import { randomUUID } from 'node:crypto';
import { buildAttendanceDigest, defaultDigestConfiguration, digestDue, digestHash, datesThrough } from './m1-attendance-digest.mjs';
import { makeDigestBinding } from './m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, workflowHealth, workflowMessages, migrateWorkflowHistory, recordWorkflowDeliveryEvidence, latestEligibleOpportunity } from './m1-attendance-digest-workflow.mjs';

const SCHEMA = 'm1-attendance-workflow-examples/v1';
const STORE = 'gib-m1-attendance-workflow-examples-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START = Date.parse('2026-09-25T02:30:00.000Z');
const DATE = '2026-09-24';
const SCOPE = Object.freeze({ target: 'test', syntheticRehearsal: true, profile: { installationId: 'rev', gymName: 'Revolution TEST — synthetic examples' } });
const SAFE_ENV = Object.freeze({ GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true', GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME: '22:00', GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: 'stu@example.invalid',
  GIB_M1_ATTENDANCE_DIGEST_TREY_EMAIL: 'trey@example.invalid', GIB_M1_ATTENDANCE_DIGEST_ANDREW_EMAIL: 'andrew@example.invalid',
  GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW: 'false', GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW: 'false', GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'false' });
const MINUTE = 60000, LEASE_MS = 5 * MINUTE;
const scenarioKeys = ['routing', 'clean', 'incomplete', 'upcoming-canceled', 'duplicate-concurrent', 'temporary-recovery',
  'uncertain-reload', 'permanent-failure', 'resolved-before-attempt', 'immutable-after-attempt', 'expired-uncertain', 'health-ordering'];
const historyScenarioKeys = ['history-over-256', 'history-old-barriers', 'history-late-event', 'history-interrupted-upgrade'];
const dailyScenarioKeys = ['daily-fresh-unknown', 'daily-clean-incomplete', 'daily-calendar-dst', 'daily-overlap-recovery',
  'daily-missed-days', 'daily-late-evidence', 'daily-holds'];
const mailappScenarioKeys = ['mailapp-original-recovery', 'mailapp-next-day', 'mailapp-clean-incomplete', 'mailapp-claims', 'mailapp-no-backlog'];
const keysFor = kind => kind === 'mailapp' ? mailappScenarioKeys : kind === 'daily' ? dailyScenarioKeys : kind === 'history' ? historyScenarioKeys : scenarioKeys;
const clock = deps => (deps.clock || Date.now)();
const fail = (code, status = 503, runId) => { throw Object.assign(new Error(code), { code, status, ...(runId ? { runId } : {}) }); };
const assert = (value, message) => { if (!value) throw Object.assign(new Error(message), { exampleCheck: true }); };
const idFor = value => { const hash = digestHash(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
const key = runId => 'examples/' + runId + '/';
async function storeFor(deps) {
  if (deps.examplesStore || deps.store) return deps.examplesStore || deps.store;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE, consistency: 'strong' });
}
async function read(store, path) {
  const saved = await store.getWithMetadata(path, { type: 'json', consistency: 'strong' });
  if (saved && (!saved.data || typeof saved.etag !== 'string' || !saved.etag)) fail('WORKFLOW_EXAMPLES_STORAGE_UNAVAILABLE');
  return saved || null;
}
async function create(store, path, data) {
  const write = await store.set(path, JSON.stringify(data), { onlyIfNew: true });
  const saved = await read(store, path);
  if (![true, false].includes(write?.modified) || !saved || (write.modified && digestHash(saved.data) !== digestHash(data))) fail('WORKFLOW_EXAMPLES_STORAGE_UNCONFIRMED');
  return saved;
}
function isolated(store, prefix) {
  const checked = path => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) fail('WORKFLOW_EXAMPLES_NAMESPACE_INVALID');
    return prefix + path;
  };
  return { getWithMetadata: (path, options) => store.getWithMetadata(checked(path), options),
    set: (path, raw, options) => store.set(checked(path), raw, options),
    delete: path => store.delete(checked(path)),
    async *list(options = {}) {
      for await (const page of store.list({ ...options, prefix: prefix + (options.prefix || '') })) {
        if (!Array.isArray(page.blobs) || page.blobs.some(blob => !blob.key.startsWith(prefix))) fail('WORKFLOW_EXAMPLES_NAMESPACE_INVALID');
        yield { ...page, blobs: page.blobs.map(blob => ({ ...blob, key: blob.key.slice(prefix.length) })) };
      }
    } };
}
const failureCategories = new Set(['WORKFLOW_STORAGE_INCOMPLETE', 'WORKFLOW_STORAGE_UNCONFIRMED', 'WORKFLOW_HISTORY_UNAVAILABLE',
  'WORKFLOW_HISTORY_TRANSITION_PENDING', 'WORKFLOW_HISTORY_MIGRATION_PENDING', 'WORKFLOW_MESSAGE_UNAVAILABLE', 'WORKFLOW_HEALTH_UNAVAILABLE',
  'WORKFLOW_HEALTH_UNCONFIRMED', 'WORKFLOW_CHECK_CONFLICT', 'WORKFLOW_FRESH_CHECK_REQUIRED', 'WORKFLOW_PROCESSOR_SUPERSEDED',
  'WORKFLOW_OPPORTUNITY_CONFLICT', 'WORKFLOW_OPPORTUNITY_UNCONFIRMED', 'WORKFLOW_OPPORTUNITY_CONFIGURATION_INVALID',
  'WORKFLOW_PRIOR_DELIVERY_UNCONFIRMED', 'WORKFLOW_RECIPIENT_PROOF_UNAVAILABLE', 'WORKFLOW_EVIDENCE_UNAVAILABLE',
  'WORKFLOW_EXAMPLES_STORAGE_UNAVAILABLE', 'WORKFLOW_EXAMPLES_STORAGE_UNCONFIRMED', 'WORKFLOW_EXAMPLES_NAMESPACE_INVALID',
  'WORKFLOW_EXAMPLES_RECOVERY_INVALID', 'WORKFLOW_EXAMPLES_RECOVERY_REQUIRES_REVIEW',
  'WORKFLOW_EXAMPLES_PROVIDER_BODY_CHANGED', 'WORKFLOW_EXAMPLES_SIMULATION_CONFLICT', 'WORKFLOW_EXAMPLES_SIMULATION_UNCONFIRMED',
  'SYNTHETIC_OPPORTUNITY_WRITE_FAILURE', 'SYNTHETIC_OLD_LEDGER_UNAVAILABLE']);
const failureNames = new Map([['BlobsInternalError', 'BLOBS_STORAGE_ERROR'], ['MissingBlobsEnvironmentError', 'BLOBS_CONFIGURATION_ERROR'],
  ['BlobsConsistencyError', 'BLOBS_CONSISTENCY_ERROR'], ['TimeoutError', 'OPERATION_TIMEOUT']]);
async function retainFailure(store, runId, scenario, step, stage, requestId, error, worker = null) {
  const category = [error?.code, error?.message].find(value => failureCategories.has(value))
    || failureNames.get(error?.name)
    || (error instanceof TypeError ? 'TYPE_ERROR' : error instanceof RangeError ? 'RANGE_ERROR' : 'UNCLASSIFIED_ERROR');
  const status = error?.status ?? error?.statusCode;
  const receipt = { schema: 'm1-workflow-example-failure/v1', runId, scenario, step, stage, requestId, worker, category,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, observedAt: new Date().toISOString() };
  // Diagnostics never replace the original exception, including when the
  // underlying storage failure also prevents retaining this receipt.
  try { Object.defineProperty(error, 'exampleFailure', { value: receipt, configurable: true }); } catch {}
  try { await create(store, 'failures/' + randomUUID(), receipt); } catch {}
}
async function calendarRecovery(store, runId, scenario, step, requestedAt) {
  const requestId = idFor([runId, scenario, step]);
  if (scenario !== 'daily-calendar-dst' || !['cutoff', 'repeat'].includes(step)) return { at: requestedAt, requestId };
  const cutoff = Date.parse('2026-09-25T22:00:00-04:00'), originalRequestId = idFor([runId, scenario, 'cutoff']);
  const path = 'fixture/concurrent-recovery';
  let saved = await read(store, path);
  if (!saved && step === 'cutoff') {
    const health = await read(store, 'workflow/health');
    if (health?.data.requestId === originalRequestId && health.data.checkedAt === cutoff) {
      const processor = await read(store, 'workflow/processor');
      if (processor?.data.expiresAt > cutoff) {
        const value = { schema: 'm1-workflow-example-clock-recovery/v1', runId, scenario, originalRequestId, originalAt: cutoff,
          originalHealth: health.data, originalHealthHash: digestHash(health.data), originalProcessor: processor.data,
          effectiveAt: processor.data.expiresAt + 1 };
        value.recoveryRequestId = idFor([runId, scenario, 'cutoff', 'recovery', processor.data.owner, processor.data.expiresAt]);
        if (!validCalendarRecovery(value, runId, scenario, cutoff, originalRequestId)) fail('WORKFLOW_EXAMPLES_RECOVERY_INVALID');
        // Preserve the failed assessment before a fresh bound read can replace
        // the mutable health head. The original run and daily IDs stay fixed.
        saved = await create(store, path, value);
      }
    }
  }
  if (!saved) return { at: requestedAt, requestId };
  const value = saved.data;
  if (!validCalendarRecovery(value, runId, scenario, cutoff, originalRequestId)) fail('WORKFLOW_EXAMPLES_RECOVERY_INVALID');
  const at = requestedAt + value.effectiveAt - cutoff;
  if (requestedAt < cutoff || latestEligibleOpportunity(input().configuration, at).date !== '2026-09-25') fail('WORKFLOW_EXAMPLES_RECOVERY_INVALID');
  const processor = await read(store, 'workflow/processor');
  if (processor?.data.expiresAt > at) fail('WORKFLOW_EXAMPLES_RECOVERY_REQUIRES_REVIEW');
  return { at, requestId: idFor([runId, scenario, step, 'recovery', value.originalProcessor.owner, value.originalProcessor.expiresAt]) };
}
function validCalendarRecovery(value, runId, scenario, cutoff, originalRequestId) {
  return value?.schema === 'm1-workflow-example-clock-recovery/v1' && value.runId === runId && value.scenario === scenario
    && value.originalAt === cutoff && value.originalRequestId === originalRequestId
    && value.originalHealth?.requestId === originalRequestId && value.originalHealth.checkedAt === cutoff
    && value.originalHealthHash === digestHash(value.originalHealth) && UUID.test(value.originalProcessor?.owner || '')
    && Number.isSafeInteger(value.originalProcessor.expiresAt) && value.originalProcessor.expiresAt > cutoff
    && value.originalProcessor.expiresAt <= cutoff + 10 * MINUTE && value.effectiveAt === value.originalProcessor.expiresAt + 1
    && value.recoveryRequestId === idFor([runId, scenario, 'cutoff', 'recovery', value.originalProcessor.owner, value.originalProcessor.expiresAt]);
}
function validOriginal(value, runId) {
  return value?.schema === SCHEMA && value.runId === runId && value.synthetic === true
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && ((value.fixtureVersion === 1 && Object.keys(value).length === 5 && !Object.hasOwn(value, 'kind'))
      || (value.fixtureVersion === 2 && value.kind === 'history' && Object.keys(value).length === 6)
      || (value.fixtureVersion === 3 && value.kind === 'daily' && Object.keys(value).length === 6)
      || (value.fixtureVersion === 4 && value.kind === 'mailapp' && Object.keys(value).length === 6));
}
const originalFor = (runId, now, kind) => ({ schema: SCHEMA, runId, synthetic: true,
  fixtureVersion: kind === 'mailapp' ? 4 : kind === 'daily' ? 3 : kind === 'history' ? 2 : 1, ...(kind !== 'workflow' ? { kind } : {}), createdAt: now });
function validateOriginalKind(value, runId, kind) {
  if (!validOriginal(value, runId)) fail('WORKFLOW_EXAMPLES_ORIGINAL_INVALID');
  if ((value.kind || 'workflow') !== kind) fail('WORKFLOW_EXAMPLES_KIND_MISMATCH', 409, runId);
}
function validateResult(value, runId, kind = 'workflow') {
  const expectedKeys = keysFor(kind);
  if (!value || value.runId !== runId || value.synthetic !== true || value.complete !== true || !Array.isArray(value.scenarios)
    || value.scenarios.length !== expectedKeys.length || value.scenarios.some((scenario, index) => scenario.key !== expectedKeys[index]
      || typeof scenario.title !== 'string' || typeof scenario.passed !== 'boolean' || typeof scenario.summary !== 'string'
      || !Array.isArray(scenario.warnings) || scenario.warnings.some(w => typeof w.code !== 'string' || typeof w.message !== 'string')
      || !Array.isArray(scenario.checks) || scenario.checks.some(check => typeof check !== 'string')
      || !Array.isArray(scenario.messages) || scenario.messages.some(message => !['rev', 'richmond'].includes(message.gym)
        || typeof message.name !== 'string' || !Array.isArray(message.to) || !Array.isArray(message.cc)
        || [...message.to, ...message.cc].some(address => !['stu@example.invalid', 'trey@example.invalid', 'andrew@example.invalid'].includes(address))
        || ['subject', 'html', 'text', 'adminUrl'].some(field => typeof message[field] !== 'string')))) fail('WORKFLOW_EXAMPLES_SAVED_RESULT_INVALID');
  return value;
}
async function savedResult(store, runId, kind = 'workflow') {
  const saved = await read(store, key(runId) + 'result');
  if (!saved) return null;
  if (saved.data.schema !== SCHEMA || saved.data.hash !== digestHash(saved.data.result)) fail('WORKFLOW_EXAMPLES_SAVED_RESULT_INVALID');
  return validateResult(saved.data.result, runId, kind);
}

export async function readAttendanceWorkflowExamples(runId = null, deps = {}) {
  const store = await storeFor(deps);
  if (runId === null) runId = (await read(store, 'latestRun'))?.data?.runId || null;
  if (runId === null) return null;
  if (!UUID.test(runId || '')) fail('WORKFLOW_EXAMPLES_ID_INVALID', 400);
  const original = await read(store, key(runId) + 'original');
  if (!original) return null;
  if (!validOriginal(original.data, runId)) fail('WORKFLOW_EXAMPLES_ORIGINAL_INVALID');
  return savedResult(store, runId, original.data.kind || 'workflow');
}

export const prepareAttendanceWorkflowExamples = (runId, deps = {}) => prepareExamples(runId, deps, 'workflow');
export const prepareAttendanceWorkflowHistoryExamples = (runId, deps = {}) => prepareExamples(runId, deps, 'history');
export const prepareAttendanceWorkflowDailyExamples = (runId, deps = {}) => prepareExamples(runId, deps, 'daily');
export const prepareAttendanceWorkflowMailAppExamples = (runId, deps = {}) => prepareExamples(runId, deps, 'mailapp');
async function prepareExamples(runId, deps, kind) {
  if (!UUID.test(runId || '')) fail('WORKFLOW_EXAMPLES_ID_INVALID', 400);
  const store = await storeFor(deps), now = clock(deps);
  if (!Number.isSafeInteger(now) || now < 0) fail('WORKFLOW_EXAMPLES_CLOCK_INVALID');
  const original = await create(store, key(runId) + 'original', originalFor(runId, now, kind));
  validateOriginalKind(original.data, runId, kind);
  const result = await savedResult(store, runId, kind);
  const lease = await read(store, key(runId) + 'lease');
  const latest = await read(store, 'latestRun');
  if (!latest || latest.data.createdAt <= original.data.createdAt) {
    const written = await store.set('latestRun', JSON.stringify({ runId, createdAt: original.data.createdAt }), latest ? { onlyIfMatch: latest.etag } : { onlyIfNew: true });
    if (![true, false].includes(written?.modified) || !(await read(store, 'latestRun'))) fail('WORKFLOW_EXAMPLES_STORAGE_UNCONFIRMED');
  }
  return { runId, complete: Boolean(result), synthetic: true, state: result ? 'complete' : lease?.data.expiresAt > now ? 'running' : 'queued' };
}

function input(mode = 'issue', stamp = START, both = false) {
  const configuration = defaultDigestConfiguration(SCOPE, SAFE_ENV);
  // These retained examples keep their original synthetic 22:00 closing rule
  // and no-BCC message shape. Current operational defaults belong to new runs
  // of the dedicated configuration rehearsal, not this historical evidence.
  delete configuration.classFinishCutoffConfirmed;
  for (const route of Object.values(configuration.routing)) delete route.bcc;
  if (both) configuration.gyms.push({ id: 'richmond', name: 'Richmond TEST — synthetic examples', timezone: 'America/New_York', adminUrl: 'https://gib-richmond-test.netlify.app/m1/admin/' });
  const jobDate = makeDigestBinding(idFor('fixture'), 'scheduled', stamp).jobDate;
  const snapshots = configuration.gyms.map(gym => ({ gym: gym.id, attendance: { ok: true, ledger: {
    ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true, gym: gym.id, from: '2026-09-07', to: jobDate,
    days: datesThrough(jobDate).map(date => ({ date, attendanceHash: digestHash(['synthetic-example', gym.id, date]), records: [], warnings: [], review: null }))
  } }, staff: { ok: true, complete: true, items: [] } }));
  const schedules = configuration.gyms.map(gym => ({ gym: gym.id, timezone: 'America/New_York', days: datesThrough(jobDate).map(date => ({
    date, status: 'complete', observedAt: date + 'T12:00:00.000Z', sourceVersion: 'synthetic-workflow-examples/v1', occurrences: date === DATE ? [{
      label: '6:00 PM SYNTHETIC ' + gym.id + ' class', startAt: DATE + 'T22:00:00.000Z', endAt: DATE + 'T23:00:00.000Z', cancelled: false
    }] : []
  })) }));
  if (mode === 'clean') snapshots.forEach(snapshot => snapshot.attendance.ledger.days.find(day => day.date === DATE).records.push({
    recordId: 'synthetic-' + snapshot.gym, date: DATE, classLabel: '6:00 PM SYNTHETIC ' + snapshot.gym + ' class', instructor: 'SYNTHETIC recorded instructor', duration: 1, reviewRequired: false
  }));
  if (mode === 'incomplete') snapshots.forEach(snapshot => { snapshot.attendance = { ok: false, code: 'SYNTHETIC_UNAVAILABLE' }; snapshot.staff = { ok: false, code: 'SYNTHETIC_UNAVAILABLE' }; });
  if (mode === 'new-issue') schedules.forEach(schedule => schedule.days.find(day => day.date === jobDate).occurrences.push({
    label: '12:00 PM SYNTHETIC new ' + schedule.gym + ' class', startAt: jobDate + 'T16:00:00.000Z', endAt: jobDate + 'T17:00:00.000Z', cancelled: false
  }));
  if (mode === 'upcoming-canceled') schedules.forEach(schedule => {
    const occurrences = schedule.days.find(day => day.date === DATE).occurrences;
    occurrences[0].cancelled = true; occurrences[0].endAt = null;
    occurrences.push({ label: '11:00 PM SYNTHETIC upcoming class', startAt: '2026-09-25T03:00:00.000Z', endAt: '2026-09-25T03:45:00.000Z', cancelled: false });
  });
  const digest = buildAttendanceDigest({ jobDate, snapshots, schedules, configuration, now: stamp });
  const dueByGym = {}, opportunityDueByGym = {};
  for (const gym of configuration.gyms) {
    const perGym = { ...configuration, dailyLocalTime: gym.dailyLocalTime ?? configuration.dailyLocalTime,
      cutoffConfirmed: gym.cutoffConfirmed ?? configuration.cutoffConfirmed };
    const ownSchedules = schedules.filter(schedule => schedule.gym === gym.id), opportunity = latestEligibleOpportunity(configuration, stamp, gym.id);
    dueByGym[gym.id] = digestDue(jobDate, stamp, perGym, ownSchedules);
    opportunityDueByGym[gym.id] = opportunity ? digestDue(opportunity.date, stamp, perGym, ownSchedules) : 'awaiting-configuration';
  }
  return { digest, configuration, due: digestDue(jobDate, stamp, configuration, schedules), dueByGym, opportunityDueByGym };
}

function harness(store, runId, scenario) {
  const scoped = isolated(store, key(runId) + 'scenarios/' + scenario + '/');
  let stamp = START;
  const mailapp = scenario.startsWith('mailapp-');
  // A durable stand-in for the Google TEST ledger, inside this existing
  // example's namespace. Status reads never call MailApp or fabricate delivery.
  const google = async (message, options) => {
    assert(['attendanceMailStatus', 'attendanceMailSend'].includes(options?.action), 'Only the fixed Google status/send actions are simulated.');
    assert(message.synthetic === true && message.target === 'test' && message.from === 'revbjjops@gmail.com'
      && message.messageId.startsWith('m1-test-scheduled-rev-'), 'The MailApp example is Revolution TEST only.');
    const path = 'simulation/' + message.messageId, previous = await read(scoped, path);
    if (previous && previous.data.hash !== message.hash) fail('WORKFLOW_EXAMPLES_PROVIDER_BODY_CHANGED');
    const response = (value, override) => {
      const state = value?.state || 'not-attempted';
      const code = override || (state === 'not-attempted' ? 'MAILAPP_READY' : state === 'submitted' ? 'MAILAPP_SUBMITTED' : 'MAILAPP_CALL_UNCERTAIN');
      return { ok: ['MAILAPP_READY', 'MAILAPP_SUBMITTED'].includes(code), target: 'test', gym: 'rev', messageId: message.messageId, hash: message.hash,
        state, code, attemptedAt: value?.attemptedAt || null, completedAt: value?.completedAt || null, retrySafe: state === 'not-attempted' };
    };
    if (options.action === 'attendanceMailStatus') {
      if (scenario.includes('lost-reply') && previous?.data.state === 'submitted' && stamp === START)
        throw new Error('Synthetic Google status unavailable until reload');
      return response(previous?.data);
    }
    if (previous?.data.attemptedAt) {
      const repeated = { ...previous.data, sendRequests: (previous.data.sendRequests || 1) + 1 };
      if ((await scoped.set(path, JSON.stringify(repeated), { onlyIfMatch: previous.etag }))?.modified !== true) fail('WORKFLOW_EXAMPLES_SIMULATION_CONFLICT');
      return response(repeated);
    }
    if (scenario === 'mailapp-quota-before-call' && !previous) {
      const noCall = { hash: message.hash, calls: 0, sendRequests: 1, state: 'not-attempted', attemptedAt: null, completedAt: null };
      const saved = await create(scoped, path, noCall);
      return response(saved.data, 'MAILAPP_QUOTA_UNAVAILABLE');
    }
    const unknown = scenario.includes('unknown') && message.messageId.endsWith(DATE);
    const attemptedAt = new Date(stamp).toISOString();
    const claim = { hash: message.hash, calls: 1, sendRequests: (previous?.data.sendRequests || 0) + 1, state: 'unknown', attemptedAt, completedAt: null };
    const written = await scoped.set(path, JSON.stringify(claim), previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
    const retained = await read(scoped, path);
    if (!retained || ![true, false].includes(written?.modified)) fail('WORKFLOW_EXAMPLES_SIMULATION_UNCONFIRMED');
    if (!written.modified || unknown) return response(retained.data);
    const completed = { ...retained.data, state: 'submitted', completedAt: attemptedAt };
    const saved = await scoped.set(path, JSON.stringify(completed), { onlyIfMatch: retained.etag });
    if (saved?.modified !== true || digestHash((await read(scoped, path))?.data) !== digestHash(completed)) fail('WORKFLOW_EXAMPLES_SIMULATION_UNCONFIRMED');
    if (scenario.includes('lost-reply')) throw new Error('Synthetic Google reply unavailable after completion');
    return response(completed);
  };
  const provider = async message => {
    const id = message.messageId, hash = digestHash(message), path = 'simulation/' + id;
    let record;
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await read(scoped, path);
      if (previous && previous.data.hash !== hash) fail('WORKFLOW_EXAMPLES_PROVIDER_BODY_CHANGED');
      record = previous?.data || { hash, providerId: idFor([runId, scenario, id]), calls: 0, accepted: false };
      const updated = { ...record, calls: record.calls + 1 };
      const saved = await scoped.set(path, JSON.stringify(updated), previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
      if (saved?.modified === true) { record = updated; break; }
      if (attempt === 3) fail('WORKFLOW_EXAMPLES_SIMULATION_CONFLICT');
    }
    const behavior = scenario === 'history-templates' ? message.messageId.includes('-richmond-') ? 'permanent' : message.messageId.endsWith(DATE) ? 'accepted' : 'uncertain'
      : scenario === 'permanent-failure' || scenario === 'daily-holds-permanent' ? 'permanent'
      : scenario === 'daily-holds-transient' ? 'transient-rejection'
      : scenario.startsWith('daily-') && scenario.includes('unknown') && message.messageId.endsWith(DATE) ? 'uncertain'
      : ['uncertain-reload', 'expired-uncertain'].includes(scenario) ? 'uncertain'
        : ['temporary-recovery', 'immutable-after-attempt'].includes(scenario) ? 'temporary' : 'accepted';
    if (behavior === 'permanent') return new Response('{}', { status: 403 });
    if (behavior === 'transient-rejection') return new Response('{}', { status: 429 });
    if (behavior === 'temporary' && record.calls === 1) return new Response('{}', { status: 503 });
    const previous = await read(scoped, path);
    if (!previous.data.accepted) {
      const written = await scoped.set(path, JSON.stringify({ ...previous.data, accepted: true }), { onlyIfMatch: previous.etag });
      if (written?.modified !== true || !(await read(scoped, path))?.data.accepted) fail('WORKFLOW_EXAMPLES_SIMULATION_UNCONFIRMED');
    }
    if (behavior === 'uncertain' && record.calls === 1) throw new Error('Synthetic accepted response unavailable');
    return new Response(JSON.stringify({ id: record.providerId }), { status: 200 });
  };
  // Caller env, fetch and provider dependencies are deliberately never forwarded.
  // Every dispatch is this fixed local simulation, even if a real send key exists.
  const dependencies = () => ({ scope: SCOPE, workflowStore: scoped, clock: () => stamp, env: SAFE_ENV,
    simulatedProvider: { identity: 'fixed-synthetic-provider', ...(mailapp ? { kind: 'mailapp' } : {}), send: mailapp ? google : provider },
    fetch: async () => { throw new Error('Example network forbidden'); } });
  async function tick(stage, mode = 'issue', elapsed = 0, options = {}) {
    let boundary = 'checkpoint-read', requestId = idFor([runId, scenario, stage]), retained = false;
    try {
      const checkpoint = await read(scoped, 'steps/' + stage);
      if (checkpoint) return checkpoint.data;
      boundary = 'clock-recovery';
      const recovery = await calendarRecovery(scoped, runId, scenario, stage, START + elapsed);
      stamp = recovery.at; requestId = recovery.requestId;
      boundary = 'input-build';
      const data = input(mode, stamp, options.both);
      if (options.unconfigured) data.configuration.routing.rev.reviewer.address = null;
      const binding = makeDigestBinding(requestId, 'scheduled', options.createdAt ?? stamp);
      const request = { ...data, binding, ...(options.due ? { due: options.due,
        dueByGym: Object.fromEntries(data.configuration.gyms.map(gym => [gym.id, options.due])),
        opportunityDueByGym: Object.fromEntries(data.configuration.gyms.map(gym => [gym.id, options.due])) } : {}) };
      boundary = options.concurrent ? 'concurrent-process' : 'process';
      if (options.concurrent) {
        // A rejected peer must not let this supported background invocation
        // finish while its other processor still owns unfinished storage work.
        const outcomes = await Promise.allSettled([processAttendanceWorkflow(request, dependencies()), processAttendanceWorkflow(request, dependencies())]);
        for (let worker = 0; worker < outcomes.length; worker++) if (outcomes[worker].status === 'rejected') {
          await retainFailure(scoped, runId, scenario, stage, boundary, requestId, outcomes[worker].reason, worker); retained = true;
        }
        const rejected = outcomes.find(outcome => outcome.status === 'rejected');
        if (rejected) throw rejected.reason;
      } else await processAttendanceWorkflow(request, dependencies());
      boundary = 'messages-read';
      const messages = await workflowMessages(SCOPE, dependencies());
      boundary = 'provider-readback';
      const providerStates = await Promise.all(messages.messages.map(async entry => ({ messageId: entry.messageId,
        receipt: (await read(scoped, 'simulation/' + entry.messageId))?.data || null })));
      boundary = 'health-read';
      const result = { messages, health: await workflowHealth(SCOPE, dependencies()), digest: data.digest, providerStates };
      boundary = 'checkpoint-save';
      return (await create(scoped, 'steps/' + stage, result)).data;
    } catch (error) {
      if (!retained) await retainFailure(scoped, runId, scenario, stage, boundary, requestId, error);
      throw error;
    }
  }
  async function simulation(id) { return (await read(scoped, 'simulation/' + id))?.data || null; }
  async function health(elapsed) { stamp = START + elapsed; return workflowHealth(SCOPE, dependencies()); }
  return { tick, simulation, health, scoped, dependencies, at: value => { stamp = value; } };
}

const entries = result => result.messages.messages;
const firstMessage = result => entries(result)[0];
const stepProviderCalls = result => result.providerStates.reduce((total, item) => total + (item.receipt?.calls || 0), 0);
function publicMessages(result) {
  return entries(result).filter(entry => entry.message).map(entry => ({ gym: entry.gym, name: entry.gym === 'rev' ? 'Stu — synthetic address' : 'Trey — synthetic address',
    to: entry.message.to, cc: entry.message.cc || [], subject: entry.message.subject, html: entry.message.html, text: entry.message.text,
    adminUrl: (entry.gym === 'rev' ? 'https://deploy-preview-89--gib-live.netlify.app' : 'https://gib-richmond-test.netlify.app') + '/m1/admin/' }));
}
function warning(code, message) { return { code, message }; }

const HISTORY_DAY = '2027-02-06';
const historyTime = day => Date.parse(day + 'T22:30:00-05:00');
const canonicalMessage = message => ({ messageId: message.messageId, from: message.from, to: message.to, cc: message.cc,
  subject: message.subject, html: message.html, text: message.text, synthetic: message.synthetic, target: message.target });
async function historySeed(store, runId) {
  const h = harness(store, runId, 'history-main'), existing = await read(h.scoped, 'fixture/seed');
  if (existing) return { h, seed: existing.data };
  const templates = harness(store, runId, 'history-templates');
  await templates.tick('first', 'issue', 0, { both: true });
  const second = await templates.tick('second', 'issue', 24 * 60 * MINUTE, { both: true });
  const originals = entries(second), retained = originals.filter(entry => entry.firstAttemptAt);
  assert(originals.length === 4 && retained.length === 3, 'Three original simulated attempts establish accepted, unknown and rejected history.');
  const ids = [], messageHashes = [], engineHashes = [];
  async function copy(path, data) {
    const saved = await create(h.scoped, path, data);
    if (digestHash(saved.data) !== digestHash(data)) fail('WORKFLOW_HISTORY_FIXTURE_CONFLICT');
  }
  for (const entry of originals) {
    await copy('workflow/messages/' + entry.messageId, entry);
    ids.push(entry.messageId); messageHashes.push([entry.messageId, digestHash(entry.message)]);
    const enginePath = 'workflow/delivery/messages/' + entry.messageId, engine = await read(templates.scoped, enginePath);
    if (!engine) continue;
    await copy(enginePath, engine.data); engineHashes.push([enginePath, digestHash(engine.data)]);
    for (const attempt of engine.data.attempts) {
      const path = 'workflow/delivery/attempts/' + entry.messageId + '/' + attempt.attemptId;
      const receipt = await read(templates.scoped, path);
      if (receipt) { await copy(path, receipt.data); engineHashes.push([path, digestHash(receipt.data)]); }
    }
    await copy('simulation/' + entry.messageId, await templates.simulation(entry.messageId));
  }
  const archives = Array.from({ length: 252 }, (_, index) => {
    const gym = index % 2 ? 'richmond' : 'rev';
    const date = new Date(Date.parse('2026-09-26T12:00:00.000Z') + Math.floor(index / 2) * 86400000).toISOString().slice(0, 10);
    const template = originals.find(entry => entry.gym === gym), messageId = 'm1-test-scheduled-' + gym + '-' + date;
    const message = { ...template.message, messageId, subject: '[SYNTHETIC HISTORY] ' + gym + ' ' + date,
      html: '<p>Isolated synthetic retained message. No email was attempted for this fixture.</p>',
      text: 'Isolated synthetic retained message. No email was attempted for this fixture.' };
    message.hash = digestHash(canonicalMessage(message));
    return { schema: 'm1-digest-workflow/v1', messageId, gym, date, checkAt: Date.parse(date + 'T12:00:00Z'),
      firstAttemptAt: null, state: 'suppressed', code: 'NO_OUTSTANDING_ITEMS', message, attemptCount: 0,
      nextAttemptAt: null, retryBefore: null, delivery: null };
  });
  // Fixed synthetic originals only. Bounded writes seed history efficiently;
  // Google, Sheets and hundreds of provider requests are never involved.
  for (let offset = 0; offset < archives.length; offset += 8) {
    await Promise.all(archives.slice(offset, offset + 8).map(entry => copy('workflow/messages/' + entry.messageId, entry)));
  }
  for (const entry of archives) { ids.push(entry.messageId); messageHashes.push([entry.messageId, digestHash(entry.message)]); }
  await copy('workflow/index', { ids });
  const seed = { ids, messageHashes, engineHashes, originals: retained, legacyHash: digestHash({ ids }) };
  await create(h.scoped, 'fixture/seed', seed);
  return { h, seed };
}
async function historyMigration(h) {
  if ((await read(h.scoped, 'fixture/migrated'))?.data.complete) return;
  const set = h.scoped.set;
  h.scoped.set = async (path, raw, options) => {
    if ((path.startsWith('workflow/history/plans/') || path.startsWith('workflow/history/months/'))
      && !(await read(h.scoped, 'fixture/interrupted'))) {
      await create(h.scoped, 'fixture/interrupted', { code: 'SYNTHETIC_HISTORY_WRITE_INTERRUPTED', boundary: path.startsWith('workflow/history/plans/') ? 'plan' : 'month' });
      throw new Error('SYNTHETIC_HISTORY_WRITE_INTERRUPTED');
    }
    return set(path, raw, options);
  };
  try {
    const before = await read(h.scoped, 'fixture/interrupted');
    if (!before) {
      let interrupted = false;
      try { await migrateWorkflowHistory(SCOPE, h.dependencies()); }
      catch (error) { if (error.message !== 'SYNTHETIC_HISTORY_WRITE_INTERRUPTED') throw error; interrupted = true; }
      assert(interrupted && (await read(h.scoped, 'fixture/interrupted')), 'A real history-plan write interruption was captured.');
    }
    let migration;
    for (let step = 0; step < 20; step++) {
      migration = await migrateWorkflowHistory(SCOPE, h.dependencies());
      if (migration.complete) break;
    }
    assert(migration?.complete === true, 'Bounded migration resumes to completion after the interrupted write.');
    await create(h.scoped, 'fixture/migrated', { complete: true, migration });
  } finally { h.scoped.set = set; }
}
async function historyPages(h) {
  const recent = await workflowMessages(SCOPE, h.dependencies());
  assert(recent.historyComplete === true && recent.messages.length <= 8, 'The ordinary recent-history read remains bounded.');
  if (!recent.nextCursor) return recent.messages;
  // The recent overview is separate from the complete archive's first page.
  const messages = [], ids = new Set(), cursors = new Set(); let cursor = recent.nextCursor;
  for (let page = 0; page < 40; page++) {
    const response = await workflowMessages(SCOPE, { ...h.dependencies(), ...(cursor ? { historyCursor: cursor } : {}) });
    assert(response.historyComplete === true && response.messages.length <= 32, 'Every history page is complete and bounded.');
    for (const message of response.messages) { assert(!ids.has(message.messageId), 'History pagination returns each permanent message ID once.'); ids.add(message.messageId); messages.push(message); }
    if (!response.nextCursor) return messages;
    assert(!cursors.has(response.nextCursor), 'History pagination advances without looping.'); cursors.add(response.nextCursor); cursor = response.nextCursor;
  }
  throw Object.assign(new Error('History pagination completes within its bounded fixture size.'), { exampleCheck: true });
}
async function historyOriginalsIntact(h, seed) {
  for (const [path, hash] of seed.engineHashes) assert(digestHash((await read(h.scoped, path))?.data) === hash, 'Original delivery ledger and audit receipt bytes remain unchanged.');
  for (const original of seed.originals) assert(digestHash((await read(h.scoped, 'workflow/messages/' + original.messageId))?.data?.message) === digestHash(original.message), 'An original message body remains unchanged.');
  assert(digestHash((await read(h.scoped, 'workflow/index'))?.data) === seed.legacyHash, 'The original legacy index remains preserved.');
}
async function historyProviderCalls(h) {
  const paths = [];
  for await (const page of h.scoped.list({ prefix: 'simulation/', paginate: true })) {
    paths.push(...page.blobs.map(blob => blob.key));
    assert(paths.length <= 16, 'The focused history fixture never accumulates unexpected provider identities.');
  }
  let calls = 0;
  for (const path of paths) calls += (await read(h.scoped, path))?.data?.calls || 0;
  return calls;
}
async function historyScenario(store, runId, name) {
  const { h, seed } = await historySeed(store, runId);
  h.at(historyTime(name === 'history-over-256' ? '2027-01-31' : HISTORY_DAY));
  await historyMigration(h);
  let title, summary, checks, warnings = [], messages = [];
  if (name === 'history-over-256') {
    for (let day = 1; day <= 5; day++) await h.tick('capacity-' + day, 'clean', historyTime('2027-02-0' + day) - START);
    const retained = await historyPages(h);
    assert(retained.length === 261 && seed.ids.every(id => retained.some(message => message.messageId === id)), 'More than 256 retained messages are readable without dropping an old permanent ID.');
    for (const [id, hash] of seed.messageHashes) assert(digestHash(retained.find(message => message.messageId === id)?.message) === hash, 'Migration preserves every retained original body.');
    await historyOriginalsIntact(h, seed);
    title = 'History remains usable beyond 256 messages'; summary = '261 isolated synthetic messages were saved and read back across bounded history pages.';
    checks = ['256 preserved legacy references migrated.', 'Five new daily records saved through the real workflow.', '261 unique permanent IDs read across bounded pages.', 'All retained bodies and original audit receipts unchanged.'];
  } else if (name === 'history-old-barriers') {
    const result = await h.tick('barriers', 'issue', historyTime(HISTORY_DAY) - START, { both: true });
    for (const [gym, code] of [['rev', null], ['richmond', 'PRIOR_PERMANENT_REJECTION_UNCHANGED']]) {
      const draft = (await read(h.scoped, 'workflow/messages/m1-test-scheduled-' + gym + '-' + HISTORY_DAY))?.data;
      if (code) {
        assert(draft?.attemptCount === 0 && !draft.firstAttemptAt && draft.code === code, 'An old permanent rejection still blocks a new daily identity.');
        assert(await h.simulation(draft.messageId) === null, 'The blocked new daily draft makes no provider call.');
      } else assert(draft?.attemptCount === 1 && (await h.simulation(draft.messageId))?.calls === 1, 'A genuinely new opportunity proceeds while old unknown history remains retained.');
    }
    for (const original of seed.originals) assert((await h.simulation(original.messageId))?.calls === 1, 'No original attempt is silently replayed while adding history.');
    assert(await historyProviderCalls(h) === 4, 'Three original calls plus one eligible new daily call are retained.');
    await historyOriginalsIntact(h, seed); messages = publicMessages(result).filter(message => message.text.includes('SYNTHETIC'));
    title = 'Retained history respects the updated daily policy'; summary = 'The old unknown remains unresolved, while a fresh eligible Revolution reminder proceeds. Richmond’s permanent rejection still holds its new draft.';
    warnings = [warning('HISTORICAL_POLICY_SUPERSEDED', 'Earlier saved runs tested a permanent hold for unknown acceptance. The approved daily policy now retires old retries at the next eligible assessment; earlier saved evidence remains unchanged.')];
    checks = ['Old unknown receipts retained without another old attempt.', 'Old permanent-rejection barrier retained.', 'New Revolution daily attempt permitted.', 'Four total simulated calls, including all three originals.'];
  } else if (name === 'history-late-event') {
    const original = seed.originals.find(item => item.gym === 'rev' && item.delivery?.state === 'accepted');
    const event = { eventId: 'synthetic-history-late-' + runId, providerId: original.delivery.providerId, type: 'email.delivered',
      occurredAt: new Date(historyTime(HISTORY_DAY)).toISOString(), from: original.message.from, to: original.message.to };
    const acknowledgment = await recordWorkflowDeliveryEvidence(event, { ...h.dependencies(), deliveryEvidenceVerified: true });
    const updated = (await read(h.scoped, 'workflow/messages/' + original.messageId))?.data;
    assert(acknowledgment.matched === true && updated?.state === 'delivered', 'The late synthetic event finds its original accepted message outside recent history.');
    for (const other of seed.originals.filter(item => item.messageId !== original.messageId)) {
      const retained = (await read(h.scoped, 'workflow/messages/' + other.messageId))?.data;
      assert(retained.state !== 'delivered', 'The late event does not resolve another original.');
    }
    await historyOriginalsIntact(h, seed);
    assert(await historyProviderCalls(h) === 4, 'The late synthetic event makes no provider request.');
    title = 'A late event still reaches its original message'; summary = 'A verified synthetic delivery event matched only the original accepted message, despite more than 256 later history records.';
    warnings = [warning('SIMULATED_EVENT_ONLY', 'This is an isolated synthetic verified event, not evidence of real inbox delivery.')];
    checks = ['Original permanent provider/message association found.', 'Only the intended original received the event.', 'Original body, acceptance receipt and other failures preserved.'];
  } else {
    const receipt = await read(h.scoped, 'fixture/interrupted'), migrated = await read(h.scoped, 'fixture/migrated');
    const retained = await historyPages(h);
    assert(receipt?.data.code === 'SYNTHETIC_HISTORY_WRITE_INTERRUPTED' && migrated?.data.complete === true, 'The interrupted central storage change is retained and completed.');
    assert(retained.length === 263 && new Set(retained.map(item => item.messageId)).size === 263, 'Storage recovery retains all 263 original and new IDs exactly once.');
    await historyOriginalsIntact(h, seed);
    title = 'An interrupted storage upgrade resumes safely'; summary = 'One simulated central write failed during migration; retry resumed the same saved history without losing or duplicating records.';
    checks = ['Actual migration write interruption recorded.', 'Same isolated run resumed; no replacement originals.', '263 unique original/new IDs readable afterward.', 'Legacy index, immutable message bodies and audit receipts preserved.'];
  }
  return { key: name, title, passed: true, summary, warnings, messages, checks };
}

async function scenario(store, runId, name) {
  const h = harness(store, runId, name); let result, title, summary, checks = [], warnings = [];
  if (name === 'routing') {
    title = 'Stu and Trey receive only their own gym'; result = await h.tick('first', 'issue', 0, { both: true });
    assert(entries(result).length === 2, 'Each gym has its own saved message.');
    for (const entry of entries(result)) {
      assert(JSON.stringify(entry.message.to) === JSON.stringify([entry.gym === 'rev' ? 'stu@example.invalid' : 'trey@example.invalid']), 'Each message uses the configured gym reviewer.');
      assert((entry.message.cc || []).length === 0, 'Optional Andrew copy stays off.');
      assert(!entry.message.text.includes('SYNTHETIC ' + (entry.gym === 'rev' ? 'richmond' : 'rev') + ' class'), 'Other gym details are absent.');
    }
    checks = ['One separate message per gym.', 'Only synthetic Stu/Trey recipients.', 'Optional Andrew copy disabled.', 'Other gym details excluded.']; summary = 'Separate simulated messages show the correct reviewer and gym content.';
  } else if (name === 'clean' || name === 'upcoming-canceled') {
    title = name === 'clean' ? 'Complete clean checks produce no email' : 'Upcoming and canceled classes stay excluded';
    result = await h.tick('first', name);
    assert(result.digest.itemCount === 0 && result.digest.readFailures.length === 0, 'No missing instructor was inferred.');
    assert(entries(result).every(entry => entry.attemptCount === 0), 'No simulated delivery was attempted.');
    checks = ['No missing-person inference.', 'No delivery attempt.']; summary = name === 'clean' ? 'One valid instructor satisfies the class; an unreviewed day alone does not trigger email.' : 'Future teaching and a resolved cancellation generate no missing-sign-in alert.';
  } else if (name === 'incomplete') {
    title = 'Unavailable checks remain visibly incomplete'; result = await h.tick('first', 'incomplete');
    assert(result.digest.itemCount === 0 && result.digest.readFailures.length === 2, 'Unavailable reads are not missing-person counts.');
    assert(firstMessage(result)?.message.text.includes('could not be checked'), 'The captured message explains incomplete checks.');
    assert(!firstMessage(result).message.text.includes('No outstanding items were found'), 'Incomplete checks never show an all-clear.');
    assert(firstMessage(result).attemptCount === 1 && firstMessage(result).delivery?.state === 'accepted'
      && firstMessage(result).state === 'unconfirmed' && (await h.simulation(firstMessage(result).messageId))?.calls === 1,
    'A fresh incomplete-check warning reaches the simulator but never claims real delivery.');
    warnings = [warning('CHECK_INCOMPLETE', 'Simulated attendance and Staff Clock reads were unavailable; this is not an all-clear.'),
      warning('SIMULATED_ACCEPTANCE_ONLY', 'The simulator accepted the warning; real email delivery remains unconfirmed.')];
    checks = ['Separate incomplete-check warning.', 'One simulated warning-message attempt.', 'Provider acceptance remains unconfirmed delivery.', 'No invented missing instructor.', 'No false all-clear.']; summary = 'The simulated message reaches the provider and states exactly which checks could not finish.';
  } else if (name === 'duplicate-concurrent') {
    title = 'Duplicate and concurrent ticks keep one message'; result = await h.tick('first', 'issue', 0, { concurrent: true });
    result = await h.tick('repeat', 'issue', MINUTE);
    assert(entries(result).length === 1, 'Repeated ticks retain one daily message.');
    assert((await h.simulation(firstMessage(result).messageId))?.calls === 1, 'Only one provider attempt was made.');
    checks = ['Concurrent ticks share one daily identity.', 'Repeat tick makes no duplicate attempt.']; summary = 'The original saved message survives concurrent and repeated ticks.';
  } else if (['temporary-recovery', 'uncertain-reload', 'immutable-after-attempt'].includes(name)) {
    title = name === 'temporary-recovery' ? 'A temporary failure recovers on the next eligible tick' : name === 'uncertain-reload' ? 'An uncertain reply survives reopening without duplicate acceptance' : 'An attempted message keeps its original body after resolution';
    const before = await h.tick('first');
    assert(firstMessage(before).attemptCount === 1, 'The initial attempt is retained.');
    const resumed = harness(store, runId, name);
    result = await resumed.tick('retry', name === 'immutable-after-attempt' ? 'clean' : 'issue', 16 * MINUTE);
    const entry = firstMessage(result), simulation = await resumed.simulation(entry.messageId);
    assert(entry.attemptCount === 2 && simulation.calls === 2 && simulation.accepted, 'One bounded retry confirms the same provider acceptance.');
    assert(entry.messageId === firstMessage(before).messageId && digestHash(entry.message) === digestHash(firstMessage(before).message), 'Retry keeps the original identity and exact body.');
    checks = ['Failure receipt retained.', 'Later eligible tick retries the same identity.', 'Original attempted body retained.', 'One simulated accepted provider identity.'];
    if (name === 'temporary-recovery') {
      const claim = harness(store, runId, 'temporary-recovery-claim'), set = claim.scoped.set;
      claim.scoped.set = async (path, raw, options) => {
        if (path.startsWith('workflow/delivery/messages/') && !(await read(claim.scoped, 'simulation/fault-consumed'))) {
          // Persist this one simulated interruption before throwing. A runner
          // reload cannot re-arm it or change the original failed claim.
          await create(claim.scoped, 'simulation/fault-consumed', { code: 'SYNTHETIC_PRE_ENGINE_WRITE_FAILURE' });
          throw new Error('Synthetic pre-engine claim persistence failed');
        }
        return set(path, raw, options);
      };
      const interrupted = await claim.tick('claim'), pending = firstMessage(interrupted);
      assert(pending.attemptCount === 0 && pending.delivery?.state === 'not-started'
        && interrupted.providerStates.find(item => item.messageId === pending.messageId)?.receipt === null, 'A failed engine claim makes no provider request.');
      const healed = await claim.tick('healed', 'issue', 2 * MINUTE), retained = firstMessage(healed);
      assert(retained.messageId === pending.messageId && JSON.stringify(retained.message.to) === JSON.stringify(pending.message.to)
        && retained.message.text.includes('Fresh assessment: ' + new Date(START + 2 * MINUTE).toISOString())
        && retained.attemptCount === 1 && retained.delivery?.state === 'accepted'
        && (await claim.simulation(retained.messageId))?.calls === 1, 'Expired unattempted claim recovers the same daily identity once using a fresh assessment.');
      await claim.tick('repeat', 'issue', 3 * MINUTE);
      assert((await claim.simulation(retained.messageId)).calls === 1, 'Recovered first attempt is not repeated.');
      checks.push('A pre-engine storage failure makes zero provider calls.', 'The expired saved claim recovers the same message exactly once.');
    }
    warnings = [warning('SIMULATED_ACCEPTANCE_ONLY', 'A simulated provider acceptance is not evidence of real email delivery.')];
    summary = name === 'immutable-after-attempt' ? 'A later clean check cannot rewrite an already attempted email.' : 'Reopening uses the retained message and the same simulated provider identity.';
  } else if (name === 'permanent-failure') {
    title = 'A permanent rejection also blocks a new daily send'; const before = await h.tick('first');
    result = await h.tick('next-day', 'issue', 24 * 60 * MINUTE);
    const prior = firstMessage(before), original = entries(result).find(entry => entry.messageId === prior.messageId);
    const draft = entries(result).find(entry => entry.messageId !== prior.messageId);
    assert(original?.attemptCount === 1 && original.delivery?.state === 'rejected'
      && digestHash(original.message) === digestHash(prior.message)
      && digestHash(original.delivery.receipts) === digestHash(prior.delivery.receipts), 'Original permanent rejection, exact message and audit receipts remain unchanged.');
    assert(draft?.date === '2026-09-25' && draft.attemptCount === 0 && !draft.firstAttemptAt
      && !draft.delivery && draft.state === 'prepared' && draft.code === 'PRIOR_PERMANENT_REJECTION_UNCHANGED', 'The next due day retains a blocked draft with no delivery attempt.');
    assert(result.providerStates.reduce((total, item) => total + (item.receipt?.calls || 0), 0) === 1
      && result.providerStates.find(item => item.messageId === draft.messageId)?.receipt === null, 'Permanent rejection cannot reset provider attempts under a new daily identity.');
    warnings = [warning('PERMANENT_DELIVERY_FAILURE', 'The simulator permanently rejected the original email; the next day’s draft remains unattempted until the failure is addressed.')];
    checks = ['Original permanent rejection and receipts preserved.', 'Same unresolved issue checked at the next due day, 24 hours later.', 'One total provider call across both dates.', 'Next-day draft retained without an attempt.'];
    summary = 'A new date cannot restart delivery after a permanent failure.';
  } else if (name === 'resolved-before-attempt') {
    title = 'Resolved work is suppressed before any first attempt'; await h.tick('before', 'issue', 0, { due: 'not-due' }); result = await h.tick('resolved', 'clean', MINUTE);
    assert(result.digest.itemCount === 0 && entries(result).every(entry => entry.attemptCount === 0), 'Resolved items never reach the provider.');
    checks = ['Fresh complete read sees the resolution.', 'No provider attempt.']; summary = 'Items fixed before the first eligible send no longer trigger an email.';
  } else if (name === 'expired-uncertain') {
    title = 'New daily policy preserves old uncertainty without blocking fresh work'; const before = await h.tick('first');
    result = await h.tick('next-day', 'issue', 24 * 60 * MINUTE);
    const prior = firstMessage(before), original = entries(result).find(entry => entry.messageId === prior.messageId);
    const draft = entries(result).find(entry => entry.messageId !== prior.messageId);
    assert(original?.attemptCount === 1 && original.delivery?.state === 'unknown'
      && original.code === 'MANUAL_RECONCILIATION_REQUIRED'
      && digestHash(original.message) === digestHash(prior.message)
      && digestHash(original.delivery.receipts) === digestHash(prior.delivery.receipts), 'Original unknown acceptance, exact message and audit receipts remain unchanged.');
    assert(draft?.date === '2026-09-25' && draft.attemptCount === 1 && draft.firstAttemptAt && draft.delivery?.state === 'unknown', 'The next eligible assessment uses a new daily identity without rewriting old uncertainty.');
    assert(result.providerStates.reduce((total, item) => total + (item.receipt?.calls || 0), 0) === 2
      && (await h.simulation(original.messageId))?.calls === 1, 'The old identity is not retried; one genuinely new daily assessment is attempted.');
    warnings = [warning('MANUAL_RECONCILIATION_REQUIRED', 'Whether the original email was accepted remains unknown; the fresh daily assessment does not claim to resolve it.'),
      warning('HISTORICAL_POLICY_SUPERSEDED', 'The earlier permanent hold for unknown acceptance was superseded by the approved daily policy. Previously saved results remain unchanged.')];
    checks = ['Unknown acceptance remains an honest unresolved state.', 'Original identity and receipts preserved past 23 hours.', 'One new eligible daily assessment, with current unresolved work.', 'Old retry retired; two total calls across two identities.'];
    summary = 'The fresh daily assessment proceeds while preserving the old uncertain attempt and its original retry window.';
  } else {
    title = 'Overlapping checks and overdue status remain honest'; await h.tick('newer', 'incomplete', 30000);
    // The older request returns later, still inside its original 60-second
    // binding. Wall time never moves backward to manufacture this ordering.
    result = await h.tick('older', 'clean', 31000, { createdAt: START });
    assert(Date.parse(result.health.checkedAt) === START + 30000, 'The newer request remains the health authority.');
    assert(JSON.stringify(result.health).includes('INCOMPLETE'), 'An older clean result cannot erase a newer failed check.');
    const overdue = await h.health(31 * MINUTE);
    assert(/OVERDUE|STALE/.test(JSON.stringify(overdue)), 'Expired evidence produces a visible overdue warning.');
    assert(!JSON.stringify(overdue).includes('@example.invalid') && !JSON.stringify(overdue).includes('SYNTHETIC rev class'), 'Public health stays aggregate-only.');
    warnings = [warning('CHECK_OVERDUE', 'The simulated last check is overdue; status cannot be treated as clear.')];
    checks = ['Newer incomplete result survives a late older clean result.', 'Overdue evidence produces a warning.', 'Aggregate health contains no names, addresses or class details.']; summary = 'Late results and missing future checks cannot create a false all-clear.';
  }
  return { key: name, title, passed: true, summary, warnings, messages: publicMessages(result), checks };
}

const dailyTime = (date, time = '22:30', offset = '-04:00') => Date.parse(date + 'T' + time + ':00' + offset);
const dailyEntry = (result, date) => entries(result).find(entry => entry.messageId === 'm1-test-scheduled-rev-' + date);
async function dailyOriginalIntact(h, original) {
  const saved = (await read(h.scoped, 'workflow/messages/' + original.messageId))?.data;
  assert(saved && digestHash(saved.message) === digestHash(original.message)
    && digestHash(saved.delivery?.receipts) === digestHash(original.delivery?.receipts)
    && saved.retryBefore === original.retryBefore, 'The original body, receipts and 23-hour window remain unchanged.');
  return saved;
}
async function dailyOverlap(store, runId) {
  const h = harness(store, runId, 'daily-overlap-recovery');
  if (!(await read(h.scoped, 'fixture/overlap-complete'))) {
    let stamp = dailyTime('2026-09-25', '21:55');
    const dependencies = () => ({ ...h.dependencies(), clock: () => stamp });
    const request = (stage, mode) => ({ ...input(mode, stamp), binding: makeDigestBinding(idFor([runId, 'daily-overlap', stage]), 'scheduled', stamp) });
    const get = h.scoped.getWithMetadata;
    let release, reached, paused = false;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { reached = resolve; });
    const earlierPause = await read(h.scoped, 'fixture/paused');
    if (!earlierPause) {
      h.scoped.getWithMetadata = async (path, options) => {
        const value = await get(path, options);
        if (!paused && path === 'workflow/delivery/messages/m1-test-scheduled-rev-2026-09-24' && value?.data.attempts?.length === 1) {
          paused = true;
          await create(h.scoped, 'fixture/paused', { stage: 'ENGINE_LEDGER_READBACK', messageId: value.data.message.messageId });
          reached(true); await gate;
        }
        return value;
      };
      const old = processAttendanceWorkflow(request('original', 'issue'), dependencies()).then(value => ({ value }), error => ({ error: error.message }));
      try {
        assert(await Promise.race([waiting, old.then(() => false)]), 'The original request reaches the engine readback pause before any provider call.');
        stamp = dailyTime('2026-09-25', '22:00');
        const pending = await processAttendanceWorkflow(request('overlapping', 'clean'), dependencies());
        assert(pending.pending === true && await historyProviderCalls(h) === 0, 'A fresh overlapping request waits while the original coordinator lease is active.');
        await create(h.scoped, 'fixture/overlap-held', { pending: true, providerCalls: 0 });
        stamp = dailyTime('2026-09-25', '22:06');
        await processAttendanceWorkflow(request('takeover', 'clean'), dependencies());
      } finally { release(); h.scoped.getWithMetadata = get; }
      const outcome = await old;
      assert(!outcome.error || outcome.error === 'WORKFLOW_PROCESSOR_SUPERSEDED', 'The superseded original ends safely.');
    } else {
      // A terminated example invocation leaves the original engine claim and
      // its pause receipt. Resume the same clean takeover after lease expiry.
      stamp = dailyTime('2026-09-25', '22:06');
      await processAttendanceWorkflow(request('takeover', 'clean'), dependencies());
    }
    assert((await read(h.scoped, 'fixture/overlap-held'))?.data.pending === true, 'The active-lease overlap was recorded before takeover.');
    assert((await read(h.scoped, 'workflow/opportunities/rev'))?.data.decision === 'clean' && await historyProviderCalls(h) === 0,
      'The durable newer clean decision and final engine gate prevent an old send.');
    await create(h.scoped, 'fixture/overlap-complete', { providerCalls: 0, decision: 'clean' });
  }
  const interrupted = harness(store, runId, 'daily-takeover-unknown');
  const original = firstMessage(await interrupted.tick('original'));
  if (!(await read(interrupted.scoped, 'fixture/interruption-observed'))) {
    const set = interrupted.scoped.set;
    interrupted.scoped.set = async (path, raw, options) => {
      if (path === 'workflow/opportunities/rev' && JSON.parse(raw).opportunityDate === '2026-09-25'
        && !(await read(interrupted.scoped, 'fixture/interrupted'))) {
        await create(interrupted.scoped, 'fixture/interrupted', { code: 'SYNTHETIC_OPPORTUNITY_WRITE_FAILURE' });
        throw new Error('SYNTHETIC_OPPORTUNITY_WRITE_FAILURE');
      }
      return set(path, raw, options);
    };
    let failed = false;
    try { await interrupted.tick('interrupted', 'new-issue', dailyTime('2026-09-25') - START); }
    catch { failed = true; }
    finally { interrupted.scoped.set = set; }
    assert(failed && (await read(interrupted.scoped, 'fixture/interrupted')), 'The actual opportunity write was interrupted.');
    assert(await historyProviderCalls(interrupted) === 1, 'Unconfirmed takeover persistence makes no new provider call.');
    await create(interrupted.scoped, 'fixture/interruption-observed', { providerCalls: 1 });
  }
  const result = await interrupted.tick('recovered', 'new-issue', dailyTime('2026-09-25', '22:32') - START);
  await interrupted.tick('repeat', 'new-issue', dailyTime('2026-09-25', '22:33') - START);
  assert(dailyEntry(result, '2026-09-25')?.attemptCount === 1 && await historyProviderCalls(interrupted) === 2,
    'The interrupted takeover recovers exactly one new daily attempt.');
  await dailyOriginalIntact(interrupted, original);
  return result;
}
async function dailyHolds(store, runId) {
  const permanent = harness(store, runId, 'daily-holds-permanent');
  await permanent.tick('original');
  const rejected = await permanent.tick('next', 'new-issue', dailyTime('2026-09-25') - START);
  assert(dailyEntry(rejected, '2026-09-25')?.code === 'PRIOR_PERMANENT_REJECTION_UNCHANGED'
    && await historyProviderCalls(permanent) === 1, 'New eligibility preserves a permanent unchanged-route rejection.');
  const transient = harness(store, runId, 'daily-holds-transient');
  await transient.tick('original', 'issue', dailyTime('2026-09-25', '21:50') - START);
  const clean = await transient.tick('clean', 'clean', dailyTime('2026-09-25') - START);
  assert(clean.health.failedCount === 0 && clean.health.historicalFailedCount === 1 && !clean.health.codes.includes('DELIVERY_FAILED')
    && await historyProviderCalls(transient) === 1, 'A superseded generic failure remains historical without making a fresh clean check appear currently failed.');
  const configuration = harness(store, runId, 'daily-holds-configuration');
  const unconfigured = await configuration.tick('missing-reviewer', 'issue', 0, { unconfigured: true });
  assert(firstMessage(unconfigured)?.state === 'not-configured' && await historyProviderCalls(configuration) === 0, 'Missing reviewer configuration prevents a first attempt.');
  const storage = harness(store, runId, 'daily-storage-unknown'), original = firstMessage(await storage.tick('original'));
  if (!(await read(storage.scoped, 'fixture/storage-held'))) {
    const get = storage.scoped.getWithMetadata;
    let observed = false;
    storage.scoped.getWithMetadata = async (path, options) => {
      if (path === 'workflow/delivery/messages/' + original.messageId) { observed = true; throw new Error('SYNTHETIC_OLD_LEDGER_UNAVAILABLE'); }
      return get(path, options);
    };
    try { await storage.tick('unavailable', 'new-issue', dailyTime('2026-09-25') - START); }
    catch { /* The normal read path may reject rather than return a held draft. */ }
    finally { storage.scoped.getWithMetadata = get; }
    assert(observed && await historyProviderCalls(storage) === 1, 'Unavailable old delivery storage blocks all new provider calls.');
    const draft = (await read(storage.scoped, 'workflow/messages/m1-test-scheduled-rev-2026-09-25'))?.data;
    assert(!draft?.firstAttemptAt && !draft?.attemptCount, 'A failed old ledger read cannot become a new attempt.');
    await create(storage.scoped, 'fixture/storage-held', { code: 'SYNTHETIC_OLD_LEDGER_UNAVAILABLE', providerCalls: 1 });
  }
  const result = await storage.tick('recovered', 'new-issue', dailyTime('2026-09-25', '22:32') - START);
  assert(dailyEntry(result, '2026-09-25')?.attemptCount === 1 && await historyProviderCalls(storage) === 2, 'Confirmed storage recovery permits one new daily attempt.');
  await dailyOriginalIntact(storage, original);
  return result;
}
async function dailyUnknownBounce(store, runId) {
  const h = harness(store, runId, 'daily-late-unknown');
  if (await read(h.scoped, 'fixture/unbound-bounce-checked')) return;
  const original = firstMessage(await h.tick('original'));
  assert(original.delivery?.state === 'unknown', 'The old message has no confirmed provider acceptance.');
  for (let index = 1; index <= 9; index++) {
    const date = new Date(Date.parse(DATE + 'T12:00:00Z') + index * 86400000).toISOString().slice(0, 10);
    await h.tick('clean-' + index, 'clean', dailyTime(date) - START);
  }
  const recent = await workflowMessages(SCOPE, h.dependencies());
  assert(!recent.messages.some(message => message.messageId === original.messageId)
    && recent.messages.every(message => !message.firstAttemptAt && message.state === 'suppressed'),
    'The unknown original is outside the recent page and no current message is pending.');
  h.at(dailyTime('2026-10-03', '23:00'));
  const event = { eventId: 'daily-old-unbound-bounce-' + runId, providerId: (await h.simulation(original.messageId)).providerId,
    type: 'email.bounced', permanentFailure: true, occurredAt: new Date(dailyTime('2026-10-03', '23:00')).toISOString(),
    from: original.message.from, to: original.message.to };
  const acknowledgment = await recordWorkflowDeliveryEvidence(event, { ...h.dependencies(), deliveryEvidenceVerified: true });
  assert(acknowledgment.matched === false, 'A verified unbound bounce is not attributed to a message through its recipient alone.');
  const retained = await dailyOriginalIntact(h, original);
  assert(retained.delivery.state === 'unknown' && retained.state !== 'delivered', 'The old unknown is never relabeled as delivered.');
  const next = await h.tick('after-unbound-bounce', 'issue', dailyTime('2026-10-04') - START), draft = dailyEntry(next, '2026-10-04');
  assert(draft?.code === 'PRIOR_PERMANENT_RECIPIENT_PROOF_UNRESOLVED' && draft.attemptCount === 0 && !draft.firstAttemptAt
    && await historyProviderCalls(h) === 1, 'A verified permanent recipient failure holds a later new send even without a current pending original.');
  await create(h.scoped, 'fixture/unbound-bounce-checked', { originalMessageId: original.messageId, matched: false,
    originalState: 'unknown', nextMessageId: draft.messageId, providerCalls: 1, code: draft.code });
}
async function dailyScenario(store, runId, name) {
  let result, title, summary, checks, warnings = [];
  const h = harness(store, runId, name);
  if (name === 'daily-fresh-unknown') {
    const before = await h.tick('original', 'issue', dailyTime('2026-09-25', '21:50') - START), original = firstMessage(before);
    assert(original.delivery?.state === 'unknown', 'The original provider acceptance is genuinely unknown.');
    result = await h.tick('next', 'new-issue', dailyTime('2026-09-25') - START);
    const fresh = dailyEntry(result, '2026-09-25');
    assert(fresh?.attemptCount === 1 && fresh.delivery?.state === 'accepted' && result.digest.itemCount === 2,
      'The next eligible fresh assessment includes the old question and new class and makes one new attempt.');
    assert(fresh.message.text.includes('SYNTHETIC rev class') && fresh.message.text.includes('SYNTHETIC new rev class'), 'Both old and new unresolved questions are included.');
    const retained = await dailyOriginalIntact(h, original);
    assert(original.retryBefore > dailyTime('2026-09-25') && retained.nextAttemptAt === null && (await h.simulation(original.messageId)).calls === 1,
      'The previous unknown retry is retired even while its original 23-hour window remains open.');
    assert(await historyProviderCalls(h) === 2, 'Exactly two distinct daily provider calls are stored.');
    title = 'Fresh daily questions can follow an old unknown send'; summary = 'The next eligible daily assessment includes current unresolved work, while the old uncertain message and its receipts remain preserved.';
    warnings = [warning('OLD_ACCEPTANCE_UNKNOWN', 'The original provider acceptance remains unknown; the new synthetic message does not resolve it.'), warning('SIMULATED_ACCEPTANCE_ONLY', 'Simulated acceptance is not real inbox delivery.')];
    checks = ['Old and new unresolved questions included in fresh records.', 'One stable ID per eligible daily assessment.', 'Old retry retired without changing its original receipt or 23-hour window.', 'Two total simulated calls.'];
  } else if (name === 'daily-clean-incomplete') {
    for (const mode of ['clean', 'incomplete']) {
      const branch = harness(store, runId, 'daily-' + mode + '-unknown');
      const before = await branch.tick('original', 'issue', dailyTime('2026-09-25', '21:50') - START), original = firstMessage(before);
      const next = await branch.tick('next', mode, dailyTime('2026-09-25') - START), fresh = dailyEntry(next, '2026-09-25');
      const retained = await dailyOriginalIntact(branch, original);
      assert(original.retryBefore > dailyTime('2026-09-25') && retained.nextAttemptAt === null && (await branch.simulation(original.messageId)).calls === 1,
        'Clean and incomplete eligible assessments both retire a still-retryable old attempt.');
      if (mode === 'clean') {
        const decision = (await read(branch.scoped, 'workflow/opportunities/rev'))?.data;
        assert(decision?.decision === 'clean' && fresh?.attemptCount === 0, 'A clean opportunity is durably closed without email.');
        await branch.tick('later-issue', 'new-issue', dailyTime('2026-09-25', '23:00') - START);
        assert(await historyProviderCalls(branch) === 1 && (await read(branch.scoped, 'workflow/opportunities/rev'))?.data.decision === 'clean', 'Later same-opportunity changes cannot reopen a clean decision.');
      } else {
        assert(fresh?.attemptCount === 1 && fresh.message.text.includes('could not be checked')
          && !fresh.message.text.includes('No outstanding items were found'), 'Incomplete checks send an explicit warning without a false all-clear.');
        assert(await historyProviderCalls(branch) === 2, 'One old and one new incomplete-warning call are retained.');
      }
      result = next;
    }
    title = 'Clean and incomplete checks both supersede old retries'; summary = 'A clean result closes that daily decision; an unavailable read produces a clear warning. Neither revives yesterday’s uncertain send.';
    warnings = [warning('CHECK_INCOMPLETE', 'An unavailable check remains a warning, never an all-clear.')];
    checks = ['Durable clean decision survives a later same-day issue.', 'Incomplete check sends explicit could-not-check message.', 'Both paths retire old retries.', 'Original receipts remain unchanged.'];
  } else if (name === 'daily-calendar-dst') {
    const configuration = input().configuration;
    const cases = [['2026-09-25T00:01:00-04:00', '2026-09-24'], ['2026-09-25T21:59:00-04:00', '2026-09-24'],
      ['2026-09-25T22:00:00-04:00', '2026-09-25'], ['2026-11-01T01:30:00-04:00', '2026-10-31'],
      ['2026-11-01T01:30:00-05:00', '2026-10-31'], ['2026-11-01T22:00:00-05:00', '2026-11-01'],
      ['2027-03-14T03:01:00-04:00', '2027-03-13']];
    for (const [stamp, expected] of cases) assert(latestEligibleOpportunity(configuration, Date.parse(stamp)).date === expected, 'Local cutoff and daylight-saving transitions select the correct single opportunity.');
    await h.tick('original');
    await h.tick('midnight', 'issue', dailyTime('2026-09-25', '00:01') - START);
    const beforeCutoff = await h.tick('before-cutoff', 'issue', dailyTime('2026-09-25', '21:59') - START);
    assert(stepProviderCalls(beforeCutoff) === 1, 'Midnight and repeated pre-cutoff ticks do not create a new message.');
    result = await h.tick('cutoff', 'new-issue', dailyTime('2026-09-25', '22:00') - START, { concurrent: true });
    await h.tick('repeat', 'new-issue', dailyTime('2026-09-25', '22:01') - START);
    assert(await historyProviderCalls(h) === 2 && entries(result).length === 2, 'Concurrent and repeated cutoff ticks keep one new daily message.');
    const dst = harness(store, runId, 'daily-dst');
    await dst.tick('first-hour', 'issue', Date.parse(cases[3][0]) - START);
    const repeated = await dst.tick('repeated-hour', 'issue', Date.parse(cases[4][0]) - START);
    assert(firstMessage(repeated)?.date === '2026-10-31' && await historyProviderCalls(dst) === 1, 'Repeated DST hour uses the same durable daily identity.');
    title = 'Local cutoff, repeats and daylight saving keep one daily identity'; summary = 'Crossing midnight does not authorize a new message. The configured local cutoff does, including daylight-saving transitions.';
    checks = ['Seven cutoff/DST boundary selections.', 'No new send at midnight or before cutoff.', 'Concurrent cutoff requests create one identity.', 'Repeated fall-back hour makes one call.'];
  } else if (name === 'daily-overlap-recovery') {
    result = await dailyOverlap(store, runId);
    title = 'A newer assessment fences an interrupted old dispatch'; summary = 'A request paused before delivery remains blocked by the active coordinator; after its lease expires, a clean daily decision prevents the old request from sending.';
    checks = ['Paused after original engine ledger readback.', 'Overlapping request held while the coordinator remained active.', 'Expired coordinator recovered under the same original IDs.', 'Final delivery gate prevented the old provider call.', 'Interrupted opportunity persistence recovered.'];
  } else if (name === 'daily-missed-days') {
    await h.tick('original');
    result = await h.tick('after-downtime', 'new-issue', dailyTime('2026-09-29', '08:00') - START);
    const fresh = dailyEntry(result, '2026-09-28');
    assert(entries(result).length === 2 && fresh?.assessmentDate === '2026-09-29' && fresh.attemptCount === 1,
      'Downtime catches only yesterday’s latest eligible opportunity with today’s fresh records.');
    assert(result.digest.itemCount === 1 && fresh.message.text.includes('SYNTHETIC rev class'), 'The fresh morning read retains the old unresolved question and excludes a future class.');
    await h.tick('repeat-catchup', 'new-issue', dailyTime('2026-09-29', '08:01') - START);
    assert(await historyProviderCalls(h) === 2, 'Repeated catch-up does not send a missed-day backlog.');
    title = 'Downtime catches the latest opportunity only'; summary = 'One fresh morning assessment catches yesterday’s eligible reminder. Missed dates do not generate a backlog of emails.';
    checks = ['Latest eligible date separated from current assessment date.', 'Old unresolved question retained.', 'Future class excluded.', 'Two messages total across the downtime gap.'];
  } else if (name === 'daily-late-evidence') {
    const before = await h.tick('original'), original = firstMessage(before);
    result = await h.tick('next', 'new-issue', dailyTime('2026-09-25') - START);
    const newer = dailyEntry(result, '2026-09-25');
    const event = { eventId: 'daily-delivered-' + runId, providerId: original.delivery.providerId, type: 'email.delivered',
      occurredAt: new Date(dailyTime('2026-09-25', '23:00')).toISOString(), from: original.message.from, to: original.message.to };
    h.at(Date.parse(event.occurredAt));
    if (!(await read(h.scoped, 'fixture/late-evidence-checked'))) {
      assert((await recordWorkflowDeliveryEvidence(event, { ...h.dependencies(), deliveryEvidenceVerified: true })).matched, 'Late evidence matches its original provider identity.');
      assert((await read(h.scoped, 'workflow/messages/' + original.messageId)).data.state === 'delivered'
        && digestHash((await read(h.scoped, 'workflow/messages/' + newer.messageId)).data) === digestHash(newer), 'Old delivery evidence does not update the newer message.');
      const unknownEvent = { ...event, eventId: 'daily-unbound-' + runId, providerId: idFor(['unbound-provider', runId]) };
      assert((await recordWorkflowDeliveryEvidence(unknownEvent, { ...h.dependencies(), deliveryEvidenceVerified: true })).matched === false, 'A shared recipient cannot bind an unknown provider identity.');
      await create(h.scoped, 'fixture/late-evidence-checked', { originalMessageId: original.messageId, state: 'delivered', newerHash: digestHash(newer), unboundMatched: false });
    }
    await h.tick('after-late-success', 'issue', dailyTime('2026-09-25', '23:01') - START);
    assert(await historyProviderCalls(h) === 2, 'A late success does not schedule another attempt.');
    const bounce = { ...event, eventId: 'daily-bounce-' + runId, type: 'email.bounced', permanentFailure: true,
      occurredAt: new Date(dailyTime('2026-09-25', '23:02')).toISOString() };
    h.at(Date.parse(bounce.occurredAt));
    await recordWorkflowDeliveryEvidence(bounce, { ...h.dependencies(), deliveryEvidenceVerified: true });
    result = await h.tick('after-bounce', 'issue', dailyTime('2026-09-26') - START);
    assert(dailyEntry(result, '2026-09-26')?.code === 'PRIOR_PERMANENT_RECIPIENT_BOUNCE' && await historyProviderCalls(h) === 2, 'A retained permanent recipient bounce still blocks later daily attempts.');
    await dailyUnknownBounce(store, runId);
    title = 'Late events update their original message only'; summary = 'A late success changes only its matching original. A permanent recipient bounce continues to block sending to that address.';
    warnings = [warning('SIMULATED_EVENT_ONLY', 'These verified synthetic events do not prove real inbox delivery.')];
    checks = ['Exact original provider/message association.', 'Newer identity and receipts remain untouched.', 'Unbound event not attributed to another message.', 'No retry after late success.',
      'Permanent bounce continues to hold later sends.', 'Old unknown outside recent history remains unknown after an unbound permanent event.', 'That verified recipient failure still holds the next daily send, without a current pending message.'];
  } else {
    result = await dailyHolds(store, runId);
    title = 'Configuration and storage failures remain holds'; summary = 'A new eligible day does not bypass a permanent rejection, missing reviewer configuration or unavailable original delivery storage.';
    warnings = [warning('SYNTHETIC_FAILURES', 'Failures were injected only into isolated example storage and the simulated provider.')];
    checks = ['Permanent rejection holds the unchanged route.', 'A superseded generic failure remains historical, not a current failure after a clean check.',
      'Missing reviewer makes no attempt.', 'Unavailable old delivery storage is distinct from retained unknown acceptance.', 'Storage recovery permits the same new daily ID once.'];
  }
  return { key: name, title, passed: true, summary, warnings, messages: publicMessages(result), checks };
}

async function mailappScenario(store, runId, name) {
  let result, title, summary, checks;
  const warnings = [warning('SIMULATED_GOOGLE_ONLY', 'Only an isolated Google simulation ran. A completed Google call is not confirmed inbox delivery.')];
  if (name === 'mailapp-original-recovery') {
    for (const behavior of ['unknown', 'lost-reply']) {
      const scenarioName = 'mailapp-original-' + behavior, h = harness(store, runId, scenarioName);
      const before = await h.tick('original'), original = firstMessage(before);
      const claimPath = 'workflow/delivery/mailapp/messages/' + original.messageId;
      const claim = (await read(h.scoped, claimPath))?.data;
      assert(original.delivery?.state === 'unknown' && claim, 'An interrupted Google confirmation remains genuinely unknown.');
      const resumed = harness(store, runId, scenarioName);
      result = await resumed.tick('reload', 'issue', MINUTE);
      const recovered = firstMessage(result), simulation = await resumed.simulation(original.messageId);
      assert(recovered.messageId === original.messageId && digestHash(recovered.message) === digestHash(original.message)
        && digestHash((await read(resumed.scoped, claimPath))?.data) === digestHash(claim), 'Reload preserves the original body, ID and durable attempt.');
      assert(simulation.calls === 1 && simulation.sendRequests === 1 && recovered.delivery.retryAllowed === false, 'Recovery does not request Google sending again.');
      assert(recovered.state === (behavior === 'lost-reply' ? 'submitted' : 'unconfirmed'), 'Read-only status recovers completed Google work and preserves genuine uncertainty.');
      assert(recovered.delivery.deliveryConfirmed === false && !recovered.delivery.providerId, 'Neither outcome invents provider delivery evidence.');
      await resumed.tick('repeat', 'issue', 2 * MINUTE);
      assert((await resumed.simulation(original.messageId)).sendRequests === 1, 'Repeated same-day checks make no duplicate Send request.');
    }
    title = 'Reload checks the original Google result without resending';
    summary = 'A lost completion reply recovers as submitted to Google. A genuinely unknown Google call stays visibly unconfirmed; neither is sent again.';
    checks = ['Original message, attempt claim and timestamps preserved.', 'One simulated sending call for each original.', 'Reload uses status recovery only.', 'Submitted never means delivered.'];
  } else if (name === 'mailapp-next-day') {
    const h = harness(store, runId, 'mailapp-next-day-unknown');
    const before = await h.tick('original', 'issue', dailyTime('2026-09-25', '21:50') - START), original = firstMessage(before);
    const originalClaim = (await read(h.scoped, 'workflow/delivery/mailapp/messages/' + original.messageId))?.data;
    result = await h.tick('next', 'new-issue', dailyTime('2026-09-25') - START);
    const fresh = dailyEntry(result, '2026-09-25'), old = entries(result).find(entry => entry.messageId === original.messageId);
    assert(fresh?.state === 'submitted' && fresh.attemptCount === 1 && fresh.message.text.includes('SYNTHETIC rev class')
      && fresh.message.text.includes('SYNTHETIC new rev class'), 'A fresh due assessment includes both old and new unresolved questions.');
    assert(old?.state === 'unconfirmed' && old.automaticRetriesRetired && (await h.simulation(original.messageId)).calls === 1,
      'Yesterday’s uncertainty remains history without blocking or resending today’s distinct assessment.');
    assert(digestHash((await read(h.scoped, 'workflow/delivery/mailapp/messages/' + original.messageId))?.data) === digestHash(originalClaim), 'The original Google claim is unchanged.');
    assert(await historyProviderCalls(h) === 2 && fresh.delivery.deliveryConfirmed === false, 'Two daily identities produce two calls, neither claiming inbox delivery.');
    title = 'A fresh due day can follow an earlier unknown Google result';
    summary = 'The next due assessment covers current unresolved work once. The previous uncertain call and its history remain intact.';
    checks = ['Fresh authoritative fixture contains old and new questions.', 'One send identity per eligible day.', 'Previous unknown attempt never resent.', 'Original claim remains unchanged.'];
  } else if (name === 'mailapp-clean-incomplete') {
    for (const mode of ['clean', 'incomplete']) {
      const h = harness(store, runId, 'mailapp-' + mode + '-unknown');
      const before = await h.tick('original'), original = firstMessage(before);
      result = await h.tick('next', mode, dailyTime('2026-09-25') - START);
      const fresh = dailyEntry(result, '2026-09-25');
      if (mode === 'clean') assert(fresh?.attemptCount === 0 && await historyProviderCalls(h) === 1,
        'A complete clean assessment makes no new email call.');
      else assert(fresh?.state === 'submitted' && fresh.message.text.includes('could not be checked')
        && !fresh.message.text.includes('No outstanding items were found') && result.health.codes.includes('CHECK_INCOMPLETE')
        && result.health.state !== 'clear' && await historyProviderCalls(h) === 2,
      'An incomplete check produces a clear warning without inventing missing people or an all-clear.');
      assert((await h.simulation(original.messageId)).calls === 1, 'Neither fresh result resends the earlier unknown call.');
    }
    title = 'Clean checks suppress email; failed reads stay explicit';
    summary = 'A clean due check sends nothing. An incomplete one submits a could-not-check warning, retaining earlier uncertainty separately.';
    warnings.push(warning('CHECK_INCOMPLETE', 'An incomplete read is never an all-clear.'));
    checks = ['No email for a complete clean check.', 'Incomplete records produce a could-not-check message.', 'Old unknown send remains preserved.', 'No real records or recipients used.'];
  } else if (name === 'mailapp-claims') {
    const h = harness(store, runId, 'mailapp-concurrent');
    result = await h.tick('overlap', 'issue', 0, { concurrent: true });
    assert(firstMessage(result)?.state === 'submitted' && await historyProviderCalls(h) === 1, 'Overlapping processors retain one sending claim and one Google call.');
    const broken = harness(store, runId, 'mailapp-storage'), set = broken.scoped.set;
    broken.scoped.set = async (path, raw, options) => {
      const written = await set(path, raw, options);
      if (path.startsWith('workflow/delivery/mailapp/messages/') && written.modified
        && !(await read(broken.scoped, 'fixture/ambiguous-claim'))) {
        await create(broken.scoped, 'fixture/ambiguous-claim', { originalClaim: JSON.parse(raw) });
        throw new Error('Synthetic Google claim acknowledgment lost');
      }
      return written;
    };
    let interrupted;
    try { interrupted = await broken.tick('claim'); } finally { broken.scoped.set = set; }
    assert(await historyProviderCalls(broken) === 0 && firstMessage(interrupted)?.state !== 'submitted'
      && interrupted.health.state !== 'clear', 'An ambiguous durable claim prevents Google sending and cannot show an all-clear.');
    await broken.tick('recover', 'issue', MINUTE);
    assert(await historyProviderCalls(broken) === 0, 'Recovering the claimed original only reads status; it cannot start a replacement send.');
    const quota = harness(store, runId, 'mailapp-quota-before-call');
    const denied = await quota.tick('quota'), noCall = firstMessage(denied);
    const quotaClaimPath = 'workflow/delivery/mailapp/messages/' + noCall.messageId;
    const firstClaim = (await read(quota.scoped, quotaClaimPath))?.data;
    const firstSimulation = await quota.simulation(noCall.messageId);
    assert(noCall.state === 'retrying' && noCall.code === 'PROVEN_NO_SEND_RECHECK_PENDING'
      && noCall.delivery.state === 'rejected' && firstSimulation.calls === 0 && firstSimulation.sendRequests === 1,
    'A definitive quota rejection before MailApp runs shows a safe pending recheck, with zero actual sending calls.');
    const waiting = await quota.tick('before-recheck', 'issue', 14 * MINUTE);
    assert(firstMessage(waiting).state === 'retrying' && (await quota.simulation(noCall.messageId)).sendRequests === 1,
      'The original waits for its existing backoff instead of immediately repeating Send.');
    const recovered = await quota.tick('recheck', 'issue', 15 * MINUTE), submitted = firstMessage(recovered);
    const recoveredClaim = (await read(quota.scoped, quotaClaimPath))?.data, sent = await quota.simulation(noCall.messageId);
    assert(submitted.state === 'submitted' && submitted.messageId === noCall.messageId && digestHash(submitted.message) === digestHash(noCall.message)
      && submitted.attemptCount === 2 && sent.sendRequests === 2 && sent.calls === 1,
    'After fresh READY, two Send requests produce exactly one actual MailApp call under the original message identity.');
    assert(firstClaim.bindings.length === 1 && recoveredClaim.bindings.length === 2
      && digestHash(firstClaim.bindings[0]) === digestHash(recoveredClaim.bindings[0])
      && submitted.delivery.receipts.some(receipt => receipt.action === 'attendanceMailSend' && receipt.code === 'MAILAPP_QUOTA_UNAVAILABLE'),
    'The original no-call binding and exact receipt survive the safely appended attempt.');
    await quota.tick('recheck-repeat', 'issue', 16 * MINUTE);
    assert((await quota.simulation(noCall.messageId)).sendRequests === 2, 'Confirmed submission cannot trigger a third Send request.');
    const legacy = harness(store, runId, 'uncertain-reload'), before = await legacy.tick('original'), original = firstMessage(before);
    assert(original.delivery?.state === 'unknown', 'The original legacy-provider outcome is uncertain.');
    const legacyClaimPath = 'workflow/delivery/messages/' + original.messageId;
    const legacyClaim = (await read(legacy.scoped, legacyClaimPath))?.data;
    legacy.at(START + MINUTE); let googleCalls = 0;
    const changed = { ...legacy.dependencies(), simulatedProvider: { kind: 'mailapp', identity: 'changed-synthetic-provider', send: async () => { googleCalls++; throw new Error('Provider switch must not resend this day'); } } };
    const data = input('issue', START + MINUTE), binding = makeDigestBinding(idFor([runId, name, 'changed-provider']), 'scheduled', START + MINUTE);
    await processAttendanceWorkflow({ ...data, binding }, changed);
    assert(googleCalls === 0 && (await legacy.simulation(original.messageId)).calls === 1
      && digestHash((await read(legacy.scoped, legacyClaimPath))?.data) === digestHash(legacyClaim), 'Changing providers does not resend or rewrite an attempted legacy day.');
    title = 'Only a proven no-call result may retry safely';
    summary = 'A confirmed quota rejection waits and recovers: two Send requests, one MailApp call. Unknown outcomes, uncertain storage and an attempted Resend day cannot become replacement sends.';
    checks = ['Concurrent processors share one durable attempt.', 'Ambiguous claim creates zero Google sends.', 'Recovery keeps the uncertain original claim without replacement.',
      'Proven no-call quota response waits 15 minutes and rechecks READY.', 'Two Send requests produce one actual simulated MailApp call.',
      'Original no-call receipt and binding preserved.', 'Existing provider ledger survives a provider-policy change.'];
  } else {
    const h = harness(store, runId, 'mailapp-no-backlog');
    await h.tick('original');
    result = await h.tick('after-downtime', 'new-issue', dailyTime('2026-09-29', '08:00') - START);
    const fresh = dailyEntry(result, '2026-09-28');
    assert(entries(result).length === 2 && fresh?.assessmentDate === '2026-09-29' && fresh.state === 'submitted'
      && fresh.message.text.includes('SYNTHETIC rev class'), 'The latest due opportunity uses fresh records and preserves unresolved older work.');
    assert(!fresh.message.text.includes('SYNTHETIC new rev class'), 'Future classes are not described as missing.');
    await h.tick('repeat', 'new-issue', dailyTime('2026-09-29', '08:01') - START);
    assert(await historyProviderCalls(h) === 2, 'Downtime and repeat ticks never drain a missed-day backlog.');
    title = 'Recovery after downtime sends only the latest fresh assessment';
    summary = 'One current assessment covers the latest due opportunity. Missed dates do not create a queue of stale emails.';
    checks = ['Latest eligible date and actual assessment date remain distinct.', 'Older unresolved work remains included.', 'Future classes excluded.', 'One original and one fresh simulated call only.'];
  }
  return { key: name, title, passed: true, summary, warnings, messages: publicMessages(result), checks };
}

export const runAttendanceWorkflowExamples = (runId, deps = {}) => runExamples(runId, deps, 'workflow');
export const runAttendanceWorkflowHistoryExamples = (runId, deps = {}) => runExamples(runId, deps, 'history');
export const runAttendanceWorkflowDailyExamples = (runId, deps = {}) => runExamples(runId, deps, 'daily');
export const runAttendanceWorkflowMailAppExamples = (runId, deps = {}) => runExamples(runId, deps, 'mailapp');
async function runExamples(runId, deps, kind) {
  if (!UUID.test(runId || '')) fail('WORKFLOW_EXAMPLES_ID_INVALID', 400);
  const store = await storeFor(deps), started = clock(deps);
  if (!Number.isSafeInteger(started) || started < 0) fail('WORKFLOW_EXAMPLES_CLOCK_INVALID');
  if (deps.requirePrepared === true && !(await read(store, key(runId) + 'original'))) fail('WORKFLOW_EXAMPLES_ORIGINAL_REQUIRED', 404, runId);
  const original = await create(store, key(runId) + 'original', originalFor(runId, started, kind));
  validateOriginalKind(original.data, runId, kind);
  const complete = await savedResult(store, runId, kind); if (complete) return complete;
  const leasePath = key(runId) + 'lease', previous = await read(store, leasePath);
  if (previous?.data.expiresAt > started) fail('WORKFLOW_EXAMPLES_IN_PROGRESS', 409, runId);
  const lease = { owner: randomUUID(), expiresAt: started + LEASE_MS };
  const claim = await store.set(leasePath, JSON.stringify(lease), previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
  if (claim?.modified !== true || digestHash((await read(store, leasePath))?.data) !== digestHash(lease)) fail('WORKFLOW_EXAMPLES_IN_PROGRESS', 409, runId);
  const latest = await read(store, 'latestRun');
  if (!latest || latest.data.createdAt <= original.data.createdAt) await store.set('latestRun', JSON.stringify({ runId, createdAt: original.data.createdAt }), latest ? { onlyIfMatch: latest.etag } : { onlyIfNew: true });
  try {
    const scenarios = [];
    for (const name of keysFor(kind)) {
      const leaseSaved = await read(store, leasePath);
      if (leaseSaved?.data.owner !== lease.owner) fail('WORKFLOW_EXAMPLES_IN_PROGRESS', 409, runId);
      const renewed = { owner: lease.owner, expiresAt: clock(deps) + LEASE_MS };
      if ((await store.set(leasePath, JSON.stringify(renewed), { onlyIfMatch: leaseSaved.etag }))?.modified !== true) fail('WORKFLOW_EXAMPLES_IN_PROGRESS', 409, runId);
      const path = key(runId) + 'completed/' + name, saved = await read(store, path);
      let result = saved?.data;
      if (!result) {
        try { result = await (kind === 'mailapp' ? mailappScenario : kind === 'daily' ? dailyScenario : kind === 'history' ? historyScenario : scenario)(store, runId, name); }
        catch (error) {
          if (!error.exampleCheck) throw error;
          result = { key: name, title: name, passed: false, summary: error.message, warnings: [warning('WORKFLOW_EXAMPLE_FAILED', error.message)], messages: [], checks: [] };
        }
        result = (await create(store, path, result)).data;
      }
      scenarios.push(result);
    }
    const result = validateResult({ runId, complete: true, synthetic: true, scenarios }, runId, kind);
    await create(store, key(runId) + 'result', { schema: SCHEMA, hash: digestHash(result), result });
    return savedResult(store, runId, kind);
  } finally {
    const saved = await read(store, leasePath);
    if (saved?.data.owner === lease.owner) await store.set(leasePath, JSON.stringify({ owner: lease.owner, expiresAt: 0 }), { onlyIfMatch: saved.etag });
  }
}
