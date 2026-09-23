import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { handleReadProof } from '../netlify/functions/m1-test-read-proof.mjs';
import { handleReadResult } from '../netlify/functions/m1-test-read-result.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { CALLBACK_URL, PROOF_ORIGIN, PROOF_PATH, SIGNATURE_HEADER, key, makeBinding, signature } from '../netlify/functions/_lib/m1-test-read-callback.mjs';

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
  const sent = [];
  const ctx = vm.createContext({ Date: class extends Date { static now() { return now + 100; } },
    console: { log() {}, warn() {} }, GIB_M1_ALLOWED_TARGET: 'test', GIB_M1_MANAGER_REVIEW_TEST_ENABLED: true, EXPECTED_SPREADSHEET_NAME: 'RBJJ M1 — TEST', GIB_M1_ADMIN_NAMES_: ['Andrew Smith', 'Stuart Turner'],
    configuredDeploymentTarget_: () => 'test', requestTarget_: body => body.target, adminActionAuthorized_: body => body.token === env.GIB_TEST_WEBHOOK_TOKEN && body.adminActionToken === env.GIB_TEST_ADMIN_ACTION_TOKEN,
    todayNewYork_: () => '2026-09-23', rejectedAuthResult_: () => ({ getContent: () => '{"ok":false}' }), jsonResult_: value => ({ getContent: () => JSON.stringify(value) }),
    LockService: { getScriptLock: () => ({ tryLock: () => { locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    openExpectedSpreadsheet_: () => ({ getName: () => 'RBJJ M1 — TEST', getSheetByName: () => null }), signinsSheet_: () => ({}), readSignins_: () => ({ records: [] }),
    Utilities: { Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' }, newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }), computeDigest: (algorithm, text) => [...createHash(algorithm).update(text).digest()], computeHmacSha256Signature: (text, secret) => [...createHmac('sha256', secret).update(text).digest()] },
    UrlFetchApp: { fetch: (url, options) => { assert.equal(locked, false, 'Google read lock must be released before callback'); sent.push({ url, options }); return { getResponseCode: () => 200 }; }, getRequest: () => ({}) }
  });
  vm.runInContext(read('integrations/google-apps-script/GibM1ManagerReview.gs'), ctx);
  vm.runInContext(read('integrations/google-apps-script/GibM1TestReadCallback.gs'), ctx);
  const body = { token: env.GIB_TEST_WEBHOOK_TOKEN, adminActionToken: env.GIB_TEST_ADMIN_ACTION_TOKEN, target: 'test', gym: 'rev', action: 'managerReviewReadCallbackProof', from: '2026-09-07', to: '2026-09-23', adminName: 'Andrew Smith', binding: makeBinding(id, now) };
  return { ctx, sent, body };
}

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
