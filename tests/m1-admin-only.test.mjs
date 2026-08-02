import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  createAdminSession,
  isDeployPreview,
  postGoogle,
  readAdminSession,
  runtimeConfig,
  validAdminPassphrase,
  validNonFutureDate
} from '../netlify/functions/_lib/m1-common.mjs';
import { handleAdminAdd } from '../netlify/functions/m1-admin-add.mjs';
import { handleAdminLogin } from '../netlify/functions/m1-admin-login.mjs';
import { handleAdminLogout } from '../netlify/functions/m1-admin-logout.mjs';
import { handleAdminReview } from '../netlify/functions/m1-admin-review.mjs';
import { handleAdminSearch } from '../netlify/functions/m1-admin-search.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const guestHtml = read('guests/index.html');
const adminHtml = read('m1/admin/index.html');
const schedule = JSON.parse(read('m1/shared-schedule.json'));
const commonSource = read('netlify/functions/_lib/m1-common.mjs');
const receiverSource = read('integrations/google-apps-script/GibM1Receiver.gs');
const fixedNow = Date.parse('2026-07-26T15:00:00Z');
const fixedDateNow = new Date('2026-07-26T15:00:00Z');
const fixedRequestToken = Buffer.alloc(32, 9).toString('base64url');

const previewUrl = 'https://deploy-preview-99--gib-live.netlify.app';
const previewEnv = Object.freeze({
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/TEST_ID/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'test-receiver-token-long-enough'
});
const productionEnv = Object.freeze({
  GIB_M1_WEBHOOK_URL: 'https://script.google.com/macros/s/PROD_ID/exec',
  GIB_M1_WEBHOOK_TOKEN: 'production-receiver-token-long-enough',
  GIB_M1_ADMIN_ACTION_TOKEN: 'production-admin-action-token-long-enough',
  GIB_M1_ADMIN_PASSPHRASE: 'four memorable private words'
});

function jsonRequest(url, body, cookie = '', extraHeaders = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
}

function googleResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function adminHeaders(token = fixedRequestToken) {
  return { [ADMIN_REQUEST_HEADER]: token };
}

function previewCookie(adminName = 'Stuart Turner') {
  const config = runtimeConfig(previewEnv, {
    admin: true,
    requestUrl: `${previewUrl}/m1/admin/`
  });
  return `${ADMIN_COOKIE}=${encodeURIComponent(
    createAdminSession(adminName, config.sessionSecret, fixedNow, fixedRequestToken)
  )}`;
}

const SIGNIN_HEADERS = Object.freeze([
  'RowID',
  'Timestamp',
  'Date',
  'Class Label',
  'Duration (hr)',
  'Instructor',
  'Site',
  'Device',
  'Build',
  'Notes',
  'Status'
]);

function makeSheet(initialRows = []) {
  const values = initialRows.map(row => [...row]);
  return {
    values,
    appendRow(row) {
      values.push([...row]);
    },
    getDataRange() {
      return { getValues: () => values.map(row => [...row]) };
    },
    getLastRow() {
      return values.length;
    },
    getRange(startRow, startColumn, rowCount, columnCount) {
      return {
        getValues() {
          const rows = [];
          for (let row = 0; row < rowCount; row += 1) {
            const source = values[startRow - 1 + row] || [];
            rows.push(source.slice(startColumn - 1, startColumn - 1 + columnCount));
          }
          return rows;
        },
        setValues(rows) {
          rows.forEach((source, rowOffset) => {
            const rowIndex = startRow - 1 + rowOffset;
            if (!values[rowIndex]) values[rowIndex] = [];
            source.forEach((value, columnOffset) => {
              values[rowIndex][startColumn - 1 + columnOffset] = value;
            });
          });
        }
      };
    },
    setFrozenRows() {}
  };
}

function receiverHarness({
  testSpreadsheet = false,
  productionSpreadsheet = true,
  adminActionToken = '',
  rows = []
} = {}) {
  const signins = makeSheet([SIGNIN_HEADERS, ...rows]);
  let audit = null;
  let spreadsheetOpens = 0;
  const spreadsheet = {
    getName: () => 'Expected Signins',
    getSheetByName(name) {
      if (name === 'Signins') return signins;
      if (name === 'Admin Audit') return audit;
      return null;
    },
    insertSheet(name) {
      assert.equal(name, 'Admin Audit');
      audit = makeSheet();
      return audit;
    }
  };
  const context = {
    module: { exports: {} },
    exports: {},
    console,
    SECRET_TOKEN: 'receiver-token',
    EXPECTED_SPREADSHEET_NAME: 'Expected Signins',
    SHEET_NAME: 'Signins',
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return {
          text,
          setMimeType() { return this; }
        };
      }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock() {}
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => {
          assert.equal(name, 'GIB_M1_ADMIN_ACTION_TOKEN');
          return adminActionToken;
        }
      })
    },
    SpreadsheetApp: {
      openById() {
        spreadsheetOpens += 1;
        return spreadsheet;
      },
      flush() {}
    },
    Utilities: {
      formatDate(_value, _zone, pattern) {
        return pattern === 'yyyy-MM-dd HH:mm:ss'
          ? '2026-07-26 11:00:00'
          : '2026-07-26';
      }
    }
  };
  if (testSpreadsheet) context.TEST_SPREADSHEET_ID = 'test-spreadsheet';
  if (productionSpreadsheet) context.SPREADSHEET_ID = 'production-spreadsheet';
  const vmContext = vm.createContext(context);
  vm.runInContext(receiverSource, vmContext);
  return {
    apps: vmContext.module.exports,
    signins,
    get audit() { return audit; },
    get spreadsheetOpens() { return spreadsheetOpens; },
    post(body) {
      const output = vmContext.adReceiverV2_({
        postData: { contents: JSON.stringify(body) }
      });
      return JSON.parse(output.text);
    }
  };
}

function kioskRow(overrides = {}) {
  return {
    RowID: 'legacy-row',
    Timestamp: '2026-07-25 09:00:00',
    Date: '2026-07-25',
    'Class Label': '10:00 AM Kids\u2019 BJJ',
    'Duration (hr)': 0.5,
    Instructor: 'QA Test Instructor',
    Site: 'Rev',
    Device: 'Existing kiosk',
    Build: 'existing',
    Notes: '',
    ...overrides
  };
}

function adminAddition(overrides = {}) {
  return {
    token: 'receiver-token',
    adminActionToken: 'production-admin-token',
    action: 'addMissedInstructor',
    target: 'production',
    requestId: 'qa-admin-one',
    adminName: 'Stuart Turner',
    date: '2026-07-25',
    classLabel: '10:00 AM Kids\u2019 BJJ',
    duration: 0.5,
    instructor: 'QA Test Instructor',
    site: 'Rev',
    notes: '',
    reason: 'Missed tablet sign-in',
    ...overrides
  };
}

test('legacy {token, rows} payload remains readable and backward-compatible', () => {
  const harness = receiverHarness();
  const first = harness.post({ token: 'receiver-token', rows: [kioskRow()] });
  const retry = harness.post({ token: 'receiver-token', rows: [kioskRow()] });
  const mixed = harness.post({
    token: 'receiver-token',
    rows: [
      kioskRow({ RowID: 'second', Instructor: 'QA Second Test Instructor' }),
      { RowID: 'bad' }
    ]
  });
  assert.equal(first.ok, true);
  assert.equal(first.results[0].result, 'added');
  assert.equal(retry.results[0].result, 'already exists');
  assert.equal(mixed.results[0].result, 'added');
  assert.equal(mixed.results[1].result, 'rejected');
  assert.equal(harness.signins.values.length, 3);
  assert.match(receiverSource, /if \(!action && Array\.isArray\(body\.rows\)\) action = 'kioskSignIn'/);
});

test('receiver requires two credentials and an explicit target before Sheet access', () => {
  const missingProperty = receiverHarness();
  const receiverOnly = missingProperty.post({
    token: 'receiver-token',
    action: 'dailyReview',
    target: 'production',
    date: '2026-07-25'
  });
  assert.equal(receiverOnly.result, 'rejected');
  assert.equal(missingProperty.spreadsheetOpens, 0);

  const wrong = receiverHarness({ adminActionToken: 'correct-production-admin-token' });
  assert.equal(wrong.post({
    token: 'receiver-token',
    adminActionToken: 'wrong-production-admin-token',
    action: 'dailyReview',
    target: 'production',
    date: '2026-07-25'
  }).result, 'rejected');
  assert.equal(wrong.spreadsheetOpens, 0);

  const noTarget = receiverHarness({ adminActionToken: 'correct-production-admin-token' });
  assert.equal(noTarget.post({
    token: 'receiver-token',
    adminActionToken: 'correct-production-admin-token',
    action: 'dailyReview',
    date: '2026-07-25'
  }).result, 'rejected');
  assert.equal(noTarget.spreadsheetOpens, 0);

  const correct = receiverHarness({ adminActionToken: 'correct-production-admin-token' });
  const accepted = correct.post({
    token: 'receiver-token',
    adminActionToken: 'correct-production-admin-token',
    action: 'dailyReview',
    target: 'production',
    date: '2026-07-25'
  });
  assert.equal(accepted.ok, true);
  assert.equal(correct.spreadsheetOpens, 1);
});

test('TEST receiver reuses the existing TEST credential and requires fake instructor data', () => {
  const harness = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false
  });
  const review = harness.post({
    token: 'receiver-token',
    adminActionToken: 'receiver-token',
    action: 'dailyReview',
    target: 'test',
    date: '2026-07-25'
  });
  assert.equal(review.ok, true);
  assert.equal(harness.post({
    token: 'receiver-token',
    adminActionToken: 'receiver-token',
    action: 'instructorSearch',
    target: 'test',
    date: '2026-07-25',
    instructor: 'Real Person'
  }).result, 'rejected');
});

test('Netlify pins both backend credentials, action, and target', async () => {
  const observed = [];
  const previewConfig = runtimeConfig(previewEnv, {
    admin: true,
    requestUrl: `${previewUrl}/m1/admin/`
  });
  assert.equal(previewConfig.adminActionToken, previewEnv.GIB_TEST_WEBHOOK_TOKEN);
  await postGoogle(previewConfig, 'dailyReview', {
    date: '2026-07-25',
    token: 'browser-override',
    adminActionToken: 'browser-override',
    action: 'browser-override',
    target: 'production'
  }, async (_url, options) => {
    observed.push(JSON.parse(options.body));
    return googleResponse({ ok: true });
  });
  assert.deepEqual(
    {
      token: observed[0].token,
      adminActionToken: observed[0].adminActionToken,
      action: observed[0].action,
      target: observed[0].target
    },
    {
      token: previewEnv.GIB_TEST_WEBHOOK_TOKEN,
      adminActionToken: previewEnv.GIB_TEST_WEBHOOK_TOKEN,
      action: 'dailyReview',
      target: 'test'
    }
  );
});

test('production Admin configuration fails closed without every private value', () => {
  assert.equal(runtimeConfig({}, { admin: true, requestUrl: 'https://bjjsite.com/m1/admin/' }), null);
  assert.equal(runtimeConfig({
    ...productionEnv,
    GIB_M1_ADMIN_ACTION_TOKEN: ''
  }, { admin: true, requestUrl: 'https://bjjsite.com/m1/admin/' }), null);
  assert.equal(runtimeConfig({
    ...productionEnv,
    GIB_M1_ADMIN_PASSPHRASE: 'three weak words'
  }, { admin: true, requestUrl: 'https://bjjsite.com/m1/admin/' }), null);
  assert.equal(runtimeConfig(productionEnv, {
    admin: true,
    requestUrl: 'https://bjjsite.com/m1/admin/'
  }).adminActionToken, productionEnv.GIB_M1_ADMIN_ACTION_TOKEN);
});

test('Admin passphrase policy and production login are enforced', async () => {
  assert.equal(validAdminPassphrase('alpha beta gamma delta'), true);
  assert.equal(validAdminPassphrase('alpha-bravo-charlie-delta'), true);
  assert.equal(validAdminPassphrase('one two three four'), false);
  assert.equal(validAdminPassphrase('repeat repeat repeat repeat'), false);
  assert.equal(validAdminPassphrase('alpha beta gamma delta\n'), false);
  assert.equal(validAdminPassphrase('alpha beta gamma ' + 'd'.repeat(240)), false);

  const valid = await handleAdminLogin(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-admin-login', {
      adminName: 'Andrew Smith',
      passphrase: productionEnv.GIB_M1_ADMIN_PASSPHRASE,
      testShortcut: false
    }),
    {
      env: productionEnv,
      now: fixedNow,
      randomBytes: size => Buffer.alloc(size, 7)
    }
  );
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
});

test('TEST login shortcut is limited to the exact Deploy Preview host pattern', async () => {
  assert.equal(isDeployPreview({}, `${previewUrl}/m1/admin/`), true);
  assert.equal(isDeployPreview({}, 'https://bjjsite.com/m1/admin/'), false);
  assert.equal(isDeployPreview({}, 'https://deploy-preview-99--other.netlify.app/m1/admin/'), false);
  const preview = await handleAdminLogin(
    jsonRequest(`${previewUrl}/.netlify/functions/m1-admin-login`, {
      adminName: 'Stuart Turner',
      testShortcut: true
    }),
    { env: previewEnv, now: fixedNow }
  );
  assert.equal(preview.status, 200);
  const production = await handleAdminLogin(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-admin-login', {
      adminName: 'Stuart Turner',
      testShortcut: true
    }),
    { env: productionEnv, now: fixedNow }
  );
  assert.equal(production.status, 401);
});

test('per-login request token is signed, memory-only, and required by every protected endpoint', async () => {
  const config = runtimeConfig(previewEnv, {
    admin: true,
    requestUrl: `${previewUrl}/m1/admin/`
  });
  const signed = createAdminSession('Stuart Turner', config.sessionSecret, fixedNow, fixedRequestToken);
  assert.equal(readAdminSession(signed, config.sessionSecret, fixedNow).requestToken, fixedRequestToken);
  assert.doesNotMatch(adminHtml, /localStorage|sessionStorage|URLSearchParams/);
  assert.match(adminHtml, /let adminRequestToken = ''/);

  const cases = [
    [handleAdminReview, 'review', { date: '2026-07-25' }],
    [handleAdminSearch, 'search', { instructor: 'QA Test Instructor', date: '2026-07-25' }],
    [handleAdminAdd, 'add', {
      requestId: 'qa-auth',
      date: '2026-07-25',
      classLabel: '10:00 AM Kids\u2019 BJJ',
      duration: 0.5,
      instructor: 'QA Test Instructor',
      site: 'Rev',
      reason: 'Missed tablet sign-in'
    }]
  ];
  for (const [handler, name, body] of cases) {
    let calls = 0;
    const response = await handler(
      jsonRequest(`${previewUrl}/.netlify/functions/m1-admin-${name}`, body, previewCookie()),
      {
        env: previewEnv,
        now: fixedNow,
        dateNow: fixedDateNow,
        fetch: async () => {
          calls += 1;
          return googleResponse({ ok: true });
        }
      }
    );
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  }
});

test('valid session can review, search, add, and logout with no-store responses', async () => {
  const common = {
    env: previewEnv,
    now: fixedNow,
    dateNow: fixedDateNow
  };
  const review = await handleAdminReview(
    jsonRequest(
      `${previewUrl}/.netlify/functions/m1-admin-review`,
      { date: '2026-07-25' },
      previewCookie(),
      adminHeaders()
    ),
    {
      ...common,
      fetch: async () => googleResponse({
        ok: true,
        records: [{ recordId: 'one', instructor: 'QA Test Instructor' }]
      })
    }
  );
  assert.equal(review.status, 200);
  assert.equal((await review.json()).records.length, 1);
  assert.equal(review.headers.get('cache-control'), 'no-store, max-age=0');

  const search = await handleAdminSearch(
    jsonRequest(
      `${previewUrl}/.netlify/functions/m1-admin-search`,
      { date: '2026-07-25', instructor: 'QA Test Instructor' },
      previewCookie(),
      adminHeaders()
    ),
    {
      ...common,
      fetch: async () => googleResponse({
        ok: true,
        selectedDateRecords: [{ recordId: 'one' }],
        recentRecords: Array.from({ length: 8 }, (_, index) => ({ recordId: String(index) }))
      })
    }
  );
  const searchBody = await search.json();
  assert.equal(search.status, 200);
  assert.equal(searchBody.selectedDateRecords.length, 1);
  assert.equal(searchBody.recentRecords.length, 5);

  const add = await handleAdminAdd(
    jsonRequest(
      `${previewUrl}/.netlify/functions/m1-admin-add`,
      {
        requestId: 'qa-add',
        date: '2026-07-25',
        classLabel: '10:00 AM Kids\u2019 BJJ',
        duration: 0.5,
        instructor: 'QA Test Instructor',
        site: 'Rev',
        notes: '',
        reason: 'Missed tablet sign-in'
      },
      previewCookie(),
      adminHeaders()
    ),
    {
      ...common,
      fetch: async () => googleResponse({
        ok: true,
        result: 'added',
        linkedRecordId: 'gib-admin-qa-add',
        auditActionNumber: 1
      })
    }
  );
  assert.equal(add.status, 200);
  assert.equal((await add.json()).result, 'added');

  const logout = await handleAdminLogout(
    jsonRequest(
      `${previewUrl}/.netlify/functions/m1-admin-logout`,
      {},
      previewCookie(),
      adminHeaders()
    ),
    { env: previewEnv, now: fixedNow }
  );
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('Deploy Preview rejects real instructor input before Google', async () => {
  let calls = 0;
  const search = await handleAdminSearch(
    jsonRequest(
      `${previewUrl}/.netlify/functions/m1-admin-search`,
      { date: '2026-07-25', instructor: 'Real Instructor' },
      previewCookie(),
      adminHeaders()
    ),
    {
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: async () => {
        calls += 1;
        return googleResponse({ ok: true });
      }
    }
  );
  assert.equal(search.status, 400);
  assert.equal(calls, 0);
});

test('duplicate identity prevents cross-channel payroll duplicates and records audit', () => {
  const adminFirst = receiverHarness({ adminActionToken: 'production-admin-token' });
  assert.equal(adminFirst.post(adminAddition()).result, 'added');
  const delayed = adminFirst.post({
    token: 'receiver-token',
    rows: [kioskRow({ RowID: 'delayed-kiosk' })]
  });
  assert.equal(delayed.results[0].result, 'already exists');
  assert.equal(adminFirst.signins.values.length, 2);
  assert.equal(adminFirst.audit.values.length, 2);

  const kioskFirst = receiverHarness({ adminActionToken: 'production-admin-token' });
  assert.equal(kioskFirst.post({
    token: 'receiver-token',
    rows: [kioskRow()]
  }).results[0].result, 'added');
  assert.equal(kioskFirst.post(adminAddition()).result, 'already exists');
  assert.equal(kioskFirst.signins.values.length, 2);
  assert.equal(kioskFirst.audit.values.length, 2);
});

test('rapid Admin retry creates one payroll event and readable results', () => {
  const harness = receiverHarness({ adminActionToken: 'production-admin-token' });
  const first = harness.post(adminAddition());
  const retry = harness.post(adminAddition());
  assert.equal(first.result, 'added');
  assert.equal(retry.result, 'already exists');
  assert.equal(harness.signins.values.length, 2);
  assert.equal(harness.audit.values.length, 3);
  assert.ok(first.auditActionNumber > 0);
  assert.ok(retry.auditActionNumber > first.auditActionNumber);
});

test('rapid double-click reaches one added result and one duplicate-safe result', async () => {
  const events = new Set();
  let auditNumber = 0;
  const fetchMock = async (_url, options) => {
    const body = JSON.parse(options.body);
    const key = [
      body.date,
      String(body.instructor).toLocaleLowerCase('en-US'),
      String(body.classLabel).toLocaleLowerCase('en-US'),
      String(body.site).toLocaleLowerCase('en-US')
    ].join('|');
    const result = events.has(key) ? 'already exists' : 'added';
    events.add(key);
    auditNumber += 1;
    return googleResponse({
      ok: true,
      result,
      linkedRecordId: 'one-google-payroll-event',
      auditActionNumber: auditNumber
    });
  };
  const request = () => handleAdminAdd(
    jsonRequest(
      `${previewUrl}/.netlify/functions/m1-admin-add`,
      {
        requestId: 'qa-double-click',
        date: '2026-07-25',
        classLabel: '10:00 AM Kids\u2019 BJJ',
        duration: 0.5,
        instructor: 'QA Test Double Click',
        site: 'Rev',
        notes: '',
        reason: 'QA TEST missed sign-in'
      },
      previewCookie(),
      adminHeaders()
    ),
    {
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: fetchMock
    }
  );
  const responses = await Promise.all([request(), request()]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(bodies.map(body => body.result).sort(), ['added', 'already exists']);
  assert.equal(events.size, 1);
  assert.match(adminHtml, /if \(inFlightAdditions\.has\(key\)\) return/);
});

test('four-field identity normalizes harmless text and preserves legitimate distinct events', () => {
  const { apps } = receiverHarness();
  const first = {
    rowId: 'one',
    date: '2026-07-25',
    instructor: ' QA   TEST Instructor ',
    classLabel: '10:00 AM Kids\u2019 BJJ \u2013 Fundamentals',
    site: ' Rev ',
    status: 'OK'
  };
  const same = {
    ...first,
    rowId: 'two',
    instructor: 'qa test instructor',
    classLabel: "10:00 am kids' bjj - fundamentals",
    site: 'rev'
  };
  assert.equal(apps.findExistingEvent_([first], same), first);
  assert.equal(apps.findExistingEvent_([first], {
    ...same,
    rowId: 'different-instructor',
    instructor: 'QA Other Test Instructor'
  }), null);
  assert.equal(apps.findExistingEvent_([first], {
    ...same,
    rowId: 'different-class',
    classLabel: '11:00 AM BJJ'
  }), null);
  assert.equal(apps.findExistingEvent_([{ ...first, status: 'VOID' }], same), null);
  assert.equal(apps.findExistingEvent_([{ ...first, status: 'VOIDED' }], same), null);
});

test('Daily Review workflow is yesterday-first, date-selectable, complete, and explicit about limits', () => {
  assert.equal(Object.keys(schedule.days).length, 7);
  Object.values(schedule.days).forEach(classes => assert.equal(Array.isArray(classes), true));
  assert.match(adminHtml, /function defaultYesterday\(\)/);
  assert.match(adminHtml, /loadReview\(defaultYesterday\(\)\)/);
  assert.match(adminHtml, /Previous day/);
  assert.match(adminHtml, /Yesterday/);
  assert.match(adminHtml, /Today/);
  assert.match(adminHtml, /Next day/);
  assert.match(adminHtml, /No sign-in recorded/);
  assert.match(adminHtml, /Recorded sign-ins not matched to this schedule/);
  assert.match(adminHtml, /Find an Instructor/);
  assert.match(adminHtml, /Five recent active sign-ins/);
  assert.match(
    adminHtml,
    /Daily Review uses the shared Rev schedule\. Local schedule edits and Series classes must also be added to the shared schedule or they will not appear as blanks\./
  );
  assert.equal(validNonFutureDate('2025-01-10', fixedDateNow), true);
  assert.equal(validNonFutureDate('2026-07-27', fixedDateNow), false);
});

test('Admin addition UX has fixed fields, reason, confirmation, refresh, and Admin label', () => {
  assert.match(adminHtml, /fixedValue\('Date'/);
  assert.match(adminHtml, /fixedValue\('Class'/);
  assert.match(adminHtml, /fixedValue\('Site'/);
  assert.match(adminHtml, /fixedValue\('Duration'/);
  assert.match(adminHtml, /Required reason/);
  assert.match(adminHtml, /Notes \(optional\)/);
  assert.match(adminHtml, /window\.confirm\(/);
  assert.match(adminHtml, /await loadReview\(currentDate\)/);
  assert.match(adminHtml, /Admin-added/);
  assert.doesNotMatch(adminHtml, /payroll approval|dashboard|analytics|void sign-in/i);
  assert.doesNotMatch(adminHtml, /<button[^>]*>[^<]*(?:schedule|void|approve)/i);
});

test('guest payload renders literally as text with no element, handler, code, or Admin call', () => {
  const payload = '<img src=x onerror="window.__GIB_XSS_EXECUTED__=true">';
  function fakeElement(tagName) {
    let ownText = '';
    return {
      tagName: String(tagName).toUpperCase(),
      className: '',
      style: {},
      childNodes: [],
      appendChild(child) {
        this.childNodes.push(child);
        return child;
      },
      replaceChildren(...children) {
        this.childNodes = children;
      },
      get textContent() {
        return ownText + this.childNodes.map(child => child.textContent || '').join('');
      },
      set textContent(value) {
        ownText = String(value);
        this.childNodes = [];
      }
    };
  }
  const entriesWrap = fakeElement('div');
  const jsonOutput = { value: '' };
  let fetchCalls = 0;
  const renderer = guestHtml.slice(
    guestHtml.indexOf('const renderEntries = () =>'),
    guestHtml.indexOf('const resetForm = () =>')
  );
  const context = vm.createContext({
    document: { createElement: fakeElement },
    entriesWrap,
    jsonOutput,
    fetch: () => { fetchCalls += 1; },
    window: { __GIB_XSS_EXECUTED__: false },
    entries: [{
      name: payload,
      organization: payload,
      type: payload,
      checkIn: payload,
      notes: payload
    }]
  });
  vm.runInContext(`${renderer}\nrenderEntries();`, context);
  const tags = [];
  const cells = [];
  (function walk(node) {
    if (node.tagName) {
      tags.push(node.tagName);
      if (node.tagName === 'TD') cells.push(node.textContent);
    }
    (node.childNodes || []).forEach(walk);
  })(entriesWrap);
  assert.deepEqual(cells, [payload, payload, payload, payload, payload]);
  assert.equal(tags.includes('IMG'), false);
  assert.equal(context.window.__GIB_XSS_EXECUTED__, false);
  assert.equal(fetchCalls, 0);
});

test('touched browser pages contain no executable-markup sink', () => {
  const forbidden = [
    /\.innerHTML\s*=/iu,
    /\.outerHTML\s*=/iu,
    /\.insertAdjacentHTML\s*\(/iu,
    /\bdocument\.write(?:ln)?\s*\(/iu,
    /\beval\s*\(/iu,
    /(?:\bnew\s+)?\bFunction\s*\(/u,
    /\son[a-z]+\s*=/iu
  ];
  for (const [name, html] of [['Admin', adminHtml], ['guests', guestHtml]]) {
    forbidden.forEach(pattern => assert.doesNotMatch(html, pattern, `${name} contains ${pattern}`));
  }
});

test('browser source has no backend credential, private Sheet, or deployment ID', () => {
  const browserSource = [adminHtml, guestHtml, JSON.stringify(schedule)].join('\n');
  assert.doesNotMatch(
    browserSource,
    /script\.google\.com|GIB_(?:TEST|M1)_(?:WEBHOOK|ADMIN_ACTION)|AKfy[A-Za-z0-9_-]{20,}|1[A-Za-z0-9_-]{30,}/
  );
  assert.doesNotMatch(browserSource, /production-receiver-token|production-admin-action-token|four memorable private words/);
  assert.doesNotMatch(commonSource + receiverSource, /AKfy[A-Za-z0-9_-]{20,}/);
});

test('candidate source and config contain no live-system mutation command', () => {
  const source = [
    commonSource,
    receiverSource,
    read('netlify.toml'),
    read('_headers'),
    read('_redirects')
  ].join('\n');
  assert.doesNotMatch(source, /netlify\s+deploy\s+--prod|production_deploy|setEnvVarValue|updateEnvVar|clasp\s+deploy/i);
  assert.doesNotMatch(source, /bjjsite\.com|AKfy[A-Za-z0-9_-]{20,}/);
  assert.match(receiverSource, /GIB_M1_ADMIN_ACTION_TOKEN/);
  assert.doesNotMatch(receiverSource, /GIB_M1_ADMIN_ACTION_TOKEN\s*=\s*['"][^'"]{12,}/);
});

test('all inline scripts on touched production pages compile', () => {
  for (const [name, html] of [['Admin', adminHtml], ['guests', guestHtml]]) {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)]
      .map(match => match[1])
      .filter(source => source.trim());
    scripts.forEach((source, index) => {
      assert.doesNotThrow(() => new vm.Script(source, { filename: `${name}-inline-${index}.js` }));
    });
  }
});
