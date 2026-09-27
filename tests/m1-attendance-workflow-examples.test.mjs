import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareAttendanceWorkflowExamples, prepareAttendanceWorkflowHistoryExamples, readAttendanceWorkflowExamples,
  runAttendanceWorkflowExamples, runAttendanceWorkflowHistoryExamples } from '../netlify/functions/_lib/m1-attendance-workflow-examples.mjs';

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
  assert.equal(healed.messageId, pending.messageId); assert.deepEqual(healed.message, pending.message);
  assert.equal(healed.attemptCount, 1); assert.equal(healed.delivery.state, 'accepted');
  const provider = store.entries.get(root + 'temporary-recovery-claim/simulation/' + pending.messageId).data;
  assert.equal(provider.calls, 1); assert.equal(provider.accepted, true);
  assert.ok(result.scenarios.find(s => s.key === 'temporary-recovery').passed);
});

test('permanent rejection and expired unknown acceptance retain old receipts and prevent a next-day replacement attempt', async () => {
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
    assert.equal(draft.date, '2026-09-25'); assert.equal(draft.attemptCount, 0); assert.equal(draft.firstAttemptAt, null); assert.equal(draft.delivery, null);
    assert.equal(draft.state, 'prepared');
    assert.equal(draft.code, name === 'permanent-failure' ? 'PRIOR_PERMANENT_REJECTION_UNCHANGED' : 'PRIOR_ACCEPTANCE_UNCONFIRMED');
    const providerEntries = [...store.entries].filter(([key]) => key.startsWith(root + 'simulation/'));
    assert.equal(providerEntries.length, 1); assert.equal(providerEntries[0][1].data.calls, 1);
    assert.equal(store.entries.has(root + 'simulation/' + draft.messageId), false);
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

test('focused saved history proves capacity, old barriers, late-event association and interrupted upgrade using zero network', async () => {
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
  assert.equal(simulator.length, 3); assert.equal(simulator.reduce((count, receipt) => count + receipt.calls, 0), 3);
  const accepted = seed.originals.find(message => message.delivery.state === 'accepted');
  assert.equal(messages.find(message => message.messageId === accepted.messageId).state, 'delivered');
  for (const other of seed.originals.filter(message => message.messageId !== accepted.messageId)) assert.notEqual(messages.find(message => message.messageId === other.messageId).state, 'delivered');
  for (const gym of ['rev', 'richmond']) {
    const draft = messages.find(message => message.messageId === 'm1-test-scheduled-' + gym + '-2027-02-06');
    assert.equal(draft.attemptCount, 0); assert.equal(draft.firstAttemptAt, null);
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
