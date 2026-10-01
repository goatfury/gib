import { captureDigestMessage, defaultDigestStore, digestFail, digestState, loadDigestConfiguration, processDigestJob, readDigestEntry, validateDigestBinding } from './m1-attendance-digest-outbox.mjs';
import { buildAttendanceDigest, digestHash, datesThrough } from './m1-attendance-digest.mjs';
import { processAttendanceWorkflow, workflowMessages } from './m1-attendance-digest-workflow.mjs';
import { localNow } from './m1-manager-review.mjs';
import { validId } from './m1-test-read-callback.mjs';

const SCHEMA = 'm1-attendance-digest-rehearsal/v1';
const activeKey = 'rehearsal-active';
const clock = dependencies => (dependencies.clock || Date.now)();
const leaseKey = id => 'rehearsals/' + id + '/lease';
const iso = value => new Date(value).toISOString();
const ROUTES = Object.freeze({
  rev: { name: 'Revolution BJJ', to: 'info@revolutionbjj.com', adminUrl: 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/' },
  richmond: { name: 'Richmond BJJ', to: 'info@richmondbjj.com', adminUrl: 'https://gib-richmond-test.netlify.app/m1/admin/' }
});
const SENDER = 'revbjjops@gmail.com', BCC = 'andrew@revolutionbjj.com';
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
function isolatedStore(store, id, area = 'data') {
  const prefix = 'rehearsals/' + id + '/' + area + '/';
  return { getWithMetadata: (key, options) => store.getWithMetadata(prefix + key, options),
    set: (key, value, options) => store.set(prefix + key, value, options) };
}

function proposalFrom(message, gym, lease) {
  const route = ROUTES[gym];
  const canonical = { messageId: message?.messageId, from: message?.from, to: message?.to, cc: message?.cc,
    subject: message?.subject, html: message?.html, text: message?.text, synthetic: message?.synthetic, target: message?.target, bcc: message?.bcc };
  if (!route || !message || Object.keys(message).sort().join('|') !== 'bcc|cc|from|hash|html|messageId|subject|synthetic|target|text|to'
    || message.synthetic !== true || message.target !== 'test' || message.from !== SENDER
    || message.messageId !== 'm1-test-scheduled-' + gym + '-' + lease.jobDate || digestHash(canonical) !== message.hash
    || JSON.stringify(message.to) !== JSON.stringify([route.to]) || JSON.stringify(message.cc) !== '[]' || JSON.stringify(message.bcc) !== JSON.stringify([BCC])
    || ['subject', 'html', 'text'].some(key => typeof message[key] !== 'string' || !message[key].trim() || message[key].length > (key === 'subject' ? 998 : 200000))
    || message.html.includes(BCC) || message.text.includes(BCC)) digestFail(503, 'DIGEST_REHEARSAL_UNAVAILABLE');
  return { messageId: message.messageId, hash: message.hash, gym, name: route.name, from: message.from, to: message.to, cc: message.cc,
    bcc: message.bcc, subject: message.subject, html: message.html, text: message.text, adminUrl: route.adminUrl, state: 'captured', synthetic: true };
}
async function proposedMessages(store, lease) {
  const values = await Promise.all(Object.keys(ROUTES).map(async gym => {
    const retained = await readDigestEntry(store, 'proposals/' + gym);
    if (!retained) return null;
    if (Object.keys(retained.data).sort().join('|') !== 'gym|message|rehearsalId' || retained.data.rehearsalId !== lease.rehearsalId
      || retained.data.gym !== gym) digestFail(503, 'DIGEST_REHEARSAL_UNAVAILABLE');
    const proposal = proposalFrom(retained.data.message, gym, lease), captured = await readDigestEntry(store, 'captures/' + proposal.messageId);
    if (!captured) return null;
    const expected = { messageId: proposal.messageId, contentHash: digestHash({ subject: proposal.subject, html: proposal.html, text: proposal.text }),
      subject: proposal.subject, html: proposal.html, text: proposal.text };
    if (digestHash(captured.data) !== digestHash(expected)) digestFail(503, 'DIGEST_CAPTURE_CONFLICT');
    return proposal;
  }));
  // A partial capture is retained centrally but never presented as a complete
  // two-gym rehearsal. The next original timer tick can finish it.
  return values.every(Boolean) ? values : [];
}

async function captureWorkflow(input, lease, data, store, dependencies) {
  if (data.scope.syntheticRehearsal !== true || input.digest.syntheticRehearsal !== true || input.configuration.sendingEnabled !== false
    || clock(dependencies) < lease.cutoffAt || input.due !== 'due') return;
  const isolated = isolatedStore(store, lease.rehearsalId, 'workflow-data');
  const configuration = { ...input.configuration, senderAddress: SENDER, sendingEnabled: false, syntheticRehearsal: true,
    gyms: Object.entries(ROUTES).map(([id, route]) => ({ id, name: route.name, adminUrl: route.adminUrl,
      timezone: 'America/New_York', staffClockEnabled: id === 'rev' })),
    routing: Object.fromEntries(Object.keys(ROUTES).map(gym => [gym, { reviewer: { ...input.configuration.routing[gym].reviewer, address: ROUTES[gym].to },
      cc: [], bcc: [{ key: 'andrew', name: 'Andrew', address: BCC }] }])) };
  configuration.recipients = [configuration.routing.rev.reviewer];
  const snapshots = Object.keys(ROUTES).map(gym => ({ gym, attendance: { ok: true, ledger: { ...structuredClone(data.gyms[0].attendance.ledger), gym } },
    ...(gym === 'rev' ? { staff: { ok: true, complete: true, items: [{ id: 'synthetic-rehearsal-unknown-finish', kind: 'forgotten-clock-out',
      staffName: 'SYNTHETIC employee', date: lease.jobDate, status: 'pending', summary: 'Previous finish time is unknown; manager review is needed. No hours were guessed.' }] } } : {}) }));
  const schedules = await Promise.all(Object.keys(ROUTES).map(async gym => ({ ...await data.dependencies.loadSchedules(), gym })));
  const digest = buildAttendanceDigest({ jobDate: lease.jobDate, snapshots, schedules, configuration, now: clock(dependencies) });
  // Never forward caller provider hooks, credentials or enabled sending flags.
  // This invokes the ordinary workflow's preparation, with its send gate OFF.
  const safe = { scope: data.scope, workflowStore: isolated, clock: () => clock(dependencies),
    env: { GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'false', GIB_M1_MAILAPP_TEST_SEND_ENABLED: 'false' },
    fetch: async () => { throw new Error('Synthetic rehearsal network is disabled.'); } };
  const result = await processAttendanceWorkflow({ ...input, digest, configuration,
    dueByGym: { rev: input.dueByGym.rev, richmond: input.dueByGym.rev },
    opportunityDueByGym: { rev: input.opportunityDueByGym.rev, richmond: input.opportunityDueByGym.rev } }, safe);
  if (result.pending) return;
  const current = await workflowMessages(data.scope, safe);
  if (current.messages.length !== 2 || current.historyComplete !== true) digestFail(503, 'DIGEST_REHEARSAL_UNAVAILABLE');
  for (const gym of Object.keys(ROUTES)) {
    const prepared = current.messages.find(value => value.gym === gym && value.date === lease.jobDate);
    if (!prepared?.message || prepared.firstAttemptAt !== null || prepared.code !== 'SCHEDULED_SENDING_DISABLED') digestFail(503, 'DIGEST_REHEARSAL_UNAVAILABLE');
    proposalFrom(prepared.message, gym, lease);
    const candidate = { rehearsalId: lease.rehearsalId, gym, message: prepared.message };
    const written = await isolated.set('proposals/' + gym, JSON.stringify(candidate), { onlyIfNew: true });
    const retained = await readDigestEntry(isolated, 'proposals/' + gym);
    if (![true, false].includes(written?.modified) || !retained || written.modified && digestHash(retained.data) !== digestHash(candidate)) digestFail(503, 'DIGEST_STORAGE_UNCONFIRMED');
    const original = proposalFrom(retained.data.message, gym, lease);
    // Use the existing immutable capture boundary. A subsequent tick retains
    // the original body even when its fresh workflow assessment is newer.
    await captureDigestMessage(isolated, { ...original, contentHash: digestHash({ subject: original.subject, html: original.html, text: original.text }) });
  }
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
    { ...data.dependencies, digestStore: isolatedStore(store, rehearsalId), captureTransport: captureDigestMessage,
      onDigestCheck: input => captureWorkflow(input, lease, data, store, dependencies) });
}

export async function digestRehearsalState(id, requestId, scope, dependencies = {}) {
  requireScope(scope);
  const store = dependencies.digestStore || await defaultDigestStore(), now = clock(dependencies), lease = await loadLease(store, id);
  const configuration = await loadDigestConfiguration(store, scope, dependencies);
  const data = rehearsalData(lease, scope, dependencies);
  const isolated = await digestState(data.scope, requestId, { ...data.dependencies, digestStore: isolatedStore(store, id) });
  return { ...isolated, configuration, rehearsal: publicLease(lease, now),
    proposedMessages: await proposedMessages(isolatedStore(store, id, 'workflow-data'), lease) };
}
