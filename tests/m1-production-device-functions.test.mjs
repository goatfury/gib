import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  TABLET_INSTALL_PATH,
  config as installConfig,
  handleTabletInstall
} from '../netlify/functions/m1-tablet-install.mjs';
import {
  TABLET_STATUS_PATH,
  config as statusConfig,
  handleTabletStatus
} from '../netlify/functions/m1-tablet-status.mjs';
import {
  PRODUCTION_DEVICE_COOKIE,
  PRODUCTION_INSTALL_MAX_SECONDS,
  PRODUCTION_INSTALL_SIGNATURE_DOMAIN,
  PRODUCTION_INSTALL_STORE,
  PRODUCTION_ORIGIN,
  createProductionDeviceCredential,
  createProductionInstallCapability,
  productionInstallConsumptionKey,
  readProductionInstallCapability,
  validProductionDeviceCredential
} from '../netlify/functions/_lib/m1-production-runtime.mjs';

const NOW_MS = Date.parse('2026-08-07T16:00:00Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const RUN_ID = 'm1-production-cutover-20260807';
const WEBHOOK_TOKEN = 'production-webhook-token-0123456789abcdef';
const DEVICE_TOKEN = 'production-device-token-abcdef0123456789';
const INSTALL_SECRET = 'production-install-secret-0011223344556677';
const NONCE = Buffer.alloc(32, 0x31).toString('base64url');
const ROOT = new URL('../', import.meta.url);
const installSource = readFileSync(new URL('netlify/functions/m1-tablet-install.mjs', ROOT), 'utf8');
const statusSource = readFileSync(new URL('netlify/functions/m1-tablet-status.mjs', ROOT), 'utf8');

const ENV = Object.freeze({
  GIB_M1_PRODUCTION_SYNC_ENABLED: 'true',
  GIB_M1_PRODUCTION_ORIGIN: PRODUCTION_ORIGIN,
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION_RECEIVER_123/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  GIB_M1_PRODUCTION_DEVICE_TOKEN: DEVICE_TOKEN,
  GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: INSTALL_SECRET,
  GIB_M1_PRODUCTION_INSTALL_RUN_ID: RUN_ID,
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER_456/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'test-webhook-token-fedcba9876543210'
});

function capability(overrides = {}) {
  return createProductionInstallCapability({
    secret: INSTALL_SECRET,
    runId: RUN_ID,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS,
    nonce: NONCE,
    ...overrides
  });
}

function resignCapability(token, changes) {
  const [encoded] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const changed = Buffer.from(JSON.stringify({ ...payload, ...changes }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', INSTALL_SECRET)
    .update(PRODUCTION_INSTALL_SIGNATURE_DOMAIN, 'utf8')
    .update(changed, 'utf8')
    .digest('base64url');
  return `${changed}.${signature}`;
}

function request(path, {
  origin = PRODUCTION_ORIGIN,
  requestOrigin = origin,
  host = new URL(origin).host,
  fetchSite = 'same-origin',
  body = {},
  cookie = '',
  includeHost = true,
  includeOrigin = true,
  includeFetchSite = true
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (includeHost) headers.Host = host;
  if (includeOrigin) headers.Origin = requestOrigin;
  if (includeFetchSite) headers['Sec-Fetch-Site'] = fetchSite;
  if (cookie) headers.Cookie = cookie;
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

async function body(response) {
  return JSON.parse(await response.text());
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

test('installer and status routes are literal and independently rate-limited', () => {
  assert.deepEqual(installConfig, {
    path: TABLET_INSTALL_PATH,
    rateLimit: {
      windowLimit: 5,
      windowSize: 60,
      aggregateBy: ['ip', 'domain']
    }
  });
  assert.deepEqual(statusConfig, {
    path: TABLET_STATUS_PATH,
    rateLimit: {
      windowLimit: 30,
      windowSize: 60,
      aggregateBy: ['ip', 'domain']
    }
  });
  assert.match(installSource, /export const config = \{[\s\S]*?path: '\/api\/m1-tablet-install'/u);
  assert.match(statusSource, /export const config = \{[\s\S]*?path: '\/api\/m1-tablet-status'/u);
});

test('capability helper and default-Date.now device credential use canonical seconds', () => {
  const now = Date.now();
  const token = createProductionInstallCapability({
    secret: INSTALL_SECRET,
    runId: RUN_ID,
    issuedAt: now,
    expiresAt: now + (PRODUCTION_INSTALL_MAX_SECONDS * 1_000),
    nonce: NONCE
  });
  assert.ok(readProductionInstallCapability(token, {
    installSecret: INSTALL_SECRET,
    runId: RUN_ID
  }));

  const credential = createProductionDeviceCredential(
    DEVICE_TOKEN,
    size => Buffer.alloc(size, 0x61)
  );
  assert.equal(validProductionDeviceCredential(credential, DEVICE_TOKEN), true);
  assert.match(credential, /^v1\.[A-Za-z0-9_-]{43}\.[1-9][0-9]{9}\.[A-Za-z0-9_-]{43}$/u);
});

test('production device credentials expire at the same 400-day boundary as their cookie', () => {
  const maxAgeSeconds = 400 * 24 * 60 * 60;
  const credential = createProductionDeviceCredential(
    DEVICE_TOKEN,
    size => Buffer.alloc(size, 0x62),
    NOW_MS
  );
  assert.equal(validProductionDeviceCredential(
    credential,
    DEVICE_TOKEN,
    NOW_MS + ((maxAgeSeconds - 1) * 1_000)
  ), true);
  assert.equal(validProductionDeviceCredential(
    credential,
    DEVICE_TOKEN,
    NOW_MS + (maxAgeSeconds * 1_000)
  ), false);
  assert.equal(validProductionDeviceCredential(
    credential,
    DEVICE_TOKEN,
    NOW_MS + ((maxAgeSeconds + 1) * 1_000)
  ), false);
});

test('install capabilities accept exactly ten hours and reject longer durations', () => {
  assert.equal(PRODUCTION_INSTALL_MAX_SECONDS, 36_000);
  const exactBoundary = createProductionInstallCapability({
    secret: INSTALL_SECRET,
    runId: RUN_ID,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS,
    nonce: NONCE
  });
  assert.equal(
    readProductionInstallCapability(exactBoundary, {
      installSecret: INSTALL_SECRET,
      runId: RUN_ID
    }, (NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS - 1) * 1_000)?.expiresAt,
    NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS
  );
  assert.equal(readProductionInstallCapability(exactBoundary, {
    installSecret: INSTALL_SECRET,
    runId: RUN_ID
  }, (NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS) * 1_000), null);

  assert.throws(() => createProductionInstallCapability({
    secret: INSTALL_SECRET,
    runId: RUN_ID,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS + 1,
    nonce: NONCE
  }), /Invalid production install capability input/u);
  assert.equal(readProductionInstallCapability(resignCapability(exactBoundary, {
    expiresAt: NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS + 1
  }), {
    installSecret: INSTALL_SECRET,
    runId: RUN_ID
  }, NOW_MS), null);
});

test('install rejects preview and malformed production boundaries before replay storage', async () => {
  const candidates = [
    request(TABLET_INSTALL_PATH, {
      origin: 'https://deploy-preview-50--gib-live.netlify.app',
      body: { capability: capability() }
    }),
    request(TABLET_INSTALL_PATH, {
      origin: 'https://bjjsite.com',
      body: { capability: capability() }
    }),
    request(TABLET_INSTALL_PATH, {
      requestOrigin: 'https://evil.example',
      body: { capability: capability() }
    }),
    request(TABLET_INSTALL_PATH, {
      host: 'evil.example',
      body: { capability: capability() }
    }),
    request(TABLET_INSTALL_PATH, {
      fetchSite: 'cross-site',
      body: { capability: capability() }
    }),
    request(`${TABLET_INSTALL_PATH}?again=1`, {
      body: { capability: capability() }
    }),
    request(TABLET_INSTALL_PATH, {
      includeHost: false,
      body: { capability: capability() }
    })
  ];
  let storeCalls = 0;
  const store = { async set() { storeCalls += 1; return { modified: true }; } };
  for (const candidate of candidates) {
    const response = await handleTabletInstall(candidate, {
      env: ENV,
      now: NOW_MS,
      store
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.has('set-cookie'), false);
  }
  assert.equal(storeCalls, 0);
});

test('missing or cross-scoped installer configuration fails before replay storage', async () => {
  const variants = [
    {},
    { ...ENV, GIB_M1_PRODUCTION_SYNC_ENABLED: '' },
    { ...ENV, GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: '' },
    { ...ENV, GIB_M1_PRODUCTION_INSTALL_RUN_ID: '' },
    { ...ENV, GIB_M1_PRODUCTION_DEVICE_TOKEN: INSTALL_SECRET },
    { ...ENV, GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: ENV.GIB_TEST_WEBHOOK_TOKEN }
  ];
  let storeCalls = 0;
  for (const env of variants) {
    const response = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
      body: { capability: capability() }
    }), {
      env,
      now: NOW_MS,
      store: { async set() { storeCalls += 1; return { modified: true }; } }
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.has('set-cookie'), false);
  }
  assert.equal(storeCalls, 0);
});

test('valid run-bound install atomically consumes only a hash and returns an HttpOnly host cookie', async () => {
  const token = capability();
  const store = oneTimeStore();
  const response = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    body: { capability: token }
  }), {
    env: ENV,
    now: NOW_MS,
    store,
    randomBytes: size => Buffer.alloc(size, 0x42)
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, installed: true });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-gib_m1_production_device=/u);
  assert.match(cookie, /; Path=\//u);
  assert.match(cookie, /; Secure/u);
  assert.match(cookie, /; HttpOnly/u);
  assert.match(cookie, /; SameSite=Strict/u);
  assert.doesNotMatch(cookie, /; Domain=/iu);
  for (const secret of [token, NONCE, INSTALL_SECRET, DEVICE_TOKEN, WEBHOOK_TOKEN]) {
    assert.equal(cookie.includes(secret), false);
  }

  assert.deepEqual([...store.values.keys()], [productionInstallConsumptionKey(token)]);
  const stored = [...store.values.values()][0];
  for (const secret of [token, NONCE, INSTALL_SECRET, DEVICE_TOKEN, WEBHOOK_TOKEN]) {
    assert.equal(stored.includes(secret), false);
  }

  const cookiePair = cookie.split(';', 1)[0];
  const status = await handleTabletStatus(request(TABLET_STATUS_PATH, {
    body: {},
    cookie: cookiePair
  }), { env: ENV, now: NOW_MS });
  assert.equal(status.status, 200);
  assert.deepEqual(await body(status), { authorized: true });
  assert.equal(status.headers.has('set-cookie'), false);
});

test('expired, future, tampered, wrong-run, and replayed capabilities fail closed', async () => {
  const store = oneTimeStore();
  const valid = capability();
  const cases = [
    capability({
      issuedAt: NOW_SECONDS - PRODUCTION_INSTALL_MAX_SECONDS,
      expiresAt: NOW_SECONDS - 1
    }),
    capability({
      issuedAt: NOW_SECONDS + 1,
      expiresAt: NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS
    }),
    `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`,
    resignCapability(valid, { purpose: 'diagnostic' }),
    resignCapability(valid, { origin: 'https://bjjsite.com' }),
    resignCapability(valid, { extra: true }),
    createProductionInstallCapability({
      secret: INSTALL_SECRET,
      runId: 'different-production-run',
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + PRODUCTION_INSTALL_MAX_SECONDS,
      nonce: NONCE
    })
  ];
  for (const candidate of cases) {
    const response = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
      body: { capability: candidate }
    }), { env: ENV, now: NOW_MS, store });
    assert.equal(response.status, 403);
    assert.equal(response.headers.has('set-cookie'), false);
  }
  assert.equal(store.values.size, 0);

  const first = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    body: { capability: valid }
  }), {
    env: ENV,
    now: NOW_MS,
    store,
    randomBytes: size => Buffer.alloc(size, 0x42)
  });
  assert.equal(first.status, 200);
  const replay = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    body: { capability: valid }
  }), {
    env: ENV,
    now: NOW_MS,
    store,
    randomBytes: size => Buffer.alloc(size, 0x43)
  });
  assert.equal(replay.status, 403);
  assert.equal(replay.headers.has('set-cookie'), false);
});

test('simultaneous installer replay can mint exactly one device cookie', async () => {
  const token = capability();
  const store = oneTimeStore();
  const responses = await Promise.all([0x51, 0x52].map(fill => handleTabletInstall(
    request(TABLET_INSTALL_PATH, { body: { capability: token } }),
    {
      env: ENV,
      now: NOW_MS,
      store,
      randomBytes: size => Buffer.alloc(size, fill)
    }
  )));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 403]);
  assert.equal(responses.filter(response => response.headers.has('set-cookie')).length, 1);
  assert.equal(store.values.size, 1);
});

test('replay-store failure burns safely without issuing a device credential', async () => {
  const response = await handleTabletInstall(request(TABLET_INSTALL_PATH, {
    body: { capability: capability() }
  }), {
    env: ENV,
    now: NOW_MS,
    store: { async set() { throw new Error('synthetic store failure'); } }
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.has('set-cookie'), false);
  const text = await response.text();
  for (const secret of [INSTALL_SECRET, DEVICE_TOKEN, WEBHOOK_TOKEN]) {
    assert.equal(text.includes(secret), false);
  }
});

test('status returns only its authorization boolean for every outcome', async () => {
  const goodCredential = createProductionDeviceCredential(
    DEVICE_TOKEN,
    size => Buffer.alloc(size, 0x44),
    NOW_MS
  );
  const wrongCredential = createProductionDeviceCredential(
    ENV.GIB_TEST_WEBHOOK_TOKEN,
    size => Buffer.alloc(size, 0x44),
    NOW_MS
  );
  const cases = [
    [request(TABLET_STATUS_PATH, { body: {} }), ENV, 200, false],
    [request(TABLET_STATUS_PATH, {
      body: {},
      cookie: `${PRODUCTION_DEVICE_COOKIE}=${wrongCredential}`
    }), ENV, 200, false],
    [request(TABLET_STATUS_PATH, {
      body: {},
      cookie: `${PRODUCTION_DEVICE_COOKIE}=${goodCredential}`
    }), ENV, 200, true],
    [request(TABLET_STATUS_PATH, {
      origin: 'https://deploy-preview-50--gib-live.netlify.app',
      body: {}
    }), ENV, 403, false],
    [request(TABLET_STATUS_PATH, { body: {} }), {}, 503, false],
    [request(TABLET_STATUS_PATH, { body: { extra: true } }), ENV, 400, false]
  ];
  for (const [candidate, env, status, authorized] of cases) {
    const response = await handleTabletStatus(candidate, { env, now: NOW_MS });
    assert.equal(response.status, status);
    assert.deepEqual(await body(response), { authorized });
  }
});

test('production replay store name is public and contains no credential material', () => {
  assert.equal(PRODUCTION_INSTALL_STORE, 'gib-m1-production-installer');
  for (const secret of [INSTALL_SECRET, DEVICE_TOKEN, WEBHOOK_TOKEN]) {
    assert.equal(PRODUCTION_INSTALL_STORE.includes(secret), false);
  }
});
