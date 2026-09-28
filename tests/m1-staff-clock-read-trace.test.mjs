import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import test from 'node:test';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig, postGoogle } from '../netlify/functions/_lib/m1-common.mjs';
import { handleAdminStaffTime, ADMIN_STAFF_TIME_PATH } from '../netlify/functions/m1-admin-staff-time.mjs';

const ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const TOKEN = 'a'.repeat(64);
const NOW = new Date('2026-08-18T21:00:00Z');
const REQUEST_TOKEN = 'A'.repeat(43);
const ENV = {
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/PRIVATE_TEST_RECEIVER/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'private-synthetic-staff-transport-123456789',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'private-synthetic-staff-admin-9876543210',
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/PRIVATE_LIVE_RECEIVER/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'private-synthetic-live-transport-9876543210',
  GIB_M1_ADMIN_ACTION_TOKEN: 'private-synthetic-live-admin-0123456789',
  GIB_M1_ADMIN_PASSPHRASE: 'Synthetic passphrase used only in isolated tests'
};
const CONTEXT = { site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' },
  deploy: { context: 'deploy-preview', published: false } };

function summary(target = 'test') {
  return { ok: true, target, staff: [], shiftStaff: [], clockedInNow: [],
    periods: { current: { startDate: '2026-08-10', endDate: '2026-08-23', totals: [] },
      previous: { startDate: '2026-07-27', endDate: '2026-08-09', totals: [] } },
    view: { token: TOKEN, today: '2026-08-18', recordCount: 0, recordTotal: 0,
      todayPunchCount: 0, todayPunchTotal: 0, adjustmentCount: 0, adjustmentTotal: 0,
      attentionCount: 0, attentionOccurrenceCount: 0, auditCount: 0, auditTotal: 0,
      recordsTruncated: false, auditTruncated: false } };
}

async function capture(run) {
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(args.join(' '));
  try { return { value: await run(), logs }; }
  finally { console.info = original; }
}

async function invoke(body, upstream, options = {}) {
  const origin = options.origin || ORIGIN;
  const requestUrl = `${origin}${ADMIN_STAFF_TIME_PATH}`;
  const headers = { 'Content-Type': 'application/json', Origin: origin, Host: new URL(origin).host,
    'Sec-Fetch-Site': 'same-origin', 'X-GIB-M1-Read-ID': options.traceId ?? ID };
  if (options.auth !== false) {
    const runtime = runtimeConfig(ENV, { admin: true, requestUrl });
    const session = createAdminSession('Andrew Smith', runtime.sessionSecret, +NOW, REQUEST_TOKEN);
    headers.Cookie = `${ADMIN_COOKIE}=${encodeURIComponent(session)}`;
    headers[ADMIN_REQUEST_HEADER] = REQUEST_TOKEN;
  }
  const wires = [];
  const result = await capture(() => handleAdminStaffTime(new Request(requestUrl, {
    method: 'POST', headers, body: JSON.stringify(body)
  }), { env: ENV, installationId: options.installationId || 'rev', enabled: true, context: CONTEXT,
    now: +NOW, dateNow: NOW, clock: () => +NOW,
    fetch: async (url, init) => {
      wires.push({ url, body: JSON.parse(init.body), redirect: init.redirect, signal: init.signal });
      // Exercise the same AsyncLocalStorage channel subscribers without network.
      const first = { origin: 'https://script.google.com', method: 'POST' };
      channel('undici:request:create').publish({ request: first });
      channel('undici:request:headers').publish({ request: first, response: { statusCode: 302 } });
      const second = { origin: 'https://script.googleusercontent.com', method: 'GET' };
      channel('undici:request:create').publish({ request: second });
      channel('undici:request:headers').publish({ request: second, response: { statusCode: 200 } });
      channel('undici:request:trailers').publish({ request: second });
      if (upstream instanceof Error) throw upstream;
      return upstream instanceof Response ? upstream.clone() : new Response(JSON.stringify(upstream));
    } }));
  return { response: result.value, value: await result.value.json(), logs: result.logs, wires,
    events: result.logs.filter(line => line.startsWith('M1_TEST_STAFF_READ ')).map(line => JSON.parse(line.slice('M1_TEST_STAFF_READ '.length))) };
}

test('authenticated exact-preview read correlates browser, Netlify stages, actual hop subscribers and Google envelope', async () => {
  const traced = await invoke({ operation: 'review' }, summary());
  const baseline = await invoke({ operation: 'review' }, summary(), { traceId: '' });
  assert.equal(traced.response.status, 200);
  assert.deepEqual(traced.value, baseline.value, 'Diagnostics cannot alter the response contract');
  assert.equal(traced.response.headers.get('X-GIB-M1-Read-ID'), ID);
  assert.equal(traced.wires.length, 1);
  assert.equal(traced.wires[0].body.staffReadTraceId, ID);
  assert.equal(traced.wires[0].body.action, 'staffTimeReviewV2');
  assert.equal(traced.wires[0].redirect, 'follow');
  assert.ok(traced.wires[0].signal instanceof AbortSignal);
  assert.deepEqual(traced.events.map(event => [event.stage, event.category]), [
    ['netlify.accepted', 'ACCEPTED'], ['google.transport', 'ACCEPTED'], ['google.result', 'OK'],
    ['netlify.validation', 'VALIDATED'], ['netlify.delivery', 'HTTP_SUCCESS']
  ]);
  assert.ok(traced.events.every(event => event.requestId === ID && Number.isInteger(event.elapsedMs)));
  const hops = traced.logs.filter(line => line.startsWith('M1_TEST_HOP ')).map(line => JSON.parse(line.slice(12)));
  assert.deepEqual(hops.filter(event => event.event === 'request').map(event => [event.method, event.host]),
    [['POST', 'script.google.com'], ['GET', 'script.googleusercontent.com']]);
  assert.ok(hops.every(event => event.requestId === ID));
  assert.equal(new Set(hops.map(event => event.trace)).size, 1);
  const text = traced.logs.join('\n');
  for (const privateValue of [...Object.values(ENV), REQUEST_TOKEN, TOKEN, 'Andrew Smith']) assert.ok(!text.includes(privateValue));
});

test('the other four pure read actions preserve exact response shapes and one upstream request', async () => {
  const cases = [
    [{ operation: 'reviewPage', viewToken: TOKEN, stream: 'attention', offset: 0 }, 'staffTimeReviewPageV2'],
    [{ operation: 'historyPage', viewToken: TOKEN, offset: 0 }, 'staffTimeHistoryPageV2'],
    [{ operation: 'shiftLookup', viewToken: TOKEN, mode: 'recent' }, 'staffTimeShiftLookupV3'],
    [{ operation: 'recoveryReview' }, 'staffRecoveryReview']
  ];
  for (const [body, action] of cases) {
    const upstream = body.operation === 'recoveryReview'
      ? { ok: true, target: 'test', recovery: { enabled: true, items: [] } }
      : { ok: false, target: 'test', result: 'stale' };
    const result = await invoke(body, upstream);
    assert.equal(result.response.status, body.operation === 'recoveryReview' ? 200 : 409);
    assert.equal(result.response.headers.get('X-GIB-M1-Read-ID'), ID);
    assert.equal(result.wires.length, 1);
    assert.equal(result.wires[0].body.action, action);
    assert.equal(result.wires[0].body.staffReadTraceId, ID);
    assert.ok(result.events.some(event => event.stage === 'netlify.validation'
      && event.category === (body.operation === 'recoveryReview' ? 'VALIDATED' : 'STALE')));
  }
});

test('transport failure, receiver failure and Netlify contract rejection remain distinct without logging values', async () => {
  const cases = [
    [new Error('PRIVATE raw error with token and URL'), 'UNREACHABLE', 'NOT_VALIDATED', 504],
    [new Response('<html>PRIVATE Google reply</html>'), 'HTML', 'NOT_VALIDATED', 502],
    [{ ok: false, result: 'rejected', message: 'PRIVATE rejection' }, 'REJECTED', 'NOT_VALIDATED', 502],
    [{ ok: false, result: 'failed', message: 'PRIVATE busy message' }, 'FAILED', 'NOT_VALIDATED', 502],
    [{ ok: true, target: 'test', PRIVATE: 'incomplete data' }, 'OK', 'CONTRACT_MISMATCH', 502]
  ];
  for (const [upstream, googleCategory, validationCategory, status] of cases) {
    const result = await invoke({ operation: 'recoveryReview' }, upstream);
    assert.equal(result.response.status, status);
    assert.equal(result.value.code, 'STAFF_RECOVERY_UNCONFIRMED', 'Public error contract stays unchanged');
    assert.equal(result.wires.length, 1, 'Diagnostics add no retry');
    assert.ok(result.events.some(event => event.stage === 'google.result' && event.category === googleCategory));
    assert.ok(result.events.some(event => event.stage === 'netlify.validation' && event.category === validationCategory));
    assert.ok(!result.logs.join('\n').includes('PRIVATE'));
  }
});

test('malformed/missing IDs, other previews, immutable deploys, production and unauthenticated reads are not traced', async () => {
  for (const options of [{ traceId: '' }, { traceId: 'not-a-uuid-secret' }, { traceId: ID.toUpperCase() },
    { traceId: ID.replace('-4111-', '-1111-') }, { origin: 'https://deploy-preview-90--gib-live.netlify.app' },
    { origin: 'https://1234567890abcdef12345678--gib-live.netlify.app' },
    { origin: 'https://gib-live.netlify.app' }, { auth: false }, { installationId: 'richmond' }]) {
    const target = options.origin === 'https://gib-live.netlify.app' ? 'production' : 'test';
    const result = await invoke({ operation: 'review' }, summary(target), options);
    assert.equal(result.response.headers.get('X-GIB-M1-Read-ID'), null, JSON.stringify(options));
    assert.equal(result.logs.length, 0, JSON.stringify(options));
    assert.ok(result.wires.every(wire => !Object.hasOwn(wire.body, 'staffReadTraceId')));
  }
});

test('write routes ignore the diagnostic header and preserve their existing upstream envelope', async () => {
  const requestId = 'gib-m1-staff-request-12345678-1234-4123-8123-123456789abc';
  const punchId = 'gib-m1-staff-12345678-1234-4123-8123-123456789abc';
  const result = await invoke({ operation: 'void', requestId, punchId, reason: 'Synthetic review' },
    { ok: false, result: 'rejected', message: 'Synthetic rejection' });
  assert.equal(result.response.status, 400);
  assert.equal(result.wires.length, 1);
  assert.equal(result.wires[0].body.action, 'staffTimeVoid');
  assert.equal(result.wires[0].body.requestId, requestId);
  assert.equal(Object.hasOwn(result.wires[0].body, 'staffReadTraceId'), false);
  assert.equal(result.logs.length, 0);
  assert.equal(result.response.headers.get('X-GIB-M1-Read-ID'), null);
});

test('invalid browser body does not bypass request validation or reach Google with a supplied trace field', async () => {
  const result = await invoke({ operation: 'review', staffReadTraceId: ID }, summary());
  assert.equal(result.response.status, 400);
  assert.equal(result.wires.length, 0);
  assert.ok(result.events.some(event => event.stage === 'netlify.validation' && event.category === 'REQUEST_REJECTED'));
});

test('common transport requires exact scope and allowed read action before forwarding server trace metadata', async () => {
  const base = { target: 'test', installationId: 'rev', webhookUrl: ENV.GIB_TEST_WEBHOOK_URL,
    webhookToken: ENV.GIB_TEST_WEBHOOK_TOKEN, staffReadTraceOrigin: ORIGIN, staffReadTraceId: ID };
  for (const [overrides, action] of [[{ target: 'production' }, 'staffTimeReviewV2'],
    [{ installationId: 'richmond' }, 'staffTimeReviewV2'],
    [{ staffReadTraceOrigin: 'https://deploy-preview-90--gib-live.netlify.app' }, 'staffTimeReviewV2'],
    [{}, 'staffTimeCorrect'], [{}, 'staffRecoveryDecide']]) {
    let wire;
    const { logs } = await capture(() => postGoogle({ ...base, ...overrides }, action, {}, async (_url, init) => {
      wire = JSON.parse(init.body); return new Response('{"ok":false}');
    }));
    assert.equal(Object.hasOwn(wire, 'staffReadTraceId'), false);
    assert.equal(logs.length, 0);
  }
});

test('logging failures cannot invalidate a successful authenticated read', async () => {
  const original = console.info;
  console.info = () => { throw new Error('Log sink unavailable'); };
  try {
    const runtime = runtimeConfig(ENV, { admin: true, requestUrl: `${ORIGIN}${ADMIN_STAFF_TIME_PATH}` });
    const session = createAdminSession('Andrew Smith', runtime.sessionSecret, +NOW, REQUEST_TOKEN);
    const response = await handleAdminStaffTime(new Request(`${ORIGIN}${ADMIN_STAFF_TIME_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN,
        Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session)}`, [ADMIN_REQUEST_HEADER]: REQUEST_TOKEN,
        'X-GIB-M1-Read-ID': ID }, body: '{"operation":"review"}'
    }), { env: ENV, installationId: 'rev', now: +NOW, dateNow: NOW,
      fetch: async () => new Response(JSON.stringify(summary())) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(response.headers.get('X-GIB-M1-Read-ID'), ID);
  } finally { console.info = original; }
});
