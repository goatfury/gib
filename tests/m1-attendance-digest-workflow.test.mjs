import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttendanceDigest, defaultDigestConfiguration, datesThrough, digestHash } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { makeDigestBinding } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, workflowMessages, workflowHealth, recordWorkflowDeliveryEvidence, latestEligibleOpportunity } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';

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

test('scheduled controls reach only TEST MailApp after sender, recipients and cutoff are verified', async () => {
  const h = harness(); delete h.deps.simulatedProvider;
  const input = h.input(); input.digest.syntheticRehearsal = true;
  const sender = 'revbjjops@gmail.com';
  h.deps.env = { GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_ATTENDANCE_DIGEST_VERIFIED_SENDER: sender,
    GIB_M1_ATTENDANCE_DIGEST_VERIFIED_RECIPIENTS: 'stu@example.invalid', GIB_M1_DIGEST_TEST_RESEND_API_KEY: 'synthetic-provider-key' };
  h.deps.mailappRuntime = { target: 'test', preview: true, webhookUrl: 'https://script.google.com/macros/s/synthetic-test/exec', webhookToken: 'synthetic-receiver', adminActionToken: 'synthetic-admin' };
  const requests = [];
  h.deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, init, body });
    if (body.action === 'attendanceMailSend') assert.ok([...h.entries.keys()].some(key => key.includes('/delivery/mailapp/messages/')));
    const sent = body.action === 'attendanceMailSend';
    return new Response(JSON.stringify({ ok: true, target: 'test', gym: 'rev', messageId: body.message.messageId, hash: body.message.hash,
      state: sent ? 'submitted' : 'not-attempted', code: sent ? 'MAILAPP_SUBMITTED' : 'MAILAPP_READY',
      attemptedAt: sent ? new Date(NOW).toISOString() : null, completedAt: sent ? new Date(NOW).toISOString() : null, retrySafe: !sent }), { status: 200 });
  };
  await processAttendanceWorkflow(input, h.deps);
  assert.deepEqual(requests.map(request => request.body.action), ['attendanceMailStatus', 'attendanceMailSend']);
  assert.ok(requests.every(request => request.url === h.deps.mailappRuntime.webhookUrl));
  assert.deepEqual(requests[1].body.message.to, ['stu@example.invalid']);
  assert.equal((await h.messages())[0].state, 'submitted', 'a completed Google call is not delivery evidence');
  assert.equal((await h.messages())[0].delivery.deliveryConfirmed, false);
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

test('a new eligible opportunity retires older uncertainty without changing its original identity, body or retry window', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(structuredClone(message)); throw new Error('synthetic lost reply'); };
  await h.run();
  const original = structuredClone(h.entries.get('workflow/delivery/messages/m1-test-scheduled-rev-' + DATE).data);
  h.at(NOW + 24 * 60 * 60000); await h.run();
  let draft = (await h.messages()).find(value => value.date === '2026-09-25');
  assert.equal(draft.firstAttemptAt, NOW + 24 * 60 * 60000);
  assert.equal(h.calls.length, 2); assert.ok(draft.message.text.includes('SYNTHETIC class'));
  assert.equal(h.entries.has('workflow/delivery/messages/' + draft.messageId), true);
  h.at(NOW + 48 * 60 * 60000); h.deps.simulatedProvider.identity = 'changed-provider';
  const changed = h.input(); changed.configuration.routing.rev.reviewer.address = 'repaired@example.invalid';
  await processAttendanceWorkflow(changed, h.deps);
  draft = (await h.messages()).find(value => value.date === '2026-09-26');
  assert.equal(h.calls.length, 3); assert.equal(draft.assessmentDate, '2026-09-26');
  assert.deepEqual(h.entries.get('workflow/delivery/messages/m1-test-scheduled-rev-' + DATE).data, original);
  assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
  assert.equal((await h.health()).historicalUnconfirmedCount, 2);
  const old = (await h.messages()).find(value => value.date === DATE);
  assert.equal(old.automaticRetriesRetired, true); assert.equal(old.nextAttemptAt, null);
});

test('an active original provider claim across midnight defers a new day without creating another identity', async () => {
  const h = harness(), start = Date.parse('2026-09-25T03:59:30Z'), set = h.store.set;
  h.at(start);
  h.store.set = async (key, ...args) => { if (key.startsWith('workflow/delivery/attempts/')) throw new Error('synthetic receipt storage failure'); return set(key, ...args); };
  await h.run(); assert.equal(h.calls.length, 1);
  h.at(start + 31000); await h.run();
  assert.equal((await h.messages()).length, 1);
  assert.equal(h.entries.get('workflow/opportunities/rev').data.opportunityDate, DATE);
  assert.equal(h.calls.length, 1); assert.equal(h.entries.has('workflow/delivery/messages/m1-test-scheduled-rev-2026-09-25'), false);
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

test('authoritative uncertainty can take over despite stale workflow summaries, but unreadable history still blocks only its gym', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(structuredClone(message)); if (message.messageId.includes('-rev-')) throw new Error('synthetic lost reply'); return new Response(JSON.stringify({ id: providerId }), { status: 200 }); };
  await h.run('issue', true);
  const old = h.entries.get('workflow/messages/m1-test-scheduled-rev-' + DATE);
  old.data.delivery = { state: 'accepted', providerId }; old.data.state = 'delivered';
  h.at(NOW + 24 * 60 * 60000); await h.run('issue', true);
  assert.equal(h.calls.filter(message => message.messageId.includes('-rev-')).length, 2);
  assert.equal(h.calls.filter(message => message.messageId.includes('-richmond-')).length, 2);
  const read = h.store.getWithMetadata;
  h.store.getWithMetadata = async key => { if (key === 'workflow/delivery/messages/m1-test-scheduled-rev-' + DATE) throw new Error('synthetic unavailable'); return read(key); };
  h.at(NOW + 48 * 60 * 60000); await h.run();
  assert.equal(h.calls.filter(message => message.messageId.includes('-rev-')).length, 2);
  assert.equal((await h.messages()).find(value => value.date === '2026-09-26').code, 'PRIOR_ACCEPTANCE_UNCONFIRMED');
  assert.ok((await h.health()).codes.includes('CHECK_INCOMPLETE'));
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

test('an archived expired claim with no authoritative provider attempt safely recovers outside the recent-message window', async () => {
  for (const mode of ['issue', 'clean']) {
    const h = harness(), originalId = 'm1-test-scheduled-rev-' + DATE, ids = [];
    const original = { schema: 'm1-digest-workflow/v1', messageId: originalId, gym: 'rev', date: DATE, checkAt: NOW,
      firstAttemptAt: NOW, claimUntil: NOW + 60000, state: 'unconfirmed', code: 'ATTEMPT_CLAIMED', message: null,
      attemptCount: 0, nextAttemptAt: null, retryBefore: null, delivery: null };
    const setup = harness(); await setup.run(); original.message = (await setup.messages())[0].message;
    for (let index = 0; index < 14; index++) {
      const date = new Date(Date.parse(DATE + 'T12:00:00Z') + index * 86400000).toISOString().slice(0, 10), messageId = 'm1-test-scheduled-rev-' + date;
      const record = index === 0 ? original : { ...original, messageId, date, firstAttemptAt: null, claimUntil: null, state: 'suppressed', code: 'NO_OUTSTANDING_ITEMS', message: null };
      await h.store.set('workflow/messages/' + messageId, JSON.stringify(record), { onlyIfNew: true }); ids.push(messageId);
    }
    await h.store.set('workflow/index', JSON.stringify({ ids }), { onlyIfNew: true });
    h.at(NOW + 15 * 86400000); await h.run(mode);
    const retained = h.entries.get('workflow/messages/' + originalId).data;
    assert.equal(retained.messageId, originalId); assert.equal(retained.firstAttemptAt, null);
    assert.equal(h.entries.has('workflow/delivery/messages/' + originalId), false);
    assert.equal(h.calls.length, mode === 'issue' ? 1 : 0);
    if (mode === 'issue') assert.notEqual(h.calls[0].messageId, originalId, 'only a fresh necessary daily draft starts');
    assert.deepEqual(h.entries.get('workflow/index').data.ids, ids);
  }
});

test('a clean takeover is durable, closes its opportunity, and separates historical uncertainty from current status', async () => {
  const h = harness(); h.at(Date.parse('2026-09-26T01:50:00Z'));
  h.deps.simulatedProvider.send = async message => { h.calls.push(message); throw new Error('synthetic lost reply'); };
  await h.run(); const original = structuredClone((await h.messages())[0]);
  h.at(Date.parse('2026-09-26T02:05:00Z')); await h.run('clean');
  const health = await h.health(); assert.equal(health.state, 'clear'); assert.equal(health.unconfirmedCount, 0);
  assert.equal(health.historicalUnconfirmedCount, 1); assert.equal(health.opportunityDate, '2026-09-25');
  h.at(Date.parse('2026-09-26T02:21:00Z')); await h.run('issue');
  assert.equal(h.calls.length, 1); assert.equal(h.entries.get('workflow/opportunities/rev').data.decision, 'clean');
  const old = (await h.messages()).find(value => value.date === DATE);
  assert.equal(old.automaticRetriesRetired, true); assert.equal(old.nextAttemptAt, null);
  assert.deepEqual(old.message, original.message); assert.equal(old.retryBefore, original.retryBefore);
});

test('latest opportunity uses local cutoff across DST, independent gym times, and skips missed dates', async () => {
  const h = harness(), config = h.input().configuration;
  for (const [iso, date] of [['2026-03-08T06:30:00Z', '2026-03-07'], ['2026-03-09T01:59:00Z', '2026-03-07'],
    ['2026-03-09T02:00:00Z', '2026-03-08'], ['2026-11-01T05:30:00Z', '2026-10-31'], ['2026-11-01T06:30:00Z', '2026-10-31'],
    ['2026-11-02T03:00:00Z', '2026-11-01']]) assert.equal(latestEligibleOpportunity(config, Date.parse(iso), 'rev').date, date);
  h.at(Date.parse('2026-09-26T01:00:00Z')); const input = h.input('issue', true);
  input.configuration.gyms[0].dailyLocalTime = '20:00'; input.configuration.gyms[1].dailyLocalTime = '23:00';
  input.due = 'not-due'; input.dueByGym = { rev: 'due', richmond: 'not-due' }; input.opportunityDueByGym = { rev: 'due', richmond: 'due' };
  await processAttendanceWorkflow(input, h.deps);
  assert.deepEqual(h.calls.map(value => value.messageId), ['m1-test-scheduled-rev-2026-09-25', 'm1-test-scheduled-richmond-2026-09-24']);
  const missed = harness(); missed.at(NOW + 6 * 86400000); await missed.run();
  assert.equal(missed.calls.length, 1); assert.equal((await missed.messages()).length, 1); assert.equal(missed.calls[0].messageId, 'm1-test-scheduled-rev-2026-09-30');
  assert.match(missed.calls[0].text, /Fresh assessment: 2026-10-01T02:30:00.000Z \(2026-09-30/);
});

test('actual upcoming guard holds takeover and an interrupted head can resume without a second identity', async () => {
  const h = harness(); await h.run(); h.at(NOW + 86400000);
  let input = h.input(); input.due = 'not-due'; input.opportunityDueByGym = { rev: 'not-due' };
  await processAttendanceWorkflow(input, h.deps); assert.equal(h.calls.length, 1);
  assert.equal(h.entries.get('workflow/opportunities/rev').data.opportunityDate, DATE);
  const set = h.store.set; let fail = true;
  h.store.set = async (key, raw, options) => { const result = await set(key, raw, options); if (fail && key === 'workflow/opportunities/rev') { fail = false; throw new Error('interrupted persisted takeover'); } return result; };
  await assert.rejects(() => h.run('clean'), /interrupted/);
  assert.ok((await h.health()).codes.includes('CHECK_INCOMPLETE'));
  await h.run('clean'); await h.run(); assert.equal(h.calls.length, 1);
  assert.equal(h.entries.get('workflow/opportunities/rev').data.decision, 'clean');
});

test('mixed unknown and known permanent rejection retains the unchanged broken-route hold', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(message); if (h.calls.length === 1) throw new Error('lost reply'); return new Response('{}', { status: 403 }); };
  await h.run(); h.at(NOW + 16 * 60000); await h.run(); assert.equal(h.calls.length, 2);
  h.at(NOW + 86400000); await h.run(); assert.equal(h.calls.length, 2);
  assert.equal((await h.messages()).find(value => value.date === '2026-09-25').code, 'PRIOR_PERMANENT_REJECTION_UNCHANGED');
  assert.ok((await h.health()).codes.includes('DELIVERY_FAILED'));
});

test('retired temporary failures remain historical while active permanent failures remain operating warnings', async () => {
  for (const status of [429, 403]) {
    const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(message); return new Response('{}', { status }); };
    await h.run(); h.at(NOW + 86400000); await h.run('clean');
    const health = await h.health(); assert.equal(health.historicalFailedCount, 1);
    assert.equal(health.failedCount, status === 403 ? 1 : 0);
    assert.equal(health.codes.includes('DELIVERY_FAILED'), status === 403);
  }
});

test('an archived unknown late Permanent event holds its exact recipient without guessing a current message identity', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(message); throw new Error('lost reply'); };
  await h.run(); const original = structuredClone((await h.messages())[0]);
  for (let day = 1; day <= 10; day++) { h.at(NOW + day * 86400000); await h.run('clean'); }
  const result = await recordWorkflowDeliveryEvidence(evidence(original.message, { eventId: 'late_unbound_permanent', type: 'email.bounced', permanentFailure: true }), { ...h.deps, deliveryEvidenceVerified: true });
  assert.deepEqual(result, { ok: true, matched: false, state: 'pending' });
  const retained = h.entries.get('workflow/messages/' + original.messageId).data;
  assert.equal(retained.state, 'unconfirmed'); assert.equal(retained.delivery.state, 'unknown');
  h.at(NOW + 11 * 86400000); await h.run(); assert.equal(h.calls.length, 1);
  const current = (await h.messages()).find(value => value.date === '2026-10-05');
  assert.equal(current.code, 'PRIOR_PERMANENT_RECIPIENT_PROOF_UNRESOLVED'); assert.equal(current.firstAttemptAt, null);
  assert.ok((await h.health()).codes.includes('DELIVERY_FAILED'));
});

test('a fully drained unbound Permanent callback invalidates first-send clearance before a new claim', async () => {
  const h = harness(); h.deps.simulatedProvider.send = async message => { h.calls.push(message); throw new Error('lost reply'); };
  await h.run(); const original = (await h.messages())[0].message, set = h.store.set;
  let injected = false;
  h.store.set = async (key, raw, options) => {
    const value = JSON.parse(raw);
    if (!injected && key.startsWith('workflow/history/intents/') && value.source?.value.firstAttemptAt && value.messageId === 'm1-test-scheduled-rev-2026-09-25') {
      injected = true;
      await recordWorkflowDeliveryEvidence(evidence(original, { eventId: 'between_guard_claim', type: 'email.bounced', permanentFailure: true }), { ...h.deps, deliveryEvidenceVerified: true });
    }
    return set(key, raw, options);
  };
  h.at(NOW + 86400000); await h.run(); assert.equal(injected, true); assert.equal(h.calls.length, 1);
  assert.equal((await h.messages()).find(value => value.date === '2026-09-25').firstAttemptAt, null);
  assert.ok((await h.health()).codes.includes('DELIVERY_FAILED'));
});

test('exact later accepted delivery resolves a provisional recipient hold in read-only health, retaining both events', async () => {
  const h = harness();
  h.deps.simulatedProvider.send = async message => {
    h.calls.push(message);
    await recordWorkflowDeliveryEvidence(evidence(message, { eventId: 'early_permanent', type: 'email.bounced', permanentFailure: true }), { ...h.deps, deliveryEvidenceVerified: true });
    return new Response(JSON.stringify({ id: providerId }), { status: 200 });
  };
  await h.run(); assert.ok((await h.health()).codes.includes('DELIVERY_FAILED'));
  h.at(NOW + 1000); const message = (await h.messages())[0].message;
  await recordWorkflowDeliveryEvidence(evidence(message, { eventId: 'later_exact_delivery', occurredAt: new Date(NOW + 1000).toISOString() }), { ...h.deps, deliveryEvidenceVerified: true });
  assert.equal((await h.health()).codes.includes('DELIVERY_FAILED'), false);
  assert.equal(h.entries.has('workflow/provider-evidence/' + providerId + '/early_permanent'), true);
  assert.equal(h.entries.has('workflow/provider-evidence/' + providerId + '/later_exact_delivery'), true);
  assert.equal(h.calls.length, 1);
});
