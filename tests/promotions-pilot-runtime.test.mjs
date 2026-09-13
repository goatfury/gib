import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  createPromotionsEnvelope, createPromotionsInstallCapability, handlePromotionsInstall,
  promotionsDeviceCredential, promotionsRuntimeConfig, readPromotionsInstallCapability,
  validPromotionsRequest
} from '../netlify/functions/_lib/promotions-runtime.mts';
import { createProductionDeviceCredential, PRODUCTION_DEVICE_COOKIE } from '../netlify/functions/_lib/m1-production-runtime.mjs';

// Preparation only: fake keys and in-memory Requests; no deployment or network.
const NOW = Date.parse('2026-09-13T15:20:30.000Z');
const LIVE = 'https://gib-live.netlify.app';
const TEST = 'https://deploy-preview-85--gib-live.netlify.app';
const API = '/api/m1-promotions';
const INSTALL = '/api/m1-promotions-install';
const SITE = 'synthetic-revolution-site-id';
const TEST_COOKIE = '__Host-gib_m1_promotions_test_device';
const ENV = Object.freeze({
  GIB_PROMOTIONS_TEST_ENABLED: 'true', GIB_PROMOTIONS_TEST_INSTALLATION: 'rev', GIB_PROMOTIONS_TEST_ORIGIN: TEST,
  GIB_PROMOTIONS_TEST_SITE_ID: SITE,
  GIB_PROMOTIONS_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_PROMOTION_RECEIVER/exec',
  GIB_PROMOTIONS_TEST_BRIDGE_SECRET: 'synthetic-test-bridge-secret-0123456789',
  GIB_PROMOTIONS_TEST_DEVICE_SECRET: 'synthetic-test-device-secret-0123456789',
  GIB_PROMOTIONS_TEST_INSTALL_SECRET: 'synthetic-test-install-secret-0123456789',
  GIB_PROMOTIONS_TEST_INSTALL_RUN_ID: 'synthetic-install-run-20260913',
  GIB_PROMOTIONS_LIVE_ENABLED: 'true', GIB_PROMOTIONS_LIVE_INSTALLATION: 'rev', GIB_PROMOTIONS_LIVE_SITE_ID: SITE,
  GIB_PROMOTIONS_LIVE_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_LIVE_PROMOTION_RECEIVER/exec',
  GIB_PROMOTIONS_LIVE_BRIDGE_SECRET: 'synthetic-live-bridge-secret-0123456789',
  GIB_M1_PRODUCTION_DEVICE_TOKEN: 'synthetic-existing-production-device-0123456789'
});
const config = (origin = LIVE, changes = {}, options = {}) => promotionsRuntimeConfig({ ...ENV, ...changes }, {
  siteId: SITE, installationId: 'rev', requestOrigin: origin, ...options
});
const device = (key = ENV.GIB_M1_PRODUCTION_DEVICE_TOKEN, when = NOW) => createProductionDeviceCredential(key, size => Buffer.alloc(size, 0x41), when);
function request(origin = LIVE, path = API, { cookie = `${PRODUCTION_DEVICE_COOKIE}=${device()}`, method = 'POST', headers = {} } = {}) {
  return new Request(`${origin}${path}`, {
    method, headers: { Host: new URL(origin).host, Origin: origin, 'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json', Cookie: cookie, ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: '{"operation":"bootstrap"}' })
  });
}
function canonical(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

test('live selection is off by default and requires every explicit Revolution/site field', () => {
  assert.equal(promotionsRuntimeConfig({}, { requestOrigin: LIVE, installationId: 'rev', siteId: SITE }), null);
  for (const flag of [undefined, '', 'false', true, 'TRUE', ' true']) assert.equal(config(LIVE, { GIB_PROMOTIONS_LIVE_ENABLED: flag }), null);
  for (const installation of [undefined, '', 'richmond']) assert.equal(config(LIVE, { GIB_PROMOTIONS_LIVE_INSTALLATION: installation }), null);
  for (const site of [undefined, '', 'another-site']) assert.equal(config(LIVE, { GIB_PROMOTIONS_LIVE_SITE_ID: site }), null);
  for (const options of [{ siteId: undefined }, { siteId: 'another-site' }, { installationId: undefined }, { installationId: 'richmond' }]) {
    assert.equal(config(LIVE, {}, options), null);
  }
  const ready = config();
  assert.equal(ready.target, 'live');
  assert.equal(ready.mode, 'm1-authorized-tablet-live-v1');
  assert.equal(ready.signatureDomain, 'gib-promotions-live-bridge:v1\n');
  assert.equal(ready.origin, LIVE);
  assert.equal(ready.deviceSecret, ENV.GIB_M1_PRODUCTION_DEVICE_TOKEN);
  assert.equal(Object.hasOwn(ready, 'installSecret'), false);
  assert.equal(Object.hasOwn(ready, 'runId'), false);
  assert.equal(Object.isFrozen(ready), true);
});

test('request origin selects one target with no fallback across targets or other gyms', () => {
  for (const origin of ['', null, `${LIVE}/`, `${LIVE}:443`, `${LIVE}:8443`, LIVE.replace('https:', 'http:'),
    `${LIVE}.attacker.invalid`, 'https://gib-richmond-live.netlify.app', 'https://gib-richmond-test.netlify.app',
    'https://0123456789abcdef01234567--gib-live.netlify.app', 'https://deploy-preview-86--gib-live.netlify.app']) {
    assert.equal(config(origin), null, String(origin));
  }
  assert.equal(config(TEST).target, 'test');
  assert.equal(config(TEST, { GIB_PROMOTIONS_TEST_ENABLED: 'false' }), null);
  assert.equal(config(LIVE, { GIB_PROMOTIONS_LIVE_ENABLED: 'false' }), null);
  assert.equal(config(LIVE, { GIB_PROMOTIONS_TEST_ENABLED: 'false' }).target, 'live');
  assert.equal(config(TEST, { GIB_PROMOTIONS_LIVE_ENABLED: 'false' }).target, 'test');
  const legacy = promotionsRuntimeConfig(ENV, { siteId: SITE, installationId: 'rev' });
  assert.equal(legacy.target, 'test', 'omitting origin keeps the existing TEST setup contract');
  assert.equal(promotionsRuntimeConfig({ ...ENV, GIB_PROMOTIONS_TEST_ENABLED: 'false' }, { siteId: SITE, installationId: 'rev' }), null);
});

test('live requires its own bridge destination and existing production key, with no TEST credential fallback', () => {
  for (const field of ['GIB_PROMOTIONS_LIVE_WEBHOOK_URL', 'GIB_PROMOTIONS_LIVE_BRIDGE_SECRET', 'GIB_M1_PRODUCTION_DEVICE_TOKEN']) {
    for (const value of [undefined, '', 'short']) assert.equal(config(LIVE, { [field]: value }), null, field);
  }
  assert.equal(config(LIVE, { GIB_M1_PRODUCTION_DEVICE_TOKEN: undefined, GIB_PROMOTIONS_LIVE_DEVICE_SECRET: 'synthetic-new-key-must-never-be-used-0123456789' }), null);
  for (const url of ['https://attacker.invalid/exec', ENV.GIB_PROMOTIONS_LIVE_WEBHOOK_URL.replace('https:', 'http:'),
    `${ENV.GIB_PROMOTIONS_LIVE_WEBHOOK_URL}?secret=invalid`, `${ENV.GIB_PROMOTIONS_LIVE_WEBHOOK_URL}#invalid`,
    ENV.GIB_PROMOTIONS_LIVE_WEBHOOK_URL.replace('/exec', '/dev'),
    ENV.GIB_PROMOTIONS_LIVE_WEBHOOK_URL.replace('script.google.com', 'script.google.com:8443'),
    ENV.GIB_PROMOTIONS_LIVE_WEBHOOK_URL.replace('script.google.com', 'user:password@script.google.com')]) {
    assert.equal(config(LIVE, { GIB_PROMOTIONS_LIVE_WEBHOOK_URL: url }), null);
  }
  assert.equal(config(LIVE, { GIB_PROMOTIONS_LIVE_WEBHOOK_URL: ENV.GIB_PROMOTIONS_TEST_WEBHOOK_URL }).target, 'live',
    'a shared dual-target receiver is permitted; signing keys and modes remain separate');
});

test('reusing device or bridge secrets across targets rejects both affected runtime selections', () => {
  const testFields = ['GIB_PROMOTIONS_TEST_BRIDGE_SECRET', 'GIB_PROMOTIONS_TEST_DEVICE_SECRET', 'GIB_PROMOTIONS_TEST_INSTALL_SECRET'];
  for (const liveField of ['GIB_PROMOTIONS_LIVE_BRIDGE_SECRET', 'GIB_M1_PRODUCTION_DEVICE_TOKEN']) {
    for (const testField of testFields) {
      const changes = { [liveField]: ENV[testField] };
      assert.equal(config(LIVE, changes), null);
      assert.equal(config(TEST, changes), null);
    }
  }
  assert.equal(config(LIVE, { GIB_PROMOTIONS_LIVE_BRIDGE_SECRET: ENV.GIB_M1_PRODUCTION_DEVICE_TOKEN }), null);
  assert.equal(config(TEST, { GIB_PROMOTIONS_LIVE_BRIDGE_SECRET: ENV.GIB_M1_PRODUCTION_DEVICE_TOKEN }).target, 'test',
    'an unrelated invalid live configuration does not disable otherwise isolated TEST');
});

test('live request validation accepts only the canonical same-origin API and never an installer route', () => {
  const live = config();
  assert.equal(validPromotionsRequest(request(), live), true);
  for (const input of [request(TEST), request('https://gib-richmond-live.netlify.app'),
    request('https://0123456789abcdef01234567--gib-live.netlify.app'),
    request(LIVE, INSTALL), request(LIVE, `${API}/`), request(LIVE, `${API}?target=test`), request(LIVE, `${API}#test`),
    request(LIVE, '/api/m1-kiosk-sync'), request(LIVE, API, { method: 'GET' }),
    request(LIVE, API, { headers: { Origin: TEST } }), request(LIVE, API, { headers: { Host: 'attacker.invalid' } }),
    request(LIVE, API, { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
    request(LIVE, API, { headers: { 'Sec-Fetch-Site': 'same-site' } }),
    request(LIVE, API, { headers: { 'Content-Type': 'text/plain' } })]) {
    assert.equal(validPromotionsRequest(input, live), false, input.url);
  }
  for (const name of ['Host', 'Origin', 'Sec-Fetch-Site', 'Content-Type']) {
    const input = request(); input.headers.delete(name);
    assert.equal(validPromotionsRequest(input, live), false, name);
  }
  assert.equal(validPromotionsRequest(request(TEST, INSTALL), config(TEST)), true);
  assert.equal(validPromotionsRequest(request(), { ...live, target: 'test' }), false);
});

test('live accepts the existing signed production cookie only, including expiry and duplicate rejection', () => {
  const live = config();
  const current = device();
  const testDevice = device(ENV.GIB_PROMOTIONS_TEST_DEVICE_SECRET);
  assert.equal(PRODUCTION_DEVICE_COOKIE, '__Host-gib_m1_production_device');
  assert.equal(promotionsDeviceCredential(request(), live, NOW), current);
  for (const cookie of ['', `${TEST_COOKIE}=${current}`, `__Host-gib_m1_richmond_production_device=${current}`,
    `${PRODUCTION_DEVICE_COOKIE}=${testDevice}`, `${PRODUCTION_DEVICE_COOKIE}=invalid`,
    `${PRODUCTION_DEVICE_COOKIE}=${current}; ${PRODUCTION_DEVICE_COOKIE}=${current}`,
    `${PRODUCTION_DEVICE_COOKIE}=invalid; ${PRODUCTION_DEVICE_COOKIE}=${current}`,
    `${PRODUCTION_DEVICE_COOKIE}=${current}; ${PRODUCTION_DEVICE_COOKIE}=invalid`,
    `${PRODUCTION_DEVICE_COOKIE}=${device(undefined, NOW - 400 * 86400000)}`,
    `${PRODUCTION_DEVICE_COOKIE}=${device(undefined, NOW + 301000)}`]) {
    assert.equal(promotionsDeviceCredential(request(LIVE, API, { cookie }), live, NOW), '');
  }
  assert.equal(promotionsDeviceCredential(request(TEST, API, { cookie: `${TEST_COOKIE}=${testDevice}` }), config(TEST), NOW), testDevice);
  assert.equal(promotionsDeviceCredential(request(TEST, API, { cookie: `${TEST_COOKIE}=${current}` }), config(TEST), NOW), '');
  assert.equal(promotionsDeviceCredential(request(), { ...live, mode: 'm1-authorized-tablet-test-v1' }, NOW), '');
});

test('live signs unchanged intent under a distinct domain and device attribution without exposing credentials', () => {
  const live = config();
  const intent = { operation: 'recordPromotion', requestId: 'synthetic-live-request-001', studentId: 'synthetic-student-001',
    expectedRevision: 3, action: 'stripe', approverName: "Synthetic Coach O'Neill" };
  const envelope = createPromotionsEnvelope(live, device(), intent, NOW, size => Buffer.alloc(size, 0x32));
  assert.deepEqual(envelope.payload, {
    version: 1, mode: 'm1-authorized-tablet-live-v1', target: 'live', installation: 'rev', origin: LIVE,
    issuedAt: Math.floor(NOW / 1000), nonce: '32'.repeat(16),
    deviceIdentity: envelope.payload.deviceIdentity, request: intent
  });
  assert.match(envelope.payload.deviceIdentity, /^m1-live-device-[0-9a-f]{24}$/);
  const digest = domain => createHmac('sha256', ENV.GIB_PROMOTIONS_LIVE_BRIDGE_SECRET)
    .update(domain + canonical(envelope.payload)).digest('hex');
  assert.equal(envelope.signature, digest('gib-promotions-live-bridge:v1\n'));
  assert.notEqual(envelope.signature, digest('gib-promotions-test-bridge:v1\n'));
  for (const hidden of [device(), ENV.GIB_M1_PRODUCTION_DEVICE_TOKEN, ENV.GIB_PROMOTIONS_LIVE_BRIDGE_SECRET, live.webhookUrl]) {
    assert.equal(JSON.stringify(envelope).includes(hidden), false);
  }
  const retry = createPromotionsEnvelope(live, device(), intent, NOW + 1000, size => Buffer.alloc(size, 0x33));
  assert.deepEqual(retry.payload.request, intent);
  assert.equal(retry.payload.deviceIdentity, envelope.payload.deviceIdentity);
  assert.notEqual(retry.payload.nonce, envelope.payload.nonce);
  assert.throws(() => createPromotionsEnvelope({ ...live, signatureDomain: 'gib-promotions-test-bridge:v1\n' }, device(), intent, NOW));
  const testEnvelope = createPromotionsEnvelope(config(TEST), device(ENV.GIB_PROMOTIONS_TEST_DEVICE_SECRET), intent, NOW, size => Buffer.alloc(size, 0x32));
  assert.equal(testEnvelope.payload.target, 'test');
  assert.equal(testEnvelope.payload.mode, 'm1-authorized-tablet-test-v1');
  assert.match(testEnvelope.payload.deviceIdentity, /^m1-test-device-[0-9a-f]{24}$/);
  assert.equal(testEnvelope.signature, createHmac('sha256', ENV.GIB_PROMOTIONS_TEST_BRIDGE_SECRET)
    .update('gib-promotions-test-bridge:v1\n' + canonical(testEnvelope.payload)).digest('hex'));
});

test('live cannot create, read, approve or poll TEST installation capabilities and never accesses installer storage', async () => {
  const live = config();
  const capability = createPromotionsInstallCapability(config(TEST), {
    issuedAt: NOW / 1000, expiresAt: NOW / 1000 + 600, nonce: 'ab'.repeat(16), pairingCode: '012345ABCD'
  });
  assert.ok(readPromotionsInstallCapability(capability, config(TEST), NOW));
  assert.equal(readPromotionsInstallCapability(capability, live, NOW), null);
  assert.throws(() => createPromotionsInstallCapability(live, { pairingCode: '012345ABCD' }));
  const dependencies = { now: NOW, get store() { assert.fail('Live must never open installer storage.'); } };
  for (const input of [{ operation: 'start' }, { operation: 'poll' }, { operation: 'approve', capability }]) {
    const result = await handlePromotionsInstall(request(LIVE, INSTALL), input, live, dependencies);
    assert.equal(result.status, 403);
    assert.equal(result.body.ok, false);
    assert.deepEqual(result.cookies, []);
  }
});
