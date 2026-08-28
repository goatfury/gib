import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  createAdminSession,
  runtimeConfig
} from '../netlify/functions/_lib/m1-common.mjs';
import {
  staffClockPairingProfile
} from '../netlify/functions/_lib/m1-installation.mjs';
import {
  PRODUCTION_DEVICE_COOKIE,
  PRODUCTION_ORIGIN,
  createProductionDeviceCredential,
  productionAdminInstallerConfig
} from '../netlify/functions/_lib/m1-production-runtime.mjs';
import {
  TABLET_PAIRING_ADMISSION_KEY,
  TABLET_PAIRING_ADMISSION_LIMIT,
  TABLET_PAIRING_ADMISSION_WINDOW_SECONDS,
  TABLET_PAIRING_CODE_PATTERN,
  TABLET_PAIRING_DELIVERY_GRACE_SECONDS,
  TABLET_PAIRING_GENESIS_SECONDS,
  TABLET_PAIRING_MAX_SECONDS,
  TABLET_PAIRING_PENDING_COOKIE,
  TABLET_PAIRING_PENDING_MAX_SECONDS,
  TABLET_PAIRING_PURPOSE,
  TABLET_PAIRING_PURGE_SECONDS,
  TABLET_PAIRING_REVIEW_COOKIE,
  TABLET_PAIRING_REVIEW_MAX_SECONDS,
  createPairingPendingToken,
  emptyPairingRequestRecord,
  normalizePairingCode,
  pairingCodeFromRequest,
  pairingCodeIndexRecord,
  pairingCodeIndexKey,
  pairingCodeIndexKeyFromHash,
  pairingRequestKey,
  readPairingPendingToken,
  reservePairingAdmission,
  validPairingRequestRecord
} from '../netlify/functions/_lib/m1-tablet-pairing.mjs';
import {
  ADMIN_TABLET_PAIRING_PATH,
  config as adminPairingConfig,
  handleAdminTabletPairing
} from '../netlify/functions/m1-admin-tablet-pairing.mjs';
import {
  PAIRING_CLEANUP_CONCURRENCY,
  PAIRING_CLEANUP_CURSOR_KEY,
  PAIRING_CLEANUP_LIMIT_PER_PREFIX,
  PAIRING_CLEANUP_PREFIXES,
  config as cleanupConfig,
  handleTabletPairingCleanup
} from '../netlify/functions/m1-tablet-pairing-cleanup.mjs';
import {
  TABLET_PAIRING_CANCEL_PATH,
  config as cancelConfig,
  handleTabletPairingCancel
} from '../netlify/functions/m1-tablet-pairing-cancel.mjs';
import {
  TABLET_PAIRING_POLL_PATH,
  config as pollConfig,
  handleTabletPairingPoll
} from '../netlify/functions/m1-tablet-pairing-poll.mjs';
import {
  TABLET_PAIRING_START_PATH,
  config as startConfig,
  handleTabletPairingStart
} from '../netlify/functions/m1-tablet-pairing-start.mjs';
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
const installSource = readFileSync(new URL('netlify/functions/m1-tablet-install.mjs', ROOT), 'utf8');

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

class StrongStore {
  constructor() {
    this.values = new Map();
    this.etagCounter = 0;
    this.calls = [];
    this.pageReads = [];
    this.readFailures = new Set();
  }

  async set(key, serialized, options) {
    this.calls.push(['set', key, options]);
    const current = this.values.get(key);
    if (options?.onlyIfNew && current) return { modified: false };
    if (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch) {
      return { modified: false };
    }
    const etag = `etag-${++this.etagCounter}`;
    this.values.set(key, { value: JSON.parse(serialized), etag });
    return { modified: true, etag };
  }

  async getWithMetadata(key, options) {
    this.calls.push(['getWithMetadata', key, options]);
    assert.deepEqual(options, { type: 'json', consistency: 'strong' });
    if (this.readFailures.has(key)) throw new Error('Synthetic corrupt Blob read.');
    const current = this.values.get(key);
    return current ? { data: structuredClone(current.value), etag: current.etag } : null;
  }

  async delete(key) {
    this.calls.push(['delete', key]);
    this.values.delete(key);
  }

  list({ prefix, paginate }) {
    this.calls.push(['list', prefix, paginate]);
    assert.equal(paginate, true);
    const keys = [...this.values.keys()].filter(key => key.startsWith(prefix)).sort();
    const tracker = this.pageReads;
    return {
      async *[Symbol.asyncIterator]() {
        tracker.push(prefix);
        yield { blobs: keys.map(key => ({ key })) };
        tracker.push(`${prefix}:second-page-requested`);
        yield { blobs: [] };
      }
    };
  }
}

function adminRuntime(env = ENV) {
  const runtime = runtimeConfig(env, {
    admin: true,
    requestUrl: `${PRODUCTION_ORIGIN}${ADMIN_TABLET_PAIRING_PATH}`
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

async function body(response) {
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

function clearedCookie(response, name) {
  return setCookies(response).some(value => (
    value.startsWith(`${name}=`) && value.includes('Max-Age=0')
  ));
}

function fillRandom(fill) {
  return size => Buffer.alloc(size, fill);
}

async function startPairing(store, {
  now = NOW_MS,
  fill = 0x31,
  cookie = '',
  origin = PRODUCTION_ORIGIN,
  dependencies = {}
} = {}) {
  const response = await handleTabletPairingStart(request(TABLET_PAIRING_START_PATH, {
    origin,
    body: { operation: 'start' },
    cookie
  }), {
    env: ENV,
    now,
    store,
    randomBytes: fillRandom(fill),
    ...dependencies
  });
  return {
    response,
    responseBody: await body(response),
    pendingCookie: response.status === 200
      && setCookies(response).some(value => value.startsWith(`${TABLET_PAIRING_PENDING_COOKIE}=`))
      ? responseCookiePair(response, TABLET_PAIRING_PENDING_COOKIE)
      : ''
  };
}

async function pollPairing(store, pendingCookie, {
  now = NOW_MS,
  deviceCookie = '',
  path = TABLET_PAIRING_POLL_PATH,
  bodyValue = { operation: 'poll' },
  dependencies = {}
} = {}) {
  const response = await handleTabletPairingPoll(request(path, {
    body: bodyValue,
    cookie: [pendingCookie, deviceCookie].filter(Boolean).join('; ')
  }), { env: ENV, now, store, ...dependencies });
  return { response, responseBody: await body(response) };
}

async function cancelPairing(store, pendingCookie, {
  now = NOW_MS,
  path = TABLET_PAIRING_CANCEL_PATH,
  bodyValue = { operation: 'cancel' },
  dependencies = {}
} = {}) {
  const response = await handleTabletPairingCancel(request(path, {
    body: bodyValue,
    cookie: pendingCookie
  }), { env: ENV, now, store, ...dependencies });
  return { response, responseBody: await body(response) };
}

async function reviewPairing(store, pairingCode, {
  now = NOW_MS,
  cookie = adminCookie(),
  requestToken = ADMIN_REQUEST_TOKEN,
  dependencies = {}
} = {}) {
  const response = await handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
    body: { operation: 'review', pairingCode },
    cookie,
    requestToken
  }), { env: ENV, now, store, ...dependencies });
  return {
    response,
    responseBody: await body(response),
    reviewCookie: response.status === 200
      ? responseCookiePair(response, TABLET_PAIRING_REVIEW_COOKIE)
      : ''
  };
}

async function approvePairing(store, pairingCode, reviewCookie, {
  now = NOW_MS,
  fill = 0x41,
  cookie = adminCookie(),
  requestToken = ADMIN_REQUEST_TOKEN,
  dependencies = {}
} = {}) {
  const response = await handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
    body: { operation: 'approve', pairingCode },
    cookie: [cookie, reviewCookie].filter(Boolean).join('; '),
    requestToken
  }), {
    env: ENV,
    now,
    store,
    randomBytes: fillRandom(fill),
    ...dependencies
  });
  return { response, responseBody: await body(response) };
}

async function rejectPairing(store, pairingCode, reviewCookie, {
  now = NOW_MS,
  cookie = adminCookie(),
  requestToken = ADMIN_REQUEST_TOKEN,
  dependencies = {}
} = {}) {
  const response = await handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
    body: { operation: 'reject', pairingCode },
    cookie: [cookie, reviewCookie].filter(Boolean).join('; '),
    requestToken
  }), { env: ENV, now, store, ...dependencies });
  return { response, responseBody: await body(response) };
}

async function completeApproval(store, started, options = {}) {
  const reviewed = await reviewPairing(store, started.responseBody.pairingCode, options);
  assert.equal(reviewed.response.status, 200);
  const approved = await approvePairing(
    store,
    started.responseBody.pairingCode,
    reviewed.reviewCookie,
    options
  );
  assert.equal(approved.response.status, 200);
  return { reviewed, approved };
}

async function seedHistoricalPairingRecord(store, {
  profile,
  requestedAt,
  fill
}) {
  const requestId = Buffer.alloc(32, fill).toString('base64url');
  const pairingCode = pairingCodeFromRequest(INSTALL_SECRET, profile, requestId);
  const record = emptyPairingRequestRecord(
    INSTALL_SECRET,
    profile,
    requestId,
    pairingCode,
    requestedAt
  );
  const requestKey = pairingRequestKey(profile, requestId, record.requestedAt);
  const codeKey = pairingCodeIndexKey(INSTALL_SECRET, profile, pairingCode);
  const index = pairingCodeIndexRecord(
    profile,
    requestKey,
    record.codeHash,
    record.approvalExpiresAt,
    record.purgeAfter
  );
  assert.equal((await store.set(
    requestKey,
    JSON.stringify(record),
    { onlyIfNew: true }
  )).modified, true);
  assert.equal((await store.set(
    codeKey,
    JSON.stringify(index),
    { onlyIfNew: true }
  )).modified, true);
  return { requestKey, codeKey, record, index };
}

test('pairing profile and literal routes expose Rev only with independent bounded limits', () => {
  const profile = staffClockPairingProfile();
  assert.deepEqual(profile, {
    installationId: 'rev',
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk',
    origin: PRODUCTION_ORIGIN,
    expiresInSeconds: 12 * 60 * 60
  });
  assert.equal(staffClockPairingProfile('richmond', 'test'), null);
  assert.equal(staffClockPairingProfile('richmond', 'production', 'active'), null);
  assert.deepEqual(startConfig, {
    path: TABLET_PAIRING_START_PATH,
    rateLimit: { windowLimit: 3, windowSize: 60, aggregateBy: ['ip', 'domain'] }
  });
  assert.deepEqual(pollConfig, {
    path: TABLET_PAIRING_POLL_PATH,
    rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] }
  });
  assert.deepEqual(cancelConfig, {
    path: TABLET_PAIRING_CANCEL_PATH,
    rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] }
  });
  assert.deepEqual(adminPairingConfig, {
    path: ADMIN_TABLET_PAIRING_PATH,
    rateLimit: { windowLimit: 10, windowSize: 300, aggregateBy: ['ip', 'domain'] }
  });
  assert.deepEqual(cleanupConfig, { schedule: '*/5 * * * *' });
  assert.equal(TABLET_PAIRING_MAX_SECONDS, 12 * 60 * 60);
  assert.equal(TABLET_PAIRING_DELIVERY_GRACE_SECONDS, 120);
  assert.equal(TABLET_PAIRING_REVIEW_MAX_SECONDS, 15 * 60);
  assert.equal(TABLET_PAIRING_PENDING_MAX_SECONDS, (12 * 60 * 60) + 120);
  assert.equal(PAIRING_CLEANUP_LIMIT_PER_PREFIX, 30);
  assert.equal(PAIRING_CLEANUP_CONCURRENCY, 5);
  assert.ok(PAIRING_CLEANUP_LIMIT_PER_PREFIX * 12 > 180);
  assert.deepEqual(PAIRING_CLEANUP_PREFIXES, ['pairing/request/v1/']);
  assert.equal(productionAdminInstallerConfig(ENV, {
    staffClockPairing: true,
    installationId: 'rev'
  })?.origin, PRODUCTION_ORIGIN);
  assert.equal(productionAdminInstallerConfig(ENV, {
    staffClockPairing: true,
    installationId: 'richmond',
    environment: 'production',
    activation: 'active'
  }), null);
});

test('configured pairing lifetimes accept the full 60-second-to-12-hour range and bind every signed deadline', () => {
  const requestId = Buffer.alloc(32, 0x2a).toString('base64url');
  for (const expiresInSeconds of [60, 61, 119, 120, 299, 300, 43_199, 43_200]) {
    const profile = Object.freeze({
      ...staffClockPairingProfile(),
      expiresInSeconds
    });
    const pairingCode = pairingCodeFromRequest(INSTALL_SECRET, profile, requestId);
    const record = emptyPairingRequestRecord(
      INSTALL_SECRET,
      profile,
      requestId,
      pairingCode,
      NOW_MS
    );
    assert.equal(record.approvalExpiresAt, NOW_SECONDS + expiresInSeconds);
    assert.equal(validPairingRequestRecord(record, profile), true);

    const token = createPairingPendingToken({
      secret: INSTALL_SECRET,
      profile,
      requestId,
      issuedAt: NOW_SECONDS,
      approvalExpiresAt: record.approvalExpiresAt,
      expiresAt: record.approvalExpiresAt + TABLET_PAIRING_DELIVERY_GRACE_SECONDS
    });
    assert.deepEqual(readPairingPendingToken(token, INSTALL_SECRET, profile, NOW_MS), {
      v: 1,
      purpose: TABLET_PAIRING_PURPOSE,
      installationId: 'rev',
      origin: PRODUCTION_ORIGIN,
      requestId,
      issuedAt: NOW_SECONDS,
      approvalExpiresAt: NOW_SECONDS + expiresInSeconds,
      expiresAt: NOW_SECONDS + expiresInSeconds + TABLET_PAIRING_DELIVERY_GRACE_SECONDS,
      expired: false
    });
    assert.equal(
      readPairingPendingToken(
        token,
        INSTALL_SECRET,
        profile,
        NOW_MS + ((expiresInSeconds + TABLET_PAIRING_DELIVERY_GRACE_SECONDS) * 1_000)
      )?.expired,
      true
    );
  }

  for (const expiresInSeconds of [59, 43_201]) {
    assert.throws(() => pairingCodeFromRequest(INSTALL_SECRET, {
      ...staffClockPairingProfile(),
      expiresInSeconds
    }, requestId), /Invalid tablet pairing code input/u);
  }
});

test('start returns one 50-bit Crockford display code and securely reuses it only for the same tablet', async () => {
  const store = new StrongStore();
  const started = await startPairing(store);
  assert.equal(started.response.status, 200);
  assert.deepEqual(started.responseBody, {
    ok: true,
    result: 'pending',
    pairingCode: started.responseBody.pairingCode,
    expiresAt: new Date((NOW_SECONDS + (12 * 60 * 60)) * 1_000).toISOString(),
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk'
  });
  assert.match(started.responseBody.pairingCode, TABLET_PAIRING_CODE_PATTERN);
  assert.equal(normalizePairingCode(started.responseBody.pairingCode.toLowerCase()), started.responseBody.pairingCode);
  assert.doesNotMatch(started.responseBody.pairingCode, /[ILOU]/u);
  const pendingHeader = setCookies(started.response)[0];
  assert.match(pendingHeader, /^__Host-gib_m1_tablet_pairing=/u);
  assert.match(pendingHeader, /; Path=\//u);
  assert.match(pendingHeader, /; Max-Age=43320/u);
  assert.match(pendingHeader, /; Secure/u);
  assert.match(pendingHeader, /; HttpOnly/u);
  assert.match(pendingHeader, /; SameSite=Strict/u);
  assert.doesNotMatch(pendingHeader, /; Domain=/iu);
  assert.equal(store.values.size, 3);
  assert.deepEqual(store.values.get(TABLET_PAIRING_ADMISSION_KEY).value, {
    v: 1,
    windowStart: NOW_SECONDS,
    windowExpiresAt: NOW_SECONDS + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS,
    count: 1
  });

  const before = store.values.size;
  const admissionBefore = structuredClone(store.values.get(TABLET_PAIRING_ADMISSION_KEY).value);
  const reused = await startPairing(store, {
    now: NOW_MS + (60 * 60 * 1_000),
    cookie: started.pendingCookie,
    fill: 0x52
  });
  assert.equal(reused.response.status, 200);
  assert.deepEqual(reused.responseBody, started.responseBody);
  assert.equal(store.values.size, before);
  assert.deepEqual(
    store.values.get(TABLET_PAIRING_ADMISSION_KEY).value,
    admissionBefore,
    'exact pending-cookie reuse must not consume another global admission'
  );
  assert.equal(reused.pendingCookie, '');

  const profile = staffClockPairingProfile();
  const codeIndex = pairingCodeIndexKey(INSTALL_SECRET, profile, started.responseBody.pairingCode);
  assert.equal(store.values.has(codeIndex), true);
  const publicHash = createHash('sha256')
    .update(`rev\0${PRODUCTION_ORIGIN}\0${started.responseBody.pairingCode}`, 'utf8')
    .digest('hex');
  assert.notEqual(codeIndex.split('/').at(-1), publicHash);
  for (const stored of store.values.values()) {
    assert.equal(JSON.stringify(stored.value).includes(started.responseBody.pairingCode), false);
  }
});

test('a 5:45 AM code survives reload, 6:45 AM approval, and a delayed tablet reconnect', async () => {
  const store = new StrongStore();
  const generatedAt = Date.parse('2026-08-28T05:45:00-04:00');
  const reloadedAt = Date.parse('2026-08-28T06:15:00-04:00');
  const approvedAt = Date.parse('2026-08-28T06:45:00-04:00');
  const reconnectedAt = Date.parse('2026-08-28T07:15:00-04:00');
  const started = await startPairing(store, { now: generatedAt, fill: 0x53 });
  assert.equal(started.response.status, 200);
  assert.equal(
    started.responseBody.expiresAt,
    new Date(Date.parse('2026-08-28T17:45:00-04:00')).toISOString()
  );

  const reloaded = await startPairing(store, {
    now: reloadedAt,
    cookie: started.pendingCookie,
    fill: 0x54
  });
  assert.equal(reloaded.response.status, 200);
  assert.deepEqual(reloaded.responseBody, started.responseBody);
  assert.equal(reloaded.pendingCookie, '');

  const approvalAdminCookie = adminCookie({ now: approvedAt });
  const reviewed = await reviewPairing(store, started.responseBody.pairingCode, {
    now: approvedAt,
    cookie: approvalAdminCookie
  });
  assert.equal(reviewed.response.status, 200);
  const approved = await approvePairing(
    store,
    started.responseBody.pairingCode,
    reviewed.reviewCookie,
    {
      now: approvedAt,
      cookie: approvalAdminCookie,
      fill: 0x55
    }
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.responseBody.result, 'approved');

  const freshReview = await reviewPairing(store, started.responseBody.pairingCode, {
    now: approvedAt + 1_000,
    cookie: adminCookie({ now: approvedAt + 1_000 })
  });
  assert.equal(freshReview.response.status, 404, 'approval immediately invalidates fresh code review');

  const delivered = await pollPairing(store, started.pendingCookie, { now: reconnectedAt });
  assert.equal(delivered.response.status, 200);
  assert.deepEqual(delivered.responseBody, {
    ok: true,
    result: 'approved',
    expiresAt: started.responseBody.expiresAt,
    deliveryExpiresAt: new Date(
      Date.parse('2026-08-28T17:47:00-04:00')
    ).toISOString()
  });
  const deviceCookie = responseCookiePair(delivered.response, PRODUCTION_DEVICE_COOKIE);
  assert.ok(deviceCookie);
  const authorized = await pollPairing(store, started.pendingCookie, {
    now: reconnectedAt + 1_000,
    deviceCookie
  });
  assert.deepEqual(authorized.responseBody, { ok: true, result: 'authorized' });
});

test('Admin review possession remains usable for 15 minutes and expires at the boundary', async () => {
  const beforeBoundaryStore = new StrongStore();
  const beforeBoundary = await startPairing(beforeBoundaryStore, { fill: 0x56 });
  const beforeReview = await reviewPairing(
    beforeBoundaryStore,
    beforeBoundary.responseBody.pairingCode
  );
  const beforeApproval = await approvePairing(
    beforeBoundaryStore,
    beforeBoundary.responseBody.pairingCode,
    beforeReview.reviewCookie,
    { now: NOW_MS + (899 * 1_000), fill: 0x57 }
  );
  assert.equal(beforeApproval.response.status, 200);

  const atBoundaryStore = new StrongStore();
  const atBoundary = await startPairing(atBoundaryStore, { fill: 0x58 });
  const atBoundaryReview = await reviewPairing(
    atBoundaryStore,
    atBoundary.responseBody.pairingCode
  );
  const atBoundaryApproval = await approvePairing(
    atBoundaryStore,
    atBoundary.responseBody.pairingCode,
    atBoundaryReview.reviewCookie,
    { now: NOW_MS + (900 * 1_000), fill: 0x59 }
  );
  assert.equal(atBoundaryApproval.response.status, 403);
  assert.equal(clearedCookie(atBoundaryApproval.response, TABLET_PAIRING_REVIEW_COOKIE), true);
});

test('Admin rejection and tablet cancellation are explicit, bound, terminal, and retry-safe', async () => {
  const rejectedStore = new StrongStore();
  const rejectedStarted = await startPairing(rejectedStore, { fill: 0x5a });
  const rejectedReview = await reviewPairing(
    rejectedStore,
    rejectedStarted.responseBody.pairingCode
  );
  const rejected = await rejectPairing(
    rejectedStore,
    rejectedStarted.responseBody.pairingCode,
    rejectedReview.reviewCookie
  );
  assert.equal(rejected.response.status, 200);
  assert.deepEqual(rejected.responseBody, {
    ok: true,
    result: 'rejected',
    installationId: 'rev',
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk'
  });
  const rejectedRetry = await rejectPairing(
    rejectedStore,
    rejectedStarted.responseBody.pairingCode,
    rejectedReview.reviewCookie
  );
  assert.equal(rejectedRetry.response.status, 200);
  assert.deepEqual(rejectedRetry.responseBody, rejected.responseBody);
  const rejectedPoll = await pollPairing(rejectedStore, rejectedStarted.pendingCookie);
  assert.equal(rejectedPoll.response.status, 409);
  assert.deepEqual(rejectedPoll.responseBody, {
    ok: false,
    result: 'rejected',
    message: 'Pairing request was rejected by an Admin.'
  });
  assert.equal(clearedCookie(rejectedPoll.response, TABLET_PAIRING_PENDING_COOKIE), true);
  assert.equal(
    setCookies(rejectedPoll.response).some(value => value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)),
    false
  );
  const rejectedFreshReview = await reviewPairing(
    rejectedStore,
    rejectedStarted.responseBody.pairingCode
  );
  assert.equal(rejectedFreshReview.response.status, 404);

  const cancelledStore = new StrongStore();
  const cancelledStarted = await startPairing(cancelledStore, { fill: 0x5b });
  const cancelled = await cancelPairing(cancelledStore, cancelledStarted.pendingCookie);
  assert.equal(cancelled.response.status, 200);
  assert.deepEqual(cancelled.responseBody, { ok: true, result: 'cancelled' });
  assert.equal(clearedCookie(cancelled.response, TABLET_PAIRING_PENDING_COOKIE), true);
  const cancelledRetry = await cancelPairing(cancelledStore, cancelledStarted.pendingCookie);
  assert.equal(cancelledRetry.response.status, 200);
  assert.deepEqual(cancelledRetry.responseBody, cancelled.responseBody);
  const cancelledPoll = await pollPairing(cancelledStore, cancelledStarted.pendingCookie);
  assert.equal(cancelledPoll.response.status, 409);
  assert.deepEqual(cancelledPoll.responseBody, {
    ok: false,
    result: 'cancelled',
    message: 'Pairing request was cancelled on this tablet.'
  });
  assert.equal(clearedCookie(cancelledPoll.response, TABLET_PAIRING_PENDING_COOKIE), true);
  const cancelledReview = await reviewPairing(
    cancelledStore,
    cancelledStarted.responseBody.pairingCode
  );
  assert.equal(cancelledReview.response.status, 404);

  const replacement = await startPairing(cancelledStore, {
    now: NOW_MS + 1_000,
    cookie: cancelledStarted.pendingCookie,
    fill: 0x5c
  });
  assert.equal(replacement.response.status, 200);
  assert.equal(replacement.responseBody.result, 'pending');
  assert.notEqual(replacement.responseBody.pairingCode, cancelledStarted.responseBody.pairingCode);
});

test('an approval that wins a cancellation race still delivers the one device credential', async () => {
  const store = new StrongStore();
  const started = await startPairing(store, { fill: 0x5d });
  const reviewed = await reviewPairing(store, started.responseBody.pairingCode);

  let releaseCancellation;
  let signalCancellationWrite;
  const cancellationWrite = new Promise(resolve => { signalCancellationWrite = resolve; });
  const cancellationGate = new Promise(resolve => { releaseCancellation = resolve; });
  const originalSet = store.set.bind(store);
  store.set = async (key, serialized, options) => {
    const value = JSON.parse(serialized);
    if (options?.onlyIfMatch && value.status === 'cancelled') {
      signalCancellationWrite();
      await cancellationGate;
    }
    return originalSet(key, serialized, options);
  };

  const cancelling = cancelPairing(store, started.pendingCookie);
  await cancellationWrite;
  const approved = await approvePairing(
    store,
    started.responseBody.pairingCode,
    reviewed.reviewCookie,
    { fill: 0x5e }
  );
  assert.equal(approved.response.status, 200);
  releaseCancellation();

  const cancelResult = await cancelling;
  assert.equal(cancelResult.response.status, 200);
  assert.equal(cancelResult.responseBody.result, 'approved');
  assert.ok(responseCookiePair(cancelResult.response, PRODUCTION_DEVICE_COOKIE));
  assert.equal(clearedCookie(cancelResult.response, TABLET_PAIRING_PENDING_COOKIE), false);
});

test('global admission allows 120 distinct requests, rejects the 121st without request writes, and resets next hour', async () => {
  const store = new StrongStore();
  const distinctRandom = index => size => {
    const value = Buffer.alloc(size, 0x25);
    value.writeUInt32BE(index + 1, size - 4);
    return value;
  };
  const pairingCodes = new Set();
  for (let index = 0; index < TABLET_PAIRING_ADMISSION_LIMIT; index += 1) {
    const started = await startPairing(store, {
      now: NOW_MS + (index * 10),
      dependencies: { randomBytes: distinctRandom(index) }
    });
    assert.equal(started.response.status, 200, `request ${index + 1}`);
    assert.equal(started.responseBody.result, 'pending');
    pairingCodes.add(started.responseBody.pairingCode);
  }
  assert.equal(pairingCodes.size, TABLET_PAIRING_ADMISSION_LIMIT);
  assert.equal(
    [...store.values.keys()].filter(key => key.startsWith('pairing/request/v1/')).length,
    TABLET_PAIRING_ADMISSION_LIMIT
  );
  assert.equal(
    [...store.values.keys()].filter(key => key.startsWith('pairing/code/v1/')).length,
    TABLET_PAIRING_ADMISSION_LIMIT
  );
  assert.equal(store.values.get(TABLET_PAIRING_ADMISSION_KEY).value.count, 120);

  const requestKeysBefore = [...store.values.keys()]
    .filter(key => key.startsWith('pairing/request/v1/'))
    .sort();
  const codeKeysBefore = [...store.values.keys()]
    .filter(key => key.startsWith('pairing/code/v1/'))
    .sort();
  const setCallsBefore = store.calls.filter(([operation]) => operation === 'set').length;
  const rejected = await startPairing(store, {
    now: NOW_MS + 2_000,
    dependencies: { randomBytes: distinctRandom(120) }
  });
  assert.equal(rejected.response.status, 429);
  assert.deepEqual(rejected.responseBody, {
    ok: false,
    message: 'Too many tablet pairing requests. Try again shortly.'
  });
  assert.equal(rejected.pendingCookie, '');
  assert.deepEqual(
    [...store.values.keys()].filter(key => key.startsWith('pairing/request/v1/')).sort(),
    requestKeysBefore
  );
  assert.deepEqual(
    [...store.values.keys()].filter(key => key.startsWith('pairing/code/v1/')).sort(),
    codeKeysBefore
  );
  assert.equal(
    store.calls.filter(([operation]) => operation === 'set').length,
    setCallsBefore,
    'quota rejection must not attempt an admission, request, or index write'
  );

  const nextHour = await startPairing(store, {
    now: NOW_MS + (TABLET_PAIRING_ADMISSION_WINDOW_SECONDS * 1_000),
    dependencies: { randomBytes: distinctRandom(121) }
  });
  assert.equal(nextHour.response.status, 200);
  assert.equal(nextHour.responseBody.result, 'pending');
  assert.deepEqual(store.values.get(TABLET_PAIRING_ADMISSION_KEY).value, {
    v: 1,
    windowStart: NOW_SECONDS + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS,
    windowExpiresAt: NOW_SECONDS + (2 * TABLET_PAIRING_ADMISSION_WINDOW_SECONDS),
    count: 1
  });
});

test('concurrent admission CAS never exceeds the strong global 120-per-hour limit', async () => {
  const store = new StrongStore();
  for (let batch = 0; batch < 10; batch += 1) {
    const accepted = await Promise.all(Array.from(
      { length: 12 },
      () => reservePairingAdmission(store, NOW_MS)
    ));
    assert.deepEqual(accepted, Array(12).fill(true), `batch ${batch + 1}`);
  }
  assert.equal(store.values.get(TABLET_PAIRING_ADMISSION_KEY).value.count, 120);

  const rejected = await Promise.all(Array.from(
    { length: 12 },
    () => reservePairingAdmission(store, NOW_MS)
  ));
  assert.deepEqual(rejected, Array(12).fill(false));
  assert.equal(store.values.get(TABLET_PAIRING_ADMISSION_KEY).value.count, 120);
});

test('invalid, corrupt, and future admission state fails closed before any request or index write', async t => {
  const currentWindow = Math.floor(NOW_SECONDS / TABLET_PAIRING_ADMISSION_WINDOW_SECONDS)
    * TABLET_PAIRING_ADMISSION_WINDOW_SECONDS;
  const cases = [
    {
      name: 'invalid',
      configure(store) {
        store.values.set(TABLET_PAIRING_ADMISSION_KEY, {
          value: {
            v: 1,
            windowStart: currentWindow,
            windowExpiresAt: currentWindow + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS,
            count: 0
          },
          etag: 'invalid-admission'
        });
      }
    },
    {
      name: 'corrupt',
      configure(store) {
        store.values.set(TABLET_PAIRING_ADMISSION_KEY, {
          value: {
            v: 1,
            windowStart: currentWindow,
            windowExpiresAt: currentWindow + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS,
            count: 1
          },
          etag: 'corrupt-admission'
        });
        store.readFailures.add(TABLET_PAIRING_ADMISSION_KEY);
      }
    },
    {
      name: 'future',
      configure(store) {
        const futureWindow = currentWindow + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS;
        store.values.set(TABLET_PAIRING_ADMISSION_KEY, {
          value: {
            v: 1,
            windowStart: futureWindow,
            windowExpiresAt: futureWindow + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS,
            count: 1
          },
          etag: 'future-admission'
        });
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const store = new StrongStore();
      scenario.configure(store);
      const originalAdmission = structuredClone(store.values.get(TABLET_PAIRING_ADMISSION_KEY));
      const started = await startPairing(store, { fill: 0x6d });
      assert.equal(started.response.status, 503);
      assert.deepEqual(started.responseBody, {
        ok: false,
        message: 'Tablet pairing is temporarily unavailable.'
      });
      assert.deepEqual(store.values.get(TABLET_PAIRING_ADMISSION_KEY), originalAdmission);
      assert.equal(
        [...store.values.keys()].some(key => key.startsWith('pairing/request/v1/')),
        false
      );
      assert.equal(
        [...store.values.keys()].some(key => key.startsWith('pairing/code/v1/')),
        false
      );
      assert.equal(store.calls.some(([operation]) => operation === 'set'), false);
    });
  }
});

test('separate-device Admin review shows exact context, then approval delivers idempotently and consumes on confirmation poll', async () => {
  const store = new StrongStore();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Pairing must not call the business backend.');
  };
  try {
    const started = await startPairing(store, { fill: 0x32 });
    const { reviewed, approved } = await completeApproval(store, started, { fill: 0x42 });
    assert.deepEqual(reviewed.responseBody, {
      ok: true,
      result: 'pending',
      installationId: 'rev',
      gymName: 'Revolution BJJ',
      origin: PRODUCTION_ORIGIN,
      deviceLabel: 'Revolution BJJ front desk',
      requestedAt: new Date(NOW_SECONDS * 1_000).toISOString(),
      expiresAt: new Date((NOW_SECONDS + (12 * 60 * 60)) * 1_000).toISOString()
    });
    const reviewHeader = setCookies(reviewed.response)[0];
    assert.match(reviewHeader, /^__Host-gib_m1_tablet_pairing_review=/u);
    assert.match(reviewHeader, /; Secure/u);
    assert.match(reviewHeader, /; HttpOnly/u);
    assert.match(reviewHeader, /; SameSite=Strict/u);
    assert.match(reviewHeader, /; Max-Age=900/u);
    assert.equal(JSON.stringify(reviewed.responseBody).includes(started.pendingCookie), false);
    assert.deepEqual(approved.responseBody, {
      ok: true,
      result: 'approved',
      installationId: 'rev',
      gymName: 'Revolution BJJ',
      deviceLabel: 'Revolution BJJ front desk',
      approvedAt: new Date(NOW_SECONDS * 1_000).toISOString()
    });
    assert.equal(clearedCookie(approved.response, TABLET_PAIRING_REVIEW_COOKIE), false);
    assert.equal(setCookies(approved.response).some(value => value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)), false);

    const firstPoll = await pollPairing(store, started.pendingCookie);
    assert.equal(firstPoll.response.status, 200);
    assert.deepEqual(firstPoll.responseBody, {
      ok: true,
      result: 'approved',
      expiresAt: new Date((NOW_SECONDS + 43_200) * 1_000).toISOString(),
      deliveryExpiresAt: new Date((NOW_SECONDS + 43_320) * 1_000).toISOString()
    });
    const firstDevice = responseCookiePair(firstPoll.response, PRODUCTION_DEVICE_COOKIE);
    const deviceHeader = setCookies(firstPoll.response).find(value => (
      value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)
    ));
    assert.ok(deviceHeader);
    assert.match(deviceHeader, /; Path=\//u);
    assert.match(deviceHeader, /; Secure/u);
    assert.match(deviceHeader, /; HttpOnly/u);
    assert.match(deviceHeader, /; SameSite=Strict/u);
    assert.doesNotMatch(deviceHeader, /; Domain=/iu);
    assert.equal(clearedCookie(firstPoll.response, TABLET_PAIRING_PENDING_COOKIE), false);

    const lostResponseRetry = await pollPairing(store, started.pendingCookie, {
      now: NOW_MS + 1_000
    });
    assert.deepEqual(lostResponseRetry.responseBody, {
      ok: true,
      result: 'approved',
      expiresAt: new Date((NOW_SECONDS + 43_200) * 1_000).toISOString(),
      deliveryExpiresAt: new Date((NOW_SECONDS + 43_320) * 1_000).toISOString()
    });
    assert.equal(responseCookiePair(lostResponseRetry.response, PRODUCTION_DEVICE_COOKIE), firstDevice);

    const consumed = await pollPairing(store, started.pendingCookie, {
      now: NOW_MS + 2_000,
      deviceCookie: firstDevice
    });
    assert.deepEqual(consumed.responseBody, { ok: true, result: 'authorized' });
    assert.equal(clearedCookie(consumed.response, TABLET_PAIRING_PENDING_COOKIE), true);
    assert.equal(responseCookiePair(consumed.response, PRODUCTION_DEVICE_COOKIE), firstDevice);

    const lostAdminResponseRetry = await approvePairing(
      store,
      started.responseBody.pairingCode,
      reviewed.reviewCookie,
      { now: NOW_MS + 2_000 }
    );
    assert.equal(lostAdminResponseRetry.response.status, 200);
    assert.deepEqual(lostAdminResponseRetry.responseBody, approved.responseBody);
    assert.equal(
      clearedCookie(lostAdminResponseRetry.response, TABLET_PAIRING_REVIEW_COOKIE),
      false
    );

    const authorizedRetry = await pollPairing(store, started.pendingCookie, {
      now: NOW_MS + 3_000,
      deviceCookie: firstDevice
    });
    assert.deepEqual(authorizedRetry.responseBody, { ok: true, result: 'authorized' });
    assert.equal(clearedCookie(authorizedRetry.response, TABLET_PAIRING_PENDING_COOKIE), true);
    assert.equal(responseCookiePair(authorizedRetry.response, PRODUCTION_DEVICE_COOKIE), firstDevice);

    const status = await handleTabletStatus(request(TABLET_STATUS_PATH, {
      body: {},
      cookie: firstDevice
    }), { env: ENV, now: NOW_MS + 3_000 });
    assert.deepEqual(await body(status), { authorized: true });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fresh, reset, replacement, and simultaneous additional tablets keep independent pending requests', async () => {
  const store = new StrongStore();
  const [first, second] = await Promise.all([
    startPairing(store, { fill: 0x51 }),
    startPairing(store, { fill: 0x52 })
  ]);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.notEqual(first.responseBody.pairingCode, second.responseBody.pairingCode);
  assert.notEqual(first.pendingCookie, second.pendingCookie);
  assert.equal(store.values.size, 5);

  await completeApproval(store, first, { fill: 0x61 });
  await completeApproval(store, second, { fill: 0x62 });
  const firstPoll = await pollPairing(store, first.pendingCookie);
  const secondPoll = await pollPairing(store, second.pendingCookie);
  assert.notEqual(
    responseCookiePair(firstPoll.response, PRODUCTION_DEVICE_COOKIE),
    responseCookiePair(secondPoll.response, PRODUCTION_DEVICE_COOKIE)
  );
});

test('a factory-reset tablet with no cookies receives a distinct new credential without rotating the erased one', async () => {
  const store = new StrongStore();
  const first = await startPairing(store, { fill: 0x55 });
  await completeApproval(store, first, { fill: 0x65 });
  const firstDelivery = await pollPairing(store, first.pendingCookie);
  const erasedCredential = responseCookiePair(firstDelivery.response, PRODUCTION_DEVICE_COOKIE);
  const firstConsumed = await pollPairing(store, first.pendingCookie, {
    now: NOW_MS + 1_000,
    deviceCookie: erasedCredential
  });
  assert.deepEqual(firstConsumed.responseBody, { ok: true, result: 'authorized' });

  const reset = await startPairing(store, {
    now: NOW_MS + 10_000,
    fill: 0x56,
    cookie: ''
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.responseBody.result, 'pending');
  assert.notEqual(reset.responseBody.pairingCode, first.responseBody.pairingCode);
  await completeApproval(store, reset, {
    now: NOW_MS + 10_000,
    fill: 0x66
  });
  const resetDelivery = await pollPairing(store, reset.pendingCookie, {
    now: NOW_MS + 10_000
  });
  const resetCredential = responseCookiePair(resetDelivery.response, PRODUCTION_DEVICE_COOKIE);
  assert.notEqual(resetCredential, erasedCredential);
  const resetConsumed = await pollPairing(store, reset.pendingCookie, {
    now: NOW_MS + 11_000,
    deviceCookie: resetCredential
  });
  assert.deepEqual(resetConsumed.responseBody, { ok: true, result: 'authorized' });

  for (const credential of [erasedCredential, resetCredential]) {
    const status = await handleTabletStatus(request(TABLET_STATUS_PATH, {
      body: {},
      cookie: credential
    }), { env: ENV, now: NOW_MS + 12_000 });
    assert.deepEqual(await body(status), { authorized: true });
  }
});

test('Admin review and approval reject the exact pending tablet browser while allowing a separate Admin device', async () => {
  const store = new StrongStore();
  const tablet = await startPairing(store, { fill: 0x53 });
  const unrelatedTablet = await startPairing(store, { fill: 0x54 });
  const sameBrowserCookie = [adminCookie(), tablet.pendingCookie].join('; ');

  const sameBrowserReview = await reviewPairing(
    store,
    tablet.responseBody.pairingCode,
    { cookie: sameBrowserCookie }
  );
  assert.equal(sameBrowserReview.response.status, 403);
  assert.equal(clearedCookie(sameBrowserReview.response, TABLET_PAIRING_REVIEW_COOKIE), true);
  assert.equal(clearedCookie(sameBrowserReview.response, TABLET_PAIRING_PENDING_COOKIE), false);

  const separateBrowserCookie = [adminCookie(), unrelatedTablet.pendingCookie].join('; ');
  const separateReview = await reviewPairing(
    store,
    tablet.responseBody.pairingCode,
    { cookie: separateBrowserCookie }
  );
  assert.equal(separateReview.response.status, 200);

  const sameBrowserApprove = await approvePairing(
    store,
    tablet.responseBody.pairingCode,
    separateReview.reviewCookie,
    { cookie: sameBrowserCookie }
  );
  assert.equal(sameBrowserApprove.response.status, 403);
  assert.equal(clearedCookie(sameBrowserApprove.response, TABLET_PAIRING_REVIEW_COOKIE), true);
  assert.equal(clearedCookie(sameBrowserApprove.response, TABLET_PAIRING_PENDING_COOKIE), false);

  const separateApprove = await approvePairing(
    store,
    tablet.responseBody.pairingCode,
    separateReview.reviewCookie,
    { cookie: separateBrowserCookie }
  );
  assert.equal(separateApprove.response.status, 200);
});

test('a valid normal device cookie short-circuits start before any Blob access or credential rotation', async () => {
  const credential = createProductionDeviceCredential(
    DEVICE_TOKEN,
    fillRandom(0x66),
    NOW_MS
  );
  const store = {
    getWithMetadata() { throw new Error('Blob read must not occur.'); },
    set() { throw new Error('Blob write must not occur.'); }
  };
  const response = await handleTabletPairingStart(request(TABLET_PAIRING_START_PATH, {
    body: { operation: 'start' },
    cookie: [
      `${PRODUCTION_DEVICE_COOKIE}=${encodeURIComponent(credential)}`,
      `${TABLET_PAIRING_PENDING_COOKIE}=stale`
    ].join('; ')
  }), { env: ENV, now: NOW_MS, store });
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, result: 'authorized' });
  assert.equal(clearedCookie(response, TABLET_PAIRING_PENDING_COOKIE), true);
  assert.equal(
    setCookies(response).some(value => value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)),
    false
  );
});

test('Admin authentication, review possession, cross-tab binding, and single-use approval fail closed', async () => {
  const store = new StrongStore();
  const first = await startPairing(store, { fill: 0x71 });
  const second = await startPairing(store, { fill: 0x72 });
  const callsBefore = store.calls.length;

  const noAdmin = await reviewPairing(store, first.responseBody.pairingCode, { cookie: '' });
  assert.equal(noAdmin.response.status, 401);
  const wrongToken = await reviewPairing(store, first.responseBody.pairingCode, {
    requestToken: `${ADMIN_REQUEST_TOKEN}x`
  });
  assert.equal(wrongToken.response.status, 403);
  assert.equal(store.calls.length, callsBefore);

  const firstReview = await reviewPairing(store, first.responseBody.pairingCode);
  const secondReview = await reviewPairing(store, second.responseBody.pairingCode);
  const crossTab = await approvePairing(
    store,
    first.responseBody.pairingCode,
    secondReview.reviewCookie
  );
  assert.equal(crossTab.response.status, 403);

  const missingReview = await approvePairing(store, first.responseBody.pairingCode, '');
  assert.equal(missingReview.response.status, 403);
  const approved = await approvePairing(
    store,
    first.responseBody.pairingCode,
    firstReview.reviewCookie
  );
  assert.equal(approved.response.status, 200);
  const replay = await approvePairing(
    store,
    first.responseBody.pairingCode,
    firstReview.reviewCookie
  );
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.responseBody, approved.responseBody);
});

test('same-Admin concurrent approval retries converge on the same immutable approval', async () => {
  const store = new StrongStore();
  const started = await startPairing(store, { fill: 0x79 });
  const reviewed = await reviewPairing(store, started.responseBody.pairingCode);
  const approvals = await Promise.all([
    approvePairing(store, started.responseBody.pairingCode, reviewed.reviewCookie, {
      fill: 0x7a
    }),
    approvePairing(store, started.responseBody.pairingCode, reviewed.reviewCookie, {
      fill: 0x7b
    })
  ]);
  assert.deepEqual(approvals.map(value => value.response.status), [200, 200]);
  assert.deepEqual(approvals[0].responseBody, approvals[1].responseBody);

  const poll = await pollPairing(store, started.pendingCookie);
  const credential = responseCookiePair(poll.response, PRODUCTION_DEVICE_COOKIE);
  assert.equal(credential.includes(Buffer.alloc(32, 0x7a).toString('base64url'))
    || credential.includes(Buffer.alloc(32, 0x7b).toString('base64url')), true);
});

test('a lost Admin success response reads back after tablet consumption only for the reviewed Admin session', async () => {
  const store = new StrongStore();
  const started = await startPairing(store, { fill: 0x7d });
  const andrewReview = await reviewPairing(store, started.responseBody.pairingCode);
  const stuRequestToken = 'stuart_retry_token_0123456789abcdefghij';
  const stuCookie = adminCookie({
    adminName: 'Stuart Turner',
    requestToken: stuRequestToken
  });
  const stuReview = await reviewPairing(store, started.responseBody.pairingCode, {
    cookie: stuCookie,
    requestToken: stuRequestToken
  });
  const approved = await approvePairing(
    store,
    started.responseBody.pairingCode,
    andrewReview.reviewCookie,
    { fill: 0x7e }
  );
  assert.equal(approved.response.status, 200);

  const delivered = await pollPairing(store, started.pendingCookie);
  const credential = responseCookiePair(delivered.response, PRODUCTION_DEVICE_COOKIE);
  const consumed = await pollPairing(store, started.pendingCookie, {
    now: NOW_MS + 1_000,
    deviceCookie: credential
  });
  assert.equal(consumed.response.status, 200);
  assert.deepEqual(consumed.responseBody, { ok: true, result: 'authorized' });

  const sameSessionRetry = await approvePairing(
    store,
    started.responseBody.pairingCode,
    andrewReview.reviewCookie,
    { now: NOW_MS + 2_000 }
  );
  assert.equal(sameSessionRetry.response.status, 200);
  assert.deepEqual(sameSessionRetry.responseBody, approved.responseBody);

  const otherSessionRetry = await approvePairing(
    store,
    started.responseBody.pairingCode,
    stuReview.reviewCookie,
    {
      now: NOW_MS + 2_000,
      cookie: stuCookie,
      requestToken: stuRequestToken
    }
  );
  assert.equal(otherSessionRetry.response.status, 409);
});

test('consumed codes cannot be reviewed again or redelivered without the issued device, while exact Admin readback lasts 15 minutes', async () => {
  const store = new StrongStore();
  const started = await startPairing(store, { fill: 0x6a });
  const reviewed = await reviewPairing(store, started.responseBody.pairingCode);
  const approved = await approvePairing(
    store,
    started.responseBody.pairingCode,
    reviewed.reviewCookie,
    { fill: 0x6b }
  );
  assert.equal(approved.response.status, 200);

  const delivered = await pollPairing(store, started.pendingCookie);
  const credential = responseCookiePair(delivered.response, PRODUCTION_DEVICE_COOKIE);
  const consumed = await pollPairing(store, started.pendingCookie, {
    now: NOW_MS + 1_000,
    deviceCookie: credential
  });
  assert.deepEqual(consumed.responseBody, { ok: true, result: 'authorized' });

  const pendingOnly = await pollPairing(store, started.pendingCookie, {
    now: NOW_MS + 2_000
  });
  assert.notEqual(
    pendingOnly.response.status,
    200,
    JSON.stringify({
      status: pendingOnly.response.status,
      body: pendingOnly.responseBody,
      cookies: setCookies(pendingOnly.response)
    })
  );
  assert.equal(
    setCookies(pendingOnly.response).some(value => value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)),
    false
  );

  const rereview = await reviewPairing(store, started.responseBody.pairingCode, {
    now: NOW_MS + 2_000
  });
  assert.equal(rereview.response.status, 404);
  assert.equal(clearedCookie(rereview.response, TABLET_PAIRING_REVIEW_COOKIE), true);
  const noReviewedPossession = await approvePairing(
    store,
    started.responseBody.pairingCode,
    '',
    { now: NOW_MS + 2_000 }
  );
  assert.equal(noReviewedPossession.response.status, 403);

  for (const delaySeconds of [61, 899]) {
    const readback = await approvePairing(
      store,
      started.responseBody.pairingCode,
      reviewed.reviewCookie,
      { now: NOW_MS + (delaySeconds * 1_000) }
    );
    assert.equal(readback.response.status, 200, `${delaySeconds}-second readback`);
    assert.deepEqual(readback.responseBody, approved.responseBody);
  }
  const afterReviewDeadline = await approvePairing(
    store,
    started.responseBody.pairingCode,
    reviewed.reviewCookie,
    { now: NOW_MS + (900 * 1_000) }
  );
  assert.equal(afterReviewDeadline.response.status, 403);
  assert.equal(clearedCookie(afterReviewDeadline.response, TABLET_PAIRING_REVIEW_COOKIE), true);
});

test('concurrent Admin approvals have exactly one CAS winner and concurrent polls reissue one deterministic credential', async () => {
  const store = new StrongStore();
  const started = await startPairing(store, { fill: 0x73 });
  const andrewReview = await reviewPairing(store, started.responseBody.pairingCode);
  const stuCookie = adminCookie({
    adminName: 'Stuart Turner',
    requestToken: 'stuart_request_token_0123456789abcdefghij'
  });
  const stuReview = await reviewPairing(store, started.responseBody.pairingCode, {
    cookie: stuCookie,
    requestToken: 'stuart_request_token_0123456789abcdefghij'
  });
  const approvals = await Promise.all([
    approvePairing(store, started.responseBody.pairingCode, andrewReview.reviewCookie, {
      fill: 0x74
    }),
    approvePairing(store, started.responseBody.pairingCode, stuReview.reviewCookie, {
      fill: 0x75,
      cookie: stuCookie,
      requestToken: 'stuart_request_token_0123456789abcdefghij'
    })
  ]);
  assert.deepEqual(approvals.map(value => value.response.status).sort(), [200, 409]);

  const polls = await Promise.all([
    pollPairing(store, started.pendingCookie),
    pollPairing(store, started.pendingCookie)
  ]);
  assert.deepEqual(polls.map(value => value.response.status), [200, 200]);
  assert.equal(
    responseCookiePair(polls[0].response, PRODUCTION_DEVICE_COOKIE),
    responseCookiePair(polls[1].response, PRODUCTION_DEVICE_COOKIE)
  );
});

test('approval and delivery deadlines are absolute, distinct, and retain state until bounded cleanup', async () => {
  const pendingStore = new StrongStore();
  const pending = await startPairing(pendingStore, { fill: 0x76 });
  const expiredPoll = await pollPairing(pendingStore, pending.pendingCookie, {
    now: NOW_MS + (43_200 * 1_000)
  });
  assert.equal(expiredPoll.response.status, 410);
  assert.deepEqual(expiredPoll.responseBody, {
    ok: false,
    result: 'expired',
    message: 'Pairing code expired. Request a new code.'
  });
  assert.equal(clearedCookie(expiredPoll.response, TABLET_PAIRING_PENDING_COOKIE), true);
  assert.equal(pendingStore.values.size, 3);
  assert.equal(pendingStore.calls.some(([operation]) => operation === 'delete'), false);

  const lateStore = new StrongStore();
  const late = await startPairing(lateStore, { fill: 0x77 });
  const lateNow = NOW_MS + (43_199 * 1_000);
  const lateAdminCookie = adminCookie({ now: lateNow });
  const lateReview = await reviewPairing(lateStore, late.responseBody.pairingCode, {
    now: lateNow,
    cookie: lateAdminCookie
  });
  assert.equal(lateReview.response.status, 200);
  const lateApprove = await approvePairing(
    lateStore,
    late.responseBody.pairingCode,
    lateReview.reviewCookie,
    { now: lateNow, cookie: lateAdminCookie, fill: 0x78 }
  );
  assert.equal(lateApprove.response.status, 200);
  const justBeforeDeliveryExpiry = await pollPairing(lateStore, late.pendingCookie, {
    now: NOW_MS + (43_319 * 1_000)
  });
  assert.deepEqual(justBeforeDeliveryExpiry.responseBody, {
    ok: true,
    result: 'approved',
    expiresAt: new Date((NOW_SECONDS + 43_200) * 1_000).toISOString(),
    deliveryExpiresAt: new Date((NOW_SECONDS + 43_320) * 1_000).toISOString()
  });
  const atDeliveryExpiry = await pollPairing(lateStore, late.pendingCookie, {
    now: NOW_MS + (43_320 * 1_000)
  });
  assert.equal(atDeliveryExpiry.response.status, 410);
  assert.equal(lateStore.values.size, 3);
  assert.equal(lateStore.calls.some(([operation]) => operation === 'delete'), false);
});

test('an expiry poll cannot delete a concurrently approved request', async () => {
  const store = new StrongStore();
  const started = await startPairing(store, { fill: 0x68 });
  const nearDeadline = NOW_MS + (43_199 * 1_000);
  const nearDeadlineAdminCookie = adminCookie({ now: nearDeadline });
  const reviewed = await reviewPairing(store, started.responseBody.pairingCode, {
    now: nearDeadline,
    cookie: nearDeadlineAdminCookie
  });
  assert.equal(reviewed.response.status, 200);

  let releaseApproval;
  let signalApprovalWrite;
  const approvalWrite = new Promise(resolve => { signalApprovalWrite = resolve; });
  const approvalGate = new Promise(resolve => { releaseApproval = resolve; });
  const originalSet = store.set.bind(store);
  store.set = async (key, serialized, options) => {
    const value = JSON.parse(serialized);
    if (options?.onlyIfMatch && value.status === 'approved') {
      signalApprovalWrite();
      await approvalGate;
    }
    return originalSet(key, serialized, options);
  };

  const approving = approvePairing(
    store,
    started.responseBody.pairingCode,
    reviewed.reviewCookie,
    { now: nearDeadline, cookie: nearDeadlineAdminCookie, fill: 0x69 }
  );
  await approvalWrite;
  const expiredPoll = await pollPairing(store, started.pendingCookie, {
    now: NOW_MS + (43_200 * 1_000)
  });
  assert.equal(expiredPoll.response.status, 410);
  assert.equal(store.calls.some(([operation]) => operation === 'delete'), false);

  releaseApproval();
  const approved = await approving;
  assert.equal(approved.response.status, 200);
  const delivered = await pollPairing(store, started.pendingCookie, {
    now: NOW_MS + (43_201 * 1_000)
  });
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.responseBody.result, 'approved');
  assert.ok(responseCookiePair(delivered.response, PRODUCTION_DEVICE_COOKIE));
});

test('every pairing operation rejects wrong-origin and Richmond requests before Blob mutation', async () => {
  const store = new StrongStore();
  const wrongOrigin = 'https://deploy-preview-90--gib-live.netlify.app';
  const wrongOriginCandidates = [
    handleTabletPairingStart(request(TABLET_PAIRING_START_PATH, {
      origin: wrongOrigin,
      body: { operation: 'start' }
    }), { env: ENV, now: NOW_MS, store }),
    handleTabletPairingPoll(request(TABLET_PAIRING_POLL_PATH, {
      origin: wrongOrigin,
      body: { operation: 'poll' }
    }), { env: ENV, now: NOW_MS, store }),
    handleTabletPairingCancel(request(TABLET_PAIRING_CANCEL_PATH, {
      origin: wrongOrigin,
      body: { operation: 'cancel' }
    }), { env: ENV, now: NOW_MS, store }),
    handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
      origin: wrongOrigin,
      body: { operation: 'review', pairingCode: '01234-56789' }
    }), { env: ENV, now: NOW_MS, store }),
    handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
      origin: wrongOrigin,
      body: { operation: 'approve', pairingCode: '01234-56789' }
    }), { env: ENV, now: NOW_MS, store }),
    handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
      origin: wrongOrigin,
      body: { operation: 'reject', pairingCode: '01234-56789' }
    }), { env: ENV, now: NOW_MS, store })
  ];
  const wrongOriginResponses = await Promise.all(wrongOriginCandidates);
  assert.deepEqual(wrongOriginResponses.map(value => value.status), [404, 404, 404, 404, 404, 404]);
  assert.equal(store.calls.length, 0);

  const richmondOrigin = 'https://gib-richmond-live.netlify.app';
  const richmondDependencies = {
    env: ENV,
    now: NOW_MS,
    store,
    installationId: 'richmond',
    environment: 'production',
    activation: 'active'
  };
  const richmondCandidates = [
    handleTabletPairingStart(request(TABLET_PAIRING_START_PATH, {
      origin: richmondOrigin,
      body: { operation: 'start' }
    }), richmondDependencies),
    handleTabletPairingPoll(request(TABLET_PAIRING_POLL_PATH, {
      origin: richmondOrigin,
      body: { operation: 'poll' }
    }), richmondDependencies),
    handleTabletPairingCancel(request(TABLET_PAIRING_CANCEL_PATH, {
      origin: richmondOrigin,
      body: { operation: 'cancel' }
    }), richmondDependencies),
    handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
      origin: richmondOrigin,
      body: { operation: 'review', pairingCode: '01234-56789' }
    }), richmondDependencies),
    handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
      origin: richmondOrigin,
      body: { operation: 'approve', pairingCode: '01234-56789' }
    }), richmondDependencies),
    handleAdminTabletPairing(request(ADMIN_TABLET_PAIRING_PATH, {
      origin: richmondOrigin,
      body: { operation: 'reject', pairingCode: '01234-56789' }
    }), richmondDependencies)
  ];
  const richmondResponses = await Promise.all(richmondCandidates);
  assert.deepEqual(richmondResponses.map(value => value.status), [404, 404, 404, 404, 404, 404]);
  assert.equal(store.calls.length, 0);
});

test('wrong path, malformed body, and unauthenticated poll fail before Blob mutation', async () => {
  const store = new StrongStore();
  const candidates = [
    handleTabletPairingStart(request(TABLET_PAIRING_POLL_PATH, {
      body: { operation: 'start' }
    }), { env: ENV, now: NOW_MS, store }),
    handleTabletPairingStart(request(TABLET_PAIRING_START_PATH, {
      body: { operation: 'poll' }
    }), { env: ENV, now: NOW_MS, store }),
    handleTabletPairingPoll(request(TABLET_PAIRING_POLL_PATH, {
      body: { operation: 'poll', extra: true }
    }), { env: ENV, now: NOW_MS, store })
  ];
  const responses = await Promise.all(candidates);
  assert.deepEqual(responses.map(value => value.status), [404, 400, 400]);
  assert.equal(store.calls.length, 0);

  const noCookiePoll = await pollPairing(store, '');
  assert.equal(noCookiePoll.response.status, 401);
  assert.deepEqual(noCookiePoll.responseBody, {
    ok: false,
    result: 'authorization_required',
    message: 'This tablet needs authorization.'
  });
  assert.equal(store.calls.length, 0);
});

test('tablet poll rejects a mismatched code index before issuing any device credential', async () => {
  const store = new StrongStore();
  const started = await startPairing(store, { fill: 0x7c });
  const profile = staffClockPairingProfile();
  const codeKey = pairingCodeIndexKey(INSTALL_SECRET, profile, started.responseBody.pairingCode);
  const indexed = store.values.get(codeKey);
  indexed.value = {
    ...indexed.value,
    approvalExpiresAt: indexed.value.approvalExpiresAt + 1
  };

  const polled = await pollPairing(store, started.pendingCookie);
  assert.equal(polled.response.status, 403);
  assert.equal(clearedCookie(polled.response, TABLET_PAIRING_PENDING_COOKIE), true);
  assert.equal(
    setCookies(polled.response).some(value => value.startsWith(`${PRODUCTION_DEVICE_COOKIE}=`)),
    false
  );
});

test('legacy developer installer remains while generic same-device authorization is removed', () => {
  assert.equal(
    existsSync(new URL('netlify/functions/m1-admin-tablet-authorize.mjs', ROOT)),
    false
  );
  assert.doesNotMatch(installSource, /installAdminGrant|tablet_authorization/u);
  assert.match(installSource, /readProductionInstallCapability/u);
});

test('bucketed cleanup is bounded, order-independent, retry-safe, and retires exact linked pairs', async () => {
  const store = new StrongStore();
  const historicalSeconds = TABLET_PAIRING_GENESIS_SECONDS + 3_600;
  const historicalNow = historicalSeconds * 1_000;
  const cleanupSeconds = historicalSeconds + TABLET_PAIRING_PURGE_SECONDS + 7_200;
  const cleanupNow = cleanupSeconds * 1_000;
  for (let index = 0; index < PAIRING_CLEANUP_LIMIT_PER_PREFIX + 4; index += 1) {
    const started = await startPairing(store, {
      now: historicalNow,
      dependencies: {
        randomBytes(size) {
          const value = Buffer.alloc(size, 0x41);
          value.writeUInt32BE(index + 1, size - 4);
          return value;
        }
      }
    });
    assert.equal(started.response.status, 200);
  }
  const historicalProfile = Object.freeze({
    installationId: 'rev-legacy-installation',
    gymName: 'Legacy Revolution Gym',
    deviceLabel: 'Retired Revolution Staff Clock',
    origin: 'https://legacy-revolution.example',
    expiresInSeconds: 60
  });
  const drifted = await seedHistoricalPairingRecord(store, {
    profile: historicalProfile,
    requestedAt: historicalNow,
    fill: 0x5e
  });
  assert.notEqual(historicalProfile.installationId, staffClockPairingProfile().installationId);
  assert.notEqual(historicalProfile.gymName, staffClockPairingProfile().gymName);
  assert.notEqual(historicalProfile.deviceLabel, staffClockPairingProfile().deviceLabel);
  assert.notEqual(historicalProfile.origin, staffClockPairingProfile().origin);
  assert.notEqual(historicalProfile.expiresInSeconds, staffClockPairingProfile().expiresInSeconds);

  const fresh = await startPairing(store, { now: cleanupNow, fill: 0x7f });
  assert.equal(fresh.response.status, 200);
  store.values.set('unrelated/data', { value: { purgeAfter: 1 }, etag: 'unrelated' });

  const requestKeys = [...store.values.keys()]
    .filter(key => key.startsWith(PAIRING_CLEANUP_PREFIXES[0]));
  const targetBucket = Number(requestKeys[0].split('/').at(-2));
  const targetPrefix = `${PAIRING_CLEANUP_PREFIXES[0]}${String(targetBucket).padStart(12, '0')}/`;
  const targetKeys = requestKeys.filter(key => key.startsWith(targetPrefix));
  assert.equal(targetKeys.length, PAIRING_CLEANUP_LIMIT_PER_PREFIX + 5);
  await store.set(PAIRING_CLEANUP_CURSOR_KEY, JSON.stringify({
    v: 1,
    bucket: targetBucket
  }), { onlyIfNew: true });

  // Reverse the synthetic listing to prove cleanup does not depend on the
  // platform's ordering: every selected key is already in one closed bucket.
  const originalList = store.list.bind(store);
  store.list = options => {
    const listed = originalList(options);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const page of listed) {
          yield { blobs: [...page.blobs].reverse() };
        }
      }
    };
  };
  const failedKey = [...targetKeys].sort().reverse()[0];
  const failedCodeKey = pairingCodeIndexKeyFromHash(
    store.values.get(failedKey).value.codeHash
  );
  store.readFailures.add(failedKey);

  let active = 0;
  let maxActive = 0;
  const delayed = method => {
    const original = store[method].bind(store);
    store[method] = async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      try {
        return await original(...args);
      } finally {
        active -= 1;
      }
    };
  };
  delayed('getWithMetadata');
  delayed('delete');
  const callsBefore = store.calls.length;

  const response = await handleTabletPairingCleanup(new Request(PRODUCTION_ORIGIN), {
    store,
    now: cleanupNow
  });
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.ok, true);
  assert.equal(result.inspected, PAIRING_CLEANUP_LIMIT_PER_PREFIX);
  assert.equal(result.deleted, PAIRING_CLEANUP_LIMIT_PER_PREFIX - 1);
  assert.ok(store.calls.length - callsBefore <= 124);
  assert.ok(maxActive > 1);
  assert.ok(maxActive <= PAIRING_CLEANUP_CONCURRENCY);
  assert.deepEqual(store.pageReads, [targetPrefix, targetPrefix]);
  assert.equal(store.values.has('unrelated/data'), true);
  assert.equal(store.values.has(failedKey), true);
  assert.equal(store.values.has(failedCodeKey), true);
  assert.equal(store.values.get(PAIRING_CLEANUP_CURSOR_KEY).value.bucket, targetBucket);
  const freshCodeKey = pairingCodeIndexKey(
    INSTALL_SECRET,
    staffClockPairingProfile(),
    fresh.responseBody.pairingCode
  );
  assert.equal(store.values.has(freshCodeKey), true);

  store.readFailures.delete(failedKey);
  const retried = await handleTabletPairingCleanup(new Request(PRODUCTION_ORIGIN), {
    store,
    now: cleanupNow
  });
  assert.deepEqual(await body(retried), {
    ok: true,
    inspected: 6,
    deleted: 6
  });
  assert.equal(store.values.has(failedKey), false);
  assert.equal(store.values.has(failedCodeKey), false);
  assert.equal(
    store.values.get(PAIRING_CLEANUP_CURSOR_KEY).value.bucket,
    targetBucket + 3_600
  );
  assert.equal(
    [...store.values.keys()].some(key => key.startsWith(targetPrefix)),
    false
  );
  assert.equal(store.values.has(freshCodeKey), true);
  assert.equal(store.values.has(drifted.requestKey), false);
  assert.equal(store.values.has(drifted.codeKey), false);

  const richmondStore = {
    list() { throw new Error('Richmond cleanup must not open pairing storage.'); }
  };
  const richmond = await handleTabletPairingCleanup(new Request('https://example.invalid'), {
    store: richmondStore,
    now: NOW_MS,
    installationId: 'richmond',
    environment: 'production',
    activation: 'active'
  });
  assert.deepEqual(await body(richmond), { ok: true, inspected: 0, deleted: 0 });
});

test('a deleted cleanup cursor recreates at fixed genesis and cannot skip its oldest historical bucket', async () => {
  const store = new StrongStore();
  const profile = Object.freeze({
    installationId: 'historical-rev',
    gymName: 'Historical Revolution',
    deviceLabel: 'Historical front desk',
    origin: 'https://historical-revolution.example',
    expiresInSeconds: 120
  });
  const oldest = await seedHistoricalPairingRecord(store, {
    profile,
    requestedAt: TABLET_PAIRING_GENESIS_SECONDS * 1_000,
    fill: 0x2c
  });
  const genesisPurgeBucket = Math.floor(
    (TABLET_PAIRING_GENESIS_SECONDS + TABLET_PAIRING_PURGE_SECONDS) / 3_600
  ) * 3_600;
  await store.set(PAIRING_CLEANUP_CURSOR_KEY, JSON.stringify({
    v: 1,
    bucket: genesisPurgeBucket + (24 * 3_600)
  }), { onlyIfNew: true });
  await store.delete(PAIRING_CLEANUP_CURSOR_KEY);
  assert.equal(store.values.has(PAIRING_CLEANUP_CURSOR_KEY), false);

  const cursorWrites = [];
  const originalSet = store.set.bind(store);
  store.set = async (key, serialized, options) => {
    if (key === PAIRING_CLEANUP_CURSOR_KEY) {
      cursorWrites.push({ value: JSON.parse(serialized), options: { ...options } });
    }
    return originalSet(key, serialized, options);
  };
  const response = await handleTabletPairingCleanup(new Request(PRODUCTION_ORIGIN), {
    store,
    now: (
      TABLET_PAIRING_GENESIS_SECONDS
      + TABLET_PAIRING_PURGE_SECONDS
      + 7_200
    ) * 1_000
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, inspected: 1, deleted: 1 });
  assert.deepEqual(cursorWrites[0], {
    value: { v: 1, bucket: genesisPurgeBucket },
    options: { onlyIfNew: true }
  });
  assert.equal(store.values.has(oldest.requestKey), false);
  assert.equal(store.values.has(oldest.codeKey), false);
  assert.deepEqual(store.values.get(PAIRING_CLEANUP_CURSOR_KEY).value, {
    v: 1,
    bucket: genesisPurgeBucket + 3_600
  });
});
