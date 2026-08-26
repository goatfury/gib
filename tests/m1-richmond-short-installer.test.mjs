import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  RICHMOND_PRODUCTION_DEVICE_COOKIE
} from '../netlify/functions/_lib/m1-richmond-production-runtime.mjs';
import {
  SHORT_TABLET_INSTALL_PATH,
  config,
  handleShortTabletInstall
} from '../netlify/functions/m1-tablet-short-install.mjs';

const ORIGIN = 'https://gib-richmond-live.netlify.app';
const NOW_MS = Date.parse('2026-08-25T20:00:00Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const RUN_ID = 'richmond-short-install-20260825-a';
const INSTALL_SECRET = 'richmond-short-install-secret-0011223344556677';
const SOURCE = readFileSync(
  new URL('../netlify/functions/m1-tablet-short-install.mjs', import.meta.url),
  'utf8'
);

const ENV = Object.freeze({
  GIB_M1_INSTALLATION: 'richmond',
  GIB_M1_ENVIRONMENT: 'production',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_PRODUCTION_RECEIVER_123456/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'richmond-production-webhook-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'richmond-production-admin-action-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'cedar orbit copper meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'richmond-production-device-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_INSTALL_CAPABILITY_SECRET: INSTALL_SECRET,
  GIB_RICHMOND_PRODUCTION_INSTALL_RUN_ID: RUN_ID,
  GIB_RICHMOND_PRODUCTION_INSTALL_ISSUED_AT: String(NOW_SECONDS - 60),
  GIB_RICHMOND_PRODUCTION_INSTALL_EXPIRES_AT: String(NOW_SECONDS + 9 * 60 * 60),
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'pending',
  GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'false',
  GIB_RICHMOND_TEST_WEBHOOK_TOKEN: 'richmond-test-webhook-token-fedcba9876543210',
  GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN: 'richmond-test-admin-action-token-fedcba9876543210',
  GIB_TEST_WEBHOOK_TOKEN: 'rev-test-webhook-token-fedcba9876543210',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'rev-test-admin-action-token-fedcba9876543210',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'rev-production-webhook-token-fedcba9876543210',
  GIB_M1_ADMIN_ACTION_TOKEN: 'rev-production-admin-action-token-fedcba9876543210',
  GIB_M1_ADMIN_PASSPHRASE: 'violet harbor maple lantern',
  GIB_M1_PRODUCTION_DEVICE_TOKEN: 'rev-production-device-token-fedcba9876543210',
  GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: 'rev-production-install-secret-fedcba9876543210'
});

const DEPENDENCIES = Object.freeze({
  installationId: 'richmond',
  environment: 'production',
  activation: 'pending',
  env: ENV,
  now: NOW_MS,
  randomBytes: size => Buffer.alloc(size, 0x52)
});

function store() {
  const values = new Map();
  return {
    values,
    async set(key, value, options) {
      assert.deepEqual(options, { onlyIfNew: true });
      if (values.has(key)) return { modified: false };
      values.set(key, value);
      return { modified: true, etag: 'short-install-etag' };
    }
  };
}

function getRequest({
  url = `${ORIGIN}${SHORT_TABLET_INSTALL_PATH}`,
  host = 'gib-richmond-live.netlify.app',
  fetchSite,
  fetchMode,
  fetchDest,
  origin
} = {}) {
  const headers = { Host: host };
  if (fetchSite !== undefined) headers['Sec-Fetch-Site'] = fetchSite;
  if (fetchMode !== undefined) headers['Sec-Fetch-Mode'] = fetchMode;
  if (fetchDest !== undefined) headers['Sec-Fetch-Dest'] = fetchDest;
  if (origin !== undefined) headers.Origin = origin;
  return new Request(url, { method: 'GET', headers });
}

function postRequest({
  url = `${ORIGIN}${SHORT_TABLET_INSTALL_PATH}`,
  host = 'gib-richmond-live.netlify.app',
  origin = ORIGIN,
  fetchSite = 'same-origin',
  cookie = '',
  body = '{}',
  contentType = 'application/json'
} = {}) {
  const headers = {
    Host: host,
    Origin: origin,
    'Content-Type': contentType
  };
  if (fetchSite !== null) headers['Sec-Fetch-Site'] = fetchSite;
  if (cookie) headers.Cookie = cookie;
  return new Request(url, { method: 'POST', headers, body });
}

function firstCookie(response) {
  const header = response.headers.get('set-cookie') || '';
  return header.split(';', 1)[0];
}

async function freshChallenge(overrides = {}) {
  const response = await handleShortTabletInstall(getRequest(), {
    ...DEPENDENCIES,
    ...overrides
  });
  assert.equal(response.status, 200);
  const cookie = firstCookie(response);
  assert.match(cookie, /^__Host-gib_m1_richmond_short_install=/u);
  return { response, cookie };
}

function pageScript(html) {
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u);
  assert.ok(match, 'short installer script is present');
  return match[1];
}

test('short installer has a literal easy path and contains no raw capability or logging', () => {
  assert.equal(SHORT_TABLET_INSTALL_PATH, '/install');
  assert.equal(SHORT_TABLET_INSTALL_PATH.length, 8);
  assert.equal(config.path, '/install');
  assert.match(SOURCE, /path: '\/install'/u);
  assert.doesNotMatch(SOURCE, /createRichmondProductionInstallCapability/u);
  assert.doesNotMatch(SOURCE, /readRichmondProductionInstallCapability/u);
  assert.doesNotMatch(SOURCE, /console\.|\.log\(/u);
  assert.doesNotMatch(SOURCE, /m1-production-runtime\.mjs/u);
});

test('typed GET returns only a no-store bootstrap and does not consume the run', async () => {
  const replayStore = store();
  const response = await handleShortTabletInstall(getRequest({
    fetchSite: 'none',
    fetchMode: 'navigate',
    fetchDest: 'document'
  }), {
    ...DEPENDENCIES,
    store: replayStore
  });

  assert.equal(response.status, 200);
  assert.equal(replayStore.values.size, 0);
  assert.match(response.headers.get('content-type'), /^text\/html/u);
  assert.match(response.headers.get('cache-control'), /no-store/u);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/u);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('x-robots-tag'), /noindex/u);
  assert.match(firstCookie(response), /^__Host-gib_m1_richmond_short_install=/u);
  const html = await response.text();
  assert.match(html, /Authorizing Richmond tablet/u);
  assert.match(html, /Auto-sync/u);
  assert.equal(html.includes(RUN_ID), false);
  assert.equal(html.includes(INSTALL_SECRET), false);
});

test('typed GET works when old Silk omits Fetch Metadata headers', async () => {
  const response = await handleShortTabletInstall(getRequest(), DEPENDENCIES);
  assert.equal(response.status, 200);
});

test('bootstrap uses old-Silk-safe XHR and changes only the Richmond auto-sync key', async () => {
  const { response } = await freshChallenge();
  const script = pageScript(await response.text());
  assert.doesNotMatch(script, /=>|\basync\b|\bawait\b|\bfetch\s*\(|\bMap\b|\.\.\./u);
  assert.match(script, /new XMLHttpRequest\(\)/u);

  const initial = {
    gib_m1_local_state_v2: '{"rev":"local"}',
    gib_m1_sync_queue_v1: '["rev-queue"]',
    gib_m1_signins_v1: '["rev-signin"]',
    gib_m1_sync_auto_v1: 'true',
    gib_m1_richmond_production_local_state_v2: '{"richmond":"local"}',
    gib_m1_richmond_production_sync_queue_v1: '["richmond-queue"]',
    gib_m1_richmond_production_signins_v1: '["richmond-signin"]',
    gib_m1_richmond_production_sync_auto_v1: 'true'
  };
  const storage = new Map(Object.entries(initial));
  const elements = {
    heading: { textContent: '' },
    message: { textContent: '' },
    detail: { textContent: '' },
    card: { className: '' },
    icon: { textContent: '' }
  };
  let xhr;
  function XMLHttpRequest() {
    xhr = this;
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.open = (method, url, async) => { this.opened = { method, url, async }; };
    this.setRequestHeader = (name, value) => { this.requestHeader = { name, value }; };
    this.send = body => { this.sentBody = body; };
  }
  const context = {
    window: {
      location: {
        protocol: 'https:',
        host: 'gib-richmond-live.netlify.app',
        origin: ORIGIN,
        pathname: '/install',
        search: '',
        hash: ''
      },
      localStorage: {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); }
      }
    },
    document: {
      readyState: 'complete',
      getElementById(id) { return elements[id]; },
      addEventListener() { throw new Error('not expected'); }
    },
    XMLHttpRequest,
    JSON
  };
  vm.runInNewContext(script, context, { filename: '/install' });

  assert.deepEqual(xhr.opened, { method: 'POST', url: '/install', async: true });
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.sentBody, '{}');
  assert.deepEqual(xhr.requestHeader, { name: 'Content-Type', value: 'application/json' });
  assert.equal(storage.get('gib_m1_richmond_production_sync_auto_v1'), 'false');
  for (const [key, value] of Object.entries(initial)) {
    if (key !== 'gib_m1_richmond_production_sync_auto_v1') assert.equal(storage.get(key), value, key);
  }

  xhr.status = 200;
  xhr.responseText = JSON.stringify({ ok: true, installed: true });
  xhr.readyState = 4;
  xhr.onreadystatechange();
  assert.equal(elements.heading.textContent, 'Richmond tablet authorized');
  assert.equal(elements.message.textContent, 'Setup complete. Auto-sync is OFF.');
});

test('storage failure prevents the authorization POST', async () => {
  const { response } = await freshChallenge();
  const script = pageScript(await response.text());
  let xhrCreated = false;
  const elements = Object.fromEntries(
    ['heading', 'message', 'detail', 'card', 'icon'].map(key => [key, { textContent: '', className: '' }])
  );
  const context = {
    window: {
      location: {
        protocol: 'https:', host: 'gib-richmond-live.netlify.app', origin: ORIGIN,
        pathname: '/install', search: '', hash: ''
      },
      localStorage: {
        getItem() { return null; },
        setItem() { throw new Error('denied'); }
      }
    },
    document: {
      readyState: 'complete',
      getElementById(id) { return elements[id]; },
      addEventListener() {}
    },
    XMLHttpRequest() { xhrCreated = true; },
    JSON
  };
  vm.runInNewContext(script, context, { filename: '/install' });
  assert.equal(xhrCreated, false);
  assert.match(elements.message.textContent, /not attempted/u);
});

test('one valid POST installs only the Richmond device cookie and replay is rejected', async () => {
  const replayStore = store();
  const { cookie } = await freshChallenge({ store: replayStore });
  const dependencies = { ...DEPENDENCIES, store: replayStore };
  const first = await handleShortTabletInstall(postRequest({ cookie }), dependencies);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, installed: true });
  const deviceCookie = first.headers.get('set-cookie') || '';
  assert.match(deviceCookie, new RegExp(`^${RICHMOND_PRODUCTION_DEVICE_COOKIE}=`));
  assert.match(deviceCookie, /; Secure/u);
  assert.match(deviceCookie, /; HttpOnly/u);
  assert.match(deviceCookie, /; SameSite=Strict/u);
  assert.equal(deviceCookie.includes(RUN_ID), false);
  assert.equal(deviceCookie.includes(INSTALL_SECRET), false);
  assert.equal(replayStore.values.size, 1);

  const replay = await handleShortTabletInstall(postRequest({ cookie }), dependencies);
  assert.equal(replay.status, 410);
  assert.equal(replay.headers.has('set-cookie'), false);
  assert.equal(replayStore.values.size, 1);
});

test('old-Silk POST without Sec-Fetch-Site is accepted', async () => {
  const replayStore = store();
  const { cookie } = await freshChallenge({ store: replayStore });
  const response = await handleShortTabletInstall(postRequest({
    cookie,
    fetchSite: null
  }), {
    ...DEPENDENCIES,
    store: replayStore
  });
  assert.equal(response.status, 200);
});

test('rotating the run ID invalidates an already issued short challenge', async () => {
  const replayStore = store();
  const { cookie } = await freshChallenge({ store: replayStore });
  const response = await handleShortTabletInstall(postRequest({ cookie }), {
    ...DEPENDENCIES,
    env: {
      ...ENV,
      GIB_RICHMOND_PRODUCTION_INSTALL_RUN_ID: 'richmond-short-install-20260825-b'
    },
    store: replayStore
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(replayStore.values.size, 0);
});

test('wrong origin, path, query, body, and content type fail before Blob consumption', async () => {
  const replayStore = store();
  const { cookie } = await freshChallenge({ store: replayStore });
  const requests = [
    postRequest({ cookie, origin: 'https://evil.example' }),
    postRequest({ cookie, url: `${ORIGIN}/install/` }),
    postRequest({ cookie, url: `${ORIGIN}/install?again=1` }),
    postRequest({ cookie, body: '{"again":true}' }),
    postRequest({ cookie, contentType: 'text/plain' })
  ];
  for (const request of requests) {
    const response = await handleShortTabletInstall(request, {
      ...DEPENDENCIES,
      store: replayStore
    });
    assert.equal(response.status, 403);
  }
  assert.equal(replayStore.values.size, 0);
});

test('expiry, excessive lifetime, gate mismatch, and Revolution profile fail closed', async () => {
  const variants = [
    {
      env: { ...ENV, GIB_RICHMOND_PRODUCTION_INSTALL_EXPIRES_AT: String(NOW_SECONDS) },
      installationId: 'richmond'
    },
    {
      env: {
        ...ENV,
        GIB_RICHMOND_PRODUCTION_INSTALL_ISSUED_AT: String(NOW_SECONDS - 1),
        GIB_RICHMOND_PRODUCTION_INSTALL_EXPIRES_AT: String(NOW_SECONDS + 36_000)
      },
      installationId: 'richmond'
    },
    {
      env: { ...ENV, GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true' },
      installationId: 'richmond'
    },
    { env: ENV, installationId: 'rev', environment: '', activation: '' }
  ];
  for (const variant of variants) {
    const replayStore = store();
    const response = await handleShortTabletInstall(getRequest(), {
      ...DEPENDENCIES,
      ...variant,
      store: replayStore
    });
    assert.equal(response.status, 410);
    assert.equal(replayStore.values.size, 0);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('Blob failure sets no device cookie and the response contains no secrets', async () => {
  const { cookie } = await freshChallenge();
  const response = await handleShortTabletInstall(postRequest({ cookie }), {
    ...DEPENDENCIES,
    store: { async set() { throw new Error('unavailable'); } }
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.has('set-cookie'), false);
  const body = await response.text();
  assert.equal(body.includes(RUN_ID), false);
  assert.equal(body.includes(INSTALL_SECRET), false);
});
