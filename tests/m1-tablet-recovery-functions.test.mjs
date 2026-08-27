import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  createAdminSession,
  runtimeConfig
} from '../netlify/functions/_lib/m1-common.mjs';
import {
  PRODUCTION_ADMIN_INSTALL_GRANT_COOKIE,
  PRODUCTION_ADMIN_INSTALL_GRANT_MAX_SECONDS,
  PRODUCTION_ADMIN_INSTALL_GRANT_SIGNATURE_DOMAIN,
  PRODUCTION_DEVICE_COOKIE,
  PRODUCTION_ORIGIN,
  productionAdminInstallGrantConsumptionKey
} from '../netlify/functions/_lib/m1-production-runtime.mjs';
import {
  ADMIN_TABLET_AUTHORIZE_PATH,
  config as authorizeConfig,
  handleAdminTabletAuthorize
} from '../netlify/functions/m1-admin-tablet-authorize.mjs';
import {
  TABLET_INSTALL_PATH,
  handleTabletInstall
} from '../netlify/functions/m1-tablet-install.mjs';
import {
  TABLET_STATUS_PATH,
  handleTabletStatus
} from '../netlify/functions/m1-tablet-status.mjs';

const NOW_MS = Date.parse('2026-08-27T14:00:00Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const ADMIN_REQUEST_TOKEN = 'admin_request_token_0123456789abcdefghij';
const INSTALL_SECRET = 'production-install-secret-0011223344556677';
const DEVICE_TOKEN = 'production-device-token-abcdef0123456789';
const WEBHOOK_TOKEN = 'production-webhook-token-0123456789abcdef';
const ADMIN_ACTION_TOKEN = 'production-admin-action-token-0123456789';
const ADMIN_PASSPHRASE = 'violet harbor maple lantern';
const ROOT = new URL('../', import.meta.url);
const authorizeSource = readFileSync(
  new URL('netlify/functions/m1-admin-tablet-authorize.mjs', ROOT),
  'utf8'
);

// Deliberately no GIB_M1_PRODUCTION_INSTALL_RUN_ID: reusable Admin recovery
// must work for future devices without changing deployment configuration.
const ENV = Object.freeze({
  GIB_M1_PRODUCTION_SYNC_ENABLED: 'true',
  GIB_M1_PRODUCTION_ORIGIN: PRODUCTION_ORIGIN,
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION_RECEIVER_123/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  GIB_M1_PRODUCTION_DEVICE_TOKEN: DEVICE_TOKEN,
  GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: INSTALL_SECRET,
  GIB_M1_ADMIN_ACTION_TOKEN: ADMIN_ACTION_TOKEN,
  GIB_M1_ADMIN_PASSPHRASE: ADMIN_PASSPHRASE,
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER_456/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'test-webhook-token-fedcba9876543210',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'test-admin-action-token-fedcba9876543210'
});

function adminRuntime(env = ENV) {
  const runtime = runtimeConfig(env, {
    admin: true,
    requestUrl: `${PRODUCTION_ORIGIN}${ADMIN_TABLET_AUTHORIZE_PATH}`
  });
  assert.ok(runtime);
  return runtime;
}

function adminCookie({
  adminName = 'Andrew Smith',
  requestToken = ADMIN_REQUEST_TOKEN,
  now = NOW_MS,
  env = ENV
} = {}) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(createAdminSession(
    adminName,
    adminRuntime(env).sessionSecret,
    now,
    requestToken
  ))}`;
}

function request(path, {
  origin = PRODUCTION_ORIGIN,
  requestOrigin = origin,
  host = new URL(origin).host,
  fetchSite = 'same-origin',
  method = 'POST',
  body,
  cookie = '',
  requestToken,
  includeHost = true,
  includeOrigin = true,
  includeFetchSite = true
} = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (includeHost) headers.Host = host;
  if (includeOrigin) headers.Origin = requestOrigin;
  if (includeFetchSite) headers['Sec-Fetch-Site'] = fetchSite;
  if (cookie) headers.Cookie = cookie;
  if (requestToken !== undefined) headers[ADMIN_REQUEST_HEADER] = requestToken;
  return new Request(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

function setCookies(response) {
  return response.headers.getSetCookie();
}

function responseCookiePair(response, name) {
  const line = setCookies(response).find(value => value.startsWith(`${name}=`));
  assert.ok(line, `Expected ${name} response cookie.`);
  return line.split(';', 1)[0];
}

function cookieValue(cookiePair) {
  return decodeURIComponent(cookiePair.slice(cookiePair.indexOf('=') + 1));
}

function grantWasCleared(response) {
  return setCookies(response).some(value => (
    value.startsWith(`${PRODUCTION_ADMIN_INSTALL_GRANT_COOKIE}=`)
    && value.includes('Max-Age=0')
  ));
}

function oneTimeStore() {
  const values = new Map();
  return {
    values,
    async set(key, value, options) {
      assert.deepEqual(options, { onlyIfNew: true });
      if (values.has(key)) return { modified: false };
      values.set(key, value);
      return { modified: true, etag: 'synthetic-etag' };
    }
  };
}

async function issueGrant({
  now = NOW_MS,
  fill = 0x31,
  env = ENV,
  cookie = adminCookie({ now, env }),
  requestToken = ADMIN_REQUEST_TOKEN
} = {}) {
  const response = await handleAdminTabletAuthorize(request(
    ADMIN_TABLET_AUTHORIZE_PATH,
    {
      body: { operation: 'issue' },
      cookie,
      requestToken
    }
  ), {
    env,
    now,
    randomBytes: size => Buffer.alloc(size, fill)
  });
  return {
    response,
    grantCookie: response.status === 200
      ? responseCookiePair(response, PRODUCTION_ADMIN_INSTALL_GRANT_COOKIE)
      : ''
  };
}

async function installGrant(grantCookie, {
  now = NOW_MS,
  fill = 0x41,
  env = ENV,
  store = oneTimeStore(),
  cookie = adminCookie({ now: NOW_MS, env }),
  requestToken = ADMIN_REQUEST_TOKEN,
  ...dependencies
} = {}) {
  const response = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    body: { operation: 'installAdminGrant' },
    cookie: [cookie, grantCookie].filter(Boolean).join('; '),
    requestToken
  }), {
    env,
    now,
    store,
    randomBytes: size => Buffer.alloc(size, fill),
    ...dependencies
  });
  return { response, store };
}

function resignGrant(grant, changes) {
  const [encoded] = grant.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const changed = Buffer.from(JSON.stringify({ ...payload, ...changes }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', INSTALL_SECRET)
    .update(PRODUCTION_ADMIN_INSTALL_GRANT_SIGNATURE_DOMAIN, 'utf8')
    .update(changed, 'utf8')
    .digest('base64url');
  return `${changed}.${signature}`;
}

test('Admin tablet authorization route is literal, production-only, and bounded', () => {
  assert.deepEqual(authorizeConfig, {
    path: ADMIN_TABLET_AUTHORIZE_PATH,
    rateLimit: {
      windowLimit: 3,
      windowSize: 60,
      aggregateBy: ['ip', 'domain']
    }
  });
  assert.match(
    authorizeSource,
    /export const config = \{[\s\S]*?path: '\/api\/m1-admin-tablet-authorize'/u
  );
  assert.equal(PRODUCTION_ADMIN_INSTALL_GRANT_MAX_SECONDS, 120);
  assert.equal(ENV.GIB_M1_PRODUCTION_INSTALL_RUN_ID, undefined);
});

test('same-device Admin authorization keeps its grant HttpOnly, installs the normal cookie, and makes no business call', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Business endpoint must not be called during authorization.');
  };
  try {
    const issued = await issueGrant();
    assert.equal(issued.response.status, 200);
    const issuedBody = await responseBody(issued.response);
    assert.deepEqual(issuedBody, { ok: true, issued: true, expiresInSeconds: 120 });
    assert.equal(JSON.stringify(issuedBody).includes(INSTALL_SECRET), false);
    assert.equal(JSON.stringify(issuedBody).includes(ADMIN_REQUEST_TOKEN), false);

    const issueCookie = setCookies(issued.response)[0];
    assert.match(issueCookie, /^__Host-gib_m1_tablet_authorization=/u);
    assert.match(issueCookie, /; Path=\//u);
    assert.match(issueCookie, /; Max-Age=120/u);
    assert.match(issueCookie, /; Secure/u);
    assert.match(issueCookie, /; HttpOnly/u);
    assert.match(issueCookie, /; SameSite=Strict/u);
    assert.doesNotMatch(issueCookie, /; Domain=/iu);

    const grant = cookieValue(issued.grantCookie);
    const payload = JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString('utf8'));
    assert.deepEqual(Object.keys(payload), [
      'v',
      'purpose',
      'origin',
      'installationId',
      'issuedAt',
      'expiresAt',
      'nonce',
      'sessionBinding'
    ]);
    assert.equal(payload.origin, PRODUCTION_ORIGIN);
    assert.equal(payload.installationId, 'rev');
    assert.equal(payload.issuedAt, NOW_SECONDS);
    assert.equal(payload.expiresAt, NOW_SECONDS + 120);
    assert.equal(JSON.stringify(payload).includes(ADMIN_REQUEST_TOKEN), false);
    assert.equal(JSON.stringify(payload).includes('Andrew Smith'), false);

    const store = oneTimeStore();
    const installed = await installGrant(issued.grantCookie, { store });
    assert.equal(installed.response.status, 200);
    assert.deepEqual(await responseBody(installed.response), { ok: true, installed: true });
    assert.equal(grantWasCleared(installed.response), true);
    const deviceCookie = setCookies(installed.response).find(value => (
      value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)
    ));
    assert.ok(deviceCookie);
    assert.match(deviceCookie, /; Path=\//u);
    assert.match(deviceCookie, /; Secure/u);
    assert.match(deviceCookie, /; HttpOnly/u);
    assert.match(deviceCookie, /; SameSite=Strict/u);
    assert.doesNotMatch(deviceCookie, /; Domain=/iu);

    assert.deepEqual([...store.values.keys()], [
      productionAdminInstallGrantConsumptionKey(grant)
    ]);
    assert.equal([...store.values.values()][0].includes(grant), false);
    assert.equal([...store.values.values()][0].includes(INSTALL_SECRET), false);

    const status = await handleTabletStatus(request(TABLET_STATUS_PATH, {
      body: {},
      cookie: deviceCookie.split(';', 1)[0]
    }), { env: ENV, now: NOW_MS });
    assert.equal(status.status, 200);
    assert.deepEqual(await responseBody(status), { authorized: true });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('issuance and installation both require the same live Admin session and request token', async () => {
  const missingSession = await issueGrant({ cookie: '' });
  assert.equal(missingSession.response.status, 401);
  assert.equal(grantWasCleared(missingSession.response), true);

  const missingToken = await handleAdminTabletAuthorize(request(
    ADMIN_TABLET_AUTHORIZE_PATH,
    {
      body: { operation: 'issue' },
      cookie: adminCookie()
    }
  ), { env: ENV, now: NOW_MS });
  assert.equal(missingToken.status, 403);
  assert.equal(grantWasCleared(missingToken), true);

  const wrongToken = await issueGrant({ requestToken: `${ADMIN_REQUEST_TOKEN}x` });
  assert.equal(wrongToken.response.status, 403);
  assert.equal(grantWasCleared(wrongToken.response), true);

  const issued = await issueGrant({ fill: 0x32 });
  const store = oneTimeStore();
  const wrongInstallToken = await installGrant(issued.grantCookie, {
    store,
    requestToken: `${ADMIN_REQUEST_TOKEN}x`
  });
  assert.equal(wrongInstallToken.response.status, 403);
  assert.equal(grantWasCleared(wrongInstallToken.response), true);
  assert.equal(store.values.size, 0);

  const otherAdminCookie = adminCookie({ adminName: 'Stuart Turner' });
  const otherAdmin = await installGrant(issued.grantCookie, {
    store,
    cookie: otherAdminCookie
  });
  assert.equal(otherAdmin.response.status, 403);
  assert.equal(grantWasCleared(otherAdmin.response), true);
  assert.equal(store.values.size, 0);
});

test('expired, replayed, wrong-origin, wrong-installation, and malformed grants fail closed', async () => {
  const expiredIssue = await issueGrant({ fill: 0x33 });
  const expiredStore = oneTimeStore();
  const expired = await installGrant(expiredIssue.grantCookie, {
    now: NOW_MS + (120 * 1_000),
    store: expiredStore
  });
  assert.equal(expired.response.status, 403);
  assert.equal(grantWasCleared(expired.response), true);
  assert.equal(expiredStore.values.size, 0);

  const replayIssue = await issueGrant({ fill: 0x34 });
  const replayStore = oneTimeStore();
  const first = await installGrant(replayIssue.grantCookie, { store: replayStore });
  assert.equal(first.response.status, 200);
  const replay = await installGrant(replayIssue.grantCookie, { store: replayStore });
  assert.equal(replay.response.status, 403);
  assert.equal(grantWasCleared(replay.response), true);
  assert.equal(setCookies(replay.response).some(value => (
    value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)
  )), false);

  const originalGrant = cookieValue(replayIssue.grantCookie);
  const invalidGrants = [
    resignGrant(originalGrant, { origin: 'https://evil.example' }),
    resignGrant(originalGrant, { installationId: 'richmond' }),
    resignGrant(originalGrant, {
      issuedAt: NOW_SECONDS + 1,
      expiresAt: NOW_SECONDS + 120
    }),
    resignGrant(originalGrant, { expiresAt: NOW_SECONDS + 121 }),
    resignGrant(originalGrant, { extra: true }),
    `${originalGrant.slice(0, -1)}${originalGrant.endsWith('A') ? 'B' : 'A'}`
  ];
  for (const invalidGrant of invalidGrants) {
    const invalidStore = oneTimeStore();
    const attempted = await installGrant(
      `${PRODUCTION_ADMIN_INSTALL_GRANT_COOKIE}=${encodeURIComponent(invalidGrant)}`,
      { store: invalidStore }
    );
    assert.equal(attempted.response.status, 403);
    assert.equal(grantWasCleared(attempted.response), true);
    assert.equal(invalidStore.values.size, 0);
  }

  const malformed = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    body: { operation: 'installAdminGrant', extra: true },
    cookie: `${adminCookie()}; ${replayIssue.grantCookie}`,
    requestToken: ADMIN_REQUEST_TOKEN
  }), { env: ENV, now: NOW_MS, store: oneTimeStore() });
  assert.equal(malformed.status, 403);
  assert.equal(grantWasCleared(malformed), true);
});

test('authorization endpoints are hidden on Richmond and reject non-production origins', async () => {
  const wrongOrigins = [
    'https://deploy-preview-99--gib-live.netlify.app',
    'https://evil.example',
    'https://gib-richmond-live.netlify.app'
  ];
  for (const origin of wrongOrigins) {
    const response = await handleAdminTabletAuthorize(request(
      ADMIN_TABLET_AUTHORIZE_PATH,
      {
        origin,
        body: { operation: 'issue' },
        cookie: adminCookie(),
        requestToken: ADMIN_REQUEST_TOKEN
      }
    ), { env: ENV, now: NOW_MS });
    assert.equal(response.status, 404);
    assert.equal(response.headers.has('set-cookie'), false);
  }

  const richmondOrigin = 'https://gib-richmond-live.netlify.app';
  const richmondAuthorize = await handleAdminTabletAuthorize(request(
    ADMIN_TABLET_AUTHORIZE_PATH,
    {
      origin: richmondOrigin,
      body: { operation: 'issue' }
    }
  ), {
    env: ENV,
    now: NOW_MS,
    installationId: 'richmond',
    environment: 'production',
    activation: 'active'
  });
  assert.equal(richmondAuthorize.status, 404);

  const richmondInstall = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    origin: richmondOrigin,
    body: { operation: 'installAdminGrant' }
  }), {
    env: ENV,
    now: NOW_MS,
    installationId: 'richmond',
    environment: 'production',
    activation: 'active'
  });
  assert.equal(richmondInstall.status, 404);
  assert.equal(richmondInstall.headers.has('set-cookie'), false);

  const crossOriginInstall = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    origin: 'https://evil.example',
    body: { operation: 'installAdminGrant' }
  }), { env: ENV, now: NOW_MS });
  assert.equal(crossOriginInstall.status, 403);
  assert.equal(crossOriginInstall.headers.has('set-cookie'), false);
});

test('the unchanged flow authorizes replacement and additional tablets independently', async () => {
  const store = oneTimeStore();
  const firstIssue = await issueGrant({ fill: 0x71 });
  const firstInstall = await installGrant(firstIssue.grantCookie, {
    fill: 0x81,
    store
  });
  const secondIssue = await issueGrant({ fill: 0x72 });
  const secondInstall = await installGrant(secondIssue.grantCookie, {
    fill: 0x82,
    store
  });

  assert.equal(firstInstall.response.status, 200);
  assert.equal(secondInstall.response.status, 200);
  const firstDevice = responseCookiePair(firstInstall.response, PRODUCTION_DEVICE_COOKIE);
  const secondDevice = responseCookiePair(secondInstall.response, PRODUCTION_DEVICE_COOKIE);
  assert.notEqual(firstDevice, secondDevice);
  assert.equal(store.values.size, 2);
});

test('grant-mode storage failure and credential failure clear the grant and never mint a device cookie', async () => {
  const issued = await issueGrant({ fill: 0x35 });
  const storageFailure = await installGrant(issued.grantCookie, {
    store: { async set() { throw new Error('synthetic store failure'); } }
  });
  assert.equal(storageFailure.response.status, 503);
  assert.equal(grantWasCleared(storageFailure.response), true);
  assert.equal(setCookies(storageFailure.response).some(value => (
    value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)
  )), false);

  const credentialStore = oneTimeStore();
  const credentialFailure = await installGrant(issued.grantCookie, {
    store: credentialStore,
    randomBytes: () => Buffer.alloc(0)
  });
  assert.equal(credentialFailure.response.status, 503);
  assert.equal(grantWasCleared(credentialFailure.response), true);
  assert.equal(credentialStore.values.size, 1);
  assert.equal(setCookies(credentialFailure.response).some(value => (
    value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)
  )), false);
});
