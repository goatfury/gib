import { defaultDigestStore, digestFail, digestState, loadDigestConfiguration, processDigestJob, readDigestEntry, validateDigestBinding } from './m1-attendance-digest-outbox.mjs';
import { digestHash, datesThrough } from './m1-attendance-digest.mjs';
import { localNow } from './m1-manager-review.mjs';
import { validId } from './m1-test-read-callback.mjs';

const SCHEMA = 'm1-attendance-digest-rehearsal/v1';
const activeKey = 'rehearsal-active';
const clock = dependencies => (dependencies.clock || Date.now)();
const leaseKey = id => 'rehearsals/' + id + '/lease';
const iso = value => new Date(value).toISOString();
function requireScope(scope) {
  if (scope?.target !== 'test' || scope.profile?.installationId !== 'rev') digestFail(403, 'DIGEST_SCOPE_REQUIRED');
}
function validateLease(lease, id) {
  if (!lease || Object.keys(lease).sort().join('|') !== 'createdAt|cutoffAt|expiresAt|jobDate|rehearsalId|reviewer|schema|synthetic'
    || lease.schema !== SCHEMA || lease.rehearsalId !== id || !validId(id) || lease.synthetic !== true
    || !Number.isSafeInteger(lease.createdAt) || !Number.isSafeInteger(lease.cutoffAt) || lease.cutoffAt % 60000 !== 0
    || lease.cutoffAt < lease.createdAt + 120000 || lease.cutoffAt >= lease.createdAt + 180000
    || lease.expiresAt !== lease.createdAt + 1800000 || !['Andrew Smith', 'Stuart Turner'].includes(lease.reviewer)
    || localNow(new Date(lease.createdAt)).date !== lease.jobDate || localNow(new Date(lease.cutoffAt)).date !== lease.jobDate) digestFail(503, 'DIGEST_REHEARSAL_UNAVAILABLE');
  return lease;
}
const publicLease = (lease, now) => ({ rehearsalId: lease.rehearsalId, createdAt: lease.createdAt, cutoffAt: lease.cutoffAt,
  expiresAt: lease.expiresAt, jobDate: lease.jobDate, synthetic: true, state: now >= lease.expiresAt ? 'expired' : 'armed' });
function isolatedStore(store, id) {
  const prefix = 'rehearsals/' + id + '/data/';
  return { getWithMetadata: (key, options) => store.getWithMetadata(prefix + key, options),
    set: (key, value, options) => store.set(prefix + key, value, options) };
}
async function loadLease(store, id) {
  if (!validId(id)) digestFail(400, 'DIGEST_REHEARSAL_INVALID');
  const saved = await readDigestEntry(store, leaseKey(id));
  if (!saved) digestFail(404, 'DIGEST_REHEARSAL_MISSING');
  return validateLease(saved.data, id);
}

// This is an explicit, temporary synthetic scope, never a real closing-time approval.
export async function armDigestRehearsal(id, reviewer, scope, dependencies = {}) {
  requireScope(scope);
  if (!validId(id) || !['Andrew Smith', 'Stuart Turner'].includes(reviewer)) digestFail(400, 'DIGEST_REHEARSAL_INVALID');
  const store = dependencies.digestStore || await defaultDigestStore(), now = clock(dependencies);
  const existing = await readDigestEntry(store, leaseKey(id));
  if (existing) return publicLease(validateLease(existing.data, id), now); // A lost reply never extends the lease.
  const active = await readDigestEntry(store, activeKey);
  if (active && active.data.expiresAt > now && active.data.rehearsalId !== id) digestFail(409, 'DIGEST_REHEARSAL_ACTIVE');
  const lease = active?.data.rehearsalId === id ? validateLease(active.data, id) : { schema: SCHEMA, rehearsalId: id, createdAt: now, cutoffAt: Math.ceil((now + 120000) / 60000) * 60000,
    expiresAt: now + 1800000, jobDate: localNow(new Date(now)).date, reviewer, synthetic: true };
  validateLease(lease, id);
  const claim = lease; // The durable claim also permits recovery if lease persistence was interrupted.
  await store.set(activeKey, JSON.stringify(claim), active ? { onlyIfMatch: active.etag } : { onlyIfNew: true });
  const winner = await readDigestEntry(store, activeKey);
  if (digestHash(winner?.data) !== digestHash(claim)) digestFail(409, 'DIGEST_REHEARSAL_ACTIVE');
  const written = await store.set(leaseKey(id), JSON.stringify(lease), { onlyIfNew: true });
  const saved = await loadLease(store, id);
  if (![true, false].includes(written?.modified) || (written.modified && digestHash(saved) !== digestHash(lease))) digestFail(503, 'DIGEST_STORAGE_UNCONFIRMED');
  return publicLease(saved, now);
}

function rehearsalData(lease, scope, dependencies) {
  const dates = datesThrough(lease.jobDate), endAt = iso(lease.cutoffAt), startAt = iso(lease.cutoffAt - 60000);
  const label = 'QA SYNTHETIC REHEARSAL — finished class';
  const ledger = { ok: true, complete: true, target: 'test', schema: 'm1-manager-review/v1', gym: 'rev', from: dates[0], to: lease.jobDate,
    days: dates.map(date => ({ date, attendanceHash: digestHash(['synthetic-rehearsal', lease.rehearsalId, date]), records: [], warnings: [], review: null })) };
  const schedules = { gym: 'rev', timezone: 'America/New_York', days: dates.map(date => ({ date, status: 'complete',
    observedAt: iso(lease.createdAt), sourceVersion: 'isolated-synthetic-rehearsal/v1',
    occurrences: date === lease.jobDate ? [{ label, startAt, endAt, cancelled: false }] : [] })) };
  const minutes = localNow(new Date(lease.cutoffAt)).minutes;
  return { gyms: [{ gym: 'rev', attendance: { ok: true, ledger }, staff: { ok: true, complete: true, items: [] } }],
    scope: { ...scope, syntheticRehearsal: true, profile: { ...scope.profile, gymName: 'Revolution BJJ — synthetic rehearsal' } },
    dependencies: { ...dependencies, env: { GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME: String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'),
      GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true' }, loadSchedules: async () => schedules,
      dailyMessagePrefix: 'm1-test-rehearsal-' + lease.rehearsalId + '-' } };
}

export async function processDigestRehearsal(job, scope, dependencies = {}) {
  requireScope(scope);
  const now = clock(dependencies), store = dependencies.digestStore || await defaultDigestStore();
  validateDigestBinding(job.binding, now);
  if (job.binding.mode !== 'rehearsal' || !Array.isArray(job.gyms) || job.gyms.length) digestFail(409, 'DIGEST_BINDING_MISMATCH');
  const lease = await loadLease(store, job.binding.rehearsalId), active = await readDigestEntry(store, activeKey);
  if (now >= lease.expiresAt || job.binding.createdAt < lease.createdAt || job.binding.expiresAt > lease.expiresAt) digestFail(410, 'DIGEST_REHEARSAL_EXPIRED');
  if (active?.data.rehearsalId !== lease.rehearsalId || active.data.expiresAt !== lease.expiresAt || job.binding.jobDate !== lease.jobDate) digestFail(409, 'DIGEST_BINDING_MISMATCH');
  const data = rehearsalData(lease, scope, dependencies), { rehearsalId, ...binding } = job.binding;
  return processDigestJob({ binding: { ...binding, mode: 'scheduled' }, gyms: data.gyms }, data.scope,
    { ...data.dependencies, digestStore: isolatedStore(store, rehearsalId) });
}

export async function digestRehearsalState(id, requestId, scope, dependencies = {}) {
  requireScope(scope);
  const store = dependencies.digestStore || await defaultDigestStore(), now = clock(dependencies), lease = await loadLease(store, id);
  const configuration = await loadDigestConfiguration(store, scope, dependencies);
  const data = rehearsalData(lease, scope, dependencies);
  const isolated = await digestState(data.scope, requestId, { ...data.dependencies, digestStore: isolatedStore(store, id) });
  return { ...isolated, configuration, rehearsal: publicLease(lease, now) };
}
