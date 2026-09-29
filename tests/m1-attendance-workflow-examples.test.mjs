import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareAttendanceWorkflowExamples, prepareAttendanceWorkflowHistoryExamples, readAttendanceWorkflowExamples,
  runAttendanceWorkflowExamples, runAttendanceWorkflowHistoryExamples, prepareAttendanceWorkflowDailyExamples,
  runAttendanceWorkflowDailyExamples } from '../netlify/functions/_lib/m1-attendance-workflow-examples.mjs';
import { digestHash } from '../netlify/functions/_lib/m1-attendance-digest.mjs';

const ID = '123e4567-e89b-42d3-a456-426614174001';
const OTHER = '123e4567-e89b-42d3-a456-426614174002';
const NOW = Date.parse('2026-09-27T16:00:00Z');
class Store {
  entries = new Map(); serial = 0; writes = [];
  async getWithMetadata(key, options) {
    assert.equal(options.consistency, 'strong');
    const found = this.entries.get(key); return found ? structuredClone(found) : null;
  }
  async set(key, raw, options = {}) {
    const prior = this.entries.get(key);
    if ((options.onlyIfNew && prior) || (options.onlyIfMatch && prior?.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = String(++this.serial); this.entries.set(key, { data: JSON.parse(raw), etag }); this.writes.push(key);
    return { modified: true, etag };
  }
  async *list({ prefix = '' } = {}) { yield { blobs: [...this.entries.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; }
  async delete(key) { this.entries.delete(key); }
}
function fixture() { const store = new Store(); return { store, deps: { examplesStore: store, clock: () => NOW } }; }
const simulations = store => [...store.entries].filter(([key]) => key.includes('/simulation/')).map(([key, value]) => [key, structuredClone(value.data)]);

test('all saved examples exercise the workflow using only synthetic per-gym delivery and honest warnings', async () => {
  const { store, deps } = fixture();
  let network = 0, envReads = 0;
  deps.fetch = () => { network++; throw new Error('must not reach a caller transport'); };
  Object.defineProperty(deps, 'env', { get: () => { envReads++; throw new Error('must not read caller credentials'); } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { network++; throw new Error('Examples must never reach global fetch'); };
  let result;
  try { result = await runAttendanceWorkflowExamples(ID, deps); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(result.complete, true); assert.equal(result.synthetic, true); assert.equal(result.scenarios.length, 12);
  assert.deepEqual(result.scenarios.filter(s => !s.passed).map(s => [s.key, s.summary]), []);
  assert.equal(network, 0); assert.equal(envReads, 0);
  const retainedMessages = [...store.entries].filter(([key]) => key.includes('/workflow/messages/')).map(([, value]) => value.data.message).filter(Boolean);
  assert.ok(retainedMessages.length > 0);
  for (const message of retainedMessages) {
    assert.equal(Object.hasOwn(message, 'bcc'), false, 'historical examples keep their original no-BCC canonical shape');
    assert.equal(message.hash, digestHash({ messageId: message.messageId, from: message.from, to: message.to, cc: message.cc,
      subject: message.subject, html: message.html, text: message.text, synthetic: message.synthetic, target: message.target }));
  }
  const routing = result.scenarios.find(s => s.key === 'routing');
  assert.equal(routing.messages.length, 2);
  for (const message of routing.messages) {
    assert.deepEqual(message.to, [message.gym === 'rev' ? 'stu@example.invalid' : 'trey@example.invalid']);
    assert.deepEqual(message.cc, []); assert.match(message.subject, /SYNTHETIC/);
    assert.match(message.html, /synthetic/i); assert.match(message.adminUrl, /^https:\/\//);
  }
  assert.ok(result.scenarios.find(s => s.key === 'incomplete').warnings.some(w => w.code === 'CHECK_INCOMPLETE'));
  assert.ok(result.scenarios.find(s => s.key === 'expired-uncertain').warnings.some(w => w.code === 'MANUAL_RECONCILIATION_REQUIRED'));
  assert.ok(store.writes.every(key => key === 'latestRun' || key.startsWith('examples/' + ID + '/')));
  assert.equal(store.writes[0], 'examples/' + ID + '/original', 'original run precedes every simulated workflow operation');
  assert.ok(store.writes.some(key => key.includes('/delivery/attempts/')), 'actual delivery engine attempt receipts were persisted');
});

test('preparation is durable before dispatch, pending reads stay null, and completed reload/retry returns exactly the saved original', async () => {
  const { store, deps } = fixture();
  const prepared = await prepareAttendanceWorkflowExamples(ID, deps);
  assert.deepEqual(prepared, { runId: ID, complete: false, synthetic: true, state: 'queued' });
  assert.equal(await readAttendanceWorkflowExamples(ID, deps), null); assert.equal(await readAttendanceWorkflowExamples(null, deps), null);
  assert.equal(simulations(store).length, 0);
  const original = structuredClone(store.entries.get('examples/' + ID + '/original'));
  const result = await runAttendanceWorkflowExamples(ID, deps), captures = simulations(store);
  assert.deepEqual(await readAttendanceWorkflowExamples(null, deps), result);
  assert.deepEqual(await runAttendanceWorkflowExamples(ID, { ...deps, clock: () => NOW + 86400000 }), result);
  assert.deepEqual(simulations(store), captures); assert.deepEqual(store.entries.get('examples/' + ID + '/original'), original);
  assert.equal((await prepareAttendanceWorkflowExamples(ID, deps)).state, 'complete');
});

test('fresh incomplete results deliver a warning and a pre-engine claim failure recovers once without fabricating acceptance', async () => {
  const { store, deps } = fixture();
  const result = await runAttendanceWorkflowExamples(ID, deps);
  const root = 'examples/' + ID + '/scenarios/';
  const incomplete = store.entries.get(root + 'incomplete/steps/first').data.messages.messages[0];
  assert.equal(incomplete.attemptCount, 1); assert.equal(incomplete.delivery.state, 'accepted'); assert.equal(incomplete.state, 'unconfirmed');
  assert.match(incomplete.message.text, /could not be checked/); assert.doesNotMatch(incomplete.message.text, /No outstanding items were found/);
  const pending = store.entries.get(root + 'temporary-recovery-claim/steps/claim').data.messages.messages[0];
  const healed = store.entries.get(root + 'temporary-recovery-claim/steps/healed').data.messages.messages[0];
  assert.equal(pending.attemptCount, 0); assert.equal(pending.delivery.state, 'not-started');
  assert.equal(healed.messageId, pending.messageId); assert.deepEqual(healed.message.to, pending.message.to);
  assert.match(healed.message.text, /Fresh assessment: 2026-09-25T02:32:00\.000Z/);
  assert.equal(healed.attemptCount, 1); assert.equal(healed.delivery.state, 'accepted');
  const provider = store.entries.get(root + 'temporary-recovery-claim/simulation/' + pending.messageId).data;
  assert.equal(provider.calls, 1); assert.equal(provider.accepted, true);
  assert.ok(result.scenarios.find(s => s.key === 'temporary-recovery').passed);
});

test('retained receipts survive the updated daily policy while permanent rejection still holds new attempts', async () => {
  const { store, deps } = fixture();
  const result = await runAttendanceWorkflowExamples(ID, deps);
  for (const name of ['permanent-failure', 'expired-uncertain']) {
    const root = 'examples/' + ID + '/scenarios/' + name + '/';
    const prior = store.entries.get(root + 'steps/first').data.messages.messages[0];
    const next = store.entries.get(root + 'steps/next-day').data;
    const original = next.messages.messages.find(message => message.messageId === prior.messageId);
    const draft = next.messages.messages.find(message => message.messageId !== prior.messageId);
    assert.equal(next.digest.date, '2026-09-25'); assert.equal(next.digest.itemCount, 1, 'same unresolved class remains in the next due check');
    assert.equal(Date.parse(next.digest.generatedAt) - Date.parse(store.entries.get(root + 'steps/first').data.digest.generatedAt), 86400000);
    assert.deepEqual(original.message, prior.message); assert.deepEqual(original.delivery.receipts, prior.delivery.receipts);
    assert.equal(original.attemptCount, 1); assert.equal(original.delivery.state, name === 'permanent-failure' ? 'rejected' : 'unknown');
    const providerEntries = [...store.entries].filter(([key]) => key.startsWith(root + 'simulation/'));
    assert.equal(draft.date, '2026-09-25');
    if (name === 'permanent-failure') {
      assert.equal(draft.attemptCount, 0); assert.equal(draft.firstAttemptAt, null); assert.equal(draft.delivery, null);
      assert.equal(draft.state, 'prepared'); assert.equal(draft.code, 'PRIOR_PERMANENT_REJECTION_UNCHANGED');
      assert.equal(providerEntries.length, 1); assert.equal(store.entries.has(root + 'simulation/' + draft.messageId), false);
    } else {
      assert.equal(draft.attemptCount, 1); assert.equal(draft.delivery.state, 'unknown'); assert.equal(providerEntries.length, 2);
      assert.equal(original.automaticRetriesRetired, true); assert.equal(original.nextAttemptAt, null);
      assert.ok(result.scenarios.find(scenario => scenario.key === name).warnings.some(warning => warning.code === 'HISTORICAL_POLICY_SUPERSEDED'));
    }
    assert.ok(providerEntries.every(([, entry]) => entry.data.calls === 1));
    assert.ok(result.scenarios.find(scenario => scenario.key === name).passed);
  }
});

test('concurrent calls use one durable lease and an interrupted runner resumes its saved scenario checkpoints', async () => {
  const h = fixture();
  const results = await Promise.allSettled([runAttendanceWorkflowExamples(ID, h.deps), runAttendanceWorkflowExamples(ID, h.deps)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WORKFLOW_EXAMPLES_IN_PROGRESS');
  const retry = fixture(), originalSet = retry.store.set.bind(retry.store); let stop = true;
  retry.store.set = async (key, raw, options) => {
    if (stop && key.endsWith('/completed/temporary-recovery')) { stop = false; throw new Error('simulated interruption'); }
    return originalSet(key, raw, options);
  };
  await assert.rejects(() => runAttendanceWorkflowExamples(OTHER, retry.deps), /simulated interruption/);
  assert.equal(await readAttendanceWorkflowExamples(OTHER, retry.deps), null);
  const initial = simulations(retry.store), original = structuredClone(retry.store.entries.get('examples/' + OTHER + '/original'));
  const resumed = await runAttendanceWorkflowExamples(OTHER, retry.deps);
  assert.ok(resumed.scenarios.every(scenario => scenario.passed));
  for (const [key, value] of initial) assert.deepEqual(retry.store.entries.get(key).data, value, 'completed and checkpointed stages never redeliver');
  assert.deepEqual(retry.store.entries.get('examples/' + OTHER + '/original'), original);
});

test('an unexpired foreign execution remains pending; its expired lease resumes the same saved run', async () => {
  const { store, deps } = fixture(); await prepareAttendanceWorkflowExamples(ID, deps);
  await store.set('examples/' + ID + '/lease', JSON.stringify({ owner: OTHER, expiresAt: NOW + 1000 }), { onlyIfNew: true });
  assert.equal((await prepareAttendanceWorkflowExamples(ID, deps)).state, 'running');
  await assert.rejects(() => runAttendanceWorkflowExamples(ID, deps), error => error.status === 409 && error.runId === ID);
  assert.equal(simulations(store).length, 0);
  const result = await runAttendanceWorkflowExamples(ID, { ...deps, clock: () => NOW + 1001 });
  assert.equal(result.runId, ID); assert.ok(result.scenarios.every(scenario => scenario.passed));
});

test('failed original persistence or corrupted saved content never claims completion or starts a new identity', async () => {
  const h = fixture(); h.store.set = async () => ({ modified: false });
  await assert.rejects(() => runAttendanceWorkflowExamples(ID, h.deps), error => error.code === 'WORKFLOW_EXAMPLES_STORAGE_UNCONFIRMED');
  assert.equal(h.store.entries.size, 0);
  const complete = fixture(); await runAttendanceWorkflowExamples(ID, complete.deps);
  complete.store.entries.get('examples/' + ID + '/result').data.result.scenarios[0].summary = 'tampered';
  await assert.rejects(() => readAttendanceWorkflowExamples(ID, complete.deps), error => error.code === 'WORKFLOW_EXAMPLES_SAVED_RESULT_INVALID');
  await assert.rejects(() => runAttendanceWorkflowExamples(ID, complete.deps), error => error.code === 'WORKFLOW_EXAMPLES_SAVED_RESULT_INVALID');
  await assert.rejects(() => prepareAttendanceWorkflowExamples('../other', complete.deps), error => error.status === 400);
});

test('history actions bind their original ID before dispatch without changing legacy workflow runs or inventing unprepared jobs', async () => {
  const { store, deps } = fixture();
  await assert.rejects(() => runAttendanceWorkflowHistoryExamples(ID, { ...deps, requirePrepared: true }), error => error.status === 404 && error.code === 'WORKFLOW_EXAMPLES_ORIGINAL_REQUIRED');
  assert.equal(store.entries.size, 0);
  await prepareAttendanceWorkflowHistoryExamples(ID, deps);
  const original = structuredClone(store.entries.get('examples/' + ID + '/original'));
  assert.equal(original.data.kind, 'history'); assert.equal(original.data.fixtureVersion, 2);
  assert.equal(await readAttendanceWorkflowExamples(ID, deps), null);
  for (const call of [prepareAttendanceWorkflowExamples, runAttendanceWorkflowExamples]) {
    await assert.rejects(() => call(ID, deps), error => error.status === 409 && error.code === 'WORKFLOW_EXAMPLES_KIND_MISMATCH');
  }
  assert.deepEqual(store.entries.get('examples/' + ID + '/original'), original);
  const old = await runAttendanceWorkflowExamples(OTHER, deps), entriesBefore = structuredClone([...store.entries]);
  for (const call of [prepareAttendanceWorkflowHistoryExamples, runAttendanceWorkflowHistoryExamples]) {
    await assert.rejects(() => call(OTHER, deps), error => error.status === 409 && error.code === 'WORKFLOW_EXAMPLES_KIND_MISMATCH');
  }
  assert.deepEqual(await readAttendanceWorkflowExamples(OTHER, deps), old);
  assert.deepEqual([...store.entries], entriesBefore, 'type mismatch does not rewrite old originals, leases, results, or receipts');
});

test('focused saved history proves capacity, current daily barriers, late-event association and interrupted upgrade using zero network', async () => {
  const { store, deps } = fixture();
  await prepareAttendanceWorkflowHistoryExamples(ID, deps);
  const originalFetch = globalThis.fetch; let network = 0, result;
  globalThis.fetch = () => { network++; throw new Error('History examples cannot use a real network'); };
  try { result = await runAttendanceWorkflowHistoryExamples(ID, { ...deps, requirePrepared: true }); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(network, 0); assert.equal(result.scenarios.length, 4);
  assert.deepEqual(result.scenarios.filter(item => !item.passed).map(item => [item.key, item.summary]), []);
  const root = 'examples/' + ID + '/scenarios/history-main/';
  const seed = store.entries.get(root + 'fixture/seed').data;
  assert.equal(seed.ids.length, 256); assert.deepEqual(store.entries.get(root + 'workflow/index').data.ids, seed.ids);
  const messages = [...store.entries].filter(([key]) => key.startsWith(root + 'workflow/messages/')).map(([, entry]) => entry.data);
  assert.equal(messages.length, 263); assert.equal(new Set(messages.map(message => message.messageId)).size, 263);
  const simulator = [...store.entries].filter(([key]) => key.startsWith(root + 'simulation/')).map(([, entry]) => entry.data);
  assert.equal(simulator.length, 4); assert.equal(simulator.reduce((count, receipt) => count + receipt.calls, 0), 4);
  const accepted = seed.originals.find(message => message.delivery.state === 'accepted');
  assert.equal(messages.find(message => message.messageId === accepted.messageId).state, 'delivered');
  for (const other of seed.originals.filter(message => message.messageId !== accepted.messageId)) assert.notEqual(messages.find(message => message.messageId === other.messageId).state, 'delivered');
  for (const gym of ['rev', 'richmond']) {
    const draft = messages.find(message => message.messageId === 'm1-test-scheduled-' + gym + '-2027-02-06');
    assert.equal(draft.attemptCount, gym === 'rev' ? 1 : 0);
    if (gym === 'richmond') assert.equal(draft.firstAttemptAt, null);
  }
  assert.equal(store.entries.get(root + 'fixture/interrupted').data.code, 'SYNTHETIC_HISTORY_WRITE_INTERRUPTED');
  assert.equal(store.entries.get(root + 'fixture/migrated').data.complete, true);
  const saved = structuredClone([...store.entries]);
  assert.deepEqual(await readAttendanceWorkflowExamples(null, deps), result);
  assert.deepEqual(await runAttendanceWorkflowHistoryExamples(ID, deps), result);
  assert.deepEqual([...store.entries], saved, 'saved history reload does not rerun or alter evidence');
  assert.equal([...store.entries.keys()].some(key => key.startsWith('examples/' + ID + '/completed/routing')), false, 'the twelve workflow scenarios are not run by history');
});

test('focused history resumes the same original after runner interruption and leaves a prior saved twelve-scenario run unchanged', async () => {
  const { store, deps } = fixture();
  const previous = await runAttendanceWorkflowExamples(OTHER, deps), previousPrefix = 'examples/' + OTHER + '/';
  const previousEntries = structuredClone([...store.entries].filter(([key]) => key.startsWith(previousPrefix)));
  const historyDeps = { ...deps, clock: () => NOW + 1 };
  await prepareAttendanceWorkflowHistoryExamples(ID, historyDeps);
  const set = store.set.bind(store); let stop = true;
  store.set = async (key, raw, options) => {
    if (stop && key.endsWith('/completed/history-old-barriers')) { stop = false; throw new Error('Synthetic history runner interruption'); }
    return set(key, raw, options);
  };
  await assert.rejects(() => runAttendanceWorkflowHistoryExamples(ID, historyDeps), /Synthetic history runner interruption/);
  assert.equal(await readAttendanceWorkflowExamples(ID, historyDeps), null);
  const receipts = simulations(store), original = structuredClone(store.entries.get('examples/' + ID + '/original'));
  const result = await runAttendanceWorkflowHistoryExamples(ID, historyDeps);
  assert.ok(result.scenarios.every(scenario => scenario.passed));
  assert.deepEqual(simulations(store), receipts, 'resuming does not restart simulator attempts');
  assert.deepEqual(store.entries.get('examples/' + ID + '/original'), original);
  assert.deepEqual(await readAttendanceWorkflowExamples(null, historyDeps), result);
  assert.deepEqual(await readAttendanceWorkflowExamples(OTHER, deps), previous);
  assert.deepEqual([...store.entries].filter(([key]) => key.startsWith(previousPrefix)), previousEntries);
});

test('daily policy scenarios use fresh assessments, retained originals and the real coordinator without any network or caller credentials', async () => {
  const { store, deps } = fixture();
  await prepareAttendanceWorkflowDailyExamples(ID, deps);
  let calls = 0, envReads = 0;
  deps.fetch = () => { calls++; throw new Error('No caller network'); };
  Object.defineProperty(deps, 'env', { get() { envReads++; throw new Error('No caller credentials'); } });
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { calls++; throw new Error('No real network'); };
  let result;
  deps.requirePrepared = true;
  try { result = await runAttendanceWorkflowDailyExamples(ID, deps); }
  finally { globalThis.fetch = fetch; }
  assert.equal(calls, 0); assert.equal(envReads, 0);
  assert.equal(result.scenarios.length, 7);
  assert.deepEqual(result.scenarios.filter(item => !item.passed).map(item => [item.key, item.summary]), []);
  const root = 'examples/' + ID + '/scenarios/';
  const unknown = store.entries.get(root + 'daily-fresh-unknown/steps/original').data.messages.messages[0];
  const retained = store.entries.get(root + 'daily-fresh-unknown/workflow/messages/' + unknown.messageId).data;
  assert.deepEqual(retained.message, unknown.message); assert.deepEqual(retained.delivery.receipts, unknown.delivery.receipts);
  assert.equal(retained.retryBefore, unknown.retryBefore); assert.equal(retained.automaticRetriesRetired, true); assert.equal(retained.nextAttemptAt, null);
  assert.equal(store.entries.get(root + 'daily-clean-unknown/workflow/opportunities/rev').data.decision, 'clean');
  assert.deepEqual(store.entries.get(root + 'daily-overlap-recovery/fixture/overlap-complete').data, { providerCalls: 0, decision: 'clean' });
  assert.equal(store.entries.get(root + 'daily-takeover-unknown/fixture/interrupted').data.code, 'SYNTHETIC_OPPORTUNITY_WRITE_FAILURE');
  assert.equal(store.entries.get(root + 'daily-storage-unknown/fixture/storage-held').data.code, 'SYNTHETIC_OLD_LEDGER_UNAVAILABLE');
  const oldBounce = store.entries.get(root + 'daily-late-unknown/fixture/unbound-bounce-checked').data;
  assert.equal(oldBounce.matched, false); assert.equal(oldBounce.originalState, 'unknown'); assert.equal(oldBounce.providerCalls, 1);
  assert.equal(oldBounce.code, 'PRIOR_PERMANENT_RECIPIENT_PROOF_UNRESOLVED');
  const historicalHealth = store.entries.get(root + 'daily-holds-transient/steps/clean').data.health;
  assert.equal(historicalHealth.failedCount, 0); assert.equal(historicalHealth.historicalFailedCount, 1);
  const catchup = store.entries.get(root + 'daily-missed-days/workflow/messages/m1-test-scheduled-rev-2026-09-28').data;
  assert.equal(catchup.assessmentDate, '2026-09-29'); assert.equal(catchup.attemptCount, 1);
  assert.equal([...store.entries.keys()].filter(key => key.startsWith(root + 'daily-missed-days/workflow/messages/')).length, 2);
  assert.ok(result.scenarios.flatMap(item => item.messages).every(message => message.to.every(address => address.endsWith('@example.invalid'))));
  assert.ok(store.writes.every(key => key === 'latestRun' || key.startsWith('examples/' + ID + '/')));
  const saved = structuredClone([...store.entries]);
  assert.deepEqual(await readAttendanceWorkflowExamples(null, deps), result);
  assert.deepEqual(await runAttendanceWorkflowDailyExamples(ID, deps), result);
  assert.deepEqual([...store.entries], saved, 'saved daily evidence reload does not repeat a scenario');
});

test('daily originals bind kind/version before dispatch and preserve prior saved policy evidence without rerunning it', async () => {
  const { store, deps } = fixture();
  await assert.rejects(() => runAttendanceWorkflowDailyExamples(ID, { ...deps, requirePrepared: true }), error => error.code === 'WORKFLOW_EXAMPLES_ORIGINAL_REQUIRED');
  assert.equal(store.entries.size, 0);
  const legacyKeys = ['routing', 'clean', 'incomplete', 'upcoming-canceled', 'duplicate-concurrent', 'temporary-recovery',
    'uncertain-reload', 'permanent-failure', 'resolved-before-attempt', 'immutable-after-attempt', 'expired-uncertain', 'health-ordering'];
  const historyKeys = ['history-over-256', 'history-old-barriers', 'history-late-event', 'history-interrupted-upgrade'];
  for (const [runId, version, keys] of [[OTHER, 1, legacyKeys], ['123e4567-e89b-42d3-a456-426614174003', 2, historyKeys]]) {
    const original = { schema: 'm1-attendance-workflow-examples/v1', runId, synthetic: true, fixtureVersion: version, createdAt: NOW - 1,
      ...(version === 2 ? { kind: 'history' } : {}) };
    const result = { runId, complete: true, synthetic: true, scenarios: keys.map(key => ({ key, title: key, passed: true,
      summary: 'Previously saved policy evidence; no execution requested.', warnings: [], messages: [], checks: ['Historical saved result.'] })) };
    await store.set('examples/' + runId + '/original', JSON.stringify(original));
    await store.set('examples/' + runId + '/result', JSON.stringify({ schema: original.schema, hash: digestHash(result), result }));
    assert.deepEqual(await readAttendanceWorkflowExamples(runId, deps), result);
    await assert.rejects(() => prepareAttendanceWorkflowDailyExamples(runId, deps), error => error.code === 'WORKFLOW_EXAMPLES_KIND_MISMATCH');
  }
  const legacy = structuredClone([...store.entries]);
  await prepareAttendanceWorkflowDailyExamples(ID, deps);
  assert.equal(store.entries.get('examples/' + ID + '/original').data.fixtureVersion, 3);
  assert.equal(store.entries.get('examples/' + ID + '/original').data.kind, 'daily');
  for (const call of [prepareAttendanceWorkflowExamples, prepareAttendanceWorkflowHistoryExamples, runAttendanceWorkflowExamples, runAttendanceWorkflowHistoryExamples]) {
    await assert.rejects(() => call(ID, deps), error => error.code === 'WORKFLOW_EXAMPLES_KIND_MISMATCH');
  }
  assert.equal(await readAttendanceWorkflowExamples(ID, deps), null);
  assert.deepEqual([...store.entries].filter(([key]) => !key.startsWith('examples/' + ID + '/') && key !== 'latestRun'), legacy);
  assert.equal(simulations(store).length, 0);
});

test('a daily runner interruption resumes its original action and checkpoints without duplicate simulated calls', async () => {
  for (const interruptedAfter of ['daily-calendar-dst', 'daily-late-evidence']) {
    const { store, deps } = fixture();
    await prepareAttendanceWorkflowDailyExamples(ID, deps);
    const set = store.set.bind(store); let stop = true;
    store.set = async (path, raw, options) => {
      if (stop && path.endsWith('/completed/' + interruptedAfter)) { stop = false; throw new Error('Daily runner interrupted'); }
      return set(path, raw, options);
    };
    await assert.rejects(() => runAttendanceWorkflowDailyExamples(ID, deps), /Daily runner interrupted/);
    const originals = simulations(store), savedOriginal = structuredClone(store.entries.get('examples/' + ID + '/original'));
    assert.equal(await readAttendanceWorkflowExamples(ID, deps), null);
    const result = await runAttendanceWorkflowDailyExamples(ID, deps);
    assert.deepEqual(result.scenarios.filter(item => !item.passed).map(item => [item.key, item.summary]), []);
    for (const [path, value] of originals) assert.deepEqual(store.entries.get(path).data, value);
    assert.deepEqual(store.entries.get('examples/' + ID + '/original'), savedOriginal);
  }
});

test('a rejected concurrent worker waits for its delayed peer and retains only sanitized failure evidence', async () => {
  const { store, deps } = fixture(), get = store.getWithMetadata.bind(store);
  const prefix = 'examples/' + ID + '/scenarios/daily-calendar-dst/';
  let release, entered, rejected, reads = 0, finished = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const didEnter = new Promise(resolve => { entered = resolve; });
  const didReject = new Promise(resolve => { rejected = resolve; });
  const originalError = Object.assign(new Error('Unstored synthetic private transport detail'), { code: 'WORKFLOW_STORAGE_UNCONFIRMED', status: 503 });
  store.getWithMetadata = async (path, options) => {
    if (path === prefix + 'workflow/processor' && store.entries.has(prefix + 'steps/before-cutoff') && reads < 2) {
      reads++;
      if (reads === 1) { entered(); await blocked; }
      else { rejected(); throw originalError; }
    }
    return get(path, options);
  };
  const running = runAttendanceWorkflowDailyExamples(ID, deps).then(value => { finished = true; return { value }; }, error => { finished = true; return { error }; });
  await Promise.all([didEnter, didReject]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'the background run must await the delayed processor after its peer rejects');
  } finally { release(); }
  const outcome = await running;
  assert.equal(outcome.error, originalError, 'the original error is propagated without replacement or swallowing');
  assert.equal(store.entries.get(prefix + 'workflow/processor').data.expiresAt, 0, 'the delayed winner finishes and releases normally');
  assert.equal(store.entries.get(prefix + 'simulation/m1-test-scheduled-rev-2026-09-25').data.calls, 1);
  assert.equal(store.entries.has(prefix + 'steps/cutoff'), false, 'a failed peer cannot be hidden behind a successful step');
  const receipts = [...store.entries].filter(([path]) => path.startsWith(prefix + 'failures/')).map(([, entry]) => entry.data);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].stage, 'concurrent-process'); assert.equal(receipts[0].worker, 1);
  assert.equal(receipts[0].category, 'WORKFLOW_STORAGE_UNCONFIRMED'); assert.equal(receipts[0].httpStatus, 503);
  assert.doesNotMatch(JSON.stringify(receipts), /private transport detail|authorization|passphrase/i);
  assert.equal(await readAttendanceWorkflowExamples(ID, deps), null);
});

test('the original partial calendar run resumes after its retained virtual lease without rewriting earlier evidence or advancing repeatedly', async () => {
  const { store, deps } = fixture(), set = store.set.bind(store);
  const prefix = 'examples/' + ID + '/scenarios/daily-calendar-dst/', cutoff = Date.parse('2026-09-25T22:00:00-04:00');
  const interrupted = Object.assign(new Error('Simulated terminated worker'), { code: 'WORKFLOW_STORAGE_UNCONFIRMED' });
  let stopped = false;
  store.set = async (path, raw, options) => {
    const value = JSON.parse(raw);
    if (path === prefix + 'workflow/health' && value.checkedAt === cutoff) {
      await set(path, raw, options); stopped = true; throw interrupted;
    }
    if (stopped && path === prefix + 'workflow/processor' && value.expiresAt === 0) throw interrupted;
    return set(path, raw, options);
  };
  await assert.rejects(() => runAttendanceWorkflowDailyExamples(ID, deps), error => error === interrupted);
  store.set = set;
  const original = structuredClone(store.entries.get('examples/' + ID + '/original'));
  const oldHealth = structuredClone(store.entries.get(prefix + 'workflow/health').data);
  const oldProcessor = structuredClone(store.entries.get(prefix + 'workflow/processor').data);
  const earlier = structuredClone([...store.entries].filter(([path]) => path.startsWith(prefix + 'steps/') || path.startsWith(prefix + 'failures/')));
  assert.equal(oldHealth.checkedAt, cutoff); assert.equal(oldProcessor.expiresAt, cutoff + 600000);
  assert.equal(store.entries.has(prefix + 'steps/cutoff'), false);
  const second = new Store(); second.entries = structuredClone(store.entries); second.serial = store.serial;
  const result = await runAttendanceWorkflowDailyExamples(ID, deps);
  assert.deepEqual(result.scenarios.filter(scenario => !scenario.passed).map(scenario => [scenario.key, scenario.summary]), []);
  const recovery = store.entries.get(prefix + 'fixture/concurrent-recovery').data;
  assert.deepEqual(recovery.originalHealth, oldHealth); assert.deepEqual(recovery.originalProcessor, oldProcessor);
  assert.equal(recovery.effectiveAt, oldProcessor.expiresAt + 1);
  assert.notEqual(recovery.recoveryRequestId, oldHealth.requestId);
  assert.equal(Date.parse(store.entries.get(prefix + 'steps/cutoff').data.digest.generatedAt), recovery.effectiveAt);
  assert.equal(Date.parse(store.entries.get(prefix + 'steps/repeat').data.digest.generatedAt), recovery.effectiveAt + 60000);
  assert.equal(store.entries.get(prefix + 'workflow/messages/m1-test-scheduled-rev-2026-09-25').data.firstAttemptAt, recovery.effectiveAt);
  assert.equal(store.entries.get(prefix + 'simulation/m1-test-scheduled-rev-2026-09-25').data.calls, 1);
  for (const [path, value] of earlier) assert.deepEqual(store.entries.get(path), value, 'earlier checkpoints and failure evidence are preserved');
  assert.deepEqual(store.entries.get('examples/' + ID + '/original'), original);
  const secondSet = second.set.bind(second); let stoppedAgain = false;
  second.set = async (path, raw, options) => {
    const value = JSON.parse(raw);
    if (path === prefix + 'workflow/health' && value.checkedAt > cutoff) {
      await secondSet(path, raw, options); stoppedAgain = true; throw interrupted;
    }
    if (stoppedAgain && path === prefix + 'workflow/processor' && value.expiresAt === 0) throw interrupted;
    return secondSet(path, raw, options);
  };
  const secondDeps = { examplesStore: second, clock: deps.clock };
  await assert.rejects(() => runAttendanceWorkflowDailyExamples(ID, secondDeps), error => error === interrupted);
  second.set = secondSet;
  const retainedRecovery = structuredClone(second.entries.get(prefix + 'fixture/concurrent-recovery'));
  await assert.rejects(() => runAttendanceWorkflowDailyExamples(ID, secondDeps), error => error.code === 'WORKFLOW_EXAMPLES_RECOVERY_REQUIRES_REVIEW');
  assert.deepEqual(second.entries.get(prefix + 'fixture/concurrent-recovery'), retainedRecovery, 'a second failure cannot extend the virtual clock repeatedly');
  assert.equal(second.entries.has(prefix + 'simulation/m1-test-scheduled-rev-2026-09-25'), false);
});
