import assert from 'node:assert/strict';
import test from 'node:test';
import { handleManagerReview } from '../netlify/functions/m1-manager-review.mjs';
import { handleReadResult } from '../netlify/functions/m1-test-read-result.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { CALLBACK_URL, PROOF_ORIGIN, READ_ID_HEADER, READ_OPERATION_HEADER, SIGNATURE_HEADER, key, signature, readCallbackTicket } from '../netlify/functions/_lib/m1-test-read-callback.mjs';
import { additionCheckHash } from '../netlify/functions/_lib/m1-admin-add-check-proof.mjs';

const startAt = Date.parse('2026-09-23T17:30:00Z');
const id = '00000000-0000-4000-8000-000000000001', secondId = '00000000-0000-4000-8000-000000000002';
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER/exec', GIB_TEST_WEBHOOK_TOKEN: 'synthetic-test-transport-1234567890', GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-test-admin-1234567890abcdef' };
const runtime = runtimeConfig(env, { admin: true, requestUrl: PROOF_ORIGIN });
const context = { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { id: 'synthetic', context: 'deploy-preview', published: false } };
const ledger = () => ({ ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true, gym: 'rev', from: '2026-09-07', to: '2026-09-23',
  days: datesThrough('2026-09-23').map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) });
function harness() {
  let stamp = startAt;
  const entries = new Map(), tasks = [], calls = [], stages = [];
  const store = {
    async getWithMetadata(k) { return entries.has(k) ? { data: structuredClone(entries.get(k)), etag: 'confirmed' } : null; },
    async set(k, raw, options) { assert.equal(options.onlyIfNew, true); if (entries.has(k)) return { modified: false }; entries.set(k, JSON.parse(raw)); return { modified: true }; },
    async *list() { yield { blobs: [...entries.keys()].map(key => ({ key })) }; },
    async delete(k) { entries.delete(k); }
  };
  const deps = { env, enabled: true, store, context: { ...context, waitUntil: p => tasks.push(p) }, clock: () => stamp,
    traceLog: (_, raw) => stages.push(JSON.parse(raw)), schedule: { current: true, timezone: 'America/New_York', days: {} }, addedStore: { getWithMetadata: async () => null },
    fetch: async (_, options) => { calls.push(JSON.parse(options.body)); return new Response(null, { status: 302 }); } };
  Object.defineProperty(deps, 'now', { enumerable: true, get: () => stamp });
  return { deps, entries, tasks, calls, stages, advance: ms => { stamp = startAt + ms; } };
}
function admin(operation = 'start', requestId = id, reviewer = 'Andrew Smith') {
  const token = 'x'.repeat(43), cookie = createAdminSession(reviewer, runtime.sessionSecret, startAt, token);
  return new Request(PROOF_ORIGIN + '/api/m1-manager-review', { method: 'POST', headers: { Origin: PROOF_ORIGIN, 'Content-Type': 'application/json',
    Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`, [ADMIN_REQUEST_HEADER]: token }, body: JSON.stringify({ action: 'read', readRequest: { operation, requestId } }) });
}
function badge(operation = 'start', requestId = secondId) {
  return new Request(PROOF_ORIGIN + '/api/m1-manager-review', { headers: { [READ_ID_HEADER]: requestId, [READ_OPERATION_HEADER]: operation } });
}
async function deliver(h, requestId = id, modify = () => {}) {
  const pending = h.entries.get(key(requestId, 'pending'));
  const value = { binding: structuredClone(pending.binding), readAt: h.deps.clock(), result: ledger() };
  modify(value);
  const raw = JSON.stringify(value);
  return handleReadResult(new Request(CALLBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signature(raw, env.GIB_TEST_ADMIN_ACTION_TOKEN) }, body: raw }), h.deps);
}

test('a callback at 35 seconds completes the same ticket through short responses and one Google dispatch', { timeout: 2000 }, async () => {
  const h = harness();
  h.deps.sleep = () => { throw new Error('The HTTP handler must not run the old waiting loop.'); };
  const first = await handleManagerReview(admin(), h.deps);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { ok: true, state: 'pending', requestId: id, deadlineAt: startAt + 50000, expiresAt: startAt + 60000 });
  await Promise.all(h.tasks);
  h.advance(31000);
  assert.equal((await handleManagerReview(admin('status'), h.deps)).status, 202);
  h.advance(35000);
  assert.equal((await deliver(h)).status, 200);
  const final = await handleManagerReview(admin('status'), h.deps);
  assert.equal(final.status, 200); assert.equal(final.headers.get(READ_ID_HEADER), id);
  const result = await final.json();
  assert.equal(result.days.length, 17); assert.equal(result.pendingDays, 17); assert.equal(result.target, 'test');
  assert.equal(h.calls.length, 1);
  assert.equal(h.entries.get(key(id, 'pending')).binding.createdAt, startAt);
  assert.equal(h.deps.clock(), startAt + 35000);
});

test('concurrent and repeated starts preserve the initial owner, deadline and single dispatch; status never dispatches', async () => {
  const h = harness();
  const responses = await Promise.all([handleManagerReview(admin(), h.deps), handleManagerReview(admin(), h.deps)]);
  assert.deepEqual(responses.map(r => r.status), [202, 202]);
  await Promise.all(h.tasks);
  h.advance(12000);
  assert.equal((await handleManagerReview(admin(), h.deps)).status, 202);
  assert.equal((await handleManagerReview(admin('status'), h.deps)).status, 202);
  assert.equal((await handleManagerReview(admin('status', id, 'Stuart Turner'), h.deps)).status, 409);
  assert.equal((await handleManagerReview(admin('start', id, 'Stuart Turner'), h.deps)).status, 409);
  assert.equal(h.entries.get(key(id, 'pending')).ticket.deadlineAt, startAt + 50000);
  assert.equal(h.calls.length, 1);
});

test('only confirmed absent storage permits same-ID start recovery; unavailable storage never claims a missing ticket', async () => {
  const h = harness(), get = h.deps.store.getWithMetadata;
  h.deps.store.getWithMetadata = async () => { throw new Error('Storage unavailable'); };
  const unavailable = await handleManagerReview(badge('status'), h.deps);
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).code, undefined);
  assert.equal(h.calls.length, 0);
  h.deps.store.getWithMetadata = get;
  const missing = await handleManagerReview(badge('status'), h.deps);
  assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'READ_TICKET_MISSING');
  assert.equal((await handleManagerReview(badge('start'), h.deps)).status, 202);
  assert.equal((await handleManagerReview(badge('start'), h.deps)).status, 202);
  await Promise.all(h.tasks);
  assert.equal(h.calls.length, 1);
});

test('an absent callback ends at the original 50-second deadline; no callback after expiry can succeed', async () => {
  const h = harness(); await handleManagerReview(badge(), h.deps); await Promise.all(h.tasks);
  h.advance(49999);
  assert.equal((await handleManagerReview(badge('status'), h.deps)).status, 202);
  h.advance(50000);
  for (const operation of ['status', 'start']) {
    const response = await handleManagerReview(badge(operation), h.deps);
    assert.equal(response.status, 410); assert.equal((await response.json()).pendingDays, undefined);
  }
  h.advance(60000);
  assert.equal((await deliver(h, secondId)).status, 410);
  assert.equal((await handleManagerReview(badge('status'), h.deps)).status, 410);
  assert.equal(h.calls.length, 1);
});

test('Admin and badge tickets stay separate and aggregate-only; malformed, unauthorized or unknown status calls never dispatch', async () => {
  const h = harness();
  const unsigned = new Request(PROOF_ORIGIN + '/api/m1-manager-review', { method: 'POST', body: JSON.stringify({ action: 'read', readRequest: { operation: 'start', requestId: id } }) });
  assert.equal((await handleManagerReview(unsigned, h.deps)).status, 401);
  assert.equal((await handleManagerReview(badge('status'), h.deps)).status, 404);
  assert.equal((await handleManagerReview(badge('other'), h.deps)).status, 400);
  assert.equal((await handleManagerReview(badge('start', 'invalid-id'), h.deps)).status, 400);
  assert.equal(h.calls.length, 0);
  await Promise.all([handleManagerReview(admin(), h.deps), handleManagerReview(badge(), h.deps)]); await Promise.all(h.tasks);
  assert.equal((await handleManagerReview(badge('status', id), h.deps)).status, 409);
  assert.equal((await handleManagerReview(admin('status', secondId), h.deps)).status, 409);
  h.advance(3000); await deliver(h); await deliver(h, secondId);
  const value = await (await handleManagerReview(badge('status'), h.deps)).json();
  assert.deepEqual(Object.keys(value).sort(), ['asOf', 'ok', 'pendingDays']);
  assert.equal(h.calls.length, 2);
  assert.equal(Object.hasOwn(h.calls.find(call => call.binding.action === 'managerReviewBadgeRead'), 'adminName'), false);
});

test('a ticket cannot deliver mismatched, corrupt, incomplete or now-expired authoritative data', async () => {
  for (const mode of ['binding', 'incomplete', 'corrupt', 'deadline', 'schedule']) {
    const h = harness(); await handleManagerReview(admin(), h.deps); await Promise.all(h.tasks); h.advance(2000);
    const received = await deliver(h, id, value => { if (mode === 'binding') value.binding.action = 'managerReviewBadgeRead'; if (mode === 'incomplete') value.result.days.pop(); });
    if (['binding', 'incomplete'].includes(mode)) assert.equal(received.status, mode === 'binding' ? 409 : 422);
    else assert.equal(received.status, 200);
    if (mode === 'corrupt') h.entries.get(key(id, 'result')).digest = 'corrupt';
    if (mode === 'deadline') h.advance(50000);
    if (mode === 'schedule') h.deps.schedule.current = false;
    const response = await handleManagerReview(admin('status'), h.deps);
    assert.notEqual(response.status, 200, mode); assert.equal((await response.json()).pendingDays, undefined, mode);
    assert.equal(h.calls.length, 1, mode);
  }
});

test('a callback validated before a slow calendar read cannot be delivered after its deadline or after local midnight', async () => {
  for (const mode of ['deadline', 'midnight']) {
    const h = harness();
    const offset = mode === 'midnight' ? Date.parse('2026-09-24T03:59:59Z') - startAt : 0;
    h.advance(offset);
    assert.equal((await handleManagerReview(badge(), h.deps)).status, 202);
    await Promise.all(h.tasks);
    assert.equal((await deliver(h, secondId)).status, 200);
    h.deps.addedStore.getWithMetadata = async () => { h.advance(offset + (mode === 'midnight' ? 2000 : 50000)); return null; };
    const response = await handleManagerReview(badge('status'), h.deps);
    assert.equal(response.status, 410, mode);
    const value = await response.json();
    assert.equal(value.ok, false, mode); assert.equal(value.pendingDays, undefined, mode);
    assert.equal(h.calls.length, 1, mode);
  }
});

test('addition proof tickets bind the exact original and owner, reject cross-purpose results and enforce the full ledger range', async () => {
  const h = harness();
  const original = { requestId: 'm1-2026-09-23-111111112222222233333333', date: '2026-09-23', classLabel: '6:00 PM TEST class', duration: 1,
    instructor: 'TEST retained instructor', site: 'Rev', notes: 'DO NOT PAY', reason: 'TEST preserved addition' };
  const request = new Request(PROOF_ORIGIN + '/api/m1-admin-add-check', { method: 'POST' });
  const options = { operation: 'start', requestId: id, action: 'adminAdditionCheckRead', original };
  assert.equal((await readCallbackTicket(request, runtime, 'Andrew Smith', options, h.deps)).state, 'pending');
  await Promise.all(h.tasks);
  assert.deepEqual(h.calls[0].original, original);
  assert.equal(h.calls[0].binding.originalHash, additionCheckHash(original, 'Andrew Smith', 'test'));
  assert.equal(h.calls[0].binding.date, original.date);
  for (const changed of [{ ...original, reason: 'Changed reason' }, { ...original, requestId: original.requestId.replace(/3$/, '4') }]) {
    await assert.rejects(() => readCallbackTicket(request, runtime, 'Andrew Smith', { ...options, operation: 'status', original: changed }, h.deps), { status: 409 });
  }
  await assert.rejects(() => readCallbackTicket(request, runtime, 'Stuart Turner', { ...options, operation: 'status' }, h.deps), { status: 409 });
  assert.equal((await deliver(h)).status, 422, 'a normal ledger cannot satisfy an addition proof');
  const additionResult = () => ({ ok: true, schema: 'm1-admin-addition-check/v1', target: 'test', gym: 'rev',
    originalHash: additionCheckHash(original, 'Andrew Smith', 'test'), date: original.date, reviewer: 'Andrew Smith',
    dailyRead: { ok: true, test: true, adminName: 'Andrew Smith', date: original.date, records: [], warnings: [], auditHistory: [] }, ledger: ledger() });
  for (const mode of ['date', 'range']) {
    const response = await deliver(h, id, value => {
      value.result = additionResult();
      if (mode === 'date') value.result.date = '2026-09-22';
      else { value.result.ledger.to = '2026-09-24'; value.result.ledger.days.push({ date: '2026-09-24', attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null }); }
    });
    assert.equal(response.status, 422, mode);
  }
  assert.equal((await deliver(h, id, value => { value.result = additionResult(); })).status, 200);
  const confirmed = await readCallbackTicket(request, runtime, 'Andrew Smith', { ...options, operation: 'status' }, h.deps);
  assert.equal(confirmed.state, 'received'); assert.equal(confirmed.result.schema, 'm1-admin-addition-check/v1');
  assert.equal(h.calls.length, 1);
});

test('unconfirmed pending persistence or missing lifecycle schedules no Google request', async () => {
  for (const mode of ['write', 'uncertain', 'readback', 'lifecycle']) {
    const h = harness();
    if (mode === 'write') h.deps.store.set = async () => { throw new Error('unavailable'); };
    if (mode === 'uncertain') { const set = h.deps.store.set; h.deps.store.set = async (...args) => { await set(...args); }; }
    if (mode === 'readback') h.deps.store.getWithMetadata = async () => null;
    if (mode === 'lifecycle') delete h.deps.context.waitUntil;
    assert.equal((await handleManagerReview(admin(), h.deps)).status, 503, mode);
    assert.equal(h.calls.length, 0, mode);
  }
});

test('the owned bounded watcher cancels a blocked ordinary reply only after persisted callback validation', { timeout: 2000 }, async () => {
  const h = harness(), waiters = [];
  let signal;
  h.deps.sleep = () => new Promise(resolve => waiters.push(resolve));
  h.deps.fetch = (_, options) => {
    h.calls.push(JSON.parse(options.body)); signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const first = await handleManagerReview(admin(), h.deps);
  assert.equal(first.status, 202); assert.equal(signal.aborted, false);
  while (!waiters.length) await new Promise(resolve => setImmediate(resolve));
  h.advance(3000); assert.equal((await deliver(h)).status, 200);
  waiters.splice(0).forEach(resolve => resolve());
  await Promise.all(h.tasks);
  assert.equal(signal.aborted, true);
  assert.equal(h.entries.get(key(id, 'dispatch')).outcome, 'callback-confirmed');
  assert.equal((await handleManagerReview(admin('status'), h.deps)).status, 200);
  assert.equal(h.calls.length, 1);
});

test('the watcher settles with an ordinary reply instead of holding the start until its observation deadline', { timeout: 2000 }, async () => {
  const h = harness();
  h.deps.watchStore = { getWithMetadata: () => new Promise(() => {}) };
  assert.equal((await handleManagerReview(admin(), h.deps)).status, 202);
  await Promise.all(h.tasks);
  assert.equal(h.entries.get(key(id, 'dispatch')).outcome, 'ordinary-reply-discarded');
  assert.equal(h.deps.clock(), startAt);
});
