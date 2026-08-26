import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  sanitizeAdminAdditionPayload,
  sanitizeAuditRecord,
  sanitizeDailyReviewPayload,
  sanitizeInstructorSigninVoidRequest,
  sanitizeInstructorSigninVoidResult
} from '../netlify/functions/_lib/m1-admin-contracts.mjs';
import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  createAdminSession
} from '../netlify/functions/_lib/m1-common.mjs';
import {
  ADMIN_VOID_PATH,
  config as voidConfig,
  handleAdminVoid
} from '../netlify/functions/m1-admin-void.mjs';

const ROOT = new URL('../', import.meta.url);
const voidSource = readFileSync(new URL('netlify/functions/m1-admin-void.mjs', ROOT), 'utf8');
const ORIGIN = 'https://gib-richmond-live.netlify.app';
const ADMIN_NAME = 'Andrew Smith';
const ROW_ID = 'gib-m1-12345678-1234-4123-8123-123456789abc';
const REQUEST_ID = `gib-m1-admin-void-${ROW_ID}`;
const REQUEST_TOKEN = 'admin-request-token-1234567890-abcdefghi';
const REASON = 'Installation check verified and voided';
const NOW_MS = Date.parse('2026-08-26T15:00:00Z');

const ACTIVE_ENV = Object.freeze({
  GIB_M1_INSTALLATION: 'richmond',
  GIB_M1_ENVIRONMENT: 'production',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL:
    'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_PRODUCTION_RECEIVER_123456/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN:
    'richmond-production-webhook-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN:
    'richmond-production-admin-action-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'cedar orbit copper meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN:
    'richmond-production-device-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active',
  GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true'
});

const ACTIVE_DEPENDENCIES = Object.freeze({
  installationId: 'richmond',
  environment: 'production',
  activation: 'active',
  env: ACTIVE_ENV,
  now: NOW_MS
});

function requestBody(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    rowId: ROW_ID,
    adminName: ADMIN_NAME,
    reason: REASON,
    ...overrides
  };
}

function confirmation(overrides = {}) {
  return {
    adminName: ADMIN_NAME,
    rowId: ROW_ID,
    timestamp: '2026-08-26 06:59:00',
    date: '2026-08-26',
    classLabel: '6:00 AM–7:00 AM Muay Thai Fundamentals',
    duration: 1,
    instructor: 'Andrew Smith',
    site: 'Richmond',
    device: 'Richmond Front Desk Tablet',
    build: '2026-08-22 RICHMOND M1 PRODUCTION',
    notes: 'Install check only',
    status: 'VOID',
    reason: REASON,
    ...overrides
  };
}

function googleResult(overrides = {}) {
  return {
    ok: true,
    result: 'voided',
    requestId: REQUEST_ID,
    linkedRecordId: ROW_ID,
    auditActionNumber: 1,
    confirmation: confirmation(),
    ...overrides
  };
}

function sessionCookie(adminName = ADMIN_NAME) {
  const session = createAdminSession(
    adminName,
    ACTIVE_ENV.GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE,
    NOW_MS,
    REQUEST_TOKEN
  );
  return `${ADMIN_COOKIE}=${encodeURIComponent(session)}`;
}

function request(options = {}) {
  const origin = options.origin || ORIGIN;
  const url = options.url || `${origin}${ADMIN_VOID_PATH}`;
  const headers = {
    Host: options.host || new URL(url).host,
    Origin: origin,
    'Sec-Fetch-Site': options.fetchSite || 'same-origin',
    ...(options.includeJson === false ? {} : { 'Content-Type': 'application/json' }),
    ...(options.auth === false ? {} : {
      Cookie: options.cookie || sessionCookie(),
      [ADMIN_REQUEST_HEADER]: options.requestToken || REQUEST_TOKEN
    })
  };
  const body = options.body === undefined ? requestBody() : options.body;
  return new Request(url, {
    method: options.method || 'POST',
    headers,
    body: (options.method || 'POST') === 'GET'
      ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body)
  });
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

test('dedicated Richmond void route is literal, POST-only, and tightly rate-limited', async () => {
  assert.equal(ADMIN_VOID_PATH, '/.netlify/functions/m1-admin-void');
  assert.deepEqual(voidConfig, {
    path: '/.netlify/functions/m1-admin-void',
    rateLimit: {
      windowLimit: 10,
      windowSize: 60,
      aggregateBy: ['ip', 'domain']
    }
  });
  assert.match(voidSource, /postGoogle\([\s\S]*?'voidInstructorSignin'/u);
  assert.doesNotMatch(voidSource, /kioskSignIn|addMissedInstructor|staffTimeVoid/u);

  let fetchCalls = 0;
  const response = await handleAdminVoid(request({ method: 'GET' }), {
    ...ACTIVE_DEPENDENCIES,
    fetch: async () => { fetchCalls += 1; throw new Error('must not run'); }
  });
  assert.equal(response.status, 405);
  assert.equal(fetchCalls, 0);
});

test('valid active Richmond Admin void forwards one exact authenticated semantic request', async () => {
  const upstream = [];
  const response = await handleAdminVoid(request(), {
    ...ACTIVE_DEPENDENCIES,
    fetch: async (url, init) => {
      upstream.push({ url, init });
      return new Response(JSON.stringify(googleResult()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].url, ACTIVE_ENV.GIB_RICHMOND_PRODUCTION_WEBHOOK_URL);
  assert.equal(upstream[0].init.method, 'POST');
  const forwarded = JSON.parse(upstream[0].init.body);
  assert.deepEqual(Object.keys(forwarded).sort(), [
    'action',
    'adminActionToken',
    'adminName',
    'environment',
    'installation',
    'reason',
    'requestId',
    'rowId',
    'target',
    'token'
  ]);
  assert.deepEqual({
    action: forwarded.action,
    adminName: forwarded.adminName,
    environment: forwarded.environment,
    installation: forwarded.installation,
    reason: forwarded.reason,
    requestId: forwarded.requestId,
    rowId: forwarded.rowId,
    target: forwarded.target
  }, {
    action: 'voidInstructorSignin',
    adminName: ADMIN_NAME,
    environment: 'production',
    installation: 'richmond',
    reason: REASON,
    requestId: REQUEST_ID,
    rowId: ROW_ID,
    target: 'production'
  });

  assert.deepEqual(await responseBody(response), {
    ok: true,
    test: false,
    adminName: ADMIN_NAME,
    operation: 'void',
    requestId: REQUEST_ID,
    result: 'voided',
    linkedRecordId: ROW_ID,
    auditActionNumber: 1,
    confirmation: confirmation(),
    message: 'Instructor sign-in voided.'
  });
  assert.equal(response.headers.get('set-cookie'), null);
});

test('exact already-voided replay is accepted without changing the operation identity', async () => {
  const response = await handleAdminVoid(request(), {
    ...ACTIVE_DEPENDENCIES,
    fetch: async () => new Response(JSON.stringify(googleResult({
      result: 'already voided'
    })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.equal(response.status, 200);
  const body = await responseBody(response);
  assert.equal(body.result, 'already voided');
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.linkedRecordId, ROW_ID);
  assert.equal(
    body.message,
    'This instructor sign-in was already voided. No second audit action was created.'
  );
});

test('request contract binds deterministic request ID, RowID, reason, and session Admin exactly', async t => {
  const variants = [
    ['extra key', { ...requestBody(), extra: true }],
    ['wrong request ID', requestBody({ requestId: `${REQUEST_ID}-other` })],
    ['non-v4 RowID', requestBody({
      rowId: 'gib-m1-12345678-1234-3123-8123-123456789abc',
      requestId: 'gib-m1-admin-void-gib-m1-12345678-1234-3123-8123-123456789abc'
    })],
    ['other Admin', requestBody({ adminName: 'Stuart Turner' })],
    ['blank reason', requestBody({ reason: '' })],
    ['short reason', requestBody({ reason: 'no' })],
    ['formula reason', requestBody({ reason: '=IMPORTDATA("x")' })],
    ['noncanonical reason', requestBody({ reason: ' Installation  check ' })]
  ];
  for (const [name, body] of variants) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      const response = await handleAdminVoid(request({ body }), {
        ...ACTIVE_DEPENDENCIES,
        fetch: async () => { fetchCalls += 1; throw new Error('must not run'); }
      });
      assert.equal(response.status, 400);
      assert.equal(fetchCalls, 0);
    });
  }
});

test('missing or mismatched authenticated Admin proof is rejected before Google', async t => {
  const variants = [
    ['missing session', request({ auth: false }), 401],
    ['wrong request token', request({ requestToken: `${REQUEST_TOKEN}-wrong` }), 403],
    ['wrongly signed session', request({ cookie: `${ADMIN_COOKIE}=not-a-session` }), 401]
  ];
  for (const [name, candidate, expectedStatus] of variants) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      const response = await handleAdminVoid(candidate, {
        ...ACTIVE_DEPENDENCIES,
        fetch: async () => { fetchCalls += 1; throw new Error('must not run'); }
      });
      assert.equal(response.status, expectedStatus);
      assert.equal(fetchCalls, 0);
    });
  }
});

test('wrong origin, installation, profile phase, or Netlify gate fails closed before Google', async t => {
  const cases = [
    ['lookalike origin', request({
      origin: 'https://6a8ef6b20bba220fe005ae06--gib-richmond-live.netlify.app'
    }), ACTIVE_DEPENDENCIES, 403],
    ['Revolution profile', request(), {
      ...ACTIVE_DEPENDENCIES,
      installationId: 'rev',
      environment: undefined,
      activation: undefined
    }, 404],
    ['pending Richmond profile', request(), {
      ...ACTIVE_DEPENDENCIES,
      activation: 'pending'
    }, 404],
    ['Netlify write gate off', request(), {
      ...ACTIVE_DEPENDENCIES,
      env: {
        ...ACTIVE_ENV,
        GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'false'
      }
    }, 503]
  ];
  for (const [name, candidate, dependencies, expectedStatus] of cases) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      const response = await handleAdminVoid(candidate, {
        ...dependencies,
        fetch: async () => { fetchCalls += 1; throw new Error('must not run'); }
      });
      assert.equal(response.status, expectedStatus);
      assert.equal(fetchCalls, 0);
    });
  }
  assert.match(voidSource, /profile\.featureFlags\?\.staffClock === false/u);
});

test('Google confirmation is exact, Richmond-bound, idempotent, and fails closed', async t => {
  const malformed = [
    ['extra response field', { ...googleResult(), extra: true }],
    ['wrong request ID', googleResult({ requestId: `${REQUEST_ID}-other` })],
    ['wrong linked RowID', googleResult({
      linkedRecordId: 'gib-m1-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })],
    ['unsupported result', googleResult({ result: 'added' })],
    ['zero audit action', googleResult({ auditActionNumber: 0 })],
    ['wrong Admin', googleResult({ confirmation: confirmation({ adminName: 'Stuart Turner' }) })],
    ['wrong reason', googleResult({ confirmation: confirmation({ reason: 'Different reason' }) })],
    ['wrong status', googleResult({ confirmation: confirmation({ status: 'OK' }) })],
    ['wrong site', googleResult({ confirmation: confirmation({ site: 'Rev' }) })],
    ['wrong device', googleResult({ confirmation: confirmation({ device: 'Other tablet' }) })],
    ['TEST instructor', googleResult({ confirmation: confirmation({ instructor: 'QA Test Person' }) })],
    ['date mismatch', googleResult({ confirmation: confirmation({ date: '2026-08-25' }) })]
  ];
  for (const [name, payload] of malformed) {
    await t.test(name, async () => {
      const response = await handleAdminVoid(request(), {
        ...ACTIVE_DEPENDENCIES,
        fetch: async () => new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      });
      assert.equal(response.status, 502);
      const body = await responseBody(response);
      assert.equal(body.ok, false);
      assert.match(body.code, /^ADMIN_VOID_/u);
    });
  }
});

test('unreachable and rejected Google responses never report success', async () => {
  const unreachable = await handleAdminVoid(request(), {
    ...ACTIVE_DEPENDENCIES,
    fetch: async () => { throw new Error('offline'); }
  });
  assert.equal(unreachable.status, 504);
  assert.equal((await responseBody(unreachable)).code, 'ADMIN_VOID_UNREACHABLE');

  const rejected = await handleAdminVoid(request(), {
    ...ACTIVE_DEPENDENCIES,
    fetch: async () => new Response(JSON.stringify({ ok: false, result: 'rejected' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.equal(rejected.status, 502);
  assert.equal((await responseBody(rejected)).code, 'ADMIN_VOID_REJECTED');
});

test('shared Admin contracts expose void audit history without widening addition results', () => {
  const audit = {
    auditId: 'audit-row-2',
    actionNumber: 1,
    adminName: ADMIN_NAME,
    actionTime: '2026-08-26 10:30:00',
    instructor: 'Andrew Smith',
    classDate: '2026-08-26',
    classLabel: '6:00 AM–7:00 AM Muay Thai Fundamentals',
    site: 'Richmond',
    duration: 1,
    reason: REASON,
    result: 'voided',
    linkedRecordId: ROW_ID
  };
  assert.deepEqual(sanitizeAuditRecord(audit, '2026-08-26', {
    allowInstructorSigninVoid: true
  }), audit);
  assert.equal(sanitizeAuditRecord(audit, '2026-08-26'), null);
  assert.equal(sanitizeAuditRecord({ ...audit, linkedRecordId: 'sheet-row-2' }, '2026-08-26', {
    allowInstructorSigninVoid: true
  }), null);

  const reviewPayload = {
    ok: true,
    date: '2026-08-26',
    records: [],
    warnings: [],
    auditHistory: [audit]
  };
  assert.equal(sanitizeDailyReviewPayload(reviewPayload, '2026-08-26'), null);
  assert.ok(sanitizeDailyReviewPayload(reviewPayload, '2026-08-26', {
    allowInstructorSigninVoid: true
  }));

  const expected = sanitizeInstructorSigninVoidRequest(requestBody(), ADMIN_NAME);
  assert.ok(expected);
  assert.ok(sanitizeInstructorSigninVoidResult(googleResult(), expected));
  assert.equal(sanitizeAdminAdditionPayload({
    ok: true,
    result: 'voided',
    requestId: 'addition-request',
    linkedRecordId: ROW_ID,
    linkedDisplayId: 'sheet-row-2',
    auditActionNumber: 1,
    confirmation: {
      adminName: ADMIN_NAME,
      date: '2026-08-26',
      classLabel: 'Class',
      duration: 1,
      instructor: 'Andrew Smith',
      site: 'Richmond',
      reason: REASON,
      notes: ''
    }
  }, {
    requestId: 'addition-request',
    adminName: ADMIN_NAME,
    date: '2026-08-26',
    classLabel: 'Class',
    duration: 1,
    instructor: 'Andrew Smith',
    site: 'Richmond',
    reason: REASON,
    notes: ''
  }), null);
});
