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
  for (const operation of [...LOOKUPS, SAVE]) for (const cookie of invalidCookies) {
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
  for (const operation of [...LOOKUPS, ...writes]) {
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
