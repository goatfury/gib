import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttendanceDigest, defaultDigestConfiguration, datesThrough, digestHash } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { makeDigestBinding } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, workflowMessages, workflowHealth, recordWorkflowDeliveryEvidence,
  enqueueAttendanceWorkflow, executeAttendanceWorkflowJob } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';

const NOW = Date.parse('2026-09-25T02:30:00Z'), DATE = '2026-09-24';
const providerId = '00000000-0000-4000-8000-000000000001';
const scope = { target: 'test', syntheticRehearsal: true, profile: { installationId: 'rev', gymName: 'Revolution synthetic TEST' } };
const SAFE_ENV = { GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true', GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME: '22:00',
  GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW: 'false', GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW: 'false', GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: 'stu@example.invalid',
  GIB_M1_ATTENDANCE_DIGEST_TREY_EMAIL: 'trey@example.invalid' };

// The same isolated fixture used during independent review. Store hooks below
// reproduce the demonstrated interleavings without network, timers or live data.
function harness() {
  let stamp = NOW, serial = 0, request = 10;
  const entries = new Map(), calls = [];
  const store = {
    async getWithMetadata(key) { return structuredClone(entries.get(key) || null); },
    async set(key, raw, options) {
      const prior = entries.get(key);
      if (options.onlyIfNew && prior || options.onlyIfMatch && options.onlyIfMatch !== prior?.etag) return { modified: false };
      const etag = String(++serial);
      entries.set(key, { data: JSON.parse(raw), etag });
      return { modified: true, etag };
    }
  };
  const deps = { scope, workflowStore: store, clock: () => stamp, env: {},
    fetch: async () => { throw new Error('Network forbidden in workflow race fixture'); },
    simulatedProvider: { identity: 'fixed-synthetic-provider', send: async message => {
      calls.push(structuredClone(message));
      return new Response(JSON.stringify({ id: providerId }), { status: 200 });
    } } };
  function input(mode = 'issue') {
    const configuration = defaultDigestConfiguration(scope, SAFE_ENV);
    // Preserve the reviewed legacy no-copy fixture and its explicit closing
    // policy; new reminder defaults must not change the race under test.
    delete configuration.classFinishCutoffConfirmed;
    for (const route of Object.values(configuration.routing)) delete route.bcc;
    const binding = makeDigestBinding('00000000-0000-4000-8000-' + String(++request).padStart(12, '0'), 'scheduled', stamp);
    const snapshots = configuration.gyms.map(gym => ({ gym: gym.id, attendance: { ok: true, ledger: {
      ok: true, complete: true, target: 'test', schema: 'm1-manager-review/v1', gym: gym.id, from: '2026-09-07', to: binding.jobDate,
      days: datesThrough(binding.jobDate).map(date => ({ date, attendanceHash: digestHash(date),
        records: mode === 'clean' && date === DATE ? [{ recordId: 'fixture-' + gym.id, date, classLabel: 'SYNTHETIC class',
          instructor: 'SYNTHETIC instructor', duration: 1, reviewRequired: false }] : [], warnings: [], review: null }))
    } }, staff: { ok: true, complete: true, items: [] } }));
    const schedules = configuration.gyms.map(gym => ({ gym: gym.id, timezone: 'America/New_York',
      days: datesThrough(binding.jobDate).map(date => ({ date, status: 'complete',
        observedAt: new Date(Math.min(stamp, Date.parse(date + 'T12:00:00.000Z'))).toISOString(), sourceVersion: 'synthetic',
        occurrences: date === DATE ? [{ label: 'SYNTHETIC class', startAt: DATE + 'T22:00:00.000Z',
          endAt: DATE + 'T23:00:00.000Z', cancelled: false }] : [] })) }));
    return { configuration, binding, due: 'due', digest: buildAttendanceDigest({ jobDate: binding.jobDate, snapshots, schedules, configuration, now: stamp }) };
  }
  return { deps, entries, store, calls, input, at: value => { stamp = value; },
    run: mode => processAttendanceWorkflow(input(mode), deps),
    messages: async () => (await workflowMessages(scope, deps)).messages, health: () => workflowHealth(scope, deps) };
}
const evidence = (message, patch = {}) => ({ eventId: 'msg_fixture_delivered', providerId, type: 'email.delivered',
  occurredAt: new Date(NOW).toISOString(), from: message.from, to: message.to, ...patch });

test('a concurrent clean check cannot publish newer health between the owner check and its first claim', { timeout: 5000 }, async () => {
  const h = harness(), older = h.input();
  h.at(NOW + 1000);
  const newer = h.input('clean');
  assert.equal(newer.digest.itemCount, 0);
  const get = h.store.getWithMetadata.bind(h.store), provider = h.deps.simulatedProvider.send;
  let injected = false, concurrentResult, healthAtProvider;
  h.store.getWithMetadata = async path => {
    const value = await get(path);
    // Pause the older invocation at its final health read after preparation,
    // before it freezes the body or creates the provider's durable attempt.
    const draft = h.entries.get('workflow/messages/m1-test-scheduled-rev-' + DATE)?.data;
    if (!injected && path === 'workflow/health' && draft?.state === 'prepared' && !draft.firstAttemptAt) {
      injected = true;
      concurrentResult = await processAttendanceWorkflow(newer, h.deps);
    }
    return value;
  };
  h.deps.simulatedProvider.send = async message => {
    healthAtProvider = (await get('workflow/health')).data.requestId;
    return provider(message);
  };
  await processAttendanceWorkflow(older, h.deps);
  assert.equal(injected, true, 'the adversarial interleaving was reached');
  assert.equal(concurrentResult.pending, true, 'the second check must defer to the active owner');
  assert.equal(healthAtProvider, older.binding.requestId);
  assert.equal(h.calls.length, 1);
  await processAttendanceWorkflow(newer, h.deps);
  assert.equal(h.entries.get('workflow/health').data.requestId, newer.binding.requestId, 'the deferred check can run after ownership is released');
  assert.equal(h.calls.length, 1, 'the later clean check cannot create another send');
});

test('a delivery webhook committed before a stale outcome write keeps its confirmed state', async () => {
  const h = harness();
  await h.run();
  const message = (await h.messages())[0].message;
  h.at(NOW + 1000);
  const set = h.store.set.bind(h.store);
  let injected = false, webhookResult;
  h.store.set = async (path, raw, options) => {
    if (!injected && path === 'workflow/messages/' + message.messageId && JSON.parse(raw).state === 'unconfirmed') {
      injected = true;
      webhookResult = await recordWorkflowDeliveryEvidence(evidence(message), { ...h.deps, deliveryEvidenceVerified: true });
    }
    return set(path, raw, options);
  };
  await h.run('clean');
  assert.equal(injected, true);
  assert.deepEqual(webhookResult, { ok: true, matched: true, state: 'delivered' });
  assert.equal((await h.messages())[0].state, 'delivered');
  assert.equal((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'), false);
  assert.equal(h.calls.length, 1);
});

test('delivery evidence before a retry response survives the expired first-attempt claim', async () => {
  const h = harness();
  let webhookResult;
  h.deps.simulatedProvider.send = async message => {
    h.calls.push(structuredClone(message));
    if (h.calls.length === 1) throw new Error('Synthetic lost first response');
    webhookResult = await recordWorkflowDeliveryEvidence(evidence(message, { occurredAt: new Date(NOW + 16 * 60000).toISOString() }),
      { ...h.deps, deliveryEvidenceVerified: true });
    return new Response(JSON.stringify({ id: providerId }), { status: 200 });
  };
  await h.run();
  h.at(NOW + 16 * 60000);
  await h.run();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], h.calls[0], 'retry must preserve the complete original message and identity');
  assert.deepEqual(webhookResult, { ok: true, matched: false, state: 'pending' }, 'an active retry retains provisional evidence without prematurely confirming it');
  const saved = (await h.messages())[0];
  assert.equal(saved.state, 'delivered');
  assert.equal(saved.attemptCount, 2);
  assert.deepEqual(saved.delivery.receipts.map(receipt => receipt.state), ['unknown', 'accepted'], 'the original uncertain history remains');
  assert.equal((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'), false);
});

test('a worker failure after clean health publication never hides behind the same check timestamp', async () => {
  const h = harness(), input = h.input('clean');
  h.deps.backgroundFetch = async () => {
    assert.ok(h.entries.has('workflow/jobs/' + input.binding.requestId), 'the exact job is durable before dispatch');
    return new Response(null, { status: 202 });
  };
  await enqueueAttendanceWorkflow(input, { target: 'test', adminActionToken: 'synthetic-fixture-key' }, h.deps);
  const set = h.store.set.bind(h.store);
  let injected = false;
  h.store.set = async (path, ...args) => {
    if (!injected && path.startsWith('workflow/messages/')) {
      injected = true;
      assert.equal(h.entries.get('workflow/health').data.requestId, input.binding.requestId);
      throw new Error('Synthetic message storage failure after health publication');
    }
    return set(path, ...args);
  };
  await assert.rejects(() => executeAttendanceWorkflowJob(input.binding.requestId, scope, h.deps), /WORKFLOW_JOB_UNCONFIRMED/);
  assert.equal(injected, true);
  const head = h.entries.get('workflow/job-head').data, checked = h.entries.get('workflow/health').data;
  assert.equal(head.jobId, checked.requestId);
  assert.equal(head.checkedAt, checked.checkedAt);
  assert.equal(head.state, 'needs-fresh-check');
  const health = await h.health();
  assert.equal(health.state, 'check-incomplete');
  assert.ok(health.codes.includes('CHECK_INCOMPLETE'));
  assert.equal(h.calls.length, 0);
});
