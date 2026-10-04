import { createHash } from 'node:crypto';
import { digestGym, digestDate } from './m1-attendance-digest.mjs';
import { validateRead, localNow, datePlus } from './m1-manager-review.mjs';

const SCHEMA = 'm1-upload-evidence/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROW = /^gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('UPLOAD_EVIDENCE_UNAVAILABLE'); };
export function validUploadManifest(value) {
  return value && Object.keys(value).sort().join('|') === 'coverageFrom|date|deviceId|manifestComplete|pendingCount|rowIds|savedCount|schema|sequence|unconfirmedCount'
    && value.schema === SCHEMA && UUID.test(value.deviceId) && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && digestDate(value.date) && value.coverageFrom === datePlus(value.date, -1) && typeof value.manifestComplete === 'boolean'
    && ['savedCount', 'pendingCount', 'unconfirmedCount'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 20000)
    && Array.isArray(value.rowIds) && value.rowIds.length <= 2000 && value.rowIds.every(id => ROW.test(id))
    && new Set(value.rowIds).size === value.rowIds.length && (!value.manifestComplete || value.savedCount === value.rowIds.length);
}
export async function uploadEvidenceStore(scope) {
  const gym = digestGym(scope); if (!gym) fail();
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'gib-m1-upload-' + scope.target + '-' + gym + '-v1', consistency: 'strong' });
}
async function read(store, key) {
  const value = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (value && (!value.etag || !value.data)) fail();
  return value;
}
export async function recordUploadEvidence(store, manifest, now) {
  if (!validUploadManifest(manifest) || manifest.date !== localNow(new Date(now)).date) fail();
  const key = 'devices/' + manifest.deviceId, before = await read(store, key);
  if (before && (!validUploadManifest(before.data.manifest) || before.data.manifest.sequence >= manifest.sequence)) fail();
  const value = { schema: SCHEMA, manifest, receivedAt: now };
  const saved = await store.set(key, JSON.stringify(value), before ? { onlyIfMatch: before.etag } : { onlyIfNew: true });
  const confirmed = await read(store, key);
  if (saved?.modified !== true || !confirmed || hash(confirmed.data) !== hash(value)) fail();
  return { ok: true, schema: SCHEMA, sequence: manifest.sequence };
}
// This mapping comes only from the authenticated own-gym background reader,
// which verifies the existing receiver receipt and Admin audit. Tablet manifests
// retain their original IDs and never supply reconciliation authority.
function confirmedUploadIds(ledger, gym, target) {
  const records = new Map();
  for (const day of ledger.days) for (const row of day.records) {
    const matches = records.get(row.recordId) || []; matches.push(row); records.set(row.recordId, matches);
  }
  const confirmed = new Set([...records].filter(([, rows]) => rows.length === 1).map(([id]) => id));
  const receipts = ledger.uploadReceipts ?? [], seenRows = new Set(), seenLinked = new Set();
  if (!Array.isArray(receipts) || receipts.length > 20000) fail();
  for (const receipt of receipts) {
    const linked = records.get(receipt?.linkedRecordId);
    if (!receipt || Object.keys(receipt).sort().join('|') !== 'date|gym|linkedRecordId|rowId|schema|target'
      || receipt.schema !== 'm1-upload-reconciliation/v1' || receipt.gym !== gym || receipt.target !== target
      || !digestDate(receipt.date) || receipt.date < ledger.from || receipt.date > ledger.to
      || !ROW.test(receipt.rowId) || typeof receipt.linkedRecordId !== 'string'
      || !/^gib-admin-.{1,230}$/.test(receipt.linkedRecordId)
      || records.has(receipt.rowId) || seenRows.has(receipt.rowId) || seenLinked.has(receipt.linkedRecordId)
      || linked?.length !== 1 || linked[0].date !== receipt.date || linked[0].reviewRequired !== false
      || linked[0].source !== 'Admin-added' || linked[0].site !== (gym === 'richmond' ? 'Richmond' : 'Rev')) fail();
    seenRows.add(receipt.rowId); seenLinked.add(receipt.linkedRecordId); confirmed.add(receipt.rowId);
  }
  return confirmed;
}
export async function assessUploadEvidence(scope, attendance, jobDate, now, dependencies = {}) {
  // An accepted-report entry is evidence of a reporting device, not an
  // enrollment inventory. An empty/unreadable store cannot prove a tablet is
  // offline, absent, or unauthorized. This classification never grants access.
  let deviceCount = null, reporterSetHash = null;
  const monitoring = () => ({ schema: 'm1-reporting-evidence/v1', gym: digestGym(scope), target: scope.target,
    state: deviceCount === null ? 'unknown' : deviceCount === 0 ? 'none-observed' : 'observed', deviceCount });
  const unavailable = reason => ({ ok: false, code: 'UPLOAD_COMPLETENESS_UNCONFIRMED', reason, monitoring: monitoring(), reporterSetHash });
  try {
    const store = dependencies.uploadStore || await uploadEvidenceStore(scope);
    const listed = await store.list({ prefix: 'devices/' });
    if (!Array.isArray(listed?.blobs) || listed.blobs.length > 100) return unavailable('UPLOAD_EVIDENCE_READ_UNAVAILABLE');
    const keys = listed.blobs.map(item => item.key).sort();
    if (new Set(keys).size !== keys.length || keys.some(key => !key.startsWith('devices/') || !UUID.test(key.slice(8)))) return unavailable('UPLOAD_EVIDENCE_READ_UNAVAILABLE');
    deviceCount = keys.length;
    // Device-set identity is stable; time/age/sequence/date alone are not new.
    reporterSetHash = keys.length ? hash(keys) : null;
    if (!listed.blobs.length) return unavailable('TABLET_REPORT_NOT_RECEIVED');
    // Inspect every retained reporter before classifying a repeatable fault.
    // An earlier stale/unreadable device must not hide another device's newly
    // reported pending rows or incomplete manifest. These are never repeat-held.
    const reports = []; let readFailed = false;
    for (const key of keys) {
      let entry;
      try { entry = await read(store, key); } catch { readFailed = true; continue; }
      const report = entry?.data, manifest = report?.manifest;
      if (!report || report.schema !== SCHEMA || !validUploadManifest(manifest) || key !== 'devices/' + manifest.deviceId
        || !Number.isSafeInteger(report.receivedAt) || report.receivedAt > now) { readFailed = true; continue; }
      reports.push({ key, entry, report, manifest });
    }
    if (reports.some(({manifest}) => manifest.pendingCount || manifest.unconfirmedCount)) return unavailable('TABLET_UPLOADS_PENDING');
    if (reports.some(({manifest}) => !manifest.manifestComplete)) return unavailable('TABLET_MANIFEST_INCOMPLETE');
    if (readFailed) return unavailable('UPLOAD_EVIDENCE_READ_UNAVAILABLE');
    const ledger = validateRead(attendance?.ledger, digestGym(scope), jobDate, scope.target);
    if (attendance?.ok !== true) return unavailable('UPLOAD_EVIDENCE_READ_UNAVAILABLE');
    const confirmedIds = confirmedUploadIds(ledger, digestGym(scope), scope.target);
    let checkedRows = 0;
    for (const { manifest } of reports) {
      if (manifest.rowIds.some(id => !confirmedIds.has(id))) return unavailable('SPREADSHEET_RECEIPTS_UNCONFIRMED');
      checkedRows += manifest.rowIds.length;
    }
    if (reports.some(({report,manifest}) => now - report.receivedAt > 5 * 60000 || manifest.date !== jobDate)) return unavailable('TABLET_REPORT_STALE');
    for (const { key, entry } of reports) {
      // A partial upload or a newly queued row cannot be replaced with an older clean report.
      if ((await read(store, key))?.etag !== entry.etag) return unavailable('UPLOAD_EVIDENCE_READ_UNAVAILABLE');
    }
    const after = await store.list({ prefix: 'devices/' });
    if (JSON.stringify(after.blobs.map(item => item.key).sort()) !== JSON.stringify(keys)) return unavailable('UPLOAD_EVIDENCE_READ_UNAVAILABLE');
    return { ok: true, complete: true, deviceCount: keys.length, checkedRows, monitoring: monitoring() };
  } catch { return unavailable('UPLOAD_EVIDENCE_READ_UNAVAILABLE'); }
}
