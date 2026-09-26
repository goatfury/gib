import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { sanitizeStaffClockPunch, sanitizeStaffRecoveryRequest, sanitizeStaffRecoveryDecisionRequest,
  sanitizeStaffRecoveryResponse, sanitizeStaffViewPage } from '../netlify/functions/_lib/m1-staff-clock-contracts.mjs';
import { STAFF_CLOCK_PATH, handleStaffClock } from '../netlify/functions/m1-staff-clock.mjs';
import { ADMIN_STAFF_TIME_PATH, handleAdminStaffTime } from '../netlify/functions/m1-admin-staff-time.mjs';

const ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
const NOW = new Date('2026-09-25T15:00:00Z');
const ENV = {
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RECOVERY_TEST_RECEIVER/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-staff-recovery-transport-0123456789',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-staff-recovery-admin-9876543210'
};
const CONTEXT = { site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' },
  deploy: { context: 'deploy-preview', published: false } };
const punchId = n => `gib-m1-staff-${String(n).padStart(8, '0')}-1234-4123-8123-123456789abc`;
const requestId = n => `gib-m1-staff-request-${String(n).padStart(8, '0')}-1234-4123-8123-123456789abc`;
function punch() { return { punchId: punchId(2), timestamp: '2026-09-25T09:00:00-04:00', date: '2026-09-25',
  staffId: 'test-staff', staffName: 'TEST Staff', punchAction: 'clockIn', site: 'Rev', device: 'TEST tablet', build: 'staff-test', note: '' }; }
function start() { return { operation: 'recover', requestId: requestId(4), previousClockInPunchId: punchId(1),
  punch: punch(), proposedFinishAt: '2026-09-24T20:00:00-04:00' }; }
function decision(overrides = {}) { return { operation: 'recoveryDecide', requestId: requestId(5), recoveryRequestId: requestId(4),
  revision: 0, decision: 'approve', finishAt: '2026-09-24T20:00:00-04:00', punchId: punchId(3), reason: 'Verified actual finish', ...overrides }; }
function decisionReceipt(request = decision(), overrides = {}) { const { operation, ...body } = request; return {
  ...body, revision: request.revision + 1, adminName: 'Andrew Smith', decidedAt: '2026-09-25T09:02:00-04:00', ...overrides }; }
function item(overrides = {}) { const s = start(); return { requestId: s.requestId, staffId: s.punch.staffId, staffName: s.punch.staffName,
  previousClockInPunchId: s.previousClockInPunchId, previousClockInAt: '2026-09-24T18:00:00-04:00',
  newClockInPunchId: s.punch.punchId, startedAt: s.punch.timestamp, proposedFinishAt: s.proposedFinishAt,
  proposedBy: s.punch.staffName, proposedAt: '2026-09-25T09:00:03-04:00', status: 'pending', revision: 0,
  decision: null, punch: s.punch, conflicts: [], ...overrides }; }
function readResult(items = [item()]) { return { ok: true, target: 'test', recovery: { enabled: true, items } }; }
function startResult(items) { const s = start(); return { ...readResult(items), receipt: {
  requestId: s.requestId, previousClockInPunchId: s.previousClockInPunchId, newClockInPunchId: s.punch.punchId,
  startedAt: s.punch.timestamp, proposedFinishAt: s.proposedFinishAt, status: 'pending' } }; }
function decisionResult(request = decision()) { const receipt = decisionReceipt(request); return { ...readResult([item({
  status: request.decision === 'approve' ? 'approved' : 'rejected', revision: receipt.revision, decision: receipt })]), receipt }; }
const options = expected => ({ now: NOW, expected });
function req(body, { admin = false, origin = ORIGIN, auth = true, headerToken = 'A'.repeat(43) } = {}) {
  const path = admin ? ADMIN_STAFF_TIME_PATH : STAFF_CLOCK_PATH;
  const headers = { 'Content-Type': 'application/json', Origin: origin, Host: new URL(origin).host, 'Sec-Fetch-Site': 'same-origin' };
  if (admin && auth) {
    const runtime = runtimeConfig(ENV, { admin: true, requestUrl: `${ORIGIN}${path}` });
    headers.Cookie = `${ADMIN_COOKIE}=${encodeURIComponent(createAdminSession('Andrew Smith', runtime.sessionSecret, +NOW, 'A'.repeat(43)))}`;
    headers[ADMIN_REQUEST_HEADER] = headerToken;
  }
  return new Request(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
function dependencies(value, overrides = {}) {
  const calls = [];
  return { env: ENV, enabled: true, installationId: 'rev', environment: 'production', context: CONTEXT,
    now: +NOW, dateNow: NOW, clock: () => +NOW, calls, fetch: async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) });
      if (value instanceof Error) throw value;
      return value instanceof Response ? value.clone() : new Response(JSON.stringify(value)); }, ...overrides };
}

test('recovery request contracts retain exact permanent IDs and require a valid TEST clock-in and NY times', () => {
  assert.deepEqual(sanitizeStaffRecoveryRequest(start(), { now: NOW, requireTestName: true }), start());
  for (const mutate of [s => { s.extra = true; }, s => { s.requestId = punchId(4); },
    s => { s.previousClockInPunchId = s.punch.punchId; }, s => { s.punch.punchAction = 'clockOut'; },
    s => { s.punch.site = 'Richmond'; }, s => { s.punch.staffName = 'Actual Staff'; },
    s => { s.proposedFinishAt = '2026-09-25T10:00:00-04:00'; },
    s => { s.proposedFinishAt = '2026-09-24T20:00:00-05:00'; },
    s => { s.punch.timestamp = '2026-09-25T09:00:00.000-04:00'; },
    s => { s.punch.recoveryRequestId = s.requestId; }]) {
    const s = start(); mutate(s); assert.equal(sanitizeStaffRecoveryRequest(s, { now: NOW, requireTestName: true }), null);
  }
  const unknown = start(); unknown.proposedFinishAt = null;
  assert.ok(sanitizeStaffRecoveryRequest(unknown, { now: NOW }));
});

test('Admin decision requests bind revision and require an exact reason, finish and separate punch', () => {
  assert.ok(sanitizeStaffRecoveryDecisionRequest(decision(), options()));
  assert.ok(sanitizeStaffRecoveryDecisionRequest(decision({ decision: 'reject', finishAt: null, punchId: null }), options()));
  for (const override of [{ adminName: 'Stuart Turner' }, { revision: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER },
    { reason: '' }, { reason: '=formula' }, { finishAt: null }, { punchId: null }, { decision: 'reject' },
    { requestId: requestId(4) }, { finishAt: '2026-09-25T20:00:00-04:00' }]) {
    assert.equal(sanitizeStaffRecoveryDecisionRequest(decision(override), options()), null);
  }
});

test('whole recovery response rejects mismatched punch proof, status, chronology and duplicate identities', () => {
  assert.ok(sanitizeStaffRecoveryResponse(readResult(), 'test', options()));
  for (const mutate of [v => { v.extra = true; }, v => { v.target = 'production'; },
    v => { v.recovery.enabled = false; }, v => { v.recovery.items.push(structuredClone(v.recovery.items[0])); },
    v => { v.recovery.items[0].staffName = 'TEST Other'; }, v => { v.recovery.items[0].punch.note = '=formula'; },
    v => { v.recovery.items[0].proposedBy = 'Stuart Turner'; }, v => { v.recovery.items[0].revision = 1; },
    v => { v.recovery.items[0].previousClockInAt = '2026-09-25T10:00:00-04:00'; },
    v => { v.recovery.items[0].previousClockInAt = '2026-09-23T10:00:00-04:00'; },
    v => { v.recovery.items[0].proposedAt = '2026-09-25T08:00:00-04:00'; },
    v => { v.recovery.items[0].punch.punchAction = 'clockOut'; },
    v => { v.recovery.items[0].status = 'approved'; },
    v => { v.recovery.items.push(item({ requestId: requestId(9) })); }]) {
    const value = readResult(); mutate(value); assert.equal(sanitizeStaffRecoveryResponse(value, 'test', options()), null);
  }
});

test('start confirmation binds the complete original punch and stays immutable after a decision', () => {
  assert.ok(sanitizeStaffRecoveryResponse(startResult(), 'test', options(start())));
  const decided = decisionResult().recovery.items;
  assert.ok(sanitizeStaffRecoveryResponse(startResult(decided), 'test', options(start())));
  for (const mutate of [v => { v.receipt.status = 'approved'; }, v => { v.receipt.startedAt = '2026-09-25T08:00:00-04:00'; },
    v => { v.recovery.items = []; }, v => { v.recovery.items[0].punch.note = 'different'; },
    v => { v.receipt.requestId = requestId(9); }, v => { v.receipt.extra = true; }]) {
    const value = startResult(); mutate(value); assert.equal(sanitizeStaffRecoveryResponse(value, 'test', options(start())), null);
  }
});

test('decision confirmation binds the trusted reviewer, original request and next revision', () => {
  const expected = { ...decision(), adminName: 'Andrew Smith' };
  assert.ok(sanitizeStaffRecoveryResponse(decisionResult(), 'test', options(expected)));
  for (const mutate of [v => { v.receipt.adminName = 'Stuart Turner'; }, v => { v.receipt.reason = 'other reason'; },
    v => { v.receipt.revision = 3; }, v => { v.receipt.requestId = requestId(9); },
    v => { v.recovery.items[0].decision = null; }, v => { v.recovery.items[0].revision = 0; },
    v => { v.recovery.items[0].decision.punchId = punchId(2); },
    v => { v.recovery.items[0].decision.finishAt = '2026-09-25T10:00:00-04:00'; }]) {
    const value = decisionResult(); mutate(value); assert.equal(sanitizeStaffRecoveryResponse(value, 'test', options(expected)), null);
  }
});

test('same rejected decision receipt remains confirmable after a later approval without replaying a write', () => {
  const rejected = decision({ decision: 'reject', finishAt: null, punchId: null });
  const approved = decision({ requestId: requestId(6), revision: 1 });
  const result = decisionResult(approved);
  result.receipt = decisionReceipt(rejected);
  assert.ok(sanitizeStaffRecoveryResponse(result, 'test', options({ ...rejected, adminName: 'Andrew Smith' })));
  result.receipt.revision = 3;
  assert.equal(sanitizeStaffRecoveryResponse(result, 'test', options({ ...rejected, adminName: 'Andrew Smith' })), null);
});

test('recovery collections fail closed on count or byte limits instead of returning a partial all-clear', () => {
  const tooMany = readResult(Array.from({ length: 101 }, (_, i) => item({ requestId: requestId(100 + i) })));
  assert.equal(sanitizeStaffRecoveryResponse(tooMany, 'test', options()), null);
  const value = readResult(Array.from({ length: 90 }, (_, i) => {
    const p = { ...punch(), punchId: punchId(1000 + i), note: 'a'.repeat(400) };
    return item({ requestId: requestId(1000 + i), previousClockInPunchId: punchId(2000 + i), newClockInPunchId: p.punchId, punch: p });
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 80000);
  assert.equal(sanitizeStaffRecoveryResponse(value, 'test', options()), null);
});

test('authoritative record pages permit only paired Tablet clock-in recovery metadata; ordinary sync cannot send it', () => {
  const record = { ...punch(), status: 'ACTIVE', source: 'Tablet', recoveryRequestId: requestId(4), previousClockInPunchId: punchId(1) };
  const pageRequest = { viewToken: 'a'.repeat(64), stream: 'records', offset: 0 };
  const page = r => ({ ok: true, target: 'test', ...pageRequest, items: [r], nextOffset: null });
  const accepted = sanitizeStaffViewPage(page(record), 'test', pageRequest, options());
  assert.equal(accepted.items[0].recoveryRequestId, requestId(4));
  assert.equal(sanitizeStaffClockPunch({ ...punch(), recoveryRequestId: requestId(4) }, options()), null);
  for (const r of [{ ...record, source: 'Admin-added', adminName: 'Andrew Smith' }, { ...record, punchAction: 'clockOut' },
    { ...record, previousClockInPunchId: record.punchId }, { ...record, recoveryRequestId: undefined }]) {
    assert.equal(sanitizeStaffViewPage(page(r), 'test', pageRequest, options()), null);
  }
  const unpaired = { ...record }; delete unpaired.previousClockInPunchId;
  assert.equal(sanitizeStaffViewPage(page(unpaired), 'test', pageRequest, options()), null);
});

test('employee recovery read and start use existing TEST transport without Admin credentials', async () => {
  for (const [body, response, action] of [[{ operation: 'recoveryRead' }, readResult(), 'staffRecoveryRead'], [start(), startResult(), 'staffRecoveryStart']]) {
    const dep = dependencies(response); const result = await handleStaffClock(req(body), dep);
    assert.equal(result.status, 200); assert.equal(dep.calls.length, 1);
    const wire = dep.calls[0].body;
    assert.equal(wire.action, action); assert.equal(wire.target, 'test'); assert.equal(wire.adminActionToken, '');
    assert.equal(wire.token, ENV.GIB_TEST_WEBHOOK_TOKEN); assert.equal(wire.adminName, undefined);
    assert.equal(wire.operation, undefined); assert.equal(dep.calls[0].url, ENV.GIB_TEST_WEBHOOK_URL);
    assert.equal((await result.json()).recovery.items[0].requestId, requestId(4));
    if (body.operation === 'recover') {
      const { operation, ...expected } = body;
      assert.deepEqual(wire.recovery, expected);
    }
  }
});

test('recovery remains hard-disabled outside canonical PR89 TEST and trusted deployment facts', async () => {
  for (const override of [{ enabled: false }, { enabled: true, target: 'production' }, { context: null },
    { context: { ...CONTEXT, site: { ...CONTEXT.site, id: 'wrong' } } },
    { context: { ...CONTEXT, deploy: { context: 'production', published: true } } },
    { installationId: 'richmond', environment: 'test' }]) {
    for (const admin of [false, true]) {
      const dep = dependencies(readResult(), override);
      const handler = admin ? handleAdminStaffTime : handleStaffClock;
      const result = await handler(req({ operation: admin ? 'recoveryReview' : 'recoveryRead' }, { admin }), dep);
      assert.equal(result.status, 404); assert.equal(dep.calls.length, 0);
    }
  }
  for (const origin of ['https://deploy-preview-57--gib-live.netlify.app', 'https://1234567890abcdef12345678--gib-live.netlify.app', 'https://gib-live.netlify.app']) {
    for (const admin of [false, true]) {
      const dep = dependencies(readResult());
      const result = await (admin ? handleAdminStaffTime : handleStaffClock)(req({ operation: admin ? 'recoveryReview' : 'recoveryRead' }, { admin, origin }), dep);
      assert.equal(result.status, 404); assert.equal(dep.calls.length, 0);
    }
  }
});

test('Admin recovery uses existing session and request token and never accepts a client reviewer', async () => {
  for (const requestOptions of [{ auth: false }, { headerToken: 'B'.repeat(43) }]) {
    const dep = dependencies(readResult());
    const response = await handleAdminStaffTime(req({ operation: 'recoveryReview' }, { admin: true, ...requestOptions }), dep);
    assert.ok([401, 403].includes(response.status)); assert.equal(dep.calls.length, 0);
  }
  for (const [body, result, action] of [[{ operation: 'recoveryReview' }, readResult(), 'staffRecoveryReview'], [decision(), decisionResult(), 'staffRecoveryDecide']]) {
    const dep = dependencies(result);
    const response = await handleAdminStaffTime(req(body, { admin: true }), dep);
    assert.equal(response.status, 200); assert.equal(dep.calls.length, 1);
    assert.equal(dep.calls[0].body.action, action);
    assert.equal(dep.calls[0].body.adminName, body.operation === 'recoveryDecide' ? 'Andrew Smith' : undefined);
    if (body.operation === 'recoveryDecide') {
      const { operation, ...expected } = body;
      assert.deepEqual(dep.calls[0].body.decision, expected);
    }
    assert.equal(dep.calls[0].body.adminActionToken, ENV.GIB_TEST_ADMIN_ACTION_TOKEN);
    assert.equal(dep.calls[0].body.operation, undefined);
    const output = await response.json(); assert.equal(output.adminName, 'Andrew Smith'); assert.equal(output.test, true);
    assert.equal(output.target, undefined);
  }
  const dep = dependencies(decisionResult());
  assert.equal((await handleAdminStaffTime(req(decision({ adminName: 'Stuart Turner' }), { admin: true }), dep)).status, 400);
  assert.equal(dep.calls.length, 0);
});

test('unreadable, partial or mismatched replies remain unconfirmed and neither recovery endpoint retries', async () => {
  for (const upstream of [new Error('synthetic transport failure'), new Response('<html>unavailable</html>'),
    { ok: true, target: 'test', recovery: { enabled: true, items: [] } },
    { ...startResult(), target: 'production' }, { ok: false, result: 'mystery', message: 'internal' }]) {
    for (const admin of [false, true]) {
      const dep = dependencies(upstream);
      const response = await (admin ? handleAdminStaffTime : handleStaffClock)(req(admin ? decision() : start(), { admin }), dep);
      assert.equal(response.status, upstream instanceof Error ? 504 : 502); assert.equal(dep.calls.length, 1);
      const text = await response.text(); assert.ok(!text.includes('internal')); assert.ok(!text.includes('synthetic transport failure'));
    }
  }
});

test('only exact Google mutation rejections and conflicts are mapped; read failures never become an empty success', async () => {
  for (const admin of [false, true]) {
    const handler = admin ? handleAdminStaffTime : handleStaffClock;
    for (const [value, status] of [[{ ok: false, result: 'conflict', message: 'State changed. Reload before deciding.' }, 409],
      [{ ok: false, result: 'rejected', message: 'Request was rejected.' }, 400],
      [{ ok: false, result: 'conflict', message: 'State changed.', extra: true }, 502]]) {
      const dep = dependencies(value);
      assert.equal((await handler(req(admin ? decision() : start(), { admin }), dep)).status, status);
      assert.equal(dep.calls.length, 1);
    }
    const dep = dependencies({ ok: false, result: 'conflict', message: 'Read unavailable.' });
    assert.equal((await handler(req({ operation: admin ? 'recoveryReview' : 'recoveryRead' }, { admin }), dep)).status, 502);
  }
});

test('invalid requests and cross-origin calls reach no Google action', async () => {
  for (const admin of [false, true]) {
    const handler = admin ? handleAdminStaffTime : handleStaffClock;
    for (const body of [admin ? decision({ revision: -1 }) : { ...start(), target: 'production' },
      { operation: admin ? 'recoveryReview' : 'recoveryRead', extra: true }]) {
      const dep = dependencies(readResult());
      assert.equal((await handler(req(body, { admin }), dep)).status, 400); assert.equal(dep.calls.length, 0);
    }
    const request = req({ operation: admin ? 'recoveryReview' : 'recoveryRead' }, { admin });
    request.headers.set('Origin', 'https://example.com');
    const dep = dependencies(readResult()); assert.equal((await handler(request, dep)).status, 403); assert.equal(dep.calls.length, 0);
  }
});

test('delayed start and decision responses validate central timestamps against fresh response time', async () => {
  for (const admin of [false, true]) {
    const requestTime = new Date(admin ? '2026-09-25T09:01:00-04:00' : '2026-09-25T09:00:00-04:00');
    const deliveredAt = Date.parse('2026-09-25T09:04:00-04:00');
    const value = admin ? decisionResult() : startResult();
    let clock = +requestTime;
    const dep = dependencies(value, { dateNow: requestTime, clock: () => clock });
    const originalFetch = dep.fetch;
    dep.fetch = async (...args) => {
      const response = await originalFetch(...args);
      clock = deliveredAt;
      return response;
    };
    const response = await (admin ? handleAdminStaffTime : handleStaffClock)(req(admin ? decision() : start(), { admin }), dep);
    assert.equal(response.status, 200, `${admin ? 'decision' : 'start'} confirmation survives a crossed second boundary`);
    assert.equal(dep.calls.length, 1);
    assert.deepEqual((await response.json()).receipt, value.receipt);
  }
});

test('response-time clock does not admit truly future central receipts or future request values', async () => {
  for (const admin of [false, true]) {
    const requestTime = new Date('2026-09-25T09:00:00-04:00');
    const deliveredAt = Date.parse('2026-09-25T09:04:00-04:00');
    const value = admin ? decisionResult() : startResult();
    if (admin) {
      value.receipt.decidedAt = '2026-09-25T09:05:00-04:00';
      value.recovery.items[0].decision.decidedAt = value.receipt.decidedAt;
    } else value.recovery.items[0].proposedAt = '2026-09-25T09:05:00-04:00';
    const dep = dependencies(value, { dateNow: requestTime, clock: () => deliveredAt });
    const handler = admin ? handleAdminStaffTime : handleStaffClock;
    const response = await handler(req(admin ? decision() : start(), { admin }), dep);
    assert.equal(response.status, 502); assert.equal(dep.calls.length, 1);

    const invalidRequest = admin ? decision({ finishAt: '2026-09-25T09:01:00-04:00' }) : start();
    if (!admin) invalidRequest.punch.timestamp = '2026-09-25T09:01:00-04:00';
    const invalidDep = dependencies(value, { dateNow: requestTime, clock: () => deliveredAt });
    assert.equal((await handler(req(invalidRequest, { admin }), invalidDep)).status, 400);
    assert.equal(invalidDep.calls.length, 0);
  }
});

test('historical recovery and decision receipts remain readable when linked punches are later VOID', async () => {
  const expected = { ...decision(), adminName: 'Andrew Smith' };
  const value = decisionResult();
  value.recovery.items[0].conflicts = ['previous-punch-void', 'new-punch-void', 'finish-punch-void'];
  assert.ok(sanitizeStaffRecoveryResponse(value, 'test', options(expected)));
  const read = readResult(value.recovery.items);
  assert.deepEqual(sanitizeStaffRecoveryResponse(read, 'test', options()).recovery.items[0].conflicts,
    value.recovery.items[0].conflicts);
  for (const admin of [false, true]) {
    const dep = dependencies(read);
    const response = await (admin ? handleAdminStaffTime : handleStaffClock)(
      req({ operation: admin ? 'recoveryReview' : 'recoveryRead' }, { admin }), dep);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).recovery.items[0].conflicts, value.recovery.items[0].conflicts);
  }
  const dep = dependencies(value);
  const response = await handleAdminStaffTime(req(decision(), { admin: true }), dep);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).receipt, value.receipt);
});

test('VOID conflicts use only the required bounded fixed categories', () => {
  for (const conflicts of [undefined, null, 'previous-punch-void', ['unknown'],
    ['previous-punch-void', 'previous-punch-void'], ['finish-punch-void'],
    ['previous-punch-void', 'new-punch-void', 'finish-punch-void', 'extra']]) {
    assert.equal(sanitizeStaffRecoveryResponse(readResult([item({ conflicts })]), 'test', options()), null);
  }
  const missing = item(); delete missing.conflicts;
  assert.equal(sanitizeStaffRecoveryResponse(readResult([missing]), 'test', options()), null);
  assert.ok(sanitizeStaffRecoveryResponse(readResult([item({ conflicts: ['previous-punch-void'] })]), 'test', options()));
});

test('a historical start receipt cannot adopt its now-VOID new clock-in as an active shift', async () => {
  const value = startResult([item({ conflicts: ['new-punch-void'] })]);
  assert.equal(sanitizeStaffRecoveryResponse(value, 'test', options(start())), null);
  const dep = dependencies(value);
  const response = await handleStaffClock(req(start()), dep);
  assert.equal(response.status, 502); assert.equal(dep.calls.length, 1);
  assert.equal((await response.json()).ok, false);
  assert.ok(sanitizeStaffRecoveryResponse(startResult([item({ conflicts: ['previous-punch-void'] })]), 'test', options(start())));
});
