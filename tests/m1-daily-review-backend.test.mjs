import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  createAdminSession,
  postGoogle,
  readJson,
  runtimeConfig,
  runtimeTarget
} from '../netlify/functions/_lib/m1-common.mjs';
import {
  sanitizeAdminAdditionPayload,
  sanitizeAuditRecord,
  sanitizeDailyReviewPayload,
  sanitizeInstructorSearchPayload,
  sanitizeReviewRecord
} from '../netlify/functions/_lib/m1-admin-contracts.mjs';
import { handleAdminAdd } from '../netlify/functions/m1-admin-add.mjs';
import { handleAdminReview } from '../netlify/functions/m1-admin-review.mjs';
import { handleAdminSearch } from '../netlify/functions/m1-admin-search.mjs';

const ROOT = new URL('../', import.meta.url);
const RECEIVER = readFileSync(new URL('integrations/google-apps-script/GibM1Receiver.gs', ROOT), 'utf8');
const FIXTURE = JSON.parse(readFileSync(new URL('tests/fixtures/m1-daily-review-sheet.json', ROOT), 'utf8'));
const PREVIEW_ORIGIN = 'https://deploy-preview-99--gib-live.netlify.app';
const IMMUTABLE_ORIGIN = 'https://1234567890abcdef12345678--gib-live.netlify.app';
const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';
const PREVIEW_ENV = Object.freeze({
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'test-transport-token-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'test-admin-action-token-0987654321abcdef'
});
const PRODUCTION_ENV = Object.freeze({
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION_RECEIVER/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'test-production-transport-token-1234567890abcdef',
  GIB_M1_ADMIN_ACTION_TOKEN: 'test-production-admin-token-0987654321',
  GIB_M1_ADMIN_PASSPHRASE: 'violet harbor maple lantern',
  GIB_M1_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_LEGACY_RECEIVER/exec',
  GIB_M1_WEBHOOK_TOKEN: 'legacy-test-token'
});
const NOW = Date.parse('2026-08-10T16:00:00Z');
const REQUEST_TOKEN = Buffer.alloc(32, 0x19).toString('base64url');

function makeSheet(rows) {
  const values = rows.map(row => [...row]);
  let maxRows = 1000;
  return {
    values,
    appendRow(row) { values.push([...row]); },
    getDataRange() { return { getValues: () => values.map(row => [...row]) }; },
    getLastRow() { return values.length; },
    getMaxRows() { return maxRows; },
    insertRowsAfter(_after, count) { maxRows += count; },
    setFrozenRows() {},
    getRange(startRow, startColumn, rowCount, columnCount) {
      return {
        getValues() {
          return Array.from({ length: rowCount }, (_, rowOffset) => {
            const source = values[startRow - 1 + rowOffset] || [];
            return source.slice(startColumn - 1, startColumn - 1 + columnCount);
          });
        },
        setNumberFormat() { return this; },
        setValues(inputRows) {
          inputRows.forEach((source, rowOffset) => {
            const rowIndex = startRow - 1 + rowOffset;
            if (!values[rowIndex]) values[rowIndex] = [];
            source.forEach((value, columnOffset) => {
              values[rowIndex][startColumn - 1 + columnOffset] = value;
            });
          });
          return this;
        }
      };
    }
  };
}

function receiverHarness({ withAudit = true } = {}) {
  const signins = makeSheet([FIXTURE.headers, ...FIXTURE.rows]);
  let audit = withAudit ? makeSheet([FIXTURE.auditHeaders, ...FIXTURE.auditRows]) : null;
  let insertedAuditSheets = 0;
  const spreadsheet = {
    getName: () => 'RBJJ M1 — TEST',
    getSheetByName(name) {
      if (name === 'Signins') return signins;
      if (name === 'Admin Audit') return audit;
      return null;
    },
    insertSheet(name) {
      assert.equal(name, 'Admin Audit');
      insertedAuditSheets += 1;
      audit = makeSheet([]);
      return audit;
    }
  };
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    console,
    GIB_M1_ALLOWED_TARGET: 'test',
    GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA: true,
    TEST_SPREADSHEET_ID: 'synthetic-test-sheet',
    EXPECTED_SPREADSHEET_NAME: 'RBJJ M1 — TEST',
    SHEET_NAME: 'Signins',
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput(text) { return { text, setMimeType() { return this; } }; }
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty(name) {
          if (name === 'GIB_M1_RECEIVER_TRANSPORT_TOKEN') return 'receiver-token';
          if (name === 'GIB_M1_ADMIN_ACTION_TOKEN') return 'admin-token';
          if (name === 'GIB_M1_LEGACY_KIOSK_TOKEN') return 'legacy-token';
          if (name === 'GIB_M1_RECOVERY_TOKEN') return 'recovery-token';
          return '';
        }
      })
    },
    SpreadsheetApp: { openById: () => spreadsheet, flush() {} },
    Utilities: {
      formatDate(_date, _zone, pattern) {
        return pattern === 'yyyy-MM-dd HH:mm:ss' ? '2026-08-10 12:30:45' : '2026-08-10';
      }
    }
  });
  vm.runInContext(RECEIVER, context);
  return {
    signins,
    get audit() { return audit; },
    get insertedAuditSheets() { return insertedAuditSheets; },
    post(body) {
      const output = context.adReceiverV2_({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(output.text);
    }
  };
}

function adminRequest(origin, body, env = PREVIEW_ENV) {
  const config = runtimeConfig(env, { admin: true, requestUrl: `${origin}/m1/admin/` });
  const cookie = createAdminSession('Andrew Smith', config.sessionSecret, NOW, REQUEST_TOKEN);
  return new Request(`${origin}/.netlify/functions/m1-admin-review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`,
      [ADMIN_REQUEST_HEADER]: REQUEST_TOKEN
    },
    body: JSON.stringify(body)
  });
}

function googleResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('Admin runtime pins production, PR, and immutable hosts without legacy fallback', async () => {
  assert.equal(runtimeTarget(`${PRODUCTION_ORIGIN}/m1/admin/`), 'production');
  assert.equal(runtimeTarget(`${PREVIEW_ORIGIN}/m1/admin/`), 'test');
  assert.equal(runtimeTarget(`${IMMUTABLE_ORIGIN}/m1/admin/`), 'test');
  assert.equal(runtimeTarget('https://branch--gib-live.netlify.app/m1/admin/'), '');
  assert.equal(runtimeTarget('https://bjjsite.com/m1/admin/'), '');

  const production = runtimeConfig(PRODUCTION_ENV, {
    admin: true,
    requestUrl: `${PRODUCTION_ORIGIN}/m1/admin/`
  });
  assert.equal(production.webhookUrl, PRODUCTION_ENV.GIB_M1_PRODUCTION_WEBHOOK_URL);
  assert.equal(production.webhookToken, PRODUCTION_ENV.GIB_M1_PRODUCTION_WEBHOOK_TOKEN);
  assert.notEqual(production.webhookUrl, PRODUCTION_ENV.GIB_M1_WEBHOOK_URL);
  assert.equal(runtimeConfig(PRODUCTION_ENV, {
    admin: true,
    requestUrl: 'https://bjjsite.com/m1/admin/'
  }), null);
  assert.equal(runtimeConfig({
    ...PRODUCTION_ENV,
    GIB_M1_PRODUCTION_WEBHOOK_URL: PRODUCTION_ENV.GIB_M1_WEBHOOK_URL
  }, { admin: true, requestUrl: `${PRODUCTION_ORIGIN}/m1/admin/` }), null);

  const immutable = runtimeConfig(PREVIEW_ENV, {
    admin: true,
    requestUrl: `${IMMUTABLE_ORIGIN}/m1/admin/`
  });
  assert.equal(immutable.preview, true);
  assert.equal(immutable.webhookToken, PREVIEW_ENV.GIB_TEST_WEBHOOK_TOKEN);

  let forwarded;
  await postGoogle(immutable, 'dailyReview', { date: FIXTURE.reviewDate }, async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return googleResponse({ ok: true });
  });
  assert.deepEqual(forwarded, {
    date: FIXTURE.reviewDate,
    token: PREVIEW_ENV.GIB_TEST_WEBHOOK_TOKEN,
    action: 'dailyReview',
    target: 'test',
    adminActionToken: PREVIEW_ENV.GIB_TEST_ADMIN_ACTION_TOKEN
  });
});

test('production Admin handler forwards only the canonical production transport and target', async () => {
  const mixedEnv = { ...PRODUCTION_ENV, ...PREVIEW_ENV };
  let observedUrl = '';
  let observedBody = null;
  const response = await handleAdminReview(
    adminRequest(PRODUCTION_ORIGIN, { date: FIXTURE.reviewDate }, mixedEnv),
    {
      env: mixedEnv,
      now: NOW,
      dateNow: new Date(NOW),
      fetch: async (url, options) => {
        observedUrl = url;
        observedBody = JSON.parse(options.body);
        return googleResponse({
          ok: true,
          date: FIXTURE.reviewDate,
          records: [],
          warnings: [],
          auditHistory: []
        });
      }
    }
  );
  assert.equal(response.status, 200);
  assert.equal(observedUrl, PRODUCTION_ENV.GIB_M1_PRODUCTION_WEBHOOK_URL);
  assert.deepEqual(observedBody, {
    date: FIXTURE.reviewDate,
    token: PRODUCTION_ENV.GIB_M1_PRODUCTION_WEBHOOK_TOKEN,
    action: 'dailyReview',
    target: 'production',
    adminActionToken: PRODUCTION_ENV.GIB_M1_ADMIN_ACTION_TOKEN
  });
  const serialized = JSON.stringify(observedBody);
  assert.equal(serialized.includes(PREVIEW_ENV.GIB_TEST_WEBHOOK_TOKEN), false);
  assert.equal(serialized.includes(PRODUCTION_ENV.GIB_M1_WEBHOOK_TOKEN), false);
});

test('Daily Review isolates unreadable rows, preserves manual rows, and reads audit history without writes', () => {
  const harness = receiverHarness();
  const beforeSignins = structuredClone(harness.signins.values);
  const beforeAudit = structuredClone(harness.audit.values);
  const review = harness.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'dailyReview',
    target: 'test',
    date: FIXTURE.reviewDate
  });
  assert.equal(review.ok, true);
  assert.equal(review.records.length, 5);
  assert.equal(review.warnings.length, 1);
  assert.equal(review.auditHistory.length, 1);
  assert.equal(new Set(review.records.map(record => record.displayId)).size, 5);
  const manual = review.records.find(record => record.source === 'Manual');
  assert.equal(manual.recordId, '');
  assert.equal(manual.instructor, 'QA Test Manual');
  assert.equal(review.records.find(record => record.instructor === 'QA Test Unmatched').timestamp, '2026-08-10 08:00:09');
  assert.deepEqual(harness.signins.values, beforeSignins);
  assert.deepEqual(harness.audit.values, beforeAudit);

  const noAudit = receiverHarness({ withAudit: false });
  const withoutHistory = noAudit.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'dailyReview',
    target: 'test',
    date: FIXTURE.reviewDate
  });
  assert.deepEqual(withoutHistory.auditHistory, []);
  assert.equal(noAudit.insertedAuditSheets, 0);
});

test('Daily Review bounds display-only fields and isolates oversized record and audit fields', async () => {
  const harness = receiverHarness();
  const lengths = FIXTURE.boundaryLengths;
  harness.signins.values.push(
    [
      'r'.repeat(lengths.recordId),
      '2026-08-10 14:00:09',
      FIXTURE.reviewDate,
      '2:00 PM QA TEST Boundary Class',
      1,
      'QA Test Boundary',
      'Rev',
      'TEST tablet',
      'test-build',
      'n'.repeat(lengths.note),
      'OK'
    ],
    [
      'gib-m1-44444444-4444-4444-8444-444444444444',
      '2026-08-10 15:00:09',
      FIXTURE.reviewDate,
      'c'.repeat(lengths.classLabel),
      1,
      'QA Test Oversized Class',
      'Rev',
      'TEST tablet',
      'test-build',
      'DO NOT PAY',
      'OK'
    ],
    [
      'gib-m1-55555555-5555-4555-8555-555555555555',
      '2026-08-10 16:00:09',
      'not-a-date',
      '4:00 PM QA TEST Invalid Date',
      1,
      'QA Test Invalid Date',
      'Rev',
      'TEST tablet',
      'test-build',
      'DO NOT PAY',
      'OK'
    ]
  );
  harness.audit.values.push([
    2,
    'Andrew Smith',
    '2026-08-10 14:01:09',
    'i'.repeat(lengths.instructor),
    FIXTURE.reviewDate,
    '2:00 PM QA TEST Boundary Class',
    'Rev',
    1,
    'r'.repeat(lengths.auditReason),
    'added',
    'gib-admin-qa-boundary'
  ]);

  const review = harness.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'dailyReview',
    target: 'test',
    date: FIXTURE.reviewDate
  });
  assert.equal(review.ok, true);
  const bounded = review.records.find(record => record.instructor === 'QA Test Boundary');
  assert.equal(bounded.recordId.length, 240);
  assert.equal(bounded.notes.length, 800);
  assert.equal(review.records.some(record => record.instructor === 'QA Test Oversized Class'), false);
  assert.equal(review.auditHistory.length, 1);
  assert.equal(review.warnings.filter(warning => warning.code === 'UNREADABLE_SIGNIN').length, 2);
  assert.equal(review.warnings.filter(warning => warning.code === 'UNREADABLE_SIGNIN_DATE').length, 1);
  assert.equal(review.warnings.filter(warning => warning.code === 'UNREADABLE_AUDIT').length, 1);

  const response = await handleAdminReview(
    adminRequest(PREVIEW_ORIGIN, { date: FIXTURE.reviewDate }),
    {
      env: PREVIEW_ENV,
      now: NOW,
      dateNow: new Date(NOW),
      fetch: async () => googleResponse(review)
    }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).records.some(record => record.displayId === bounded.displayId), true);
});

test('maximum optional note stays attributed, readable, and tied to one audit', async () => {
  const harness = receiverHarness();
  const reason = `QA ${'r'.repeat(237)}`;
  const notes = 'n'.repeat(400);
  const auditRowsBefore = harness.audit.values.length;
  const added = harness.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'addMissedInstructor',
    target: 'test',
    requestId: 'qa-max-note',
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    classLabel: '7:00 PM QA TEST Boundary Class',
    duration: 1,
    instructor: 'QA Test Max Note',
    site: 'Rev',
    notes,
    reason
  });
  assert.equal(added.result, 'added');
  assert.equal(added.requestId, 'qa-max-note');
  assert.equal(added.linkedRecordId, 'gib-admin-qa-max-note');
  assert.equal(harness.audit.values.length, auditRowsBefore + 1);
  const storedNotes = harness.signins.values.at(-1)[9];
  assert.ok(storedNotes.length <= 800);
  assert.match(storedNotes, /^Admin-added \| Admin: Andrew Smith \| Reason: QA /u);
  assert.ok(storedNotes.endsWith(notes));

  const review = harness.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'dailyReview',
    target: 'test',
    date: FIXTURE.reviewDate
  });
  assert.equal(review.records.find(record => record.displayId === added.linkedDisplayId).notes, storedNotes);
  assert.equal(review.auditHistory.filter(audit => audit.actionNumber === added.auditActionNumber).length, 1);
  const response = await handleAdminReview(
    adminRequest(PREVIEW_ORIGIN, { date: FIXTURE.reviewDate }),
    {
      env: PREVIEW_ENV,
      now: NOW,
      dateNow: new Date(NOW),
      fetch: async () => googleResponse(review)
    }
  );
  assert.equal(response.status, 200);
});

test('forgotten-instructor add allows a second instructor, blocks a blank-RowID duplicate, and confirms audit details', () => {
  const harness = receiverHarness();
  const base = {
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'addMissedInstructor',
    target: 'test',
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    duration: 1,
    site: 'Rev',
    notes: 'DO NOT PAY',
    reason: 'QA forgotten sign-in'
  };
  const signinsBeforeDuplicate = structuredClone(harness.signins.values);
  const duplicate = harness.post({
    ...base,
    requestId: 'qa-manual-duplicate',
    classLabel: '5:30 PM BJJ (Level 2)',
    instructor: 'QA Test Manual'
  });
  assert.equal(duplicate.result, 'already exists');
  assert.equal(duplicate.linkedRecordId, '');
  assert.match(duplicate.linkedDisplayId, /^sheet-row-/);
  assert.deepEqual(harness.signins.values, signinsBeforeDuplicate);

  const beforeAddCount = harness.signins.values.length;
  const added = harness.post({
    ...base,
    requestId: 'qa-third-instructor',
    classLabel: '6:00 AM BJJ (Level 2)',
    instructor: 'QA Test Charlie'
  });
  assert.equal(added.result, 'added');
  assert.equal(harness.signins.values.length, beforeAddCount + 1);
  assert.equal(added.confirmation.instructor, 'QA Test Charlie');
  assert.ok(added.auditActionNumber > 0);
  const auditRow = harness.audit.values.at(-1);
  assert.deepEqual(auditRow.slice(1, 11), [
    'Andrew Smith',
    '2026-08-10 12:30:45',
    'QA Test Charlie',
    FIXTURE.reviewDate,
    '6:00 AM BJJ (Level 2)',
    'Rev',
    1,
    'QA forgotten sign-in',
    'added',
    added.linkedRecordId
  ]);
});

test('same existing-event request reuses one audit for blank and canonical linked RowIDs', () => {
  const cases = [
    {
      requestId: 'qa-replay-manual-existing',
      classLabel: '5:30 PM BJJ (Level 2)',
      instructor: 'QA Test Manual',
      linkedRecordId: ''
    },
    {
      requestId: 'qa-replay-canonical-existing',
      classLabel: '6:00 AM BJJ (Level 2)',
      instructor: 'QA Test Alpha',
      linkedRecordId: 'gib-m1-11111111-1111-4111-8111-111111111111'
    }
  ];

  for (const item of cases) {
    const harness = receiverHarness();
    const body = {
      token: 'receiver-token',
      adminActionToken: 'admin-token',
      action: 'addMissedInstructor',
      target: 'test',
      requestId: item.requestId,
      adminName: 'Andrew Smith',
      date: FIXTURE.reviewDate,
      classLabel: item.classLabel,
      duration: 1,
      instructor: item.instructor,
      site: 'Rev',
      notes: 'DO NOT PAY',
      reason: 'QA forgotten sign-in'
    };
    const signinsBefore = structuredClone(harness.signins.values);
    const auditsBefore = harness.audit.values.length;
    const first = harness.post(body);
    const replay = harness.post(body);

    assert.equal(first.result, 'already exists');
    assert.equal(replay.result, 'already exists');
    assert.equal(first.requestId, item.requestId);
    assert.equal(replay.requestId, item.requestId);
    assert.equal(first.linkedRecordId, item.linkedRecordId);
    assert.equal(replay.linkedRecordId, item.linkedRecordId);
    assert.equal(replay.linkedDisplayId, first.linkedDisplayId);
    assert.equal(replay.auditActionNumber, first.auditActionNumber);
    assert.equal(harness.audit.values.length, auditsBefore + 1);
    assert.deepEqual(harness.signins.values, signinsBefore);
  }
});

test('multiple exact existing-event audits fail closed without another mutation', () => {
  const harness = receiverHarness();
  const body = {
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'addMissedInstructor',
    target: 'test',
    requestId: 'qa-ambiguous-existing-audit',
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    classLabel: '5:30 PM BJJ (Level 2)',
    duration: 1,
    instructor: 'QA Test Manual',
    site: 'Rev',
    notes: 'DO NOT PAY',
    reason: 'QA forgotten sign-in'
  };
  const first = harness.post(body);
  assert.equal(first.result, 'already exists');

  const duplicateAudit = [...harness.audit.values.at(-1)];
  duplicateAudit[0] = first.auditActionNumber + 1;
  harness.audit.values.push(duplicateAudit);
  const signinsBefore = structuredClone(harness.signins.values);
  const auditsBefore = structuredClone(harness.audit.values);
  const replay = harness.post(body);

  assert.equal(replay.result, 'failed');
  assert.deepEqual(harness.signins.values, signinsBefore);
  assert.deepEqual(harness.audit.values, auditsBefore);
});

test('an unreadable same-event row cannot suppress a valid Admin correction', () => {
  const harness = receiverHarness();
  harness.signins.values.push([
    'legacy-invalid-duration',
    '2026-08-10 15:00:09',
    FIXTURE.reviewDate,
    '3:00 PM QA TEST Invalid Duration',
    0,
    'QA Test Invalid Duration',
    'Rev',
    'Manual import',
    'legacy-build',
    'DO NOT PAY',
    'OK'
  ]);
  const malformedDisplayId = `sheet-row-${harness.signins.values.length}`;
  const reviewRequest = {
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'dailyReview',
    target: 'test',
    date: FIXTURE.reviewDate
  };
  const beforeReview = harness.post(reviewRequest);
  assert.equal(beforeReview.records.some(record => record.displayId === malformedDisplayId), false);
  assert.equal(beforeReview.warnings.some(warning => warning.displayId === malformedDisplayId), true);

  const signinsBefore = harness.signins.values.length;
  const auditsBefore = harness.audit.values.length;
  const added = harness.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'addMissedInstructor',
    target: 'test',
    requestId: 'qa-correct-invalid-duration',
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    classLabel: '3:00 PM QA TEST Invalid Duration',
    duration: 1,
    instructor: 'QA Test Invalid Duration',
    site: 'Rev',
    notes: 'DO NOT PAY',
    reason: 'QA forgotten sign-in'
  });

  assert.equal(added.result, 'added');
  assert.equal(added.linkedRecordId, 'gib-admin-qa-correct-invalid-duration');
  assert.equal(harness.signins.values.length, signinsBefore + 1);
  assert.equal(harness.audit.values.length, auditsBefore + 1);
  const afterReview = harness.post(reviewRequest);
  assert.equal(afterReview.records.some(record => record.displayId === added.linkedDisplayId), true);
  assert.equal(afterReview.warnings.some(warning => warning.displayId === malformedDisplayId), true);
});

test('oversized stored RowID is projected consistently before audit and response contracts', () => {
  const harness = receiverHarness();
  harness.signins.values.push([
    'x'.repeat(241),
    '2026-08-10 15:30:09',
    FIXTURE.reviewDate,
    '3:30 PM QA TEST Oversized ID',
    1,
    'QA Test Oversized ID',
    'Rev',
    'Manual import',
    'legacy-build',
    'DO NOT PAY',
    'OK'
  ]);
  const body = {
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'addMissedInstructor',
    target: 'test',
    requestId: 'qa-oversized-existing-id',
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    classLabel: '3:30 PM QA TEST Oversized ID',
    duration: 1,
    instructor: 'QA Test Oversized ID',
    site: 'Rev',
    notes: 'DO NOT PAY',
    reason: 'QA forgotten sign-in'
  };
  const expected = {
    requestId: body.requestId,
    adminName: body.adminName,
    date: body.date,
    classLabel: body.classLabel,
    duration: body.duration,
    instructor: body.instructor,
    site: body.site,
    reason: body.reason,
    notes: body.notes
  };
  const signinsBefore = structuredClone(harness.signins.values);
  const auditsBefore = harness.audit.values.length;
  const first = harness.post(body);
  const replay = harness.post(body);

  assert.equal(first.result, 'already exists');
  assert.equal(replay.result, 'already exists');
  assert.equal(first.linkedRecordId, '');
  assert.equal(replay.linkedRecordId, '');
  assert.equal(replay.auditActionNumber, first.auditActionNumber);
  assert.equal(harness.audit.values.length, auditsBefore + 1);
  assert.equal(harness.audit.values.at(-1)[10], '');
  assert.deepEqual(harness.signins.values, signinsBefore);
  assert.ok(sanitizeAdminAdditionPayload(first, expected));
  assert.ok(sanitizeAdminAdditionPayload(replay, expected));

  const review = harness.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'dailyReview',
    target: 'test',
    date: FIXTURE.reviewDate
  });
  const audit = review.auditHistory.find(item => item.actionNumber === first.auditActionNumber);
  assert.equal(audit.linkedRecordId, '');
  assert.equal(audit.result, 'already exists');
});

test('same request heals a row-only interruption once and then replays idempotently', () => {
  const harness = receiverHarness();
  const requestId = 'qa-interrupted-audit';
  const reason = 'QA interrupted audit';
  harness.signins.values.push([
    `gib-admin-${requestId}`,
    '2026-08-10 17:00:09',
    FIXTURE.reviewDate,
    '5:00 PM QA TEST Interrupted Class',
    1,
    'QA Test Interrupted',
    'Rev',
    'Admin Daily Review',
    'm1-unified-august-rollout-2026',
    `Admin-added | Admin: Andrew Smith | Reason: ${reason}`,
    'OK'
  ]);
  const body = {
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'addMissedInstructor',
    target: 'test',
    requestId,
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    classLabel: '5:00 PM QA TEST Interrupted Class',
    duration: 1,
    instructor: 'QA Test Interrupted',
    site: 'Rev',
    notes: '',
    reason
  };
  const signinsBefore = harness.signins.values.length;
  const auditsBefore = harness.audit.values.length;
  const healed = harness.post(body);
  const replay = harness.post(body);
  assert.equal(healed.result, 'added');
  assert.equal(replay.result, 'added');
  assert.equal(healed.requestId, requestId);
  assert.equal(replay.requestId, requestId);
  assert.equal(replay.auditActionNumber, healed.auditActionNumber);
  assert.equal(harness.signins.values.length, signinsBefore);
  assert.equal(harness.audit.values.length, auditsBefore + 1);
});

test('named audit-schema drift blocks correction before Signins mutation', () => {
  const harness = receiverHarness();
  harness.audit.values[0].push('Unexpected named column');
  const signinsBefore = structuredClone(harness.signins.values);
  const response = harness.post({
    token: 'receiver-token',
    adminActionToken: 'admin-token',
    action: 'addMissedInstructor',
    target: 'test',
    requestId: 'qa-audit-schema-drift',
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    classLabel: '8:00 PM QA TEST Schema Drift',
    duration: 1,
    instructor: 'QA Test Schema Drift',
    site: 'Rev',
    notes: '',
    reason: 'QA forgotten sign-in'
  });
  assert.equal(response.result, 'failed');
  assert.deepEqual(harness.signins.values, signinsBefore);
});

test('Netlify rejects mismatched review dates and partial add confirmations with secret-safe classes', async () => {
  const reviewRequest = adminRequest(PREVIEW_ORIGIN, { date: FIXTURE.reviewDate });
  const review = await handleAdminReview(reviewRequest, {
    env: PREVIEW_ENV,
    now: NOW,
    dateNow: new Date(NOW),
    fetch: async () => googleResponse({
      ok: true,
      date: '2026-08-09',
      records: [],
      warnings: [],
      auditHistory: []
    })
  });
  assert.equal(review.status, 502);
  assert.equal((await review.json()).code, 'DAILY_REVIEW_CONTRACT_MISMATCH');

  const addRequest = adminRequest(PREVIEW_ORIGIN, {
    requestId: 'qa-partial-confirmation',
    date: FIXTURE.reviewDate,
    classLabel: '6:00 AM BJJ (Level 2)',
    duration: 1,
    instructor: 'QA Test Delta',
    site: 'Rev',
    notes: '',
    reason: 'QA forgotten sign-in'
  });
  const add = await handleAdminAdd(addRequest, {
    env: PREVIEW_ENV,
    now: NOW,
    dateNow: new Date(NOW),
    fetch: async () => googleResponse({
      ok: true,
      result: 'added',
      requestId: 'qa-partial-confirmation',
      linkedRecordId: 'gib-admin-qa-partial-confirmation',
      linkedDisplayId: 'sheet-row-10',
      auditActionNumber: 0,
      confirmation: {
        adminName: 'Andrew Smith',
        date: FIXTURE.reviewDate,
        classLabel: '6:00 AM BJJ (Level 2)',
        duration: 1,
        instructor: 'QA Test Delta',
        site: 'Rev',
        reason: 'QA forgotten sign-in',
        notes: ''
      }
    })
  });
  assert.equal(add.status, 502);
  assert.equal((await add.json()).code, 'ADMIN_ADD_CONTRACT_MISMATCH');
});

test('Netlify Daily Review fails closed on duplicate audit action numbers with distinct audit IDs', async () => {
  const audit = {
    auditId: 'audit-row-2',
    actionNumber: 7,
    adminName: 'Andrew Smith',
    actionTime: '2026-08-10 12:30:45',
    instructor: 'QA Test Contract',
    classDate: FIXTURE.reviewDate,
    classLabel: '6:00 AM BJJ (Level 2)',
    site: 'Rev',
    duration: 1,
    reason: 'QA forgotten sign-in',
    result: 'added',
    linkedRecordId: 'gib-admin-qa-contract'
  };
  const response = await handleAdminReview(
    adminRequest(PREVIEW_ORIGIN, { date: FIXTURE.reviewDate }),
    {
      env: PREVIEW_ENV,
      now: NOW,
      dateNow: new Date(NOW),
      fetch: async () => googleResponse({
        ok: true,
        date: FIXTURE.reviewDate,
        records: [],
        warnings: [],
        auditHistory: [audit, { ...audit, auditId: 'audit-row-3' }]
      })
    }
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: 'DAILY_REVIEW_CONTRACT_MISMATCH',
    message: 'Google returned an incomplete Daily Review response. Nothing changed.'
  });
});

test('strict contract mutation matrix rejects semantic drift and unsafe boundary values', () => {
  const record = {
    displayId: 'sheet-row-2',
    recordId: 'gib-admin-qa-contract',
    timestamp: '2026-08-10 12:30:45',
    date: FIXTURE.reviewDate,
    classLabel: '6:00 AM BJJ (Level 2)',
    duration: 1,
    instructor: 'QA Test Contract',
    site: 'Rev',
    notes: '',
    source: 'Admin-added',
    reviewRequired: false,
    reviewMessage: ''
  };
  assert.ok(sanitizeReviewRecord(record, FIXTURE.reviewDate));
  for (const mutation of [
    { timestamp: '2026-99-99 12:30:45' },
    { date: '2026-02-31' },
    { classLabel: 'c'.repeat(201) },
    { instructor: 'i'.repeat(101) },
    { site: 's'.repeat(81) },
    { notes: 'n'.repeat(801) },
    { source: 'Collision review' },
    { unexpected: true }
  ]) assert.equal(sanitizeReviewRecord({ ...record, ...mutation }, FIXTURE.reviewDate), null);

  const audit = {
    auditId: 'audit-row-2',
    actionNumber: 1,
    adminName: 'Andrew Smith',
    actionTime: '2026-08-10 12:30:45',
    instructor: record.instructor,
    classDate: FIXTURE.reviewDate,
    classLabel: record.classLabel,
    site: record.site,
    duration: 1,
    reason: 'QA forgotten sign-in',
    result: 'added',
    linkedRecordId: record.recordId
  };
  assert.ok(sanitizeAuditRecord(audit, FIXTURE.reviewDate));
  for (const mutation of [
    { adminName: 'False Admin' },
    { actionNumber: Number.MAX_SAFE_INTEGER + 1 },
    { actionTime: '2026-99-99 12:30:45' },
    { reason: 'r'.repeat(241) },
    { linkedRecordId: 'r'.repeat(241) },
    { linkedRecordId: '' }
  ]) assert.equal(sanitizeAuditRecord({ ...audit, ...mutation }, FIXTURE.reviewDate), null);

  assert.equal(sanitizeDailyReviewPayload({
    ok: true,
    date: FIXTURE.reviewDate,
    records: [record],
    warnings: [],
    auditHistory: [audit, { ...audit, auditId: 'audit-row-3' }]
  }, FIXTURE.reviewDate), null);

  const search = {
    ok: true,
    instructor: record.instructor,
    date: FIXTURE.reviewDate,
    selectedDateRecords: [record],
    recentRecords: [record]
  };
  assert.ok(sanitizeInstructorSearchPayload(
    search,
    record.instructor,
    FIXTURE.reviewDate,
    FIXTURE.reviewDate
  ));
  assert.equal(sanitizeInstructorSearchPayload({
    ...search,
    recentRecords: [{ ...record, instructor: 'QA Test Other' }]
  }, record.instructor, FIXTURE.reviewDate, FIXTURE.reviewDate), null);
  assert.equal(sanitizeInstructorSearchPayload({
    ...search,
    recentRecords: [{ ...record, date: '2026-08-11' }]
  }, record.instructor, FIXTURE.reviewDate, FIXTURE.reviewDate), null);
  assert.equal(sanitizeInstructorSearchPayload({
    ...search,
    recentRecords: Array.from({ length: 6 }, (_value, index) => ({
      ...record,
      displayId: `sheet-row-${index + 2}`
    }))
  }, record.instructor, FIXTURE.reviewDate, FIXTURE.reviewDate), null);

  const expected = {
    requestId: 'qa-contract',
    adminName: 'Andrew Smith',
    date: FIXTURE.reviewDate,
    classLabel: record.classLabel,
    duration: 1,
    instructor: record.instructor,
    site: record.site,
    reason: 'QA forgotten sign-in',
    notes: ''
  };
  const addition = {
    ok: true,
    result: 'added',
    requestId: expected.requestId,
    linkedRecordId: `gib-admin-${expected.requestId}`,
    linkedDisplayId: 'sheet-row-8',
    auditActionNumber: 2,
    confirmation: {
      adminName: expected.adminName,
      date: expected.date,
      classLabel: expected.classLabel,
      duration: expected.duration,
      instructor: expected.instructor,
      site: expected.site,
      reason: expected.reason,
      notes: expected.notes
    }
  };
  assert.ok(sanitizeAdminAdditionPayload(addition, expected));
  assert.equal(sanitizeAdminAdditionPayload({ ...addition, requestId: 'wrong' }, expected), null);
  assert.equal(sanitizeAdminAdditionPayload({ ...addition, linkedRecordId: 'unbound' }, expected), null);
  assert.equal(sanitizeAdminAdditionPayload({
    ...addition,
    auditActionNumber: Number.MAX_SAFE_INTEGER + 1
  }, expected), null);
});

test('request, cookie, and upstream failure matrix fails closed without reading declared oversize bodies', async () => {
  let requestBodyReads = 0;
  const declaredOversize = await readJson({
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      'Content-Length': '5000'
    }),
    async text() { requestBodyReads += 1; return '{}'; }
  }, 4096);
  assert.equal(declaredOversize.response.status, 400);
  assert.equal(requestBodyReads, 0);

  const config = runtimeConfig(PREVIEW_ENV, {
    admin: true,
    requestUrl: `${PREVIEW_ORIGIN}/m1/admin/`
  });
  const cases = [
    ['UNREACHABLE', async () => { throw new Error('secret-canary'); }],
    ['READ_FAILED', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() { throw new Error('secret-canary'); }
    })],
    ['HTTP_FAILURE', async () => new Response('failed', { status: 500 })],
    ['EMPTY', async () => new Response('')],
    ['OVERSIZE', async () => new Response('{}', { headers: { 'Content-Length': '300000' } })],
    ['HTML', async () => new Response('<!doctype html><html></html>')],
    ['UNSUPPORTED_JSON', async () => new Response('[]')],
    ['MALFORMED_JSON', async () => new Response('{')]
  ];
  for (const [expectedClass, fetchImpl] of cases) {
    const result = await postGoogle(config, 'dailyReview', { date: FIXTURE.reviewDate }, fetchImpl);
    assert.equal(result.failureClass, expectedClass);
    assert.doesNotMatch(JSON.stringify(result), /secret-canary|test-admin-action-token/u);
  }

  const malformedCookie = await handleAdminReview(new Request(
    `${PREVIEW_ORIGIN}/.netlify/functions/m1-admin-review`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${ADMIN_COOKIE}=%`,
        [ADMIN_REQUEST_HEADER]: REQUEST_TOKEN
      },
      body: JSON.stringify({ date: FIXTURE.reviewDate })
    }
  ), { env: PREVIEW_ENV, now: NOW, dateNow: new Date(NOW) });
  assert.equal(malformedCookie.status, 401);
});

test('Admin request envelopes reject coercion, extras, and noncanonical dates before Google', async () => {
  const cases = [
    [handleAdminReview, { date: [FIXTURE.reviewDate] }],
    [handleAdminReview, { date: FIXTURE.reviewDate, extra: true }],
    [handleAdminSearch, { instructor: 'QA Test Instructor', date: ` ${FIXTURE.reviewDate}` }],
    [handleAdminSearch, { instructor: 'QA Test Instructor', date: FIXTURE.reviewDate, extra: true }],
    [handleAdminAdd, {
      requestId: 'qa-schema',
      date: ` ${FIXTURE.reviewDate}`,
      classLabel: '6:00 AM BJJ (Level 2)',
      duration: 1,
      instructor: 'QA Test Schema',
      site: 'Rev',
      notes: '',
      reason: 'QA forgotten sign-in'
    }],
    [handleAdminAdd, {
      requestId: 'qa-schema',
      date: FIXTURE.reviewDate,
      classLabel: '6:00 AM BJJ (Level 2)',
      duration: '1',
      instructor: 'QA Test Schema',
      site: 'Rev',
      notes: '',
      reason: 'QA forgotten sign-in'
    }]
  ];
  for (const [handler, body] of cases) {
    let calls = 0;
    const response = await handler(adminRequest(PREVIEW_ORIGIN, body), {
      env: PREVIEW_ENV,
      now: NOW,
      dateNow: new Date(NOW),
      fetch: async () => { calls += 1; return googleResponse({ ok: true }); }
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  }
});

test('Admin credentials are domain-separated and cross-scope equality fails closed', () => {
  const preview = runtimeConfig(PREVIEW_ENV, {
    admin: true,
    requestUrl: `${PREVIEW_ORIGIN}/m1/admin/`
  });
  assert.ok(preview);
  assert.equal(preview.adminPassphrase, '');
  assert.notEqual(preview.sessionSecret, preview.webhookToken);
  assert.notEqual(preview.sessionSecret, preview.adminActionToken);

  for (const env of [
    { ...PREVIEW_ENV, GIB_TEST_ADMIN_ACTION_TOKEN: 'short' },
    {
      ...PREVIEW_ENV,
      GIB_M1_PRODUCTION_WEBHOOK_TOKEN: PREVIEW_ENV.GIB_TEST_WEBHOOK_TOKEN
    },
    {
      ...PREVIEW_ENV,
      GIB_M1_ADMIN_ACTION_TOKEN: PREVIEW_ENV.GIB_TEST_ADMIN_ACTION_TOKEN
    }
  ]) assert.equal(runtimeConfig(env, {
    admin: true,
    requestUrl: `${PREVIEW_ORIGIN}/m1/admin/`
  }), null);

  for (const env of [
    {
      ...PRODUCTION_ENV,
      GIB_TEST_WEBHOOK_TOKEN: PRODUCTION_ENV.GIB_M1_PRODUCTION_WEBHOOK_TOKEN
    },
    {
      ...PRODUCTION_ENV,
      GIB_TEST_ADMIN_ACTION_TOKEN: PRODUCTION_ENV.GIB_M1_ADMIN_ACTION_TOKEN
    },
    {
      ...PRODUCTION_ENV,
      GIB_M1_RECOVERY_TOKEN: PRODUCTION_ENV.GIB_M1_ADMIN_PASSPHRASE
    }
  ]) assert.equal(runtimeConfig(env, {
    admin: true,
    requestUrl: `${PRODUCTION_ORIGIN}/m1/admin/`
  }), null);

  const allDistinctEnv = {
    ...PREVIEW_ENV,
    ...PRODUCTION_ENV,
    GIB_TEST_LEGACY_KIOSK_TOKEN: 'test-legacy-kiosk-token-1234567890abcdef',
    GIB_M1_LEGACY_KIOSK_TOKEN: 'production-legacy-kiosk-token-1234567890',
    GIB_M1_RECOVERY_TOKEN: 'production-recovery-token-1234567890abcdef',
    GIB_M1_PRODUCTION_DEVICE_TOKEN: 'production-device-token-1234567890abcdef',
    GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: 'production-install-token-1234567890abcdef'
  };
  for (const [origin, target] of [
    [PREVIEW_ORIGIN, 'test'],
    [PRODUCTION_ORIGIN, 'production']
  ]) {
    assert.equal(runtimeConfig(allDistinctEnv, {
      admin: true,
      requestUrl: `${origin}/m1/admin/`
    })?.target, target);
  }

  const sensitiveKeys = [
    'GIB_TEST_WEBHOOK_TOKEN',
    'GIB_TEST_ADMIN_ACTION_TOKEN',
    'GIB_TEST_LEGACY_KIOSK_TOKEN',
    'GIB_M1_PRODUCTION_WEBHOOK_TOKEN',
    'GIB_M1_ADMIN_ACTION_TOKEN',
    'GIB_M1_ADMIN_PASSPHRASE',
    'GIB_M1_LEGACY_KIOSK_TOKEN',
    'GIB_M1_WEBHOOK_TOKEN',
    'GIB_M1_RECOVERY_TOKEN',
    'GIB_M1_PRODUCTION_DEVICE_TOKEN',
    'GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET'
  ];
  const sharedSecret = 'shared cedar orbit lantern meadow 1234567890';
  for (let left = 0; left < sensitiveKeys.length; left += 1) {
    for (let right = left + 1; right < sensitiveKeys.length; right += 1) {
      const duplicateEnv = {
        ...allDistinctEnv,
        [sensitiveKeys[left]]: sharedSecret,
        [sensitiveKeys[right]]: sharedSecret
      };
      for (const origin of [PREVIEW_ORIGIN, PRODUCTION_ORIGIN]) {
        assert.equal(runtimeConfig(duplicateEnv, {
          admin: true,
          requestUrl: `${origin}/m1/admin/`
        }), null, `${sensitiveKeys[left]} must differ from ${sensitiveKeys[right]} at ${origin}`);
      }
    }
  }
});
