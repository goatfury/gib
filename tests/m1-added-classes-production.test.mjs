import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { addedClassesKey, addedClassesStoreName, mutateAddedClasses, readAddedClasses, publicAddedClasses } from '../netlify/functions/_lib/m1-added-classes.mjs';
import { handleM1AddedClasses, ADDED_CLASSES_PATH } from '../netlify/functions/m1-added-classes.mjs';

// Synthetic configuration and injected storage only: these tests make no network
// requests and never use, read or change a real gym's credentials or data.
const NOW = Date.parse('2026-09-08T16:00:00Z');
const REQUEST_TOKEN = 'synthetic-release-page-request-0123456789';
const ENV = {
  GIB_M1_ENVIRONMENT: 'production',
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_REV_PRODUCTION_CLASSES/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'synthetic-rev-production-webhook-0123456789',
  GIB_M1_ADMIN_ACTION_TOKEN: 'synthetic-rev-production-admin-action-0123456789',
  GIB_M1_ADMIN_PASSPHRASE: 'synthetic revolution forest lantern violet',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_PRODUCTION_CLASSES/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'synthetic-richmond-production-webhook-0123456789',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'synthetic-richmond-production-admin-action-0123456789',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'synthetic richmond mountain meadow copper',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'synthetic-richmond-production-device-0123456789',
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active',
  GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true',
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_REV_TEST_CLASSES/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-rev-test-webhook-0123456789',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-rev-test-admin-action-0123456789'
};
const PROFILES = {
  rev: { origin: 'https://gib-live.netlify.app', site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' } },
  richmond: { origin: 'https://gib-richmond-live.netlify.app', site: { name: 'gib-richmond-live', id: '9b7757a9-70f4-4977-9ca2-270b41e34007' } }
};
class Store {
  data = new Map(); calls = []; sequence = 0;
  async getWithMetadata(key, options) {
    assert.deepEqual(options, { type: 'json', consistency: 'strong' });
    this.calls.push(['read', key]);
    return this.data.has(key) ? structuredClone(this.data.get(key)) : null;
  }
  async set(key, value, options) {
    this.calls.push(['write', key]);
    const previous = this.data.get(key);
    if ((options.onlyIfNew && previous) || (options.onlyIfMatch && previous?.etag !== options.onlyIfMatch)) return { modified: false };
    this.data.set(key, { data: JSON.parse(value), etag: `synthetic-etag-${++this.sequence}` });
    return { modified: true };
  }
}
const series = { id: '', label: 'Synthetic release class', time: '09:15', days: ['Tuesday'], startDate: '2026-09-08', endDate: '2026-09-15', enabled: true };
const create = () => ({ action: 'create', requestId: 'synthetic-production-create', expectedVersion: 0, series });
function dependencies(gym, store, extra = {}) {
  return { installationId: gym, environment: gym === 'richmond' ? 'production' : undefined, activation: 'active', env: ENV, store, now: NOW,
    context: { site: PROFILES[gym].site, deploy: { context: 'production', published: true } }, ...extra };
}
function request(gym, body, { auth = true, origin = PROFILES[gym].origin, originHeader = origin, path = ADDED_CLASSES_PATH, pageToken = REQUEST_TOKEN, signingSecret } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: originHeader, 'Sec-Fetch-Site': 'same-origin' };
  if (body && auth) {
    const config = runtimeConfig(ENV, { admin: true, requestUrl: PROFILES[gym].origin + ADDED_CLASSES_PATH, installationId: gym, environment: gym === 'richmond' ? 'production' : undefined, activation: 'active' });
    assert.ok(config?.sessionSecret, `${gym} synthetic production fixture is valid`);
    headers.Cookie = `${ADMIN_COOKIE}=${createAdminSession('Stuart Turner', signingSecret || config.sessionSecret, NOW, REQUEST_TOKEN)}`;
    headers[ADMIN_REQUEST_HEADER] = pageToken;
  }
  return new Request(origin + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('each canonical published gym can save with its existing production Admin session and only its production key', async () => {
  for (const gym of Object.keys(PROFILES)) {
    const store = new Store();
    const response = await handleM1AddedClasses(request(gym, create()), dependencies(gym, store));
    assert.equal(response.status, 200);
    const doc = await response.json();
    assert.equal(doc.target, 'production'); assert.equal(doc.gymId, gym); assert.equal(doc.version, 1);
    assert.ok(store.calls.every(([, key]) => key === `production/${gym}/classes-v1`));
    const replay = await handleM1AddedClasses(request(gym, create()), dependencies(gym, store));
    assert.equal((await replay.json()).retry, true);
    assert.equal(store.calls.filter(([action]) => action === 'write').length, 1);
    const read = await handleM1AddedClasses(request(gym), dependencies(gym, store));
    assert.deepEqual((await read.json()).series, doc.series);
  }
});

test('production POST denies missing session, mismatched page token and foreign/test session before opening storage', async () => {
  const preview = runtimeConfig(ENV, { admin: true, requestUrl: 'https://deploy-preview-83--gib-live.netlify.app/api/m1-added-classes', installationId: 'rev' });
  for (const gym of Object.keys(PROFILES)) {
    for (const options of [{ auth: false }, { pageToken: 'wrong-page-token' }, { signingSecret: preview.sessionSecret },
      { signingSecret: gym === 'rev' ? ENV.GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE : ENV.GIB_M1_ADMIN_PASSPHRASE }]) {
      const store = new Store();
      const response = await handleM1AddedClasses(request(gym, create(), options), dependencies(gym, store));
      assert.ok([401, 403].includes(response.status)); assert.equal(store.calls.length, 0);
    }
  }
});

test('production storage requires the exact canonical host, site ID, published context and active Richmond gate', async () => {
  for (const gym of Object.keys(PROFILES)) {
    const bad = [
      { request: request(gym, null, { origin: `https://${'a'.repeat(24)}--${PROFILES[gym].site.name}.netlify.app` }) },
      { request: request(gym, null, { path: ADDED_CLASSES_PATH + '?target=production' }) },
      { request: request(gym, null, { originHeader: 'https://unrelated.example' }) },
      { context: { site: { ...PROFILES[gym].site, id: 'wrong-site-id' }, deploy: { context: 'production', published: true } } },
      ...[false, undefined].map(published => ({ context: { site: PROFILES[gym].site, deploy: { context: 'production', published } } })),
      { context: { site: PROFILES[gym].site, deploy: { context: 'deploy-preview', published: false } } }
    ];
    if (gym === 'richmond') bad.push({ activation: 'pending' });
    for (const extra of bad) {
      const store = new Store();
      assert.equal((await handleM1AddedClasses(extra.request || request(gym), dependencies(gym, store, extra))).status, 403);
      assert.equal(store.calls.length, 0);
    }
    for (const options of [{ originHeader: '' }, { originHeader: 'https://unrelated.example' }]) {
      const store = new Store();
      assert.equal((await handleM1AddedClasses(request(gym, create(), options), dependencies(gym, store))).status, 403);
      assert.equal(store.calls.length, 0);
    }
  }
  for (const flags of [
    { GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'false' },
    { GIB_RICHMOND_PRODUCTION_ACTIVATION: 'pending' }
  ]) {
    const store = new Store();
    assert.equal((await handleM1AddedClasses(request('richmond', create()), dependencies('richmond', store,
      { env: { ...ENV, ...flags } }))).status, 503);
    assert.equal(store.calls.length, 0);
  }
});

test('separate stores and target-bound documents prevent TEST migration or cross-gym reads', async () => {
  assert.notEqual(addedClassesStoreName('test'), addedClassesStoreName('production'));
  assert.throws(() => addedClassesStoreName('preview'));
  const store = new Store();
  for (const gym of Object.keys(PROFILES)) {
    await mutateAddedClasses(store, gym, create(), NOW, 'Stuart Turner', 'test');
    assert.equal((await readAddedClasses(store, gym, NOW, 'production')).value.version, 0);
    await mutateAddedClasses(store, gym, { ...create(), series: { ...series, label: `${gym} production example` } }, NOW, 'Stuart Turner', 'production');
    const doc = publicAddedClasses((await readAddedClasses(store, gym, NOW, 'production')).value, NOW);
    assert.equal(doc.target, 'production'); assert.equal(doc.series[0].label, `${gym} production example`);
    assert.equal((await readAddedClasses(store, gym, NOW, 'test')).value.series[0].label, series.label);
  }
  assert.equal(store.data.size, 4);
  store.data.set(addedClassesKey('rev', 'production'), structuredClone(store.data.get(addedClassesKey('rev', 'test'))));
  await assert.rejects(() => readAddedClasses(store, 'rev', NOW, 'production'), /validated/);
});
