import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminHtml = readFileSync(path.join(root, 'm1', 'admin', 'index.html'), 'utf8');
const TARGET_ROW_ID = 'gib-m1-11111111-1111-4111-8111-111111111111';
const OTHER_ROW_ID = 'gib-m1-22222222-2222-4222-8222-222222222222';
const ROW_ID_PATTERN = /^gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sourceBetween(start, end) {
  const startIndex = adminHtml.indexOf(start);
  const endIndex = adminHtml.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return adminHtml.slice(startIndex, endIndex);
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

function reviewRecord(overrides = {}) {
  return {
    displayId: 'sheet-row-2',
    recordId: TARGET_ROW_ID,
    timestamp: '2026-08-26 06:21:15',
    date: '2026-08-26',
    classLabel: '6:00 AM–7:00 AM Muay Thai Fundamentals',
    duration: 1,
    instructor: 'Andrew Smith',
    site: 'Richmond',
    notes: 'Install check only',
    source: 'Kiosk',
    reviewRequired: false,
    reviewMessage: '',
    ...overrides
  };
}

function voidExpected(overrides = {}) {
  const record = reviewRecord();
  return {
    requestId: `gib-m1-admin-void-${record.recordId}`,
    rowId: record.recordId,
    adminName: 'Andrew Smith',
    reason: 'Installation check — void after verification',
    timestamp: record.timestamp,
    date: record.date,
    classLabel: record.classLabel,
    duration: record.duration,
    instructor: record.instructor,
    site: record.site,
    notes: record.notes,
    ...overrides
  };
}

function voidResponse(result = 'voided', overrides = {}) {
  const expected = voidExpected();
  return {
    ok: true,
    test: false,
    adminName: expected.adminName,
    operation: 'void',
    requestId: expected.requestId,
    result,
    linkedRecordId: expected.rowId,
    auditActionNumber: 1,
    confirmation: {
      adminName: expected.adminName,
      rowId: expected.rowId,
      timestamp: expected.timestamp,
      date: expected.date,
      classLabel: expected.classLabel,
      duration: expected.duration,
      instructor: expected.instructor,
      site: expected.site,
      device: 'Richmond Front Desk Tablet',
      build: 'm1-unified-august-rollout-2026',
      notes: expected.notes,
      status: 'VOID',
      reason: expected.reason
    },
    message: result === 'voided'
      ? 'Instructor sign-in voided.'
      : 'This instructor sign-in was already voided. No second audit action was created.',
    ...overrides
  };
}

test('control is authenticated Richmond-production-only, row-derived, and uses the dedicated Admin endpoint', () => {
  assert.match(adminHtml, /void:\s*'\/\.netlify\/functions\/m1-admin-void'/u);
  assert.match(
    adminHtml,
    /const IS_RICHMOND_PRODUCTION_ORIGIN = IS_RICHMOND_PRODUCTION[\s\S]*location\.origin === 'https:\/\/gib-richmond-live\.netlify\.app'[\s\S]*INSTALLATION\.allowedOrigin === location\.origin/u
  );
  const eligibility = sourceBetween('function signinVoidEligible(', 'function buildSigninVoidForm(');
  assert.match(eligibility, /IS_RICHMOND_PRODUCTION_ORIGIN/u);
  assert.match(eligibility, /ADMIN_MUTATIONS_ENABLED/u);
  assert.match(eligibility, /\['Andrew Smith', 'Stuart Turner'\]\.includes\(currentAdminName\)/u);
  assert.match(eligibility, /RICHMOND_PRODUCTION_ROW_ID_PATTERN\.test\(record\.recordId\)/u);

  const recordRenderer = sourceBetween('function recordElement(', 'function warningElement(');
  assert.match(recordRenderer, /options\.allowSigninVoid === true && signinVoidEligible\(record\)/u);
  const reviewRenderer = sourceBetween('function classRow(', 'function renderReview(');
  assert.match(reviewRenderer, /recordElement\(record, \{ allowSigninVoid: true \}\)/u);
  assert.match(adminHtml, /unmatched\.map\(record => recordElement\([\s\S]*allowSigninVoid: true/u);

  const requestTransport = sourceBetween('async function requestJson(', 'function setLoggedOut(');
  assert.match(requestTransport, /headers\[ADMIN_REQUEST_HEADER\] = adminRequestToken/u);
  assert.match(requestTransport, /credentials:\s*'same-origin'/u);
  assert.match(requestTransport, /cache:\s*'no-store'/u);

  assert.doesNotMatch(adminHtml, new RegExp(TARGET_ROW_ID, 'u'));
  const flow = sourceBetween('function readSigninVoidRequest(', 'function uniqueRequestId(');
  assert.doesNotMatch(flow, /API\.staffTime|STAFF_CLOCK_ENABLED|staffTimeVoid/u);
});

test('permanent void request identity is bound deterministically to the exact RowID', () => {
  const identitySource = sourceBetween('function signinVoidRequestId(', 'function validAdminSigninVoidResponse(');
  const requestSource = sourceBetween('function readSigninVoidRequest(', 'function expectedSigninVoid(');
  const record = reviewRecord();
  const form = {
    dataset: { rowId: record.recordId },
    elements: { reason: { value: '  Installation check — void after verification  ' } }
  };
  const context = vm.createContext({
    RICHMOND_PRODUCTION_ROW_ID_PATTERN: ROW_ID_PATTERN,
    currentAdminName: 'Andrew Smith',
    currentDate: record.date,
    clean: value => String(value == null ? '' : value).trim().replace(/\s+/gu, ' '),
    signinVoidEligible: candidate => candidate === record
  });
  new vm.Script(`${identitySource}\n${requestSource}\nthis.identity = signinVoidRequestId; this.read = readSigninVoidRequest;`)
    .runInContext(context);

  const first = json(context.read(form, record));
  const retry = json(context.read(form, record));
  assert.deepEqual(first, {
    requestId: `gib-m1-admin-void-${TARGET_ROW_ID}`,
    rowId: TARGET_ROW_ID,
    adminName: 'Andrew Smith',
    reason: 'Installation check — void after verification'
  });
  assert.deepEqual(retry, first);

  form.elements.reason.value = 'Changed reason must conflict server-side';
  const changed = json(context.read(form, record));
  assert.equal(changed.requestId, first.requestId, 'RowID remains the durable operation key.');
  assert.equal(context.identity(OTHER_ROW_ID), `gib-m1-admin-void-${OTHER_ROW_ID}`);
  assert.equal(context.identity('sheet-row-2'), '');
});

test('response validation is exact and fail-closed for identity, record snapshot, result, and message', () => {
  const exactKeysSource = sourceBetween('function exactObjectKeys(', 'function validReviewDisplayId(');
  const validatorSource = sourceBetween('function validAdminSigninVoidResponse(', 'function validInstructorSearchResponse(');
  const context = vm.createContext({
    Object,
    Number,
    INSTALLATION: { deviceLabel: 'Richmond Front Desk Tablet' }
  });
  new vm.Script(`${exactKeysSource}\n${validatorSource}\nthis.validate = validAdminSigninVoidResponse;`)
    .runInContext(context);
  const expected = voidExpected();

  assert.equal(context.validate(voidResponse('voided'), expected), true);
  assert.equal(context.validate(voidResponse('already voided'), expected), true);
  assert.equal(context.validate(voidResponse('voided', { test: true }), expected), false);
  assert.equal(context.validate(voidResponse('voided', { operation: 'add' }), expected), false);
  assert.equal(context.validate(voidResponse('voided', { linkedRecordId: OTHER_ROW_ID }), expected), false);
  assert.equal(context.validate(voidResponse('voided', { auditActionNumber: 0 }), expected), false);
  assert.equal(context.validate(voidResponse('voided', { message: 'Done.' }), expected), false);
  assert.equal(context.validate(voidResponse('voided', { extra: true }), expected), false);
  assert.equal(context.validate(voidResponse('voided', {
    confirmation: { ...voidResponse().confirmation, notes: 'Different row snapshot' }
  }), expected), false);
  assert.equal(context.validate(voidResponse('voided', {
    confirmation: { ...voidResponse().confirmation, status: 'OK' }
  }), expected), false);
});

test('Daily Review accepts exactly one persisted void audit and rejects replay-result lookalikes', () => {
  const validatorsSource = sourceBetween('function exactObjectKeys(', 'function validAdminAdditionResponse(');
  const context = vm.createContext({
    REVIEW_NOTES_MAX_LENGTH: 800,
    RICHMOND_PRODUCTION_ROW_ID_PATTERN: ROW_ID_PATTERN,
    IS_RICHMOND_PRODUCTION: true
  });
  new vm.Script(`${validatorsSource}\nthis.validateReview = validDailyReviewResponse;`).runInContext(context);
  const expected = voidExpected();
  const audit = {
    auditId: 'audit-row-2',
    actionNumber: 1,
    adminName: expected.adminName,
    actionTime: '2026-08-26 09:00:00',
    instructor: expected.instructor,
    classDate: expected.date,
    classLabel: expected.classLabel,
    site: expected.site,
    duration: expected.duration,
    reason: expected.reason,
    result: 'voided',
    linkedRecordId: expected.rowId
  };
  const review = {
    ok: true,
    test: false,
    adminName: expected.adminName,
    date: expected.date,
    records: [],
    warnings: [],
    auditHistory: [audit]
  };
  assert.equal(context.validateReview(review, expected.date), true);
  assert.equal(context.validateReview({
    ...review,
    auditHistory: [{ ...audit, result: 'already voided' }]
  }, expected.date), false);
  assert.equal(context.validateReview({
    ...review,
    auditHistory: [{ ...audit, linkedRecordId: 'sheet-row-2' }]
  }, expected.date), false);
  assert.equal(context.validateReview({
    ...review,
    auditHistory: [audit, { ...audit, auditId: 'audit-row-3' }]
  }, expected.date), false);

  const revolutionContext = vm.createContext({
    REVIEW_NOTES_MAX_LENGTH: 800,
    RICHMOND_PRODUCTION_ROW_ID_PATTERN: ROW_ID_PATTERN,
    IS_RICHMOND_PRODUCTION: false
  });
  new vm.Script(`${validatorsSource}\nthis.validateReview = validDailyReviewResponse;`)
    .runInContext(revolutionContext);
  assert.equal(revolutionContext.validateReview(review, expected.date), false);
});

test('confirmation names the exact row and required reason before any request', () => {
  const confirmationSource = sourceBetween('function signinVoidConfirmationText(', 'function setSigninVoidWorking(');
  const context = vm.createContext({});
  new vm.Script(`${confirmationSource}\nthis.confirmation = signinVoidConfirmationText;`).runInContext(context);
  const record = reviewRecord();
  const reason = 'Installation check — void after verification';
  assert.equal(context.confirmation(record, reason), [
    'Void exactly this Richmond instructor record?',
    '',
    'Instructor: Andrew Smith',
    'Date: 2026-08-26',
    'Class: 6:00 AM–7:00 AM Muay Thai Fundamentals',
    'Site: Richmond',
    'Notes: Install check only',
    `RowID: ${TARGET_ROW_ID}`,
    `Required reason: ${reason}`,
    '',
    'The original row will remain and one Admin Audit action will be recorded.'
  ].join('\n'));

  const submitSource = sourceBetween('async function submitSigninVoid(', 'function uniqueRequestId(');
  assert.ok(submitSource.indexOf('window.confirm(') < submitSource.indexOf('requestSigninVoidWithReconciliation(request)'));
});

test('success is withheld until refreshed Daily Review proves row absence and exactly one linked void audit', async () => {
  const submitSource = sourceBetween('async function submitSigninVoid(', 'function uniqueRequestId(');
  const record = reviewRecord();
  const expected = voidExpected();
  const response = voidResponse();
  const request = Object.freeze({
    requestId: expected.requestId,
    rowId: expected.rowId,
    adminName: expected.adminName,
    reason: expected.reason
  });
  let finishRefresh;
  const refresh = new Promise(resolve => { finishRefresh = resolve; });
  const calls = [];
  const status = {};
  const form = {
    dataset: { rowId: record.recordId },
    isConnected: true,
    querySelector(selector) { return selector === '.signin-void-status' ? status : {}; }
  };
  const context = vm.createContext({
    IS_RICHMOND_PRODUCTION_ORIGIN: true,
    ADMIN_MUTATIONS_ENABLED: true,
    currentRecords: [record],
    inFlightSigninVoids: new Set(),
    persistentReviewOutcome: null,
    readSigninVoidRequest: () => request,
    signinVoidConfirmationText: () => 'exact confirmation',
    clearClassOutcome: () => calls.push('clear'),
    setSigninVoidWorking: (_form, working) => calls.push(working ? 'working' : 'idle'),
    expectedSigninVoid: () => expected,
    requestSigninVoidWithReconciliation: async body => {
      calls.push(['request', json(body)]);
      return response;
    },
    validAdminSigninVoidResponse: () => true,
    refreshConfirmedSigninVoid: async () => {
      calls.push('refresh-start');
      return refresh;
    },
    renderReview: () => calls.push('render'),
    toast: message => calls.push(['success', message]),
    showMessage: (_element, message) => calls.push(['message', message]),
    setLoggedOut: () => calls.push('logout'),
    applyPendingScheduleToReview: () => calls.push('schedule'),
    window: { confirm: () => true }
  });
  new vm.Script(`${submitSource}\nthis.submit = submitSigninVoid;`).runInContext(context);

  const submission = context.submit(form);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.find(item => Array.isArray(item) && item[0] === 'request'), ['request', json(request)]);
  assert.equal(calls.some(item => Array.isArray(item) && item[0] === 'success'), false);
  finishRefresh(true);
  await submission;
  assert.ok(calls.indexOf('refresh-start') < calls.indexOf('render'));
  assert.ok(calls.indexOf('render') < calls.findIndex(item => Array.isArray(item) && item[0] === 'success'));
  assert.deepEqual(json(context.persistentReviewOutcome), {
    date: expected.date,
    classLabel: expected.classLabel,
    instructor: expected.instructor,
    result: 'voided',
    auditActionNumber: 1
  });
});

test('review verification requires row removal and one exact voided audit', () => {
  const verifySource = sourceBetween('function reviewConfirmsSigninVoid(', 'async function refreshConfirmedSigninVoid(');
  const context = vm.createContext({});
  new vm.Script(`${verifySource}\nthis.verify = reviewConfirmsSigninVoid;`).runInContext(context);
  const expected = voidExpected();
  const result = voidResponse();
  const audit = {
    auditId: 'audit-row-2',
    actionNumber: 1,
    adminName: expected.adminName,
    actionTime: '2026-08-26 09:00:00',
    instructor: expected.instructor,
    classDate: expected.date,
    classLabel: expected.classLabel,
    site: expected.site,
    duration: expected.duration,
    reason: expected.reason,
    result: 'voided',
    linkedRecordId: expected.rowId
  };
  assert.equal(context.verify({ records: [], auditHistory: [audit] }, expected, result), true);
  assert.equal(context.verify({ records: [reviewRecord()], auditHistory: [audit] }, expected, result), false);
  assert.equal(context.verify({ records: [], auditHistory: [] }, expected, result), false);
  assert.equal(context.verify({ records: [], auditHistory: [audit, { ...audit }] }, expected, result), false);
  assert.equal(context.verify({ records: [], auditHistory: [{ ...audit, result: 'already voided' }] }, expected, result), false);
  assert.equal(context.verify({ records: [], auditHistory: [{ ...audit, linkedRecordId: OTHER_ROW_ID }] }, expected, result), false);
});
