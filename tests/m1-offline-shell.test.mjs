import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const kioskHtml = readFileSync(new URL('m1/index.html', ROOT), 'utf8');
const staffClockClientSource = readFileSync(new URL('m1/staff-clock-client.mjs', ROOT), 'utf8');
const workerSource = readFileSync(new URL('m1/service-worker.js', ROOT), 'utf8');
const headersSource = readFileSync(new URL('_headers', ROOT), 'utf8').replaceAll('\r\n', '\n');
const ORIGIN = 'https://deploy-preview-99--gib-live.netlify.app';

function declaredRevision() {
  const match = kioskHtml.match(/const OFFLINE_SHELL_REVISION = '([a-z0-9._-]{1,64})';/iu);
  assert.ok(match, 'The kiosk must declare one safe offline-shell revision.');
  return match[1];
}

function headerSection(pathname) {
  const start = headersSource.indexOf(`${pathname}\n`);
  if (start < 0) return '';
  const next = headersSource.indexOf('\n/', start + pathname.length + 1);
  return headersSource.slice(start, next < 0 ? undefined : next);
}

function createWorkerHarness(options = {}) {
  const revision = options.revision || declaredRevision();
  const listeners = new Map();
  const deleted = [];
  const cacheRecords = new Map();
  const addAllCalls = [];
  const matchCalls = [];
  const fetchCalls = [];
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  let fetchImpl = async request => ({
    kind: 'network',
    ok: true,
    status: 200,
    url: request.url
  });

  function cacheRecord(name) {
    if (!cacheRecords.has(name)) {
      cacheRecords.set(name, {
        entries: new Map(),
        async addAll(requests) {
          const values = [...requests];
          addAllCalls.push({ name, requests: values });
          if (options.addAllError) throw options.addAllError;
          for (const request of values) {
            this.entries.set(request.url, {
              kind: 'cached',
              cacheName: name,
              url: request.url
            });
          }
        },
        async match(key) {
          const url = typeof key === 'string' ? key : key.url;
          matchCalls.push({ name, url });
          return this.entries.get(url);
        }
      });
    }
    return cacheRecords.get(name);
  }

  for (const name of options.initialCaches || []) cacheRecord(name);

  const caches = {
    async open(name) {
      return cacheRecord(name);
    },
    async keys() {
      return [...cacheRecords.keys()];
    },
    async delete(name) {
      deleted.push(name);
      return cacheRecords.delete(name);
    }
  };

  const self = {
    location: {
      href: `${ORIGIN}/m1/service-worker.js?v=${encodeURIComponent(revision)}`,
      origin: ORIGIN
    },
    registration: { scope: `${ORIGIN}/m1/` },
    clients: {
      async claim() {
        claimCalls += 1;
      }
    },
    async skipWaiting() {
      skipWaitingCalls += 1;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };

  vm.runInNewContext(workerSource, {
    URL,
    Request,
    Promise,
    Object,
    Error,
    encodeURIComponent,
    self,
    caches,
    fetch(request) {
      fetchCalls.push(request);
      return fetchImpl(request);
    }
  }, { filename: 'm1/service-worker.js' });

  return {
    revision,
    addAllCalls,
    cacheRecords,
    deleted,
    fetchCalls,
    matchCalls,
    get claimCalls() { return claimCalls; },
    get skipWaitingCalls() { return skipWaitingCalls; },
    setFetch(value) { fetchImpl = value; },
    async dispatchLifecycle(type) {
      let lifetime;
      listeners.get(type)({
        waitUntil(value) {
          assert.equal(lifetime, undefined, `${type} must register one lifetime promise.`);
          lifetime = Promise.resolve(value);
        }
      });
      assert.ok(lifetime, `${type} must use waitUntil.`);
      return lifetime;
    },
    async dispatchFetch(request) {
      let response;
      listeners.get('fetch')({
        request,
        respondWith(value) {
          assert.equal(response, undefined, 'fetch must call respondWith at most once.');
          response = Promise.resolve(value);
        }
      });
      return response;
    }
  };
}

function request(url, options = {}) {
  return {
    url,
    method: options.method || 'GET',
    mode: options.mode || 'cors'
  };
}

test('kiosk import, worker registration, scope, and no-store header share one revision contract', () => {
  const revision = declaredRevision();
  assert.match(
    kioskHtml,
    new RegExp(`from './sync-core\\.mjs\\?v=${revision}';`, 'u')
  );
  assert.match(
    kioskHtml,
    new RegExp(`<script src="\\./installation-profile\\.generated\\.js\\?v=${revision}"></script>`, 'u')
  );
  assert.match(
    kioskHtml,
    new RegExp(`<script type="module" src="\\./staff-clock-client\\.mjs\\?v=${revision}"></script>`, 'u')
  );
  assert.match(
    staffClockClientSource,
    new RegExp(`from './staff-clock-core\\.mjs\\?v=${revision}';`, 'u')
  );
  assert.match(
    kioskHtml,
    /navigator\.serviceWorker\.register\(\s*`\/m1\/service-worker\.js\?v=\$\{encodeURIComponent\(OFFLINE_SHELL_REVISION\)\}`,[\s\S]*?scope: '\/m1\/'[\s\S]*?updateViaCache: 'none'/u
  );

  const section = headerSection('/m1/service-worker.js');
  assert.ok(section, 'The service worker needs an exact Netlify header rule.');
  assert.match(section, /Cache-Control: no-store, max-age=0/u);
  assert.match(section, /Service-Worker-Allowed: \/m1\//u);
  assert.match(section, /X-Content-Type-Options: nosniff/u);
  assert.match(section, /Referrer-Policy: no-referrer/u);
});

test('install atomically precaches only the revision-matched shell and activation preserves unrelated caches', async () => {
  const harness = createWorkerHarness({
    initialCaches: ['gib-m1-shell-older', 'unrelated-application-cache']
  });
  await harness.dispatchLifecycle('install');

  assert.equal(harness.addAllCalls.length, 1);
  assert.equal(harness.addAllCalls[0].name, `gib-m1-shell-${harness.revision}`);
  assert.deepEqual(
    harness.addAllCalls[0].requests.map(value => value.url),
    [
      `${ORIGIN}/m1/index.html`,
      `${ORIGIN}/m1/installation-profile.generated.js?v=${harness.revision}`,
      `${ORIGIN}/m1/sync-core.mjs?v=${harness.revision}`,
      `${ORIGIN}/m1/staff-clock-core.mjs?v=${harness.revision}`,
      `${ORIGIN}/m1/staff-clock-client.mjs?v=${harness.revision}`,
      `${ORIGIN}/m1/kiosk-enhancements.css?v=${harness.revision}`,
      `${ORIGIN}/m1/kiosk-enhancements.mjs?v=${harness.revision}`,
      `${ORIGIN}/m1/kiosk-enhancements-core.mjs`,
      `${ORIGIN}/m1/assets/revolution-bjj-logo.webp`,
      `${ORIGIN}/m1/assets/richmond-bjj-logo.webp`
    ]
  );
  for (const value of harness.addAllCalls[0].requests) {
    assert.equal(value.cache, 'reload');
    assert.equal(value.credentials, 'same-origin');
  }
  assert.equal(harness.skipWaitingCalls, 1);

  await harness.dispatchLifecycle('activate');
  assert.deepEqual(harness.deleted, ['gib-m1-shell-older']);
  assert.equal(harness.cacheRecords.has('unrelated-application-cache'), true);
  assert.equal(harness.cacheRecords.has(`gib-m1-shell-${harness.revision}`), true);
  assert.equal(harness.claimCalls, 1);
});

test('failed atomic precache does not advance the worker to skipWaiting', async () => {
  const expected = new Error('precache failed');
  const harness = createWorkerHarness({ addAllError: expected });
  await assert.rejects(harness.dispatchLifecycle('install'), expected);
  assert.equal(harness.skipWaitingCalls, 0);
});

test('network wins online while current-revision navigation and module reload from cache offline', async () => {
  const harness = createWorkerHarness();
  await harness.dispatchLifecycle('install');

  const onlineResponse = { kind: 'network', ok: true, status: 200 };
  harness.setFetch(async () => onlineResponse);
  assert.equal(
    await harness.dispatchFetch(request(`${ORIGIN}/m1/?view=admin`, { mode: 'navigate' })),
    onlineResponse
  );
  assert.equal(harness.matchCalls.length, 0, 'Online responses must not be replaced or runtime-cached.');

  harness.setFetch(async () => { throw new TypeError('offline'); });
  const offlineRoot = await harness.dispatchFetch(request(`${ORIGIN}/m1/`, { mode: 'navigate' }));
  const offlineIndex = await harness.dispatchFetch(request(`${ORIGIN}/m1/index.html?view=kiosk`, {
    mode: 'navigate'
  }));
  const offlineCore = await harness.dispatchFetch(request(
    `${ORIGIN}/m1/sync-core.mjs?v=${harness.revision}`
  ));
  const offlineProfile = await harness.dispatchFetch(request(
    `${ORIGIN}/m1/installation-profile.generated.js?v=${harness.revision}`
  ));
  const offlineStaffCore = await harness.dispatchFetch(request(
    `${ORIGIN}/m1/staff-clock-core.mjs?v=${harness.revision}`
  ));
  const offlineStaffClient = await harness.dispatchFetch(request(
    `${ORIGIN}/m1/staff-clock-client.mjs?v=${harness.revision}`
  ));
  assert.equal(offlineRoot.url, `${ORIGIN}/m1/index.html`);
  assert.equal(offlineIndex.url, `${ORIGIN}/m1/index.html`);
  assert.equal(offlineCore.url, `${ORIGIN}/m1/sync-core.mjs?v=${harness.revision}`);
  assert.equal(offlineProfile.url, `${ORIGIN}/m1/installation-profile.generated.js?v=${harness.revision}`);
  assert.equal(offlineStaffCore.url, `${ORIGIN}/m1/staff-clock-core.mjs?v=${harness.revision}`);
  assert.equal(offlineStaffClient.url, `${ORIGIN}/m1/staff-clock-client.mjs?v=${harness.revision}`);

  const serverFailure = { kind: 'network', ok: false, status: 503 };
  harness.setFetch(async () => serverFailure);
  assert.equal(
    await harness.dispatchFetch(request(`${ORIGIN}/m1/`, { mode: 'navigate' })),
    serverFailure,
    'An HTTP failure must stay visible instead of being masked by stale content.'
  );
});

test('API, Admin, auxiliary, stale-version, cross-origin, and non-GET traffic bypasses the cache', async () => {
  const harness = createWorkerHarness();
  const excluded = [
    request(`${ORIGIN}/.netlify/functions/m1-kiosk-sync`, { method: 'POST' }),
    request(`${ORIGIN}/.netlify/functions/m1-schedule`),
    request(`${ORIGIN}/.netlify/functions/m1-admin-review`, { method: 'POST' }),
    request(`${ORIGIN}/m1/admin/`, { mode: 'navigate' }),
    request(`${ORIGIN}/m1/tablet-install.html`, { mode: 'navigate' }),
    request(`${ORIGIN}/m1/production-diagnostic.html`, { mode: 'navigate' }),
    request(`${ORIGIN}/m1/shared-schedule.json`),
    request(`${ORIGIN}/m1/installation-profile.generated.js?v=older-revision`),
    request(`${ORIGIN}/m1/sync-core.mjs?v=older-revision`),
    request(`${ORIGIN}/m1/staff-clock-core.mjs?v=older-revision`),
    request(`${ORIGIN}/m1/staff-clock-client.mjs?v=older-revision`),
    request(`${ORIGIN}/m1/sync-core.mjs?v=${harness.revision}`, { method: 'POST' }),
    request(`https://revolutionbjj.com/m1/sync-core.mjs?v=${harness.revision}`)
  ];

  for (const value of excluded) {
    assert.equal(await harness.dispatchFetch(value), undefined, `Unexpected interception: ${value.url}`);
  }
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.matchCalls.length, 0);
  assert.equal(harness.addAllCalls.length, 0);
});
