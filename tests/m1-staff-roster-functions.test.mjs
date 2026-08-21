import assert from 'node:assert/strict';
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
  handleAdminStaffRoster
} from '../netlify/functions/m1-admin-staff-roster.mjs';

const NOW_MS = Date.parse('2026-08-21T14:00:00.000Z');
const PREVIEW_ORIGIN = 'https://deploy-preview-63--gib-live.netlify.app';
const IMMUTABLE_ORIGIN = 'https://abcdef1234567890abcdef12--gib-live.netlify.app';
const ROSTER_PATH = '/.netlify/functions/m1-admin-staff-roster';
const TEST_WEBHOOK_URL = 'https://script.google.com/macros/s/SYNTHETIC_ROSTER_TEST_RECEIVER/exec';
const PRODUCTION_WEBHOOK_URL = 'https://script.google.com/macros/s/SYNTHETIC_ROSTER_PRODUCTION_RECEIVER/exec';
const TEST_WEBHOOK_TOKEN = 'roster-test-transport-token-0123456789abcdef';
const TEST_ADMIN_TOKEN = 'roster-test-admin-token-fedcba9876543210';
const PRODUCTION_WEBHOOK_TOKEN = 'roster-production-transport-token-0123456789';
const PRODUCTION_ADMIN_TOKEN = 'roster-production-admin-token-9876543210abcdef';
const PRODUCTION_PASSPHRASE = 'correct horse private gym battery staple';
const ADMIN_REQUEST_TOKEN = 'R'.repeat(43);
const ADD_REQUEST_ID = 'gib-m1-staff-request-11111111-1111-4111-8111-111111111111';
const DEACTIVATE_REQUEST_ID = 'gib-m1-staff-request-22222222-2222-4222-8222-222222222222';
const REACTIVATE_REQUEST_ID = 'gib-m1-staff-request-33333333-3333-4333-8333-333333333333';
const STAFF_ID = 'staff-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const ENV = Object.freeze({
  GIB_TEST_WEBHOOK_URL: TEST_WEBHOOK_URL,
  GIB_TEST_WEBHOOK_TOKEN: TEST_WEBHOOK_TOKEN,
  GIB_TEST_ADMIN_ACTION_TOKEN: TEST_ADMIN_TOKEN,
  GIB_M1_PRODUCTION_WEBHOOK_URL: PRODUCTION_WEBHOOK_URL,
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: PRODUCTION_WEBHOOK_TOKEN,
  GIB_M1_ADMIN_ACTION_TOKEN: PRODUCTION_ADMIN_TOKEN,
  GIB_M1_ADMIN_PASSPHRASE: PRODUCTION_PASSPHRASE
});

function adminRequest({
  origin = PREVIEW_ORIGIN,
  requestOrigin = origin,
  host = new URL(origin).host,
  fetchSite = 'same-origin',
  path = ROSTER_PATH,
  body = { operation: 'list' },
  adminName = 'Andrew Smith',
  env = ENV,
  sessionOrigin = origin,
  requestToken = ADMIN_REQUEST_TOKEN,
  headerToken = requestToken,
  includeAuth = true,
  includeHost = true,
  includeOrigin = true,
  includeFetchSite = true
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (includeHost) headers.Host = host;
  if (includeOrigin) headers.Origin = requestOrigin;
  if (includeFetchSite) headers['Sec-Fetch-Site'] = fetchSite;
  if (includeAuth) {
    const runtime = runtimeConfig(env, {
      admin: true,
      requestUrl: `${sessionOrigin}${path}`
    });
    assert.ok(runtime, 'test setup requires a valid Admin runtime');
    const session = createAdminSession(
      adminName,
      runtime.sessionSecret,
      NOW_MS,
      requestToken
    );
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

function rosterGoogle(target = 'test', overrides = {}) {
  const staff = target === 'test'
    ? [
      { staffId: 'mandy-test', staffName: 'Mandy Test', active: true },
      { staffId: 'former-staff-test', staffName: 'Former Staff Test', active: false }
    ]
    : [
      { staffId: 'mandy', staffName: 'Mandy', active: true },
      { staffId: 'marvin', staffName: 'Marvin', active: true }
    ];
  return {
    ok: true,
    target,
    staff,
    ...overrides
  };
}

function mutationValues(operation, target = 'test') {
  const staffName = target === 'test' ? 'QA Test Staff' : 'Mandy';
  if (operation === 'add') {
    return {
      requestId: ADD_REQUEST_ID,
      result: 'added',
      staffName,
      previousActive: null,
      newActive: true
    };
  }
  if (operation === 'deactivate') {
    return {
      requestId: DEACTIVATE_REQUEST_ID,
      result: 'deactivated',
      staffName,
      previousActive: true,
      newActive: false
    };
  }
  return {
    requestId: REACTIVATE_REQUEST_ID,
    result: 'reactivated',
    staffName,
    previousActive: false,
    newActive: true
  };
}

function mutationGoogle(operation, target = 'test', overrides = {}) {
  const values = mutationValues(operation, target);
  return {
    ok: true,
    target,
    operation,
    requestId: values.requestId,
    result: values.result,
    confirmation: {
      adminName: 'Andrew Smith',
      staffId: STAFF_ID,
      staffName: values.staffName,
      action: operation,
      previousActive: values.previousActive,
      newActive: values.newActive
    },
    ...overrides
  };
}

function dependencies(fetchImpl, env = ENV) {
  return { env, now: NOW_MS, fetch: fetchImpl };
}

test('Staff roster list uses exact preview routes and isolated authenticated TEST transport', async () => {
  for (const origin of [PREVIEW_ORIGIN, IMMUTABLE_ORIGIN]) {
    let upstream;
    const response = await handleAdminStaffRoster(adminRequest({
      origin,
      sessionOrigin: origin,
      adminName: 'Stuart Turner'
    }), dependencies(async (url, options) => {
      upstream = { url, options, body: JSON.parse(options.body) };
      return googleResponse(rosterGoogle());
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.deepEqual(await responseBody(response), {
      ok: true,
      test: true,
      adminName: 'Stuart Turner',
      staff: rosterGoogle().staff
    });
    assert.equal(upstream.url, TEST_WEBHOOK_URL);
    assert.equal(upstream.options.method, 'POST');
    assert.deepEqual(upstream.body, {
      token: TEST_WEBHOOK_TOKEN,
      action: 'staffRosterList',
      target: 'test',
      adminActionToken: TEST_ADMIN_TOKEN
    });
  }
});

test('exact canonical production Admin can list and mutate with only production transport', async () => {
  const operations = ['list', 'add', 'deactivate', 'reactivate'];
  for (const operation of operations) {
    const values = operation === 'list' ? null : mutationValues(operation, 'production');
    const body = operation === 'list'
      ? { operation }
      : operation === 'add'
        ? { operation, requestId: values.requestId, staffName: values.staffName }
        : { operation, requestId: values.requestId, staffId: STAFF_ID };
    let upstream;
    const response = await handleAdminStaffRoster(adminRequest({
      origin: PRODUCTION_ORIGIN,
      sessionOrigin: PRODUCTION_ORIGIN,
      adminName: 'Stuart Turner',
      body
    }), dependencies(async (url, options) => {
      upstream = { url, body: JSON.parse(options.body) };
      return googleResponse(operation === 'list'
        ? rosterGoogle('production')
        : mutationGoogle(operation, 'production', {
          confirmation: {
            ...mutationGoogle(operation, 'production').confirmation,
            adminName: 'Stuart Turner'
          }
        }));
    }));

    assert.equal(response.status, 200, operation);
    const browser = await responseBody(response);
    assert.equal(browser.ok, true);
    assert.equal(browser.test, false);
    assert.equal(browser.adminName, 'Stuart Turner');
    assert.equal(upstream.url, PRODUCTION_WEBHOOK_URL);
    assert.equal(upstream.body.target, 'production');
    assert.equal(upstream.body.token, PRODUCTION_WEBHOOK_TOKEN);
    assert.equal(upstream.body.adminActionToken, PRODUCTION_ADMIN_TOKEN);
    const wire = JSON.stringify(upstream);
    assert.equal(wire.includes(TEST_WEBHOOK_URL), false);
    assert.equal(wire.includes(TEST_WEBHOOK_TOKEN), false);
    assert.equal(wire.includes(TEST_ADMIN_TOKEN), false);
    if (operation === 'list') {
      assert.equal(upstream.body.action, 'staffRosterList');
      assert.deepEqual(browser.staff, rosterGoogle('production').staff);
    } else {
      assert.equal(upstream.body.action, 'staffRosterMutate');
      assert.equal(browser.operation, operation);
      assert.equal(browser.requestId, values.requestId);
      assert.equal(browser.confirmation.staffName, 'Mandy');
    }
  }
});

test('Staff roster requires the current Admin cookie and matching memory-only request token', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return googleResponse(rosterGoogle());
  };

  const missingSession = await handleAdminStaffRoster(
    adminRequest({ includeAuth: false }),
    dependencies(fetchImpl)
  );
  assert.equal(missingSession.status, 401);
  assert.deepEqual(await responseBody(missingSession), {
    ok: false,
    message: 'Admin login required.'
  });

  const wrongRequestToken = await handleAdminStaffRoster(
    adminRequest({ headerToken: 'W'.repeat(43) }),
    dependencies(fetchImpl)
  );
  assert.equal(wrongRequestToken.status, 403);
  assert.deepEqual(await responseBody(wrongRequestToken), {
    ok: false,
    message: 'Admin login must be renewed for this page.'
  });
  assert.equal(calls, 0, 'unauthorized roster requests must stop before Google');
});

test('TEST and production Admin sessions cannot cross-authorize', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return googleResponse(rosterGoogle());
  };
  const productionCookieOnPreview = await handleAdminStaffRoster(adminRequest({
    sessionOrigin: PRODUCTION_ORIGIN
  }), dependencies(fetchImpl));
  const testCookieOnProduction = await handleAdminStaffRoster(adminRequest({
    origin: PRODUCTION_ORIGIN,
    sessionOrigin: PREVIEW_ORIGIN
  }), dependencies(fetchImpl));

  for (const response of [productionCookieOnPreview, testCookieOnProduction]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await responseBody(response), {
      ok: false,
      message: 'Admin login required.'
    });
  }
  assert.equal(calls, 0);
});

test('cross-scoped credentials and Apps Script endpoints fail configuration before Google', async () => {
  const cases = [
    {
      origin: PREVIEW_ORIGIN,
      env: { ...ENV, GIB_TEST_WEBHOOK_URL: PRODUCTION_WEBHOOK_URL }
    },
    {
      origin: PRODUCTION_ORIGIN,
      env: { ...ENV, GIB_M1_PRODUCTION_WEBHOOK_URL: TEST_WEBHOOK_URL }
    },
    {
      origin: PREVIEW_ORIGIN,
      env: { ...ENV, GIB_TEST_ADMIN_ACTION_TOKEN: PRODUCTION_ADMIN_TOKEN }
    },
    {
      origin: PRODUCTION_ORIGIN,
      env: { ...ENV, GIB_M1_ADMIN_ACTION_TOKEN: TEST_ADMIN_TOKEN }
    }
  ];
  let calls = 0;
  for (const candidate of cases) {
    const response = await handleAdminStaffRoster(adminRequest({
      origin: candidate.origin,
      includeAuth: false
    }), dependencies(async () => {
      calls += 1;
      return googleResponse(rosterGoogle());
    }, candidate.env));
    assert.equal(response.status, 503);
    assert.deepEqual(await responseBody(response), {
      ok: false,
      message: 'Staff Roster Admin is not configured.'
    });
  }
  assert.equal(calls, 0);
});

test('add normalizes the only user-entered field and pins Admin attribution server-side', async () => {
  let upstream;
  const request = adminRequest({
    body: {
      operation: 'add',
      requestId: ADD_REQUEST_ID,
      staffName: '  QA   Test   Staff  '
    }
  });
  const response = await handleAdminStaffRoster(request, dependencies(async (url, options) => {
    upstream = { url, body: JSON.parse(options.body) };
    return googleResponse(mutationGoogle('add'));
  }));

  assert.equal(response.status, 200);
  assert.equal(upstream.url, TEST_WEBHOOK_URL);
  assert.deepEqual(upstream.body, {
    operation: 'add',
    requestId: ADD_REQUEST_ID,
    staffName: 'QA Test Staff',
    adminName: 'Andrew Smith',
    token: TEST_WEBHOOK_TOKEN,
    action: 'staffRosterMutate',
    target: 'test',
    adminActionToken: TEST_ADMIN_TOKEN
  });
  assert.deepEqual(await responseBody(response), {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    operation: 'add',
    requestId: ADD_REQUEST_ID,
    result: 'added',
    confirmation: mutationGoogle('add').confirmation
  });
});

test('name policy requires obvious fake names in TEST and forbids them in production', async () => {
  const obviousFakeNames = [
    'QA Staff',
    'Test Staff',
    'Fake Staff',
    'Demo Staff',
    'Do Not Pay Staff',
    'Do-Not-Pay Staff'
  ];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return googleResponse(mutationGoogle('add'));
  };

  const realInTest = await handleAdminStaffRoster(adminRequest({
    body: { operation: 'add', requestId: ADD_REQUEST_ID, staffName: 'Mandy' }
  }), dependencies(fetchImpl));
  assert.equal(realInTest.status, 400);

  const noncanonicalFakeInTest = await handleAdminStaffRoster(adminRequest({
    body: { operation: 'add', requestId: ADD_REQUEST_ID, staffName: 'Do-Not-Pay Staff' }
  }), dependencies(fetchImpl));
  assert.equal(noncanonicalFakeInTest.status, 400);

  for (const staffName of obviousFakeNames) {
    const fakeInProduction = await handleAdminStaffRoster(adminRequest({
      origin: PRODUCTION_ORIGIN,
      sessionOrigin: PRODUCTION_ORIGIN,
      body: { operation: 'add', requestId: ADD_REQUEST_ID, staffName }
    }), dependencies(fetchImpl));
    assert.equal(fakeInProduction.status, 400, staffName);
    assert.deepEqual(await responseBody(fakeInProduction), {
      ok: false,
      result: 'rejected',
      message: 'The Staff Roster request was rejected.'
    });
  }
  assert.equal(calls, 0);
});

test('deactivate and reactivate forward only the stable Staff ID and require exact confirmations', async () => {
  for (const operation of ['deactivate', 'reactivate']) {
    const values = mutationValues(operation);
    let upstream;
    const response = await handleAdminStaffRoster(adminRequest({
      body: {
        operation,
        requestId: values.requestId,
        staffId: STAFF_ID
      }
    }), dependencies(async (_url, options) => {
      upstream = JSON.parse(options.body);
      return googleResponse(mutationGoogle(operation));
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(upstream, {
      operation,
      requestId: values.requestId,
      staffId: STAFF_ID,
      adminName: 'Andrew Smith',
      token: TEST_WEBHOOK_TOKEN,
      action: 'staffRosterMutate',
      target: 'test',
      adminActionToken: TEST_ADMIN_TOKEN
    });
    assert.deepEqual(await responseBody(response), {
      ok: true,
      test: true,
      adminName: 'Andrew Smith',
      operation,
      requestId: values.requestId,
      result: values.result,
      confirmation: mutationGoogle(operation).confirmation
    });
  }
});

test('malformed, dangerous, real-person, and noncanonical requests stop before Google', async () => {
  const invalidBodies = [
    {},
    { operation: 'unknown' },
    { operation: 'list', extra: true },
    { operation: 'list', target: 'production' },
    { operation: 'list', environment: 'production' },
    { operation: 'list', test: false },
    { operation: 'list', sheetId: 'private-sheet-id' },
    { operation: 'list', sheetUrl: 'https://docs.google.com/private' },
    { operation: 'list', webhookUrl: TEST_WEBHOOK_URL },
    { operation: 'list', deploymentId: 'private-deployment-id' },
    { operation: 'list', token: TEST_WEBHOOK_TOKEN },
    { operation: 'list', adminActionToken: TEST_ADMIN_TOKEN },
    { operation: 'add', requestId: ADD_REQUEST_ID, staffName: '' },
    { operation: 'add', requestId: ADD_REQUEST_ID, staffName: 'Mandy' },
    { operation: 'add', requestId: ADD_REQUEST_ID, staffName: '=QA Test Staff' },
    { operation: 'add', requestId: ADD_REQUEST_ID, staffName: '<script>QA Test Staff</script>' },
    { operation: 'add', requestId: ADD_REQUEST_ID, staffName: 'QA\u0000 Test Staff' },
    { operation: 'add', requestId: ADD_REQUEST_ID, staffName: `${'A'.repeat(96)} QA Test Staff` },
    { operation: 'add', requestId: 'not-a-request-id', staffName: 'QA Test Staff' },
    { operation: 'add', requestId: ADD_REQUEST_ID, staffName: 'QA Test Staff', staffId: STAFF_ID },
    { operation: 'deactivate', requestId: DEACTIVATE_REQUEST_ID, staffId: '' },
    { operation: 'deactivate', requestId: DEACTIVATE_REQUEST_ID, staffId: 'UPPERCASE' },
    { operation: 'deactivate', requestId: DEACTIVATE_REQUEST_ID, staffId: STAFF_ID, staffName: 'QA Test Staff' },
    { operation: 'reactivate', requestId: REACTIVATE_REQUEST_ID },
    { operation: 'reactivate', requestId: REACTIVATE_REQUEST_ID, staffId: STAFF_ID, active: true }
  ];
  let calls = 0;
  for (const body of invalidBodies) {
    const response = await handleAdminStaffRoster(adminRequest({ body }), dependencies(async () => {
      calls += 1;
      return googleResponse(rosterGoogle());
    }));
    assert.equal(response.status, 400, JSON.stringify(body));
    const value = await responseBody(response);
    assert.equal(value.ok, false);
    assert.equal(Object.hasOwn(value, 'staffId'), false);
  }
  assert.equal(calls, 0);
});

test('strict roster replies reject target, field, identity, name, and Active drift', async () => {
  const invalidReplies = [
    { ...rosterGoogle(), target: 'production' },
    { ...rosterGoogle(), extra: true },
    { ...rosterGoogle(), staff: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }] },
    { ...rosterGoogle(), staff: [{ staffId: 'UPPERCASE', staffName: 'QA Test Staff', active: true }] },
    { ...rosterGoogle(), staff: [{ staffId: 'qa-test', staffName: '=QA Test Staff', active: true }] },
    { ...rosterGoogle(), staff: [{ staffId: 'qa-test', staffName: 'QA Test Staff', active: 'TRUE' }] },
    {
      ...rosterGoogle(),
      staff: Array.from({ length: 101 }, (_, index) => ({
        staffId: `qa-test-${index}`,
        staffName: `QA Test Staff ${index}`,
        active: index === 0
      }))
    },
    {
      ...rosterGoogle(),
      staff: [
        { staffId: 'duplicate-test', staffName: 'First QA Test', active: true },
        { staffId: 'duplicate-test', staffName: 'Second QA Test', active: false }
      ]
    },
    {
      ...rosterGoogle(),
      staff: [
        { staffId: 'first-test', staffName: 'QA Test Staff', active: true },
        { staffId: 'second-test', staffName: '  qa   test staff  ', active: false }
      ]
    }
  ];

  for (const value of invalidReplies) {
    const response = await handleAdminStaffRoster(
      adminRequest(),
      dependencies(async () => googleResponse(value))
    );
    assert.equal(response.status, 502);
    const body = await responseBody(response);
    assert.equal(body.ok, false);
    assert.equal(Object.hasOwn(body, 'staff'), false);
  }
});

test('readable roster confirmations enforce the server-selected target name policy', async () => {
  const cases = [
    {
      request: adminRequest(),
      reply: rosterGoogle('test', {
        staff: [{ staffId: 'mandy', staffName: 'Mandy', active: true }]
      })
    },
    {
      request: adminRequest({
        origin: PRODUCTION_ORIGIN,
        sessionOrigin: PRODUCTION_ORIGIN
      }),
      reply: rosterGoogle('production', {
        staff: [{ staffId: 'qa-test', staffName: 'QA Test Staff', active: true }]
      })
    }
  ];
  for (const candidate of cases) {
    const response = await handleAdminStaffRoster(
      candidate.request,
      dependencies(async () => googleResponse(candidate.reply))
    );
    assert.equal(response.status, 502);
    const browser = await responseBody(response);
    assert.equal(browser.ok, false);
    assert.equal(Object.hasOwn(browser, 'staff'), false);
  }
});

test('mutation replies fail closed on operation, replay identity, attribution, and state drift', async () => {
  const valid = mutationGoogle('deactivate');
  const invalidReplies = [
    { ...valid, target: 'production' },
    { ...valid, operation: 'reactivate' },
    { ...valid, requestId: REACTIVATE_REQUEST_ID },
    { ...valid, result: 'updated' },
    { ...valid, extra: true },
    { ...valid, confirmation: { ...valid.confirmation, adminName: 'Stuart Turner' } },
    { ...valid, confirmation: { ...valid.confirmation, staffId: 'another-test-staff' } },
    { ...valid, confirmation: { ...valid.confirmation, action: 'reactivate' } },
    { ...valid, confirmation: { ...valid.confirmation, previousActive: false } },
    { ...valid, confirmation: { ...valid.confirmation, newActive: true } },
    { ...valid, confirmation: { ...valid.confirmation, extra: true } }
  ];
  const request = () => adminRequest({
    body: {
      operation: 'deactivate',
      requestId: DEACTIVATE_REQUEST_ID,
      staffId: STAFF_ID
    }
  });

  for (const value of invalidReplies) {
    const response = await handleAdminStaffRoster(
      request(),
      dependencies(async () => googleResponse(value))
    );
    assert.equal(response.status, 502);
    const body = await responseBody(response);
    assert.equal(body.ok, false);
    assert.equal(Object.hasOwn(body, 'confirmation'), false);
  }
});

test('mutation confirmation names are exact and target-aware', async () => {
  const productionRequest = body => adminRequest({
    origin: PRODUCTION_ORIGIN,
    sessionOrigin: PRODUCTION_ORIGIN,
    body
  });
  const cases = [
    {
      request: adminRequest({
        body: {
          operation: 'deactivate',
          requestId: DEACTIVATE_REQUEST_ID,
          staffId: STAFF_ID
        }
      }),
      reply: mutationGoogle('deactivate', 'test', {
        confirmation: {
          ...mutationGoogle('deactivate').confirmation,
          staffName: 'Mandy'
        }
      })
    },
    {
      request: productionRequest({
        operation: 'deactivate',
        requestId: DEACTIVATE_REQUEST_ID,
        staffId: STAFF_ID
      }),
      reply: mutationGoogle('deactivate', 'production', {
        confirmation: {
          ...mutationGoogle('deactivate', 'production').confirmation,
          staffName: 'QA Test Staff'
        }
      })
    },
    {
      request: productionRequest({
        operation: 'add',
        requestId: ADD_REQUEST_ID,
        staffName: 'Mandy'
      }),
      reply: mutationGoogle('add', 'production', {
        confirmation: {
          ...mutationGoogle('add', 'production').confirmation,
          staffName: 'Marvin'
        }
      })
    }
  ];

  for (const candidate of cases) {
    const response = await handleAdminStaffRoster(
      candidate.request,
      dependencies(async () => googleResponse(candidate.reply))
    );
    assert.equal(response.status, 502);
    const browser = await responseBody(response);
    assert.equal(browser.ok, false);
    assert.equal(Object.hasOwn(browser, 'confirmation'), false);
  }
});

test('conflicts require an exact target-aware confirmation and stay target-neutral', async () => {
  for (const target of ['test', 'production']) {
    const origin = target === 'test' ? PREVIEW_ORIGIN : PRODUCTION_ORIGIN;
    const staffName = target === 'test' ? 'QA Test Staff' : 'Mandy';
    const request = () => adminRequest({
      origin,
      sessionOrigin: origin,
      body: { operation: 'add', requestId: ADD_REQUEST_ID, staffName }
    });
    const exact = {
      ok: false,
      target,
      result: 'conflict',
      code: 'capacity'
    };
    const accepted = await handleAdminStaffRoster(
      request(),
      dependencies(async () => googleResponse(exact))
    );
    assert.equal(accepted.status, 409);
    assert.deepEqual(await responseBody(accepted), {
      ok: false,
      test: target === 'test',
      result: 'conflict',
      code: 'capacity',
      message: 'The Staff Roster has reached its safe staff limit.'
    });

    const invalid = [
      { ...exact, target: target === 'test' ? 'production' : 'test' },
      { ...exact, code: 'unknown_conflict' },
      { ...exact, message: 'private upstream detail' },
      { ...exact, extra: true }
    ];
    for (const reply of invalid) {
      const response = await handleAdminStaffRoster(
        request(),
        dependencies(async () => googleResponse(reply))
      );
      assert.equal(response.status, 502);
      const browser = await responseBody(response);
      assert.equal(browser.ok, false);
      assert.equal(Object.hasOwn(browser, 'result'), false);
    }
  }
});

test('inexact preview and production browser boundaries reject before Google', async () => {
  const invalidRequests = [
    adminRequest({ includeAuth: false, requestOrigin: 'https://attacker.example' }),
    adminRequest({ includeAuth: false, host: 'attacker.example' }),
    adminRequest({ includeAuth: false, fetchSite: 'cross-site' }),
    adminRequest({ includeAuth: false, includeHost: false }),
    adminRequest({ includeAuth: false, includeFetchSite: false }),
    adminRequest({ includeAuth: false, path: `${ROSTER_PATH}/extra` }),
    adminRequest({ includeAuth: false, path: `${ROSTER_PATH}?scope=test` }),
    adminRequest({
      includeAuth: false,
      origin: 'http://deploy-preview-63--gib-live.netlify.app',
      requestOrigin: 'http://deploy-preview-63--gib-live.netlify.app'
    }),
    adminRequest({
      includeAuth: false,
      origin: 'https://branch-name--gib-live.netlify.app'
    }),
    adminRequest({
      includeAuth: false,
      origin: 'https://gib-live.netlify.app.attacker.example'
    }),
    adminRequest({
      includeAuth: false,
      origin: PRODUCTION_ORIGIN,
      host: 'GIB-LIVE.NETLIFY.APP:443'
    }),
    adminRequest({
      includeAuth: false,
      origin: PRODUCTION_ORIGIN,
      requestOrigin: PREVIEW_ORIGIN
    }),
    adminRequest({
      includeAuth: false,
      origin: PRODUCTION_ORIGIN,
      fetchSite: 'none'
    }),
    adminRequest({
      includeAuth: false,
      origin: PRODUCTION_ORIGIN,
      includeHost: false
    }),
    adminRequest({
      includeAuth: false,
      origin: PRODUCTION_ORIGIN,
      includeFetchSite: false
    }),
    adminRequest({
      includeAuth: false,
      origin: PRODUCTION_ORIGIN,
      path: `${ROSTER_PATH}?target=production`
    })
  ];
  let calls = 0;
  for (const request of invalidRequests) {
    const response = await handleAdminStaffRoster(request, dependencies(async () => {
      calls += 1;
      return googleResponse(rosterGoogle());
    }));
    assert.equal(response.status, 403);
    assert.equal((await responseBody(response)).ok, false);
  }
  assert.equal(calls, 0);
});

test('unreachable, unreadable, rejected, and drifting Google replies stay fail-closed and secret-safe', async () => {
  const upstreamCanary = 'UPSTREAM_ROSTER_CANARY';
  const cases = [
    {
      status: 504,
      fetch: async () => { throw new Error(upstreamCanary); }
    },
    {
      status: 502,
      fetch: async () => new Response(`<html>${upstreamCanary}</html>`, { status: 200 })
    },
    {
      status: 502,
      fetch: async () => googleResponse({
        ok: false,
        target: 'test',
        result: 'rejected',
        message: upstreamCanary
      })
    },
    {
      status: 502,
      fetch: async () => googleResponse({
        ...rosterGoogle(),
        staff: [{ staffId: 'qa-test', staffName: upstreamCanary, active: true }]
      })
    }
  ];
  const forbidden = [
    upstreamCanary,
    TEST_WEBHOOK_URL,
    TEST_WEBHOOK_TOKEN,
    TEST_ADMIN_TOKEN,
    PRODUCTION_WEBHOOK_URL,
    PRODUCTION_WEBHOOK_TOKEN,
    PRODUCTION_ADMIN_TOKEN,
    PRODUCTION_PASSPHRASE
  ];

  for (const candidate of cases) {
    const response = await handleAdminStaffRoster(
      adminRequest(),
      dependencies(candidate.fetch)
    );
    assert.equal(response.status, candidate.status);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    const text = await response.text();
    assert.equal(JSON.parse(text).ok, false);
    for (const secret of forbidden) assert.equal(text.includes(secret), false);
  }
});

test('mutation timeout after send reports an unconfirmed outcome and requires the same request ID', async () => {
  let upstream;
  const response = await handleAdminStaffRoster(
    adminRequest({
      body: {
        operation: 'add',
        requestId: ADD_REQUEST_ID,
        staffName: 'QA Test Staff'
      }
    }),
    dependencies(async (url, options) => {
      upstream = { url, body: JSON.parse(options.body) };
      const timeout = new Error('synthetic timeout after request send');
      timeout.name = 'TimeoutError';
      throw timeout;
    })
  );

  assert.equal(upstream.url, TEST_WEBHOOK_URL);
  assert.equal(upstream.body.requestId, ADD_REQUEST_ID);
  assert.equal(response.status, 504);
  assert.deepEqual(await responseBody(response), {
    ok: false,
    code: 'STAFF_ROSTER_ADD_UNREACHABLE',
    message: 'Staff Roster change outcome is unconfirmed. Retry this exact action with the same request ID.'
  });
});

test('read-only roster list reachability failure remains definitive that nothing changed', async () => {
  const response = await handleAdminStaffRoster(
    adminRequest(),
    dependencies(async () => {
      throw new Error('synthetic pre-list reachability failure');
    })
  );

  assert.equal(response.status, 504);
  assert.deepEqual(await responseBody(response), {
    ok: false,
    code: 'STAFF_ROSTER_LIST_UNREACHABLE',
    message: 'Staff Roster could not reach Google. Nothing changed.'
  });
});

test('valid roster-shaped configured secrets are contained before any browser success', async () => {
  const cases = [
    {
      request: adminRequest(),
      reply: rosterGoogle('test', {
        staff: [{
          staffId: TEST_ADMIN_TOKEN,
          staffName: 'QA Test Staff',
          active: true
        }]
      })
    },
    {
      request: adminRequest({
        origin: PRODUCTION_ORIGIN,
        sessionOrigin: PRODUCTION_ORIGIN
      }),
      reply: rosterGoogle('production', {
        staff: [{
          staffId: PRODUCTION_WEBHOOK_TOKEN,
          staffName: `Mandy ${PRODUCTION_PASSPHRASE}`,
          active: true
        }]
      })
    },
    {
      request: adminRequest({
        origin: PRODUCTION_ORIGIN,
        sessionOrigin: PRODUCTION_ORIGIN,
        body: {
          operation: 'add',
          requestId: ADD_REQUEST_ID,
          staffName: 'Mandy'
        }
      }),
      reply: mutationGoogle('add', 'production', {
        confirmation: {
          ...mutationGoogle('add', 'production').confirmation,
          staffId: PRODUCTION_ADMIN_TOKEN
        }
      })
    }
  ];
  const forbidden = [
    TEST_WEBHOOK_URL,
    TEST_WEBHOOK_TOKEN,
    TEST_ADMIN_TOKEN,
    PRODUCTION_WEBHOOK_URL,
    PRODUCTION_WEBHOOK_TOKEN,
    PRODUCTION_ADMIN_TOKEN,
    PRODUCTION_PASSPHRASE
  ];

  for (const candidate of cases) {
    const response = await handleAdminStaffRoster(
      candidate.request,
      dependencies(async () => googleResponse(candidate.reply))
    );
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), {
      ok: false,
      code: 'STAFF_ROSTER_PRIVATE_VALUE',
      message: 'Staff Roster did not return a safe readable confirmation. Success is not being reported.'
    });
    for (const secret of forbidden) assert.equal(text.includes(secret), false);
  }
});
