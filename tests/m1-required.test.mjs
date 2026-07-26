import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  KIOSK_DEVICE_HEADER,
  createAdminSession,
  isDeployPreview,
  postGoogle,
  readAdminSession,
  runtimeConfig,
  sanitizeKioskRows,
  validAdminPassphrase,
  validNonFutureDate
} from '../netlify/functions/_lib/m1-common.mjs';
import { handleAdminAdd } from '../netlify/functions/m1-admin-add.mjs';
import { handleAdminLogin } from '../netlify/functions/m1-admin-login.mjs';
import { handleAdminLogout } from '../netlify/functions/m1-admin-logout.mjs';
import { handleAdminReview } from '../netlify/functions/m1-admin-review.mjs';
import { handleAdminSearch } from '../netlify/functions/m1-admin-search.mjs';
import { handleKioskSync } from '../netlify/functions/m1-kiosk-sync.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const rootHtml = read('index.html');
const guestHtml = read('guests/index.html');
const kioskHtml = read('m1/index.html');
const adminHtml = read('m1/admin/index.html');
const productionHtmlPages = Object.freeze([
  ['/', rootHtml],
  ['/guests', guestHtml],
  ['/m1', kioskHtml],
  ['/m1/admin', adminHtml]
]);
const schedule = JSON.parse(read('m1/shared-schedule.json'));
const appsScriptSource = read('integrations/google-apps-script/GibM1Receiver.gs');

const kioskContext = vm.createContext({});
vm.runInContext(read('m1/kiosk-safety.js'), kioskContext);
const safety = kioskContext.GibM1Safety;

const appsContext = vm.createContext({
  module: { exports: {} },
  exports: {},
  console,
  Utilities: {
    formatDate: () => '2026-07-26'
  }
});
vm.runInContext(appsScriptSource, appsContext);
const apps = appsContext.module.exports;

const previewEnv = Object.freeze({
  CONTEXT: 'deploy-preview',
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/TEST_ID/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'test-token-long-enough'
});
const productionEnv = Object.freeze({
  CONTEXT: 'production',
  GIB_M1_WEBHOOK_URL: 'https://script.google.com/macros/s/PROD_ID/exec',
  GIB_M1_WEBHOOK_TOKEN: 'production-token-long-enough',
  GIB_M1_ADMIN_PASSPHRASE: 'four memorable words here',
  GIB_M1_KIOSK_DEVICE_TOKEN: 'correct-production-device-token'
});
const fixedNow = Date.parse('2026-07-26T15:00:00Z');
const fixedDateNow = new Date('2026-07-26T15:00:00Z');
const fixedAdminRequestToken = Buffer.alloc(32, 9).toString('base64url');

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

function previewCookie(adminName = 'Stuart Turner') {
  const config = runtimeConfig(previewEnv, {
    admin: true,
    requestUrl: 'https://deploy-preview-44--gib-live.netlify.app/m1/admin/'
  });
  return `${ADMIN_COOKIE}=${encodeURIComponent(
    createAdminSession(adminName, config.sessionSecret, fixedNow, fixedAdminRequestToken)
  )}`;
}

function adminHeaders(token = fixedAdminRequestToken) {
  return { [ADMIN_REQUEST_HEADER]: token };
}

function googleResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function kioskRow(overrides = {}) {
  return {
    RowID: 'legacy|QA Test Instructor|6:00 AM BJJ (Level 2)|Rev',
    Timestamp: '2026-07-25 09:00:00',
    Date: '2026-07-25',
    'Class Label': '10:00 AM Kids’ BJJ',
    'Duration (hr)': 0.5,
    Instructor: 'QA Test Instructor',
    Site: 'Rev',
    Device: 'QA Tablet',
    Build: 'qa',
    Notes: 'QA fake row',
    ...overrides
  };
}

function parityTabletRows(overrides = {}) {
  const queueRow = kioskRow(overrides);
  const ledgerRow = {
    Timestamp: queueRow.Timestamp,
    Date: queueRow.Date,
    'Class Label': queueRow['Class Label'],
    'Duration (hr)': queueRow['Duration (hr)'],
    Instructor: queueRow.Instructor,
    Site: queueRow.Site,
    Notes: queueRow.Notes,
    Status: 'OK',
    __syncState: 'never-sent',
    __rowId: queueRow.RowID
  };
  return { ledgerRow, queueRow };
}

function settleTabletSync(ledger, queue, response) {
  const applied = safety.applyReadableResults(queue, response);
  return {
    readable: applied.readable,
    completed: applied.completed,
    ledger: safety.markCompletedLedgerRows(ledger, applied.completed),
    queue: applied.remaining
  };
}

function activeTabletEventRows(rows, event) {
  const key = safety.eventKey(event);
  return rows.filter(row =>
    safety.isActiveLedgerRow(row) && safety.eventKey(row) === key
  );
}

function activeGoogleEventRows(rows, event) {
  return rows.filter(row => apps.activeRecord_(row) && apps.sameEvent_(row, event));
}

function generatedPayrollCsv(rows) {
  const buildCsvSource = kioskHtml.slice(
    kioskHtml.indexOf('function buildCSV()'),
    kioskHtml.indexOf('async function exportCSV()')
  );
  const context = vm.createContext({
    PAYROLL_HEADERS: [
      'Timestamp',
      'Date',
      'Class Label',
      'Duration (hr)',
      'Instructor',
      'Site',
      'Notes'
    ],
    exportableSignins: () => rows.filter(safety.isActiveLedgerRow)
  });
  vm.runInContext(`${buildCsvSource}\nglobalThis.csv = buildCSV();`, context);
  return context.csv;
}

function csvEventCount(csv, event) {
  return String(csv).split('\n').slice(1).filter(line => {
    const columns = line.split(',');
    return columns[1] === String(event.Date || event.date).slice(0, 10)
      && safety.normalize(columns[2]) === safety.normalize(event['Class Label'] || event.classLabel)
      && safety.normalize(columns[4]) === safety.normalize(event.Instructor || event.instructor)
      && safety.normalize(columns[5]) === safety.normalize(event.Site || event.site);
  }).length;
}

async function syncTabletAgainstGoogle(ledger, queue, googleRows) {
  const response = await handleKioskSync(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-kiosk-sync',
      { rows: queue }
    ),
    {
      env: previewEnv,
      fetch: async (_url, options) => {
        const posted = JSON.parse(options.body);
        const results = posted.rows.map(row => {
          const candidate = apps.validateKioskRow_(row);
          const existing = apps.findExistingEvent_(googleRows, candidate);
          if (existing) {
            return {
              rowId: candidate.rowId,
              result: 'already exists',
              linkedRecordId: existing.rowId
            };
          }
          googleRows.push({ ...candidate, status: 'OK' });
          return {
            rowId: candidate.rowId,
            result: 'added',
            linkedRecordId: candidate.rowId
          };
        });
        return googleResponse({ ok: true, results });
      }
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  return {
    body,
    ...settleTabletSync(ledger, queue, body)
  };
}

test('01 first-run setup blocks sign-in until gym, location, and site exist', () => {
  assert.match(kioskHtml, /missingDeviceSetupFields/);
  assert.match(kioskHtml, /Device setup required before sign-in/);
});

test('02 normal sign-in creates one safe row', () => {
  assert.equal(sanitizeKioskRows([kioskRow()]).length, 1);
  assert.match(kioskHtml, /commitSigninTransaction\(rows, newRows, queuedRows\)/);
});

test('03 multi-class sign-in preserves two distinct waiting rows', () => {
  const ledger = [
    { ...kioskRow({ RowID: 'one', __rowId: 'one' }), Status: 'OK' },
    { ...kioskRow({ RowID: 'two', __rowId: 'two', 'Class Label': '11:00 AM BJJ (Level 2)' }), Status: 'OK' }
  ];
  const queue = ledger.map(row => ({ ...row }));
  assert.equal(safety.reconcileQueue(queue, ledger).length, 2);
});

test('04 duplicate warning normalizes harmless name, apostrophe, dash, and space differences', () => {
  const rows = [kioskRow({
    Instructor: '  QA   TEST Instructor ',
    'Class Label': '10:00 AM Kids’ BJJ – Fundamentals'
  })];
  const duplicates = safety.duplicateClasses(
    rows,
    '2026-07-25',
    'qa test instructor',
    ' rev ',
    ["10:00 AM Kids' BJJ - Fundamentals"]
  );
  assert.equal(duplicates.length, 1);
  assert.match(kioskHtml, /Possible duplicate payroll sign-in/);
  const duplicateGuard = kioskHtml.slice(
    kioskHtml.indexOf('if (duplicateClasses.length)'),
    kioskHtml.indexOf('const batchId')
  );
  assert.match(duplicateGuard, /return;/);
  assert.doesNotMatch(duplicateGuard, /saveSignins|commitSigninTransaction/);
});

test('05 reload persistence keeps the established sign-in key', () => {
  assert.match(kioskHtml, /const SIGNINS_KEY = 'gib_m1_signins_v1'/);
});

test('06 browser-restart persistence keeps the established waiting-list key', () => {
  assert.match(kioskHtml, /const SYNC_QUEUE_KEY\s+= 'gib_m1_sync_queue_v1'/);
});

test('07 failed send keeps the row waiting', () => {
  const row = kioskRow();
  const result = safety.applyReadableResults([row], null);
  assert.equal(result.readable, false);
  assert.equal(result.remaining.length, 1);
});

test('08 unclear result keeps the row waiting', () => {
  const row = kioskRow();
  const result = safety.applyReadableResults([row], { ok: true, message: 'sent' });
  assert.equal(result.readable, false);
  assert.equal(result.remaining.length, 1);
});

test('09 readable added result removes the waiting row', () => {
  const row = kioskRow();
  const result = safety.applyReadableResults([row], {
    ok: true,
    results: [{ rowId: row.RowID, result: 'added' }]
  });
  assert.equal(result.remaining.length, 0);
  assert.equal(result.completed.length, 1);
});

test('10 readable already-exists result removes the waiting row safely', () => {
  const row = kioskRow();
  const result = safety.applyReadableResults([row], {
    ok: true,
    results: [{ rowId: row.RowID, result: 'already exists' }]
  });
  assert.equal(result.remaining.length, 0);
});

test('11 Undo removes its ledger batch and reconciles the waiting list', () => {
  assert.match(kioskHtml, /nextRows = rows\.filter\(r => r\.__batchId !== lastSigninBatchId\)/);
  assert.match(kioskHtml, /pendingAutoSyncBatchId = null;\s+reconcileSyncQueue\(\)/);
});

test('12 Void removes the corresponding unsent row and export excludes it', () => {
  const neverSent = { ...kioskRow(), Status: 'OK', __syncState: 'never-sent' };
  const voided = { ...neverSent, Status: 'VOID' };
  assert.equal(safety.reconcileQueue([kioskRow()], [voided]).length, 0);
  assert.equal(safety.queueContainsLedgerRow([kioskRow()], neverSent), true);
  assert.equal(
    safety.queueContainsLedgerRow(
      [kioskRow({ RowID: 'different-id' })],
      neverSent
    ),
    false
  );
  const attempted = safety.markAttemptedLedgerRows(
    [neverSent],
    [kioskRow()],
    '2026-07-26T15:00:00.000Z'
  );
  assert.equal(attempted[0].__syncState, 'attempted');
  assert.equal(safety.queueContainsLedgerRow([kioskRow()], attempted[0]), true);
  const voidBody = kioskHtml.slice(
    kioskHtml.indexOf('function voidLastSignin()'),
    kioskHtml.indexOf('// --- Sync helpers ---')
  );
  assert.match(voidBody, /__syncState !== 'never-sent'/);
  assert.match(kioskHtml, /saveSignins\(rows\);\s+reconcileSyncQueue\(\);\s+updateSyncStatus\(\)/);
  assert.match(kioskHtml, /Local Void is blocked so the payroll Sheet and export cannot disagree/);
});

test('13 Clear All leaves no orphaned waiting rows', () => {
  assert.equal(safety.reconcileQueue([kioskRow()], []).length, 0);
  assert.match(kioskHtml, /hasConfirmedOrUnknown/);
  assert.match(kioskHtml, /saveSignins\(\[\]\);[\s\S]*?reconcileSyncQueue\(\)/);
});

test('14 Reset preserves sign-ins and the waiting list while Factory Reset names both', () => {
  const resetBody = kioskHtml.slice(
    kioskHtml.indexOf('function resetDevice()'),
    kioskHtml.indexOf('function factoryReset()')
  );
  const factoryBody = kioskHtml.slice(
    kioskHtml.indexOf('function factoryReset()'),
    kioskHtml.indexOf('function getSiteCode()')
  );
  assert.doesNotMatch(resetBody, /removeItem\(SIGNINS_KEY\)|removeItem\(SYNC_QUEUE_KEY\)/);
  assert.match(resetBody, /removeItem\(KIOSK_DEVICE_TOKEN_KEY\)/);
  assert.match(resetBody, /removeItem\(LEGACY_SYNC_URL_KEY\)/);
  assert.match(resetBody, /removeItem\(LEGACY_SYNC_TOKEN_KEY\)/);
  assert.doesNotMatch(resetBody, /reconcileSyncQueue\(\)/);
  assert.match(resetBody, /updateSyncStatus\(\{ reconcile: false \}\)/);
  assert.match(factoryBody, /removeItem\(LEGACY_SYNC_URL_KEY\)/);
  assert.match(factoryBody, /removeItem\(LEGACY_SYNC_TOKEN_KEY\)/);
  assert.match(kioskHtml, /Factory reset will DELETE all device info, schedule data, sign-ins, and waiting payroll rows/);
});

test('15 Admin endpoints require a signed session', async () => {
  const response = await handleAdminReview(
    jsonRequest('https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-review', { date: '2026-07-25' }),
    { env: previewEnv, now: fixedNow, dateNow: fixedDateNow }
  );
  assert.equal(response.status, 401);
});

test('16 TEST login shortcut works only in a Deploy Preview', async () => {
  assert.equal(
    isDeployPreview({}, 'https://deploy-preview-44--gib-live.netlify.app/m1/admin/'),
    true
  );
  assert.equal(isDeployPreview({}, 'https://bjjsite.com/m1/admin/'), false);
  assert.equal(
    isDeployPreview({}, 'https://deploy-preview-44--different-site.netlify.app/m1/admin/'),
    false
  );
  const preview = await handleAdminLogin(
    jsonRequest('https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-login', {
      adminName: 'Stuart Turner',
      testShortcut: true
    }),
    {
      env: {
        GIB_TEST_WEBHOOK_URL: previewEnv.GIB_TEST_WEBHOOK_URL,
        GIB_TEST_WEBHOOK_TOKEN: previewEnv.GIB_TEST_WEBHOOK_TOKEN
      },
      now: fixedNow
    }
  );
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.match(previewBody.requestToken, /^[A-Za-z0-9_-]{43}$/);
  const production = await handleAdminLogin(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-admin-login', {
      adminName: 'Stuart Turner',
      testShortcut: true
    }),
    { env: productionEnv, now: fixedNow }
  );
  assert.equal(production.status, 401);
});

test('17 logout clears the secure HTTP-only cookie and protected responses are no-store', async () => {
  const response = await handleAdminLogout(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-logout',
      {},
      previewCookie(),
      adminHeaders()
    ),
    { env: previewEnv, now: fixedNow }
  );
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
});

test('18 Yesterday is the Admin default in America/New_York', () => {
  assert.match(adminHtml, /function defaultYesterday\(\)/);
  assert.match(adminHtml, /loadReview\(defaultYesterday\(\)\)/);
  assert.match(adminHtml, /America\/New_York/);
});

test('19 Daily class list uses the one shared schedule source', () => {
  assert.equal(Object.keys(schedule.days).length, 7);
  assert.match(kioskHtml, /fetch\('\/m1\/shared-schedule\.json'/);
  assert.match(adminHtml, /fetch\('\/m1\/shared-schedule\.json'/);
  assert.doesNotMatch(kioskHtml, /Default schedule snapshot \(Rev\)/);
  assert.doesNotMatch(kioskHtml, /const DEFAULT_SCHEDULE = \{/);
  assert.doesNotMatch(adminHtml, /6:00 AM BJJ \(Level 2\)/);
});

test('20 Older non-future dates work and future dates fail closed', () => {
  assert.equal(validNonFutureDate('2025-01-10', fixedDateNow), true);
  assert.equal(validNonFutureDate('2026-07-27', fixedDateNow), false);
});

test('21 Instructor search returns the selected date and recent records', async () => {
  const response = await handleAdminSearch(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-search',
      { instructor: 'QA Test Instructor', date: '2026-07-25' },
      previewCookie(),
      adminHeaders()
    ),
    {
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: async () => googleResponse({
        ok: true,
        selectedDateRecords: [{ recordId: 'one' }],
        recentRecords: [{ recordId: 'one' }]
      })
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.selectedDateRecords.length, 1);
});

test('22 Google limits recent active sign-ins to five', () => {
  assert.match(appsScriptSource, /\.slice\(0, 5\)\.map\(publicRecord_\)/);
  assert.match(adminHtml, /Five recent active sign-ins/);
});

test('23 One blank can be filled with a confirmed Admin addition', async () => {
  const response = await handleAdminAdd(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-add',
      {
        requestId: 'qa-add-1',
        date: '2026-07-25',
        classLabel: '10:00 AM Kids’ BJJ',
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
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: async () => googleResponse({
        ok: true,
        result: 'added',
        linkedRecordId: 'gib-admin-qa-add-1',
        auditActionNumber: 1
      })
    }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result, 'added');
  assert.match(adminHtml, /window\.confirm\(/);
});

test('24 Every Admin addition records the required separate audit fields', () => {
  [
    'Action Number',
    'Admin Name',
    'Action Time',
    'Instructor',
    'Class Date',
    'Class',
    'Site',
    'Duration',
    'Required Reason',
    'Final Result',
    'Linked Sign-in Record ID'
  ].forEach(header => assert.ok(appsScriptSource.includes(`'${header}'`)));
  assert.match(appsScriptSource, /insertSheet\(GIB_M1_AUDIT_SHEET_\)/);
});

test('25 Rapid double-click produces one added result and one already-exists result', async () => {
  const seen = new Set();
  let audit = 0;
  const fetchMock = async (_url, options) => {
    const body = JSON.parse(options.body);
    const key = [body.date, safety.normalize(body.instructor), safety.normalize(body.classLabel), safety.normalize(body.site)].join('|');
    const result = seen.has(key) ? 'already exists' : 'added';
    seen.add(key);
    audit += 1;
    return googleResponse({
      ok: true,
      result,
      linkedRecordId: 'record-one',
      auditActionNumber: audit
    });
  };
  const payload = {
    requestId: 'qa-double',
    date: '2026-07-25',
    classLabel: '10:00 AM Kids’ BJJ',
    duration: 0.5,
    instructor: 'QA Test Double',
    site: 'Rev',
    notes: '',
    reason: 'Missed tablet sign-in'
  };
  const make = () => handleAdminAdd(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-add',
      payload,
      previewCookie(),
      adminHeaders()
    ),
    { env: previewEnv, now: fixedNow, dateNow: fixedDateNow, fetch: fetchMock }
  );
  const responses = await Promise.all([make(), make()]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(results.map(result => result.result).sort(), ['added', 'already exists']);
  assert.equal(seen.size, 1);
});

test('26 Exact Admin retry finds the original active row instead of appending', () => {
  const record = {
    rowId: 'gib-admin-request-1',
    date: '2026-07-25',
    instructor: 'QA Test Retry',
    classLabel: '10:00 AM Kids’ BJJ',
    site: 'Rev',
    status: 'OK'
  };
  assert.equal(apps.findExistingEvent_([record], { ...record }), record);
});

test('27 Kiosk first then Admin add yields one active payroll event', () => {
  const kiosk = {
    rowId: 'legacy-row',
    date: '2026-07-25',
    instructor: 'QA Test Cross',
    classLabel: '10:00 AM Kids’ BJJ',
    site: 'Rev',
    status: 'OK'
  };
  const admin = { ...kiosk, rowId: 'gib-admin-cross', instructor: ' qa  test cross ' };
  assert.equal(apps.findExistingEvent_([kiosk], admin), kiosk);
});

test('28 Admin first then delayed kiosk row yields one active payroll event', () => {
  const admin = {
    rowId: 'gib-admin-cross',
    date: '2026-07-25',
    instructor: 'QA Test Cross',
    classLabel: '10:00 AM Kids’ BJJ',
    site: 'Rev',
    status: 'OK'
  };
  const delayed = { ...admin, rowId: 'old|format|row', instructor: 'QA TEST CROSS' };
  assert.equal(apps.findExistingEvent_([admin], delayed), admin);
});

test('29 Different class for the same instructor and date is not wrongly blocked', () => {
  const first = {
    rowId: 'one',
    date: '2026-07-25',
    instructor: 'QA Test Instructor',
    classLabel: '10:00 AM Kids’ BJJ',
    site: 'Rev',
    status: 'OK'
  };
  const second = { ...first, rowId: 'two', classLabel: '11:00 AM BJJ (Level 2)' };
  assert.equal(apps.findExistingEvent_([first], second), null);
});

test('29b Different instructor for the same class, date, and site is not wrongly blocked', () => {
  const first = {
    rowId: 'one',
    date: '2026-07-25',
    instructor: 'QA First Instructor',
    classLabel: '10:00 AM Kidsâ€™ BJJ',
    site: 'Rev',
    status: 'OK'
  };
  const second = { ...first, rowId: 'two', instructor: 'QA Second Instructor' };
  assert.equal(apps.findExistingEvent_([first], second), null);
  assert.doesNotMatch(appsScriptSource, /sameClassSlot_/);
});

test('30 A VOID or VOIDED matching record does not block a new active record', () => {
  const voided = {
    rowId: 'voided',
    date: '2026-07-25',
    instructor: 'QA Test Instructor',
    classLabel: '10:00 AM Kids’ BJJ',
    site: 'Rev',
    status: 'VOIDED'
  };
  assert.equal(apps.findExistingEvent_([voided], { ...voided, rowId: 'new', status: 'OK' }), null);
  assert.equal(safety.reconcileQueue([kioskRow()], [{ ...kioskRow(), Status: 'VOID' }]).length, 0);
});

test('31 Exact kiosk retry returns the original safe already-exists result', async () => {
  const row = kioskRow({ RowID: 'exact-retry' });
  const response = await handleKioskSync(
    jsonRequest('https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-kiosk-sync', { rows: [row] }),
    {
      env: previewEnv,
      fetch: async () => googleResponse({
        ok: true,
        results: [{ rowId: 'exact-retry', result: 'already exists', linkedRecordId: 'exact-retry' }]
      })
    }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].result, 'already exists');
});

test('32 Browser code contains no Google webhook URL, environment token, or embedded credential', () => {
  const browserSource = [
    kioskHtml,
    adminHtml,
    read('m1/kiosk-safety.js'),
    read('m1/shared-schedule.json')
  ].join('\n');
  assert.doesNotMatch(browserSource, /script\.google\.com|GIB_TEST_WEBHOOK|GIB_M1_WEBHOOK|SECRET_TOKEN|TEST_[A-Za-z0-9_-]{20,}/);
});

test('33 Candidate source contains no concrete webhook secret or private deployment address', () => {
  const repositorySource = [
    read('netlify/functions/_lib/m1-common.mjs'),
    appsScriptSource,
    kioskHtml,
    adminHtml
  ].join('\n');
  assert.doesNotMatch(repositorySource, /AKfy[a-zA-Z0-9_-]{20,}|TEST_-[a-zA-Z0-9_-]{20,}/);
});

test('34 Production functions refuse to operate without production settings', async () => {
  const response = await handleKioskSync(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-kiosk-sync', { rows: [kioskRow()] }),
    { env: { CONTEXT: 'production' } }
  );
  assert.equal(response.status, 503);
  assert.equal(runtimeConfig({ CONTEXT: 'production' }, { admin: true }), null);
});

test('35 Production never accepts the TEST shortcut', async () => {
  const response = await handleAdminLogin(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-admin-login', {
      adminName: 'Andrew Smith',
      testShortcut: true
    }),
    { env: productionEnv, now: fixedNow }
  );
  assert.equal(response.status, 401);
});

test('36 No real Sheet identity, row, or payroll value is present in the candidate', () => {
  assert.match(appsScriptSource, /EXPECTED_SPREADSHEET_NAME/);
  assert.doesNotMatch(appsScriptSource, /1[a-zA-Z0-9_-]{30,}/);
  assert.doesNotMatch(appsScriptSource, /bjjsite\.com/);
});

test('37 Real Apps Script is not addressed by any deployment or project ID', () => {
  assert.doesNotMatch(appsScriptSource, /\/macros\/s\/|\/home\/projects\/|AKfy/);
});

test('38 Candidate deployment configuration does not name or alter the live domain', () => {
  const deployConfig = [read('netlify.toml'), read('_headers'), read('_redirects')].join('\n');
  assert.doesNotMatch(deployConfig, /bjjsite\.com|production\s*=/i);
});

test('39 Work is isolated on m1-final-production-candidate and main is not checked out', () => {
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: new URL('.', ROOT),
    encoding: 'utf8'
  }).trim();
  assert.equal(branch, 'm1-final-production-candidate');
});

test('40 Candidate contains no command or configuration that changes Netlify production', () => {
  const allCandidateText = [
    read('netlify.toml'),
    read('_headers'),
    read('_redirects'),
    ...[
      'netlify/functions/m1-kiosk-sync.mjs',
      'netlify/functions/m1-admin-login.mjs',
      'netlify/functions/m1-admin-logout.mjs',
      'netlify/functions/m1-admin-review.mjs',
      'netlify/functions/m1-admin-search.mjs',
      'netlify/functions/m1-admin-add.mjs'
    ].map(read)
  ].join('\n');
  assert.doesNotMatch(allCandidateText, /netlify\s+deploy\s+--prod|updateEnvVar|setEnvVarValue|production_deploy/i);
});

test('41 A staged multi-class sign-in recovers after every partial-write phase without duplicates', () => {
  const newRows = [
    { ...kioskRow({ RowID: 'txn-one', __rowId: 'txn-one' }), Status: 'OK' },
    {
      ...kioskRow({
        RowID: 'txn-two',
        __rowId: 'txn-two',
        'Class Label': '11:00 AM BJJ (Level 2)'
      }),
      Status: 'OK'
    }
  ];
  const queuedRows = newRows.map(row => ({ ...row }));
  const transaction = { version: 1, newRows, queuedRows };

  const beforeEitherWrite = safety.mergeSigninTransaction([], [], transaction);
  assert.equal(beforeEitherWrite.ledger.length, 2);
  assert.equal(beforeEitherWrite.queue.length, 2);

  const afterLedgerWrite = safety.mergeSigninTransaction(newRows, [], transaction);
  assert.equal(afterLedgerWrite.ledger.length, 2);
  assert.equal(afterLedgerWrite.queue.length, 2);

  const afterBothWrites = safety.mergeSigninTransaction(newRows, queuedRows, transaction);
  assert.equal(afterBothWrites.ledger.length, 2);
  assert.equal(afterBothWrites.queue.length, 2);
  assert.match(kioskHtml, /recoverPendingSigninTransaction\(\)/);
  const commitBody = kioskHtml.slice(
    kioskHtml.indexOf('function commitSigninTransaction'),
    kioskHtml.indexOf('const PAYROLL_HEADERS')
  );
  assert.ok(commitBody.indexOf('safeSet(SIGNIN_TXN_KEY') < commitBody.indexOf('saveSignins'));
  assert.ok(commitBody.indexOf('saveSignins') < commitBody.indexOf('saveSyncQueue'));
});

test('42 A confirmed Google result marks the ledger before removing the waiting row', () => {
  const row = { ...kioskRow({ RowID: 'confirmed-one', __rowId: 'confirmed-one' }), Status: 'OK' };
  const completed = [{
    row,
    result: { rowId: 'confirmed-one', result: 'added', linkedRecordId: 'sheet-one' }
  }];
  const marked = safety.markCompletedLedgerRows([row], completed);
  assert.equal(marked[0].__syncState, 'confirmed');
  assert.equal(marked[0].__linkedRecordId, 'sheet-one');
  const syncNowBody = kioskHtml.slice(
    kioskHtml.indexOf('async function syncNow()'),
    kioskHtml.indexOf('function debugSnapshot()')
  );
  assert.ok(syncNowBody.indexOf('markAttemptedLedgerRows') < syncNowBody.indexOf("fetch('/.netlify/functions/m1-kiosk-sync'"));
  const syncBody = kioskHtml.slice(
    kioskHtml.indexOf('const applied = window.GibM1Safety.applyReadableResults'),
    kioskHtml.indexOf('if (applied.completed.length)')
  );
  assert.ok(syncBody.indexOf('markCompletedLedgerRows') < syncBody.indexOf('saveSyncQueue'));
});

test('43 Netlify pins every authenticated request to the current TEST or production target', async () => {
  const observed = [];
  const fetchMock = async (_url, options) => {
    observed.push(JSON.parse(options.body));
    return googleResponse({ ok: true });
  };
  await postGoogle(
    { preview: true, webhookUrl: previewEnv.GIB_TEST_WEBHOOK_URL, webhookToken: previewEnv.GIB_TEST_WEBHOOK_TOKEN },
    'dailyReview',
    { date: '2026-07-25', target: 'production' },
    fetchMock
  );
  await postGoogle(
    { preview: false, webhookUrl: productionEnv.GIB_M1_WEBHOOK_URL, webhookToken: productionEnv.GIB_M1_WEBHOOK_TOKEN },
    'dailyReview',
    { date: '2026-07-25', target: 'test' },
    fetchMock
  );
  assert.equal(observed[0].target, 'test');
  assert.equal(observed[1].target, 'production');
  assert.equal(apps.requestTarget_({ target: 'test' }), 'test');
  assert.equal(apps.requestTarget_({ rows: [] }), '');

  const testOnlyContext = vm.createContext({
    module: { exports: {} },
    exports: {},
    console,
    TEST_SPREADSHEET_ID: 'test-only-id'
  });
  vm.runInContext(appsScriptSource, testOnlyContext);
  assert.equal(
    testOnlyContext.module.exports.configuredSpreadsheetId_({ rows: [] }),
    'test-only-id'
  );

  const productionOnlyContext = vm.createContext({
    module: { exports: {} },
    exports: {},
    console,
    SPREADSHEET_ID: 'production-only-id'
  });
  vm.runInContext(appsScriptSource, productionOnlyContext);
  assert.equal(
    productionOnlyContext.module.exports.configuredSpreadsheetId_({ rows: [] }),
    'production-only-id'
  );

  const ambiguousContext = vm.createContext({
    module: { exports: {} },
    exports: {},
    console,
    TEST_SPREADSHEET_ID: 'test-id',
    SPREADSHEET_ID: 'production-id'
  });
  vm.runInContext(appsScriptSource, ambiguousContext);
  assert.throws(() =>
    ambiguousContext.module.exports.configuredSpreadsheetId_({ rows: [] })
  );
  assert.throws(() =>
    productionOnlyContext.module.exports.configuredSpreadsheetId_({ target: 'test' })
  );
  assert.match(appsScriptSource, /Expected spreadsheet identity is not configured/);
  assert.match(appsScriptSource, /if \(!action && Array\.isArray\(body\.rows\)\) action = 'kioskSignIn'/);
});

test('44 Admin success copy names TEST only in TEST mode', () => {
  assert.match(adminHtml, /testMode \? 'Instructor added to the TEST Sheet' : 'Instructor added to the payroll Sheet'/);
});

test('45 production kiosk requests without device authentication never reach Google', async () => {
  let googleCalls = 0;
  const response = await handleKioskSync(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-kiosk-sync', {
      rows: [kioskRow()]
    }),
    {
      env: productionEnv,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({ ok: true, results: [] });
      }
    }
  );
  assert.equal(response.status, 403);
  assert.equal(googleCalls, 0);
});

test('45b wrong production kiosk device authentication never reaches Google', async () => {
  let googleCalls = 0;
  const response = await handleKioskSync(
    jsonRequest(
      'https://bjjsite.com/.netlify/functions/m1-kiosk-sync',
      { rows: [kioskRow()] },
      '',
      { [KIOSK_DEVICE_HEADER]: 'wrong-production-device-token' }
    ),
    {
      env: productionEnv,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({ ok: true, results: [] });
      }
    }
  );
  assert.equal(response.status, 403);
  assert.equal(googleCalls, 0);
  assert.equal(
    (await response.json()).message,
    'Device sync code is not configured or was rejected.'
  );
});

test('45c correct production kiosk device authentication can reach Google', async () => {
  let googleCalls = 0;
  const row = kioskRow({ RowID: 'authenticated-production-row' });
  const response = await handleKioskSync(
    jsonRequest(
      'https://bjjsite.com/.netlify/functions/m1-kiosk-sync',
      { rows: [row] },
      '',
      { [KIOSK_DEVICE_HEADER]: productionEnv.GIB_M1_KIOSK_DEVICE_TOKEN }
    ),
    {
      env: productionEnv,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({
          ok: true,
          results: [{
            rowId: row.RowID,
            result: 'added',
            linkedRecordId: 'production-test-double'
          }]
        });
      }
    }
  );
  assert.equal(response.status, 200);
  assert.equal(googleCalls, 1);
});

test('45d exact Deploy Preview permits fake TEST data without a device secret', async () => {
  let googleCalls = 0;
  const row = kioskRow({ RowID: 'preview-fake-row' });
  const response = await handleKioskSync(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-kiosk-sync',
      { rows: [row] }
    ),
    {
      env: previewEnv,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({
          ok: true,
          results: [{ rowId: row.RowID, result: 'added', linkedRecordId: 'test-only-row' }]
        });
      }
    }
  );
  assert.equal(response.status, 200);
  assert.equal(googleCalls, 1);
  assert.equal((await response.json()).test, true);
});

test('45e Deploy Preview rejects non-TEST instructor data before Google', async () => {
  let googleCalls = 0;
  const response = await handleKioskSync(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-kiosk-sync',
      { rows: [kioskRow({ Instructor: 'Stuart Turner' })] }
    ),
    {
      env: previewEnv,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({ ok: true, results: [] });
      }
    }
  );
  assert.equal(response.status, 400);
  assert.equal(googleCalls, 0);
});

test('45f preview context cannot bypass device authentication on a production host', async () => {
  let googleCalls = 0;
  const response = await handleKioskSync(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-kiosk-sync', {
      rows: [kioskRow()]
    }),
    {
      env: {
        ...productionEnv,
        CONTEXT: 'deploy-preview',
        GIB_TEST_WEBHOOK_URL: previewEnv.GIB_TEST_WEBHOOK_URL,
        GIB_TEST_WEBHOOK_TOKEN: previewEnv.GIB_TEST_WEBHOOK_TOKEN
      },
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({ ok: true, results: [] });
      }
    }
  );
  assert.equal(response.status, 403);
  assert.equal(googleCalls, 0);
});

test('45g the masked device sync code control is inside PIN-protected local Admin', () => {
  const adminSection = kioskHtml.slice(
    kioskHtml.indexOf('<section id="admin"'),
    kioskHtml.indexOf('<div id="adminPinModal"')
  );
  assert.match(
    adminSection,
    /id="cfgDeviceSyncCode" type="password" autocomplete="off"/
  );
  assert.match(adminSection, /id="btnSaveDeviceSyncCode"/);
  assert.match(kioskHtml, /const KIOSK_DEVICE_TOKEN_KEY = 'gib_m1_kiosk_device_token_v1'/);
  assert.ok(
    kioskHtml.indexOf('function requestAdminAccess()')
      < kioskHtml.indexOf("$('#btnAdmin').addEventListener")
  );
  assert.match(
    kioskHtml.slice(
      kioskHtml.indexOf("$('#btnAdmin').addEventListener"),
      kioskHtml.indexOf("$('#btnAdminLogout').addEventListener")
    ),
    /requestAdminAccess\(\)/
  );
});

test('46 kiosk startup has a last-known-good schedule fallback and no no-store fetch', () => {
  assert.match(kioskHtml, /gib_m1_shared_schedule_cache_v1/);
  assert.doesNotMatch(kioskHtml, /fetch\('\/m1\/shared-schedule\.json', \{ cache: 'no-store' \}\)/);
});

test('46b successful schedule fetch validates all seven days and updates local cache', async () => {
  let cached = null;
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => JSON.parse(JSON.stringify(schedule)),
    readCache: () => null,
    writeCache: value => { cached = JSON.parse(JSON.stringify(value)); },
    readSaved: () => null
  });
  assert.equal(result.source, 'network');
  assert.equal(cached.version, schedule.version);
  assert.deepEqual(Object.keys(cached.days).sort(), [
    'Friday',
    'Monday',
    'Saturday',
    'Sunday',
    'Thursday',
    'Tuesday',
    'Wednesday'
  ]);
});

test('46bc a valid saved local schedule wins online while the shared schedule is still cached', async () => {
  const saved = {
    days: JSON.parse(JSON.stringify(schedule.days)),
    source: 'manual',
    updatedAt: '2026-07-25T10:00:00.000Z'
  };
  saved.days.Monday = ['5:55 AM LOCAL OVERRIDE'];
  const network = JSON.parse(JSON.stringify(schedule));
  network.version = 'network-newer-than-local';
  network.days.Monday = ['6:05 AM SHARED NETWORK'];
  let networkCalls = 0;
  let cached = null;
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => {
      networkCalls += 1;
      return network;
    },
    readCache: () => null,
    writeCache: value => { cached = JSON.parse(JSON.stringify(value)); },
    readSaved: () => saved
  });
  assert.equal(networkCalls, 1);
  assert.equal(result.source, 'saved');
  assert.equal(result.schedule.source, 'manual');
  assert.equal(result.schedule.updatedAt, saved.updatedAt);
  assert.deepEqual(result.schedule.days.Monday, ['5:55 AM LOCAL OVERRIDE']);
  assert.equal(result.sharedSource, 'network');
  assert.deepEqual(
    Array.from(result.sharedSchedule.days.Monday),
    ['6:05 AM SHARED NETWORK']
  );
  assert.equal(cached.version, 'network-newer-than-local');
});

test('46bb malformed shared schedules and versions are never accepted for caching', () => {
  const missingDay = JSON.parse(JSON.stringify(schedule));
  delete missingDay.days.Sunday;
  const nonArrayDay = JSON.parse(JSON.stringify(schedule));
  nonArrayDay.days.Monday = '6:00 AM BJJ';
  const nonStringClass = JSON.parse(JSON.stringify(schedule));
  nonStringClass.days.Monday = [42];
  const missingVersion = JSON.parse(JSON.stringify(schedule));
  delete missingVersion.version;
  const nonStringVersion = JSON.parse(JSON.stringify(schedule));
  nonStringVersion.version = 42;
  [missingDay, nonArrayDay, nonStringClass, missingVersion, nonStringVersion]
    .forEach(candidate => {
      assert.equal(
        safety.validateSchedulePayload(candidate, { requireVersion: true }),
        null
      );
    });
});

test('46c a valid saved local schedule wins offline before a cached shared schedule', async () => {
  const cached = JSON.parse(JSON.stringify(schedule));
  cached.version = 'cached-test-version';
  cached.days.Monday = ['6:05 AM CACHED SHARED'];
  const saved = {
    days: JSON.parse(JSON.stringify(schedule.days)),
    source: 'url',
    updatedAt: '2026-07-25T10:00:00.000Z'
  };
  saved.days.Monday = ['5:55 AM SAVED URL'];
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => { throw new Error('offline'); },
    readCache: () => cached,
    readSaved: () => saved
  });
  assert.equal(result.source, 'saved');
  assert.equal(result.schedule.source, 'url');
  assert.deepEqual(result.schedule.days.Monday, ['5:55 AM SAVED URL']);
  assert.equal(result.sharedSource, 'cache');
  assert.equal(result.sharedSchedule.version, 'cached-test-version');
});

test('46d failed schedule fetch still uses a valid saved local schedule', async () => {
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => { throw new Error('offline'); },
    readCache: () => ({ version: 'invalid-cache', days: { Monday: [] } }),
    readSaved: () => ({
      days: JSON.parse(JSON.stringify(schedule.days)),
      source: 'manual',
      updatedAt: '2026-07-25T10:00:00.000Z'
    })
  });
  assert.equal(result.source, 'saved');
  assert.equal(result.schedule.version, null);
  assert.equal(result.schedule.source, 'manual');
  assert.equal(result.schedule.updatedAt, '2026-07-25T10:00:00.000Z');
  assert.equal(Object.keys(result.schedule.days).length, 7);
});

test('46da every explicitly saved empty local schedule remains active after reload', async () => {
  const disabledDays = Object.fromEntries(
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      .map(day => [day, []])
  );
  for (const source of ['manual', 'url', 'disabled']) {
    const result = await safety.loadScheduleStartup({
      fetchSchedule: async () => JSON.parse(JSON.stringify(schedule)),
      readCache: () => null,
      writeCache: () => {},
      readSaved: () => ({
        days: disabledDays,
        source,
        updatedAt: '2026-07-25T10:00:00.000Z'
      })
    });
    assert.equal(result.source, 'saved', source);
    assert.equal(result.schedule.source, source);
    assert.equal(
      Object.values(result.schedule.days).flat().length,
      0
    );
    assert.equal(result.sharedSource, 'network');
  }
});

test('46daa an existing live-tablet days-only schedule remains compatible', async () => {
  const liveTabletSchedule = {
    days: {
      Monday: ['5:45 AM EXISTING TABLET CLASS'],
      Tuesday: [],
      Wednesday: [],
      Thursday: [],
      Friday: [],
      Saturday: [],
      Sunday: []
    }
  };
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => JSON.parse(JSON.stringify(schedule)),
    readCache: () => null,
    writeCache: () => {},
    readSaved: () => liveTabletSchedule
  });
  assert.equal(result.source, 'saved');
  assert.equal(result.schedule.source, 'saved');
  assert.deepEqual(
    result.schedule.days.Monday,
    ['5:45 AM EXISTING TABLET CLASS']
  );
});

test('46db without a saved local schedule, failed network uses cached shared schedule', async () => {
  const cached = JSON.parse(JSON.stringify(schedule));
  cached.version = 'cached-test-version';
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => { throw new Error('offline'); },
    readCache: () => cached,
    readSaved: () => null
  });
  assert.equal(result.source, 'cache');
  assert.equal(result.schedule.version, 'cached-test-version');
});

test('46dc a cache-write failure cannot invalidate a good shared network schedule', async () => {
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => JSON.parse(JSON.stringify(schedule)),
    readCache: () => null,
    writeCache: () => { throw new Error('quota'); },
    readSaved: () => null
  });
  assert.equal(result.source, 'network');
  assert.equal(result.schedule.version, schedule.version);
  assert.equal(result.sharedSource, 'network');
});

test('46e failed schedule fetch with no valid fallback blocks startup', async () => {
  await assert.rejects(
    safety.loadScheduleStartup({
      fetchSchedule: async () => { throw new Error('offline'); },
      readCache: () => null,
      readSaved: () => ({ days: { Funday: ['6:00 AM BJJ'] } })
    }),
    /offline/
  );
  assert.match(kioskHtml, /No valid network, cached, or saved schedule is available\. Sign-in is paused\./);
  const initializeBody = kioskHtml.slice(
    kioskHtml.indexOf('async function initializeCandidate()'),
    kioskHtml.indexOf('initializeCandidate();')
  );
  const noScheduleCatch = initializeBody.slice(
    initializeBody.indexOf('catch (error)'),
    initializeBody.indexOf('initScheduleEditor()')
  );
  assert.doesNotMatch(noScheduleCatch, /\breturn\s*;/);
  assert.match(initializeBody, /Existing records and sync tools remain available\./);
});

test('46f offline schedule startup does not alter the payroll ledger or waiting queue', async () => {
  const ledger = [{ ...kioskRow({ RowID: 'offline-ledger' }), Status: 'OK' }];
  const queue = [{ ...kioskRow({ RowID: 'offline-ledger' }) }];
  const beforeLedger = JSON.stringify(ledger);
  const beforeQueue = JSON.stringify(queue);
  const storage = new Map([
    ['gib_m1_signins_v1', beforeLedger],
    ['gib_m1_sync_queue_v1', beforeQueue],
    ['gib_m1_schedule_v1', JSON.stringify({
      days: schedule.days,
      source: 'manual',
      updatedAt: '2026-07-25T10:00:00.000Z'
    })],
    ['gib_m1_shared_schedule_cache_v1', JSON.stringify(schedule)]
  ]);
  const beforeLocalSchedule = storage.get('gib_m1_schedule_v1');
  const result = await safety.loadScheduleStartup({
    fetchSchedule: async () => { throw new Error('offline'); },
    readCache: () => JSON.parse(storage.get('gib_m1_shared_schedule_cache_v1')),
    writeCache: value => storage.set('gib_m1_shared_schedule_cache_v1', JSON.stringify(value)),
    readSaved: () => null
  });
  assert.equal(result.source, 'cache');
  assert.equal(storage.get('gib_m1_signins_v1'), beforeLedger);
  assert.equal(storage.get('gib_m1_sync_queue_v1'), beforeQueue);
  assert.equal(storage.get('gib_m1_schedule_v1'), beforeLocalSchedule);
});

test('46fa every schedule-selection path leaves ledger and waiting rows byte-for-byte unchanged', async () => {
  const paths = [
    {
      name: 'saved over network',
      fetchSchedule: async () => JSON.parse(JSON.stringify(schedule)),
      readCache: () => null,
      readSaved: () => ({
        days: schedule.days,
        source: 'manual',
        updatedAt: '2026-07-25T10:00:00.000Z'
      })
    },
    {
      name: 'network without saved',
      fetchSchedule: async () => JSON.parse(JSON.stringify(schedule)),
      readCache: () => null,
      readSaved: () => null
    },
    {
      name: 'saved over offline cache',
      fetchSchedule: async () => { throw new Error('offline'); },
      readCache: () => JSON.parse(JSON.stringify(schedule)),
      readSaved: () => ({
        days: schedule.days,
        source: 'url',
        updatedAt: '2026-07-25T10:00:00.000Z'
      })
    },
    {
      name: 'offline cache without saved',
      fetchSchedule: async () => { throw new Error('offline'); },
      readCache: () => JSON.parse(JSON.stringify(schedule)),
      readSaved: () => null
    }
  ];
  for (const path of paths) {
    const storage = new Map([
      ['gib_m1_signins_v1', JSON.stringify([kioskRow({ RowID: path.name })])],
      ['gib_m1_sync_queue_v1', JSON.stringify([kioskRow({ RowID: path.name })])]
    ]);
    const ledgerBefore = storage.get('gib_m1_signins_v1');
    const queueBefore = storage.get('gib_m1_sync_queue_v1');
    await safety.loadScheduleStartup({
      ...path,
      writeCache: value => storage.set(
        'gib_m1_shared_schedule_cache_v1',
        JSON.stringify(value)
      )
    });
    assert.equal(storage.get('gib_m1_signins_v1'), ledgerBefore, path.name);
    assert.equal(storage.get('gib_m1_sync_queue_v1'), queueBefore, path.name);
  }
});

test('46g Revert to default deliberately clears every local override and activates shared', () => {
  const revertBody = kioskHtml.slice(
    kioskHtml.indexOf("$('#btnClearSchedule').addEventListener"),
    kioskHtml.indexOf("$('#btnDisableSchedule').addEventListener")
  );
  assert.match(revertBody, /localStorage\.removeItem\(SCHEDULE_KEY\)/);
  assert.match(revertBody, /localStorage\.removeItem\(SCHEDULE_URL_KEY\)/);
  assert.match(revertBody, /localStorage\.removeItem\(SCHEDULE_MODE_KEY\)/);
  assert.match(revertBody, /activateSharedScheduleDefault\(\)/);
  assert.doesNotMatch(revertBody, /SIGNINS_KEY|SYNC_QUEUE_KEY/);
});

test('46gb Device Reset blocks sign-in and clears stale source when no shared default exists', () => {
  const resetBody = kioskHtml.slice(
    kioskHtml.indexOf('function resetDevice()'),
    kioskHtml.indexOf('function factoryReset()')
  );
  assert.match(resetBody, /const sharedScheduleAvailable = activateSharedScheduleDefault\(\)/);
  assert.match(resetBody, /SHARED_SCHEDULE_STARTUP_SOURCE = ''/);
  assert.match(resetBody, /SIGN_IN_SCHEDULE_BLOCKED = true/);
  assert.match(resetBody, /refreshSignInButtonState\(\)/);
  assert.match(resetBody, /No valid schedule is available\. Existing records and sync tools remain available\./);
});

test('46gc saving a valid schedule re-enables sign-in without overriding transaction safety', () => {
  const saveBody = kioskHtml.slice(
    kioskHtml.indexOf('function saveSchedule('),
    kioskHtml.indexOf('const DAY_ABBREV')
  );
  const refreshBody = kioskHtml.slice(
    kioskHtml.indexOf('function refreshSignInButtonState()'),
    kioskHtml.indexOf('function toggleSignInModal(')
  );
  assert.match(saveBody, /SIGN_IN_SCHEDULE_BLOCKED = false/);
  assert.match(saveBody, /refreshSignInButtonState\(\)/);
  assert.match(refreshBody, /SIGN_IN_SCHEDULE_BLOCKED/);
  assert.match(refreshBody, /SIGN_IN_TRANSACTION_BLOCKED/);
  assert.match(refreshBody, /SIGN_IN_MODAL_OPEN/);
  assert.match(refreshBody, /\.disabled = Boolean\(/);
});

test('46h an empty offline day still discloses the last-known schedule source', () => {
  assert.match(kioskHtml, /Offline — the last known shared schedule is active\./);
  assert.match(kioskHtml, /Offline — the last known saved local schedule is active\./);
});

test('47 every shipped production HTML page has no executable-markup sink', () => {
  const forbiddenSinks = [
    /\.innerHTML\s*=/iu,
    /\.outerHTML\s*=/iu,
    /\.insertAdjacentHTML\s*\(/iu,
    /\bdocument\.write(?:ln)?\s*\(/iu,
    /\beval\s*\(/iu,
    /(?:\bnew\s+)?\bFunction\s*\(/u,
    /\son[a-z]+\s*=/iu
  ];
  for (const [route, html] of productionHtmlPages) {
    forbiddenSinks.forEach(pattern => {
      assert.doesNotMatch(html, pattern, `${route} contains ${pattern}`);
    });
  }
});

test('47b malicious stored HTML is rendered literally without an image or handler', () => {
  const payload = '<img src=x onerror="throw new Error(\'executed\')">';
  function fakeElement(tagName) {
    let ownText = '';
    return {
      tagName: String(tagName).toUpperCase(),
      className: '',
      childNodes: [],
      append(...children) {
        this.childNodes.push(...children);
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
  const fakeDocument = {
    createElement: fakeElement,
    createTextNode: value => ({ nodeType: 3, textContent: String(value), childNodes: [] })
  };
  const rendererSource = adminHtml.slice(
    adminHtml.indexOf('function makeElement'),
    adminHtml.indexOf('function refreshInstructorOptions')
  );
  const rendererContext = vm.createContext({ document: fakeDocument });
  vm.runInContext(
    `${rendererSource}\nglobalThis.recordElementForTest = recordElement;`,
    rendererContext
  );
  const rendered = rendererContext.recordElementForTest({
    instructor: payload,
    date: '2026-07-25',
    classLabel: payload,
    site: payload,
    source: 'Admin-added'
  });
  const elementTags = [];
  (function walk(node) {
    if (node.tagName) elementTags.push(node.tagName);
    (node.childNodes || []).forEach(walk);
  })(rendered);
  assert.ok(rendered.textContent.includes(payload));
  assert.equal(elementTags.includes('IMG'), false);
  assert.equal(Object.hasOwn(rendered, 'onerror'), false);
});

test('47bb every guest field is rendered as exact text through DOM creation', () => {
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
  const rendererSource = guestHtml.slice(
    guestHtml.indexOf('const renderEntries = () =>'),
    guestHtml.indexOf('const resetForm = () =>')
  );
  const rendererContext = vm.createContext({
    document: { createElement: fakeElement },
    entriesWrap,
    jsonOutput,
    entries: [{
      name: payload,
      organization: payload,
      type: payload,
      checkIn: payload,
      notes: payload
    }]
  });
  vm.runInContext(`${rendererSource}\nrenderEntries();`, rendererContext);
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
  assert.equal(tags.includes('SCRIPT'), false);
  assert.equal(JSON.parse(jsonOutput.value)[0].name, payload);
});

test('47c legacy browser Google keys remain before a confirmed production sync', () => {
  const values = new Map([
    ['gib_m1_sync_url_v1', 'https://legacy.example.invalid/secret-path'],
    ['gib_m1_sync_token_v1', 'legacy-token-sentinel']
  ]);
  const storage = {
    removeItem: key => values.delete(key)
  };
  const row = kioskRow({ RowID: 'legacy-migration-row' });
  const unclear = safety.applyReadableResults([row], {
    ok: true,
    results: [{ rowId: row.RowID, result: 'unclear' }]
  });
  assert.equal(
    safety.retireLegacySyncSecrets(storage, unclear.completed),
    false
  );
  assert.equal(values.has('gib_m1_sync_url_v1'), true);
  assert.equal(values.has('gib_m1_sync_token_v1'), true);

  const unrelated = safety.applyReadableResults([row], {
    ok: true,
    results: [{ rowId: 'different-row', result: 'added' }]
  });
  assert.equal(
    safety.retireLegacySyncSecrets(storage, unrelated.completed),
    false
  );
  assert.equal(values.has('gib_m1_sync_url_v1'), true);
  assert.equal(values.has('gib_m1_sync_token_v1'), true);
});

test('47d one matched added result removes both legacy browser Google keys', () => {
  const values = new Map([
    ['gib_m1_sync_url_v1', 'legacy-url-sentinel'],
    ['gib_m1_sync_token_v1', 'legacy-token-sentinel']
  ]);
  const storage = {
    removeItem: key => values.delete(key)
  };
  const row = kioskRow({ RowID: 'legacy-added-row' });
  const applied = safety.applyReadableResults([row], {
    ok: true,
    results: [{ rowId: row.RowID, result: 'added' }]
  });
  assert.equal(
    safety.retireLegacySyncSecrets(storage, applied.completed),
    true
  );
  assert.equal(values.has('gib_m1_sync_url_v1'), false);
  assert.equal(values.has('gib_m1_sync_token_v1'), false);
});

test('47e one matched already-exists result removes both legacy browser Google keys', () => {
  const values = new Map([
    ['gib_m1_sync_url_v1', 'legacy-url-sentinel'],
    ['gib_m1_sync_token_v1', 'legacy-token-sentinel']
  ]);
  const storage = {
    removeItem: key => values.delete(key)
  };
  const row = kioskRow({ RowID: 'legacy-existing-row' });
  const applied = safety.applyReadableResults([row], {
    ok: true,
    results: [{ rowId: row.RowID, result: 'already exists' }]
  });
  assert.equal(
    safety.retireLegacySyncSecrets(storage, applied.completed),
    true
  );
  assert.equal(values.has('gib_m1_sync_url_v1'), false);
  assert.equal(values.has('gib_m1_sync_token_v1'), false);
});

test('47f legacy values are never read and migration is driven only by matched safe results', () => {
  assert.equal(safety.LEGACY_SYNC_URL_KEY, 'gib_m1_sync_url_v1');
  assert.equal(safety.LEGACY_SYNC_TOKEN_KEY, 'gib_m1_sync_token_v1');
  assert.doesNotMatch(
    `${kioskHtml}\n${read('m1/kiosk-safety.js')}`,
    /getItem\((?:window\.GibM1Safety\.)?LEGACY_SYNC_(?:URL|TOKEN)_KEY\)/
  );
  const syncBody = kioskHtml.slice(
    kioskHtml.indexOf('async function syncNow()'),
    kioskHtml.indexOf('function debugSnapshot()')
  );
  assert.match(syncBody, /retireLegacySyncSecrets\(localStorage, applied\.completed/);
  assert.doesNotMatch(syncBody, /retireLegacySyncSecrets\([^;]*data\.results/);
  assert.ok(
    syncBody.indexOf('if (!applied.readable)')
      < syncBody.indexOf('retireLegacySyncSecrets(localStorage, applied.completed')
  );
  assert.match(syncBody, /body: JSON\.stringify\(\{ rows: queue \}\)/);

  const debugBody = kioskHtml.slice(
    kioskHtml.indexOf('function debugSnapshot()'),
    kioskHtml.indexOf('async function copyDebug()')
  );
  assert.match(debugBody, /k !== LEGACY_SYNC_URL_KEY/);
  assert.match(debugBody, /k !== LEGACY_SYNC_TOKEN_KEY/);
});

test('48 weak production Admin passphrases fail closed', () => {
  const config = runtimeConfig({
    CONTEXT: 'production',
    GIB_M1_WEBHOOK_URL: productionEnv.GIB_M1_WEBHOOK_URL,
    GIB_M1_WEBHOOK_TOKEN: productionEnv.GIB_M1_WEBHOOK_TOKEN,
    GIB_M1_ADMIN_PASSPHRASE: 'three weak words'
  }, { admin: true });
  assert.equal(config, null);
});

test('48b production Admin passphrase policy enforces every boundary', () => {
  assert.equal(validAdminPassphrase('alpha beta gamma delta'), true);
  assert.equal(validAdminPassphrase('alpha-bravo-charlie-delta'), true);
  assert.equal(validAdminPassphrase('aa bb ccc ddddddddd'), false);
  assert.equal(validAdminPassphrase('aa bb ccc dddddddddd'), true);
  assert.equal(validAdminPassphrase('one two three four'), false);
  assert.equal(validAdminPassphrase('repeated repeated repeated repeated words'), false);
  assert.equal(validAdminPassphrase('alpha beta gamma delta\n'), false);
  assert.equal(validAdminPassphrase(`alpha bravo charlie ${'d'.repeat(236)}`), true);
  assert.equal(validAdminPassphrase(`alpha bravo charlie ${'d'.repeat(237)}`), false);
});

test('48c a strong four-word production Admin passphrase can log in', async () => {
  const response = await handleAdminLogin(
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
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requestToken, Buffer.alloc(32, 7).toString('base64url'));
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
});

test('48d a weak production Admin configuration returns 503 without a cookie', async () => {
  const response = await handleAdminLogin(
    jsonRequest('https://bjjsite.com/.netlify/functions/m1-admin-login', {
      adminName: 'Andrew Smith',
      passphrase: 'three weak words',
      testShortcut: false
    }),
    {
      env: {
        ...productionEnv,
        GIB_M1_ADMIN_PASSPHRASE: 'three weak words'
      },
      now: fixedNow
    }
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('48e login tokens are unique, signed into the cookie, and returned only by login', async () => {
  let fill = 1;
  const loginOnce = () => handleAdminLogin(
    jsonRequest('https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-login', {
      adminName: 'Stuart Turner',
      testShortcut: true
    }),
    {
      env: previewEnv,
      now: fixedNow,
      randomBytes: size => Buffer.alloc(size, fill++)
    }
  );
  const firstLogin = await loginOnce();
  const secondLogin = await loginOnce();
  const firstBody = await firstLogin.json();
  const secondBody = await secondLogin.json();
  assert.notEqual(firstBody.requestToken, secondBody.requestToken);

  const cookieHeader = firstLogin.headers.get('set-cookie') || '';
  const encodedSession = cookieHeader
    .split(';')[0]
    .slice(`${ADMIN_COOKIE}=`.length);
  const config = runtimeConfig(previewEnv, {
    admin: true,
    requestUrl: 'https://deploy-preview-44--gib-live.netlify.app/m1/admin/'
  });
  const session = readAdminSession(
    decodeURIComponent(encodedSession),
    config.sessionSecret,
    fixedNow
  );
  assert.equal(session.requestToken, firstBody.requestToken);

  const review = await handleAdminReview(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-review',
      { date: '2026-07-25' },
      cookieHeader.split(';')[0],
      adminHeaders(firstBody.requestToken)
    ),
    {
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: async () => googleResponse({ ok: true, records: [] })
    }
  );
  assert.equal(review.status, 200);
  assert.equal(Object.hasOwn(await review.json(), 'requestToken'), false);
});

test('49 protected Admin requests require a session-specific request header', async () => {
  let googleCalls = 0;
  const response = await handleAdminReview(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-review',
      { date: '2026-07-25' },
      previewCookie()
    ),
    {
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({ ok: true, records: [] });
      }
    }
  );
  assert.equal(response.status, 403);
  assert.equal(googleCalls, 0);
});

test('49b an incorrect Admin request token is rejected before Google', async () => {
  let googleCalls = 0;
  const response = await handleAdminReview(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-review',
      { date: '2026-07-25' },
      previewCookie(),
      adminHeaders(Buffer.alloc(32, 3).toString('base64url'))
    ),
    {
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({ ok: true, records: [] });
      }
    }
  );
  assert.equal(response.status, 403);
  assert.equal(googleCalls, 0);
});

test('49c a valid Admin cookie and matching request token can reach Google', async () => {
  let googleCalls = 0;
  const response = await handleAdminReview(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-review',
      { date: '2026-07-25' },
      previewCookie(),
      adminHeaders()
    ),
    {
      env: previewEnv,
      now: fixedNow,
      dateNow: fixedDateNow,
      fetch: async () => {
        googleCalls += 1;
        return googleResponse({ ok: true, records: [] });
      }
    }
  );
  assert.equal(response.status, 200);
  assert.equal(googleCalls, 1);
});

test('49d logout also rejects a missing request token without clearing the cookie', async () => {
  const response = await handleAdminLogout(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-logout',
      {},
      previewCookie()
    ),
    { env: previewEnv, now: fixedNow }
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('49dd search and add reject missing or wrong request tokens before Google', async () => {
  const cases = [
    {
      name: 'search',
      handler: handleAdminSearch,
      body: { instructor: 'QA Test Instructor', date: '2026-07-25' }
    },
    {
      name: 'add',
      handler: handleAdminAdd,
      body: {
        requestId: 'qa-auth-negative',
        date: '2026-07-25',
        classLabel: '10:00 AM Kids’ BJJ',
        duration: 0.5,
        instructor: 'QA Test Instructor',
        site: 'Rev',
        notes: '',
        reason: 'QA TEST missed sign-in'
      }
    }
  ];
  for (const item of cases) {
    for (const suppliedToken of ['', Buffer.alloc(32, 4).toString('base64url')]) {
      let googleCalls = 0;
      const response = await item.handler(
        jsonRequest(
          `https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-${item.name}`,
          item.body,
          previewCookie(),
          suppliedToken ? adminHeaders(suppliedToken) : {}
        ),
        {
          env: previewEnv,
          now: fixedNow,
          dateNow: fixedDateNow,
          fetch: async () => {
            googleCalls += 1;
            return googleResponse({ ok: true });
          }
        }
      );
      assert.equal(response.status, 403, `${item.name} must reject the token`);
      assert.equal(googleCalls, 0, `${item.name} must not reach Google`);
    }
  }
});

test('49de logout rejects an incorrect request token without clearing the cookie', async () => {
  const response = await handleAdminLogout(
    jsonRequest(
      'https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-logout',
      {},
      previewCookie(),
      adminHeaders(Buffer.alloc(32, 5).toString('base64url'))
    ),
    { env: previewEnv, now: fixedNow }
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('49e browser secrets remain out of source, URLs, storage, exports, snapshots, and logs', () => {
  assert.doesNotMatch(adminHtml, /localStorage|sessionStorage|URLSearchParams/);
  assert.match(adminHtml, /let adminRequestToken = ''/);
  assert.match(adminHtml, /headers\[ADMIN_REQUEST_HEADER\] = adminRequestToken/);

  const debugBody = kioskHtml.slice(
    kioskHtml.indexOf('function debugSnapshot()'),
    kioskHtml.indexOf('async function copyDebug()')
  );
  assert.match(
    debugBody,
    /deviceSyncCodeConfigured: Boolean\(localStorage\.getItem\(KIOSK_DEVICE_TOKEN_KEY\)\)/
  );
  assert.match(debugBody, /k !== KIOSK_DEVICE_TOKEN_KEY/);

  const exportBody = kioskHtml.slice(
    kioskHtml.indexOf('function buildCSV()'),
    kioskHtml.indexOf('async function exportCSV()')
  );
  assert.doesNotMatch(exportBody, /KIOSK_DEVICE_TOKEN_KEY|Device sync code|Admin-Request-Token/);
  assert.doesNotMatch(
    [
      rootHtml,
      guestHtml,
      kioskHtml,
      adminHtml,
      read('netlify/functions/m1-kiosk-sync.mjs'),
      read('netlify/functions/_lib/m1-common.mjs')
    ].join('\n'),
    /console\.[A-Za-z_$][\w$]*\s*\(/
  );
});

test('49f the schedule cutover limitation is exact and explicit', () => {
  assert.match(
    adminHtml,
    /Daily Review uses the shared Rev schedule\. Local schedule edits and Series classes must also be added to the shared schedule or they will not appear as blanks\./
  );
});

test('50 every shipped inline production browser script compiles', () => {
  for (const [name, html] of [
    ['guests', guestHtml],
    ['kiosk', kioskHtml],
    ['Admin', adminHtml]
  ]) {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)]
      .map(match => match[1])
      .filter(source => source.trim());
    assert.ok(scripts.length > 0, `${name} must have inline browser code`);
    scripts.forEach((source, index) => {
      assert.doesNotThrow(
        () => new vm.Script(source, { filename: `${name}-inline-${index}.js` })
      );
    });
  }
});

test('51 already-exists with a different linked record keeps one exportable tablet backup', () => {
  const { ledgerRow, queueRow } = parityTabletRows({
    RowID: 'tablet-parity-different-link',
    Date: '2026-07-25',
    'Class Label': '6:15 AM TEST Payroll Parity',
    'Duration (hr)': 0.75,
    Instructor: 'QA TEST Parity Different Link',
    Site: 'Rev'
  });
  const settled = settleTabletSync([ledgerRow], [queueRow], {
    ok: true,
    results: [{
      rowId: queueRow.RowID,
      result: 'already exists',
      linkedRecordId: 'gib-admin-parity-different-link'
    }]
  });

  assert.equal(settled.readable, true);
  assert.equal(settled.completed.length, 1);
  assert.equal(settled.queue.length, 0);
  assert.equal(activeTabletEventRows(settled.ledger, ledgerRow).length, 1);
  assert.equal(settled.ledger.filter(safety.isActiveLedgerRow).length, 1);
  assert.equal(settled.ledger[0].__syncState, 'confirmed');
  assert.equal(settled.ledger[0].__linkedRecordId, 'gib-admin-parity-different-link');
  assert.equal(csvEventCount(generatedPayrollCsv(settled.ledger), ledgerRow), 1);
  assert.match(
    kioskHtml,
    /function isExportableSignin\(row\) \{\s+return window\.GibM1Safety\.isActiveLedgerRow\(row\)/
  );
  assert.match(
    kioskHtml.slice(kioskHtml.indexOf('function buildCSV()'), kioskHtml.indexOf('async function exportCSV()')),
    /const rows = exportableSignins\(\)/
  );
});

test('52 already-exists exact retry clears waiting and stays exportable exactly once', () => {
  const { ledgerRow, queueRow } = parityTabletRows({
    RowID: 'tablet-parity-exact-retry',
    Date: '2026-07-25',
    'Class Label': '7:15 AM TEST Payroll Parity',
    'Duration (hr)': 1,
    Instructor: 'QA TEST Parity Exact Retry',
    Site: 'Rev'
  });
  const settled = settleTabletSync([ledgerRow], [queueRow], {
    ok: true,
    results: [{
      rowId: queueRow.RowID,
      result: 'already exists',
      linkedRecordId: queueRow.RowID
    }]
  });

  assert.equal(settled.queue.length, 0);
  assert.equal(activeTabletEventRows(settled.ledger, ledgerRow).length, 1);
  assert.equal(settled.ledger.filter(safety.isActiveLedgerRow).length, 1);
  assert.equal(settled.ledger[0].__linkedRecordId, queueRow.RowID);
  assert.equal(csvEventCount(generatedPayrollCsv(settled.ledger), ledgerRow), 1);
});

test('53 ordinary added result remains one exportable tablet and Google event', async () => {
  const { ledgerRow, queueRow } = parityTabletRows({
    RowID: 'tablet-parity-added',
    Date: '2026-07-25',
    'Class Label': '8:15 AM TEST Payroll Parity',
    'Duration (hr)': 0.5,
    Instructor: 'QA TEST Parity Added',
    Site: 'Rev'
  });
  const googleRows = [];
  const settled = await syncTabletAgainstGoogle([ledgerRow], [queueRow], googleRows);

  assert.equal(settled.body.results[0].result, 'added');
  assert.equal(settled.queue.length, 0);
  assert.equal(activeTabletEventRows(settled.ledger, ledgerRow).length, 1);
  assert.equal(activeGoogleEventRows(googleRows, googleRows[0]).length, 1);
  assert.equal(settled.ledger[0].__linkedRecordId, queueRow.RowID);
  assert.equal(csvEventCount(generatedPayrollCsv(settled.ledger), ledgerRow), 1);
});

test('54 second local attempt is blocked before another tablet row is created', () => {
  const { ledgerRow, queueRow } = parityTabletRows({
    RowID: 'tablet-parity-local-first',
    Date: '2026-07-25',
    'Class Label': '9:15 AM TEST Payroll Parity',
    'Duration (hr)': 1,
    Instructor: 'QA TEST Parity Local Duplicate',
    Site: 'Rev'
  });
  const first = settleTabletSync([ledgerRow], [queueRow], {
    ok: true,
    results: [{
      rowId: queueRow.RowID,
      result: 'already exists',
      linkedRecordId: 'gib-admin-parity-local-first'
    }]
  });
  const duplicateClasses = safety.duplicateClasses(
    first.ledger,
    ledgerRow.Date,
    '  qa test  parity local duplicate ',
    ' rev ',
    [ledgerRow['Class Label']]
  );
  const duplicateGuard = kioskHtml.slice(
    kioskHtml.indexOf('if (duplicateClasses.length)'),
    kioskHtml.indexOf('const batchId')
  );

  assert.equal(duplicateClasses.length, 1);
  assert.match(duplicateGuard, /Possible duplicate payroll sign-in/);
  assert.match(duplicateGuard, /return;/);
  assert.doesNotMatch(duplicateGuard, /commitSigninTransaction|saveSignins/);
  assert.equal(first.ledger.length, 1);
  assert.equal(first.queue.length, 0);
  assert.equal(csvEventCount(generatedPayrollCsv(first.ledger), ledgerRow), 1);
});

test('55 Admin-first tablet-later preserves one normalized event in both ledgers', async () => {
  const googleEvent = {
    rowId: 'gib-admin-parity-admin-first',
    timestamp: '2026-07-25 08:00:00',
    date: '2026-07-25',
    classLabel: '10:15 AM TEST Payroll Parity',
    duration: 0.75,
    instructor: 'QA TEST Parity Admin First',
    site: 'Rev',
    device: 'Admin Daily Review',
    notes: 'Admin-added TEST row',
    status: 'OK'
  };
  const googleRows = [googleEvent];
  const { ledgerRow, queueRow } = parityTabletRows({
    RowID: 'tablet-parity-admin-later',
    Timestamp: '2026-07-25 10:14:00',
    Date: googleEvent.date,
    'Class Label': googleEvent.classLabel,
    'Duration (hr)': googleEvent.duration,
    Instructor: googleEvent.instructor,
    Site: googleEvent.site
  });
  const settled = await syncTabletAgainstGoogle([ledgerRow], [queueRow], googleRows);
  const tabletEvents = activeTabletEventRows(settled.ledger, ledgerRow);
  const googleEvents = activeGoogleEventRows(googleRows, googleEvent);

  assert.equal(settled.body.results[0].result, 'already exists');
  assert.equal(googleEvents.length, 1);
  assert.equal(tabletEvents.length, 1);
  assert.equal(settled.queue.length, 0);
  assert.equal(settled.ledger[0].__linkedRecordId, googleEvent.rowId);
  assert.equal(csvEventCount(generatedPayrollCsv(settled.ledger), ledgerRow), 1);
  assert.equal(googleEvents[0].instructor, ledgerRow.Instructor);
  assert.equal(googleEvents[0].date, ledgerRow.Date);
  assert.equal(googleEvents[0].classLabel, ledgerRow['Class Label']);
  assert.equal(googleEvents[0].site, ledgerRow.Site);
  assert.equal(googleEvents[0].duration, ledgerRow['Duration (hr)']);
});

test('56 every parity path stays within one tablet export and one active Google event', async () => {
  const scenarios = [];

  const adminFirstGoogle = [{
    rowId: 'gib-admin-parity-bounds',
    timestamp: '2026-07-25 08:00:00',
    date: '2026-07-25',
    classLabel: '11:15 AM TEST Payroll Parity',
    duration: 0.5,
    instructor: 'QA TEST Parity Bounds Admin First',
    site: 'Rev',
    status: 'OK'
  }];
  const adminFirstTablet = parityTabletRows({
    RowID: 'tablet-parity-bounds-admin-first',
    Date: '2026-07-25',
    'Class Label': '11:15 AM TEST Payroll Parity',
    'Duration (hr)': 0.5,
    Instructor: 'QA TEST Parity Bounds Admin First',
    Site: 'Rev'
  });
  const adminFirstSettled = await syncTabletAgainstGoogle(
    [adminFirstTablet.ledgerRow],
    [adminFirstTablet.queueRow],
    adminFirstGoogle
  );
  scenarios.push({
    name: 'Admin first, tablet later',
    googleRows: adminFirstGoogle,
    googleEvent: adminFirstGoogle[0],
    tabletRows: adminFirstSettled.ledger,
    tabletEvent: adminFirstTablet.ledgerRow,
    queue: adminFirstSettled.queue
  });

  const exactRetryTablet = parityTabletRows({
    RowID: 'tablet-parity-bounds-exact',
    Date: '2026-07-25',
    'Class Label': '12:15 PM TEST Payroll Parity',
    'Duration (hr)': 1,
    Instructor: 'QA TEST Parity Bounds Exact',
    Site: 'Rev'
  });
  const exactRetryGoogle = [{
    rowId: exactRetryTablet.queueRow.RowID,
    timestamp: exactRetryTablet.queueRow.Timestamp,
    date: exactRetryTablet.queueRow.Date,
    classLabel: exactRetryTablet.queueRow['Class Label'],
    duration: exactRetryTablet.queueRow['Duration (hr)'],
    instructor: exactRetryTablet.queueRow.Instructor,
    site: exactRetryTablet.queueRow.Site,
    status: 'OK'
  }];
  const exactRetrySettled = await syncTabletAgainstGoogle(
    [exactRetryTablet.ledgerRow],
    [exactRetryTablet.queueRow],
    exactRetryGoogle
  );
  scenarios.push({
    name: 'Exact retry',
    googleRows: exactRetryGoogle,
    googleEvent: exactRetryGoogle[0],
    tabletRows: exactRetrySettled.ledger,
    tabletEvent: exactRetryTablet.ledgerRow,
    queue: exactRetrySettled.queue
  });

  const kioskFirstTablet = parityTabletRows({
    RowID: 'tablet-parity-bounds-kiosk-first',
    Date: '2026-07-25',
    'Class Label': '1:15 PM TEST Payroll Parity',
    'Duration (hr)': 0.75,
    Instructor: 'QA TEST Parity Bounds Kiosk First',
    Site: 'Rev'
  });
  const kioskFirstGoogle = [];
  const kioskFirstSettled = await syncTabletAgainstGoogle(
    [kioskFirstTablet.ledgerRow],
    [kioskFirstTablet.queueRow],
    kioskFirstGoogle
  );
  const adminLater = {
    ...kioskFirstGoogle[0],
    rowId: 'gib-admin-parity-bounds-admin-later'
  };
  const existingForAdmin = apps.findExistingEvent_(kioskFirstGoogle, adminLater);
  if (!existingForAdmin) kioskFirstGoogle.push(adminLater);
  assert.equal(existingForAdmin.rowId, kioskFirstTablet.queueRow.RowID);
  scenarios.push({
    name: 'Kiosk first, Admin later',
    googleRows: kioskFirstGoogle,
    googleEvent: kioskFirstGoogle[0],
    tabletRows: kioskFirstSettled.ledger,
    tabletEvent: kioskFirstTablet.ledgerRow,
    queue: kioskFirstSettled.queue
  });

  for (const scenario of scenarios) {
    const tabletCount = activeTabletEventRows(
      scenario.tabletRows,
      scenario.tabletEvent
    ).length;
    const googleCount = activeGoogleEventRows(
      scenario.googleRows,
      scenario.googleEvent
    ).length;
    assert.ok(tabletCount >= 1, `${scenario.name} must retain a tablet backup`);
    assert.ok(tabletCount <= 1, `${scenario.name} must not double-export on tablet`);
    assert.ok(googleCount >= 1, `${scenario.name} must retain an authoritative Google event`);
    assert.ok(googleCount <= 1, `${scenario.name} must not duplicate the Google event`);
    assert.equal(scenario.queue.length, 0, `${scenario.name} must clear confirmed waiting rows`);
    assert.equal(
      csvEventCount(generatedPayrollCsv(scenario.tabletRows), scenario.tabletEvent),
      1,
      `${scenario.name} must appear exactly once in tablet CSV`
    );
  }
});
