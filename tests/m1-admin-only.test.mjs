import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
const kioskHtml = read('m1/index.html');
const guestHtml = read('guests/index.html');
const adminHtml = read('m1/admin/index.html');
const tabletDiagnosticHtml = read('m1/tablet-diagnostic.html');
const schedule = JSON.parse(read('m1/shared-schedule.json'));
const commonSource = read('netlify/functions/_lib/m1-common.mjs');
const receiverSource = read('integrations/google-apps-script/GibM1Receiver.gs');
const fixedNow = Date.parse('2026-07-26T15:00:00Z');
const fixedDateNow = new Date('2026-07-26T15:00:00Z');
const fixedRequestToken = Buffer.alloc(32, 9).toString('base64url');
const RECOVERY_INCIDENT_ID = 'M1-2026-08-03_04';

const previewUrl = 'https://deploy-preview-99--gib-live.netlify.app';
const immutablePreviewUrl = 'https://1234567890abcdef12345678--gib-live.netlify.app';
const productionUrl = 'https://gib-live.netlify.app';
const previewEnv = Object.freeze({
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/TEST_ID/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'test-receiver-token-long-enough',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'test-admin-action-token-long-enough'
});
const productionEnv = Object.freeze({
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/PROD_ID/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'production-receiver-token-long-enough',
  GIB_M1_ADMIN_ACTION_TOKEN: 'production-admin-action-token-long-enough',
  GIB_M1_ADMIN_PASSPHRASE: 'four memorable private words'
});

function reviewRecord(overrides = {}) {
  return {
    displayId: 'sheet-row-2',
    recordId: 'one',
    timestamp: '2026-07-25 10:00:09',
    date: '2026-07-25',
    classLabel: '10:00 AM Kids\u2019 BJJ',
    duration: 0.5,
    instructor: 'QA Test Instructor',
    site: 'Rev',
    notes: '',
    source: 'Kiosk',
    reviewRequired: false,
    reviewMessage: '',
    ...overrides
  };
}

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

function makeSheet(initialRows = [], options = {}) {
  const values = initialRows.map(row => [...row]);
  let maxRows = Math.max(options.maxRows || 1000, values.length);
  return {
    values,
    appendRow(row) {
      values.push([...row]);
    },
    deleteRow(rowNumber) {
      values.splice(rowNumber - 1, 1);
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
          if (typeof options.beforeSetValues === 'function') {
            options.beforeSetValues({ startRow, startColumn, rowCount, columnCount, rows });
          }
          rows.forEach((source, rowOffset) => {
            const rowIndex = startRow - 1 + rowOffset;
            if (!values[rowIndex]) values[rowIndex] = [];
            source.forEach((value, columnOffset) => {
              values[rowIndex][startColumn - 1 + columnOffset] = value;
            });
          });
          return this;
        },
        setNumberFormat() {
          return this;
        }
      };
    },
    getMaxRows() {
      return maxRows;
    },
    insertRowsAfter(afterRow, count) {
      assert.equal(afterRow, maxRows);
      maxRows += count;
    },
    setFrozenRows() {}
  };
}

function receiverHarness({
  testSpreadsheet = false,
  productionSpreadsheet = true,
  allowedTarget = testSpreadsheet && !productionSpreadsheet ? 'test' : 'production',
  receiverToken = 'receiver-token',
  adminActionToken = '',
  legacyKioskToken = 'legacy-kiosk-token',
  recoveryToken = 'recovery-token',
  recoveryWriteIncident = '',
  failAfterAppends = null,
  rows = []
} = {}) {
  let appendFailureAfter = failAfterAppends;
  let appendAttempts = 0;
  const signins = makeSheet([SIGNIN_HEADERS, ...rows], {
    beforeSetValues({ startRow, startColumn, columnCount }) {
      if (startRow < 2 || startColumn !== 1 || columnCount !== SIGNIN_HEADERS.length) return;
      if (Number.isInteger(appendFailureAfter) && appendAttempts >= appendFailureAfter) {
        throw new Error('simulated append interruption');
      }
      appendAttempts += 1;
    }
  });
  let audit = null;
  let spreadsheetOpens = 0;
  const spreadsheet = {
    getId: () => testSpreadsheet ? 'test-spreadsheet' : 'production-spreadsheet',
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
    EXPECTED_SPREADSHEET_NAME: 'Expected Signins',
    SHEET_NAME: 'Signins',
    GIB_M1_ALLOWED_TARGET: allowedTarget,
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
          if (name === 'GIB_M1_RECEIVER_TRANSPORT_TOKEN') return receiverToken;
          if (name === 'GIB_M1_ADMIN_ACTION_TOKEN') return adminActionToken;
          if (name === 'GIB_M1_LEGACY_KIOSK_TOKEN') return legacyKioskToken;
          if (name === 'GIB_M1_RECOVERY_TOKEN') return recoveryToken;
          if (name === 'GIB_M1_RECOVERY_WRITE_INCIDENT') return recoveryWriteIncident;
          return '';
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
      Charset: { UTF_8: 'UTF_8' },
      computeHmacSha256Signature(value, secret, charset) {
        assert.equal(charset, 'UTF_8');
        return [...createHmac('sha256', String(secret)).update(String(value)).digest()];
      },
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
    clearAppendFailure() { appendFailureAfter = null; },
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

function signinSheetRow(row, status = 'OK') {
  return [
    row.RowID,
    row.Timestamp,
    row.Date,
    row['Class Label'],
    row['Duration (hr)'],
    row.Instructor,
    row.Site,
    row.Device || '',
    row.Build || '',
    row.Notes || '',
    status
  ];
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

function recoveryRow(id, overrides = {}) {
  return {
    RecoveryID: id,
    Timestamp: '2026-07-25 09:00:00',
    Date: '2026-07-25',
    'Class Label': 'TEST Recovery Class',
    'Duration (hr)': 1,
    Instructor: 'QA Recovery Instructor',
    Site: 'TEST',
    Notes: 'TEST ONLY',
    ...overrides
  };
}

function privateTestHmac(value, secret = 'recovery-token') {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function recoveryCanonicalKey(row) {
  return JSON.stringify([
    row.Timestamp,
    row.Date,
    row['Class Label'],
    String(Number(row['Duration (hr)'])),
    row.Instructor,
    row.Site,
    row.Notes || ''
  ]);
}

function recoveryRequest(rows, overrides = {}) {
  const target = overrides.target || 'test';
  const spreadsheetId = target === 'test' ? 'test-spreadsheet' : 'production-spreadsheet';
  const targetProof = privateTestHmac(`gib-m1-target\u001f${spreadsheetId}\u001fExpected Signins`);
  const candidateMaterial = rows.map(row => {
    return `${row.RecoveryID}\u001f${privateTestHmac(recoveryCanonicalKey(row))}`;
  }).sort().join('\n');
  return {
    token: 'receiver-token',
    recoveryToken: 'recovery-token',
    incidentId: RECOVERY_INCIDENT_ID,
    action: 'recoverSignins',
    target,
    expectedTargetProof: targetProof,
    expectedCandidateCount: rows.length,
    expectedCandidateSetDigest: privateTestHmac(candidateMaterial),
    rows,
    ...overrides
  };
}

test('legacy {token, rows} payload remains readable and backward-compatible', () => {
  const harness = receiverHarness({ testSpreadsheet: true, productionSpreadsheet: false });
  const first = harness.post({ token: 'legacy-kiosk-token', rows: [kioskRow()] });
  const retry = harness.post({ token: 'legacy-kiosk-token', rows: [kioskRow()] });
  const mixed = harness.post({
    token: 'legacy-kiosk-token',
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

test('legacy append authentication is isolated and fails closed before writes', () => {
  const harness = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'admin-action-token'
  });
  const before = harness.signins.values.length;
  for (const body of [
    { rows: [kioskRow()] },
    { token: 'wrong-legacy-token', rows: [kioskRow()] },
    { token: 'receiver-token', rows: [kioskRow()] },
    { token: 'admin-action-token', rows: [kioskRow()] }
  ]) {
    assert.equal(harness.post(body).result, 'rejected');
  }
  const malformed = harness.post({ token: 'legacy-kiosk-token', rows: [{ RowID: 'bad' }] });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.results[0].result, 'rejected');
  assert.equal(harness.signins.values.length, before);
  const opensBeforeAdminScopeCheck = harness.spreadsheetOpens;

  const legacyCannotAdmin = harness.post({
    token: 'legacy-kiosk-token',
    adminActionToken: 'admin-action-token',
    action: 'dailyReview',
    target: 'production',
    date: '2026-07-25'
  });
  assert.equal(legacyCannotAdmin.result, 'rejected');
  assert.equal(harness.spreadsheetOpens, opensBeforeAdminScopeCheck);
});

test('legacy exact kiosk replay adds zero duplicate rows', () => {
  const harness = receiverHarness({ testSpreadsheet: true, productionSpreadsheet: false });
  const base = kioskRow();
  const exact = harness.post({ token: 'legacy-kiosk-token', rows: [base] });
  const replay = harness.post({ token: 'legacy-kiosk-token', rows: [base] });
  assert.equal(exact.results[0].result, 'added');
  assert.equal(replay.results[0].result, 'already exists');
  assert.equal(harness.signins.values.length, 2);
});

test('legitimate repeated coarse business events remain distinct', () => {
  const harness = receiverHarness({ testSpreadsheet: true, productionSpreadsheet: false });
  const exact = harness.post({ token: 'legacy-kiosk-token', rows: [kioskRow()] });
  const distinct = harness.post({
    token: 'legacy-kiosk-token',
    rows: [kioskRow({ RowID: 'same-business-new-time', Timestamp: '2026-07-25 09:00:01' })]
  });
  assert.equal(exact.results[0].result, 'added');
  assert.equal(distinct.results[0].result, 'added');
  assert.equal(harness.signins.values.length, 3);
});

test('recovery writes and rollback stay disabled until the incident gate is explicitly open', () => {
  const closed = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'admin-action-token'
  });
  const request = recoveryRequest([recoveryRow('REC-001')]);
  assert.equal(closed.post(request).result, 'disabled');
  assert.equal(closed.post({
    token: 'receiver-token',
    recoveryToken: 'recovery-token',
    incidentId: RECOVERY_INCIDENT_ID,
    action: 'rollbackRecoveredSignins',
    target: 'test',
    expectedTargetProof: 'opaque-test-proof',
    receipt: [{ candidateId: 'REC-001', rowId: 'gib-recovery-REC-001', fingerprint: '0'.repeat(64) }]
  }).result, 'disabled');
  assert.equal(closed.signins.values.length, 1);
  assert.equal(closed.spreadsheetOpens, 0);

  const readOnly = closed.post({
    token: 'receiver-token',
    recoveryToken: 'recovery-token',
    action: 'recoveryList',
    target: 'test',
    fromDate: '2026-07-25'
  });
  assert.equal(readOnly.ok, true);
  assert.equal(closed.spreadsheetOpens, 1);

  const propertyOnly = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'admin-action-token',
    recoveryWriteIncident: RECOVERY_INCIDENT_ID
  });
  assert.equal(propertyOnly.post({ ...request, incidentId: '' }).result, 'disabled');
  assert.equal(propertyOnly.signins.values.length, 1);
});

test('recovery is target-bound, retry-safe, and rollback revalidates exact fingerprints', () => {
  const harness = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'admin-action-token',
    recoveryWriteIncident: RECOVERY_INCIDENT_ID
  });
  const rows = [
    recoveryRow('REC-001'),
    recoveryRow('REC-002', { Timestamp: '2026-07-25 10:00:00' })
  ];
  const request = recoveryRequest(rows);
  const first = harness.post(request);
  const retry = harness.post(request);
  assert.equal(first.ok, true);
  assert.deepEqual(first.results.map(item => item.result), ['added', 'added']);
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.results.map(item => item.result), ['already exists', 'already exists']);
  assert.equal(harness.signins.values.length, 3);

  const receipt = first.results.map(item => ({
    candidateId: item.candidateId,
    rowId: item.rowId,
    fingerprint: item.fingerprint
  }));
  const duplicateRollback = harness.post({
    token: 'receiver-token',
    recoveryToken: 'recovery-token',
    incidentId: RECOVERY_INCIDENT_ID,
    action: 'rollbackRecoveredSignins',
    target: 'test',
    expectedTargetProof: first.targetProof,
    receipt: [receipt[0], receipt[0]]
  });
  assert.equal(duplicateRollback.result, 'rejected');
  assert.equal(harness.signins.values.length, 3);
  const badRollback = harness.post({
    token: 'receiver-token',
    recoveryToken: 'recovery-token',
    incidentId: RECOVERY_INCIDENT_ID,
    action: 'rollbackRecoveredSignins',
    target: 'test',
    expectedTargetProof: first.targetProof,
    receipt: receipt.map((item, index) => index ? item : { ...item, fingerprint: '0'.repeat(64) })
  });
  assert.equal(badRollback.result, 'conflict');
  assert.equal(harness.signins.values.length, 3);

  const rollback = harness.post({
    token: 'receiver-token',
    recoveryToken: 'recovery-token',
    incidentId: RECOVERY_INCIDENT_ID,
    action: 'rollbackRecoveredSignins',
    target: 'test',
    expectedTargetProof: first.targetProof,
    receipt
  });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.removed, 2);
  assert.equal(harness.signins.values.length, 1);
});

test('recovery candidate proofs preserve Unicode with explicit UTF-8 HMACs', () => {
  const harness = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'admin-action-token',
    recoveryWriteIncident: RECOVERY_INCIDENT_ID
  });
  const row = recoveryRow('REC-015', {
    'Class Label': 'TEST Kids\u2019 BJJ',
    Instructor: 'TEST Jos\u00e9 Instructor'
  });
  const response = harness.post(recoveryRequest([row]));
  assert.equal(response.ok, true);
  assert.equal(response.results[0].result, 'added');
  assert.equal((receiverSource.match(/Utilities\.Charset\.UTF_8/g) || []).length, 3);
});

test('partial recovery interruption is safe to retry to completion', () => {
  const harness = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'admin-action-token',
    recoveryWriteIncident: RECOVERY_INCIDENT_ID,
    failAfterAppends: 1
  });
  const rows = [
    recoveryRow('REC-001'),
    recoveryRow('REC-002', { Timestamp: '2026-07-25 10:00:00' })
  ];
  const request = recoveryRequest(rows);
  const interrupted = harness.post(request);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.result, 'partial');
  assert.equal(harness.signins.values.length, 2);
  harness.clearAppendFailure();
  const retry = harness.post(request);
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.results.map(item => item.result), ['already exists', 'added']);
  assert.equal(harness.signins.values.length, 3);
});

test('recovery and Admin credentials cannot cross scopes', () => {
  const harness = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'admin-action-token',
    recoveryWriteIncident: RECOVERY_INCIDENT_ID
  });
  const request = recoveryRequest([recoveryRow('REC-001')]);
  assert.equal(harness.post({ ...request, recoveryToken: 'admin-action-token' }).result, 'rejected');
  assert.equal(harness.post({ ...request, token: 'legacy-kiosk-token' }).result, 'rejected');
  assert.equal(harness.post({
    token: 'receiver-token',
    adminActionToken: 'recovery-token',
    action: 'dailyReview',
    target: 'test',
    date: '2026-07-25'
  }).result, 'rejected');
  assert.equal(harness.signins.values.length, 1);
});

test('kiosk requires readable same-origin row acknowledgments and never clears the whole queue', () => {
  assert.doesNotMatch(kioskHtml, /mode:\s*['"]no-cors['"]/u);
  assert.doesNotMatch(kioskHtml, /SYNC_URL_KEY|SYNC_TOKEN_KEY/u);
  assert.doesNotMatch(kioskHtml, /saveSyncQueue\(\[\]\)/u);
  assert.match(kioskHtml, /requestAcknowledgements\(submittedRows/u);
  assert.match(kioskHtml, /applyAcknowledgements\([\s\S]*submittedRows/u);
  assert.match(kioskHtml, /if \(!applied\.readable\) throw/u);
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

test('TEST receiver keeps receiver and Admin credentials separate and requires fake instructor data', () => {
  const harness = receiverHarness({
    testSpreadsheet: true,
    productionSpreadsheet: false,
    adminActionToken: 'test-admin-action-token'
  });
  const review = harness.post({
    token: 'receiver-token',
    adminActionToken: 'test-admin-action-token',
    action: 'dailyReview',
    target: 'test',
    date: '2026-07-25'
  });
  assert.equal(review.ok, true);
  assert.equal(harness.post({
    token: 'receiver-token',
    adminActionToken: 'test-admin-action-token',
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
  assert.equal(previewConfig.adminActionToken, previewEnv.GIB_TEST_ADMIN_ACTION_TOKEN);
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
      adminActionToken: previewEnv.GIB_TEST_ADMIN_ACTION_TOKEN,
      action: 'dailyReview',
      target: 'test'
    }
  );
});

test('production Admin configuration fails closed without every private value', () => {
  assert.equal(runtimeConfig({}, { admin: true, requestUrl: `${productionUrl}/m1/admin/` }), null);
  assert.equal(runtimeConfig({
    ...productionEnv,
    GIB_M1_ADMIN_ACTION_TOKEN: ''
  }, { admin: true, requestUrl: `${productionUrl}/m1/admin/` }), null);
  assert.equal(runtimeConfig({
    ...productionEnv,
    GIB_M1_ADMIN_PASSPHRASE: 'three weak words'
  }, { admin: true, requestUrl: `${productionUrl}/m1/admin/` }), null);
  assert.equal(runtimeConfig(productionEnv, {
    admin: true,
    requestUrl: `${productionUrl}/m1/admin/`
  }).adminActionToken, productionEnv.GIB_M1_ADMIN_ACTION_TOKEN);
});

test('production requires the scoped transport credential and never falls back to legacy', () => {
  const shortProductionEnv = {
    ...productionEnv,
    GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'short'
  };
  assert.equal(runtimeConfig(shortProductionEnv, {
    admin: true,
    requestUrl: `${productionUrl}/m1/admin/`
  }), null);
  assert.equal(runtimeConfig({
    GIB_M1_WEBHOOK_URL: 'https://script.google.com/macros/s/LEGACY_ID/exec',
    GIB_M1_WEBHOOK_TOKEN: 'legacy-receiver-token-long-enough',
    GIB_M1_ADMIN_ACTION_TOKEN: productionEnv.GIB_M1_ADMIN_ACTION_TOKEN,
    GIB_M1_ADMIN_PASSPHRASE: productionEnv.GIB_M1_ADMIN_PASSPHRASE
  }, { admin: true, requestUrl: `${productionUrl}/m1/admin/` }), null);
  assert.equal(runtimeConfig({
    ...previewEnv,
    GIB_TEST_WEBHOOK_TOKEN: 'short'
  }, { admin: true, requestUrl: `${previewUrl}/m1/admin/` }), null);
  assert.equal(runtimeConfig({
    ...productionEnv,
    GIB_M1_ADMIN_ACTION_TOKEN: 'short'
  }, { admin: true, requestUrl: `${productionUrl}/m1/admin/` }), null);
});

test('Admin passphrase policy and production login are enforced', async () => {
  assert.equal(validAdminPassphrase('alpha beta gamma delta'), true);
  assert.equal(validAdminPassphrase('alpha-bravo-charlie-delta'), true);
  assert.equal(validAdminPassphrase('one two three four'), false);
  assert.equal(validAdminPassphrase('repeat repeat repeat repeat'), false);
  assert.equal(validAdminPassphrase('alpha beta gamma delta\n'), false);
  assert.equal(validAdminPassphrase('alpha beta gamma ' + 'd'.repeat(240)), false);

  const valid = await handleAdminLogin(
    jsonRequest(`${productionUrl}/.netlify/functions/m1-admin-login`, {
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
  assert.equal(isDeployPreview({}, `${immutablePreviewUrl}/m1/admin/`), true);
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
    jsonRequest(`${productionUrl}/.netlify/functions/m1-admin-login`, {
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
        date: '2026-07-25',
        records: [reviewRecord()],
        warnings: [],
        auditHistory: []
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
        instructor: 'QA Test Instructor',
        date: '2026-07-25',
        selectedDateRecords: [reviewRecord()],
        recentRecords: Array.from({ length: 5 }, (_, index) => reviewRecord({
          displayId: `sheet-row-${index + 2}`,
          recordId: String(index)
        }))
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
        requestId: 'qa-add',
        linkedRecordId: 'gib-admin-qa-add',
        linkedDisplayId: 'sheet-row-2',
        auditActionNumber: 1,
        confirmation: {
          adminName: 'Stuart Turner',
          date: '2026-07-25',
          classLabel: '10:00 AM Kids\u2019 BJJ',
          duration: 0.5,
          instructor: 'QA Test Instructor',
          site: 'Rev',
          reason: 'Missed tablet sign-in',
          notes: ''
        }
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

test('Admin-first delayed kiosk collisions are retained for audit and visibly held for review', () => {
  const adminFirst = receiverHarness({ adminActionToken: 'production-admin-token' });
  assert.equal(adminFirst.post(adminAddition()).result, 'added');
  const delayedRequest = {
    token: 'receiver-token',
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow({ RowID: 'gib-m1-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })]
  };
  const delayed = adminFirst.post(delayedRequest);
  assert.equal(delayed.results[0].result, 'review required');
  assert.equal(adminFirst.signins.values.length, 3);
  assert.equal(adminFirst.signins.values[2][7], 'Kiosk collision review');
  assert.equal(adminFirst.signins.values[2][10], 'REVIEW');
  assert.equal(adminFirst.audit.values.length, 2);
  const review = adminFirst.post({
    token: 'receiver-token',
    adminActionToken: 'production-admin-token',
    action: 'dailyReview',
    target: 'production',
    date: '2026-07-25'
  });
  assert.equal(review.ok, true);
  assert.equal(review.records.length, 2);
  assert.equal(review.records.filter(record => record.reviewRequired).length, 1);
  assert.equal(review.records.find(record => record.reviewRequired).source, 'Collision review');
  assert.match(review.records.find(record => record.reviewRequired).reviewMessage, /review before payroll/i);
  assert.equal(adminFirst.post(delayedRequest).results[0].result, 'already exists');
  assert.equal(adminFirst.signins.values.length, 3);

  const kioskFirst = receiverHarness({ adminActionToken: 'production-admin-token' });
  assert.equal(kioskFirst.post({
    token: 'receiver-token',
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow({ RowID: 'gib-m1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })]
  }).results[0].result, 'added');
  assert.equal(kioskFirst.post(adminAddition()).result, 'already exists');
  assert.equal(kioskFirst.signins.values.length, 2);
  assert.equal(kioskFirst.audit.values.length, 2);
});

test('Daily Review browser visibly labels possible Admin and kiosk duplicates', () => {
  assert.match(adminHtml, /Review possible duplicate/);
  assert.match(adminHtml, /possible Admin\/kiosk duplicate/);
  assert.match(adminHtml, /reviewRequired/);
});

test('exact Admin request replay returns the original result and one audit entry', () => {
  const harness = receiverHarness({ adminActionToken: 'production-admin-token' });
  const first = harness.post(adminAddition());
  const retry = harness.post(adminAddition());
  assert.equal(first.result, 'added');
  assert.equal(retry.result, 'added');
  assert.equal(retry.requestId, first.requestId);
  assert.equal(harness.signins.values.length, 2);
  assert.equal(harness.audit.values.length, 2);
  assert.ok(first.auditActionNumber > 0);
  assert.equal(retry.auditActionNumber, first.auditActionNumber);
});

test('Admin request IDs remain permanent after payload changes or VOID', () => {
  const changed = receiverHarness({ adminActionToken: 'production-admin-token' });
  assert.equal(changed.post(adminAddition()).result, 'added');
  assert.equal(changed.post(adminAddition({ reason: 'Changed retry payload' })).result, 'rejected');
  assert.equal(changed.signins.values.length, 2);

  const voidedAdminRow = kioskRow({
    RowID: 'gib-admin-qa-admin-one',
    Device: 'Admin Daily Review',
    Build: 'm1-admin-only-couch-rollout',
    Notes: 'Admin-added | Admin: Stuart Turner | Reason: Missed tablet sign-in'
  });
  const voided = receiverHarness({
    adminActionToken: 'production-admin-token',
    rows: [signinSheetRow(voidedAdminRow, 'VOID')]
  });
  assert.equal(voided.post(adminAddition()).result, 'rejected');
  assert.equal(voided.signins.values.length, 2);
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
      requestId: body.requestId,
      linkedRecordId: `gib-admin-${body.requestId}`,
      linkedDisplayId: 'sheet-row-2',
      auditActionNumber: auditNumber,
      confirmation: {
        adminName: body.adminName,
        date: body.date,
        classLabel: body.classLabel,
        duration: body.duration,
        instructor: body.instructor,
        site: body.site,
        reason: body.reason,
        notes: body.notes
      }
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
    /Daily Review uses the current canonical regular weekly schedule from the Revolution BJJ website\. Recorded sign-ins with historical, local-override, or Series labels remain visible as unmatched rather than being hidden\./
  );
  assert.match(adminHtml, /schedule:\s*'\/api\/m1-schedule'/);
  assert.match(adminHtml, /function validateScheduleResponse\(value\)/);
  assert.match(adminHtml, /id="scheduleSource"[^>]*role="status"/);
  assert.match(adminHtml, /Version: \$\{schedule\.version\}/);
  assert.match(adminHtml, /scheduleBootstrap:\s*'\/m1\/shared-schedule\.json'/);
  assert.match(adminHtml, /function loadCheckedInScheduleBootstrap\(reason/);
  assert.match(adminHtml, /const SCHEDULE_REFRESH_INTERVAL_MS = 10 \* 60 \* 1_000;/);
  assert.match(adminHtml, /window\.setInterval\(refreshCanonicalSchedule, SCHEDULE_REFRESH_INTERVAL_MS\)/);
  assert.match(adminHtml, /visibilitychange[\s\S]*resume[\s\S]*focus[\s\S]*pageshow/);
  assert.match(adminHtml, /function reviewFormInProgress\(\)[\s\S]*\.add-form\.open/);
  assert.match(adminHtml, /scheduleRenderPending = true/);
  assert.equal(validNonFutureDate('2025-01-10', fixedDateNow), true);
  assert.equal(validNonFutureDate('2026-07-27', fixedDateNow), false);
});

test('Admin addition UX binds fixed identity, requires duration, confirms, refreshes, and labels Admin rows', () => {
  assert.match(adminHtml, /fixedValue\('Date'/);
  assert.match(adminHtml, /fixedValue\('Class'/);
  assert.match(adminHtml, /fixedValue\('Site'/);
  assert.match(adminHtml, /inputField\('Duration \(choose explicitly\)', durationSelect\)/);
  assert.match(adminHtml, /const ADMIN_DURATION_OPTIONS = Object\.freeze\(\[1, 0\.5\]\)/);
  assert.doesNotMatch(adminHtml, /durationForClass|\bkids[^\n]*\?\s*0\.5/iu);
  assert.match(adminHtml, /Required reason/);
  assert.match(adminHtml, /Notes \(optional\)/);
  assert.match(adminHtml, /window\.confirm\(/);
  assert.match(adminHtml, /await loadReview\(date\)/);
  assert.match(adminHtml, /Admin-added/);
  assert.doesNotMatch(adminHtml, /payroll approval|dashboard|analytics|void sign-in/i);
  assert.doesNotMatch(adminHtml, /<button[^>]*>[^<]*(?:schedule|void|approve)/i);
});

test('Daily Review keeps every correction path visible and renders strict manual, warning, and audit contracts', () => {
  assert.match(adminHtml, /href="\/m1\/\?view=admin"[^>]*>Local M1 Admin<\/a>/);
  assert.match(adminHtml, /href="\/m1\/"[^>]*>Instructor Sign-In<\/a>/);
  assert.doesNotMatch(adminHtml, /href="\/m1\/(?:\?view=admin)?"[^>]*(?:target=|onclick=)/);

  const classRowSource = adminHtml.slice(
    adminHtml.indexOf('function classRow('),
    adminHtml.indexOf('function renderReview(')
  );
  assert.match(classRowSource, /instructors\.join\(' \+ '\)/);
  assert.match(classRowSource, /Add forgotten instructor/);
  assert.match(classRowSource, /record\.source === 'Manual'[\s\S]*Manual Sheet row/);
  assert.match(classRowSource, /row\.append\(main, buildAddForm\(label, index\)\)/);
  assert.equal((classRowSource.match(/return row;/g) || []).length, 1);
  assert.match(adminHtml, /\.forgotten-action\s*\{[\s\S]*min-height:\s*44px/);

  assert.match(adminHtml, /matchedDisplayIds\.add\(record\.displayId\)/);
  assert.doesNotMatch(adminHtml, /matchedRecordIds\.add\(record\.recordId\)/);
  assert.match(adminHtml, /Manual Sheet row/);
  assert.match(adminHtml, /id="warningSection"[\s\S]*Sheet rows needing attention/);
  assert.match(adminHtml, /id="auditSection"[\s\S]*Forgotten sign-in audit history/);
  assert.match(adminHtml, /function warningElement\(/);
  assert.match(adminHtml, /function auditElement\(/);
  assert.match(adminHtml, /function validDailyReviewResponse\(/);
  assert.match(adminHtml, /function validAdminAdditionResponse\(/);
  assert.match(adminHtml, /Google did not fully confirm the correction\. Success is not being reported\./);
  assert.match(adminHtml, /Daily Review refreshed immediately\./);
  assert.match(adminHtml, /const generation = \+\+reviewLoadGeneration/);
  assert.match(adminHtml, /generation !== reviewLoadGeneration/);
  assert.match(adminHtml, /record\.displayId === data\.linkedDisplayId/);
  assert.match(adminHtml, /audit\.actionNumber === data\.auditActionNumber/);
  assert.match(adminHtml, /validInstructorSearchResponse\(data, instructor, date\)/);
});

test('Daily Review rejects duplicate audit action numbers before any success state is rendered', async () => {
  const validatorsSource = adminHtml.slice(
    adminHtml.indexOf('function exactObjectKeys('),
    adminHtml.indexOf('function validAdminAdditionResponse(')
  );
  const context = vm.createContext({ REVIEW_NOTES_MAX_LENGTH: 800 });
  new vm.Script(`${validatorsSource}\nthis.validDailyReviewResponse = validDailyReviewResponse;`)
    .runInContext(context);

  const audit = {
    auditId: 'audit-row-2',
    actionNumber: 7,
    adminName: 'Andrew Smith',
    actionTime: '2026-07-25 10:00:00',
    instructor: 'QA Test Instructor',
    classDate: '2026-07-25',
    classLabel: '10:00 AM Kids\u2019 BJJ',
    site: 'Rev',
    duration: 0.5,
    reason: 'QA forgotten sign-in',
    result: 'added',
    linkedRecordId: 'gib-admin-qa-audit-identity'
  };
  const mutatedResponse = {
    ok: true,
    test: true,
    adminName: 'Stuart Turner',
    date: '2026-07-25',
    records: [reviewRecord()],
    warnings: [],
    auditHistory: [audit, { ...audit, auditId: 'audit-row-3' }]
  };
  assert.equal(context.validDailyReviewResponse(mutatedResponse, mutatedResponse.date), false);

  const loadReviewSource = adminHtml.slice(
    adminHtml.indexOf('async function loadReview('),
    adminHtml.indexOf('function uniqueRequestId(')
  );
  const messages = [];
  let successStateCalls = 0;
  const element = () => ({
    value: '',
    textContent: '',
    disabled: false,
    hidden: false,
    classList: { add() {}, remove() {} },
    replaceChildren() {}
  });
  const elements = new Map();
  Object.assign(context, {
    schedule: {},
    reviewLoadGeneration: 0,
    currentDate: '',
    currentRecords: [],
    currentWarnings: [],
    currentAuditHistory: [],
    API: { review: '/.netlify/functions/m1-admin-review' },
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    nyDate: () => '2026-07-26',
    defaultYesterday: () => '2026-07-25',
    formatDateHeading: value => value,
    showMessage: (_target, message) => messages.push(message),
    requestJson: async () => mutatedResponse,
    setLoggedIn: () => { successStateCalls += 1; },
    renderReview: () => { successStateCalls += 1; },
    setLoggedOut: () => {},
    renderRecordList: () => {},
    auditElement: () => {}
  });
  new vm.Script(`${loadReviewSource}\nthis.loadReview = loadReview;`).runInContext(context);
  assert.equal(await context.loadReview(mutatedResponse.date), false);
  assert.equal(successStateCalls, 0);
  assert.equal(messages.at(-1), 'Daily Review returned an incomplete response. Nothing on the Sheet was changed.');
});

test('browser correction identity is schedule-reorder safe, opaque, and stable across indeterminate retries', () => {
  const helpersSource = adminHtml.slice(
    adminHtml.indexOf('function uniqueRequestId('),
    adminHtml.indexOf('async function addInstructor(')
  );
  let randomCalls = 0;
  const context = vm.createContext({
    ADMIN_DURATION_OPTIONS: [1, 0.5],
    Uint32Array,
    JSON,
    String,
    Number,
    clean: value => String(value == null ? '' : value).trim().replace(/\s+/gu, ' '),
    crypto: {
      getRandomValues(values) {
        randomCalls += 1;
        values.fill(randomCalls);
        return values;
      }
    }
  });
  new vm.Script(`${helpersSource}\nthis.helpers = { readAdditionForm, requestIdForAddition, clearAdditionRequestId };`)
    .runInContext(context);

  const originalClass = `6:00 AM ${'C'.repeat(191)}`.slice(0, 200);
  const form = {
    dataset: {
      reviewDate: '2026-08-10',
      classLabel: originalClass,
      site: 'Rev'
    },
    elements: {
      duration: { value: '0.5' },
      instructor: { value: 'QA Test First' },
      reason: { value: 'QA forgotten sign-in' },
      notes: { value: '' }
    }
  };
  const firstAddition = context.helpers.readAdditionForm(form);
  assert.equal(firstAddition.classLabel, originalClass);
  assert.equal(firstAddition.duration, 0.5);
  const firstId = context.helpers.requestIdForAddition(form, firstAddition);
  assert.match(firstId, /^m1-2026-08-10-[a-f0-9]{24}$/u);
  assert.equal(context.helpers.requestIdForAddition(form, firstAddition), firstId);
  assert.equal(randomCalls, 1, 'An unchanged retry must reuse its original request ID.');

  // A background schedule reorder cannot affect the class bound into the open form.
  context.schedule = { days: { Monday: ['A different reordered class'] } };
  assert.equal(context.helpers.readAdditionForm(form).classLabel, originalClass);

  form.elements.instructor.value = 'QA Test Second';
  const secondAddition = context.helpers.readAdditionForm(form);
  const secondId = context.helpers.requestIdForAddition(form, secondAddition);
  assert.notEqual(secondId, firstId);
  assert.equal(randomCalls, 2);
  context.helpers.clearAdditionRequestId(form);
  assert.equal(form.dataset.requestId, undefined);

  const addSource = adminHtml.slice(
    adminHtml.indexOf('async function addInstructor('),
    adminHtml.indexOf('function renderRecordList(')
  );
  assert.doesNotMatch(addSource, /schedule\.days|durationForClass/u);
  assert.match(addSource, /requestIdForAddition\(form, addition\)/u);
  assert.match(addSource, /clearAdditionRequestId\(form\)/u);
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
  for (const [name, html] of [['Admin', adminHtml], ['guests', guestHtml], ['tablet diagnostic', tabletDiagnosticHtml]]) {
    forbidden.forEach(pattern => assert.doesNotMatch(html, pattern, `${name} contains ${pattern}`));
  }
});

test('browser source has no backend credential, private Sheet, or deployment ID', () => {
  const browserSource = [adminHtml, guestHtml, tabletDiagnosticHtml, JSON.stringify(schedule)].join('\n');
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
  for (const [name, html] of [['Admin', adminHtml], ['guests', guestHtml], ['tablet diagnostic', tabletDiagnosticHtml]]) {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)]
      .map(match => match[1])
      .filter(source => source.trim());
    scripts.forEach((source, index) => {
      assert.doesNotThrow(() => new vm.Script(source, { filename: `${name}-inline-${index}.js` }));
    });
  }
});

test('tablet diagnostic has no network permission and removes the browser credential path', () => {
  assert.match(tabletDiagnosticHtml, /connect-src 'none'/);
  assert.match(tabletDiagnosticHtml, /Kiosk transport[\s\S]*Browser credential[\s\S]*Auto-sync[\s\S]*Current queue count[\s\S]*Current local-history record count/);
  assert.match(tabletDiagnosticHtml, /'SAME-ORIGIN'\s*:\s*'UNEXPECTED'/);
  assert.match(tabletDiagnosticHtml, /'ABSENT'\s*:\s*'UNEXPECTED'/);
  assert.doesNotMatch(tabletDiagnosticHtml, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|console\.|clipboard/);
  assert.match(tabletDiagnosticHtml, /OBSOLETE_BROWSER_SYNC_KEYS\.forEach\(key => localStorage\.removeItem\(key\)\)/u);
  assert.match(tabletDiagnosticHtml, /localStorage\.setItem\(AUTO_SYNC_KEY,\s*'false'\)/u);
  assert.doesNotMatch(tabletDiagnosticHtml, /localStorage\.setItem\([^\n]*(?:sync_url|sync_token)/u);
  assert.doesNotMatch(tabletDiagnosticHtml, /script\.google\.com|macros\/s\/|installEnvelope|decryptInstall/u);
  assert.doesNotMatch(tabletDiagnosticHtml, /AKfy[A-Za-z0-9_-]{20,}|GIB_(?:M1|TEST)_/u);
});
