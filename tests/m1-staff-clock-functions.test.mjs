import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  createAdminSession,
  runtimeConfig
} from '../netlify/functions/_lib/m1-common.mjs';
import {
  PRODUCTION_ORIGIN
} from '../netlify/functions/_lib/m1-production-runtime.mjs';
import {
  STAFF_PUNCH_ID_PATTERN,
  STAFF_REQUEST_ID_PATTERN,
  sanitizeStaffClockPunch,
  sanitizeStaffClockSnapshot,
  sanitizeStaffTimeCorrectionRequest,
  sanitizeStaffTimeReview,
  validNewYorkTimestamp
} from '../netlify/functions/_lib/m1-staff-clock-contracts.mjs';
import {
  STAFF_CLOCK_PATH,
  config as staffClockConfig,
  handleStaffClock
} from '../netlify/functions/m1-staff-clock.mjs';
import {
  ADMIN_STAFF_TIME_BUILD,
  ADMIN_STAFF_TIME_DEVICE,
  ADMIN_STAFF_TIME_PATH,
  ADMIN_STAFF_TIME_SITE,
  config as adminStaffTimeConfig,
  handleAdminStaffTime
} from '../netlify/functions/m1-admin-staff-time.mjs';

const NOW = new Date('2026-08-18T21:00:00.000Z');
const NOW_MS = NOW.getTime();
const PREVIEW_ORIGIN = 'https://deploy-preview-57--gib-live.netlify.app';
const IMMUTABLE_ORIGIN = 'https://1234567890abcdef12345678--gib-live.netlify.app';
const TEST_WEBHOOK_URL = 'https://script.google.com/macros/s/SYNTHETIC_STAFF_TEST_RECEIVER_123/exec';
const PRODUCTION_WEBHOOK_URL = 'https://script.google.com/macros/s/SYNTHETIC_STAFF_PRODUCTION_RECEIVER_456/exec';
const TEST_WEBHOOK_TOKEN = 'staff-test-transport-token-0123456789abcdef';
const TEST_ADMIN_TOKEN = 'staff-test-admin-token-fedcba9876543210';
const PRODUCTION_WEBHOOK_TOKEN = 'staff-production-transport-token-0123456789';
const PRODUCTION_ADMIN_TOKEN = 'staff-production-admin-token-9876543210abcdef';
const PRODUCTION_DEVICE_TOKEN = 'staff-production-device-token-abcdef012345';
const PRODUCTION_PASSPHRASE = 'correct horse private gym battery staple';
const ADMIN_REQUEST_TOKEN = 'A'.repeat(43);
const PUNCH_ID = 'gib-m1-staff-12345678-1234-4123-8123-123456789abc';
const SECOND_PUNCH_ID = 'gib-m1-staff-abcdef12-3456-4789-8abc-def012345678';
const REQUEST_ID = 'gib-m1-staff-request-87654321-4321-4321-8321-cba987654321';
const STAFF_CLOCK_CLIENT_SOURCE = readFileSync(
  new URL('../m1/staff-clock-client.mjs', import.meta.url),
  'utf8'
);

const ENV = Object.freeze({
  GIB_TEST_WEBHOOK_URL: TEST_WEBHOOK_URL,
  GIB_TEST_WEBHOOK_TOKEN: TEST_WEBHOOK_TOKEN,
  GIB_TEST_ADMIN_ACTION_TOKEN: TEST_ADMIN_TOKEN,
  GIB_M1_PRODUCTION_SYNC_ENABLED: 'true',
  GIB_M1_PRODUCTION_ORIGIN: PRODUCTION_ORIGIN,
  GIB_M1_PRODUCTION_WEBHOOK_URL: PRODUCTION_WEBHOOK_URL,
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: PRODUCTION_WEBHOOK_TOKEN,
  GIB_M1_ADMIN_ACTION_TOKEN: PRODUCTION_ADMIN_TOKEN,
  GIB_M1_ADMIN_PASSPHRASE: PRODUCTION_PASSPHRASE,
  GIB_M1_PRODUCTION_DEVICE_TOKEN: PRODUCTION_DEVICE_TOKEN
});

function punch(overrides = {}) {
  return {
    punchId: PUNCH_ID,
    timestamp: '2026-08-18T16:30:00-04:00',
    date: '2026-08-18',
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: 'clockIn',
    site: 'Rev',
    device: 'Staff Clock tablet',
    build: 'm1b-staff-clock',
    note: '',
    ...overrides
  };
}

function record(overrides = {}) {
  return {
    ...punch(),
    status: 'ACTIVE',
    source: 'Tablet',
    adminName: '',
    linkedPunchId: '',
    ...overrides
  };
}

function extractedClientFunction(name) {
  const start = STAFF_CLOCK_CLIENT_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the Staff Clock client`);
  const openingBrace = STAFF_CLOCK_CLIENT_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = openingBrace; index < STAFF_CLOCK_CLIENT_SOURCE.length; index += 1) {
    if (STAFF_CLOCK_CLIENT_SOURCE[index] === '{') depth += 1;
    if (STAFF_CLOCK_CLIENT_SOURCE[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) {
      const source = STAFF_CLOCK_CLIENT_SOURCE.slice(start, index + 1);
      return Function(`"use strict"; ${source}; return ${name};`)();
    }
  }
  assert.fail(`${name} source was incomplete`);
}

const staffClockSyncPunch = extractedClientFunction('staffClockSyncPunch');

function publicRecord(overrides = {}) {
  const value = record(overrides);
  if (!value.adminName) delete value.adminName;
  if (!value.linkedPunchId) delete value.linkedPunchId;
  return value;
}

function staffClockRequest({
  origin = PREVIEW_ORIGIN,
  requestOrigin = origin,
  host = new URL(origin).host,
  fetchSite = 'same-origin',
  path = STAFF_CLOCK_PATH,
  body = { operation: 'snapshot' },
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

function adminRequest({
  origin = PREVIEW_ORIGIN,
  requestOrigin = origin,
  host = new URL(origin).host,
  fetchSite = 'same-origin',
  path = ADMIN_STAFF_TIME_PATH,
  body = { operation: 'review' },
  adminName = 'Andrew Smith',
  env = ENV,
  requestToken = ADMIN_REQUEST_TOKEN,
  headerToken = requestToken,
  includeAuth = true
} = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Host: host,
    Origin: requestOrigin,
    'Sec-Fetch-Site': fetchSite
  };
  if (includeAuth) {
    const runtime = runtimeConfig(env, { admin: true, requestUrl: `${origin}${path}` });
    assert.ok(runtime, 'test setup requires valid Admin runtime');
    const session = createAdminSession(adminName, runtime.sessionSecret, NOW_MS, requestToken);
    headers.Cookie = `${ADMIN_COOKIE}=${encodeURIComponent(session)}`;
    headers[ADMIN_REQUEST_HEADER] = headerToken;
  }
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

function googleResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

function snapshot(target = 'test', overrides = {}) {
  return {
    ok: true,
    target,
    staff: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }],
    records: [record()],
    ...overrides
  };
}

function period(startDate, endDate, overrides = {}) {
  return {
    startDate,
    endDate,
    totals: [{
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      completedShifts: 0,
      totalSeconds: 0,
      needsAttention: false
    }],
    ...overrides
  };
}

function reviewPayload(target = 'test', overrides = {}) {
  return {
    ...snapshot(target),
    audit: [],
    clockedInNow: [{
      punchId: PUNCH_ID,
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      clockInAt: '2026-08-18T16:30:00-04:00'
    }],
    todayPunches: [{
      punchId: PUNCH_ID,
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      punchAction: 'clockIn',
      timestamp: '2026-08-18T16:30:00-04:00',
      source: 'Tablet',
      status: 'ACTIVE'
    }],
    needsAttention: [],
    periods: {
      current: period('2026-08-10', '2026-08-23'),
      previous: period('2026-07-27', '2026-08-09')
    },
    ...overrides
  };
}

test('Staff Clock contract uses separate permanent IDs and exact New York timestamps', () => {
  assert.match(PUNCH_ID, STAFF_PUNCH_ID_PATTERN);
  assert.match(REQUEST_ID, STAFF_REQUEST_ID_PATTERN);
  assert.equal(validNewYorkTimestamp('2026-08-18T16:30:00-04:00', '2026-08-18', NOW), true);
  assert.equal(validNewYorkTimestamp('2026-01-18T16:30:00-05:00', '2026-01-18', NOW), true);
  assert.equal(validNewYorkTimestamp('2026-08-18T16:30:00-05:00', '2026-08-18', NOW), false);
  assert.equal(validNewYorkTimestamp('2026-08-18T20:30:00Z', '2026-08-18', NOW), false);
  assert.ok(sanitizeStaffClockPunch(punch(), { requireTestName: true, now: NOW }));
  assert.equal(sanitizeStaffClockPunch(punch({ staffName: 'Mandy' }), {
    requireTestName: true,
    now: NOW
  }), null);
  assert.equal(sanitizeStaffClockPunch(punch({ extra: true }), {
    requireTestName: true,
    now: NOW
  }), null);
  assert.equal(sanitizeStaffClockPunch(punch({ punchAction: 'in' }), {
    requireTestName: true,
    now: NOW
  }), null);
  assert.deepEqual(
    sanitizeStaffClockPunch(punch(), { requireTestName: true, now: NOW }),
    punch()
  );
  assert.equal(sanitizeStaffClockPunch(record(), { requireTestName: true, now: NOW }), null);
});

test('snapshot contract rejects inactive flags, unsafe record labels, and semantic aliases', () => {
  assert.ok(sanitizeStaffClockSnapshot(snapshot(), 'test', { now: NOW }));
  assert.equal(sanitizeStaffClockSnapshot(snapshot('test', {
    staff: [{ staffId: 'mandy-test', staffName: 'Mandy Test', active: true }]
  }), 'test', { now: NOW }), null);
  assert.equal(sanitizeStaffClockSnapshot(snapshot('test', {
    records: [record({ status: 'active' })]
  }), 'test', { now: NOW }), null);
  assert.equal(sanitizeStaffClockSnapshot(snapshot('test', {
    records: [record({ source: 'Admin', adminName: 'Andrew Smith' })]
  }), 'test', { now: NOW }), null);
  assert.equal(sanitizeStaffClockSnapshot(snapshot('test', {
    records: [record({ staffName: 'Mandy' })]
  }), 'test', { now: NOW }), null);
});

test('tablet route is exact, rate-limited, same-origin, and pins TEST transport', async () => {
  assert.equal(staffClockConfig.path, STAFF_CLOCK_PATH);
  assert.ok(staffClockConfig.rateLimit.windowLimit <= 60);
  for (const candidate of [
    staffClockRequest({ requestOrigin: 'https://evil.example' }),
    staffClockRequest({ fetchSite: 'cross-site' }),
    staffClockRequest({ path: `${STAFF_CLOCK_PATH}?target=production` }),
    staffClockRequest({ origin: 'https://example.netlify.app' })
  ]) {
    let called = false;
    const response = await handleStaffClock(candidate, {
      env: ENV,
      fetch: async () => { called = true; return googleResponse(snapshot()); },
      dateNow: NOW
    });
    assert.equal(response.status, 403);
    assert.equal(called, false);
  }

  for (const origin of [PREVIEW_ORIGIN, IMMUTABLE_ORIGIN]) {
    let call;
    const response = await handleStaffClock(staffClockRequest({ origin }), {
      env: ENV,
      fetch: async (url, options) => {
        call = { url, options, body: JSON.parse(options.body) };
        return googleResponse(snapshot());
      },
      dateNow: NOW
    });
    assert.equal(response.status, 200);
    assert.equal(call.url, TEST_WEBHOOK_URL);
    assert.deepEqual(call.body, {
      token: TEST_WEBHOOK_TOKEN,
      action: 'staffClockSnapshot',
      target: 'test',
      adminActionToken: ''
    });
    assert.deepEqual(await responseBody(response), {
      ok: true,
      target: 'test',
      staff: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }],
      records: [publicRecord()]
    });
  }
});

test('tablet sync saves only the exact frontend wire projection and accepts complete ID-bound acknowledgments', async () => {
  assert.match(
    STAFF_CLOCK_CLIENT_SOURCE,
    /punches:\s*batch\.map\(staffClockSyncPunch\)/u
  );
  const valid = staffClockSyncPunch(record());
  const invalid = staffClockSyncPunch(record({
    punchId: SECOND_PUNCH_ID,
    staffName: 'Mandy'
  }));
  let upstream;
  const response = await handleStaffClock(staffClockRequest({
    body: { operation: 'sync', punches: [valid, invalid] }
  }), {
    env: ENV,
    fetch: async (_url, options) => {
      upstream = JSON.parse(options.body);
      return googleResponse({
        ok: true,
        target: 'test',
        results: [{ punchId: PUNCH_ID, result: 'added', linkedPunchId: PUNCH_ID }]
      });
    },
    dateNow: NOW
  });
  assert.equal(response.status, 200);
  assert.deepEqual(upstream.punches, [valid]);
  assert.equal(upstream.action, 'staffClockPunch');
  assert.equal(upstream.target, 'test');
  assert.equal(upstream.token, TEST_WEBHOOK_TOKEN);
  assert.deepEqual((await responseBody(response)).results, [
    { punchId: PUNCH_ID, result: 'added', linkedPunchId: PUNCH_ID },
    { punchId: SECOND_PUNCH_ID, result: 'rejected', linkedPunchId: '' }
  ]);

  for (const badGoogle of [
    { ok: true, target: 'production', results: [{ punchId: PUNCH_ID, result: 'added', linkedPunchId: PUNCH_ID }] },
    { ok: true, target: 'test', results: [] },
    { ok: true, target: 'test', results: [{ punchId: SECOND_PUNCH_ID, result: 'added', linkedPunchId: SECOND_PUNCH_ID }] },
    { ok: true, target: 'test', results: [{ punchId: PUNCH_ID, result: 'added', linkedPunchId: '' }] },
    { ok: true, target: 'test', results: [{ punchId: PUNCH_ID, result: 'already_exists', linkedPunchId: PUNCH_ID }] }
  ]) {
    const failed = await handleStaffClock(staffClockRequest({
      body: { operation: 'sync', punches: [valid] }
    }), {
      env: ENV,
      fetch: async () => googleResponse(badGoogle),
      dateNow: NOW
    });
    assert.equal(failed.status, 502);
  }
});

test('tablet input rejects duplicates and browser attempts to choose backend scope', async () => {
  for (const body of [
    { operation: 'sync', punches: [punch(), punch()] },
    { operation: 'snapshot', target: 'production' },
    { operation: 'sync', punches: [punch()], token: PRODUCTION_WEBHOOK_TOKEN },
    { operation: 'sync', punches: [punch()], action: 'kioskSignIn' }
  ]) {
    let called = false;
    const response = await handleStaffClock(staffClockRequest({ body }), {
      env: ENV,
      fetch: async () => { called = true; return googleResponse(snapshot()); },
      dateNow: NOW
    });
    assert.equal(response.status, 400);
    assert.equal(called, false);
  }
});

test('Staff Clock endpoints enforce bounded rates, batches, and JSON bodies before Google', async () => {
  assert.ok(adminStaffTimeConfig.rateLimit.windowLimit <= 30);
  const oversizedBatch = Array.from({ length: 51 }, (_value, index) => punch({
    punchId: `gib-m1-staff-${String(index).padStart(8, '0')}-1234-4123-8123-123456789abc`
  }));
  let called = false;
  const batchResponse = await handleStaffClock(staffClockRequest({
    body: { operation: 'sync', punches: oversizedBatch }
  }), {
    env: ENV,
    fetch: async () => { called = true; throw new Error('should not call'); },
    dateNow: NOW
  });
  assert.equal(batchResponse.status, 400);
  assert.equal(called, false);

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': '128001',
    Host: new URL(PREVIEW_ORIGIN).host,
    Origin: PREVIEW_ORIGIN,
    'Sec-Fetch-Site': 'same-origin'
  };
  const declaredOversize = new Request(`${PREVIEW_ORIGIN}${STAFF_CLOCK_PATH}`, {
    method: 'POST',
    headers,
    body: '{}'
  });
  const bodyResponse = await handleStaffClock(declaredOversize, {
    env: ENV,
    fetch: async () => { called = true; throw new Error('should not call'); }
  });
  assert.equal(bodyResponse.status, 400);
  assert.equal(called, false);
});

test('canonical production tablet path is hard-disabled before runtime, authorization, or Google', async () => {
  let called = false;
  const response = await handleStaffClock(staffClockRequest({
    origin: PRODUCTION_ORIGIN,
    cookie: '',
    body: { operation: 'snapshot' }
  }), {
    env: ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async () => { called = true; throw new Error('production must not call Google'); }
  });
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test('Admin review requires the existing cookie plus request token and returns a strict computed view', async () => {
  for (const request of [
    adminRequest({ includeAuth: false }),
    adminRequest({ headerToken: 'B'.repeat(43) })
  ]) {
    const response = await handleAdminStaffTime(request, {
      env: ENV,
      now: NOW_MS,
      dateNow: NOW,
      fetch: async () => googleResponse(reviewPayload())
    });
    assert.ok(response.status === 401 || response.status === 403);
  }

  let upstream;
  const response = await handleAdminStaffTime(adminRequest(), {
    env: ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async (url, options) => {
      upstream = { url, body: JSON.parse(options.body) };
      return googleResponse(reviewPayload());
    }
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.url, TEST_WEBHOOK_URL);
  assert.deepEqual(upstream.body, {
    token: TEST_WEBHOOK_TOKEN,
    action: 'staffTimeReview',
    target: 'test',
    adminActionToken: TEST_ADMIN_TOKEN
  });
  const data = await responseBody(response);
  assert.equal(data.adminName, 'Andrew Smith');
  assert.equal(data.test, true);
  assert.deepEqual(data.staff, reviewPayload().staff);
  assert.deepEqual(data.records, [publicRecord()]);
  assert.deepEqual(data.periods, reviewPayload().periods);
});

test('Admin review contract fails closed on semantic drift in computed arrays and periods', () => {
  assert.ok(sanitizeStaffTimeReview(reviewPayload(), 'test', { now: NOW }));
  assert.equal(sanitizeStaffTimeReview(reviewPayload('test', {
    clockedInNow: [{
      punchId: PUNCH_ID,
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      clockInAt: '2026-08-18T15:30:00-04:00'
    }]
  }), 'test', { now: NOW }), null);
  assert.equal(sanitizeStaffTimeReview(reviewPayload('test', {
    periods: {
      current: period('2026-08-10', '2026-08-22'),
      previous: period('2026-07-27', '2026-08-09')
    }
  }), 'test', { now: NOW }), null);
  assert.equal(sanitizeStaffTimeReview(reviewPayload('test', {
    todayPunches: [{ ...reviewPayload().todayPunches[0], source: 'Admin-added' }]
  }), 'test', { now: NOW }), null);
});

test('Admin correction pins attribution and replay identity, then validates the full confirmation', async () => {
  const input = {
    operation: 'correct',
    requestId: REQUEST_ID,
    punchId: SECOND_PUNCH_ID,
    staffId: 'front-desk-test-two',
    staffName: 'Front Desk Test Two',
    punchAction: 'clockOut',
    timestamp: '2026-08-18T16:45:00-04:00',
    date: '2026-08-18',
    reason: 'Missed clock out'
  };
  assert.ok(sanitizeStaffTimeCorrectionRequest(input, { requireTestName: true, now: NOW }));
  let upstream;
  const response = await handleAdminStaffTime(adminRequest({ body: input }), {
    env: ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async (_url, options) => {
      upstream = JSON.parse(options.body);
      return googleResponse({
        ok: true,
        target: 'test',
        requestId: REQUEST_ID,
        result: 'added',
        linkedPunchId: SECOND_PUNCH_ID,
        auditActionNumber: 7,
        confirmation: {
          adminName: 'Andrew Smith',
          punchId: SECOND_PUNCH_ID,
          staffId: input.staffId,
          staffName: input.staffName,
          timestamp: input.timestamp,
          date: input.date,
          punchAction: input.punchAction,
          reason: input.reason,
          site: ADMIN_STAFF_TIME_SITE,
          device: ADMIN_STAFF_TIME_DEVICE,
          build: ADMIN_STAFF_TIME_BUILD
        }
      });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.adminName, 'Andrew Smith');
  assert.equal(upstream.site, ADMIN_STAFF_TIME_SITE);
  assert.equal(upstream.device, ADMIN_STAFF_TIME_DEVICE);
  assert.equal(upstream.build, ADMIN_STAFF_TIME_BUILD);
  assert.equal(upstream.action, 'staffTimeCorrect');
  assert.equal(upstream.target, 'test');
  assert.equal(upstream.adminActionToken, TEST_ADMIN_TOKEN);
  const data = await responseBody(response);
  assert.equal(data.requestId, REQUEST_ID);
  assert.equal(data.linkedPunchId, SECOND_PUNCH_ID);
  assert.equal(data.confirmation.punchId, SECOND_PUNCH_ID);
  assert.equal(JSON.stringify(data).includes(TEST_ADMIN_TOKEN), false);
  assert.equal(JSON.stringify(data).includes(TEST_WEBHOOK_TOKEN), false);
});

test('Admin correction rejects real TEST names, extras, future times, and partial confirmations', async () => {
  const base = {
    operation: 'correct',
    requestId: REQUEST_ID,
    punchId: SECOND_PUNCH_ID,
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: 'clockIn',
    timestamp: '2026-08-18T16:30:00-04:00',
    date: '2026-08-18',
    reason: 'Forgotten punch'
  };
  for (const candidate of [
    { ...base, staffName: 'Mandy' },
    { ...base, extra: true },
    { ...base, timestamp: '2026-08-18T18:30:00-04:00' },
    { ...base, requestId: PUNCH_ID }
  ]) {
    let called = false;
    const response = await handleAdminStaffTime(adminRequest({ body: candidate }), {
      env: ENV,
      now: NOW_MS,
      dateNow: NOW,
      fetch: async () => { called = true; throw new Error('should not call'); }
    });
    assert.equal(response.status, 400);
    assert.equal(called, false);
  }

  const failed = await handleAdminStaffTime(adminRequest({ body: base }), {
    env: ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async () => googleResponse({
      ok: true,
      target: 'test',
      requestId: REQUEST_ID,
      result: 'added',
      linkedPunchId: SECOND_PUNCH_ID,
      auditActionNumber: 1,
      confirmation: { adminName: 'Andrew Smith' }
    })
  });
  assert.equal(failed.status, 502);
});

test('Admin void uses a separate permanent request, preserves linked punch identity, and confirms VOID', async () => {
  const input = {
    operation: 'void',
    requestId: REQUEST_ID,
    punchId: PUNCH_ID,
    reason: 'Wrong punch selected'
  };
  let upstream;
  const response = await handleAdminStaffTime(adminRequest({
    body: input,
    adminName: 'Stuart Turner'
  }), {
    env: ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async (_url, options) => {
      upstream = JSON.parse(options.body);
      return googleResponse({
        ok: true,
        target: 'test',
        requestId: REQUEST_ID,
        result: 'voided',
        linkedPunchId: PUNCH_ID,
        auditActionNumber: 8,
        confirmation: {
          adminName: 'Stuart Turner',
          punchId: PUNCH_ID,
          staffId: 'mandy-test',
          staffName: 'Mandy Test',
          timestamp: '2026-08-18T16:30:00-04:00',
          date: '2026-08-18',
          punchAction: 'clockIn',
          reason: input.reason,
          status: 'VOID'
        }
      });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.action, 'staffTimeVoid');
  assert.deepEqual({
    requestId: upstream.requestId,
    punchId: upstream.punchId,
    reason: upstream.reason,
    adminName: upstream.adminName
  }, {
    requestId: input.requestId,
    punchId: input.punchId,
    reason: input.reason,
    adminName: 'Stuart Turner'
  });
  const data = await responseBody(response);
  assert.equal(data.adminName, 'Stuart Turner');
  assert.equal(data.result, 'voided');
  assert.equal(data.confirmation.status, 'VOID');
});

test('canonical production Admin path is hard-disabled before auth, runtime, or Google', async () => {
  let called = false;
  const response = await handleAdminStaffTime(adminRequest({
    origin: PRODUCTION_ORIGIN,
    body: { operation: 'review' },
    includeAuth: false
  }), {
    env: ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async () => { called = true; throw new Error('production must not call Google'); }
  });
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test('Staff Clock browser responses never reflect configured or upstream secrets', async () => {
  const upstreamCanary = 'UPSTREAM_PRIVATE_STAFF_CANARY_93f1';
  const responses = [
    await handleStaffClock(staffClockRequest(), {
      env: ENV,
      dateNow: NOW,
      fetch: async () => googleResponse({
        ok: false,
        target: 'test',
        message: `${upstreamCanary}:${TEST_WEBHOOK_TOKEN}`
      })
    }),
    await handleAdminStaffTime(adminRequest(), {
      env: ENV,
      now: NOW_MS,
      dateNow: NOW,
      fetch: async () => googleResponse({
        ok: false,
        target: 'test',
        message: `${upstreamCanary}:${TEST_ADMIN_TOKEN}`
      })
    })
  ];
  const forbidden = [
    upstreamCanary,
    TEST_WEBHOOK_TOKEN,
    TEST_ADMIN_TOKEN,
    PRODUCTION_WEBHOOK_TOKEN,
    PRODUCTION_ADMIN_TOKEN,
    PRODUCTION_DEVICE_TOKEN,
    PRODUCTION_PASSPHRASE
  ];
  for (const response of responses) {
    assert.equal(response.status, 502);
    const text = await response.text();
    forbidden.forEach(secret => assert.equal(text.includes(secret), false));
  }
});
