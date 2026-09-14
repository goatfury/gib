import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromotionsTransport, mountPromotionsLog } from '../m1/promotions-client.mjs';

const PRIVATE = 'SYNTHETIC_PRIVATE_NAME_ID_URL_MESSAGE';
const keys = ['operation', 'startedAt', 'browserElapsedMs', 'phase', 'httpStatus', 'errorCode', 'outcome',
  'upstreamPhase', 'upstreamMs', 'upstreamStatus', 'upstreamType', 'upstreamRedirected', 'upstreamHost', 'upstreamEnvelope', 'upstreamTrace',
  'traceId', 'responseFingerprint', 'htmlCategory', 'htmlTitle', 'htmlReason'].sort();
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

test('TEST redirect traces accept only bounded exact safe hop records and reject private fields', async () => {
  const hop = { method: 'POST', host: 'google-script', path: 'web-app-exec', status: 302, type: 'html', ms: 4335, destination: 'google-content', destinationPath: 'content-response' };
  const valid = [hop, { method: 'GET', host: 'google-content', path: 'content-response', status: null, type: 'missing', ms: 0, destination: 'none', destinationPath: 'none' }];
  const malformed = [
    PRIVATE, JSON.stringify({ ...hop }), JSON.stringify(Array(22).fill(hop)),
    ...[{ ...hop, private: PRIVATE }, { ...hop, method: PRIVATE }, { ...hop, host: PRIVATE }, { ...hop, type: PRIVATE },
      { ...hop, destination: PRIVATE }, { ...hop, status: 99 }, { ...hop, status: 600 }, { ...hop, status: '302' },
      { ...hop, ms: -1 }, { ...hop, ms: 3600001 }, { ...hop, ms: 0.5 }, { ...hop, destination: undefined },
      { ...hop, path: PRIVATE }, { ...hop, destinationPath: PRIVATE }, null
    ].map(value => JSON.stringify([value]))
  ];
  for (const [value, expected] of [[JSON.stringify(valid), valid], [JSON.stringify(Array(21).fill(hop)), Array(21).fill(hop)], ...malformed.map(value => [value, null])]) {
    const records = []; const error = { code: 'UNAVAILABLE', message: PRIVATE };
    const headers = new Headers({ 'X-GIB-TEST-Upstream-Trace': value });
    const transport = createPromotionsTransport(async () => response({ ok: false, error }, { status: 503, headers }), { onDiagnostic: item => records.push(item) });
    assert.equal(await transport({ operation: 'readStudent', studentId: PRIVATE }).catch(value => value), error);
    assert.equal(records.length, 1); inspect(records[0]); assert.deepEqual(records[0].upstreamTrace, expected);
  }
});

test('TEST correlation and page identity accept only fixed categories and bounded hashes on success and failure', async () => {
  const pairs = { traceId: ['Trace-Id', 'a'.repeat(24)], responseFingerprint: ['Response-Fingerprint', 'b'.repeat(64)],
    htmlCategory: ['HTML-Category', 'google-error'], htmlTitle: ['HTML-Title', 'google-drive'], htmlReason: ['HTML-Reason', 'google-file-unavailable'] };
  for (const ok of [true, false]) {
    for (const invalid of [false, true]) {
      const records = [];
      const headers = new Headers(Object.values(pairs).map(([name, value]) => ['X-GIB-TEST-' + name, invalid ? PRIVATE : value]));
      const body = ok ? { ok: true, data: {} } : { ok: false, error: { code: 'UNAVAILABLE' } };
      await createPromotionsTransport(async () => response(body, { status: ok ? 200 : 503, headers }), { onDiagnostic: value => records.push(value) })({ operation: 'readStudent' }).catch(() => {});
      inspect(records[0]);
      for (const [key, [, value]] of Object.entries(pairs)) assert.equal(records[0][key], invalid ? null : value);
    }
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

test('TEST read cancellation stops before dispatch and settles a pending fetch only once without retry', async () => {
  for (const operation of ['bootstrap', 'readStudent']) {
    const caller = new AbortController(); const calls = []; const records = []; let reply;
    const transport = createPromotionsTransport((...args) => { calls.push(args); return new Promise(resolve => { reply = resolve; }); }, { onDiagnostic: record => records.push(record) });
    const pending = transport({ operation, studentId: PRIVATE }, { signal:caller.signal }).catch(error => error);
    await tick(); assert.equal(calls.length, 1);
    caller.abort(PRIVATE);
    assert.deepEqual(await pending, { code:'CANCELLED', message:'This lookup is no longer active.', retryable:false });
    assert.equal(calls[0][1].signal.aborted, true);
    assert.equal(records.length, 1); inspect(records[0]); assert.equal(records[0].phase, 'cancelled');
    let cancelledBody = false;
    reply({ ...response({ ok:true, data:{ studentId:PRIVATE } }), body:{ async cancel() { cancelledBody = true; } } });
    await tick(); assert.equal(cancelledBody, true); assert.equal(records.length, 1); assert.equal(calls.length, 1);

    const alreadyCancelled = await transport({ operation }, { signal:caller.signal }).catch(error => error);
    assert.equal(alreadyCancelled.code, 'CANCELLED'); assert.equal(calls.length, 1, 'an obsolete read must never start another request');
  }
});

test('cancellation while a TEST read body is pending rejects late data and never retries', async () => {
  const caller = new AbortController(); let deliverBody; let calls = 0;
  const transport = createPromotionsTransport(async () => {
    calls += 1;
    return { ...response(null), json:() => new Promise(resolve => { deliverBody = resolve; }) };
  });
  const pending = transport({ operation:'readStudent', studentId:PRIVATE }, { signal:caller.signal }).catch(error => error);
  await tick(); caller.abort();
  assert.equal((await pending).code, 'CANCELLED');
  deliverBody({ ok:true, data:{ studentId:PRIVATE } }); await tick();
  assert.equal(calls, 1);
});

test('caller cancellation cannot cancel LIVE reads, checkSave or any pending mutation', async () => {
  for (const [testOnly, operation] of [[false, 'bootstrap'], [false, 'readStudent'],
    ...['checkSave', 'recordPromotion', 'confirmRank', 'registerStudent', 'correctLatest'].map(operation => [true, operation])]) {
    const caller = new AbortController(); caller.abort();
    const payload = { operation, requestId:'original-pending-identity', studentId:PRIVATE };
    const calls = []; const data = { unchanged:true };
    const transport = createPromotionsTransport(async (...args) => { calls.push(args); return response({ ok:true, data }); }, { testOnly });
    assert.equal(await transport(payload, { signal:caller.signal }), data);
    assert.equal(calls.length, 1); assert.equal(calls[0][1].signal.aborted, false);
    assert.deepEqual(JSON.parse(calls[0][1].body), payload);
  }
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
