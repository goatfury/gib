import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { handleReadProof } from '../netlify/functions/m1-test-read-proof.mjs';
import { handleReadResult } from '../netlify/functions/m1-test-read-result.mjs';
import { handleManagerReview } from '../netlify/functions/m1-manager-review.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { CALLBACK_URL, PROOF_ORIGIN, PROOF_PATH, SIGNATURE_HEADER, cleanupExpiredReads, key, makeBinding, signature } from '../netlify/functions/_lib/m1-test-read-callback.mjs';

const now = Date.parse('2026-09-23T17:30:00Z');
const id = '00000000-0000-4000-8000-000000000001';
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER/exec', GIB_TEST_WEBHOOK_TOKEN: 'synthetic-test-transport-1234567890', GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-test-admin-1234567890abcdef' };
const runtime = runtimeConfig(env, { admin: true, requestUrl: PROOF_ORIGIN });
const context = { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { id: 'synthetic-deploy', context: 'deploy-preview', published: false } };
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ledger = () => ({ ok: true, schema: 'm1-manager-review/v1', complete: true, gym: 'rev', from: '2026-09-07', to: '2026-09-23', days: datesThrough('2026-09-23').map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) });
const payload = () => ({ binding: makeBinding(id, now), readAt: now + 100, result: ledger() });
function memory() {
  const entries = new Map();
  return { entries, async getWithMetadata(k) { const data = entries.get(k); return data ? { data: structuredClone(data), etag: 'etag' } : null; },
    async *list() { yield { blobs: [...entries.keys()].map(key => ({ key })) }; }, async delete(k) { entries.delete(k); },
    async set(k, value, options) { assert.equal(options.onlyIfNew, true); if (entries.has(k)) return { modified: false }; entries.set(k, JSON.parse(value)); return { modified: true }; } };
}
function harness() {
  const store = memory();
  const tasks = [];
  let stamp = now;
  const calls = [];
  const deps = { store, enabled: true, env, clock: () => stamp, context: { ...context, waitUntil: p => tasks.push(p) }, fetch: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 302, headers: { Location: 'https://script.googleusercontent.com/NEVER_REQUEST' } }); } };
  return { store, deps, tasks, calls, clock: value => { stamp = value; } };
}
function admin(input = { operation: 'start', requestId: id }, name = 'Andrew Smith', origin = PROOF_ORIGIN) {
  const token = 'x'.repeat(43);
  const cookie = createAdminSession(name, runtime.sessionSecret, now, token);
  return new Request(origin + PROOF_PATH, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`, [ADMIN_REQUEST_HEADER]: token }, body: JSON.stringify(input) });
}
function callback(value = payload(), secret = env.GIB_TEST_ADMIN_ACTION_TOKEN) {
  const raw = JSON.stringify(value);
  return new Request(CALLBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signature(raw, secret) }, body: raw });
}
async function start(h) { const response = await handleReadProof(admin(), h.deps); assert.equal(response.status, 202, await response.clone().text()); await Promise.all(h.tasks); h.clock(now + 200); return response.json(); }

test('pending read is persisted and read back before dispatch; supported lifecycle owns a single no-redirect 25s request', async () => {
  const h = harness();
  h.deps.fetch = async (url, init) => {
    assert.ok(h.store.entries.has(key(id, 'pending')));
    assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'POST'); assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.action, 'managerReviewReadCallbackProof'); assert.equal(body.binding.action, 'managerReviewRead');
    assert.equal(body.token, env.GIB_TEST_WEBHOOK_TOKEN); assert.equal(body.adminActionToken, env.GIB_TEST_ADMIN_ACTION_TOKEN);
    assert.equal(body.binding.expiresAt - body.binding.createdAt, 60000);
    return new Response('not an authoritative read', { status: 302 });
  };
  const result = await start(h);
  assert.equal(h.tasks.length, 1); assert.equal(result.ordinaryReplyUsed, false);
  assert.deepEqual([...h.store.entries.keys()], [key(id, 'pending'), key(id, 'dispatch')]);
  assert.equal(h.store.entries.get(key(id, 'dispatch')).outcome, 'ordinary-reply-discarded');
  const status = await (await handleReadProof(admin({ operation: 'status', requestId: id }), h.deps)).json();
  assert.equal(status.state, 'pending'); assert.equal(status.result, undefined);
});

test('result survives independent handlers and is available to another existing Admin; duplicate callback is harmless', async () => {
  const h = harness(); await start(h);
  const separate = { ...h.deps, context: { ...context } };
  assert.equal((await handleReadResult(callback(), separate)).status, 200);
  const before = structuredClone([...h.store.entries]);
  assert.equal((await handleReadResult(callback(), separate)).status, 200);
  assert.deepEqual([...h.store.entries], before);
  const status = await (await handleReadProof(admin({ operation: 'status', requestId: id }, 'Stuart Turner'), separate)).json();
  assert.equal(status.state, 'received'); assert.deepEqual(status.result, ledger()); assert.equal(status.latencyMs, 200);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-test-admin|synthetic-test-transport|signature/i);
});

test('concurrent conflicting results cannot overwrite the first authoritative result', async () => {
  const h = harness(); await start(h);
  const changed = payload(); changed.result.days[0].attendanceHash = 'b'.repeat(64);
  const responses = await Promise.all([handleReadResult(callback(), h.deps), handleReadResult(callback(changed), h.deps)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(h.store.entries.get(key(id, 'result')).payload, payload());
});

test('start retries reuse the persisted request and never dispatch again', async () => {
  const h = harness(); await start(h);
  assert.equal((await handleReadProof(admin(), h.deps)).status, 202);
  assert.equal(h.tasks.length, 1); assert.equal(h.calls.length, 1);
});

test('failed or unconfirmed pending storage and missing supported lifecycle dispatch nothing', async () => {
  for (const mode of ['throw', 'missing', 'uncertain', 'lifecycle']) {
    const h = harness();
    if (mode === 'throw') h.store.set = async () => { throw new Error('private storage error'); };
    if (mode === 'missing') h.store.getWithMetadata = async () => null;
    if (mode === 'uncertain') { const set = h.store.set; h.store.set = async (...args) => { await set(...args); }; }
    if (mode === 'lifecycle') delete h.deps.context.waitUntil;
    const response = await handleReadProof(admin(), h.deps);
    assert.equal(response.status, 503, mode); assert.equal(h.calls.length, 0); assert.equal(h.tasks.length, 0);
    assert.doesNotMatch(await response.text(), /private storage error/);
  }
});

test('transport failure has no retry and is never interpreted as a read result', async () => {
  const h = harness(); let count = 0;
  h.deps.fetch = async () => { count++; throw Object.assign(new Error('private URL and response'), { name: 'TimeoutError' }); };
  await start(h); assert.equal(count, 1);
  const status = await (await handleReadProof(admin({ operation: 'status', requestId: id }), h.deps)).json();
  assert.equal(status.state, 'pending'); assert.equal(status.dispatch.outcome, 'timeout'); assert.equal(status.result, undefined);
  assert.equal((await handleReadResult(callback(), h.deps)).status, 200);
  assert.equal((await (await handleReadProof(admin({ operation: 'status', requestId: id }), h.deps)).json()).state, 'received');
});

test('existing Admin, same-origin, deployment and gym gates protect every result', async () => {
  const h = harness();
  assert.equal((await handleReadProof(new Request(PROOF_ORIGIN + PROOF_PATH, { method: 'POST', headers: { Origin: PROOF_ORIGIN } }), h.deps)).status, 401);
  const forged = admin(); forged.headers.set(ADMIN_REQUEST_HEADER, 'forged');
  assert.equal((await handleReadProof(forged, h.deps)).status, 403);
  const crossOrigin = admin(); crossOrigin.headers.set('origin', 'https://untrusted.example');
  assert.equal((await handleReadProof(crossOrigin, h.deps)).status, 403);
  for (const origin of ['https://gib-live.netlify.app', 'https://gib-richmond-test.netlify.app', 'https://deploy-preview-90--gib-live.netlify.app']) assert.equal((await handleReadProof(admin(undefined, undefined, origin), h.deps)).status, 403);
  for (const deps of [{ ...h.deps, enabled: false }, { ...h.deps, installationId: 'richmond', environment: 'test' }, { ...h.deps, context: { ...h.deps.context, deploy: { context: 'production', published: true } } }, { ...h.deps, context: { ...h.deps.context, site: { name: 'gib-live', id: 'different' } } }]) assert.equal((await handleReadProof(admin(), deps)).status, 403);
  for (const operation of ['managerReviewSave', 'managerReviewVoid', 'kioskSignIn']) assert.equal((await handleReadProof(admin({ operation, requestId: id }), h.deps)).status, 400);
  assert.equal(h.store.entries.size, 0);
});

test('expired, mismatched, stale, unsigned, wrong-secret, incomplete and unsolicited callbacks fail closed', async () => {
  const h = harness();
  assert.equal((await handleReadResult(callback(), h.deps)).status, 404);
  await start(h);
  const unsigned = callback(); unsigned.headers.delete(SIGNATURE_HEADER);
  assert.equal((await handleReadResult(unsigned, h.deps)).status, 403);
  assert.equal((await handleReadResult(callback(payload(), 'different'), h.deps)).status, 403);
  for (const alteration of [p => { p.binding.gym = 'richmond'; }, p => { p.binding.action = 'managerReviewSave'; }, p => { p.binding.expiresAt++; }, p => { p.binding.from = '2026-09-08'; }, p => { p.binding.createdAt--; p.binding.expiresAt--; }, p => { p.readAt = now - 1; }, p => { p.readAt = now + 500; }, p => { p.result.complete = false; }, p => { p.result.days.pop(); }]) {
    const changed = payload(); alteration(changed);
    assert.ok([409, 422].includes((await handleReadResult(callback(changed), h.deps)).status));
  }
  assert.equal(h.store.entries.has(key(id, 'result')), false);
  assert.equal((await handleReadResult(callback(), h.deps)).status, 200);
  h.clock(now + 60000);
  assert.equal((await handleReadResult(callback(), h.deps)).status, 410);
  assert.equal((await handleReadProof(admin({ operation: 'status', requestId: id }), h.deps)).status, 410);
});

test('failed result saving and corrupted persisted result never return success', async () => {
  const h = harness(); await start(h);
  const set = h.store.set;
  h.store.set = async () => { throw new Error('storage failed'); };
  assert.equal((await handleReadResult(callback(), h.deps)).status, 503);
  h.store.set = set;
  assert.equal((await handleReadResult(callback(), h.deps)).status, 200);
  h.store.entries.get(key(id, 'result')).payload.result.days.pop();
  assert.equal((await handleReadProof(admin({ operation: 'status', requestId: id }), h.deps)).status, 503);
});

function googleHarness() {
  let locked = false;
  let clock = now + 100;
  let nonce = 0;
  const sent = [];
  const logs = [];
  const properties = new Map();
  const ctx = vm.createContext({ Date: class extends Date { static now() { return clock; } },
    console: { log: value => logs.push(value), warn: value => logs.push(value) }, GIB_M1_ALLOWED_TARGET: 'test', GIB_M1_MANAGER_REVIEW_TEST_ENABLED: true, EXPECTED_SPREADSHEET_NAME: 'RBJJ M1 — TEST', GIB_M1_ADMIN_NAMES_: ['Andrew Smith', 'Stuart Turner'],
    configuredDeploymentTarget_: () => 'test', requestTarget_: body => body.target, adminActionAuthorized_: body => body.token === env.GIB_TEST_WEBHOOK_TOKEN && body.adminActionToken === env.GIB_TEST_ADMIN_ACTION_TOKEN,
    todayNewYork_: () => '2026-09-23', rejectedAuthResult_: () => ({ getContent: () => '{"ok":false}' }), jsonResult_: value => ({ getContent: () => JSON.stringify(value) }),
    LockService: { getScriptLock: () => ({ tryLock: () => { locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    PropertiesService: { getScriptProperties: () => ({ getKeys: () => [...properties.keys()], getProperty: k => properties.get(k) || null, setProperty: (k, v) => { if (k.startsWith('M1_TEST_READ_TRACE_V1_')) assert.equal(locked, false); properties.set(k, v); }, deleteProperty: k => properties.delete(k) }) },
    openExpectedSpreadsheet_: () => ({ getName: () => 'RBJJ M1 — TEST', getSheetByName: () => null }), signinsSheet_: () => ({}), readSignins_: () => ({ records: [] }),
    Utilities: { getUuid: () => `10000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`, sleep: ms => { assert.equal(locked, false); assert.ok(ms > 0 && ms <= 61000); clock += ms; }, Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' }, newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }), computeDigest: (algorithm, text) => [...createHash(algorithm).update(text).digest()], computeHmacSha256Signature: (text, secret) => [...createHmac('sha256', secret).update(text).digest()] },
    UrlFetchApp: { fetch: (url, options) => { assert.equal(locked, false, 'Google read lock must be released before callback'); sent.push({ url, options }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, accepted: true, requestId: JSON.parse(options.payload).binding.requestId }) }; }, getRequest: () => ({}) }
  });
  vm.runInContext(read('integrations/google-apps-script/GibM1ManagerReview.gs'), ctx);
  vm.runInContext(read('integrations/google-apps-script/GibM1TestReadCallback.gs'), ctx);
  const body = { token: env.GIB_TEST_WEBHOOK_TOKEN, adminActionToken: env.GIB_TEST_ADMIN_ACTION_TOKEN, target: 'test', gym: 'rev', action: 'managerReviewReadCallbackProof', from: '2026-09-07', to: '2026-09-23', adminName: 'Andrew Smith', binding: makeBinding(id, now) };
  return { ctx, sent, body, properties, logs, clock: () => clock, setClock: value => { clock = value; } };
}

const googleReceipts = g => [...g.properties].filter(([key]) => key.startsWith('M1_TEST_READ_TRACE_V1_')).map(([, value]) => JSON.parse(value));
test('editor-armed receipts cover authenticated validation rejection and a request-specific acknowledgment; unauthenticated input cannot create a receipt', () => {
  const g = googleHarness();
  g.ctx.testRevolutionStartReadTrace();
  g.ctx.gibM1TestReadCallback_(g.body);
  const success = googleReceipts(g)[0];
  assert.equal(success.requestId, id); assert.equal(success.acknowledged, true); assert.equal(success.error, 'none'); assert.equal(success.status, 200);
  assert.ok(success.events.some(e => e.stage === 'google.lock' && e.state === 'released'));
  for (const [change, expected] of [[body => { body.gym = 'richmond'; }, 'validation_rejected'], [body => { body.binding.expiresAt++; }, 'binding_time'], [body => { body.binding.requestId = 'private-untrusted-value'; }, 'binding_id']]) {
    const body = structuredClone(g.body); change(body);
    g.ctx.gibM1TestReadCallback_(body);
    assert.equal(googleReceipts(g).at(-1).error, expected);
  }
  assert.equal(googleReceipts(g).at(-1).requestId, null);
  const before = structuredClone([...g.properties]);
  g.ctx.gibM1TestReadCallback_({ ...g.body, adminActionToken: 'bad' });
  assert.deepEqual([...g.properties], before);
  assert.doesNotMatch(JSON.stringify([...g.properties]) + g.logs.join('\n'), /private-untrusted|synthetic-test|Andrew|script\.google/);
  assert.equal(g.sent.length, 1);
});

test('binding diagnostics distinguish every existing rejection check without accepting future or expired requests', () => {
  const cases = [
    [body => { body.binding.extra = true; }, 'binding_shape'],
    [body => { body.binding.gym = 'richmond'; }, 'binding_scope'],
    [body => { body.adminName = 'unlisted'; }, 'binding_reviewer'],
    [body => { body.binding.createdAt = now + 500; body.binding.expiresAt = now + 60500; }, 'binding_future'],
    [body => { body.binding.createdAt = now - 60000; body.binding.expiresAt = now; }, 'binding_expired']
  ];
  for (const [change, expected] of cases) {
    const g = googleHarness(); g.ctx.testRevolutionStartReadTrace(); change(g.body);
    g.ctx.gibM1TestReadCallback_(g.body);
    const result = googleReceipts(g)[0];
    assert.equal(result.error, expected); assert.equal(g.sent.length, 0);
    if (expected === 'binding_future') assert.deepEqual(result.events.find(e => e.stage === 'google.binding-age'), { stage: 'google.binding-age', state: 'future', elapsedMs: 400, status: null });
    assert.equal(Object.hasOwn(result, 'createdAt'), false);
  }
});

test('Google failure receipts distinguish thrown read/parse/transport exceptions, rejection, non-success HTTP and wrong acknowledgments', () => {
  const cases = [
    ['lock', 'google.result', 'read_rejected', null, null],
    ['read', 'google.read', 'thrown_exception', null, null],
    ['decode', 'google.decode', 'thrown_exception', null, null],
    ['incomplete', 'google.result', 'read_rejected', null, null],
    ['oversize', 'google.payload', 'payload_limit', null, null],
    ['transport', 'google.callback', 'thrown_exception', null, null],
    ['http', 'google.callback', 'callback_http', 503, false],
    ['json', 'google.ack', 'ack_invalid_json', 200, false],
    ['mismatch', 'google.ack', 'ack_mismatch', 200, false],
    ['null', 'google.ack', 'ack_mismatch', 200, false],
    ['ack-read', 'google.ack', 'ack_read_exception', 200, false]
  ];
  for (const [mode, stage, error, status, acknowledged] of cases) {
    const g = googleHarness(); g.ctx.testRevolutionStartReadTrace();
    if (mode === 'lock') g.ctx.LockService.getScriptLock = () => ({ tryLock: () => false });
    if (mode === 'read') g.ctx.readSignins_ = () => { throw new Error('private attendance error'); };
    if (mode === 'decode') g.ctx.managerReviewAction_ = () => ({ getContent: () => 'private response' });
    if (mode === 'incomplete') g.ctx.managerReviewAction_ = () => ({ getContent: () => JSON.stringify({ ...ledger(), complete: false }) });
    if (mode === 'oversize') g.ctx.Utilities.newBlob = () => ({ getBytes: () => ({ length: 256001 }) });
    let calls = 0;
    if (['transport', 'http', 'json', 'mismatch', 'null', 'ack-read'].includes(mode)) g.ctx.UrlFetchApp.fetch = () => {
      calls++;
      if (mode === 'transport') throw new Error('private signed URL');
      return { getResponseCode: () => mode === 'http' ? 503 : 200, getContentText: () => {
        if (mode === 'ack-read') throw new Error('private response');
        if (mode === 'json') return '<private response>';
        if (mode === 'null') return 'null';
        return JSON.stringify({ ok: true, accepted: true, requestId: 'different-private-id' });
      } };
    };
    const result = g.ctx.gibM1TestReadCallback_(g.body);
    assert.equal(JSON.parse(result.getContent()).code, 'CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE');
    const receipts = googleReceipts(g); assert.equal(receipts.length, 1, mode);
    assert.deepEqual([receipts[0].stage, receipts[0].error, receipts[0].status, receipts[0].acknowledged], [stage, error, status, acknowledged], mode);
    assert.ok(calls <= 1, 'diagnostic must not retry delivery');
    assert.doesNotMatch(JSON.stringify(receipts) + g.logs.join('\n'), /private|Andrew|synthetic-test/);
  }
});

test('separate immutable diagnostic receipts preserve failure evidence even when a later success reuses the same request ID and millisecond', () => {
  const g = googleHarness(); g.ctx.testRevolutionStartReadTrace();
  const fetch = g.ctx.UrlFetchApp.fetch;
  g.ctx.UrlFetchApp.fetch = () => ({ getResponseCode: () => 503 });
  g.ctx.gibM1TestReadCallback_(g.body);
  const [failureKey, failureValue] = [...g.properties].find(([key]) => key.startsWith('M1_TEST_READ_TRACE_V1_'));
  g.ctx.UrlFetchApp.fetch = fetch;
  g.ctx.gibM1TestReadCallback_(g.body);
  const receipts = googleReceipts(g);
  assert.equal(receipts.length, 2);
  assert.equal(g.properties.get(failureKey), failureValue);
  assert.deepEqual(receipts.map(r => [r.requestId, r.error]), [[id, 'callback_http'], [id, 'none']]);
});

test('trace expiry and admission bounds preserve unexpired receipts and unrelated properties; the editor reader only outputs sanitized values', () => {
  const g = googleHarness(); g.ctx.testRevolutionStartReadTrace();
  const key = (expiry, index) => `M1_TEST_READ_TRACE_V1_${expiry}_20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const raw = JSON.stringify({ requestId: id, stage: 'private-stage', error: 'private-error', events: [], extra: 'private-payload' });
  g.properties.set('UNRELATED', 'private-secret');
  for (let i = 0; i < 96; i++) g.properties.set(key(now + 3600000, i), raw);
  for (let i = 0; i < 40; i++) g.properties.set(key(now, i), raw);
  const keys = g.ctx.gibM1ReadTraceKeys_(g.ctx.PropertiesService.getScriptProperties(), g.clock());
  assert.equal(keys.length, 104, 'at most 32 expired keys are cleaned per call');
  g.ctx.gibM1TestReadCallback_(g.body);
  assert.equal(googleReceipts(g).length, 96); assert.equal(g.sent.length, 1);
  assert.ok(g.logs.includes('M1_TEST_READ_TRACE_UNAVAILABLE'));
  assert.equal(g.properties.get('UNRELATED'), 'private-secret');
  g.ctx.testRevolutionReadTraceReceipts();
  assert.doesNotMatch(g.logs.join('\n'), /private-/);
  assert.ok(g.logs.some(s => s.includes('"stage":"google.request"')));
  g.setClock(now + 3600001);
  g.logs.length = 0; g.ctx.testRevolutionReadTraceReceipts();
  assert.equal(g.logs.some(s => s.startsWith('M1_TEST_READ_RECEIPT ')), false, 'expired receipts are never exposed even when cleanup is partial');
  g.setClock(now + 21 * 60000); g.ctx.gibM1TestReadCallback_(g.body);
  assert.equal(g.logs.some(s => s.startsWith('M1_TEST_READ_RECEIPT ')), false);
});

test('every diagnostic service failure is best effort and adds no lock or callback dependency', () => {
  for (const mode of ['window', 'keys', 'write', 'uuid', 'console']) {
    const g = googleHarness(); g.ctx.testRevolutionStartReadTrace();
    const properties = g.ctx.PropertiesService.getScriptProperties();
    if (mode === 'window') properties.getProperty = () => { throw new Error('private diagnostic error'); };
    if (mode === 'keys') properties.getKeys = () => { throw new Error('private diagnostic error'); };
    if (mode === 'write') properties.setProperty = () => { throw new Error('private diagnostic error'); };
    if (mode === 'uuid') g.ctx.Utilities.getUuid = () => { throw new Error('private diagnostic error'); };
    if (mode === 'console') g.ctx.console.log = () => { throw new Error('private diagnostic error'); };
    g.ctx.PropertiesService.getScriptProperties = () => properties;
    const locks = [];
    g.ctx.LockService.getScriptLock = () => ({ tryLock: ms => { locks.push(ms); return true; }, releaseLock() {} });
    g.body.binding.action = 'managerReviewBadgeRead'; delete g.body.adminName;
    g.ctx.gibM1TestReadCallback_(g.body);
    assert.equal(g.sent.length, 1, mode); assert.deepEqual(locks, [10000], mode);
  }
});

test('trace helpers are confined to the separate TEST editor and stop preserves existing receipts', () => {
  const g = googleHarness(); g.ctx.testRevolutionStartReadTrace(); g.ctx.gibM1TestReadCallback_(g.body);
  const existing = googleReceipts(g); g.ctx.testRevolutionStopReadTrace();
  g.ctx.gibM1TestReadCallback_(g.body);
  assert.deepEqual(googleReceipts(g), existing);
  g.ctx.GIB_M1_RICHMOND_INSTALLATION_ = true;
  for (const name of ['testRevolutionStartReadTrace', 'testRevolutionStopReadTrace', 'testRevolutionReadTraceReceipts']) assert.throws(() => g.ctx[name](), /Revolution TEST/);
  const receiver = read('integrations/google-apps-script/GibM1Receiver.gs');
  assert.doesNotMatch(receiver, /testRevolution(?:StartReadTrace|StopReadTrace|ReadTraceReceipts)/);
});

test('unarmed or expired badge faults never acquire a lock; authoritative read still owns its 10s lock', () => {
  for (const armedUntil of [undefined, now]) {
    const g = googleHarness(), attempts = [];
    if (armedUntil) g.properties.set('M1_TEST_LATE_BADGE', String(armedUntil));
    g.body.binding.action = 'managerReviewBadgeRead'; delete g.body.adminName;
    g.ctx.LockService.getScriptLock = () => ({ tryLock: ms => { attempts.push(ms); return ms === 10000; }, releaseLock() {} });
    g.ctx.gibM1TestReadCallback_(g.body);
    assert.deepEqual(attempts, [10000]);
    assert.equal(g.sent.length, 1, 'a busy instrumentation lock must not prevent the authoritative read');
  }
});

test('armed fault contention and unavailable instrumentation cannot abort normal badge reads', () => {
  for (const mode of ['busy', 'lock-error', 'properties-error']) {
    const g = googleHarness(), attempts = [];
    g.properties.set('M1_TEST_LATE_BADGE', String(now + 100000));
    g.body.binding.action = 'managerReviewBadgeRead'; delete g.body.adminName;
    g.ctx.LockService.getScriptLock = () => ({ tryLock: ms => {
      attempts.push(ms);
      if (ms === 0 && mode === 'lock-error') throw new Error('private instrumentation failure');
      return ms === 10000;
    }, releaseLock() {} });
    if (mode === 'properties-error') g.ctx.PropertiesService.getScriptProperties = () => { throw new Error('private property failure'); };
    g.ctx.gibM1TestReadCallback_(g.body);
    assert.equal(g.sent.length, 1, mode);
    assert.equal(g.clock(), now + 100);
    assert.deepEqual(attempts, mode === 'properties-error' ? [10000] : [0, 10000]);
    assert.ok(g.properties.has('M1_TEST_LATE_BADGE'), 'failed fault consumption cannot consume a fault');
  }
});

test('Google correlation distinguishes authoritative lock failure and read failure without logging private content', () => {
  for (const mode of ['lock', 'read']) {
    const g = googleHarness();
    if (mode === 'lock') g.ctx.LockService.getScriptLock = () => ({ tryLock: () => false });
    else g.ctx.readSignins_ = () => { throw new Error('private attendance contents'); };
    g.ctx.gibM1TestReadCallback_(g.body);
    assert.equal(g.sent.length, 0);
    const stages = g.logs.filter(s => s.startsWith('M1_TEST_READ_STAGE ')).map(s => JSON.parse(s.slice(19)));
    assert.ok(stages.every(s => s.requestId === id));
    assert.ok(stages.some(s => s.stage === 'google.' + mode && s.state === (mode === 'lock' ? 'unavailable' : 'failed')));
    assert.doesNotMatch(g.logs.join('\n'), /private attendance|synthetic-test-admin|synthetic-test-transport|Andrew|script\.google/);
  }
});

test('owner-only late badge fault is one-use, bounded, preserves the binding and releases locks', () => {
  const g = googleHarness();
  g.ctx.testRevolutionLateBadgeCallback();
  g.body.binding.action = 'managerReviewBadgeRead'; delete g.body.adminName;
  g.ctx.gibM1TestReadCallback_(g.body);
  assert.equal(g.sent.length, 1); assert.equal(g.clock(), now + 61000);
  assert.equal(g.properties.has('M1_TEST_LATE_BADGE'), false);
  assert.deepEqual(JSON.parse(g.sent[0].options.payload).binding, g.body.binding);
  assert.equal(JSON.parse(g.sent[0].options.payload).readAt, now + 100);
  assert.equal(g.sent[0].options.timeoutSeconds, 10);
  assert.equal(JSON.parse(g.properties.get('M1_TEST_CALLBACK_FAULT_RECEIPT')).expired, true);
  const clean = googleHarness();
  clean.properties.set('M1_TEST_LATE_BADGE', String(now));
  clean.body.binding.action = 'managerReviewBadgeRead'; delete clean.body.adminName;
  clean.ctx.gibM1TestReadCallback_(clean.body);
  assert.equal(clean.clock(), now + 100); assert.equal(clean.sent.length, 1);
});

test('real Google read releases its lock, signs one fixed destination callback, and provides no ordinary read reply', () => {
  const g = googleHarness();
  const result = JSON.parse(g.ctx.gibM1TestReadCallback_(g.body).getContent());
  assert.equal(result.ok, false); assert.equal(result.code, 'CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE');
  assert.equal(g.sent.length, 1);
  const { url, options } = g.sent[0];
  assert.equal(url, CALLBACK_URL); assert.equal(options.followRedirects, false); assert.equal(options.timeoutSeconds, 10); assert.equal(options.validateHttpsCertificates, true);
  assert.equal(options.headers[SIGNATURE_HEADER], signature(options.payload, env.GIB_TEST_ADMIN_ACTION_TOKEN));
  const p = JSON.parse(options.payload); assert.equal(p.result.days.length, 17); assert.equal(p.result.complete, true); assert.equal(p.result.gym, 'rev');
});

test('normal badge has no reviewer identity and the public response contains only an aggregate', async () => {
  const h = normalHarness();
  const response = await handleManagerReview(new Request(PROOF_ORIGIN + '/api/m1-manager-review'), h.deps);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['asOf', 'ok', 'pendingDays']);
  assert.equal(result.pendingDays, 17);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].binding.action, 'managerReviewBadgeRead');
  assert.equal(Object.hasOwn(h.calls[0], 'adminName'), false);
  const pending = h.store.entries.get(key(h.calls[0].binding.requestId, 'pending'));
  assert.equal(Object.hasOwn(pending, 'reviewer'), false);
});

function normalHarness(deliver = true) {
  const h = harness();
  Object.assign(h.deps, { now, schedule: { current: true, timezone: 'America/New_York', days: {} }, addedStore: { getWithMetadata: async () => null }, sleep: async ms => h.clock(h.deps.clock() + ms) });
  h.deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body); h.calls.push(body);
    assert.ok(h.deps.store.entries.has(key(body.binding.requestId, 'pending')));
    if (deliver) {
      const p = { binding: body.binding, readAt: h.deps.clock(), result: ledger() };
      assert.equal((await handleReadResult(callback(p), { ...h.deps, context: { ...context } })).status, 200);
    }
    return new Response(null, { status: 302 });
  };
  return h;
}
function normalAdmin(input = { action: 'read' }) {
  const auth = admin();
  return new Request(PROOF_ORIGIN + '/api/m1-manager-review', { method: 'POST', headers: auth.headers, body: JSON.stringify(input) });
}

test('ordinary authenticated Admin read receives the callback; unauthenticated calls never dispatch', async () => {
  const h = normalHarness();
  assert.equal((await handleManagerReview(new Request(PROOF_ORIGIN + '/api/m1-manager-review', { method: 'POST', body: '{"action":"read"}' }), h.deps)).status, 401);
  assert.equal(h.calls.length, 0);
  const response = await handleManagerReview(normalAdmin(), h.deps);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).days.length, 17);
  assert.equal(h.calls[0].adminName, 'Andrew Smith');
  assert.equal(h.calls[0].binding.action, 'managerReviewRead');
});

test('missing normal callback makes one attempt and fails visibly; an expired response is rejected and a fresh read recovers', async () => {
  const h = normalHarness(false);
  const response = await handleManagerReview(new Request(PROOF_ORIGIN + '/api/m1-manager-review'), h.deps);
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.match(result.message, /Review status unavailable/);
  assert.equal(result.pendingDays, undefined); assert.equal(h.calls.length, 1);
  const binding = h.calls[0].binding;
  h.clock(binding.expiresAt);
  assert.equal((await handleReadResult(callback({ binding, readAt: binding.createdAt + 100, result: ledger() }), h.deps)).status, 410);
  const recovered = normalHarness();
  recovered.deps.store = h.store;
  recovered.clock(binding.expiresAt + 1);
  assert.equal((await handleManagerReview(normalAdmin(), recovered.deps)).status, 200);
  await Promise.all(recovered.tasks);
  assert.equal(h.store.entries.has(key(binding.requestId, 'pending')), false);
});

test('slow or failing cleanup cannot delay dispatch, block a successful response or escape waitUntil ownership', { timeout: 2000 }, async () => {
  for (const mode of ['slow', 'failed']) {
    const h = normalHarness(), stages = [];
    h.deps.traceLog = (_, json) => stages.push(JSON.parse(json));
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    h.store.list = async function* () {
      assert.equal(h.calls.length, 1, 'dispatch must precede cleanup');
      if (mode === 'slow') await blocked;
      throw new Error('private cleanup failure');
    };
    const response = await handleManagerReview(normalAdmin(), h.deps);
    assert.equal(response.status, 200, mode);
    assert.equal(h.tasks.length, 2, 'supported lifecycle owns dispatch and cleanup');
    assert.ok(stages.some(s => s.stage === 'response' && s.status === 200));
    release(); await Promise.all(h.tasks);
    assert.ok(stages.some(s => s.stage === 'cleanup' && s.state === 'unavailable'));
    assert.doesNotMatch(JSON.stringify(stages), /private cleanup|Andrew|synthetic-test/);
  }
});

test('cleanup has a work cap and a deadline, and cannot remove overlapping unexpired requests', async () => {
  const store = memory(), live = '00000000-0000-4000-8000-000000000099';
  store.entries.set(key(live, 'pending'), { binding: makeBinding(live, now) });
  store.entries.set(key(live, 'result'), { keep: true });
  for (let i = 1; i <= 40; i++) {
    const old = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
    store.entries.set(key(old, 'pending'), { binding: makeBinding(old, now - 60000) });
  }
  const before = store.entries.size;
  await cleanupExpiredReads(store, now);
  assert.equal(before - store.entries.size, 29); // One of the 30 inspected requests is live.
  assert.ok(store.entries.has(key(live, 'pending'))); assert.ok(store.entries.has(key(live, 'result')));
  const bounded = store.entries.size;
  await cleanupExpiredReads(store, now, { clock: () => now, deadline: now });
  assert.equal(store.entries.size, bounded);
});

test('overlapping badge and Admin reads preserve separate bindings, public privacy and request-stage correlation', async () => {
  const h = normalHarness(), stages = [];
  h.deps.traceLog = (_, json) => stages.push(JSON.parse(json));
  const badge = new Request(PROOF_ORIGIN + '/api/m1-manager-review', { headers: { 'X-GIB-M1-Read-ID': id } });
  const responses = await Promise.all([handleManagerReview(badge, h.deps), handleManagerReview(normalAdmin(), h.deps)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.deepEqual(Object.keys(await responses[0].json()).sort(), ['asOf', 'ok', 'pendingDays']);
  const ids = responses.map(r => r.headers.get('X-GIB-M1-Read-ID'));
  assert.equal(new Set(ids).size, 2); assert.ok(ids.every(Boolean));
  for (const requestId of ids) {
    const own = stages.filter(s => s.requestId === requestId);
    for (const stage of ['pending.write', 'pending.readback', 'dispatch', 'callback.acceptance', 'schedule', 'added-classes', 'response']) assert.ok(own.some(s => s.stage === stage), stage);
  }
  assert.ok(stages.some(s => s.clientId === id));
  assert.doesNotMatch(JSON.stringify(stages), /synthetic-test-admin|synthetic-test-transport|Andrew|attendanceHash|https:/);
  await Promise.all(h.tasks);
});

test('dependency and storage failures identify their failing stage without returning an all-clear', async () => {
  for (const failure of ['pending.write', 'schedule', 'added-classes', 'callback.result.write']) {
    const h = normalHarness(), stages = [];
    h.deps.traceLog = (_, json) => stages.push(JSON.parse(json));
    if (failure === 'pending.write') h.store.set = async () => { throw new Error('private store failure'); };
    if (failure === 'schedule') h.deps.schedule.current = false;
    if (failure === 'added-classes') h.deps.addedStore.getWithMetadata = async () => { throw new Error('private added-class failure'); };
    if (failure === 'callback.result.write') {
      const set = h.store.set;
      h.store.set = (...args) => args[0].endsWith('/result') ? Promise.reject(new Error('private result failure')) : set(...args);
    }
    const response = await handleManagerReview(normalAdmin(), h.deps);
    assert.equal(response.status, 503, failure);
    assert.equal((await response.json()).pendingDays, undefined);
    await Promise.all(h.tasks);
    assert.ok(stages.some(s => s.stage === failure && s.state === 'failed'), failure);
    assert.doesNotMatch(JSON.stringify(stages), /private .* failure/);
  }
});

test('temporary collection removes expired and orphaned results while preserving live requests', async () => {
  const store = memory();
  store.entries.set(key(id, 'pending'), { binding: makeBinding(id, now - 60000) });
  store.entries.set(key(id, 'result'), { old: true }); store.entries.set(key(id, 'dispatch'), { old: true });
  const live = '00000000-0000-4000-8000-000000000002';
  store.entries.set(key(live, 'pending'), { binding: makeBinding(live, now) });
  store.entries.set(key(live, 'result'), { keep: true });
  store.entries.set(key('00000000-0000-4000-8000-000000000003', 'result'), { orphan: true });
  await cleanupExpiredReads(store, now);
  assert.deepEqual([...store.entries.keys()], [key(live, 'pending'), key(live, 'result')]);
});

test('same-request save recovery and correction pre-validation stay on their original transport', async () => {
  for (const action of ['partial', 'complete', 'void']) {
    const h = normalHarness();
    h.deps.store = { list() { throw new Error('A save must never dispatch a check:null callback'); } };
    const input = { action, requestId: 'manager-1234567890123456', date: '2026-09-22', recordId: 'original', fingerprint: 'a'.repeat(64), reason: 'TEST reason' };
    const calls = [];
    h.deps.fetch = async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if (body.action === 'managerReviewRead') return Response.json({ ...ledger(), ...(action !== 'void' ? { receipt: { saved: true, requestId: input.requestId, revision: 1 } } : {}) });
      assert.equal(body.action, 'managerReviewVoid');
      return Response.json({ ok: true, removed: true, recordId: input.recordId });
    };
    const response = await handleManagerReview(normalAdmin(input), h.deps);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(calls[0].action, 'managerReviewRead');
    assert.deepEqual(calls[0].check, action === 'void' ? null : input);
    assert.equal(calls.length, action === 'void' ? 2 : 1);
  }
});

test('Google badge callback rejects invented reviewer identities and uses the existing read with check:null', () => {
  const g = googleHarness();
  g.body.binding.action = 'managerReviewBadgeRead';
  g.ctx.gibM1TestReadCallback_(g.body); assert.equal(g.sent.length, 0);
  delete g.body.adminName;
  const original = g.ctx.managerReviewAction_;
  g.ctx.managerReviewAction_ = body => { assert.equal(body.adminName, undefined); assert.equal(body.check, null); return original(body); };
  g.ctx.gibM1TestReadCallback_(g.body); assert.equal(g.sent.length, 1);
  assert.equal(JSON.parse(g.sent[0].options.payload).binding.action, 'managerReviewBadgeRead');
});

test('Google proof refuses other actions, installations, expired bindings, bad auth, incomplete reads and never writes', () => {
  for (const change of [{ action: 'managerReviewSave' }, { target: 'production' }, { gym: 'richmond' }, { token: 'wrong' }, { adminName: 'Trey' }, { binding: { ...makeBinding(id, now - 60000) } }]) {
    const g = googleHarness(); g.ctx.gibM1TestReadCallback_({ ...g.body, ...change }); assert.equal(g.sent.length, 0);
  }
  for (const name of ['GIB_M1_ALLOWED_TARGET', 'GIB_M1_RICHMOND_INSTALLATION_', 'EXPECTED_SPREADSHEET_NAME']) {
    const g = googleHarness(); g.ctx[name] = 'other'; g.ctx.gibM1TestReadCallback_(g.body); assert.equal(g.sent.length, 0);
  }
  const g = googleHarness(); g.ctx.managerReviewAction_ = () => ({ getContent: () => '{"ok":false}' });
  g.ctx.gibM1TestReadCallback_(g.body); assert.equal(g.sent.length, 0);
  assert.doesNotMatch(read('integrations/google-apps-script/GibM1TestReadCallback.gs'), /appendRow|setValues|setValue\(|deleteRow|managerReviewSave|managerReviewVoid/);
});

test('new scope and proof file are confined to the separate Revolution TEST source package', () => {
  const scope = 'https://www.googleapis.com/auth/script.external_request';
  assert.ok(JSON.parse(read('integrations/google-apps-script/appsscript.json')).oauthScopes.includes(scope));
  for (const project of ['production', 'richmond-test', 'richmond-production']) assert.ok(!JSON.parse(read(`integrations/google-apps-script/${project}/appsscript.json`)).oauthScopes.includes(scope));
  assert.match(read('integrations/google-apps-script/.claspignore'), /!GibM1TestReadCallback\.gs/);
  assert.doesNotMatch(read('integrations/google-apps-script/production/.claspignore'), /!GibM1TestReadCallback/);
  const g = googleHarness(); g.ctx.authorizeRevolutionTestReadCallback(); assert.equal(g.sent.length, 0);
});
