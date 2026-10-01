import { validLocalState, validPermanentRowId, formatDateInTimeZone } from './sync-core.mjs';

export const UPLOAD_EVIDENCE_SCHEMA = 'm1-upload-evidence/v1';
export function uploadManifest(state, deviceId, sequence, now = new Date()) {
  if (!validLocalState(state)) throw new Error('Local attendance unavailable.');
  const date = formatDateInTimeZone(now), previous = formatDateInTimeZone(new Date(Date.parse(date + 'T12:00:00Z') - 86400000));
  const active = state.ledger.filter(row => row && row.Status !== 'VOID');
  const rows = active.filter(row => row.Date >= previous && row.Date <= date);
  const valid = rows.every(row => validPermanentRowId(row.RowID)) && new Set(rows.map(row => row.RowID)).size === rows.length;
  const unconfirmedCount = active.filter(row => !row.__syncedAt || !['added', 'already exists', 'review required'].includes(row.__syncResult)).length;
  return { schema: UPLOAD_EVIDENCE_SCHEMA, deviceId, sequence, date, coverageFrom: previous,
    manifestComplete: valid && rows.length <= 2000 && state.queue.every(row => validPermanentRowId(row?.RowID)),
    rowIds: valid ? rows.slice(0, 2000).map(row => row.RowID).sort() : [],
    savedCount: rows.length, pendingCount: state.queue.length, unconfirmedCount };
}

// A new metadata key never edits the canonical ledger, queue, or authorization.
// A blank review browser does not enroll itself as a gym tablet.
export function startUploadEvidence({ storage, stateKey, installationKey, getState, fetchImpl = fetch, cryptoApi = crypto,
  now = () => new Date(), schedule = setInterval, windowTarget = window, documentTarget = document }) {
  const key = installationKey('gib_m1_attendance_upload_evidence_v1');
  let inFlight = false;
  async function report() {
    if (inFlight || windowTarget.navigator?.onLine === false) return;
    inFlight = true;
    try {
      const raw = storage.getItem(stateKey);
      if (!raw || !validLocalState(JSON.parse(raw))) return; // Never migrate/reset records to make evidence.
      const state = getState();
      let identity = JSON.parse(storage.getItem(key) || 'null');
      if (!identity && !state.ledger.length && !state.queue.length) return;
      if (!identity) identity = { deviceId: cryptoApi.randomUUID(), sequence: 0 };
      if (!/^[0-9a-f-]{36}$/.test(identity.deviceId) || !Number.isSafeInteger(identity.sequence) || identity.sequence < 0) return;
      identity.sequence++;
      storage.setItem(key, JSON.stringify(identity));
      if (storage.getItem(key) !== JSON.stringify(identity)) return;
      const manifest = uploadManifest(state, identity.deviceId, identity.sequence, now());
      await fetchImpl('/api/m1-upload-evidence', { method: 'POST', credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(manifest), signal: AbortSignal.timeout(20000) });
    } catch { /* Missing evidence becomes a warning; it never changes sign-ins. */ }
    finally { inFlight = false; }
  }
  schedule(report, 60000);
  ['online', 'focus', 'pageshow'].forEach(event => windowTarget.addEventListener(event, report));
  documentTarget.addEventListener('visibilitychange', () => { if (documentTarget.visibilityState === 'visible') report(); });
  report();
  return report;
}
