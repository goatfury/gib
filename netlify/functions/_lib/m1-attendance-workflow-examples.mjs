import { randomUUID } from 'node:crypto';
import { buildAttendanceDigest, defaultDigestConfiguration, digestDue, digestHash, datesThrough } from './m1-attendance-digest.mjs';
import { makeDigestBinding } from './m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, workflowHealth, workflowMessages, migrateWorkflowHistory, recordWorkflowDeliveryEvidence } from './m1-attendance-digest-workflow.mjs';

const SCHEMA = 'm1-attendance-workflow-examples/v1';
const STORE = 'gib-m1-attendance-workflow-examples-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START = Date.parse('2026-09-25T02:30:00.000Z');
const DATE = '2026-09-24';
const SCOPE = Object.freeze({ target: 'test', syntheticRehearsal: true, profile: { installationId: 'rev', gymName: 'Revolution TEST — synthetic examples' } });
const SAFE_ENV = Object.freeze({ GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true', GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: 'stu@example.invalid',
  GIB_M1_ATTENDANCE_DIGEST_TREY_EMAIL: 'trey@example.invalid', GIB_M1_ATTENDANCE_DIGEST_ANDREW_EMAIL: 'andrew@example.invalid',
  GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW: 'false', GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'false' });
const MINUTE = 60000, LEASE_MS = 5 * MINUTE;
const scenarioKeys = ['routing', 'clean', 'incomplete', 'upcoming-canceled', 'duplicate-concurrent', 'temporary-recovery',
  'uncertain-reload', 'permanent-failure', 'resolved-before-attempt', 'immutable-after-attempt', 'expired-uncertain', 'health-ordering'];
const historyScenarioKeys = ['history-over-256', 'history-old-barriers', 'history-late-event', 'history-interrupted-upgrade'];
const keysFor = kind => kind === 'history' ? historyScenarioKeys : scenarioKeys;
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
function validOriginal(value, runId) {
  return value?.schema === SCHEMA && value.runId === runId && value.synthetic === true
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && ((value.fixtureVersion === 1 && Object.keys(value).length === 5 && !Object.hasOwn(value, 'kind'))
      || (value.fixtureVersion === 2 && value.kind === 'history' && Object.keys(value).length === 6));
}
const originalFor = (runId, now, kind) => ({ schema: SCHEMA, runId, synthetic: true,
  fixtureVersion: kind === 'history' ? 2 : 1, ...(kind === 'history' ? { kind } : {}), createdAt: now });
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
  if (mode === 'upcoming-canceled') schedules.forEach(schedule => {
    const occurrences = schedule.days.find(day => day.date === DATE).occurrences;
    occurrences[0].cancelled = true; occurrences[0].endAt = null;
    occurrences.push({ label: '11:00 PM SYNTHETIC upcoming class', startAt: '2026-09-25T03:00:00.000Z', endAt: '2026-09-25T03:45:00.000Z', cancelled: false });
  });
  const digest = buildAttendanceDigest({ jobDate, snapshots, schedules, configuration, now: stamp });
  return { digest, configuration, due: digestDue(jobDate, stamp, configuration, schedules) };
}

function harness(store, runId, scenario) {
  const scoped = isolated(store, key(runId) + 'scenarios/' + scenario + '/');
  let stamp = START;
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
      : scenario === 'permanent-failure' ? 'permanent'
      : ['uncertain-reload', 'expired-uncertain'].includes(scenario) ? 'uncertain'
        : ['temporary-recovery', 'immutable-after-attempt'].includes(scenario) ? 'temporary' : 'accepted';
    if (behavior === 'permanent') return new Response('{}', { status: 403 });
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
    simulatedProvider: { identity: 'fixed-synthetic-provider', send: provider }, fetch: async () => { throw new Error('Example network forbidden'); } });
  async function tick(stage, mode = 'issue', elapsed = 0, options = {}) {
    stamp = START + elapsed;
    const checkpoint = await read(scoped, 'steps/' + stage);
    if (checkpoint) return checkpoint.data;
    const data = input(mode, stamp, options.both);
    const binding = makeDigestBinding(idFor([runId, scenario, stage]), 'scheduled', options.createdAt ?? stamp);
    const request = { ...data, binding, ...(options.due ? { due: options.due } : {}) };
    if (options.concurrent) await Promise.all([processAttendanceWorkflow(request, dependencies()), processAttendanceWorkflow(request, dependencies())]);
    else await processAttendanceWorkflow(request, dependencies());
    const messages = await workflowMessages(SCOPE, dependencies());
    const providerStates = await Promise.all(messages.messages.map(async entry => ({ messageId: entry.messageId,
      receipt: (await read(scoped, 'simulation/' + entry.messageId))?.data || null })));
    const result = { messages, health: await workflowHealth(SCOPE, dependencies()), digest: data.digest, providerStates };
    return (await create(scoped, 'steps/' + stage, result)).data;
  }
  async function simulation(id) { return (await read(scoped, 'simulation/' + id))?.data || null; }
  async function health(elapsed) { stamp = START + elapsed; return workflowHealth(SCOPE, dependencies()); }
  return { tick, simulation, health, scoped, dependencies, at: value => { stamp = value; } };
}

const entries = result => result.messages.messages;
const firstMessage = result => entries(result)[0];
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
    for (const [gym, code] of [['rev', 'PRIOR_ACCEPTANCE_UNCONFIRMED'], ['richmond', 'PRIOR_PERMANENT_REJECTION_UNCHANGED']]) {
      const draft = (await read(h.scoped, 'workflow/messages/m1-test-scheduled-' + gym + '-' + HISTORY_DAY))?.data;
      assert(draft?.attemptCount === 0 && !draft.firstAttemptAt && draft.code === code, 'An old unresolved original still blocks a new daily identity.');
      assert(await h.simulation(draft.messageId) === null, 'The blocked new daily draft makes no provider call.');
    }
    for (const original of seed.originals) assert((await h.simulation(original.messageId))?.calls === 1, 'No original attempt is silently replayed while adding history.');
    assert(await historyProviderCalls(h) === 3, 'All stored simulated provider identities total exactly the three original calls.');
    await historyOriginalsIntact(h, seed); messages = publicMessages(result).filter(message => message.text.includes('SYNTHETIC'));
    title = 'Old unknown and rejected sends remain barriers'; summary = 'The original Revolution uncertainty and Richmond rejection still block new sends beyond the recent-history page.';
    warnings = [warning('PRIOR_DELIVERY_UNRESOLVED', 'Unknown acceptance and an unchanged permanent rejection remain unresolved; the synthetic new drafts were not sent.')];
    checks = ['Old unknown-acceptance barrier retained.', 'Old permanent-rejection barrier retained.', 'Both new gym drafts remain unattempted.', 'Three original simulated provider calls total, with no new calls.'];
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
    assert(await historyProviderCalls(h) === 3, 'The late synthetic event makes no provider request.');
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
      assert(retained.messageId === pending.messageId && digestHash(retained.message) === digestHash(pending.message)
        && retained.attemptCount === 1 && retained.delivery?.state === 'accepted'
        && (await claim.simulation(retained.messageId))?.calls === 1, 'Expired unattempted claim recovers the original message once.');
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
    title = 'Unknown acceptance cannot restart as a new daily email'; const before = await h.tick('first');
    result = await h.tick('next-day', 'issue', 24 * 60 * MINUTE);
    const prior = firstMessage(before), original = entries(result).find(entry => entry.messageId === prior.messageId);
    const draft = entries(result).find(entry => entry.messageId !== prior.messageId);
    assert(original?.attemptCount === 1 && original.delivery?.state === 'unknown'
      && original.code === 'MANUAL_RECONCILIATION_REQUIRED'
      && digestHash(original.message) === digestHash(prior.message)
      && digestHash(original.delivery.receipts) === digestHash(prior.delivery.receipts), 'Original unknown acceptance, exact message and audit receipts remain unchanged.');
    assert(draft?.date === '2026-09-25' && draft.attemptCount === 0 && !draft.firstAttemptAt
      && !draft.delivery && draft.state === 'prepared' && draft.code === 'PRIOR_ACCEPTANCE_UNCONFIRMED', 'An unresolved unknown acceptance blocks the next due day draft before any attempt.');
    assert(result.providerStates.reduce((total, item) => total + (item.receipt?.calls || 0), 0) === 1
      && result.providerStates.find(item => item.messageId === draft.messageId)?.receipt === null, 'An expired unknown acceptance cannot acquire a new provider identity on the next day.');
    warnings = [warning('MANUAL_RECONCILIATION_REQUIRED', 'Whether the original email was accepted is unknown. Its safe retry window expired, so the next day’s draft stays unattempted pending reconciliation.')];
    checks = ['Unknown acceptance distinguished from confirmed acceptance without delivery evidence.', 'Original identity and receipts preserved past 23 hours.', 'Same unresolved issue checked at the next due day, 24 hours later.', 'One total provider call across both dates.', 'Next-day draft retained without an attempt.'];
    summary = 'Unknown provider acceptance remains a manual question; a new day does not create a replacement send.';
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

export const runAttendanceWorkflowExamples = (runId, deps = {}) => runExamples(runId, deps, 'workflow');
export const runAttendanceWorkflowHistoryExamples = (runId, deps = {}) => runExamples(runId, deps, 'history');
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
        try { result = await (kind === 'history' ? historyScenario : scenario)(store, runId, name); }
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
