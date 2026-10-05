import { createHmac } from 'node:crypto';
import { adminNamesForScope, auditAdminNamesForScope, constantTimeSecretEqual } from './m1-common.mjs';
import { validId } from './m1-test-read-callback.mjs';
import { localNow } from './m1-manager-review.mjs';
import { DIGEST_SCHEMA, DIGEST_STORE, digestGym, digestStoreName, digestHash, digestDate, datesThrough, defaultDigestConfiguration, buildAttendanceDigest, renderAttendanceDigest, digestDue, latestEligibleOpportunity } from './m1-attendance-digest.mjs';

export const DIGEST_JOB_SCHEMA = 'm1-attendance-digest-job/v1';
export const DIGEST_SIGNATURE_HEADER = 'X-GIB-M1-Digest-Signature';
export const digestSignature = (raw, secret) => createHmac('sha256', secret).update(DIGEST_JOB_SCHEMA + '\n' + raw).digest('hex');
export const digestFail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const bindingKeys = ['schema', 'target', 'requestId', 'mode', 'jobDate', 'createdAt', 'expiresAt'];
const clock = dependencies => (dependencies.clock || Date.now)();
const reqKey = id => 'requests/' + id;
const outKey = id => 'outbox/' + id;
const reviewersFor = scope => adminNamesForScope({ target: scope?.target, installationId: scope?.profile?.installationId,
  environment: scope?.profile?.environment, preview: scope?.target === 'test', writesEnabled: scope?.profile?.activation === 'active', richmondReviewerEnabled: scope?.liveFeatures?.richmondReviewer === true });
const runtimeGym = runtime => !['test', 'production'].includes(runtime?.target) ? null : runtime.installationId === 'richmond'
  ? runtime.environment === runtime.target ? 'richmond' : null : !runtime.installationId || runtime.installationId === 'rev' ? 'rev' : null;
function validateOutbox(record, messageId) {
  if (!record || record.schema !== DIGEST_SCHEMA || record.messageId !== messageId || record.sendingEnabled !== false
    || !['prepared', 'captured', 'suppressed', 'failed'].includes(record.state) || !digestDate(record.date)
    || typeof record.subject !== 'string' || typeof record.html !== 'string' || typeof record.text !== 'string'
    || record.contentHash !== digestHash({ subject: record.subject, html: record.html, text: record.text })
    || !Array.isArray(record.groups) || !Array.isArray(record.readFailures)) digestFail(503, 'DIGEST_OUTBOX_INCOMPLETE');
  return record;
}
export async function defaultDigestStore(scope) {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: scope ? digestStoreName(scope) : DIGEST_STORE, consistency: 'strong' });
}
export async function readDigestEntry(store, key) {
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (entry && (!entry.etag || !entry.data)) digestFail(503, 'DIGEST_STORAGE_INCOMPLETE');
  return entry || null;
}
async function createConfirmed(store, key, value) {
  const result = await store.set(key, JSON.stringify(value), { onlyIfNew: true });
  const saved = await readDigestEntry(store, key);
  if (![true, false].includes(result?.modified) || !saved || (result.modified && digestHash(saved.data) !== digestHash(value))) digestFail(503, 'DIGEST_STORAGE_UNCONFIRMED');
  return { ...saved, created: result.modified };
}
async function replaceConfirmed(store, key, previous, value) {
  const result = await store.set(key, JSON.stringify(value), { onlyIfMatch: previous.etag });
  const saved = await readDigestEntry(store, key);
  if (![true, false].includes(result?.modified) || !saved || (result.modified && digestHash(saved.data) !== digestHash(value))) digestFail(503, 'DIGEST_STORAGE_UNCONFIRMED');
  return { ...saved, replaced: result.modified };
}

export function makeDigestBinding(requestId, mode, now, target = 'test') {
  return { schema: DIGEST_JOB_SCHEMA, target, requestId, mode, jobDate: localNow(new Date(now)).date, createdAt: now, expiresAt: now + 60000 };
}
export function validateDigestBinding(binding, now, target = 'test') {
  const rehearsal = binding?.mode === 'rehearsal';
  if (!exact(binding, rehearsal ? [...bindingKeys, 'rehearsalId'] : bindingKeys) || binding.schema !== DIGEST_JOB_SCHEMA || binding.target !== target || !['test', 'production'].includes(target) || (target === 'production' && rehearsal) || !validId(binding.requestId)
    || !['manual', 'scheduled', 'rehearsal'].includes(binding.mode) || (rehearsal && !validId(binding.rehearsalId)) || !Number.isSafeInteger(binding.createdAt) || binding.createdAt > now
    || binding.expiresAt !== binding.createdAt + 60000 || !digestDate(binding.jobDate)
    || binding.jobDate !== localNow(new Date(binding.createdAt)).date) digestFail(409, 'DIGEST_BINDING_MISMATCH');
  if (now >= binding.expiresAt) digestFail(410, 'DIGEST_REQUEST_EXPIRED');
  return binding;
}
export function authenticateDigestJob(raw, header, runtime, now) {
  const gym = runtimeGym(runtime);
  if (!gym) digestFail(503, 'DIGEST_RUNTIME_UNAVAILABLE');
  if (!/^[0-9a-f]{64}$/.test(header || '') || !constantTimeSecretEqual(header, digestSignature(raw, runtime.adminActionToken))) digestFail(403, 'DIGEST_AUTHENTICATION_FAILED');
  let body;
  try { body = JSON.parse(raw); } catch { digestFail(400, 'DIGEST_INVALID_JSON'); }
  if (!exact(body, [...bindingKeys, 'gyms', ...(body?.mode === 'rehearsal' ? ['rehearsalId'] : [])])) digestFail(400, 'DIGEST_INVALID_ENVELOPE');
  const { gyms, ...binding } = body;
  validateDigestBinding(binding, now, runtime.target);
  if (!Array.isArray(gyms) || (binding.mode === 'rehearsal' ? gym !== 'rev' || gyms.length !== 0 : gyms.length !== 1 || gyms[0]?.gym !== gym)) digestFail(409, 'DIGEST_GYM_MISMATCH');
  if (gym === 'richmond' && (!exact(gyms[0].staff, ['ok', 'complete', 'items', 'notApplicable']) || gyms[0].staff.ok !== true
    || gyms[0].staff.complete !== true || gyms[0].staff.notApplicable !== true || !Array.isArray(gyms[0].staff.items) || gyms[0].staff.items.length)) digestFail(409, 'DIGEST_GYM_MISMATCH');
  return { binding, gyms };
}

export async function loadDigestConfiguration(store, scope, dependencies = {}) {
  const base = defaultDigestConfiguration(scope, dependencies.env || process.env);
  const entry = await readDigestEntry(store, 'configuration');
  if (!entry) return base;
  if (scope.target === 'production' && entry.data.dailyLocalTime !== '20:00') digestFail(503, 'DIGEST_CONFIGURATION_UNAVAILABLE');
  if (!exact(entry.data, ['schema', 'dailyLocalTime', 'cutoffConfirmed', 'updatedAt', 'reviewer']) || entry.data.schema !== DIGEST_SCHEMA
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry.data.dailyLocalTime) || entry.data.cutoffConfirmed !== true
    || !auditAdminNamesForScope({ target: scope.target, installationId: scope.profile.installationId, environment: scope.profile.environment,
      preview: scope.target === 'test' }).includes(entry.data.reviewer) || !Number.isFinite(Date.parse(entry.data.updatedAt))) digestFail(503, 'DIGEST_CONFIGURATION_UNAVAILABLE');
  return { ...base, dailyLocalTime: entry.data.dailyLocalTime, cutoffConfirmed: true };
}
export async function saveDigestConfiguration(store, scope, time, reviewer, dependencies = {}) {
  if (!digestGym(scope) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time || '') || !reviewersFor(scope).includes(reviewer)) digestFail(400, 'DIGEST_CONFIGURATION_INVALID');
  if (scope.target === 'production' && time !== '20:00') digestFail(400, 'DIGEST_CONFIGURATION_INVALID');
  const value = { schema: DIGEST_SCHEMA, dailyLocalTime: time, cutoffConfirmed: true, reviewer, updatedAt: new Date(clock(dependencies)).toISOString() };
  const previous = await readDigestEntry(store, 'configuration');
  const saved = previous ? await replaceConfirmed(store, 'configuration', previous, value) : await createConfirmed(store, 'configuration', value);
  if (digestHash(saved.data) !== digestHash(value)) digestFail(409, 'DIGEST_CONFIGURATION_CHANGED');
  return loadDigestConfiguration(store, scope, dependencies);
}

async function completeRequest(store, id, update) {
  const previous = await readDigestEntry(store, reqKey(id));
  if (!previous) digestFail(503, 'DIGEST_REQUEST_MISSING');
  if (previous.data.state === 'captured' || previous.data.state === 'suppressed') return previous.data;
  const saved = await replaceConfirmed(store, reqKey(id), previous, { ...previous.data, ...update });
  return saved.data;
}
async function updateLatest(store, record) {
  const previous = await readDigestEntry(store, 'latest');
  const value = { messageId: record.messageId, createdAt: record.createdAt };
  if (previous?.data.createdAt > value.createdAt) return;
  if (previous) await replaceConfirmed(store, 'latest', previous, value);
  else await createConfirmed(store, 'latest', value);
}

// This is the complete delivery transport. It writes an immutable local capture;
// there is deliberately no mail provider, SMTP call or enabled-send branch.
export async function captureDigestMessage(store, record) {
  const value = { messageId: record.messageId, contentHash: record.contentHash, subject: record.subject, html: record.html, text: record.text };
  const saved = await createConfirmed(store, 'captures/' + record.messageId, value);
  if (saved.data.contentHash !== record.contentHash || digestHash(saved.data) !== digestHash(value)) digestFail(409, 'DIGEST_CAPTURE_CONFLICT');
  return { captured: true, messageId: record.messageId, contentHash: record.contentHash };
}
export async function deliverDigestOutbox(store, record, requestId, dependencies = {}) {
  let current = await readDigestEntry(store, outKey(record.messageId));
  if (!current || current.data.contentHash !== record.contentHash) digestFail(503, 'DIGEST_OUTBOX_UNCONFIRMED');
  validateOutbox(current.data, record.messageId);
  if (['captured', 'suppressed'].includes(current.data.state)) return current.data;
  try {
    const received = await (dependencies.captureTransport || captureDigestMessage)(store, current.data);
    if (received?.captured !== true || received.messageId !== record.messageId || received.contentHash !== record.contentHash) digestFail(503, 'DIGEST_CAPTURE_UNCONFIRMED');
    current = await readDigestEntry(store, outKey(record.messageId));
    if (current.data.state !== 'captured') {
      const saved = await replaceConfirmed(store, outKey(record.messageId), current, { ...current.data, state: 'captured', capturedAt: new Date(clock(dependencies)).toISOString(), lastFailure: null });
      if (saved.data.state !== 'captured') digestFail(503, 'DIGEST_CAPTURE_STATUS_UNCONFIRMED');
      current = saved;
    }
  } catch {
    // A later success cannot erase the immutable failed-attempt receipt.
    await createConfirmed(store, 'failures/' + record.messageId + '/' + requestId, { requestId, messageId: record.messageId, code: 'CAPTURE_UNAVAILABLE', time: new Date(clock(dependencies)).toISOString() });
    current = await readDigestEntry(store, outKey(record.messageId));
    if (current.data.state !== 'captured') current = await replaceConfirmed(store, outKey(record.messageId), current, { ...current.data, state: 'failed', lastFailure: 'CAPTURE_UNAVAILABLE' });
  }
  await updateLatest(store, current.data);
  return current.data;
}

export async function processDigestJob({ binding, gyms }, scope, dependencies = {}) {
  const now = clock(dependencies), store = dependencies.digestStore || await defaultDigestStore(scope);
  validateDigestBinding(binding, now, scope.target);
  if (binding.mode === 'rehearsal') digestFail(409, 'DIGEST_BINDING_MISMATCH'); // Only the isolated rehearsal adapter may translate this mode.
  const configuration = await loadDigestConfiguration(store, scope, dependencies);
  if (!Array.isArray(gyms) || gyms.length !== configuration.gyms.length || gyms.some(g => !configuration.gyms.some(c => c.id === g.gym))) digestFail(409, 'DIGEST_GYM_MISMATCH');
  let request = await readDigestEntry(store, reqKey(binding.requestId));
  if (binding.mode === 'manual' && !request) digestFail(404, 'DIGEST_MANUAL_REQUEST_MISSING');
  if (!request) request = await createConfirmed(store, reqKey(binding.requestId), { binding, state: 'pending', messageId: null });
  if (digestHash(request.data.binding) !== digestHash(binding)) digestFail(409, 'DIGEST_BINDING_MISMATCH');
  const inputReceipt = { requestId: binding.requestId, payloadHash: digestHash({ binding, gyms }) };
  const inputs = await createConfirmed(store, 'inputs/' + binding.requestId, inputReceipt);
  if (digestHash(inputs.data) !== digestHash(inputReceipt)) digestFail(409, 'DIGEST_RESULT_CONFLICT');
  if (['captured', 'suppressed', 'not-due', 'awaiting-configuration'].includes(request.data.state)) return request.data;
  const schedules = await Promise.all(configuration.gyms.map(async gym => {
    try {
      const loader = dependencies.loadSchedules || (await import('./m1-attendance-digest-source.mjs')).loadDigestScheduleSnapshots;
      const attendance = gyms.find(item => item.gym === gym.id)?.attendance;
      let reviewSnapshots = [];
      try {
        if (attendance?.ok === true) {
          const { validateRead } = await import('./m1-manager-review.mjs');
          const ledger = validateRead(attendance.ledger, gym.id, binding.jobDate, scope.target);
          reviewSnapshots = ledger.days.filter(day => Array.isArray(day.review?.snapshot?.base))
            .map(day => ({ date: day.date, base: day.review.snapshot.base, reviewedAt: day.review.time }));
        }
      } catch {} // Unavailable attendance cannot invent historical schedule evidence.
      return await loader({ target: scope.target, gym: gym.id, dates: datesThrough(binding.jobDate), now, store,
        closingTime: gym.dailyLocalTime ?? configuration.dailyLocalTime,
        cutoffConfirmed: gym.cutoffConfirmed ?? configuration.cutoffConfirmed,
        classFinishCutoffConfirmed: gym.classFinishCutoffConfirmed ?? configuration.classFinishCutoffConfirmed ?? gym.cutoffConfirmed ?? configuration.cutoffConfirmed, reviewSnapshots });
    } catch { return { gym: gym.id, timezone: configuration.timezone, days: [] }; }
  }));
  let snapshots = gyms;
  if (configuration.emailFirst === true) {
    const { assessUploadEvidence } = await import('./m1-upload-evidence.mjs');
    snapshots = await Promise.all(gyms.map(async snapshot => ({ ...snapshot,
      uploads: await assessUploadEvidence(scope, snapshot.attendance, binding.jobDate, now, dependencies) })));
  }
  const digest = buildAttendanceDigest({ jobDate: binding.jobDate, snapshots, schedules, configuration, now });
  validateDigestBinding(binding, clock(dependencies), scope.target);
  if (binding.mode === 'scheduled') {
    const due = digestDue(binding.jobDate, now, configuration, schedules);
    const dueByGym = {}, opportunityDueByGym = {};
    for (const gym of configuration.gyms) {
      const perGym = { ...configuration,
        dailyLocalTime: gym.dailyLocalTime ?? configuration.dailyLocalTime,
        cutoffConfirmed: gym.cutoffConfirmed ?? configuration.cutoffConfirmed,
        classFinishCutoffConfirmed: gym.classFinishCutoffConfirmed ?? configuration.classFinishCutoffConfirmed ?? gym.cutoffConfirmed ?? configuration.cutoffConfirmed,
      }, ownSchedules = schedules.filter(schedule => schedule.gym === gym.id);
      dueByGym[gym.id] = digestDue(binding.jobDate, now, perGym, ownSchedules);
      const opportunity = latestEligibleOpportunity(configuration, now, gym.id);
      opportunityDueByGym[gym.id] = opportunity
        ? digestDue(opportunity.date, now, perGym, ownSchedules) : 'awaiting-configuration';
    }
    // The workflow consumes this fresh authenticated check, never an earlier
    // immutable daily capture. Its one bounded attempt stays fully awaited.
    if (dependencies.onDigestCheck) await dependencies.onDigestCheck({ digest, configuration, binding, due, dueByGym, opportunityDueByGym,
      ...(configuration.emailFirst === true ? { uploadAssessment: snapshots[0].uploads } : {}) });
    if (due !== 'due') return completeRequest(store, binding.requestId, { state: due });
  }
  const rendered = renderAttendanceDigest(digest);
  const gym = digestGym(scope), suffix = gym === 'richmond' ? 'richmond-' : '';
  const messageId = binding.mode === 'scheduled' ? (dependencies.dailyMessagePrefix || 'm1-' + scope.target + '-daily-' + suffix) + binding.jobDate : 'm1-' + scope.target + '-manual-' + suffix + binding.requestId;
  const prepared = { schema: DIGEST_SCHEMA, messageId, date: binding.jobDate, mode: binding.mode, state: digest.shouldCapture ? 'prepared' : 'suppressed',
    requestId: binding.requestId, createdAt: new Date(now).toISOString(), capturedAt: null, sendingEnabled: false,
    ...rendered, groups: digest.groups, readFailures: digest.readFailures, itemCount: digest.itemCount, contentHash: digestHash(rendered), lastFailure: null,
    ...(configuration.emailFirst === true ? { reportingEvidence: snapshots[0].uploads.monitoring } : {}) };
  const claimed = await createConfirmed(store, outKey(messageId), prepared);
  validateOutbox(claimed.data, messageId);
  // Daily outbox ownership wins once. Repeated ticks recover that exact message,
  // even if newer data would now render different content.
  const delivered = claimed.data.state === 'suppressed' ? claimed.data : await deliverDigestOutbox(store, claimed.data, binding.requestId, dependencies);
  await updateLatest(store, delivered);
  return completeRequest(store, binding.requestId, { state: delivered.state, messageId });
}

export async function startManualDigest(requestId, reviewer, runtime, scope, dependencies = {}) {
  const gym = digestGym(scope);
  if (!validId(requestId) || !gym || !reviewersFor(scope).includes(reviewer) || runtimeGym(runtime) !== gym || runtime.target !== scope.target) digestFail(400, 'DIGEST_REQUEST_INVALID');
  if (typeof dependencies.context?.waitUntil !== 'function') digestFail(503, 'DIGEST_LIFECYCLE_UNAVAILABLE');
  const store = dependencies.digestStore || await defaultDigestStore(scope), now = clock(dependencies);
  const existing = await readDigestEntry(store, reqKey(requestId));
  if (existing) {
    if (existing.data.binding.mode !== 'manual') digestFail(409, 'DIGEST_REQUEST_CONFLICT');
    if (existing.data.state === 'failed' && existing.data.messageId) {
      const outbox = await readDigestEntry(store, outKey(existing.data.messageId));
      if (!outbox) digestFail(503, 'DIGEST_OUTBOX_UNCONFIRMED');
      const recovered = await deliverDigestOutbox(store, outbox.data, requestId, dependencies);
      return completeRequest(store, requestId, { state: recovered.state });
    }
    return existing.data;
  }
  const binding = makeDigestBinding(requestId, 'manual', now, scope.target);
  const pending = await createConfirmed(store, reqKey(requestId), { binding, reviewer, state: 'pending', messageId: null });
  if (digestHash(pending.data.binding) !== digestHash(binding)) digestFail(409, 'DIGEST_REQUEST_CONFLICT');
  if (pending.created) {
    dependencies.context.waitUntil((async () => {
      let category = 'ordinary-reply-discarded';
      try {
        const response = await (dependencies.fetch || fetch)(runtime.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: JSON.stringify({ token: runtime.webhookToken, adminActionToken: runtime.adminActionToken, target: scope.target,
            ...(gym === 'richmond' ? { installation: 'richmond', environment: scope.target, gym: 'richmond' } : {}),
            action: 'attendanceDigestCapture', adminName: reviewer, binding }),
          redirect: 'manual', signal: AbortSignal.timeout(25000) });
        await response.body?.cancel();
      } catch { category = 'ordinary-reply-unavailable'; }
      try { await createConfirmed(store, 'dispatch/' + requestId, { requestId, category, time: new Date(clock(dependencies)).toISOString() }); } catch {}
    })());
  }
  return pending.data;
}

export async function digestState(scope, requestId, dependencies = {}) {
  const store = dependencies.digestStore || await defaultDigestStore(scope), now = clock(dependencies);
  const configuration = await loadDigestConfiguration(store, scope, dependencies);
  let request = requestId ? (await readDigestEntry(store, reqKey(requestId)))?.data : null;
  const latestPointer = await readDigestEntry(store, 'latest');
  const messageId = request?.messageId || latestPointer?.data.messageId;
  const latest = messageId ? (await readDigestEntry(store, outKey(messageId)))?.data : null;
  if (messageId && !latest) digestFail(503, 'DIGEST_OUTBOX_UNCONFIRMED');
  if (latest) validateOutbox(latest, messageId);
  if (request) request = { requestId: request.binding.requestId, state: request.state === 'pending' && now >= request.binding.expiresAt ? 'expired' : request.state,
    expiresAt: request.binding.expiresAt, messageId: request.messageId };
  return { ok: true, target: scope.target, sendingEnabled: false, configuration, latest: latest || null, request: request || null };
}
