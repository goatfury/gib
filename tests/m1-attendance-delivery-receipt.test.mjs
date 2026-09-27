import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { handleAttendanceDeliveryReceipt, verifyResendReceipt } from '../netlify/functions/m1-attendance-delivery-receipt.mjs';
import { buildAttendanceDigest, defaultDigestConfiguration, DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { makeDigestBinding } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, workflowHealth, workflowMessages } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';

const now = Date.parse('2026-09-27T15:00:00.000Z'), timestamp = String(now / 1000);
const secret = 'whsec_' + Buffer.from('synthetic-public-unit-test-key-only').toString('base64');
const eventId = 'msg_synthetic_0001', providerId = '56761188-7520-42d8-8898-ff6fc54ce618';
const path = '/api/m1-attendance-delivery-receipt';
const sender = 'GIB Revolution TEST <digest@example.test>', recipient = 'stu@example.test';
const payload = (type = 'email.delivered') => ({ type, created_at: '2026-09-27T14:59:59.126Z', data: {
  email_id: providerId, created_at: '2026-09-27T14:59:58.000Z', from: sender, to: [recipient],
  subject: 'Synthetic private subject — café 中文 🥋', message_id: '<synthetic@example.test>', tags: { ignored: 'private' }
} });
const sign = (raw, id = eventId, time = timestamp, key = secret) => 'v1,' + createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
  .update(id + '.' + time + '.', 'utf8').update(raw).digest('base64');
function request(options = {}) {
  const raw = options.raw ?? Buffer.from(JSON.stringify(options.value ?? payload())), id = options.id ?? eventId, time = options.timestamp ?? timestamp;
  return new Request((options.origin || DIGEST_ORIGIN) + (options.path || path) + (options.query || ''), {
    method: options.method || 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': time,
      'svix-signature': options.signature ?? sign(raw, id, time), ...options.headers },
    ...((options.method || 'POST') === 'GET' ? {} : { body: raw })
  });
}
function harness(options = {}) {
  const evidence = [];
  const deps = { enabled: true, target: 'test', clock: () => now,
    env: { GIB_M1_WORKFLOW_TEST_RECEIPTS_ENABLED: 'true', GIB_M1_WORKFLOW_TEST_RESEND_WEBHOOK_SECRET: secret },
    context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } },
    async recordEvidence(event, dependencies) {
      assert.equal(dependencies.deliveryEvidenceVerified, true); assert.equal(dependencies.scope.target, 'test');
      assert.equal(dependencies.scope.profile.installationId, 'rev'); evidence.push(structuredClone(event)); return { ok: true, matched: true, state: 'delivered' };
    }, ...options };
  return { deps, evidence, call: options => handleAttendanceDeliveryReceipt(request(options), deps) };
}

test('manual Svix verification matches the independent published public vector', () => {
  // https://docs.svix.com/receiving/verifying-payloads/how-manual#example-signatures
  const raw = Buffer.from('{"event_type":"ping","data":{"success":true}}');
  const headers = new Headers({ 'svix-id': 'msg_loFOjxBNrRLzqYUf', 'svix-timestamp': '1731705121',
    'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=' });
  assert.equal(verifyResendReceipt(raw, headers, 'whsec_plJ3nmyCDGBKInavdOK15jsl', 1731705121000), 'msg_loFOjxBNrRLzqYUf');
});

test('receipt endpoint is disabled unless its separate TEST switch and valid signing key are both configured', async () => {
  for (const env of [{}, { GIB_M1_WORKFLOW_TEST_RECEIPTS_ENABLED: 'true' }, { GIB_M1_WORKFLOW_TEST_RESEND_WEBHOOK_SECRET: secret },
    { GIB_M1_WORKFLOW_TEST_RECEIPTS_ENABLED: 'false', GIB_M1_WORKFLOW_TEST_RESEND_WEBHOOK_SECRET: secret },
    { GIB_M1_WORKFLOW_TEST_RECEIPTS_ENABLED: 'true', GIB_M1_WORKFLOW_TEST_RESEND_WEBHOOK_SECRET: 'malformed-private-key' }]) {
    const h = harness({ env }), response = await h.call(); assert.equal(response.status, 404); assert.equal(h.evidence.length, 0);
    assert.doesNotMatch(await response.text(), /private-key|whsec_/);
  }
});

test('only exact unpublished canonical Revolution TEST route and trusted site can accept delivery evidence', async () => {
  for (const origin of ['https://gib-live.netlify.app', 'https://gib-richmond-test.netlify.app', 'https://deploy-preview-90--gib-live.netlify.app']) {
    const h = harness(); assert.equal((await h.call({ origin })).status, 403); assert.equal(h.evidence.length, 0);
  }
  for (const patch of [{ enabled: false }, { target: 'production' }, { context: { site: { name: 'gib-live', id: 'wrong' }, deploy: { context: 'deploy-preview', published: false } } },
    { context: { site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' }, deploy: { context: 'production', published: true } } }]) {
    const h = harness(patch); assert.equal((await h.call()).status, 403); assert.equal(h.evidence.length, 0);
  }
  for (const option of [{ method: 'GET' }, { query: '?test=true' }, { path: '/.netlify/functions/m1-attendance-delivery-receipt' }]) {
    const h = harness(); assert.equal((await h.call(option)).status, 404); assert.equal(h.evidence.length, 0);
  }
});

test('signed exact raw bytes yield only minimum delivery evidence with server-owned verification and scope', async () => {
  const h = harness(); const response = await h.call();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(h.evidence, [{ eventId, providerId, type: 'email.delivered', occurredAt: '2026-09-27T14:59:59.126Z', from: sender, to: [recipient] }]);
  assert.doesNotMatch(JSON.stringify(h.evidence), /subject|message_id|tags|private|whsec_|signature/);
  const value = payload(); value.deliveryEvidenceVerified = false; value.scope = { target: 'production', gym: 'richmond' };
  assert.equal((await h.call({ value })).status, 200); assert.deepEqual(h.evidence[1], h.evidence[0]);
});

test('altered body, ID, timestamp, malformed signatures and wrong signing keys fail before any evidence persistence', async () => {
  const raw = Buffer.from(JSON.stringify(payload())), signature = sign(raw);
  const wrongKey = 'whsec_' + Buffer.from('different-synthetic-public-unit-key').toString('base64');
  for (const options of [{ raw: Buffer.concat([raw, Buffer.from(' ')]), signature }, { id: 'msg_different', signature },
    { timestamp: String(Number(timestamp) + 1), signature }, { signature: sign(raw, eventId, timestamp, wrongKey) },
    { signature: 'v1,aA==' }, { signature: 'v2,' + signature.slice(3) }, { signature: '' },
    { headers: { 'svix-id': '../private', 'svix-timestamp': timestamp } }, { headers: { 'svix-timestamp': timestamp + ', ' + timestamp } }]) {
    const h = harness(); assert.equal((await h.call(options)).status, 403); assert.equal(h.evidence.length, 0);
  }
});

test('rotation accepts any matching v1 signature and rejects replays more than five minutes past or future', async () => {
  const raw = Buffer.from(JSON.stringify(payload())), valid = sign(raw), bogus = 'v1,' + Buffer.alloc(32).toString('base64');
  const h = harness(); assert.equal((await h.call({ raw, signature: `v2,ignored ${bogus} ${valid}` })).status, 200);
  for (const offset of [-301, 301]) {
    const blocked = harness(); assert.equal((await blocked.call({ timestamp: String(Number(timestamp) + offset) })).status, 403); assert.equal(blocked.evidence.length, 0);
  }
  for (const offset of [-300, 300]) assert.equal((await harness().call({ timestamp: String(Number(timestamp) + offset) })).status, 200);
});

test('opened, clicked, accepted-send and unrelated signed events are ignored without storage or delivery confirmation', async () => {
  for (const type of ['email.opened', 'email.clicked', 'email.sent', 'email.delivery_delayed', 'email.received', 'contact.created']) {
    const h = harness(), response = await h.call({ value: payload(type) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, ignored: true }); assert.equal(h.evidence.length, 0);
  }
});

test('bounced and failed evidence is forwarded as explicit negative outcomes without storing provider explanations', async () => {
  for (const type of ['email.bounced', 'email.failed']) {
    const h = harness(), value = payload(type); value.data.failed = { reason: 'private reason' }; value.data.bounce = { message: 'private bounce detail' };
    assert.equal((await h.call({ value })).status, 200); assert.equal(h.evidence[0].type, type);
    assert.doesNotMatch(JSON.stringify(h.evidence), /private|reason|"bounce"/);
  }
});

test('malformed signed delivery identities, recipients and timestamps remain rejected without a false confirmation', async () => {
  for (const change of [value => { value.data.email_id = 'bad-id'; }, value => { value.data.from = 'sender\r\nInjected'; },
    value => { value.data.to = []; }, value => { value.data.to = [recipient, recipient]; }, value => { value.data.to = ['not an address']; },
    value => { value.created_at = '2026-09-27T15:05:01.000Z'; }, value => { value.created_at = '2026-02-31T14:59:59Z'; },
    value => { value.created_at = 'yesterday'; }, value => { delete value.data; }]) {
    const value = payload(); change(value); const h = harness(); assert.equal((await h.call({ value })).status, 400); assert.equal(h.evidence.length, 0);
  }
  for (const raw of [Buffer.from('{'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])]) {
    const h = harness(); assert.equal((await h.call({ raw })).status, 400); assert.equal(h.evidence.length, 0);
  }
});

test('envelope and byte limits apply before storage and unsupported compression is rejected', async () => {
  for (const options of [{ headers: { 'Content-Type': 'text/plain' } }, { headers: { 'Content-Length': '999999' } },
    { headers: { 'Content-Length': '1' } }, { headers: { 'Content-Encoding': 'gzip' } },
    { raw: Buffer.from('界'.repeat(23000)) }, { raw: Buffer.alloc(0) }]) {
    const h = harness(); assert.equal((await h.call(options)).status, 400); assert.equal(h.evidence.length, 0);
  }
});

test('success waits for confirmed core persistence and conflicts or storage failures never acknowledge success', async () => {
  let release, entered = false;
  const h = harness({ recordEvidence: async () => { entered = true; await new Promise(resolve => { release = resolve; }); return { ok: true }; } });
  let completed = false; const pending = h.call().then(response => { completed = true; return response; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, true); assert.equal(completed, false);
  release(); assert.equal((await pending).status, 200);
  for (const status of [409, 503]) {
    const failed = harness({ recordEvidence: async () => { throw Object.assign(new Error('private provider or storage detail'), { status, code: 'private-category' }); } });
    const response = await failed.call(); assert.equal(response.status, status); assert.deepEqual(await response.json(), { ok: false, code: 'DELIVERY_EVIDENCE_UNAVAILABLE' });
  }
  assert.equal((await harness({ recordEvidence: async () => ({ ok: false }) }).call()).status, 503);
});

function memoryStore() {
  const entries = new Map(); let serial = 0;
  return { entries, async getWithMetadata(key) { return entries.has(key) ? structuredClone(entries.get(key)) : null; },
    async set(key, raw, options = {}) {
      const prior = entries.get(key);
      if ((options.onlyIfNew && prior) || (options.onlyIfMatch && prior?.etag !== options.onlyIfMatch)) return { modified: false };
      entries.set(key, { data: JSON.parse(raw), etag: String(++serial) }); return { modified: true };
    } };
}
function workflowFixture() {
  const store = memoryStore(), scope = { target: 'test', syntheticRehearsal: true, profile: { installationId: 'rev', gymName: 'Revolution TEST' } };
  let time = now, sends = 0, beforeAcceptance = null;
  const h = harness({ workflowStore: store, clock: () => time }); delete h.deps.recordEvidence;
  h.deps.env = { ...h.deps.env, GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: recipient, GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW: 'false',
    GIB_M1_ATTENDANCE_DIGEST_FROM: sender, GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true', GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME: '10:00' };
  h.deps.simulatedProvider = { identity: 'receipt-test-simulator', async send() {
    sends++; if (beforeAcceptance) await beforeAcceptance(); return new Response(JSON.stringify({ id: providerId }), { status: 200 });
  } };
  const configuration = defaultDigestConfiguration(scope, h.deps.env), jobDate = '2026-09-27', dates = datesThrough(jobDate);
  const snapshots = [{ gym: 'rev', attendance: { ok: true, ledger: { ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true,
    gym: 'rev', from: dates[0], to: jobDate, days: dates.map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) } },
    staff: { ok: true, complete: true, items: [] } }];
  const schedules = [{ gym: 'rev', timezone: 'America/New_York', days: dates.map(date => ({ date, status: 'complete', observedAt: date + 'T12:00:00.000Z', sourceVersion: 'synthetic-receipt-test',
    occurrences: date === jobDate ? [{ label: '9:00 AM SYNTHETIC class', startAt: date + 'T13:00:00.000Z', endAt: date + 'T14:00:00.000Z', cancelled: false }] : [] })) }];
  const digest = buildAttendanceDigest({ jobDate, snapshots, schedules, configuration, now });
  const input = { binding: makeDigestBinding('00000000-0000-4000-8000-000000000099', 'scheduled', now), digest, configuration, due: 'due' };
  return { ...h, store, scope, sends: () => sends, advance: ms => { time = now + ms; }, beforeAccept: callback => { beforeAcceptance = callback; },
    run: () => processAttendanceWorkflow(input, { ...h.deps, scope }),
    message: async () => (await workflowMessages(scope, h.deps)).messages[0], health: () => workflowHealth(scope, h.deps),
    event(type, id, elapsed, patch = {}) { const value = payload(type); value.created_at = new Date(now + elapsed).toISOString(); Object.assign(value.data, patch); return h.call({ value, id }); }
  };
}

test('actual workflow acceptance stays unconfirmed until signed matching delivered evidence; identical retries preserve one receipt and message', async () => {
  const h = workflowFixture(); await h.run(); assert.equal(h.sends(), 1);
  assert.equal((await h.message()).state, 'unconfirmed'); assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
  const original = structuredClone((await h.message()).message); h.advance(2000);
  assert.equal((await h.event('email.delivered', 'msg_delivery_confirmed', 1000)).status, 200);
  assert.equal((await h.message()).state, 'delivered'); assert.equal((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'), false);
  const retained = JSON.stringify([...h.store.entries.entries()]);
  const repeated = payload(); repeated.created_at = new Date(now + 1000).toISOString();
  assert.equal((await h.call({ value: repeated, id: 'msg_delivery_confirmed', timestamp: String(Number(timestamp) + 2) })).status, 200,
    'a new signed attempt timestamp still identifies the same original provider event');
  assert.equal([...h.store.entries.keys()].filter(key => key.endsWith('/msg_delivery_confirmed')).length, 1);
  assert.deepEqual((await h.message()).message, original); assert.equal(h.sends(), 1);
  assert.ok(retained.includes('msg_delivery_confirmed')); assert.equal((await h.health()).state, 'attention', 'attendance still needs attention after delivery');
});

test('signed mismatched sender, recipient and unrelated provider evidence never clears the original warning', async () => {
  const h = workflowFixture(); await h.run(); h.advance(2000);
  for (const [id, patch] of [['msg_wrong_sender', { from: 'Wrong <other@example.test>' }], ['msg_wrong_to', { to: ['trey@example.test'] }],
    ['msg_wrong_provider', { email_id: '00000000-0000-4000-8000-000000000888' }]]) {
    await h.event('email.delivered', id, 1000, patch);
    assert.equal((await h.message()).state, 'unconfirmed'); assert.ok((await h.health()).codes.includes('DELIVERY_UNCONFIRMED'));
  }
  assert.equal(h.sends(), 1);
});

test('actual workflow retains negative evidence and ignores older out-of-order events without losing audit history', async () => {
  const h = workflowFixture(); await h.run(); h.advance(10000);
  assert.equal((await h.event('email.delivered', 'msg_latest_delivery', 3000)).status, 200);
  assert.equal((await h.event('email.bounced', 'msg_older_bounce', 2000)).status, 200);
  assert.equal((await h.message()).state, 'delivered');
  assert.equal((await h.event('email.failed', 'msg_newer_failure', 4000)).status, 200);
  assert.equal((await h.message()).state, 'failed'); assert.ok((await h.health()).codes.includes('DELIVERY_FAILED'));
  assert.equal((await h.event('email.delivered', 'msg_old_delivery', 2500)).status, 200);
  assert.equal((await h.message()).state, 'failed');
  assert.equal((await h.event('email.delivered', 'msg_new_delivery', 5000)).status, 200);
  assert.equal((await h.message()).state, 'delivered');
  for (const id of ['msg_latest_delivery', 'msg_older_bounce', 'msg_newer_failure', 'msg_old_delivery', 'msg_new_delivery'])
    assert.equal([...h.store.entries.keys()].filter(key => key.endsWith('/' + id)).length, 1);
  assert.equal(h.sends(), 1);
});

test('signed receipt arriving before provider acceptance is retained, then matched without another provider send', async () => {
  const h = workflowFixture();
  h.beforeAccept(async () => {
    assert.equal((await h.message()).state, 'unconfirmed', 'original message is durably claimed before provider dispatch');
    assert.equal((await h.event('email.delivered', 'msg_before_acceptance', 0)).status, 200);
    assert.equal((await h.message()).state, 'unconfirmed', 'pending event cannot guess provider acceptance');
  });
  await h.run();
  assert.equal((await h.message()).state, 'delivered'); assert.equal(h.sends(), 1);
});

test('signed unrelated evidence without an original in-flight message is ignored without storing account email data', async () => {
  const h = workflowFixture(); assert.equal((await h.event('email.delivered', 'msg_no_original', 0)).status, 200);
  assert.equal(h.store.entries.size, 0);
  await h.run(); assert.equal((await h.message()).state, 'unconfirmed', 'previously unrelated evidence cannot clear a later original');
});

test('same signed event ID with conflicting content cannot replace its immutable stored receipt', async () => {
  const h = workflowFixture(); await h.run(); h.advance(2000);
  assert.equal((await h.event('email.delivered', 'msg_original_immutable', 1000)).status, 200);
  const key = [...h.store.entries.keys()].find(key => key.endsWith('/msg_original_immutable')), original = structuredClone(h.store.entries.get(key));
  const conflict = await h.event('email.failed', 'msg_original_immutable', 1000);
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { ok: false, code: 'DELIVERY_EVIDENCE_CONFLICT' });
  assert.deepEqual(h.store.entries.get(key), original); assert.equal((await h.message()).state, 'delivered');
});

test('concurrent conflicting signed retries cannot both claim the same immutable event ID', async () => {
  const h = workflowFixture(); await h.run(); h.advance(2000);
  const results = await Promise.all([h.event('email.delivered', 'msg_concurrent_conflict', 1000), h.event('email.failed', 'msg_concurrent_conflict', 1000)]);
  assert.equal(results.filter(response => response.status === 200).length, 1);
  assert.equal(results.filter(response => response.status === 409).length, 1);
  assert.equal([...h.store.entries.keys()].filter(key => key.endsWith('/msg_concurrent_conflict')).length, 1);
});
