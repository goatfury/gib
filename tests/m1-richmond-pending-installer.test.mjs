import assert from 'node:assert/strict';
import test from 'node:test';

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
const NOW_MS = Date.parse('2026-08-25T16:00:00Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const RUN_ID = 'richmond-fire-install-20260825';
const INSTALL_SECRET = 'richmond-pending-install-secret-0011223344556677';

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

const PENDING_DEPENDENCIES = Object.freeze({
  installationId: 'richmond',
  environment: 'production',
  activation: 'pending'
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
