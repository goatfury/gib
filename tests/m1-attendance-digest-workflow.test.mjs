import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttendanceDigest, defaultDigestConfiguration, datesThrough, digestHash } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { makeDigestBinding } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, workflowMessages, workflowHealth, recordWorkflowDeliveryEvidence } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';

const NOW = Date.parse('2026-09-25T02:30:00Z'), DATE = '2026-09-24', providerId = '00000000-0000-4000-8000-000000000001';
const scope = { target: 'test', syntheticRehearsal: true, profile: { installationId: 'rev', gymName: 'Revolution synthetic TEST' } };
const SAFE_ENV = { GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true', GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: 'stu@example.invalid', GIB_M1_ATTENDANCE_DIGEST_TREY_EMAIL: 'trey@example.invalid' };
function harness() {
  let stamp = NOW, serial = 0, request = 10;
  const entries = new Map(), calls = [];
  const store = { async getWithMetadata(key) { return structuredClone(entries.get(key) || null); }, async set(key, raw, options) {
    const prior = entries.get(key);
    if (options.onlyIfNew && prior || options.onlyIfMatch && options.onlyIfMatch !== prior?.etag) return { modified: false };
    const etag = String(++serial); entries.set(key, { data: JSON.parse(raw), etag }); return { modified: true, etag };
  } };
  const deps = { scope, workflowStore: store, clock: () => stamp, env: {}, simulatedProvider: { identity: 'fixed-synthetic-provider', send: async message => {
    calls.push(structuredClone(message)); return new Response(JSON.stringify({ id: providerId }), { status: 200 });
  } } };
  function input(mode = 'issue', both = false, createdAt = stamp) {
    const configuration = defaultDigestConfiguration(scope, SAFE_ENV), binding = makeDigestBinding('00000000-0000-4000-8000-' + String(++request).padStart(12, '0'), 'scheduled', createdAt);
    if (both) configuration.gyms.push({ id: 'richmond', name: 'Richmond synthetic TEST', timezone: 'America/New_York', adminUrl: 'https://gib-richmond-test.netlify.app/m1/admin/' });
    const snapshots = configuration.gyms.map(gym => ({ gym: gym.id, attendance: { ok: true, ledger: { ok: true, complete: true, target: 'test', schema: 'm1-manager-review/v1', gym: gym.id, from: '2026-09-07', to: binding.jobDate,
      days: datesThrough(binding.jobDate).map(date => ({ date, attendanceHash: digestHash(date), records: mode === 'clean' && date === DATE ? [{ recordId: 'fixture-' + gym.id, date, classLabel: 'SYNTHETIC class', instructor: 'SYNTHETIC instructor', duration: 1, reviewRequired: false }] : [], warnings: [], review: null })) } }, staff: { ok: true, complete: true, items: [] } }));
    if (mode === 'incomplete') snapshots[0].attendance = { ok: false, code: 'SYNTHETIC_FAILURE' };
    const schedules = configuration.gyms.map(gym => ({ gym: gym.id, timezone: 'America/New_York', days: datesThrough(binding.jobDate).map(date => ({ date, status: 'complete', observedAt: new Date(Math.min(stamp, Date.parse(date + 'T12:00:00.000Z'))).toISOString(), sourceVersion: 'synthetic',
      occurrences: date === DATE ? [{ label: 'SYNTHETIC class', startAt: DATE + 'T22:00:00.000Z', endAt: DATE + 'T23:00:00.000Z', cancelled: false }] : [] })) }));
    return { configuration, binding, due: 'due', digest: buildAttendanceDigest({ jobDate: binding.jobDate, snapshots, schedules, configuration, now: stamp }) };
  }
  return { deps, entries, store, calls, input, at: value => { stamp = value; }, run: (mode, both, createdAt) => processAttendanceWorkflow(input(mode, both, createdAt), deps),
    messages: async () => (await workflowMessages(scope, deps)).messages, health: () => workflowHealth(scope, deps) };
}
const evidence = (message, patch = {}) => ({ eventId: 'msg_fixture_delivered', providerId, type: 'email.delivered', occurredAt: new Date(NOW).toISOString(), from: message.from, to: message.to, ...patch });

test('legacy one-email flags cannot authorize scheduled delivery and no first check is not a missed run', async () => {
  const h = harness(); delete h.deps.simulatedProvider;
  let network = 0; h.deps.fetch = async () => { network++; throw new Error(); };
  h.deps.env = { GIB_M1_DIGEST_TEST_SEND_ENABLED: 'true', GIB_M1_DIGEST_TEST_RESEND_API_KEY: 'synthetic-not-a-secret' };
  const before = await h.health(); assert.deepEqual(before.codes, ['CONFIGURATION_REQUIRED']); assert.equal(before.state, 'not-configured');
  await h.run(); assert.equal(network, 0); assert.equal((await h.messages())[0].firstAttemptAt, null);
  assert.ok((await h.health()).codes.includes('CONFIGURATION_REQUIRED'));
  assert.equal([...h.entries.keys()].some(key => key.includes('/delivery/')), false);
});

test('new scheduled controls reach the same awaited provider adapter only after sender, recipients and cutoff are explicitly verified', async () => {
  const h = harness(); delete h.deps.simulatedProvider;
  const input = h.input(); input.digest.syntheticRehearsal = true;
  const sender = 'GIB Revolution TEST <onboarding@resend.dev>';
  h.deps.env = { GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_ATTENDANCE_DIGEST_VERIFIED_SENDER: sender,
    GIB_M1_ATTENDANCE_DIGEST_VERIFIED_RECIPIENTS: 'stu@example.invalid', GIB_M1_DIGEST_TEST_RESEND_API_KEY: 'synthetic-provider-key' };
  let request;
  h.deps.fetch = async (url, init) => { request = { url, init }; assert.ok([...h.entries.keys()].some(key => key.includes('/delivery/messages/'))); return new Response(JSON.stringify({ id: providerId }), { status: 200 }); };
  await processAttendanceWorkflow(input, h.deps);
  assert.equal(request.url, 'https://api.resend.com/emails'); assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers['Idempotency-Key'], 'm1-test-scheduled-rev-' + DATE);
  assert.deepEqual(JSON.parse(request.init.body).to, ['stu@example.invalid']);
  assert.equal((await h.messages())[0].state, 'unconfirmed', 'provider acceptance is not inbox delivery');
});

test('a fresh incomplete read creates an explicit could-not-check message and keeps the incomplete warning', async () => {
  const h = harness(); await h.run('incomplete');
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].text, /could not be checked/);
  assert.doesNotMatch(h.calls[0].text, /no valid instructor sign-in/);
  assert.ok((await h.health()).codes.includes('CHECK_INCOMPLETE'));
});

test('a transient pre-attempt storage failure recovers with fresh data instead of freezing an unsent obsolete message', async () => {
  const h = harness(), original = h.store.set; let fail = true;
  h.store.set = async (key, ...args) => { if (fail && key.includes('/delivery/messages/')) { fail = false; throw new Error('synthetic storage unavailable'); } return original(key, ...args); };
  await h.run(); assert.equal(h.calls.length, 0);
  h.at(NOW + 16 * 60000); await h.run('clean');
  const message = (await h.messages())[0]; assert.equal(message.firstAttemptAt, null); assert.equal(message.state, 'suppressed');
  assert.equal(h.calls.length, 0);
});

test('permanent errors stop, transient retries retain exact content and stop at the six-attempt cap', async () => {
  const permanent = harness(); permanent.deps.simulatedProvider.send = async message => { permanent.calls.push(message); return new Response('{}', { status: 403 }); };
  await permanent.run(); permanent.at(NOW + 16 * 60000); await permanent.run(); assert.equal(permanent.calls.length, 1);
  assert.ok((await permanent.health()).codes.includes('DELIVERY_FAILED'));
  const transient = harness(); transient.deps.simulatedProvider.send = async message => { transient.calls.push(structuredClone(message)); return new Response('{}', { status: 429 }); };
  await transient.run();
  for (const minutes of [16, 47, 108, 229, 470, 800]) { transient.at(NOW + minutes * 60000); await transient.run('clean'); }
  assert.equal(transient.calls.length, 6, JSON.stringify(transient.calls.map(message => message.messageId)));
  assert.ok(transient.calls.every(message => JSON.stringify(message) === JSON.stringify(transient.calls[0])));
  assert.equal((await transient.messages())[0].code, 'MANUAL_RECONCILIATION_REQUIRED');
});

test('only matched signed delivery evidence clears acceptance uncertainty, including receipt before acceptance and duplicate replay', async () => {
  const h = harness(); await h.run(); const message = (await h.messages())[0].message;
  await assert.rejects(() => recordWorkflowDeliveryEvidence(evidence(message), h.deps), /EVIDENCE_INVALID/);
  const verified = { ...h.deps, deliveryEvidenceVerified: true };
  assert.equal((await recordWorkflowDeliveryEvidence(evidence(message, { eventId: 'msg_wrong', to: ['other@example.invalid'] }), verified)).matched, false);
  assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
  const accepted = await recordWorkflowDeliveryEvidence(evidence(message), verified); assert.deepEqual(accepted, { ok: true, matched: true, state: 'delivered' });
  assert.deepEqual(await recordWorkflowDeliveryEvidence(evidence(message), verified), accepted);
  assert.equal((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'), false);
  await assert.rejects(() => recordWorkflowDeliveryEvidence(evidence(message, { type: 'email.failed' }), verified), /EVIDENCE_CONFLICT/);
  const before = harness();
  before.deps.simulatedProvider = { identity: 'fixed', send: async message => {
    assert.equal((await recordWorkflowDeliveryEvidence(evidence(message), { ...before.deps, deliveryEvidenceVerified: true })).state, 'pending');
    return new Response(JSON.stringify({ id: providerId }), { status: 200 });
  } };
  await before.run(); assert.equal((await before.messages())[0].state, 'delivered');
});

test('fresh clean reads cannot erase attempted unknown sends; old successful reads cannot erase newer incomplete evidence; public health stays Revolution-only', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(message); throw new Error('uncertain'); };
  await h.run(); h.at(NOW + 1000); await h.run('clean'); assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
  h.at(NOW + 2000); await h.run('incomplete'); h.at(NOW + 3000); await h.run('clean', false, NOW + 1000);
  assert.ok((await h.health()).codes.includes('CHECK_INCOMPLETE'));
  const isolated = harness(); await isolated.run('issue', true); const result = await isolated.health();
  assert.equal(result.unconfirmedCount, 1); assert.equal(JSON.stringify(result).includes('richmond'), false);
  isolated.at(NOW + 31 * 60000); assert.ok((await isolated.health()).codes.includes('CHECK_OVERDUE'));
});

test('positive To-only evidence cannot confirm optional copied-recipient delivery', async () => {
  const h = harness(), input = h.input();
  input.configuration.routing.rev.cc = [{ key: 'andrew', name: 'Andrew', address: 'andrew@example.invalid' }];
  input.configuration.recipients = [input.configuration.routing.rev.reviewer, ...input.configuration.routing.rev.cc];
  await processAttendanceWorkflow(input, h.deps);
  const message = (await h.messages())[0].message;
  assert.equal(message.cc.length, 1);
  const result = await recordWorkflowDeliveryEvidence(evidence(message), { ...h.deps, deliveryEvidenceVerified: true });
  assert.equal(result.state, 'unconfirmed'); assert.equal((await h.messages())[0].code, 'CC_DELIVERY_UNCONFIRMED');
  assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
});

test('new days cannot bypass unknown original acceptance or its expired retry window, even after route or credential changes', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(structuredClone(message)); throw new Error('synthetic lost reply'); };
  await h.run();
  const original = structuredClone(h.entries.get('workflow/delivery/messages/m1-test-scheduled-rev-' + DATE).data);
  h.at(NOW + 24 * 60 * 60000); await h.run();
  let draft = (await h.messages()).find(value => value.date === '2026-09-25');
  assert.equal(draft.firstAttemptAt, null); assert.equal(draft.code, 'PRIOR_ACCEPTANCE_UNCONFIRMED');
  assert.equal(h.calls.length, 1); assert.ok(draft.message.text.includes('SYNTHETIC class'));
  assert.equal(h.entries.has('workflow/delivery/messages/' + draft.messageId), false);
  h.at(NOW + 48 * 60 * 60000); h.deps.simulatedProvider.identity = 'changed-provider';
  const changed = h.input(); changed.configuration.routing.rev.reviewer.address = 'repaired@example.invalid';
  await processAttendanceWorkflow(changed, h.deps);
  draft = (await h.messages()).find(value => value.date === '2026-09-26');
  assert.equal(draft.code, 'PRIOR_ACCEPTANCE_UNCONFIRMED'); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.entries.get('workflow/delivery/messages/m1-test-scheduled-rev-' + DATE).data, original);
  assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
});

test('an active original provider claim across midnight defers a new day without creating another identity', async () => {
  const h = harness(), start = Date.parse('2026-09-25T03:59:30Z'), set = h.store.set;
  h.at(start);
  h.store.set = async (key, ...args) => { if (key.startsWith('workflow/delivery/attempts/')) throw new Error('synthetic receipt storage failure'); return set(key, ...args); };
  await h.run(); assert.equal(h.calls.length, 1);
  h.at(start + 31000); await h.run();
  const draft = (await h.messages()).find(value => value.date === '2026-09-25');
  assert.equal(draft.code, 'PRIOR_ACCEPTANCE_UNCONFIRMED'); assert.equal(draft.firstAttemptAt, null);
  assert.equal(h.calls.length, 1); assert.equal(h.entries.has('workflow/delivery/messages/' + draft.messageId), false);
});

test('known acceptance allows later daily reminders while delivery itself remains unconfirmed', async () => {
  const h = harness(); await h.run();
  assert.equal((await h.messages())[0].state, 'unconfirmed');
  h.at(NOW + 24 * 60 * 60000); await h.run();
  assert.equal(h.calls.length, 2); assert.notEqual(h.calls[0].messageId, h.calls[1].messageId);
  assert.equal((await h.messages()).find(value => value.date === '2026-09-25').delivery.state, 'accepted');
  assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
});

test('new dates and changed message contents do not restart an unchanged permanent provider rejection', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(structuredClone(message)); return new Response('{}', { status: 403 }); };
  await h.run(); const retained = structuredClone(h.entries.get('workflow/delivery/messages/m1-test-scheduled-rev-' + DATE).data);
  for (const days of [1, 2, 3]) { h.at(NOW + days * 24 * 60 * 60000); await h.run(days === 2 ? 'incomplete' : 'issue'); }
  assert.equal(h.calls.length, 1);
  const draft = (await h.messages()).find(value => value.date === '2026-09-27');
  assert.equal(draft.code, 'PRIOR_PERMANENT_REJECTION_UNCHANGED'); assert.equal(draft.firstAttemptAt, null);
  assert.deepEqual(h.entries.get('workflow/delivery/messages/m1-test-scheduled-rev-' + DATE).data, retained);
  assert.ok((await h.health()).codes.includes('DELIVERY_FAILED'));
});

test('a definite rejection can resume only across an existing sender, recipient or provider-identity repair boundary', async () => {
  for (const repair of ['sender', 'recipient', 'provider']) {
    const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(structuredClone(message)); return new Response('{}', { status: 403 }); };
    await h.run(); h.at(NOW + 24 * 60 * 60000); await h.run(); assert.equal(h.calls.length, 1);
    h.deps.simulatedProvider.send = async message => { h.calls.push(structuredClone(message)); return new Response(JSON.stringify({ id: providerId }), { status: 200 }); };
    if (repair === 'sender') h.deps.env.GIB_M1_ATTENDANCE_DIGEST_FROM = 'Repaired synthetic sender <sender@example.invalid>';
    if (repair === 'provider') h.deps.simulatedProvider.identity = 'repaired-synthetic-provider';
    h.at(NOW + 24 * 60 * 60000 + 1000); const input = h.input();
    if (repair === 'recipient') input.configuration.routing.rev.reviewer.address = 'repaired@example.invalid';
    await processAttendanceWorkflow(input, h.deps);
    assert.equal(h.calls.length, 2, repair); assert.equal(h.calls[1].messageId, 'm1-test-scheduled-rev-2026-09-25');
    assert.equal((await h.messages())[0].delivery.receipts[0].httpStatus, 403, 'original failure audit remains');
  }
});

test('prior-read failure or stale accepted workflow summaries cannot authorize a new identity; the guard remains gym-specific', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(structuredClone(message)); if (message.messageId.includes('-rev-')) throw new Error('synthetic lost reply'); return new Response(JSON.stringify({ id: providerId }), { status: 200 }); };
  await h.run('issue', true);
  const old = h.entries.get('workflow/messages/m1-test-scheduled-rev-' + DATE);
  old.data.delivery = { state: 'accepted', providerId }; old.data.state = 'delivered';
  h.at(NOW + 24 * 60 * 60000); await h.run('issue', true);
  assert.equal(h.calls.filter(message => message.messageId.includes('-rev-')).length, 1);
  assert.equal(h.calls.filter(message => message.messageId.includes('-richmond-')).length, 2);
  const read = h.store.getWithMetadata;
  h.store.getWithMetadata = async key => { if (key === 'workflow/delivery/messages/m1-test-scheduled-rev-' + DATE) throw new Error('synthetic unavailable'); return read(key); };
  h.at(NOW + 48 * 60 * 60000); await h.run();
  assert.equal(h.calls.filter(message => message.messageId.includes('-rev-')).length, 1);
  assert.equal((await h.messages()).find(value => value.date === '2026-09-26').code, 'PRIOR_ACCEPTANCE_UNCONFIRMED');
});

test('explicit signed Permanent bounce holds the same recipient across dates and provider/sender changes without reclassifying legacy failures', async () => {
  const h = harness(); await h.run(); const original = (await h.messages())[0].message;
  const bounce = evidence(original, { eventId: 'msg_permanent_bounce', type: 'email.bounced', permanentFailure: true });
  const verified = { ...h.deps, deliveryEvidenceVerified: true };
  await recordWorkflowDeliveryEvidence(bounce, verified);
  const receiptPath = 'workflow/provider-evidence/' + providerId + '/' + bounce.eventId;
  const retained = structuredClone(h.entries.get(receiptPath).data);
  h.at(NOW + 24 * 60 * 60000); await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal((await h.messages()).find(value => value.date === '2026-09-25').code, 'PRIOR_PERMANENT_RECIPIENT_BOUNCE');
  h.deps.env.GIB_M1_ATTENDANCE_DIGEST_FROM = 'Repaired synthetic sender <sender@example.invalid>';
  h.deps.simulatedProvider.identity = 'changed-synthetic-provider';
  h.at(NOW + 24 * 60 * 60000 + 1000); await h.run(); assert.equal(h.calls.length, 1);
  h.at(NOW + 24 * 60 * 60000 + 2000); const changed = h.input();
  changed.configuration.routing.rev.reviewer.address = 'verified-repaired@example.invalid';
  await processAttendanceWorkflow(changed, h.deps); assert.equal(h.calls.length, 2);
  assert.deepEqual(h.entries.get(receiptPath).data, retained, 'original signed evidence is immutable');
  await assert.rejects(() => recordWorkflowDeliveryEvidence({ ...bounce, eventId: 'invalid_failed', type: 'email.failed' }, verified), /EVIDENCE_INVALID/);
  await assert.rejects(() => recordWorkflowDeliveryEvidence({ ...bounce, eventId: 'invalid_false', permanentFailure: false }, verified), /EVIDENCE_INVALID/);
  for (const type of ['email.bounced', 'email.failed']) {
    const legacy = harness(); await legacy.run();
    const event = evidence((await legacy.messages())[0].message, { type });
    await recordWorkflowDeliveryEvidence(event, { ...legacy.deps, deliveryEvidenceVerified: true });
    legacy.at(NOW + 24 * 60 * 60000); await legacy.run();
    assert.equal(legacy.calls.length, 2, type + ' without explicit permanence remains unclassified');
    assert.deepEqual(legacy.entries.get('workflow/provider-evidence/' + providerId + '/' + event.eventId).data, event);
  }
});
