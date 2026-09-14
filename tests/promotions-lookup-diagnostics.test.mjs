import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromotionsTransport, mountPromotionsLog } from '../m1/promotions-client.mjs';

const PRIVATE = 'SYNTHETIC_PRIVATE_NAME_ID_URL_MESSAGE';
const keys = ['operation', 'startedAt', 'browserElapsedMs', 'phase', 'httpStatus', 'errorCode', 'outcome',
  'upstreamPhase', 'upstreamMs', 'upstreamStatus', 'upstreamType', 'upstreamRedirected', 'upstreamHost', 'upstreamEnvelope'].sort();
const response = (body, { status = 200, headers = new Headers() } = {}) => ({ ok: status >= 200 && status < 300, status, headers, json: async () => body });
const tick = async () => { for (let step = 0; step < 6; step += 1) await Promise.resolve(); };
function inspect(record) {
  assert.deepEqual(Object.keys(record).sort(), keys);
  assert.equal(new Date(record.startedAt).toISOString(), record.startedAt);
  assert.ok(Number.isSafeInteger(record.browserElapsedMs) && record.browserElapsedMs >= 0);
  assert.equal(JSON.stringify(record).includes(PRIVATE), false);
}

test('a TEST observation preserves exact request options and successful result without logging student data', async () => {
  const calls = []; const records = [];
  const payload = { operation: 'readStudent', studentId: PRIVATE };
  const data = { student: { studentId: PRIVATE, displayName: PRIVATE }, history: [{ reason: PRIVATE }] };
  const transport = createPromotionsTransport(async (...args) => { calls.push(args); return response({ ok: true, data }); }, { onDiagnostic: item => records.push(item) });
  assert.equal(await transport(payload), data);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/api/m1-promotions');
  const { signal, ...options } = calls[0][1];
  assert.deepEqual(options, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(signal.aborted, false); assert.equal(records.length, 1); inspect(records[0]);
  assert.equal(records[0].operation, 'readStudent'); assert.equal(records[0].phase, 'application');
  assert.equal(records[0].outcome, 'success'); assert.equal(records[0].httpStatus, 200); assert.equal(records[0].errorCode, null);
  for (const key of keys.filter(key => key.startsWith('upstream'))) assert.equal(records[0][key], null);
});

test('a failing TEST response reports safe upstream categories and preserves its original error object', async () => {
  const records = []; let calls = 0;
  const error = { code: 'UNAVAILABLE', message: PRIVATE, retryable: true, requestId: PRIVATE };
  const headers = new Headers({ 'X-GIB-TEST-Upstream': 'json', 'X-GIB-TEST-Upstream-Ms': '4335', 'X-GIB-TEST-Upstream-Status': '200',
    'X-GIB-TEST-Upstream-Type': 'html', 'X-GIB-TEST-Upstream-Redirected': '1', 'X-GIB-TEST-Upstream-Host': 'google-auth', 'X-GIB-TEST-Upstream-Envelope': 'none',
    'Location': `https://example.invalid/${PRIVATE}`, 'Set-Cookie': PRIVATE });
  const transport = createPromotionsTransport(async () => { calls += 1; return response({ ok: false, error }, { status: 503, headers }); }, { onDiagnostic: item => records.push(item) });
  assert.equal(await transport({ operation: 'bootstrap' }).catch(value => value), error);
  assert.equal(calls, 1); assert.equal(records.length, 1); inspect(records[0]);
  assert.equal(records[0].phase, 'application'); assert.equal(records[0].outcome, 'error'); assert.equal(records[0].httpStatus, 503);
  assert.equal(records[0].errorCode, 'UNAVAILABLE'); assert.equal(records[0].upstreamPhase, 'json'); assert.equal(records[0].upstreamMs, 4335);
  assert.equal(records[0].upstreamStatus, 200); assert.equal(records[0].upstreamType, 'html'); assert.equal(records[0].upstreamRedirected, 1);
  assert.equal(records[0].upstreamHost, 'google-auth'); assert.equal(records[0].upstreamEnvelope, 'none');
});

test('unrecognized operations, codes and header contents cannot leak through the diagnostic record', async () => {
  for (const malformedNumber of [PRIVATE, '-1', '1e3', '123ms', '9007199254740992', '3600001']) {
    const records = []; const error = { code: PRIVATE, message: PRIVATE };
    const headers = new Headers({ 'X-GIB-TEST-Upstream': PRIVATE, 'X-GIB-TEST-Upstream-Ms': malformedNumber,
      'X-GIB-TEST-Upstream-Status': '700', 'X-GIB-TEST-Upstream-Type': PRIVATE,
      'X-GIB-TEST-Upstream-Redirected': '2', 'X-GIB-TEST-Upstream-Host': `https://example.invalid/${PRIVATE}`, 'X-GIB-TEST-Upstream-Envelope': PRIVATE });
    const transport = createPromotionsTransport(async () => response({ ok: false, error }, { status: 503, headers }), { onDiagnostic: item => records.push(item) });
    assert.equal(await transport({ operation: PRIVATE, studentId: PRIVATE }).catch(value => value), error);
    inspect(records[0]); assert.equal(records[0].operation, 'OTHER'); assert.equal(records[0].errorCode, 'OTHER');
    for (const key of keys.filter(key => key.startsWith('upstream'))) assert.equal(records[0][key], null, key);
  }
});

test('network, body parsing, application denial and offline failures remain distinct without additional requests', async () => {
  const cases = [
    { phase: 'fetch', status: null, fetcher: async () => { throw new Error(PRIVATE); } },
    { phase: 'body', status: 200, fetcher: async () => ({ ...response(null), json: async () => { throw new Error(PRIVATE); } }) },
    { phase: 'application', status: 200, fetcher: async () => response({ ok: false, error: { code: 'TEST_DESTINATION_INVALID', message: PRIVATE } }) },
    { phase: 'offline', status: null, online: () => false, fetcher: async () => assert.fail('Offline lookup must never fetch') }
  ];
  for (const entry of cases) {
    const records = []; let calls = 0;
    const transport = createPromotionsTransport(async (...args) => { calls += 1; return entry.fetcher(...args); }, { online: entry.online || (() => true), onDiagnostic: record => records.push(record) });
    const error = await transport({ operation: 'bootstrap' }).catch(value => value);
    assert.equal(error.code, entry.phase === 'application' ? 'TEST_DESTINATION_INVALID' : 'UNAVAILABLE');
    assert.equal(calls, entry.phase === 'offline' ? 0 : 1); assert.equal(records.length, 1); inspect(records[0]);
    assert.equal(records[0].phase, entry.phase); assert.equal(records[0].httpStatus, entry.status); assert.equal(records[0].outcome, 'error');
  }
});

test('the existing 30-second timeout settles and observes once even when a late response arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const records = []; const calls = []; let reply;
  const transport = createPromotionsTransport((...args) => { calls.push(args); return new Promise(resolve => { reply = resolve; }); }, { onDiagnostic: record => records.push(record) });
  const pending = transport({ operation: 'bootstrap' }).catch(error => error);
  await tick(); assert.equal(calls.length, 1);
  t.mock.timers.tick(29999); await tick(); assert.equal(records.length, 0); assert.equal(calls[0][1].signal.aborted, false);
  t.mock.timers.tick(1); const error = await pending;
  assert.equal(error.message, 'No confirmation arrived. Keep this entry and check or retry it.');
  assert.equal(error.code, 'UNAVAILABLE'); assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(records.length, 1); inspect(records[0]); assert.equal(records[0].phase, 'timeout'); assert.equal(records[0].httpStatus, null);
  reply(response({ ok: true, data: { studentId: PRIVATE } })); await tick();
  assert.equal(records.length, 1); assert.equal(records[0].phase, 'timeout'); assert.equal(calls.length, 1);
});

test('throwing or rejecting observers and unreadable diagnostic headers cannot affect result objects', async () => {
  for (const observer of [() => { throw new Error(PRIVATE); }, () => Promise.reject(new Error(PRIVATE))]) {
    const data = { studentId: PRIVATE }; const error = { code: 'NOT_FOUND', message: PRIVATE };
    const headers = { get() { throw new Error(PRIVATE); } };
    assert.equal(await createPromotionsTransport(async () => response({ ok: true, data }, { headers }), { onDiagnostic: observer })({ operation: 'bootstrap' }), data);
    assert.equal(await createPromotionsTransport(async () => response({ ok: false, error }, { headers }), { onDiagnostic: observer })({ operation: 'readStudent' }).catch(value => value), error);
    await tick();
  }
});

test('LIVE never calls an observer or reads TEST diagnostic headers', async () => {
  const records = []; const headers = { get() { assert.fail('LIVE must not read TEST diagnostic headers'); } };
  const data = { studentId: PRIVATE }; const error = { code: 'UNAUTHORIZED', message: PRIVATE };
  for (const body of [{ ok: true, data }, { ok: false, error }]) {
    const transport = createPromotionsTransport(async () => response(body, { headers }), { testOnly: false, onDiagnostic: record => records.push(record) });
    const actual = await transport({ operation: 'bootstrap' }).catch(value => value);
    assert.equal(actual, body.ok ? data : error);
  }
  assert.deepEqual(records, []);
});

function mountedFixture(testOnly, fetcher) {
  const parts = new Map();
  const element = () => ({ value: '', hidden: true, children: [], classList: { add() {}, remove() {} }, addEventListener() {},
    setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], replaceChildren() {}, append() {}, focus() {} });
  const host = element();
  host.querySelector = selector => { if (!parts.has(selector)) parts.set(selector, element()); return parts.get(selector); };
  const controls = new Map([['promotionsPanel', host], ['promotionsNavigation', element()], ['openPromotionsLog', element()]]);
  const document = { body: element(), getElementById: id => controls.get(id) || null, addEventListener() {}, createElement: element };
  return mountPromotionsLog({ document, profile: { installationId: 'rev', backend: { enabled: true }, featureFlags: {} },
    config: { enabled: true, testOnly, endpoint: '/api/m1-promotions', ...(testOnly ? {} : { target: 'live' }) },
    origin: testOnly ? 'https://deploy-preview-86--gib-live.netlify.app' : 'https://gib-live.netlify.app', fetcher,
    storage: { getItem: () => null, setItem() {}, removeItem() {} }, windowTarget: { setInterval: () => 1, clearInterval() {}, addEventListener() {} }
  });
}

test('the mounted TEST bootstrap emits its one safe console record and the mounted LIVE bootstrap stays silent', async t => {
  const original = globalThis.M1_KIOSK_NAVIGATION;
  globalThis.M1_KIOSK_NAVIGATION = { canLeaveSignIn: () => true };
  t.after(() => { if (original === undefined) delete globalThis.M1_KIOSK_NAVIGATION; else globalThis.M1_KIOSK_NAVIGATION = original; });
  const logs = []; t.mock.method(console, 'info', (...args) => logs.push(args));
  for (const testOnly of [true, false]) {
    let calls = 0;
    const mounted = mountedFixture(testOnly, async () => { calls += 1; return response({ ok: true, data: {
      testOnly, students: [{ studentId: PRIVATE, displayName: PRIVATE }], approvers: [], todayNY: '2026-09-14', recorderLabel: PRIVATE
    } }); });
    assert.ok(mounted); assert.equal(await mounted.open(), true); assert.equal(calls, 1); mounted.destroy();
    assert.equal(logs.length, 1);
  }
  assert.equal(logs[0].length, 2); assert.equal(logs[0][0], 'Promotions TEST lookup');
  const record = JSON.parse(logs[0][1]); inspect(record); assert.equal(record.operation, 'bootstrap'); assert.equal(record.outcome, 'success');
});
