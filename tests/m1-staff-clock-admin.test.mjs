import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const adminHtml = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function idCount(id) {
  return (adminHtml.match(new RegExp(`\\bid="${id}"`, 'gu')) || []).length;
}

const PUNCH_ONE = 'gib-m1-staff-11111111-1111-4111-8111-111111111111';
const PUNCH_TWO = 'gib-m1-staff-22222222-2222-4222-8222-222222222222';
const REQUEST_ONE = 'gib-m1-staff-request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function validatorRuntime() {
  const functions = sourceBetween(
    adminHtml,
    'function validStaffId(',
    'function validDiagnosticIssueResponse('
  );
  const context = vm.createContext({ Date, Object, Set, JSON });
  new vm.Script(`
    const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_TIMESTAMP_PATTERN = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}-(?:04|05):00$/;
    const SITE = 'Rev';
    let testMode = true;
    let currentAdminName = 'Andrew Smith';
    function clean(value) {
      return String(value == null ? '' : value).normalize('NFKC').trim().replace(/\\s+/g, ' ');
    }
    function isObject(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }
    function exactObjectKeys(value, expectedKeys) {
      if (!isObject(value)) return false;
      const actual = Object.keys(value).sort();
      const expected = [...expectedKeys].sort();
      return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
    }
    function validReviewDate(value) {
      if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split('-').map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    }
    ${functions}
    globalThis.hooks = { validStaffTimeReviewResponse, validStaffMutationResponse };
  `, { filename: 'staff-time-admin-validators.js' }).runInContext(context);
  return context.hooks;
}

function reviewResponse() {
  const record = {
    punchId: PUNCH_ONE,
    timestamp: '2026-08-18T17:27:00-04:00',
    date: '2026-08-18',
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: 'clockIn',
    site: 'Rev',
    device: 'Admin Staff Time',
    build: 'm1b-staff-clock',
    note: 'Missed punch',
    status: 'ACTIVE',
    source: 'Admin-added',
    adminName: 'Andrew Smith'
  };
  return {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    staff: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }],
    records: [record],
    clockedInNow: [{
      punchId: PUNCH_ONE,
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      clockInAt: record.timestamp
    }],
    todayPunches: [{
      punchId: PUNCH_ONE,
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      punchAction: 'clockIn',
      timestamp: record.timestamp,
      source: 'Admin-added',
      status: 'ACTIVE'
    }],
    needsAttention: [],
    periods: {
      current: {
        startDate: '2026-08-10',
        endDate: '2026-08-23',
        totals: [{
          staffId: 'mandy-test',
          staffName: 'Mandy Test',
          completedShifts: 0,
          totalSeconds: 0,
          needsAttention: false
        }]
      },
      previous: {
        startDate: '2026-07-27',
        endDate: '2026-08-09',
        totals: [{
          staffId: 'mandy-test',
          staffName: 'Mandy Test',
          completedShifts: 1,
          totalSeconds: 13_020,
          needsAttention: false
        }]
      }
    },
    audit: [{
      requestId: REQUEST_ONE,
      actionTime: '2026-08-18T17:28:00-04:00',
      adminName: 'Andrew Smith',
      operation: 'correct',
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      punchTimestamp: record.timestamp,
      punchAction: 'clockIn',
      reason: 'Missed punch',
      result: 'added',
      linkedPunchId: PUNCH_ONE
    }]
  };
}

test('Daily Review remains first and one compact Staff time section follows it', () => {
  const app = sourceBetween(adminHtml, '<section id="appPanel"', '<div id="toast"');
  const reviewPosition = app.indexOf('id="reviewSection"');
  const instructorSearchPosition = app.indexOf('Find an Instructor');
  const staffPosition = app.indexOf('id="staff-time"');
  assert.ok(reviewPosition >= 0);
  assert.ok(instructorSearchPosition > reviewPosition);
  assert.ok(staffPosition > instructorSearchPosition);
  assert.equal(idCount('staff-time'), 1);
  assert.match(app, /<details id="staff-time"[^>]*\bopen\b[^>]*\btabindex="-1"/u);
  assert.match(app, /Clocked in now[\s\S]*Today’s punches[\s\S]*Needs attention/u);
  assert.match(app, /<details id="staffPayPeriods"[^>]*>\s*<summary>Pay-period totals<\/summary>/u);
  assert.doesNotMatch(app.match(/<details id="staffPayPeriods"[^>]*>/u)?.[0] || '', /\bopen\b/u);
  assert.match(app, /Fix missed punch/u);
  assert.match(app, /Staff Time records[\s\S]*Staff time audit/u);
});

test('Staff time reuses the existing secured Admin request path and loads only after login', () => {
  assert.match(adminHtml, /staffTime:\s*'\/\.netlify\/functions\/m1-admin-staff-time'/u);
  const requestSource = sourceBetween(adminHtml, 'async function requestJson(', 'function setLoggedOut(');
  assert.match(requestSource, /credentials:\s*'same-origin'/u);
  assert.match(requestSource, /cache:\s*'no-store'/u);
  assert.match(requestSource, /headers\[ADMIN_REQUEST_HEADER\] = adminRequestToken/u);
  const loginSource = sourceBetween(adminHtml, 'async function login(', 'async function logout(');
  const token = loginSource.indexOf('adminRequestToken = data.requestToken');
  const review = loginSource.indexOf('await loadReview(defaultYesterday())');
  const staff = loginSource.indexOf('await loadStaffTime()');
  assert.ok(token >= 0 && review > token && staff > review);
  const loadSource = sourceBetween(adminHtml, 'async function loadStaffTime(', 'async function submitStaffCorrection(');
  assert.match(loadSource, /requestJson\(API\.staffTime, \{ operation: 'review' \}\)/u);
  assert.match(loadSource, /validStaffTimeReviewResponse\(data\)/u);
  const initializeSource = sourceBetween(adminHtml, 'async function initialize(', "$('#loginButton')");
  assert.doesNotMatch(initializeSource, /loadReview|loadStaffTime/u);
  assert.match(initializeSource, /setLoggedOut\(\)/u);
  assert.doesNotMatch(adminHtml, /localStorage|sessionStorage/u);
  assert.equal((adminHtml.match(/id="loginAdminName"/gu) || []).length, 1);
});

test('review validation requires every canonical Staff time field and rejects drift', () => {
  const { validStaffTimeReviewResponse } = validatorRuntime();
  const valid = reviewResponse();
  assert.equal(validStaffTimeReviewResponse(valid), true);

  const lowercaseStatus = structuredClone(valid);
  lowercaseStatus.records[0].status = 'active';
  assert.equal(validStaffTimeReviewResponse(lowercaseStatus), false);

  const wrongAction = structuredClone(valid);
  wrongAction.records[0].punchAction = 'in';
  assert.equal(validStaffTimeReviewResponse(wrongAction), false);

  const tabletWithoutOptionalFields = structuredClone(valid);
  tabletWithoutOptionalFields.records[0].source = 'Tablet';
  delete tabletWithoutOptionalFields.records[0].adminName;
  tabletWithoutOptionalFields.todayPunches[0].source = 'Tablet';
  assert.equal(validStaffTimeReviewResponse(tabletWithoutOptionalFields), true);

  const validLinkedPunch = structuredClone(valid);
  validLinkedPunch.records[0].linkedPunchId = PUNCH_TWO;
  assert.equal(validStaffTimeReviewResponse(validLinkedPunch), true);

  const blankOptionalField = structuredClone(valid);
  blankOptionalField.records[0].linkedPunchId = '';
  assert.equal(validStaffTimeReviewResponse(blankOptionalField), false);

  const missingAdminAttribution = structuredClone(valid);
  delete missingAdminAttribution.records[0].adminName;
  assert.equal(validStaffTimeReviewResponse(missingAdminAttribution), false);

  const tabletWithAdminAttribution = structuredClone(tabletWithoutOptionalFields);
  tabletWithAdminAttribution.records[0].adminName = 'Andrew Smith';
  assert.equal(validStaffTimeReviewResponse(tabletWithAdminAttribution), false);

  const recordExtraField = structuredClone(valid);
  recordExtraField.records[0].secret = 'must-not-render';
  assert.equal(validStaffTimeReviewResponse(recordExtraField), false);

  const duplicatePunch = structuredClone(valid);
  duplicatePunch.records.push({ ...duplicatePunch.records[0] });
  assert.equal(validStaffTimeReviewResponse(duplicatePunch), false);

  const extraField = structuredClone(valid);
  extraField.secret = 'must-not-render';
  assert.equal(validStaffTimeReviewResponse(extraField), false);
});

test('rendering covers all review collections with safe Admin-added, VOID, totals, and audit labels', () => {
  const renderSource = sourceBetween(adminHtml, 'function renderStaffTime(', 'function newStaffUuid(');
  for (const field of [
    'data.staff',
    'data.records',
    'data.clockedInNow',
    'data.todayPunches',
    'data.needsAttention',
    'data.periods.current',
    'data.periods.previous',
    'data.audit'
  ]) assert.match(renderSource, new RegExp(field.replace('.', '\\.')));
  assert.match(renderSource, /Admin-added/u);
  assert.match(renderSource, /VOID/u);
  assert.match(adminHtml, /Math\.floor\(total\.totalSeconds \/ 3_600\)/u);
  assert.doesNotMatch(sourceBetween(adminHtml, 'function staffPeriodElement(', 'function populateStaffCorrectionNames('), /Math\.round/u);
  assert.doesNotMatch(adminHtml, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML/u);
});

test('correction IDs are permanent for an exact retry and regenerate only after input changes', () => {
  const functions = sourceBetween(adminHtml, 'function newStaffUuid()', 'function recordElement(');
  const uuids = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ];
  const context = vm.createContext({
    Date,
    Intl,
    Object,
    JSON,
    globalThis: null
  });
  context.globalThis = context;
  context.crypto = { randomUUID: () => uuids.shift() };
  new vm.Script(`
    const TIME_ZONE = 'America/New_York';
    const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    function validReviewDate(value) {
      if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split('-').map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    }
    ${functions}
    globalThis.hooks = { staffTimestampForInputs, staffCorrectionIdentityFor, staffVoidRequestIdFor };
  `, { filename: 'staff-time-admin-identities.js' }).runInContext(context);

  assert.equal(context.hooks.staffTimestampForInputs('2026-08-18', '17:27'), '2026-08-18T17:27:00-04:00');
  assert.equal(context.hooks.staffTimestampForInputs('2026-01-18', '17:27'), '2026-01-18T17:27:00-05:00');

  const form = { dataset: {} };
  const correction = {
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: 'clockIn',
    timestamp: '2026-08-18T17:27:00-04:00',
    date: '2026-08-18',
    reason: 'Missed punch'
  };
  const first = context.hooks.staffCorrectionIdentityFor(form, correction);
  const retry = context.hooks.staffCorrectionIdentityFor(form, correction);
  assert.deepEqual({ ...retry }, { ...first });
  assert.match(first.requestId, /^gib-m1-staff-request-/u);
  assert.match(first.punchId, /^gib-m1-staff-/u);
  const changed = context.hooks.staffCorrectionIdentityFor(form, { ...correction, reason: 'Corrected reason' });
  assert.notEqual(changed.requestId, first.requestId);
  assert.notEqual(changed.punchId, first.punchId);

  const voidForm = { dataset: {} };
  const firstVoid = context.hooks.staffVoidRequestIdFor(voidForm, PUNCH_ONE, 'Wrong punch');
  const retryVoid = context.hooks.staffVoidRequestIdFor(voidForm, PUNCH_ONE, 'Wrong punch');
  assert.equal(retryVoid, firstVoid);
  const changedVoid = context.hooks.staffVoidRequestIdFor(voidForm, PUNCH_ONE, 'Corrected reason');
  assert.notEqual(changedVoid, firstVoid);
});

test('correction and VOID mutations require reasons, confirmation, and exact acknowledgments', () => {
  const correctionMarkup = sourceBetween(adminHtml, '<form id="staffCorrectionForm"', '</form>');
  assert.match(correctionMarkup, /name="staffId" required/u);
  assert.match(correctionMarkup, /name="punchAction" required/u);
  assert.match(correctionMarkup, /name="date" type="date" required/u);
  assert.match(correctionMarkup, /name="time" type="time"[^>]*required/u);
  assert.match(correctionMarkup, /name="reason" maxlength="240" required/u);

  const correctionSource = sourceBetween(adminHtml, 'async function submitStaffCorrection(', 'async function submitStaffVoid(');
  assert.ok(correctionSource.indexOf('staffCorrectionIdentityFor(form, correction)') < correctionSource.indexOf('requestJson(API.staffTime, request)'));
  assert.match(correctionSource, /operation: 'correct'/u);
  assert.match(correctionSource, /window\.confirm/u);
  assert.match(correctionSource, /Retry keeps the same permanent correction IDs/u);

  const voidSource = sourceBetween(adminHtml, 'async function submitStaffVoid(', 'function uniqueRequestId(');
  assert.ok(voidSource.indexOf('staffVoidRequestIdFor(form, punchId, reason)') < voidSource.indexOf('requestJson(API.staffTime, request)'));
  assert.match(voidSource, /operation: 'void'/u);
  assert.match(voidSource, /record\.staffName/u);
  assert.match(voidSource, /staffActionLabel\(record\.punchAction\)/u);
  assert.match(voidSource, /staffTimestampLabel\(record\.timestamp\)/u);
  assert.match(voidSource, /`Reason: \$\{reason\}`/u);
  assert.match(voidSource, /window\.confirm\(confirmation\)/u);
  assert.match(voidSource, /original punch will remain/u);
  assert.match(voidSource, /Retry keeps the same permanent request ID/u);
  assert.match(adminHtml, /status\.setAttribute\('role', 'status'\)/u);
  assert.match(adminHtml, /status\.setAttribute\('aria-live', 'polite'\)/u);

  const { validStaffMutationResponse } = validatorRuntime();
  const expected = {
    operation: 'correct',
    requestId: REQUEST_ONE,
    punchId: PUNCH_ONE,
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: 'clockIn',
    timestamp: '2026-08-18T17:27:00-04:00',
    date: '2026-08-18',
    reason: 'Missed punch'
  };
  const response = {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    operation: 'correct',
    requestId: REQUEST_ONE,
    result: 'added',
    linkedPunchId: PUNCH_ONE,
    auditActionNumber: 1,
    confirmation: {
      adminName: 'Andrew Smith',
      punchId: PUNCH_ONE,
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      timestamp: '2026-08-18T17:27:00-04:00',
      date: '2026-08-18',
      punchAction: 'clockIn',
      reason: 'Missed punch',
      site: 'Rev',
      device: 'Admin Staff Time',
      build: 'm1b-staff-clock'
    }
  };
  assert.equal(validStaffMutationResponse(response, expected), true);
  assert.equal(validStaffMutationResponse({ ...response, linkedPunchId: PUNCH_TWO }, expected), false);

  const voidExpected = {
    operation: 'void',
    requestId: REQUEST_ONE,
    punchId: PUNCH_ONE,
    reason: 'Wrong punch'
  };
  const voidResponse = {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    operation: 'void',
    requestId: REQUEST_ONE,
    result: 'voided',
    linkedPunchId: PUNCH_ONE,
    auditActionNumber: 2,
    confirmation: {
      adminName: 'Andrew Smith',
      punchId: PUNCH_ONE,
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      timestamp: '2026-08-18T17:27:00-04:00',
      date: '2026-08-18',
      punchAction: 'clockIn',
      reason: 'Wrong punch',
      status: 'VOID'
    }
  };
  assert.equal(validStaffMutationResponse(voidResponse, voidExpected), true);
  assert.equal(validStaffMutationResponse({ ...voidResponse, result: 'deleted' }, voidExpected), false);
});

test('#staff-time opens and focuses the existing panel without another login or secret', () => {
  const focusSource = sourceBetween(adminHtml, 'function focusStaffTimeHash(', 'async function loadStaffTime(');
  assert.match(focusSource, /location\.hash !== '#staff-time'/u);
  assert.match(focusSource, /panel\.open = true/u);
  assert.match(focusSource, /panel\.focus/u);
  assert.match(adminHtml, /window\.addEventListener\('hashchange', focusStaffTimeHash\)/u);
  const staffMarkup = sourceBetween(adminHtml, '<details id="staff-time"', '</details>\n    </section>');
  assert.doesNotMatch(staffMarkup, /passphrase|password|PIN|token|secret/iu);
});
