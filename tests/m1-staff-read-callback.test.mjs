import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { CALLBACK_URL, PROOF_ORIGIN, SIGNATURE_HEADER, STAFF_READ_PATH, STAFF_READ_BUDGET_MS,
  key, loadStaffCallbackRead, signature, staffReadHash, validateBinding } from '../netlify/functions/_lib/m1-test-read-callback.mjs';
import { handleReadResult } from '../netlify/functions/m1-test-read-result.mjs';
import { handleAdminStaffTime } from '../netlify/functions/m1-admin-staff-time.mjs';

const NOW = Date.parse('2026-09-28T17:00:00Z');
const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ID2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const VIEW = 'a'.repeat(64), REQUEST_TOKEN = 'A'.repeat(43);
const ENV = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRIVATE_TEST_RECEIVER/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-staff-callback-test-token-123456',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-staff-callback-admin-token-123456',
  GIB_M1_ADMIN_PASSPHRASE: 'Synthetic isolated test passphrase only' };
const CONTEXT = { site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' },
  deploy: { context: 'deploy-preview', published: false } };
const runtime = runtimeConfig(ENV, { admin: true, requestUrl: PROOF_ORIGIN + STAFF_READ_PATH });
function summary() {
  return { ok: true, target: 'test', staff: [], shiftStaff: [], clockedInNow: [],
    periods: { current: { startDate: '2026-09-21', endDate: '2026-10-04', totals: [] },
      previous: { startDate: '2026-09-07', endDate: '2026-09-20', totals: [] } },
    view: { token: VIEW, today: '2026-09-28', recordCount: 0, recordTotal: 0,
      todayPunchCount: 0, todayPunchTotal: 0, adjustmentCount: 0, adjustmentTotal: 0,
      attentionCount: 0, attentionOccurrenceCount: 0, auditCount: 0, auditTotal: 0,
      recordsTruncated: false, auditTruncated: false } };
}
function memory() {
  const entries = new Map(), writes = [];
  return { entries, writes,
    async getWithMetadata(name) { return entries.has(name) ? { data: structuredClone(entries.get(name)), etag: 'etag' } : null; },
    async set(name, value, options) { assert.equal(options.onlyIfNew, true); writes.push(name);
      if (entries.has(name)) return { modified: false };
      entries.set(name, JSON.parse(value)); return { modified: true }; },
    async *list() { yield { blobs: [...entries.keys()].map(key => ({ key })) }; },
    async delete(name) { entries.delete(name); } };
}
function request(body = { operation: 'review' }, options = {}) {
  const origin = options.origin || PROOF_ORIGIN;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-GIB-M1-Read-ID': options.id ?? ID,
    'Sec-Fetch-Site': 'same-origin' };
  if (options.auth !== false) {
    headers.Cookie = `${ADMIN_COOKIE}=${encodeURIComponent(createAdminSession(options.reviewer || 'Andrew Smith', runtime.sessionSecret, NOW, REQUEST_TOKEN))}`;
    headers[ADMIN_REQUEST_HEADER] = REQUEST_TOKEN;
  }
  return new Request(origin + (options.path || STAFF_READ_PATH), { method: options.method || 'POST', headers,
    ...(options.method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
function harness(options = {}) {
  const store = options.store || memory(), tasks = [], wires = [], accepted = [], logs = [];
  let stamp = NOW;
  const h = { store, tasks, wires, accepted, logs, get now() { return stamp; }, set now(value) { stamp = value; } };
  const deps = { env: ENV, enabled: true, installationId: 'rev', store, now: NOW, dateNow: new Date(NOW),
    clock: () => stamp, traceLog: (...args) => logs.push(args.join(' ')),
    context: { ...CONTEXT, waitUntil: promise => tasks.push(promise) },
    sleep: async ms => { await nextTurn(); stamp += ms; if (options.onSleep) await options.onSleep(h); },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body); wires.push(body);
      assert.equal(init.redirect, 'manual');
      assert.ok(store.entries.has(key(body.binding.requestId, 'pending')), 'Persisted pending request precedes dispatch');
      if (options.onDispatch) return options.onDispatch(h, body, init);
      if (!options.missing) await h.callback(body, options.result || summary());
      // Model the captured failure: Google read and callback succeeded but its
      // ordinary ContentService reply is unusable. No follow or fallback occurs.
      throw new TypeError('Synthetic private ContentService transport failure');
    } };
  h.deps = deps;
  h.callback = async (body, result, change = value => value) => {
    const payload = change({ binding: structuredClone(body.binding), readAt: stamp, result });
    const raw = JSON.stringify(payload);
    const response = await handleReadResult(new Request(CALLBACK_URL, { method: 'POST',
      headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signature(raw, runtime.adminActionToken) }, body: raw }), deps);
    accepted.push(response.status);
    return response;
  };
  h.load = (action = 'staffTimeReviewV2', data = {}, req = request()) => loadStaffCallbackRead(req, runtime, 'Andrew Smith', action, data, deps);
  h.finish = async () => { await Promise.all(tasks); };
  return h;
}

test('real endpoint returns a complete authenticated persisted Staff read despite failed ordinary Google reply', async () => {
  const h = harness();
  const response = await handleAdminStaffTime(request(), h.deps);
  const body = await response.json(); await h.finish();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-GIB-M1-Read-ID'), ID);
  assert.equal(body.ok, true); assert.equal(body.adminName, 'Andrew Smith');
  assert.deepEqual(body.view, summary().view);
  assert.equal(h.wires.length, 1); assert.deepEqual(h.accepted, [200]);
  assert.equal(h.wires[0].action, 'managerReviewReadCallbackProof');
  assert.equal(h.wires[0].binding.staffAction, 'staffTimeReviewV2');
  assert.equal(h.wires[0].binding.originalHash, staffReadHash({ action: 'staffTimeReviewV2', data: {} }, 'Andrew Smith'));
  assert.ok(h.store.entries.has(key(ID, 'result')));
  const logs = h.logs.join('\n');
  for (const secret of [...Object.values(ENV), REQUEST_TOKEN, VIEW, 'Andrew Smith']) assert.ok(!logs.includes(secret));
});

test('all five read contracts are checked and preserve successful response shape', async () => {
  const cases = [
    ['staffTimeReviewV2', {}, summary()],
    ['staffTimeReviewPageV2', { viewToken: VIEW, stream: 'attention', offset: 0 }, { ok: true, target: 'test', viewToken: VIEW,
      stream: 'attention', offset: 0, items: [{ staffId: 'test-staff', staffName: 'TEST Staff', code: 'missing_clock_out',
        message: 'Synthetic missing finish', linkedPunchIds: [], occurrenceCount: 1 }], nextOffset: null }],
    ['staffTimeHistoryPageV2', { viewToken: VIEW, offset: 0 }, { ok: true, target: 'test', viewToken: VIEW, offset: 0, total: 0, items: [], nextOffset: null }],
    ['staffTimeShiftLookupV3', { viewToken: VIEW, mode: 'recent', staffId: '', date: '' }, { ok: true, target: 'test', viewToken: VIEW,
      mode: 'recent', staffId: '', date: '', dateFrom: '2026-09-22', dateThrough: '2026-09-28', total: 0, items: [], truncated: false }],
    ['staffRecoveryReview', {}, { ok: true, target: 'test', recovery: { enabled: true, items: [] } }]
  ];
  for (const [action, data, result] of cases) {
    const h = harness({ result });
    assert.deepEqual(await h.load(action, data), { readable: true, status: 200, value: result });
    await h.finish(); assert.deepEqual(h.accepted, [200]);
    assert.deepEqual(h.wires[0].original, { action, data });
  }
});

test('only exact stale and too-large typed failures survive; incomplete success never becomes clear', async () => {
  for (const result of [{ ok: true, target: 'test' }, { ...summary(), unexpected: true },
    { ok: false, target: 'test', result: 'stale' }, { ok: false, target: 'test', result: 'failed' },
    { ...summary(), target: 'production' }]) {
    const h = harness({ result });
    await assert.rejects(h.load(), error => error.status === 503);
    await h.finish(); assert.deepEqual(h.accepted, [422]); assert.equal(h.store.entries.has(key(ID, 'result')), false);
  }
  const h = harness({ result: { ok: false, target: 'test', result: 'too_large' } });
  const value = await h.load('staffTimeShiftLookupV3', { viewToken: VIEW, mode: 'recent', staffId: '', date: '' });
  assert.equal(value.value.result, 'too_large'); await h.finish();
  const stale = harness({ result: { ok: false, target: 'test', result: 'stale' } });
  const response = await handleAdminStaffTime(request({ operation: 'reviewPage', viewToken: VIEW, stream: 'attention', offset: 0 }), stale.deps);
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'STAFF_TIME_VIEW_STALE'); await stale.finish();
});

test('missing callback is bounded at original 25 seconds and an ordinary success is not accepted', async () => {
  const h = harness({ onDispatch: async () => new Response(JSON.stringify(summary())) });
  const response = await handleAdminStaffTime(request(), h.deps);
  assert.equal(response.status, 502);
  const body = await response.json(); assert.equal(body.ok, false); assert.ok(!Object.hasOwn(body, 'view'));
  assert.equal(h.now - NOW, STAFF_READ_BUDGET_MS); assert.equal(h.wires.length, 1); await h.finish();
});

test('a valid callback at 24 seconds is accepted without shortening the original budget', async () => {
  let original;
  const h = harness({ onDispatch: async (_h, body) => { original = body; return new Response(null, { status: 502 }); },
    onSleep: async h => { if (h.now - NOW === 24_000) await h.callback(original, summary()); } });
  assert.equal((await h.load()).readable, true); await h.finish();
  assert.equal(h.now - NOW, 24_000); assert.deepEqual(h.accepted, [200]);
});

test('storage write/readback consume the same deadline and cannot dispatch after it', async () => {
  for (const boundary of ['write', 'readback']) {
    const h = harness();
    if (boundary === 'write') { const original = h.store.set; h.store.set = async (...args) => { const result = await original(...args); h.now += 25_001; return result; }; }
    else { const original = h.store.getWithMetadata; h.store.getWithMetadata = async (...args) => { const result = await original(...args); h.now += 25_001; return result; }; }
    await assert.rejects(h.load(), error => error.status === 503); await h.finish(); assert.equal(h.wires.length, 0);
  }
});

test('a stored callback does not permit a final storage read to exceed the same deadline', async () => {
  const h = harness();
  const read = h.store.getWithMetadata;
  h.store.getWithMetadata = async (name, ...args) => {
    const result = await read(name, ...args);
    if (name.endsWith('/result') && h.accepted.includes(200)) h.now += 25_001;
    return result;
  };
  await assert.rejects(h.load(), error => error.status === 503); await h.finish();
  assert.ok(h.store.entries.has(key(ID, 'result')), 'Original signed evidence is retained even after the caller budget ends');
  assert.equal(h.wires.length, 1);
});

test('same-ID overlapping reads dispatch once; different IDs keep separate immutable results', async () => {
  const h = harness();
  const both = await Promise.all([h.load(), h.load()]); await h.finish();
  assert.ok(both.every(result => result.readable)); assert.equal(h.wires.length, 1);
  assert.equal(h.store.writes.filter(name => name === key(ID, 'result')).length, 1);
  const other = harness();
  await Promise.all([other.load(), other.load('staffTimeReviewV2', {}, request({}, { id: ID2 }))]); await other.finish();
  assert.equal(other.wires.length, 2); assert.ok(other.store.entries.has(key(ID, 'result'))); assert.ok(other.store.entries.has(key(ID2, 'result')));
});

test('conflicting request identity, callback binding, late result and changed page token stay blocked', async () => {
  const h = harness(); await h.load(); await h.finish();
  await assert.rejects(h.load('staffRecoveryReview', {}), error => error.status === 409);
  assert.equal(h.wires.length, 1);
  const body = h.wires[0], saved = structuredClone(h.store.entries.get(key(ID, 'result')));
  assert.equal((await h.callback(body, summary(), payload => { payload.binding.originalHash = 'b'.repeat(64); return payload; })).status, 409);
  assert.deepEqual(h.store.entries.get(key(ID, 'result')), saved);
  h.now = NOW + 60_000; assert.equal((await h.callback(body, summary())).status, 410);
  assert.deepEqual(h.store.entries.get(key(ID, 'result')), saved);
  const page = harness({ result: { ok: true, target: 'test', viewToken: 'b'.repeat(64), offset: 0, total: 0, items: [], nextOffset: null } });
  await assert.rejects(page.load('staffTimeHistoryPageV2', { viewToken: VIEW, offset: 0 }), error => error.status === 503);
  await page.finish(); assert.deepEqual(page.accepted, [422]);
});

test('storage failures never dispatch without confirmed pending or fabricate a successful result', async () => {
  for (const boundary of ['pending', 'readback', 'result']) {
    const h = harness();
    if (boundary === 'readback') h.store.getWithMetadata = async () => { throw new Error('Synthetic storage failure'); };
    else { const write = h.store.set; h.store.set = async (name, ...args) => { if (name.endsWith('/' + boundary)) throw new Error('Synthetic storage failure'); return write(name, ...args); }; }
    await assert.rejects(h.load()); await h.finish();
    assert.equal(h.store.entries.has(key(ID, 'result')), false);
    assert.equal(h.wires.length, boundary === 'result' ? 1 : 0);
  }
});

test('scope, login, request token, read actions and supported lifecycle fail closed before storage', async () => {
  const cases = [
    [request({}, { auth: false })], [request({}, { reviewer: 'Stuart Turner' })],
    [request({}, { method: 'GET' })], [request({}, { origin: 'https://gib-live.netlify.app' })],
    [request({}, { origin: 'https://deploy-preview-90--gib-live.netlify.app' })],
    [request({}, { path: '/api/m1-manager-review' })], [request(), 'staffTimeVoid'],
    [request(), 'staffRecoveryDecide'], [request(), 'staffTimeReviewV2', { operation: 'review' }]
  ];
  for (const [req, action = 'staffTimeReviewV2', data = {}] of cases) {
    const h = harness(); await assert.rejects(h.load(action, data, req));
    assert.equal(h.wires.length, 0); assert.equal(h.store.writes.length, 0);
  }
  const h = harness(); delete h.deps.context.waitUntil;
  await assert.rejects(h.load(), error => error.status === 503); assert.equal(h.store.writes.length, 0);
  const endpoint = await handleAdminStaffTime(request(), h.deps);
  assert.equal(endpoint.status, 502); assert.equal((await endpoint.json()).ok, false); assert.equal(h.store.writes.length, 0);
  const richmond = harness(); richmond.deps.installationId = 'richmond';
  await assert.rejects(richmond.load(), error => error.status === 403); assert.equal(richmond.store.writes.length, 0);
  const noToken = harness(), invalidSessionRequest = request(); invalidSessionRequest.headers.delete(ADMIN_REQUEST_HEADER);
  await assert.rejects(noToken.load('staffTimeReviewV2', {}, invalidSessionRequest), error => error.status === 403);
  assert.equal(noToken.store.writes.length, 0);
  const valid = harness(); await valid.load(); await valid.finish();
  const binding = valid.store.entries.get(key(ID, 'pending')).binding;
  assert.throws(() => validateBinding({ ...binding, schema: 'm1-manager-read-callback/v1', target: 'production' }, NOW, 'production'));
});

test('malformed browser correlation is replaced safely, cleanup failure cannot spoil a valid read', async () => {
  const h = harness(); h.deps.cleanupStore = { async *list() { throw new Error('Synthetic cleanup failure'); } };
  assert.equal((await h.load('staffTimeReviewV2', {}, request({}, { id: 'PRIVATE not a UUID' }))).readable, true);
  await h.finish(); assert.notEqual(h.wires[0].binding.requestId, 'PRIVATE not a UUID');
  assert.ok(h.store.entries.has(key(h.wires[0].binding.requestId, 'result')));
});

test('real endpoint leaves mutation dispatch unchanged and needs no callback lifecycle for writes', async () => {
  const wires = [], deps = { env: ENV, enabled: true, installationId: 'rev', context: CONTEXT, now: NOW, dateNow: new Date(NOW),
    fetch: async (_url, init) => { wires.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: false, result: 'rejected', message: 'Synthetic rejection' })); } };
  const response = await handleAdminStaffTime(request({ operation: 'void', requestId: 'gib-m1-staff-request-12345678-1234-4123-8123-123456789abc',
    punchId: 'gib-m1-staff-12345678-1234-4123-8123-123456789abc', reason: 'Synthetic review' }), deps);
  assert.equal(response.status, 400); assert.equal(wires.length, 1); assert.equal(wires[0].action, 'staffTimeVoid');
  assert.equal(Object.hasOwn(wires[0], 'binding'), false); assert.equal(response.headers.get('X-GIB-M1-Read-ID'), null);
});
