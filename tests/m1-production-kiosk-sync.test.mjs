import assert from 'node:assert/strict';
import test from 'node:test';

import { handleKioskSync } from '../netlify/functions/m1-kiosk-sync.mjs';
import {
  PRODUCTION_DEVICE_COOKIE,
  PRODUCTION_ORIGIN,
  createProductionDeviceCredential,
  productionRuntimeConfig
} from '../netlify/functions/_lib/m1-production-runtime.mjs';

const NOW = new Date('2026-08-07T16:00:00Z');
const NOW_MS = NOW.getTime();
const PRODUCTION_WEBHOOK_URL = 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION_RECEIVER_123/exec';
const TEST_WEBHOOK_URL = 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER_456/exec';
const PRODUCTION_WEBHOOK_TOKEN = 'production-webhook-token-0123456789abcdef';
const PRODUCTION_DEVICE_TOKEN = 'production-device-token-abcdef0123456789';
const TEST_WEBHOOK_TOKEN = 'test-webhook-token-fedcba9876543210';

const PRODUCTION_ENV = Object.freeze({
  GIB_M1_PRODUCTION_SYNC_ENABLED: 'true',
  GIB_M1_PRODUCTION_ORIGIN: PRODUCTION_ORIGIN,
  GIB_M1_PRODUCTION_WEBHOOK_URL: PRODUCTION_WEBHOOK_URL,
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: PRODUCTION_WEBHOOK_TOKEN,
  GIB_M1_PRODUCTION_DEVICE_TOKEN: PRODUCTION_DEVICE_TOKEN,
  GIB_TEST_WEBHOOK_URL: TEST_WEBHOOK_URL,
  GIB_TEST_WEBHOOK_TOKEN: TEST_WEBHOOK_TOKEN
});

function row(overrides = {}) {
  return {
    RowID: 'gib-m1-12345678-1234-4123-8123-123456789abc',
    Timestamp: '2026-08-07 11:30:00',
    Date: '2026-08-07',
    'Class Label': '12:00 PM BJJ',
    'Duration (hr)': 1,
    Instructor: 'Stuart Turner',
    Site: 'Rev',
    Device: 'Production tablet',
    Build: 'production-candidate',
    Notes: '',
    ...overrides
  };
}

function deviceCredential(secret = PRODUCTION_DEVICE_TOKEN) {
  return createProductionDeviceCredential(secret, size => Buffer.alloc(size, 0x42), NOW_MS);
}

function request({
  origin = PRODUCTION_ORIGIN,
  requestOrigin = origin,
  host = new URL(origin).host,
  fetchSite = 'same-origin',
  cookie = `${PRODUCTION_DEVICE_COOKIE}=${deviceCredential()}`,
  body = { rows: [row()] },
  path = '/api/m1-kiosk-sync',
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

function result(input, status = 'added', linkedRecordId = input.RowID) {
  return { rowId: input.RowID, result: status, linkedRecordId };
}

function googleResponse(results, target = 'production', extra = {}) {
  return new Response(JSON.stringify({ ok: true, target, results, ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function body(response) {
  return JSON.parse(await response.text());
}

test('production runtime is disabled unless every dedicated setting is exact and isolated', () => {
  assert.ok(productionRuntimeConfig(PRODUCTION_ENV));
  for (const key of [
    'GIB_M1_PRODUCTION_SYNC_ENABLED',
    'GIB_M1_PRODUCTION_ORIGIN',
    'GIB_M1_PRODUCTION_WEBHOOK_URL',
    'GIB_M1_PRODUCTION_WEBHOOK_TOKEN',
    'GIB_M1_PRODUCTION_DEVICE_TOKEN'
  ]) {
    assert.equal(productionRuntimeConfig({ ...PRODUCTION_ENV, [key]: '' }), null, key);
  }
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_PRODUCTION_ORIGIN: 'https://bjjsite.com'
  }), null);
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_PRODUCTION_WEBHOOK_URL: TEST_WEBHOOK_URL
  }), null);
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_PRODUCTION_WEBHOOK_TOKEN: TEST_WEBHOOK_TOKEN
  }), null);
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_PRODUCTION_DEVICE_TOKEN: TEST_WEBHOOK_TOKEN
  }), null);
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_PRODUCTION_DEVICE_TOKEN: PRODUCTION_WEBHOOK_TOKEN
  }), null);
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_WEBHOOK_URL: PRODUCTION_WEBHOOK_URL
  }), null);
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_WEBHOOK_TOKEN: PRODUCTION_WEBHOOK_TOKEN
  }), null);
  assert.equal(productionRuntimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_ADMIN_ACTION_TOKEN: ` ${PRODUCTION_WEBHOOK_TOKEN} `
  }), null);
});

test('production enforces exact HTTPS host, Origin, path, query, and Sec-Fetch-Site before Google', async () => {
  const candidates = [
    request({ origin: 'https://bjjsite.com' }),
    request({ requestOrigin: 'https://evil.example' }),
    request({ host: 'evil.example' }),
    request({ fetchSite: 'cross-site' }),
    request({ path: '/api/m1-kiosk-sync?target=production' }),
    request({ includeHost: false }),
    request({ includeOrigin: false }),
    request({ includeFetchSite: false })
  ];
  let calls = 0;
  for (const [index, candidate] of candidates.entries()) {
    const response = await handleKioskSync(candidate, {
      env: PRODUCTION_ENV,
      now: NOW_MS,
      dateNow: NOW,
      fetch: async () => {
        calls += 1;
        throw new Error('must not fetch');
      }
    });
    assert.equal(response.status, 403, `boundary case ${index}`);
  }
  assert.equal(calls, 0);
});

test('production rejects incomplete config and missing, wrong, or TEST-scoped device authentication', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };
  const incomplete = await handleKioskSync(request(), {
    env: {}, now: NOW_MS, dateNow: NOW, fetch: fetchImpl
  });
  assert.equal(incomplete.status, 403);

  const missing = await handleKioskSync(request({ cookie: '' }), {
    env: PRODUCTION_ENV, now: NOW_MS, dateNow: NOW, fetch: fetchImpl
  });
  assert.equal(missing.status, 401);

  const wrong = await handleKioskSync(request({
    cookie: `${PRODUCTION_DEVICE_COOKIE}=not-a-device-credential`
  }), {
    env: PRODUCTION_ENV, now: NOW_MS, dateNow: NOW, fetch: fetchImpl
  });
  assert.equal(wrong.status, 401);

  const testScoped = await handleKioskSync(request({
    cookie: `${PRODUCTION_DEVICE_COOKIE}=${deviceCredential(TEST_WEBHOOK_TOKEN)}`
  }), {
    env: PRODUCTION_ENV, now: NOW_MS, dateNow: NOW, fetch: fetchImpl
  });
  assert.equal(testScoped.status, 401);
  assert.equal(calls, 0);
});

test('authorized production accepts real names and pins URL, token, action, target, and exact rows', async () => {
  const input = row();
  let observedUrl;
  let observedOptions;
  const response = await handleKioskSync(request({ body: { rows: [input] } }), {
    env: PRODUCTION_ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async (url, options) => {
      observedUrl = url;
      observedOptions = options;
      return googleResponse([result(input)]);
    }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^__Host-gib_m1_production_device=/u);
  assert.equal(response.headers.get('set-cookie').includes(PRODUCTION_DEVICE_TOKEN), false);
  assert.deepEqual(await body(response), {
    ok: true,
    production: true,
    results: [result(input)]
  });
  const forwarded = JSON.parse(observedOptions.body);
  assert.equal(observedUrl, PRODUCTION_WEBHOOK_URL);
  assert.deepEqual(forwarded, {
    rows: [input],
    token: PRODUCTION_WEBHOOK_TOKEN,
    action: 'kioskSignIn',
    target: 'production'
  });
  assert.notEqual(observedUrl, TEST_WEBHOOK_URL);
  assert.notEqual(forwarded.token, TEST_WEBHOOK_TOKEN);
  assert.equal(JSON.stringify(await body(new Response(JSON.stringify(forwarded.rows)))).includes(PRODUCTION_DEVICE_TOKEN), false);
});

test('production accepts an already-exists acknowledgment linked to an Admin correction RowID', async () => {
  const input = row();
  const linkedRecordId = 'gib-admin-not-synced-correction';
  const response = await handleKioskSync(request({ body: { rows: [input] } }), {
    env: PRODUCTION_ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async () => googleResponse([
      result(input, 'already exists', linkedRecordId)
    ])
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    ok: true,
    production: true,
    results: [{
      rowId: input.RowID,
      result: 'already exists',
      linkedRecordId
    }]
  });
});

test('production simulation cannot reach TEST and browser overrides fail before Google', async () => {
  const input = row();
  let calls = 0;
  const onlyTestConfigured = await handleKioskSync(request(), {
    env: {
      GIB_TEST_WEBHOOK_URL: TEST_WEBHOOK_URL,
      GIB_TEST_WEBHOOK_TOKEN: TEST_WEBHOOK_TOKEN
    },
    now: NOW_MS,
    dateNow: NOW,
    fetch: async () => {
      calls += 1;
      return googleResponse([], 'test');
    }
  });
  assert.equal(onlyTestConfigured.status, 403);

  const override = await handleKioskSync(request({
    body: {
      rows: [input],
      target: 'test',
      token: TEST_WEBHOOK_TOKEN
    }
  }), {
    env: PRODUCTION_ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async () => {
      calls += 1;
      return googleResponse([result(input)]);
    }
  });
  assert.equal(override.status, 400);
  assert.equal(calls, 0);
});

test('production returns local rejection for malformed rows while forwarding only valid rows', async () => {
  const accepted = row();
  const rejected = row({
    RowID: 'gib-m1-fedcba98-7654-4321-8fed-cba987654321',
    Instructor: '=unsafe formula'
  });
  let forwarded;
  const response = await handleKioskSync(request({ body: { rows: [rejected, accepted] } }), {
    env: PRODUCTION_ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async (_url, options) => {
      forwarded = JSON.parse(options.body).rows;
      return googleResponse([result(accepted, 'already exists')]);
    }
  });
  assert.deepEqual(forwarded, [accepted]);
  assert.deepEqual((await body(response)).results, [
    { rowId: rejected.RowID, result: 'rejected', linkedRecordId: '' },
    result(accepted, 'already exists')
  ]);
});

test('production normalizes two synthetic legacy one-digit-second rows before Google', async () => {
  const incidentDate = new Date('2026-08-09T20:00:00Z');
  const first = row({
    Timestamp: '2026-08-09 15:57:3',
    Date: '2026-08-09',
    'Class Label': 'TEST Class A',
    Instructor: 'QA Legacy Instructor',
    Build: 'test-build'
  });
  const second = row({
    RowID: 'gib-m1-fedcba98-7654-4321-8fed-cba987654321',
    Timestamp: '2026-08-09 15:57:3',
    Date: '2026-08-09',
    'Class Label': 'TEST Class B',
    Instructor: 'QA Legacy Instructor',
    Build: 'test-build'
  });
  const firstBefore = structuredClone(first);
  const secondBefore = structuredClone(second);
  let fetchCalls = 0;
  let forwarded = [];

  const response = await handleKioskSync(request({ body: { rows: [first, second] } }), {
    env: PRODUCTION_ENV,
    now: NOW_MS,
    dateNow: incidentDate,
    fetch: async (_url, options) => {
      fetchCalls += 1;
      forwarded = JSON.parse(options.body).rows;
      return googleResponse([result(first), result(second)]);
    }
  });

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(forwarded.map(value => value.Timestamp), [
    '2026-08-09 15:57:03',
    '2026-08-09 15:57:03'
  ]);
  assert.deepEqual((await body(response)).results, [result(first), result(second)]);
  assert.deepEqual(first, firstBefore);
  assert.deepEqual(second, secondBefore);
});

test('production accepts every safe seconds boundary and forwards canonical timestamps', async () => {
  const incidentDate = new Date('2026-08-09T20:00:00Z');
  const cases = new Map([
    ['0', '00'],
    ['9', '09'],
    ['00', '00'],
    ['09', '09'],
    ['10', '10'],
    ['59', '59']
  ]);

  for (const [inputSeconds, expectedSeconds] of cases) {
    const input = row({
      Timestamp: `2026-08-09 15:57:${inputSeconds}`,
      Date: '2026-08-09',
      'Class Label': 'TEST Class A',
      Instructor: 'QA Legacy Instructor'
    });
    const inputBefore = structuredClone(input);
    let forwardedTimestamp = '';
    const response = await handleKioskSync(request({ body: { rows: [input] } }), {
      env: PRODUCTION_ENV,
      now: NOW_MS,
      dateNow: incidentDate,
      fetch: async (_url, options) => {
        forwardedTimestamp = JSON.parse(options.body).rows[0].Timestamp;
        return googleResponse([result(input)]);
      }
    });
    assert.equal(response.status, 200, inputSeconds);
    assert.equal(forwardedTimestamp, `2026-08-09 15:57:${expectedSeconds}`, inputSeconds);
    assert.deepEqual(input, inputBefore, inputSeconds);
  }
});

test('production accepts only safe one- or two-digit seconds and rejects malformed timestamps before Google', async () => {
  const incidentDate = new Date('2026-08-09T20:00:00Z');
  const malformed = [
    '2026-08-09 15:57:',
    '2026-08-09 15:57:003',
    '2026-08-09 15:57:60',
    '2026-08-09 15:57:99',
    '2026-08-09 15:57:+3',
    '2026-08-09 15:57:-1',
    '2026-08-09 15:60:3',
    '2026-08-09 24:00:3',
    '2026-08-09 15:57:a',
    '2026-08-09 15:7:3',
    '2026-08-09T15:57:3',
    '2026-08-09 15:57:3\n',
    3,
    null
  ];
  let fetchCalls = 0;

  for (const Timestamp of malformed) {
    const input = row({ Timestamp, Date: '2026-08-09' });
    const inputBefore = structuredClone(input);
    const response = await handleKioskSync(request({ body: { rows: [input] } }), {
      env: PRODUCTION_ENV,
      now: NOW_MS,
      dateNow: incidentDate,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('malformed timestamps must not reach Google');
      }
    });
    assert.equal(response.status, 200, String(Timestamp));
    assert.deepEqual((await body(response)).results, [{
      rowId: input.RowID,
      result: 'rejected',
      linkedRecordId: ''
    }], String(Timestamp));
    assert.deepEqual(input, inputBefore, String(Timestamp));
  }

  assert.equal(fetchCalls, 0);
});

test('production accepts only a complete exact target=production row acknowledgment', async t => {
  const first = row();
  const second = row({
    RowID: 'gib-m1-fedcba98-7654-4321-8fed-cba987654321',
    Instructor: 'Andrew Smith'
  });
  const cases = {
    wrongTarget: googleResponse([result(first), result(second)], 'test'),
    missing: googleResponse([result(first)]),
    duplicate: googleResponse([result(first), result(first)]),
    unrelated: googleResponse([
      result(first),
      result(row({ RowID: 'gib-m1-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))
    ]),
    malformed: googleResponse([
      result(first),
      { rowId: second.RowID, result: 'added', linkedRecordId: '', extra: true }
    ]),
    unreadable: new Response('<html>not readable</html>', { status: 200 })
  };
  for (const [name, upstream] of Object.entries(cases)) {
    await t.test(name, async () => {
      const response = await handleKioskSync(request({ body: { rows: [first, second] } }), {
        env: PRODUCTION_ENV,
        now: NOW_MS,
        dateNow: NOW,
        fetch: async () => upstream.clone()
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await body(response), {
        ok: false,
        message: 'Production sync did not return a complete readable acknowledgment.'
      });
    });
  }
});

test('production timeout and all browser-facing responses omit every secret', async () => {
  const response = await handleKioskSync(request(), {
    env: PRODUCTION_ENV,
    now: NOW_MS,
    dateNow: NOW,
    fetch: async () => {
      throw new DOMException('timeout', 'AbortError');
    }
  });
  const text = await response.text();
  assert.equal(response.status, 504);
  for (const secret of [
    PRODUCTION_WEBHOOK_URL,
    PRODUCTION_WEBHOOK_TOKEN,
    PRODUCTION_DEVICE_TOKEN,
    TEST_WEBHOOK_URL,
    TEST_WEBHOOK_TOKEN
  ]) assert.equal(text.includes(secret), false);
});
