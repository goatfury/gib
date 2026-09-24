import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { handleManagerReview } from '../netlify/functions/m1-manager-review.mjs';
import { handleReadProof } from '../netlify/functions/m1-test-read-proof.mjs';
import { handleReadResult } from '../netlify/functions/m1-test-read-result.mjs';
import { managerReviewScope } from '../netlify/functions/_lib/m1-manager-scope.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { datesThrough, dayPlan } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { emptyAddedClasses, publicAddedClasses } from '../netlify/functions/_lib/m1-added-classes.mjs';
import { CALLBACK_URL, LIVE_ORIGIN, PROOF_ORIGIN, SIGNATURE_HEADER, callbackURL, callbackRuntime, cleanupExpiredReads, key, makeBinding, signature } from '../netlify/functions/_lib/m1-test-read-callback.mjs';

const now = Date.parse('2026-09-23T17:30:00Z');
const id = '00000000-0000-4000-8000-000000000001';
const env = {
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-test-transport-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-test-admin-1234567890abcdef',
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'synthetic-production-transport-1234567890',
  GIB_M1_ADMIN_ACTION_TOKEN: 'synthetic-production-admin-1234567890abcdef',
  GIB_M1_ADMIN_PASSPHRASE: 'Synthetic private reviewer passphrase 123!'
};
const context = { site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' }, deploy: { id: 'synthetic-live', context: 'production', published: true } };
const scope = { enabled: true, target: 'production', context, installationId: 'rev', env };
const runtime = runtimeConfig(env, { admin: true, requestUrl: LIVE_ORIGIN, installationId: 'rev' });
const ledger = (target = 'production') => ({ ok: true, schema: 'm1-manager-review/v1', target, complete: true, gym: 'rev', from: '2026-09-07', to: '2026-09-23', days: datesThrough('2026-09-23').map(date => ({ date, attendanceHash: 'a'.repeat(64), records: date === '2026-09-22' ? [{ recordId: 'synthetic-existing-id', date, classLabel: '12:00 PM BJJ', instructor: 'Synthetic private instructor', duration: 1, reviewRequired: false }] : [], warnings: [], review: null })) });
function memory() {
  const entries = new Map();
  return { entries, async getWithMetadata(k) { const value = entries.get(k); return value ? { data: structuredClone(value), etag: 'etag' } : null; },
    async *list() { yield { blobs: [...entries.keys()].map(key => ({ key })) }; }, async delete(k) { entries.delete(k); },
    async set(k, value, options) { assert.equal(options.onlyIfNew, true); if (entries.has(k)) return { modified: false }; entries.set(k, JSON.parse(value)); return { modified: true }; } };
}
function admin(input = { action: 'read' }, origin = LIVE_ORIGIN, path = '/api/m1-manager-review') {
  const token = 'x'.repeat(43);
  const cookie = createAdminSession('Stuart Turner', runtime.sessionSecret, now, token);
  return new Request(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`, [ADMIN_REQUEST_HEADER]: token }, body: JSON.stringify(input) });
}
function callback(payload, { target = 'production', url = callbackURL(target), secret = env.GIB_M1_ADMIN_ACTION_TOKEN } = {}) {
  const raw = JSON.stringify(payload);
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signature(raw, secret, target) }, body: raw });
}
function harness(deliver = true) {
  const store = memory(), tasks = [], calls = [];
  let stamp = now;
  const deps = { ...scope, store, now, clock: () => stamp, traceLog() {}, context: { ...context, waitUntil: task => tasks.push(task) },
    schedule: { current: true, timezone: 'America/New_York', days: {} }, addedStore: { getWithMetadata: async () => null }, sleep: async ms => { stamp += ms; } };
  deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(url, env.GIB_M1_PRODUCTION_WEBHOOK_URL);
    assert.equal(body.action, 'managerReviewReadCallback');
    assert.equal(body.target, 'production');
    assert.equal(body.token, env.GIB_M1_PRODUCTION_WEBHOOK_TOKEN);
    assert.equal(body.adminActionToken, env.GIB_M1_ADMIN_ACTION_TOKEN);
    assert.ok(store.entries.has(key(body.binding.requestId, 'pending', 'production')));
    if (deliver) assert.equal((await handleReadResult(callback({ binding: body.binding, readAt: stamp, result: ledger() }), deps)).status, 200);
    return new Response(null, { status: 302 });
  };
  return { store, tasks, calls, deps, clock: value => { stamp = value; } };
}

test('live callback requires matching explicit build target, canonical origin, trusted site and published deployment', () => {
  const request = new Request(LIVE_ORIGIN + '/api/m1-manager-review');
  assert.equal(runtime?.target, 'production');
  assert.equal(managerReviewScope(request, scope)?.target, 'production');
  assert.equal(callbackRuntime(request, '/api/m1-manager-review', scope)?.target, 'production');
  for (const mismatch of [
    { enabled: false }, { target: 'test' }, { target: '' },
    { context: { ...context, deploy: { ...context.deploy, published: false } } },
    { context: { ...context, deploy: { ...context.deploy, context: 'deploy-preview' } } },
    { context: { ...context, site: { ...context.site, id: 'untrusted-site' } } },
    { installationId: 'richmond', environment: 'production', activation: 'active' }
  ]) assert.equal(managerReviewScope(request, { ...scope, ...mismatch }), null);
  for (const origin of [PROOF_ORIGIN, 'https://gib-richmond-live.netlify.app', 'https://synthetic--gib-live.netlify.app']) assert.equal(managerReviewScope(new Request(origin + '/api/m1-manager-review'), scope), null);
  assert.equal(callbackRuntime(new Request(LIVE_ORIGIN + '/api/m1-test-read-result'), '/api/m1-test-read-result', scope), null);
  assert.equal(callbackURL('production'), LIVE_ORIGIN + '/api/m1-manager-read-result');
  assert.equal(callbackURL('test'), CALLBACK_URL);
});

test('live badge stays aggregate-only while existing Admin authentication protects full attendance', async () => {
  const h = harness();
  const badge = await handleManagerReview(new Request(LIVE_ORIGIN + '/api/m1-manager-review'), h.deps);
  assert.equal(badge.status, 200, await badge.clone().text());
  const summary = await badge.json();
  assert.deepEqual(Object.keys(summary).sort(), ['asOf', 'ok', 'pendingDays']);
  assert.doesNotMatch(JSON.stringify(summary), /Synthetic|Stuart|recordId|2026-09-22/);
  assert.equal(h.calls[0].binding.action, 'managerReviewBadgeRead');
  assert.equal(Object.hasOwn(h.calls[0], 'adminName'), false);
  assert.equal(Object.hasOwn(h.store.entries.get(key(h.calls[0].binding.requestId, 'pending', 'production')), 'reviewer'), false);
  const unsigned = new Request(LIVE_ORIGIN + '/api/m1-manager-review', { method: 'POST', headers: { Origin: LIVE_ORIGIN, 'Content-Type': 'application/json' }, body: '{"action":"read"}' });
  assert.equal((await handleManagerReview(unsigned, h.deps)).status, 401);
  const response = await handleManagerReview(admin(), h.deps);
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  assert.equal(value.target, 'production'); assert.equal(value.test, false);
  assert.equal(value.days.find(day => day.date === '2026-09-22').classes[0].records[0].recordId, 'synthetic-existing-id');
  assert.equal(h.calls.at(-1).adminName, 'Stuart Turner');
  await Promise.all(h.tasks);
});

test('live production rejects proof, TEST transport controls and manager VOID before dispatch', async () => {
  const h = harness();
  assert.equal((await handleReadProof(admin({ operation: 'start', requestId: id }, LIVE_ORIGIN, '/api/m1-test-read-proof'), h.deps)).status, 403);
  for (const control of ['pre-pr', 'current', 'native-https', 'runtime']) assert.equal((await handleManagerReview(new Request(LIVE_ORIGIN + '/api/m1-manager-review', { headers: { 'X-GIB-M1-Transport-Control': control } }), h.deps)).status, 403);
  assert.equal((await handleManagerReview(admin({ action: 'void', recordId: 'synthetic-existing-id' }), h.deps)).status, 403);
  assert.equal(h.calls.length, 0); assert.equal(h.store.entries.size, 0);
});

test('identical IDs and even identical secrets cannot cross callback HMAC, pending keys or authoritative target', async () => {
  const h = harness();
  const binding = makeBinding(id, now, 'managerReviewRead', 'production');
  const payload = { binding, readAt: now, result: ledger() };
  const raw = JSON.stringify(payload);
  assert.notEqual(signature(raw, 'same-secret', 'test'), signature(raw, 'same-secret', 'production'));
  assert.notEqual(key(id, 'pending', 'test'), key(id, 'pending', 'production'));
  h.store.entries.set(key(id, 'pending', 'test'), { binding: makeBinding(id, now) });
  assert.equal((await handleReadResult(callback(payload), h.deps)).status, 404);
  h.store.entries.set(key(id, 'pending', 'production'), { binding, reviewer: 'Stuart Turner' });
  assert.equal((await handleReadResult(callback(payload, { target: 'test', url: callbackURL('production') }), h.deps)).status, 403);
  for (const mutate of [p => { p.binding.target = 'test'; }, p => { p.binding.schema = makeBinding(id, now).schema; }, p => { p.result.target = 'test'; }, p => { delete p.result.target; }, p => { p.binding.action = 'managerReviewSave'; }]) {
    const bad = structuredClone(payload); mutate(bad);
    assert.ok([409, 422].includes((await handleReadResult(callback(bad), h.deps)).status));
  }
  assert.equal((await handleReadResult(callback(payload), h.deps)).status, 200);
  const before = structuredClone([...h.store.entries]);
  assert.equal((await handleReadResult(callback(payload), h.deps)).status, 200);
  assert.deepEqual([...h.store.entries], before);
  const conflict = structuredClone(payload); conflict.result.days[0].attendanceHash = 'b'.repeat(64);
  assert.equal((await handleReadResult(callback(conflict), h.deps)).status, 409);
  h.clock(now + 60000);
  assert.equal((await handleReadResult(callback(payload), h.deps)).status, 410);
});

test('target-scoped cleanup preserves unexpired requests and other environments; unavailable cleanup cannot fail a delivered live read', async () => {
  const h = harness();
  const expired = '00000000-0000-4000-8000-000000000002';
  for (const [target, requestId, createdAt] of [['production', expired, now - 60000], ['production', id, now], ['test', expired, now - 60000]]) {
    h.store.entries.set(key(requestId, 'pending', target), { binding: makeBinding(requestId, createdAt, 'managerReviewRead', target) });
    h.store.entries.set(key(requestId, 'result', target), { fixture: true });
  }
  await cleanupExpiredReads(h.store, now, { target: 'production' });
  assert.equal(h.store.entries.has(key(expired, 'pending', 'production')), false);
  assert.equal(h.store.entries.has(key(expired, 'result', 'production')), false);
  assert.equal(h.store.entries.has(key(id, 'pending', 'production')), true);
  assert.equal(h.store.entries.has(key(expired, 'pending', 'test')), true);
  h.deps.cleanupStore = { async *list() { throw new Error('synthetic unavailable cleanup'); } };
  assert.equal((await handleManagerReview(admin(), h.deps)).status, 200);
  await Promise.all(h.tasks);
});

test('live read needs supported lifecycle and missing callback is unavailable, never an empty successful ledger', async () => {
  const absent = harness(); delete absent.deps.context.waitUntil;
  assert.equal((await handleManagerReview(admin(), absent.deps)).status, 503);
  assert.equal(absent.calls.length, 0);
  const h = harness(false);
  const response = await handleManagerReview(new Request(LIVE_ORIGIN + '/api/m1-manager-review'), h.deps);
  assert.equal(response.status, 503); assert.match((await response.json()).message, /Review status unavailable/);
  assert.equal(h.calls.length, 1);
  await Promise.all(h.tasks);
});

test('live save recovery preserves the original request check and never uses callback check:null', async () => {
  const h = harness();
  const day = ledger().days.find(day => day.date === '2026-09-22');
  const plan = dayPlan(day, h.deps.schedule, publicAddedClasses(emptyAddedClasses('rev', 'production'), now), new Date(now));
  const input = { action: 'partial', requestId: 'manager-synthetic-original-request', date: day.date,
    revision: plan.revision, attendanceHash: day.attendanceHash, scheduleHash: plan.scheduleHash, decisions: [] };
  const receipt = { saved: true, requestId: input.requestId, revision: 1 };
  h.deps.fetch = async (url, options) => {
    const body = JSON.parse(options.body); h.calls.push(body);
    assert.equal(body.action, 'managerReviewRead'); assert.deepEqual(body.check, input);
    return Response.json({ ...ledger(), receipt });
  };
  const response = await handleManagerReview(admin(input), h.deps);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).receipt, receipt);
  assert.equal(h.calls.length, 1); assert.equal(h.store.entries.size, 0); assert.equal(h.tasks.length, 0);
});

function google() {
  let locked = false, reads = 0, propertyWrites = 0;
  const sent = [], properties = new Map();
  const ctx = vm.createContext({ Date: class extends Date { static now() { return now + 100; } }, console: { log() {}, warn() {} },
    GIB_M1_ALLOWED_TARGET: 'production', GIB_M1_MANAGER_REVIEW_LIVE_ENABLED: true, EXPECTED_SPREADSHEET_NAME: 'RBJJ M1 — PRODUCTION', GIB_M1_ADMIN_NAMES_: ['Andrew Smith', 'Stuart Turner'],
    configuredDeploymentTarget_: () => 'production', requestTarget_: body => body.target, adminActionAuthorized_: body => body.token === env.GIB_M1_PRODUCTION_WEBHOOK_TOKEN && body.adminActionToken === env.GIB_M1_ADMIN_ACTION_TOKEN,
    todayNewYork_: () => '2026-09-23', rejectedAuthResult_: () => ({ getContent: () => '{"ok":false}' }), jsonResult_: value => ({ getContent: () => JSON.stringify(value) }),
    LockService: { getScriptLock: () => ({ tryLock: () => { assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    PropertiesService: { getScriptProperties: () => ({ getKeys: () => [...properties.keys()], getProperty: key => properties.get(key) || null, setProperty: (key, value) => { propertyWrites++; properties.set(key, value); }, deleteProperty: key => { propertyWrites++; properties.delete(key); } }) },
    openExpectedSpreadsheet_: () => ({ getName: () => 'RBJJ M1 — PRODUCTION', getSheetByName: () => null }), signinsSheet_: () => ({}), readSignins_: () => { assert.equal(locked, true); reads++; return { records: [] }; },
    Utilities: { Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' }, newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }), computeDigest: (algorithm, text) => [...createHash(algorithm).update(text).digest()], computeHmacSha256Signature: (text, secret) => [...createHmac('sha256', secret).update(text).digest()] },
    UrlFetchApp: { fetch: (url, options) => { assert.equal(locked, false, 'attendance lock released before external callback'); sent.push({ url, options }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, accepted: true, requestId: JSON.parse(options.payload).binding.requestId }) }; } }
  });
  for (const name of ['GibM1ManagerReview.gs', 'GibM1TestReadCallback.gs']) vm.runInContext(readFileSync(new URL(`../integrations/google-apps-script/${name}`, import.meta.url), 'utf8'), ctx);
  const body = { token: env.GIB_M1_PRODUCTION_WEBHOOK_TOKEN, adminActionToken: env.GIB_M1_ADMIN_ACTION_TOKEN, target: 'production', gym: 'rev', action: 'managerReviewReadCallback', from: '2026-09-07', to: '2026-09-23', adminName: 'Stuart Turner', binding: makeBinding(id, now, 'managerReviewRead', 'production') };
  return { ctx, body, sent, properties, stats: () => ({ reads, propertyWrites, locked }) };
}

test('Google live callback uses the fixed canonical URL, production signature and ordinary locked read with check:null', () => {
  const g = google();
  const read = g.ctx.managerReviewAction_;
  g.ctx.managerReviewAction_ = (body, trace) => { assert.equal(body.check, null); assert.equal(body.target, 'production'); return read(body, trace); };
  g.ctx.gibM1TestReadCallback_(g.body);
  assert.equal(g.sent.length, 1); assert.equal(g.sent[0].url, LIVE_ORIGIN + '/api/m1-manager-read-result');
  const { options } = g.sent[0], payload = JSON.parse(options.payload);
  assert.equal(payload.result.target, 'production'); assert.equal(payload.binding.schema, 'm1-manager-read-callback/v1');
  assert.equal(options.headers[SIGNATURE_HEADER], signature(options.payload, env.GIB_M1_ADMIN_ACTION_TOKEN, 'production'));
  assert.equal(options.followRedirects, false); assert.equal(options.validateHttpsCertificates, true);
  assert.deepEqual(g.stats(), { reads: 1, propertyWrites: 0, locked: false });
});

test('Google live mode rejects TEST fault and trace arms, cross-scope requests, disabled live gate and Richmond', () => {
  const g = google();
  for (const name of ['testRevolutionStartReadTrace', 'testRevolutionStopReadTrace', 'testRevolutionReadTraceReceipts', 'testRevolutionLateBadgeCallback', 'testRevolutionCallbackFaultReceipt', 'authorizeRevolutionTestReadCallback']) assert.throws(() => g.ctx[name](), /TEST project required/);
  assert.equal(g.stats().propertyWrites, 0);
  for (const mutate of [body => { body.target = 'test'; }, body => { body.gym = 'richmond'; }, body => { body.action = 'managerReviewReadCallbackProof'; }, body => { body.binding.target = 'test'; }, body => { body.binding.schema = 'm1-test-read-callback/v1'; }, body => { body.binding.action = 'managerReviewSave'; }]) {
    const body = structuredClone(g.body); mutate(body); g.ctx.gibM1TestReadCallback_(body);
  }
  g.ctx.GIB_M1_MANAGER_REVIEW_LIVE_ENABLED = false; g.ctx.gibM1TestReadCallback_(g.body);
  g.ctx.GIB_M1_MANAGER_REVIEW_LIVE_ENABLED = true; g.ctx.GIB_M1_RICHMOND_INSTALLATION_ = true; g.ctx.gibM1TestReadCallback_(g.body);
  assert.equal(g.sent.length, 0); assert.equal(g.stats().reads, 0); assert.equal(g.stats().propertyWrites, 0);
});
