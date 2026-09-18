import {
  googleFailureClass, jsonResponse, obviousTestValue, postGoogle,
  readJson, requireAdmin, runtimeConfig, runtimeTarget
} from './m1-common.mjs';

export const REMOVAL_VERSION = 'revolution-instructor-removal-v1';
export const REMOVAL_ID = /^(?:gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|gib-admin-m1-\d{4}-\d{2}-\d{2}-[0-9a-f]{24})$/u;
export const REMOVAL_FINGERPRINT = /^[0-9a-f]{64}$/u;
const ADMINS = ['Andrew Smith', 'Stuart Turner'];
const PATH = '/.netlify/functions/m1-admin-void';
const exact = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const bounded = (value, max, blank = false) => typeof value === 'string'
  && value.length <= max && (blank || value.length > 0) && !value.includes('\0');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => bounded(value, 19) && /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(value)
  && validDate(value.slice(0, 10));

export function removalReadEnvelope(value, profile, config) {
  return value?.removalVersion === REMOVAL_VERSION && profile?.installationId === 'rev' && config
    ? { removalVersion: REMOVAL_VERSION, installation: 'rev', environment: config.target }
    : null;
}

export function sanitizeRemovalRequest(value) {
  if (!exact(value, ['removalVersion', 'operation', 'requestId', 'rowId', 'fingerprint', 'reason'])
    || value.removalVersion !== REMOVAL_VERSION
    || !['remove', 'check'].includes(value.operation)
    || !REMOVAL_ID.test(value.rowId)
    || value.requestId !== 'gib-m1-admin-void-' + value.rowId
    || !REMOVAL_FINGERPRINT.test(value.fingerprint)
    || !bounded(value.reason, 240)
    || value.reason.length < 3
    || value.reason !== value.reason.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value.reason)
    || /^[=+\-@]/u.test(value.reason)) return null;
  return Object.freeze({ ...value });
}

export function sanitizeRemovalReceipt(value, expected, preview) {
  if (!exact(value, ['ok', 'removalVersion', 'requestId', 'rowId', 'fingerprint', 'state', 'record', 'audit', 'operationRecord'])
    || value.ok !== true || value.removalVersion !== REMOVAL_VERSION
    || value.requestId !== expected.requestId || value.rowId !== expected.rowId
    || value.fingerprint !== expected.fingerprint
    || !['removed', 'pending', 'not started'].includes(value.state)
    || !exact(value.record, ['timestamp', 'date', 'classLabel', 'duration', 'instructor', 'site', 'device', 'build', 'notes', 'status'])) return null;
  const record = value.record;
  if (!timestamp(record.timestamp) || !validDate(record.date)
    || !bounded(record.classLabel, 200) || !bounded(record.instructor, 100)
    || !Number.isFinite(record.duration) || record.duration <= 0 || record.duration > 8
    || record.site !== 'Rev' || !bounded(record.device, 120) || !bounded(record.build, 120)
    || !bounded(record.notes, 800, true)
    || (preview && !obviousTestValue(record.instructor))
    || record.status !== (value.state === 'removed' ? 'VOID' : 'OK')) return null;
  if (value.state === 'not started') {
    if (value.audit !== null || value.operationRecord !== null) return null;
  } else if (!exact(value.operationRecord, ['adminName', 'reason'])
    || !ADMINS.includes(value.operationRecord.adminName)
    || !bounded(value.operationRecord.reason, 240) || value.operationRecord.reason.length < 3) return null;
  if (value.state === 'removed' && !value.audit) return null;
  if (value.audit !== null && (!exact(value.audit, ['actionNumber', 'adminName', 'actionTime', 'reason'])
    || !Number.isSafeInteger(value.audit.actionNumber) || value.audit.actionNumber < 1
    || !ADMINS.includes(value.audit.adminName) || !timestamp(value.audit.actionTime)
    || !bounded(value.audit.reason, 240) || value.audit.reason.length < 3
    || value.audit.adminName !== value.operationRecord?.adminName
    || value.audit.reason !== value.operationRecord?.reason)) return null;
  return value;
}

export async function handleRevolutionRemoval(request, dependencies = {}) {
  let url;
  try { url = new URL(request.url); } catch { return jsonResponse(403, { ok: false, message: 'Exact Admin origin required.' }); }
  const target = runtimeTarget(request.url, 'rev');
  const host = request.headers.get('host');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (!target || url.pathname !== PATH || url.search || url.hash
    || request.headers.get('origin') !== url.origin
    || (host && host.toLowerCase() !== url.host.toLowerCase())
    || (fetchSite && fetchSite !== 'same-origin')) {
    return jsonResponse(403, { ok: false, message: 'Exact same-origin Revolution Admin request required.' });
  }
  const config = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  const auth = requireAdmin(request, config, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;
  const parsed = await readJson(request, 4096);
  if (parsed.response) return parsed.response;
  const value = sanitizeRemovalRequest(parsed.value);
  if (!value) return jsonResponse(400, { ok: false, message: 'Select one sign-in and enter a short reason.' });
  const google = await postGoogle(config, 'revolutionSigninRemoval', {
    ...value, installation: 'rev', environment: target, adminName: auth.session.adminName
  }, dependencies.fetch || fetch);
  const receipt = google.readable ? sanitizeRemovalReceipt(google.value, value, config.preview) : null;
  if (!receipt) {
    // A rejected snapshot is distinct from an uncertain write. Never turn an
    // absent/late confirmation into a claim that nothing was changed.
    const conflict = google.readable && google.value?.ok === false
      && google.value?.result === 'conflict';
    return jsonResponse(conflict ? 409 : googleFailureClass(google) === 'UNREACHABLE' ? 504 : 502, {
      ok: false,
      code: conflict ? 'REMOVAL_CONFLICT' : 'REMOVAL_UNCONFIRMED',
      message: conflict
        ? 'This sign-in or its removal history changed. Check its current history before continuing.'
        : 'Removal is not confirmed. Keep this request and check its saved result before retrying.'
    });
  }
  return jsonResponse(200, { ...receipt, test: config.preview });
}
