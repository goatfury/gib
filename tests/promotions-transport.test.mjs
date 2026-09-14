import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { handlePromotions } from '../netlify/functions/m1-promotions.mts';
import * as runtime from '../netlify/functions/_lib/promotions-runtime.mts';
import { createProductionDeviceCredential } from '../netlify/functions/_lib/m1-production-runtime.mjs';

const NOW = Date.parse('2026-09-13T15:20:30.000Z');
const ORIGIN = 'https://deploy-preview-85--gib-live.netlify.app';
const SITE_ID = 'synthetic-revolution-site-id';
const API = '/api/m1-promotions';
const INSTALL = '/api/m1-promotions-install';
const COOKIE = '__Host-gib_m1_promotions_test_device';
const MODE = 'm1-authorized-tablet-test-v1';
const ENV = Object.freeze({
  GIB_PROMOTIONS_TEST_ENABLED: 'true',
  GIB_PROMOTIONS_TEST_INSTALLATION: 'rev',
  GIB_PROMOTIONS_TEST_ORIGIN: ORIGIN,
  GIB_PROMOTIONS_TEST_SITE_ID: SITE_ID,
  GIB_PROMOTIONS_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PROMOTIONS_TEST_RECEIVER/exec',
  GIB_PROMOTIONS_TEST_BRIDGE_SECRET: 'synthetic-promotions-bridge-secret-0123456789',
  GIB_PROMOTIONS_TEST_DEVICE_SECRET: 'synthetic-promotions-device-secret-0123456789',
  GIB_PROMOTIONS_TEST_INSTALL_SECRET: 'synthetic-promotions-install-secret-0123456789',
  GIB_PROMOTIONS_TEST_INSTALL_RUN_ID: 'synthetic-promotions-install-run-20260913'
});
const LOOKUPS = [
  { operation: 'bootstrap' },
  { operation: 'readStudent', studentId: 'fixture-student-001' },
  { operation: 'checkSave', requestId: 'synthetic-save-request-001' }
];
const SAVE = {
  operation: 'recordPromotion', requestId: 'synthetic-save-request-001', studentId: 'fixture-student-001',
  expectedRevision: 1, action: 'stripe', approverId: 'TEST-COACH-A'
};
const namedRequest = (request, approverName = "TEST José  O'Neill-Smith") => {
  const { approverId, ...intent } = request;
  return { ...intent, approverName };
};

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}

function credential(secret = ENV.GIB_PROMOTIONS_TEST_DEVICE_SECRET, now = NOW, byte = 0x36) {
  return createProductionDeviceCredential(secret, size => Buffer.alloc(size, byte), now);
}

function request(path = API, {
  origin = ORIGIN, headerOrigin = origin, host = new URL(origin).host, fetchSite = 'same-origin',
  cookie = `${COOKIE}=${credential()}`, body = LOOKUPS[0], rawBody,
  method = 'POST', contentType = 'application/json', extraHeaders = {}
} = {}) {
  const headers = { ...extraHeaders };
  if (headerOrigin !== null) headers.Origin = headerOrigin;
  if (host !== null) headers.Host = host;
  if (fetchSite !== null) headers['Sec-Fetch-Site'] = fetchSite;
  if (cookie) headers.Cookie = cookie;
  if (contentType !== null) headers['Content-Type'] = contentType;
  return new Request(`${origin}${path}`, {
    method, headers,
    ...(!['GET', 'HEAD'].includes(method) ? { body: rawBody === undefined ? JSON.stringify(body) : rawBody } : {})
  });
}

function serverHarness(changes = {}) {
  const calls = [];
  const data = { testOnly: true, marker: 'SYNTHETIC_PRIVATE_RESULT' };
  const deps = {
    env: ENV, siteId: SITE_ID, installationId: 'rev', now: NOW,
    fetch: async (url, options) => {
      const envelope = JSON.parse(options.body);
      calls.push({ url, options, envelope });
      return new Response(JSON.stringify({
        bridge: MODE, target: 'test', installation: 'rev', requestNonce: envelope.payload.nonce,
        result: { ok: true, data }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    ...changes
  };
  return { calls, data, deps, run: input => handlePromotions(input, deps) };
}

async function result(response) {
  return { status: response.status, body: JSON.parse(await response.text()), headers: response.headers };
}

function noPrivateConfiguration(value) {
  const text = JSON.stringify(value);
  for (const key of ['WEBHOOK_URL', 'BRIDGE_SECRET', 'DEVICE_SECRET', 'INSTALL_SECRET']) {
    assert.equal(text.includes(ENV[`GIB_PROMOTIONS_TEST_${key}`]), false, `${key} must never be returned to the browser`);
  }
}

function oneTimeStore() {
  const entries = new Map();
  const calls = [];
  let revision = 0;
  return {
    entries, calls,
    async getWithMetadata(key, options) {
      assert.equal(options.type, 'json');
      const record = entries.get(key);
      return record ? { data: structuredClone(record.data), metadata: {}, etag: record.etag } : null;
    },
    async set(key, value, options) {
      assert.ok(options.onlyIfNew === true || typeof options.onlyIfMatch === 'string', 'pairing writes must be conditional');
      calls.push({ key, value, options });
      const previous = entries.get(key);
      if (options.onlyIfNew && previous || options.onlyIfMatch && previous?.etag !== options.onlyIfMatch) return { modified: false };
      const etag = `synthetic-etag-${++revision}`;
      entries.set(key, { data: typeof value === 'string' ? JSON.parse(value) : structuredClone(value), etag });
      return { modified: true, etag };
    }
  };
}

function installCapability(changes = {}) {
  const config = runtime.promotionsRuntimeConfig(ENV, { siteId: SITE_ID, installationId: 'rev' });
  assert.ok(config, 'the isolated synthetic TEST fixture must be configured');
  return runtime.createPromotionsInstallCapability(config, {
    nonce: Buffer.alloc(16, 0x71).toString('hex'), pairingCode: 'ABCDEF0123',
    issuedAt: Math.floor(NOW / 1000), expiresAt: Math.floor(NOW / 1000) + 600,
    ...changes
  });
}

test('both lookup and writes require a current signed TEST device cookie before Google is contacted', async () => {
  const invalidCookies = [
    '', `${COOKIE}=invalid`, `${COOKIE}=${credential('synthetic-unrelated-secret-0123456789')}`,
    `${COOKIE}=${credential(undefined, NOW - 400 * 86400000)}`,
    `${COOKIE}=${credential(undefined, NOW + 301000)}`,
    `__Host-gib_m1_production_device=${credential()}`,
    `__Host-gib_m1_richmond_production_device=${credential()}`,
    `${COOKIE}=${credential()}; ${COOKIE}=${credential()}`,
    `${COOKIE}=${credential()}; ${COOKIE}=invalid`,
    `${COOKIE}=invalid; ${COOKIE}=${credential()}`
  ];
  for (const operation of [...LOOKUPS, SAVE, namedRequest(SAVE)]) for (const cookie of invalidCookies) {
    const h = serverHarness();
    const denied = await result(await h.run(request(API, { cookie, body: operation })));
    assert.ok(denied.status >= 400, `${operation.operation}: ${cookie}`);
    assert.equal(denied.body.ok, false);
    assert.equal(h.calls.length, 0, 'authorization must run before Google');
    assert.equal(JSON.stringify(denied.body).includes(h.data.marker), false);
    noPrivateConfiguration(denied.body);
  }
});

test('exact TEST origin, request path and same-origin browser boundaries are enforced before Google', async () => {
  const candidates = [
    request(API, { origin: 'https://gib-live.netlify.app' }),
    request(API, { origin: 'https://gib-richmond-live.netlify.app' }),
    request(API, { origin: 'https://gib-richmond-test.netlify.app' }),
    request(API, { origin: 'https://deploy-preview-86--gib-live.netlify.app' }),
    request(API, { origin: ORIGIN.replace('https:', 'http:') }),
    request(API, { origin: `${ORIGIN}:8443` }),
    request(`${API}?operation=bootstrap`), request(`${API}#fragment`), request(`${API}/`),
    request(API, { headerOrigin: 'https://attacker.example.invalid' }),
    request(API, { headerOrigin: null }), request(API, { host: 'another.example.invalid' }),
    request(API, { host: null }), request(API, { fetchSite: 'cross-site' }),
    request(API, { fetchSite: 'same-site' }), request(API, { method: 'GET' }),
    request('/api/m1-kiosk-sync'), request('/api/m1-staff-clock')
  ];
  for (const input of candidates) {
    const h = serverHarness();
    assert.ok((await h.run(input)).status >= 400, input.url);
    assert.equal(h.calls.length, 0, input.url);
  }
});

test('missing TEST configuration, other gyms and reused backend credentials fail closed', async () => {
  const envChanges = [
    { GIB_PROMOTIONS_TEST_ENABLED: 'false' }, { GIB_PROMOTIONS_TEST_INSTALLATION: 'richmond' },
    { GIB_PROMOTIONS_TEST_ORIGIN: 'https://gib-live.netlify.app' },
    { GIB_PROMOTIONS_TEST_ORIGIN: 'https://gib-richmond-test.netlify.app' },
    { GIB_PROMOTIONS_TEST_SITE_ID: 'another-site' },
    { GIB_PROMOTIONS_TEST_WEBHOOK_URL: 'https://attacker.example.invalid/exec' },
    { GIB_PROMOTIONS_TEST_BRIDGE_SECRET: '' }, { GIB_PROMOTIONS_TEST_DEVICE_SECRET: 'short' },
    { GIB_PROMOTIONS_TEST_DEVICE_SECRET: ENV.GIB_PROMOTIONS_TEST_BRIDGE_SECRET },
    { GIB_PROMOTIONS_TEST_INSTALL_SECRET: ENV.GIB_PROMOTIONS_TEST_DEVICE_SECRET }
  ];
  for (const changes of envChanges) {
    const h = serverHarness({ env: { ...ENV, ...changes } });
    assert.ok((await h.run(request())).status >= 400, JSON.stringify(changes));
    assert.equal(h.calls.length, 0);
  }
  for (const changes of [{ installationId: 'richmond' }, { siteId: 'wrong-site' }]) {
    const h = serverHarness(changes);
    assert.ok((await h.run(request())).status >= 400);
    assert.equal(h.calls.length, 0);
  }
});

test('authorized lookup and save use an independently verified HMAC envelope with separate device identity', async () => {
  const h = serverHarness();
  const writes = [
    SAVE,
    { operation: 'registerStudent', requestId: 'synthetic-register-001', displayName: 'TEST New Student', distinguishingLabel: 'Evening', approverId: 'TEST-COACH-A' },
    { operation: 'confirmRank', requestId: 'synthetic-rank-001', studentId: 'fixture-student-001', expectedRevision: 1, rank: { belt: 'Blue Belt', marks: 2 }, approverId: 'TEST-COACH-A', reason: 'TEST explicit current rank' },
    { operation: 'correctLatest', requestId: 'synthetic-correction-001', studentId: 'fixture-student-001', expectedRevision: 2, correctsEventId: 'synthetic-event-001', rank: { belt: 'Blue Belt', marks: 2 }, approverId: 'TEST-COACH-B', reason: 'TEST correction preserves original' }
  ];
  for (const operation of [...LOOKUPS, ...writes, ...writes.map(write => namedRequest(write))]) {
    const response = await result(await h.run(request(API, { body: operation })));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, data: h.data });
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.has('access-control-allow-origin'), false);
    noPrivateConfiguration(response.body);
    const sent = h.calls.at(-1);
    assert.equal(String(sent.url), ENV.GIB_PROMOTIONS_TEST_WEBHOOK_URL);
    assert.equal(sent.options.method, 'POST');
    assert.deepEqual(Object.keys(sent.envelope).sort(), ['payload', 'signature']);
    const payload = sent.envelope.payload;
    assert.deepEqual(Object.keys(payload).sort(), ['deviceIdentity', 'installation', 'issuedAt', 'mode', 'nonce', 'origin', 'request', 'target', 'version']);
    assert.equal(payload.version, 1);
    assert.equal(payload.mode, MODE);
    assert.equal(payload.target, 'test');
    assert.equal(payload.installation, 'rev');
    assert.equal(payload.origin, ORIGIN);
    assert.equal(payload.issuedAt, Math.floor(NOW / 1000));
    assert.match(payload.nonce, /^[a-f0-9]{32}$/);
    assert.match(payload.deviceIdentity, /^m1-test-device-[a-f0-9]{24}$/);
    assert.deepEqual(payload.request, operation);
    const expected = createHmac('sha256', ENV.GIB_PROMOTIONS_TEST_BRIDGE_SECRET)
      .update(`gib-promotions-test-bridge:v1\n${canonicalJSON(payload)}`).digest('hex');
    assert.equal(sent.envelope.signature, expected);
    assert.equal(JSON.stringify(sent.envelope).includes(credential()), false);
    assert.equal(JSON.stringify(sent.options.headers).includes(credential()), false);
  }
  assert.equal(new Set(h.calls.map(call => call.envelope.payload.nonce)).size, h.calls.length);
  assert.equal(new Set(h.calls.map(call => call.envelope.payload.deviceIdentity)).size, 1);
  await h.run(request(API, { cookie: `${COOKIE}=${credential(undefined, NOW, 0x39)}` }));
  assert.notEqual(h.calls.at(-1).envelope.payload.deviceIdentity, h.calls[0].envelope.payload.deviceIdentity);
});

test('malformed payloads and unselected registration instructors are rejected without forwarding', async () => {
  const register = { operation: 'registerStudent', requestId: 'synthetic-register-001', displayName: 'TEST New Student', distinguishingLabel: 'Evening' };
  const invalid = [
    null, [], {}, { operation: 'deleteStudent' }, { ...LOOKUPS[0], recorderIdentity: 'forged' },
    { ...SAVE, recorderIdentity: 'forged' }, { ...SAVE, approverId: '' },
    register, { ...register, approverId: '' }, { ...register, approverId: 'another-instructor' }
  ];
  for (const body of invalid) {
    const h = serverHarness();
    assert.ok((await h.run(request(API, { body }))).status >= 400, JSON.stringify(body));
    assert.equal(h.calls.length, 0);
  }
  for (const options of [
    { rawBody: '{invalid json' }, { rawBody: 'x'.repeat(100000) },
    { contentType: 'text/plain' }, { contentType: null }
  ]) {
    const h = serverHarness();
    assert.ok((await h.run(request(API, options))).status >= 400);
    assert.equal(h.calls.length, 0);
  }
});

test('typed unlisted instructor names reach the bridge unchanged without adding a name requirement to lookup', async () => {
  const h = serverHarness();
  for (const approverName of [
    'TEST Guest Instructor Not Listed', "TEST José  O'Neill-Smith", 'TEST 教練 李', '  TEST aLeX McKay  ',
    'x'.repeat(120), '=TEST Coach', '+TEST Coach', '-TEST Coach', '@TEST Coach', "'TEST Coach"
  ]) {
    const intent = namedRequest(SAVE, approverName);
    const response = await result(await h.run(request(API, { body: intent })));
    assert.equal(response.status, 200, approverName);
    const forwarded = h.calls.at(-1).envelope;
    assert.deepEqual(forwarded.payload.request, intent, 'transport preserves the exact original request used for idempotent retry');
    assert.equal(Object.hasOwn(forwarded.payload.request, 'approverId'), false);
    assert.match(forwarded.payload.deviceIdentity, /^m1-test-device-/);
    assert.notEqual(forwarded.payload.deviceIdentity, approverName);
  }
  for (const body of LOOKUPS) {
    assert.equal((await h.run(request(API, { body }))).status, 200);
    assert.deepEqual(h.calls.at(-1).envelope.payload.request, body);
  }
});

test('invalid or ambiguous typed attribution is refused before Google for every writing operation', async () => {
  const writes = [
    SAVE,
    { operation: 'registerStudent', requestId: 'synthetic-register-001', displayName: 'TEST New Student', distinguishingLabel: 'Evening' },
    { operation: 'confirmRank', requestId: 'synthetic-rank-001', studentId: 'fixture-student-001', expectedRevision: 1, rank: { belt: 'Blue Belt', marks: 2 }, reason: 'TEST explicit current rank' },
    { operation: 'correctLatest', requestId: 'synthetic-correction-001', studentId: 'fixture-student-001', expectedRevision: 2, correctsEventId: 'synthetic-event-001', rank: { belt: 'Blue Belt', marks: 2 }, reason: 'TEST correction' }
  ];
  const invalid = ['', '   ', null, 123, [], {}, 'x'.repeat(121), 'TEST\nCoach', 'TEST\tCoach', 'TEST\u0000Coach', 'TEST\u001fCoach', 'TEST\u007fCoach', 'TEST\u0085Coach'];
  for (const write of writes) for (const name of invalid) {
    const h = serverHarness();
    const response = await result(await h.run(request(API, { body: namedRequest(write, name) })));
    assert.ok(response.status >= 400, `${write.operation}: ${JSON.stringify(name)}`);
    assert.equal(response.body.ok, false);
    assert.equal(h.calls.length, 0);
  }
  for (const body of [
    { ...SAVE, approverName: 'TEST Coach Avery' },
    { ...namedRequest(SAVE), recorderIdentity: 'forged-device' },
    { ...namedRequest(SAVE), approverLabel: 'forged-label' }
  ]) {
    const h = serverHarness();
    assert.ok((await h.run(request(API, { body }))).status >= 400);
    assert.equal(h.calls.length, 0);
  }
});

test('legacy approverId requests retain their exact wire payload and unconfirmed save recovery', async () => {
  const h = serverHarness();
  const first = await h.run(request(API, { body: SAVE }));
  assert.equal(first.status, 200);
  assert.deepEqual(h.calls[0].envelope.payload.request, SAVE);
  assert.equal(Object.hasOwn(h.calls[0].envelope.payload.request, 'approverName'), false);
  const outage = serverHarness({ fetch: async () => { throw new Error('Synthetic lost response'); } });
  const unconfirmed = await result(await outage.run(request(API, { body: SAVE })));
  assert.equal(unconfirmed.body.error.retryable, true);
  assert.equal(unconfirmed.body.requestId, SAVE.requestId);
  assert.equal((await h.run(request(API, { body: SAVE }))).status, 200);
  assert.deepEqual(h.calls.at(-1).envelope.payload.request, SAVE);
});

test('transport outages and unbound receiver replies leave the same save unconfirmed without exposing private errors', async () => {
  const responses = [
    async () => { throw new Error(`Private failure ${ENV.GIB_PROMOTIONS_TEST_BRIDGE_SECRET}`); },
    async () => new Response('Private TEST login required', { status: 200 }),
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response(JSON.stringify({ ok: true, data: { saved: true } })),
    async () => new Response(JSON.stringify({ bridge: MODE, target: 'test', installation: 'richmond', requestNonce: '0'.repeat(32), result: { ok: true, data: {} } })),
    async () => new Response(JSON.stringify({ bridge: MODE, target: 'test', installation: 'rev', requestNonce: '0'.repeat(32), result: { ok: true, data: {} } }))
  ];
  for (const fetch of responses) {
    const h = serverHarness({ fetch });
    const response = await result(await h.run(request(API, { body: SAVE })));
    assert.ok(response.status >= 400);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.retryable, true);
    assert.equal(response.body.requestId, SAVE.requestId);
    noPrivateConfiguration(response.body);
  }
});

async function startPairing(h) {
  const response = await result(await h.run(request(INSTALL, { cookie: '', body: { operation: 'start' } })));
  assert.equal(response.status, 200);
  assert.equal(response.body.result, 'pending');
  assert.match(response.body.pairingCode, /^[A-F0-9]{10}$/);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-gib_m1_promotions_test_pending=/);
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(cookie.includes(flag), flag);
  assert.equal(JSON.stringify(response.body).includes(cookie.split(';')[0].split('=')[1]), false);
  return { pairingCode: response.body.pairingCode, cookie: cookie.split(';')[0] };
}

test('one-use approval authorizes only the requesting browser and concurrent approval succeeds once', async () => {
  const store = oneTimeStore();
  const h = serverHarness({ store });
  const pairing = await startPairing(h);
  const pending = await result(await h.run(request(INSTALL, { cookie: pairing.cookie, body: { operation: 'poll' } })));
  assert.equal(pending.body.result, 'pending');
  assert.equal(pending.headers.has('set-cookie'), false);
  assert.ok((await h.run(request(API, { cookie: pairing.cookie }))).status >= 400);
  const capability = installCapability({ pairingCode: pairing.pairingCode });
  const responses = await Promise.all(Array.from({ length: 2 }, () => h.run(request(INSTALL, { cookie: '', body: { operation: 'approve', capability } }))));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status >= 400).length, 1);
  for (const response of responses) assert.equal(response.headers.has('set-cookie'), false, 'approval does not authorize the approving browser');
  const withoutPending = await h.run(request(INSTALL, { cookie: '', body: { operation: 'poll' } }));
  assert.ok(withoutPending.status >= 400);
  assert.equal(withoutPending.headers.has('set-cookie'), false);
  const installed = await h.run(request(INSTALL, { cookie: pairing.cookie, body: { operation: 'poll' } }));
  assert.equal(installed.status, 200);
  const cookie = installed.headers.getSetCookie().find(value => value.startsWith(`${COOKIE}=`));
  assert.ok(cookie);
  assert.match(cookie, new RegExp(`^${COOKIE}=v1\\.`));
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(cookie.includes(flag), flag);
  assert.equal(cookie.includes('Domain='), false);
  const body = JSON.parse(await installed.text());
  assert.equal(body.ok, true);
  assert.equal(JSON.stringify(body).includes(capability), false);
  assert.equal(JSON.stringify(body).includes(cookie.split(';')[0].split('=')[1]), false);
  noPrivateConfiguration(body);
  assert.equal(store.entries.size, 2, 'the pending record and consumed capability are distinct');
  assert.equal(h.calls.length, 0, 'installing a TEST device must not read the workbook');
  const deliveryRetry = await h.run(request(INSTALL, { cookie: pairing.cookie, body: { operation: 'poll' } }));
  assert.equal(deliveryRetry.headers.getSetCookie().find(value => value.startsWith(`${COOKIE}=`)), cookie, 'a lost delivery retries the same device credential');
  assert.equal((await h.run(request(API, { cookie: cookie.split(';')[0] }))).status, 200);
});

test('installer rejects absent, stale, tampered or misplaced capabilities before consuming storage', async () => {
  const h = serverHarness({ store: oneTimeStore() });
  const pairing = await startPairing(h);
  const capability = installCapability({ pairingCode: pairing.pairingCode });
  const writesBefore = h.deps.store.calls.length;
  const invalid = [
    request(INSTALL, { cookie: '', body: {} }),
    request(INSTALL, { cookie: '', body: { capability } }),
    request(INSTALL, { cookie: '', body: { operation: 'approve', capability: `${capability}changed` } }),
    request(INSTALL, { cookie: '', body: { operation: 'approve', capability, extra: true } }),
    request(`${INSTALL}?capability=${encodeURIComponent(capability)}`, { cookie: '', body: {} }),
    request(INSTALL, { cookie: '', body: { operation: 'approve', capability }, origin: 'https://gib-live.netlify.app' }),
    request(INSTALL, { cookie: '', body: { operation: 'approve', capability }, origin: 'https://gib-richmond-test.netlify.app' })
  ];
  for (const input of invalid) assert.ok((await h.run(input)).status >= 400);
  assert.equal(h.deps.store.calls.length, writesBefore);
  for (const now of [NOW + 600000, NOW - 31000]) {
    const stale = serverHarness({ now, store: oneTimeStore() });
    assert.ok((await stale.run(request(INSTALL, { cookie: '', body: { operation: 'approve', capability } }))).status >= 400);
    assert.equal(stale.deps.store.calls.length, 0);
  }
});

test('approval signatures bind exact TEST scope, run, browser pairing, nonce and bounded time fields', () => {
  const config = runtime.promotionsRuntimeConfig(ENV, { siteId: SITE_ID, installationId: 'rev' });
  const capability = installCapability();
  assert.ok(runtime.readPromotionsInstallCapability(capability, config, NOW));
  assert.ok(runtime.readPromotionsInstallCapability(capability, config, NOW + 599999));
  assert.equal(runtime.readPromotionsInstallCapability(capability, config, NOW + 600000), null);
  const [encoded] = capability.split('.');
  const original = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const invalid = [
    { version: 2 }, { purpose: 'production-tablet-install' }, { origin: 'https://gib-live.netlify.app' },
    { installation: 'richmond' }, { runId: 'another-valid-test-run' }, { pairingCode: 'invalid' },
    { nonce: '' }, { issuedAt: String(original.issuedAt) }, { expiresAt: original.issuedAt + 601 },
    { expiresAt: original.issuedAt }, { extra: 'unsupported' }
  ];
  for (const changes of invalid) {
    const changed = Buffer.from(canonicalJSON({ ...original, ...changes })).toString('base64url');
    const signature = createHmac('sha256', ENV.GIB_PROMOTIONS_TEST_INSTALL_SECRET)
      .update(`gib-promotions-test-install:v1\n${changed}`).digest('base64url');
    assert.equal(runtime.readPromotionsInstallCapability(`${changed}.${signature}`, config, NOW), null, JSON.stringify(changes));
  }
  assert.equal(runtime.readPromotionsInstallCapability(capability, { ...config, installSecret: ENV.GIB_PROMOTIONS_TEST_BRIDGE_SECRET }, NOW), null);
  assert.throws(() => installCapability({ expiresAt: original.issuedAt + 601 }));
});

test('installer storage outage and failed atomic claims never issue an authorization cookie', async () => {
  for (const set of [
    async () => { throw new Error('Synthetic replay store unavailable'); },
    async () => ({ modified: false }),
    async () => undefined
  ]) {
    const h = serverHarness({ store: oneTimeStore() });
    const pairing = await startPairing(h);
    const capability = installCapability({ pairingCode: pairing.pairingCode });
    h.deps.store.set = set;
    const response = await result(await h.run(request(INSTALL, { cookie: '', body: { operation: 'approve', capability } })));
    assert.ok(response.status >= 400);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(response.body.ok, false);
    noPrivateConfiguration(response.body);
    assert.equal(h.calls.length, 0);
  }
});

test('pending-cookie substitution, expiry and store reads cannot grant an unapproved browser access', async () => {
  const h = serverHarness({ store: oneTimeStore() });
  const first = await startPairing(h);
  const second = await startPairing(h);
  const capability = installCapability({ pairingCode: first.pairingCode });
  assert.equal((await h.run(request(INSTALL, { cookie: '', body: { operation: 'approve', capability } }))).status, 200);
  const other = await result(await h.run(request(INSTALL, { cookie: second.cookie, body: { operation: 'poll' } })));
  assert.equal(other.body.result, 'pending');
  assert.equal(other.headers.has('set-cookie'), false);
  for (const cookie of [
    `${first.cookie}corrupted`, `${first.cookie}; ${second.cookie}`, `${second.cookie}; ${first.cookie}`
  ]) {
    const response = await h.run(request(INSTALL, { cookie, body: { operation: 'poll' } }));
    assert.ok(response.status >= 400);
    assert.equal(response.headers.has('set-cookie'), false);
  }
  const expired = serverHarness({ store: h.deps.store, now: NOW + 600000 });
  const stale = await expired.run(request(INSTALL, { cookie: first.cookie, body: { operation: 'poll' } }));
  assert.ok(stale.status >= 400);
  assert.equal(stale.headers.has('set-cookie'), false);
  h.deps.store.getWithMetadata = async () => { throw new Error('Synthetic pairing read outage'); };
  const unavailable = await h.run(request(INSTALL, { cookie: first.cookie, body: { operation: 'poll' } }));
  assert.ok(unavailable.status >= 400);
  assert.equal(unavailable.headers.has('set-cookie'), false);
});

test('a consumed capability stays burned when approval-state confirmation fails', async () => {
  const h = serverHarness({ store: oneTimeStore() });
  const pairing = await startPairing(h);
  const capability = installCapability({ pairingCode: pairing.pairingCode });
  const set = h.deps.store.set.bind(h.deps.store);
  h.deps.store.set = (key, value, options) => options.onlyIfMatch ? { modified: false } : set(key, value, options);
  const failed = await h.run(request(INSTALL, { cookie: '', body: { operation: 'approve', capability } }));
  assert.ok(failed.status >= 400);
  assert.equal(failed.headers.has('set-cookie'), false);
  h.deps.store.set = set;
  const replay = await h.run(request(INSTALL, { cookie: '', body: { operation: 'approve', capability } }));
  assert.ok(replay.status >= 400);
  assert.equal(replay.headers.has('set-cookie'), false);
  const poll = await result(await h.run(request(INSTALL, { cookie: pairing.cookie, body: { operation: 'poll' } })));
  assert.equal(poll.body.result, 'pending');
  assert.equal(poll.headers.has('set-cookie'), false);
});

const diagnosticHeaders = response => [...response.headers].filter(([name]) => name.startsWith('x-gib-test-'));

test('TEST observes the one-time content redirect as GET with one signed POST and the same timeout signal', async () => {
  const calls = [];
  let envelope;
  const h = serverHarness({fetch:async (url, options) => {
    calls.push({url,options});
    assert.equal(options.redirect, 'manual');
    if (calls.length === 1) {
      envelope = JSON.parse(options.body);
      return new Response('', {status:302,headers:{location:'https://script.googleusercontent.com/PRIVATE_RESPONSE'}});
    }
    assert.equal(options.method,'GET'); assert.equal(options.body,undefined);
    assert.deepEqual(options.headers,{Accept:'application/json'});
    assert.equal(options.signal,calls[0].options.signal);
    return new Response(JSON.stringify({bridge:MODE,target:'test',installation:'rev',requestNonce:envelope.payload.nonce,result:{ok:true,data:{testOnly:true}}}),{headers:{'content-type':'application/json'}});
  }});
  const response = await h.run(request());
  assert.equal(response.status,200); assert.equal(calls.length,2);
  assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
  assert.deepEqual(diagnosticHeaders(response),[]);
});

test('TEST failure trace exposes the unexpected GET return to Google script without exposing redirect URLs', async () => {
  let calls = 0;
  const h = serverHarness({fetch:async (_url, options) => {
    calls += 1;
    if (calls === 1) return new Response('',{status:302,headers:{location:'https://script.googleusercontent.com/PRIVATE_RESPONSE'}});
    assert.equal(options.method,'GET'); assert.equal(options.body,undefined);
    if (calls === 2) return new Response('',{status:302,headers:{location:'https://script.google.com/macros/s/PRIVATE/exec'}});
    return new Response('<html>PRIVATE owner page</html>',{headers:{'content-type':'text/html'}});
  }});
  const response = await h.run(request());
  assert.equal(response.status,503); assert.equal(calls,3);
  const trace = JSON.parse(response.headers.get('x-gib-test-upstream-trace'));
  assert.deepEqual(trace.map(({method,host,status,type,destination})=>({method,host,status,type,destination})),[
    {method:'POST',host:'google-script',status:302,type:'other',destination:'google-content'},
    {method:'GET',host:'google-content',status:302,type:'other',destination:'google-script'},
    {method:'GET',host:'google-script',status:200,type:'html',destination:'none'}
  ]);
  assert.ok(trace.every(hop=>Number.isInteger(hop.ms)&&hop.ms>=0));
  assert.equal(response.headers.get('x-gib-test-upstream'),'json');
  assert.equal(JSON.stringify([...response.headers]).includes('PRIVATE'),false);
});

test('TEST redirect tracing refuses other destinations and stops at the existing fetch redirect limit without retries', async () => {
  for (const target of ['https://accounts.google.com/PRIVATE','https://evil.example/PRIVATE','http://script.google.com/PRIVATE','https://script.googleusercontent.com/LOOP']) {
    let calls=0;
    const h=serverHarness({fetch:async()=>{calls+=1;return new Response('',{status:302,headers:{location:target}});}});
    const response=await h.run(request());
    assert.equal(response.status,503);
    assert.equal(calls,target.endsWith('/LOOP')?21:1);
    assert.equal(response.headers.get('x-gib-test-upstream'),'http');
    assert.equal(JSON.stringify([...response.headers]).includes('PRIVATE'),false);
  }
});

test('authenticated TEST failures identify only fixed phases and numeric timing without losing original intent', async () => {
  const privateText = `SYNTHETIC_PRIVATE_ERROR ${ENV.GIB_PROMOTIONS_TEST_WEBHOOK_URL} ${ENV.GIB_PROMOTIONS_TEST_BRIDGE_SECRET}`;
  const cases = [
    ['fetch', null, async () => { throw new DOMException(privateText, 'TimeoutError'); }],
    ['body', '200', async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateText)); } }))],
    ['body', '200', async () => new Response('x'.repeat(1000001))],
    ['http', '503', async () => new Response(privateText, { status: 503 })],
    ['json', '200', async () => new Response(privateText)],
    ['envelope', '200', async () => new Response(JSON.stringify({ privateText, ok: true }))]
  ];
  for (const [phase, status, fetchResult] of cases) {
    let calls = 0;
    const h = serverHarness({ fetch: async (...args) => { calls += 1; return fetchResult(...args); } });
    const response = await h.run(request(API, { body: namedRequest(SAVE) }));
    const value = await result(response);
    assert.equal(value.status, 503);
    assert.equal(value.body.error.code, 'UNAVAILABLE');
    assert.equal(value.body.error.retryable, true);
    assert.equal(value.body.requestId, SAVE.requestId);
    assert.equal(value.headers.get('x-gib-test-upstream'), phase);
    assert.match(value.headers.get('x-gib-test-upstream-ms'), /^\d+$/u);
    assert.equal(value.headers.get('x-gib-test-upstream-status'), status);
    assert.equal(diagnosticHeaders(response).length, status === null ? 7 : 8);
    assert.equal(calls, 1, 'diagnosis must never automatically resend the request');
    const publicOutput = JSON.stringify({ body: value.body, headers: [...value.headers] });
    assert.equal(publicOutput.includes('SYNTHETIC_PRIVATE_ERROR'), false);
    noPrivateConfiguration(publicOutput);
  }
});

test('TEST failure categories distinguish returned HTML, HTTP errors, authorization denials and envelope mismatch without revealing content', async () => {
  const cases = [
    { url:'https://script.google.com/macros/s/PRIVATE/exec?secret=PRIVATE', type:'text/html; charset=utf-8', status:200, redirected:false, text:'<html>PRIVATE</html>', expected:['json','html','google-script','0','none'] },
    { url:'https://accounts.google.com/PRIVATE', type:'text/html', status:200, redirected:true, text:'<html>PRIVATE</html>', expected:['json','html','google-auth','1','none'] },
    { url:'https://script.googleusercontent.com/PRIVATE', type:'application/json', status:200, redirected:true, text:JSON.stringify({ok:false,error:{code:'UNAUTHORIZED',message:'PRIVATE'}}), expected:['envelope','json','google-content','1','bare-auth-denial'] },
    { url:'https://script.googleusercontent.com/PRIVATE', type:'application/json', status:200, redirected:true, text:JSON.stringify({bridge:'wrong',private:'PRIVATE'}), expected:['envelope','json','google-content','1','mismatch'] },
    { url:'https://untrusted.example/PRIVATE', type:'application/octet-stream', status:502, redirected:false, text:'PRIVATE', expected:['http','other','other','0','none'] }
  ];
  for (const item of cases) {
    let calls = 0;
    const h = serverHarness({ fetch:async () => {
      calls += 1;
      const reply = new Response(item.text, {status:item.status, headers:{'content-type':item.type}});
      Object.defineProperties(reply, {url:{value:item.url}, redirected:{value:item.redirected}});
      return reply;
    } });
    const response = await h.run(request());
    assert.equal(response.status, 503);
    assert.deepEqual(['','-type','-host','-redirected','-envelope'].map(suffix => response.headers.get('x-gib-test-upstream'+suffix)), item.expected);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify([...response.headers]).includes('PRIVATE'), false);
    assert.equal((await response.text()).includes('PRIVATE'), false);
  }
});

test('TEST diagnostic headers are absent before authorization and on valid application responses', async () => {
  const h = serverHarness();
  const responses = [
    await h.run(request(API, { cookie: '' })),
    await serverHarness({ env: {} }).run(request()),
    await h.run(request()),
    await h.run(request(API, { body: namedRequest(SAVE, '') })),
    await serverHarness({ fetch: async (_url, options) => {
      const envelope = JSON.parse(options.body);
      return new Response(JSON.stringify({ bridge: MODE, target: 'test', installation: 'rev', requestNonce: envelope.payload.nonce,
        result: { ok: false, error: { code: 'STALE_REVISION', message: 'Reload the student.', retryable: false } } }));
    } }).run(request(API, { body: namedRequest(SAVE) }))
  ];
  for (const response of responses) assert.deepEqual(diagnosticHeaders(response), []);
});

const LIVE_ORIGIN = 'https://gib-live.netlify.app';
const LIVE_ENV = Object.freeze({ ...ENV,
  GIB_PROMOTIONS_LIVE_ENABLED: 'true', GIB_PROMOTIONS_LIVE_INSTALLATION: 'rev', GIB_PROMOTIONS_LIVE_SITE_ID: SITE_ID,
  GIB_PROMOTIONS_LIVE_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_LIVE_PROMOTIONS_RECEIVER/exec',
  GIB_PROMOTIONS_LIVE_BRIDGE_SECRET: 'synthetic-live-bridge-secret-0123456789',
  GIB_M1_PRODUCTION_DEVICE_TOKEN: 'synthetic-existing-production-cookie-0123456789'
});
const liveRequest = (body, options = {}, path = API) => request(path, { origin: LIVE_ORIGIN,
  cookie: `__Host-gib_m1_production_device=${credential(LIVE_ENV.GIB_M1_PRODUCTION_DEVICE_TOKEN)}`, body, ...options });

test('live dispatcher uses its matching target and signing domain while preserving typed intent', async () => {
  for (const intent of [...LOOKUPS, namedRequest(SAVE)]) {
    let calls = 0;
    const h = serverHarness({ env: LIVE_ENV, fetch: async (url, options) => {
      calls += 1;
      assert.equal(url, LIVE_ENV.GIB_PROMOTIONS_LIVE_WEBHOOK_URL);
      const envelope = JSON.parse(options.body);
      assert.equal(envelope.payload.target, 'live');
      assert.equal(envelope.payload.mode, 'm1-authorized-tablet-live-v1');
      assert.match(envelope.payload.deviceIdentity, /^m1-live-device-[0-9a-f]{24}$/u);
      assert.deepEqual(envelope.payload.request, intent);
      assert.equal(envelope.signature, createHmac('sha256', LIVE_ENV.GIB_PROMOTIONS_LIVE_BRIDGE_SECRET)
        .update('gib-promotions-live-bridge:v1\n' + canonicalJSON(envelope.payload)).digest('hex'));
      return new Response(JSON.stringify({ bridge: envelope.payload.mode, target: 'live', installation: 'rev', requestNonce: envelope.payload.nonce,
        result: { ok: true, data: { testOnly: false } } }));
    } });
    const response = await h.run(liveRequest(intent));
    assert.equal((await result(response)).body.data.testOnly, false);
    assert.equal(calls, 1);
    assert.deepEqual(diagnosticHeaders(response), []);
  }
});

test('live failures retain safe uncertainty and never expose TEST diagnostics or cross-target replies', async () => {
  for (const variant of ['fetch', 'body', 'http', 'json', 'target', 'mode', 'nonce']) {
    const h = serverHarness({ env: LIVE_ENV, fetch: async (_url, options) => {
      if (variant === 'fetch') throw new Error('SYNTHETIC_PRIVATE_LIVE_ERROR ' + LIVE_ENV.GIB_PROMOTIONS_LIVE_BRIDGE_SECRET);
      if (variant === 'body') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('SYNTHETIC_PRIVATE_LIVE_ERROR')); } }));
      if (variant === 'http') return new Response('SYNTHETIC_PRIVATE_LIVE_ERROR', { status: 503 });
      if (variant === 'json') return new Response('SYNTHETIC_PRIVATE_LIVE_ERROR');
      const envelope = JSON.parse(options.body);
      return new Response(JSON.stringify({ bridge: variant === 'mode' ? MODE : envelope.payload.mode,
        target: variant === 'target' ? 'test' : 'live', installation: 'rev', requestNonce: variant === 'nonce' ? 'wrong-nonce' : envelope.payload.nonce,
        result: { ok: true, data: { testOnly: false } } }));
    } });
    const response = await h.run(liveRequest(namedRequest(SAVE)));
    const value = await result(response);
    assert.equal(value.status, 503);
    assert.equal(value.body.error.retryable, true);
    assert.equal(value.body.requestId, SAVE.requestId);
    assert.deepEqual(diagnosticHeaders(response), []);
    assert.equal(JSON.stringify(value.body).includes('SYNTHETIC_PRIVATE_LIVE_ERROR'), false);
    assert.equal(JSON.stringify(value.body).includes(LIVE_ENV.GIB_PROMOTIONS_LIVE_BRIDGE_SECRET), false);
  }
});

test('live dispatcher requires typed attribution and denies TEST credentials and installation before Google', async () => {
  const h = serverHarness({ env: LIVE_ENV });
  for (const operation of ['recordPromotion', 'confirmRank', 'correctLatest', 'registerStudent']) {
    const response = await h.run(liveRequest({ ...SAVE, operation }));
    assert.equal(response.status, 400, `${operation} must require typed attribution`);
    assert.deepEqual(diagnosticHeaders(response), []);
  }
  for (const response of [
    await h.run(liveRequest(LOOKUPS[0], { cookie: '' })),
    await h.run(liveRequest(LOOKUPS[0], { cookie: `${COOKIE}=${credential()}` })),
    await h.run(liveRequest({ operation: 'start' }, {}, INSTALL))
  ]) {
    assert.ok([401, 403].includes(response.status));
    assert.deepEqual(diagnosticHeaders(response), []);
  }
  assert.equal(h.calls.length, 0);
});
