import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestDigestEmail } from '../netlify/functions/_lib/m1-attendance-digest-email-proposal.mjs';
import { deliverTestDigestEmail, readTestDigestEmailDelivery, hashTestDigestEmail } from '../netlify/functions/_lib/m1-attendance-digest-email-delivery.mjs';

const START = Date.parse('2026-09-26T20:00:00Z');
const ID = 'm1-test-email-andrew-20260926-v1';
const providerId = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const uuid = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const clone = value => structuredClone(value);
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
const json = (body = { id: providerId }, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function harness() {
  let now = START, version = 0, sequence = 0;
  const message = buildTestDigestEmail('reader@example.com'), entries = new Map(), reads = [], writes = [], calls = [];
  const store = {
    async getWithMetadata(key, options) { assert.equal(options.consistency, 'strong'); assert.equal(options.type, 'json'); reads.push(key); return clone(entries.get(key) || null); },
    async set(key, raw, options) {
      const previous = entries.get(key);
      assert.ok(options.onlyIfNew === true || typeof options.onlyIfMatch === 'string', 'every write is conditional');
      writes.push({ key, raw, options: clone(options) });
      if (options.onlyIfNew && previous || options.onlyIfMatch && previous?.etag !== options.onlyIfMatch) return { modified: false };
      const etag = 'v' + ++version; entries.set(key, { etag, data: JSON.parse(raw) }); return { modified: true, etag };
    }
  };
  const env = { GIB_M1_DIGEST_TEST_SEND_ENABLED: 'true', GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_ID: ID,
    GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_HASH: message.hash, GIB_M1_DIGEST_TEST_APPROVED_RECIPIENT: message.to[0],
    GIB_M1_DIGEST_TEST_RESEND_API_KEY: 'synthetic-test-key-never-real' };
  const deps = { scope: { target: 'test', profile: { installationId: 'rev' } }, env, now: () => now, uuid: () => uuid(++sequence), deliveryStore: store,
    fetch: async (url, options) => { calls.push({ url, options }); return json(); } };
  return { message, entries, reads, writes, calls, env, deps, store, at(value) { now = value; },
    send(value = message) { return deliverTestDigestEmail(value, deps); }, read(value = message) { return readTestDigestEmailDelivery(value, deps); },
    provider(fn) { deps.fetch = async (url, options) => { calls.push({ url, options }); return fn(url, options); }; }
  };
}

test('the transport hashes exactly the immutable builder proposal and never defaults to sending', async () => {
  const h = harness(); assert.equal(hashTestDigestEmail(h.message), h.message.hash);
  assert.equal(h.message.hash, '38ec067137d5af9b29e763a5be488fcc59fa22cc2ebd8da06dc59f01b7a3d9df');
  for (const value of [undefined, '', false, true, 'false']) {
    h.env.GIB_M1_DIGEST_TEST_SEND_ENABLED = value;
    const result = await h.send(); assert.equal(result.state, 'disabled'); assert.equal(result.deliveryConfirmed, false);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.reads.length, 0);
  assert.equal((await h.read()).state, 'not-started'); assert.equal(h.writes.length, 0);
});

test('wrong gym, production, missing exact approval and absent credentials cause no storage or provider writes', async () => {
  const changes = [h => { h.deps.scope.target = 'production'; }, h => { h.deps.scope.profile.installationId = 'richmond'; },
    h => { h.deps.scope = null; }, h => { delete h.env.GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_ID; },
    h => { h.env.GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_HASH = '0'.repeat(64); },
    h => { h.env.GIB_M1_DIGEST_TEST_APPROVED_RECIPIENT = 'other@example.com'; }, h => { delete h.env.GIB_M1_DIGEST_TEST_RESEND_API_KEY; }];
  for (const change of changes) {
    const h = harness(); change(h); assert.ok(['disabled', 'blocked'].includes((await h.send()).state));
    assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.reads.length, 0);
  }
});

test('historical captures, multiple recipients, changed sender/body/hash and extra payload fields are ineligible', async () => {
  const changes = [{ messageId: 'm1-test-rehearsal-old-capture' }, { synthetic: false }, { target: 'production' }, { to: ['reader@example.com', 'other@example.com'] },
    { from: 'Other <onboarding@resend.dev>' }, { subject: 'Changed without new hash' }, { hash: '0'.repeat(64) }, { extra: 'not allowed' }, { html: '' }, { to: ['reader@example.com\r\nBcc:other@example.com'] }];
  for (const change of changes) {
    const h = harness(); const result = await h.send({ ...h.message, ...change }); assert.equal(result.state, 'blocked');
    assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  }
});

test('pending exact content is confirmed in central storage before one awaited fixed Resend request', async () => {
  const h = harness();
  h.provider(async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key-never-real'); assert.equal(options.headers['Idempotency-Key'], ID);
    const saved = h.entries.get('messages/' + ID).data;
    assert.deepEqual(saved.message, h.message); assert.equal(saved.attempts.length, 1);
    assert.ok(h.reads.includes('messages/' + ID)); assert.equal(options.signal.aborted, false);
    assert.deepEqual(JSON.parse(options.body), { from: h.message.from, to: [...h.message.to], subject: h.message.subject, html: h.message.html, text: h.message.text });
    h.at(START + 7000); return json();
  });
  const result = await h.send(); assert.equal(result.state, 'accepted'); assert.equal(result.providerId, providerId);
  assert.equal(result.acceptedAt, START + 7000); assert.equal(result.deliveryConfirmed, false); assert.equal(h.calls.length, 1);
  assert.equal(result.receipts.length, 1); assert.equal(result.receipts[0].httpStatus, 200);
  h.at(START + 365 * 86400000); h.env.GIB_M1_DIGEST_TEST_SEND_ENABLED = 'false';
  assert.equal((await h.read()).state, 'accepted', 'switch-off does not erase acceptance');
  h.env.GIB_M1_DIGEST_TEST_SEND_ENABLED = 'true'; assert.equal((await h.send()).state, 'accepted');
  assert.equal(h.calls.length, 1, 'durable acceptance suppresses resends beyond provider dedupe expiry');
});

test('definite 4xx rejections are retained without claiming delivery or automatically retrying', async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    const h = harness(); h.provider(async () => json({ message: 'Private provider response must not be persisted' }, status));
    const rejected = await h.send(); assert.equal(rejected.state, 'rejected'); assert.equal(rejected.retryAllowed, true);
    assert.equal(rejected.receipts[0].httpStatus, status); assert.equal(rejected.deliveryConfirmed, false);
    assert.equal((await h.read()).state, 'rejected'); assert.equal(h.calls.length, 1);
    assert.doesNotMatch(JSON.stringify([...h.entries]), /Private provider|synthetic-test-key/);
  }
});

test('408, 409, 5xx, redirects and malformed success remain unknown, preserving bounded immutable failure receipts', async () => {
  const responses = [() => json({}, 408), () => json({}, 409), () => json({}, 500), () => json({}, 503), () => json({}, 302),
    () => json({}), () => json({ id: 'not-a-provider-id' }), () => json({ id: providerId, error: 'conflicting evidence' }),
    () => json({ id: [providerId] }), () => new Response('not json', { status: 200 }),
    () => new Response('x'.repeat(4097), { status: 200 })];
  for (const makeResponse of responses) {
    const h = harness(); h.provider(async () => makeResponse()); const result = await h.send();
    assert.equal(result.state, 'unknown'); assert.equal(result.retryAllowed, true); assert.equal(result.deliveryConfirmed, false);
    assert.equal(h.calls.length, 1); assert.equal(result.receipts[0].providerId, null);
    assert.equal((await h.read()).state, 'unknown'); assert.equal(h.calls.length, 1);
  }
});

test('lost provider responses recover after reload using identical identity/body, while prior failure evidence survives', async () => {
  const h = harness(); h.provider(async () => { throw new Error('Lost reply containing private token'); });
  const lost = await h.send(); assert.equal(lost.state, 'unknown'); const firstReceipt = clone(lost.receipts[0]);
  const exactBody = h.calls[0].options.body; h.at(START + 30000);
  const freshDependencies = { ...h.deps, fetch: async (url, options) => { h.calls.push({ url, options }); return json(); } };
  const recovered = await deliverTestDigestEmail(clone(h.message), freshDependencies);
  assert.equal(recovered.state, 'accepted'); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.body, exactBody); assert.equal(h.calls[1].options.headers['Idempotency-Key'], ID);
  assert.deepEqual(recovered.receipts[0], firstReceipt); assert.equal(recovered.receipts.length, 2);
  assert.doesNotMatch(JSON.stringify([...h.entries]), /private token/);
});

test('a later definite rejection cannot disprove acceptance of an earlier uncertain attempt', async () => {
  const h = harness(); h.provider(async () => { throw new Error('lost reply'); }); await h.send();
  h.provider(async () => json({}, 403)); const result = await h.send();
  assert.equal(result.state, 'unknown'); assert.equal(result.receipts[1].state, 'rejected'); assert.equal(result.retryAllowed, true);
});

test('explicit retry after fixing a rejected provider setup uses the original key/body and retains the rejection', async () => {
  const h = harness(); h.provider(async () => json({}, 403)); const rejected = await h.send();
  assert.equal(rejected.state, 'rejected'); const original = h.calls[0].options.body, firstReceipt = clone(rejected.receipts[0]);
  h.env.GIB_M1_DIGEST_TEST_RESEND_API_KEY = 'repaired-synthetic-test-key'; h.provider(async () => json());
  h.at(START + 300000); const accepted = await h.send(); assert.equal(accepted.state, 'accepted'); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.body, original); assert.equal(h.calls[1].options.headers['Idempotency-Key'], ID);
  assert.deepEqual(accepted.receipts[0], firstReceipt); assert.equal(accepted.receipts[1].state, 'accepted');
  const expired = harness(); expired.provider(async () => json({}, 403)); await expired.send(); expired.at(START + 23 * 3600000);
  const blocked = await expired.send(); assert.equal(blocked.state, 'rejected'); assert.equal(blocked.retryAllowed, false);
  assert.equal(blocked.code, 'MANUAL_RECONCILIATION_REQUIRED'); assert.equal(expired.calls.length, 1);
});

test('unknown or unreceipted acceptance blocks another provider credential without exposing its fingerprint', async () => {
  for (const missingReceipt of [false, true]) {
    const h = harness(); h.provider(async () => { throw new Error('Lost provider confirmation'); });
    if (missingReceipt) {
      const set = h.store.set;
      h.store.set = async (key, ...args) => { if (key.startsWith('attempts/')) throw new Error('Receipt unavailable'); return set(key, ...args); };
    }
    await h.send(); const retained = h.entries.get('messages/' + ID).data.attempts[0];
    assert.match(retained.credentialFingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(retained.credentialFingerprint, h.env.GIB_M1_DIGEST_TEST_RESEND_API_KEY);
    const originalKey = h.env.GIB_M1_DIGEST_TEST_RESEND_API_KEY;
    h.env.GIB_M1_DIGEST_TEST_RESEND_API_KEY = 'different-synthetic-account-key'; h.at(START + 60000);
    const writes = h.writes.length, result = await h.send();
    assert.equal(result.state, 'unknown'); assert.equal(result.code, 'PROVIDER_CREDENTIAL_RECONCILIATION_REQUIRED');
    assert.equal(result.retryAllowed, false); assert.equal(h.calls.length, 1); assert.equal(h.writes.length, writes);
    assert.doesNotMatch(JSON.stringify(result), /credentialFingerprint|different-synthetic-account-key/);
    assert.equal(JSON.stringify(result).includes(retained.credentialFingerprint), false);
    const read = await h.read(); assert.equal(JSON.stringify(read).includes(retained.credentialFingerprint), false);
    h.env.GIB_M1_DIGEST_TEST_RESEND_API_KEY = originalKey;
    if (!missingReceipt) { h.provider(async () => json()); assert.equal((await h.send()).state, 'accepted'); assert.equal(h.calls.length, 2); }
  }
});

test('accepted durable receipts prevent sends after a provider credential changes', async () => {
  const h = harness(); await h.send(); h.env.GIB_M1_DIGEST_TEST_RESEND_API_KEY = 'different-synthetic-account-key';
  assert.equal((await h.read()).state, 'accepted'); assert.equal((await h.send()).state, 'accepted'); assert.equal(h.calls.length, 1);
});

test('simultaneous requests acquire one CAS lease and cannot issue concurrent provider calls', async () => {
  const h = harness(), held = deferred(); h.provider(() => held.promise);
  const first = h.send(), second = h.send(); await flush();
  assert.equal(h.calls.length, 1); assert.equal((await h.read()).state, 'pending'); assert.equal((await second).state, 'pending');
  held.resolve(json()); assert.equal((await first).state, 'accepted'); assert.equal(h.calls.length, 1);
  assert.equal(h.entries.get('messages/' + ID).data.attempts.length, 1);
});

test('a lost pending-write acknowledgment sends nothing; expired lease recovery retains the original payload', async () => {
  const h = harness(), set = h.store.set; let once = true;
  h.store.set = async (...args) => { const value = await set(...args); if (once) { once = false; throw new Error('Lost storage acknowledgment'); } return value; };
  assert.equal((await h.send()).state, 'unknown'); assert.equal(h.calls.length, 0);
  assert.equal((await h.read()).state, 'pending'); assert.equal((await h.send()).state, 'pending');
  h.at(START + 60000); assert.equal((await h.send()).state, 'accepted'); assert.equal(h.calls.length, 1);
  assert.equal(h.entries.get('messages/' + ID).data.attempts.length, 2);
});

test('receipt storage failure after provider acceptance never reports success and can reconcile the durable receipt without sending again', async () => {
  const h = harness(), set = h.store.set; let once = true;
  h.store.set = async (key, ...args) => {
    const result = await set(key, ...args);
    if (key.startsWith('attempts/') && once) { once = false; throw new Error('Lost receipt acknowledgment'); }
    return result;
  };
  const initial = await h.send(); assert.equal(initial.state, 'unknown'); assert.equal(initial.code, 'RESULT_STORAGE_UNCONFIRMED');
  assert.equal(h.calls.length, 1); assert.equal((await h.read()).state, 'accepted'); assert.equal((await h.send()).state, 'accepted');
  assert.equal(h.calls.length, 1);
});

test('missing receipt storage after acceptance stays pending then retries the exact provider key only within the safe window', async () => {
  const h = harness(), set = h.store.set; let once = true;
  h.store.set = async (key, ...args) => { if (key.startsWith('attempts/') && once) { once = false; throw new Error('Receipt write failed'); } return set(key, ...args); };
  assert.equal((await h.send()).state, 'unknown'); assert.equal((await h.read()).state, 'pending');
  h.at(START + 60000); assert.equal((await h.send()).state, 'accepted');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].options.body, h.calls[1].options.body);
  assert.equal(h.calls[0].options.headers['Idempotency-Key'], h.calls[1].options.headers['Idempotency-Key']);
});

test('CAS loss, malformed readback and unavailable storage never dispatch a provider request', async () => {
  for (const boundary of ['read', 'set', 'cas', 'readback']) {
    const h = harness(), get = h.store.getWithMetadata;
    if (boundary === 'read') h.store.getWithMetadata = async () => { throw new Error('Read failed'); };
    if (boundary === 'set') h.store.set = async () => { throw new Error('Write failed'); };
    if (boundary === 'cas') h.store.set = async () => ({ modified: false });
    if (boundary === 'readback') h.store.getWithMetadata = async (...args) => h.writes.length ? { data: { wrong: true }, etag: 'wrong' } : get(...args);
    const result = await h.send(); assert.notEqual(result.state, 'accepted'); assert.equal(h.calls.length, 0);
  }
});

test('a changed retry body or recipient stays blocked even when the approval settings are changed to match it', async () => {
  const h = harness(); h.provider(async () => { throw new Error('Lost reply'); }); await h.send();
  const changed = { ...h.message, subject: h.message.subject + ' changed' }; changed.hash = hashTestDigestEmail(changed);
  h.env.GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_HASH = changed.hash;
  assert.equal((await h.send(changed)).code, 'RETAINED_MESSAGE_MISMATCH'); assert.equal(h.calls.length, 1);
  const other = buildTestDigestEmail('different@example.com'); h.env.GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_HASH = other.hash;
  h.env.GIB_M1_DIGEST_TEST_APPROVED_RECIPIENT = other.to[0]; assert.equal((await h.send(other)).code, 'RETAINED_MESSAGE_MISMATCH'); assert.equal(h.calls.length, 1);
});

test('uncertain delivery never retries at or beyond 23h, and the first attempt time never rolls forward', async () => {
  const h = harness(); h.provider(async () => { throw new Error('Lost reply'); }); await h.send();
  h.at(START + 23 * 3600000 - 1); assert.equal((await h.send()).state, 'unknown'); assert.equal(h.calls.length, 2);
  assert.equal(h.entries.get('messages/' + ID).data.createdAt, START);
  for (const time of [START + 23 * 3600000, START + 24 * 3600000, START + 30 * 86400000]) {
    h.at(time); const result = await h.send(); assert.equal(result.code, 'MANUAL_RECONCILIATION_REQUIRED'); assert.equal(result.retryAllowed, false);
    assert.equal(h.calls.length, 2); assert.equal((await h.read()).state, 'unknown');
  }
});

test('corrupt and mismatched immutable receipts cannot become acceptance evidence', async () => {
  for (const change of [{ providerId: 'invalid' }, { hash: '0'.repeat(64) }, { messageId: 'another' }, { attemptId: uuid(999) }, { httpStatus: 403 }, { extra: true }]) {
    const h = harness(); await h.send(); const key = [...h.entries.keys()].find(key => key.startsWith('attempts/'));
    Object.assign(h.entries.get(key).data, change); const result = await h.read(); assert.equal(result.state, 'blocked');
    assert.equal(result.code, 'RETAINED_RECEIPT_INVALID'); await h.send(); assert.equal(h.calls.length, 1);
  }
});

test('provider wait is bounded at the existing 25 seconds, aborts, and does not retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); h.provider(() => new Promise(() => {})); const waiting = h.send(); await flush();
  assert.equal(h.calls.length, 1); t.mock.timers.tick(24999); await flush(); assert.equal(h.calls[0].options.signal.aborted, false);
  h.at(START + 25000); t.mock.timers.tick(1); const result = await waiting;
  assert.equal(h.calls[0].options.signal.aborted, true); assert.equal(result.state, 'unknown'); assert.equal(result.receipts[0].category, 'PROVIDER_TIMEOUT');
  assert.equal(h.calls.length, 1);
});
