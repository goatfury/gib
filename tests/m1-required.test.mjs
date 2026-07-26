import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

import {
  ADMIN_COOKIE,
  createAdminSession,
  isDeployPreview,
  runtimeConfig,
  sanitizeKioskRows,
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
const kioskHtml = read('m1/index.html');
const adminHtml = read('m1/admin/index.html');
const schedule = JSON.parse(read('m1/shared-schedule.json'));
const appsScriptSource = read('integrations/google-apps-script/GibM1Receiver.gs');

const kioskContext = vm.createContext({});
vm.runInContext(read('m1/kiosk-safety.js'), kioskContext);
const safety = kioskContext.GibM1Safety;

const appsContext = vm.createContext({
  module: { exports: {} },
  exports: {},
  console
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
  GIB_M1_ADMIN_PASSPHRASE: 'four memorable words here'
});
const fixedNow = Date.parse('2026-07-26T15:00:00Z');
const fixedDateNow = new Date('2026-07-26T15:00:00Z');

function jsonRequest(url, body, cookie = '') {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

function previewCookie(adminName = 'Stuart Turner') {
  const config = runtimeConfig(previewEnv, { admin: true });
  return `${ADMIN_COOKIE}=${encodeURIComponent(createAdminSession(adminName, config.sessionSecret, fixedNow))}`;
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

test('01 first-run setup blocks sign-in until gym, location, and site exist', () => {
  assert.match(kioskHtml, /missingDeviceSetupFields/);
  assert.match(kioskHtml, /Device setup required before sign-in/);
});

test('02 normal sign-in creates one safe row', () => {
  assert.equal(sanitizeKioskRows([kioskRow()]).length, 1);
  assert.match(kioskHtml, /saveSignins\(rows\.concat\(newRows\)\)/);
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
  const voided = { ...kioskRow(), Status: 'VOID' };
  assert.equal(safety.reconcileQueue([kioskRow()], [voided]).length, 0);
  assert.match(kioskHtml, /saveSignins\(rows\);\s+reconcileSyncQueue\(\);\s+updateSyncStatus\(\)/);
});

test('13 Clear All leaves no orphaned waiting rows', () => {
  assert.equal(safety.reconcileQueue([kioskRow()], []).length, 0);
  assert.match(kioskHtml, /saveSignins\(\[\]\);\s+reconcileSyncQueue\(\)/);
});

test('14 Reset preserves sign-ins and the waiting list while Factory Reset names both', () => {
  const resetBody = kioskHtml.slice(
    kioskHtml.indexOf('function resetDevice()'),
    kioskHtml.indexOf('function factoryReset()')
  );
  assert.doesNotMatch(resetBody, /removeItem\(SIGNINS_KEY\)|removeItem\(SYNC_QUEUE_KEY\)/);
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
  const response = await handleAdminLogout(jsonRequest('https://example.test/logout', {}));
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
      previewCookie()
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
      previewCookie()
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
    jsonRequest('https://deploy-preview-44--gib-live.netlify.app/.netlify/functions/m1-admin-add', payload, previewCookie()),
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
