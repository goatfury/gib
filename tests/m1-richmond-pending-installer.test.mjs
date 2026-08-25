import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  RICHMOND_PRODUCTION_DEVICE_COOKIE,
  RICHMOND_PRODUCTION_INSTALL_MAX_SECONDS,
  createRichmondProductionInstallCapability
} from '../netlify/functions/_lib/m1-richmond-production-runtime.mjs';
import {
  TABLET_INSTALL_PATH,
  handleTabletInstall
} from '../netlify/functions/m1-tablet-install.mjs';
import {
  TABLET_STATUS_PATH,
  handleTabletStatus
} from '../netlify/functions/m1-tablet-status.mjs';

const ORIGIN = 'https://gib-richmond-live.netlify.app';
const REV_ORIGIN = 'https://gib-live.netlify.app';
const NOW_MS = Date.parse('2026-08-25T16:00:00Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const RUN_ID = 'richmond-fire-install-20260825';
const INSTALL_SECRET = 'richmond-pending-install-secret-0011223344556677';
const INSTALL_PAGE_PATH = '/m1/tablet-install.html';
const INSTALL_PAGE_HTML = readFileSync(
  new URL('../m1/tablet-install.html', import.meta.url),
  'utf8'
);
const INSTALL_PAGE_SCRIPT_MATCH = INSTALL_PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/u);
assert.ok(INSTALL_PAGE_SCRIPT_MATCH, 'The shipped tablet installer script must exist.');
const INSTALL_PAGE_SCRIPT = INSTALL_PAGE_SCRIPT_MATCH[1];
assert.doesNotMatch(INSTALL_PAGE_SCRIPT, /\bObject\.hasOwn\(/u);

const REV_PRESERVED_STATE = Object.freeze({
  gib_m1_local_state_v2: '{"rev":"local"}',
  gib_m1_sync_queue_v1: '["rev-queue"]',
  gib_m1_signins_v1: '["rev-signin"]'
});
const RICHMOND_PRESERVED_STATE = Object.freeze({
  gib_m1_richmond_production_local_state_v2: '{"richmond":"local"}',
  gib_m1_richmond_production_sync_queue_v1: '["richmond-queue"]',
  gib_m1_richmond_production_signins_v1: '["richmond-signin"]'
});

const PENDING_ENV = Object.freeze({
  GIB_M1_INSTALLATION: 'richmond',
  GIB_M1_ENVIRONMENT: 'production',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_PRODUCTION_RECEIVER_123456/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'richmond-production-webhook-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'richmond-production-admin-action-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'cedar orbit copper meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'richmond-production-device-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_INSTALL_CAPABILITY_SECRET: INSTALL_SECRET,
  GIB_RICHMOND_PRODUCTION_INSTALL_RUN_ID: RUN_ID,
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

function capability() {
  return createRichmondProductionInstallCapability({
    secret: INSTALL_SECRET,
    runId: RUN_ID,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + RICHMOND_PRODUCTION_INSTALL_MAX_SECONDS,
    nonce: Buffer.alloc(32, 0x31).toString('base64url')
  });
}

function request(path, { body = {}, cookie = '' } = {}) {
  const headers = {
    Host: 'gib-richmond-live.netlify.app',
    Origin: ORIGIN,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json'
  };
  if (cookie) headers.Cookie = cookie;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

function oneTimeStore() {
  const values = new Map();
  return {
    values,
    async set(key, value, options) {
      assert.deepEqual(options, { onlyIfNew: true });
      if (values.has(key)) return { modified: false };
      values.set(key, value);
      return { modified: true, etag: 'pending-install-etag' };
    }
  };
}

async function runShippedInstallPage({
  origin,
  token,
  initialStorage = {},
  pathname = INSTALL_PAGE_PATH,
  search = '',
  responseBody = { ok: true, installed: true },
  responseStatus = 200,
  disableObjectHasOwn = false
}) {
  const storage = new Map(Object.entries(initialStorage));
  const fetchCalls = [];
  const statusElement = { textContent: 'Checking the one-time setup link...' };
  const location = {
    origin,
    pathname,
    search,
    hash: `#${token}`
  };
  const history = {
    replaceState(_state, _title, path) {
      assert.equal(path, INSTALL_PAGE_PATH);
      location.pathname = path;
      location.search = '';
      location.hash = '';
    }
  };
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  const context = {
    window: { location, history },
    document: {
      getElementById(id) {
        assert.equal(id, 'statusMessage');
        return statusElement;
      }
    },
    localStorage,
    fetch: async (endpoint, options) => {
      fetchCalls.push({ endpoint, options });
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    Response
  };

  if (disableObjectHasOwn) {
    vm.runInNewContext('Object.hasOwn = undefined;', context);
  }
  vm.runInNewContext(INSTALL_PAGE_SCRIPT, context, {
    filename: 'm1/tablet-install.html'
  });
  for (let pass = 0; pass < 12; pass += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  return {
    fetchCalls,
    storage,
    status: statusElement.textContent,
    location
  };
}

const PENDING_DEPENDENCIES = Object.freeze({
  installationId: 'richmond',
  environment: 'production',
  activation: 'pending'
});

test('the shipped browser page posts the Richmond capability and touches only Richmond storage', async () => {
  const token = capability();
  const initialStorage = {
    ...REV_PRESERVED_STATE,
    ...RICHMOND_PRESERVED_STATE,
    gib_m1_sync_auto_v1: 'true',
    gib_m1_richmond_production_sync_auto_v1: 'true'
  };
  const result = await runShippedInstallPage({
    origin: ORIGIN,
    token,
    initialStorage
  });

  assert.equal(result.fetchCalls.length, 1);
  const [{ endpoint, options }] = result.fetchCalls;
  assert.equal(endpoint, TABLET_INSTALL_PATH);
  assert.equal(options.method, 'POST');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(options.body), { capability: token });
  assert.equal(result.location.hash, '');
  assert.equal(result.status, 'Tablet authorization installed. Auto-sync is OFF.');
  assert.equal(
    result.storage.get('gib_m1_richmond_production_sync_auto_v1'),
    'false'
  );
  assert.equal(result.storage.get('gib_m1_sync_auto_v1'), 'true');
  for (const [key, value] of Object.entries(REV_PRESERVED_STATE)) {
    assert.equal(result.storage.get(key), value, key);
  }
  for (const [key, value] of Object.entries(RICHMOND_PRESERVED_STATE)) {
    assert.equal(result.storage.get(key), value, key);
  }
});

test('the shipped browser page scrubs and posts without Object.hasOwn support', async () => {
  const token = capability();
  const result = await runShippedInstallPage({
    origin: ORIGIN,
    token,
    disableObjectHasOwn: true,
    initialStorage: {
      ...RICHMOND_PRESERVED_STATE,
      gib_m1_richmond_production_sync_auto_v1: 'true'
    }
  });

  assert.equal(result.location.hash, '');
  assert.equal(result.fetchCalls.length, 1);
  assert.deepEqual(JSON.parse(result.fetchCalls[0].options.body), { capability: token });
  assert.equal(result.status, 'Tablet authorization installed. Auto-sync is OFF.');
});

test('the shared browser page still scopes the Revolution production install to Revolution storage', async () => {
  const token = capability();
  const result = await runShippedInstallPage({
    origin: REV_ORIGIN,
    token,
    initialStorage: {
      ...REV_PRESERVED_STATE,
      ...RICHMOND_PRESERVED_STATE,
      gib_m1_sync_auto_v1: 'true',
      gib_m1_richmond_production_sync_auto_v1: 'true'
    }
  });

  assert.equal(result.fetchCalls.length, 1);
  assert.equal(result.storage.get('gib_m1_sync_auto_v1'), 'false');
  assert.equal(
    result.storage.get('gib_m1_richmond_production_sync_auto_v1'),
    'true'
  );
  for (const [key, value] of Object.entries(REV_PRESERVED_STATE)) {
    assert.equal(result.storage.get(key), value, key);
  }
  for (const [key, value] of Object.entries(RICHMOND_PRESERVED_STATE)) {
    assert.equal(result.storage.get(key), value, key);
  }
});

test('the shipped browser page rejects lookalike Richmond origins after scrubbing the capability', async () => {
  const initialStorage = {
    ...REV_PRESERVED_STATE,
    ...RICHMOND_PRESERVED_STATE,
    gib_m1_sync_auto_v1: 'true',
    gib_m1_richmond_production_sync_auto_v1: 'true'
  };
  const result = await runShippedInstallPage({
    origin: 'https://gib-richmond-live.netlify.app.evil.example',
    token: capability(),
    initialStorage
  });

  assert.equal(result.location.hash, '');
  assert.equal(result.fetchCalls.length, 0);
  assert.equal(result.status, 'Installation is unavailable at this location.');
  assert.deepEqual(Object.fromEntries(result.storage), initialStorage);
});

test('Richmond tablet can be authorized while both production write gates remain off', async () => {
  const store = oneTimeStore();
  const token = capability();
  const install = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    body: { capability: token }
  }), {
    ...PENDING_DEPENDENCIES,
    env: PENDING_ENV,
    now: NOW_MS,
    store,
    randomBytes: size => Buffer.alloc(size, 0x42)
  });

  assert.equal(install.status, 200);
  assert.deepEqual(await install.json(), { ok: true, installed: true });
  assert.equal(store.values.size, 1);

  const setCookie = install.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`^${RICHMOND_PRODUCTION_DEVICE_COOKIE}=`));
  assert.match(setCookie, /; Path=\//u);
  assert.match(setCookie, /; Secure/u);
  assert.match(setCookie, /; HttpOnly/u);
  assert.match(setCookie, /; SameSite=Strict/u);
  assert.equal(setCookie.includes(token), false);
  assert.equal(setCookie.includes(INSTALL_SECRET), false);

  const cookie = setCookie.split(';', 1)[0];
  const status = await handleTabletStatus(request(TABLET_STATUS_PATH, {
    body: {},
    cookie
  }), {
    ...PENDING_DEPENDENCIES,
    env: PENDING_ENV,
    now: NOW_MS
  });

  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    authorized: true,
    writesEnabled: false,
    activation: 'pending'
  });
});

test('Richmond installer fails closed unless the profile and both gates are exactly pending and off', async () => {
  const variants = [
    {
      dependencies: { ...PENDING_DEPENDENCIES, activation: 'active' },
      env: {
        ...PENDING_ENV,
        GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active',
        GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true'
      }
    },
    {
      dependencies: PENDING_DEPENDENCIES,
      env: {
        ...PENDING_ENV,
        GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true'
      }
    },
    {
      dependencies: PENDING_DEPENDENCIES,
      env: {
        ...PENDING_ENV,
        GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active'
      }
    }
  ];

  for (const variant of variants) {
    const store = oneTimeStore();
    const response = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
      body: { capability: capability() }
    }), {
      ...variant.dependencies,
      env: variant.env,
      now: NOW_MS,
      store,
      randomBytes: size => Buffer.alloc(size, 0x43)
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(store.values.size, 0);
  }
});
