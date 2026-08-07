import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  KIOSK_SYNC_PATH,
  config,
  handleKioskSync
} from '../netlify/functions/m1-kiosk-sync.mjs';

const ROOT = new URL('../', import.meta.url);
const source = readFileSync(new URL('netlify/functions/m1-kiosk-sync.mjs', ROOT), 'utf8');
const PREVIEW_ORIGIN = 'https://deploy-preview-123--gib-live.netlify.app';
const TEST_WEBHOOK_URL = ['https://script.google.com/macros/s/', 'SYNTHETIC_PREVIEW_RECEIVER', '/exec'].join('');
const TEST_TOKEN = ['synthetic', 'preview', 'transport', 'canary'].join('-');
const PRODUCTION_WEBHOOK_URL = ['https://script.google.com/macros/s/', 'SYNTHETIC_PRODUCTION_RECEIVER', '/exec'].join('');
const PRODUCTION_TOKEN = ['synthetic', 'production', 'transport', 'canary'].join('-');
const TEST_ENV = Object.freeze({
  GIB_TEST_WEBHOOK_URL: TEST_WEBHOOK_URL,
  GIB_TEST_WEBHOOK_TOKEN: TEST_TOKEN,
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-preview-admin-canary',
  GIB_M1_WEBHOOK_URL: PRODUCTION_WEBHOOK_URL,
  GIB_M1_WEBHOOK_TOKEN: PRODUCTION_TOKEN
});
const DATE_NOW = new Date('2026-08-07T16:00:00Z');

function row(overrides = {}) {
  return {
    RowID: 'gib-m1-12345678-1234-4123-8123-123456789abc',
    Timestamp: '2026-08-07 11:30:00',
    Date: '2026-08-07',
    'Class Label': '12:00 PM QA Test BJJ',
    'Duration (hr)': 1,
    Instructor: 'QA Fake Instructor',
    Site: 'Rev',
    Device: 'Preview browser',
    Build: 'test-build',
    Notes: 'Do not pay - automated test',
    ...overrides
  };
}

function request({
  origin = PREVIEW_ORIGIN,
  requestOrigin = origin,
  host = new URL(origin).host,
  fetchSite = 'same-origin',
  body = { rows: [row()] },
  path = KIOSK_SYNC_PATH
} = {}) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: requestOrigin,
      Host: host,
      'Sec-Fetch-Site': fetchSite
    },
    body: JSON.stringify(body)
  });
}

function googleResponse(results, extra = {}) {
  return new Response(JSON.stringify({ ok: true, target: 'test', results, ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function json(response) {
  return JSON.parse(await response.text());
}

function acknowledged(input, result = 'added', linkedRecordId = input.RowID) {
  return { rowId: input.RowID, result, linkedRecordId };
}

test('function route and preview boundary are exact and production never reaches Google', async () => {
  assert.match(source, /export const config = \{(?:\s*\/\/[^\r\n]*)*\s*path: '\/api\/m1-kiosk-sync'/u);
  assert.deepEqual(config, {
    path: KIOSK_SYNC_PATH,
    rateLimit: {
      windowLimit: 30,
      windowSize: 60,
      aggregateBy: ['ip', 'domain']
    }
  });

  const rejected = [
    request({ origin: 'https://gib-live.netlify.app' }),
    request({ origin: 'https://deploy-preview-123--other.netlify.app' }),
    request({ requestOrigin: 'https://evil.example' }),
    request({ host: 'evil.example' }),
    request({ fetchSite: 'cross-site' }),
    request({ path: `${KIOSK_SYNC_PATH}?mode=test` })
  ];
  let calls = 0;
  for (const candidate of rejected) {
    const response = await handleKioskSync(candidate, {
      env: TEST_ENV,
      dateNow: DATE_NOW,
      fetch: async () => {
        calls += 1;
        return googleResponse([]);
      }
    });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
});

test('browser submits rows only while server pins TEST transport, action, and target', async () => {
  const input = row();
  const browserBody = { rows: [input] };
  assert.equal(JSON.stringify(browserBody).includes(TEST_TOKEN), false);
  assert.equal(JSON.stringify(browserBody).includes(TEST_WEBHOOK_URL), false);

  let observedUrl = '';
  let observedOptions;
  const response = await handleKioskSync(request({ body: browserBody }), {
    env: TEST_ENV,
    dateNow: DATE_NOW,
    fetch: async (url, options) => {
      observedUrl = url;
      observedOptions = options;
      return googleResponse([acknowledged(input)]);
    }
  });
  const body = await json(response);
  const upstream = JSON.parse(observedOptions.body);

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    test: true,
    results: [acknowledged(input)]
  });
  assert.equal(observedUrl, TEST_WEBHOOK_URL);
  assert.equal(upstream.token, TEST_TOKEN);
  assert.equal(upstream.adminActionToken, '');
  assert.equal(upstream.action, 'kioskSignIn');
  assert.equal(upstream.target, 'test');
  assert.deepEqual(upstream.rows, [input]);
  assert.notEqual(observedUrl, PRODUCTION_WEBHOOK_URL);
  assert.notEqual(upstream.token, PRODUCTION_TOKEN);
  assert.ok(observedOptions.signal);

  let overrideCalls = 0;
  const browserOverride = await handleKioskSync(request({
    body: {
      rows: [input],
      token: PRODUCTION_TOKEN,
      target: 'production'
    }
  }), {
    env: TEST_ENV,
    dateNow: DATE_NOW,
    fetch: async () => {
      overrideCalls += 1;
      return googleResponse([acknowledged(input)]);
    }
  });
  assert.equal(browserOverride.status, 400);
  assert.equal(overrideCalls, 0);
});

test('invalid, non-permanent, and non-obviously-fake rows are rejected locally', async () => {
  const invalidId = row({ RowID: 'timestamp|Real Person|Class|Rev' });
  const realName = row({
    RowID: 'gib-m1-abcdefab-cdef-4abc-9def-abcdefabcdef',
    Instructor: 'Ordinary Instructor'
  });
  let calls = 0;
  const response = await handleKioskSync(request({ body: { rows: [invalidId, realName] } }), {
    env: TEST_ENV,
    dateNow: DATE_NOW,
    fetch: async () => {
      calls += 1;
      return googleResponse([]);
    }
  });
  assert.equal(calls, 0);
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).results, [
    { rowId: '', result: 'rejected', linkedRecordId: '' },
    { rowId: realName.RowID, result: 'rejected', linkedRecordId: '' }
  ]);
});

test('duplicate input RowIDs fail closed before Google', async () => {
  const input = row();
  let calls = 0;
  const response = await handleKioskSync(request({ body: { rows: [input, { ...input }] } }), {
    env: TEST_ENV,
    dateNow: DATE_NOW,
    fetch: async () => {
      calls += 1;
      return googleResponse([]);
    }
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('complete mixed row results are returned exactly without aliases', async () => {
  const added = row();
  const rejected = row({
    RowID: 'gib-m1-87654321-4321-4321-9876-cba987654321',
    Instructor: 'QA Fake Second Instructor'
  });
  const upstreamResults = [
    acknowledged(rejected, 'rejected', ''),
    acknowledged(added, 'already exists')
  ];
  const response = await handleKioskSync(request({ body: { rows: [added, rejected] } }), {
    env: TEST_ENV,
    dateNow: DATE_NOW,
    fetch: async () => googleResponse(upstreamResults)
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).results, [
    acknowledged(added, 'already exists'),
    acknowledged(rejected, 'rejected', '')
  ]);
});

test('timeout and unreadable Google responses fail without leaking canaries', async t => {
  await t.test('timeout or network rejection', async () => {
    const response = await handleKioskSync(request(), {
      env: TEST_ENV,
      dateNow: DATE_NOW,
      fetch: async () => {
        throw new DOMException('synthetic timeout containing no credentials', 'AbortError');
      }
    });
    const text = await response.text();
    assert.equal(response.status, 504);
    assert.equal(text.includes(TEST_TOKEN), false);
    assert.equal(text.includes(TEST_WEBHOOK_URL), false);
  });

  await t.test('HTML response', async () => {
    const response = await handleKioskSync(request(), {
      env: TEST_ENV,
      dateNow: DATE_NOW,
      fetch: async () => new Response('<!doctype html><html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    });
    assert.equal(response.status, 502);
  });
});

test('incomplete, duplicate, unrelated, and aliased results all fail closed', async t => {
  const first = row();
  const second = row({
    RowID: 'gib-m1-fedcba98-7654-4321-8fed-cba987654321',
    Instructor: 'QA Fake Second Instructor'
  });
  const cases = {
    incomplete: [acknowledged(first)],
    duplicate: [acknowledged(first), acknowledged(first)],
    unrelated: [
      acknowledged(first),
      acknowledged(row({ RowID: 'gib-m1-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))
    ],
    aliased: [acknowledged(first, 'duplicate'), acknowledged(second)],
    ambiguousLink: [acknowledged(first, 'added', ''), acknowledged(second)]
  };

  for (const [name, results] of Object.entries(cases)) {
    await t.test(name, async () => {
      const response = await handleKioskSync(request({ body: { rows: [first, second] } }), {
        env: TEST_ENV,
        dateNow: DATE_NOW,
        fetch: async () => googleResponse(results)
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await json(response), {
        ok: false,
        message: 'TEST sync did not return a complete readable acknowledgment.'
      });
    });
  }
});

test('a readable acknowledgment for any non-TEST target fails closed', async () => {
  const input = row();
  const response = await handleKioskSync(request({ body: { rows: [input] } }), {
    env: TEST_ENV,
    dateNow: DATE_NOW,
    fetch: async () => googleResponse([acknowledged(input)], { target: 'production' })
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await json(response), {
    ok: false,
    message: 'TEST sync did not return a complete readable acknowledgment.'
  });
});

test('secret canaries are absent from committed function source and browser-facing failures', async () => {
  assert.equal(source.includes(TEST_TOKEN), false);
  assert.equal(source.includes(TEST_WEBHOOK_URL), false);
  assert.equal(source.includes(PRODUCTION_TOKEN), false);
  assert.equal(source.includes(PRODUCTION_WEBHOOK_URL), false);
  assert.doesNotMatch(source, /console\.|Logger\./u);

  const missingConfig = await handleKioskSync(request(), {
    env: {},
    dateNow: DATE_NOW,
    fetch: async () => {
      throw new Error('must not fetch');
    }
  });
  const text = await missingConfig.text();
  assert.equal(missingConfig.status, 503);
  for (const canary of [TEST_TOKEN, TEST_WEBHOOK_URL, PRODUCTION_TOKEN, PRODUCTION_WEBHOOK_URL]) {
    assert.equal(text.includes(canary), false);
  }
});
