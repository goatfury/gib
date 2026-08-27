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
const REQUEST_TWO = 'gib-m1-staff-request-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VIEW_TOKEN = 'a'.repeat(64);

function validatorRuntime() {
  const functions = sourceBetween(
    adminHtml,
    'function validStaffId(',
    'function validDiagnosticIssueResponse('
  );
  const context = vm.createContext({ Date, Object, Set, JSON, TextEncoder });
  new vm.Script(`
    const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_TIMESTAMP_PATTERN = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}-(?:04|05):00$/;
    const STAFF_TIME_VIEW_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
    const STAFF_TIME_PAGE_LIMIT = 500;
    const STAFF_TIME_PAGE_MAX_BYTES = 200_000;
    const STAFF_TIME_RECORD_LIMIT = 500;
    const STAFF_TIME_ATTENTION_LIMIT = 600;
    const STAFF_TIME_AUDIT_LIMIT = 500;
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
    function shiftDate(dateString, days) {
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
    }
    ${functions}
    globalThis.hooks = {
      validStaffTimeReviewStartResponse,
      validStaffTimeReviewPageResponse,
      validStaffTimeReviewResponse,
      validStaffMutationResponse
    };
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
    }],
    view: {
      token: VIEW_TOKEN,
      today: '2026-08-18',
      recordCount: 1,
      recordTotal: 1,
      todayPunchCount: 1,
      todayPunchTotal: 1,
      adjustmentCount: 1,
      adjustmentTotal: 1,
      attentionCount: 0,
      attentionOccurrenceCount: 0,
      auditCount: 1,
      auditTotal: 1,
      recordsTruncated: false,
      auditTruncated: false
    }
  };
}

function adjustedReviewResponse() {
  const clockIn = {
    ...staffRecord(801),
    timestamp: '2026-08-18T09:15:00-04:00',
    date: '2026-08-18',
    punchAction: 'clockIn',
    originalTimestamp: '2026-08-18T09:00:00-04:00',
    originalDate: '2026-08-18',
    adjustmentRequestId: REQUEST_ONE
  };
  const clockOut = {
    ...staffRecord(802),
    timestamp: '2026-08-18T17:30:00-04:00',
    date: '2026-08-18',
    punchAction: 'clockOut',
    originalTimestamp: '2026-08-18T17:00:00-04:00',
    originalDate: '2026-08-18',
    adjustmentRequestId: REQUEST_ONE
  };
  const base = reviewResponse();
  return {
    ...base,
    records: [clockIn, clockOut],
    clockedInNow: [],
    todayPunches: [clockIn, clockOut].map(record => ({
      punchId: record.punchId,
      staffId: record.staffId,
      staffName: record.staffName,
      punchAction: record.punchAction,
      timestamp: record.timestamp,
      source: record.source,
      status: record.status
    })),
    periods: {
      ...base.periods,
      current: {
        ...base.periods.current,
        totals: [{
          staffId: 'mandy-test',
          staffName: 'Mandy Test',
          completedShifts: 1,
          totalSeconds: 29_700,
          needsAttention: false
        }]
      }
    },
    audit: [{
      requestId: REQUEST_ONE,
      actionTime: '2026-08-18T17:45:00-04:00',
      adminName: 'Andrew Smith',
      operation: 'adjust',
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      clockInPunchId: clockIn.punchId,
      clockOutPunchId: clockOut.punchId,
      originalClockInAt: '2026-08-18T09:00:00-04:00',
      originalClockOutAt: '2026-08-18T17:00:00-04:00',
      correctedClockInAt: clockIn.timestamp,
      correctedClockOutAt: clockOut.timestamp,
      changed: 'both',
      reason: 'Manager verified the written time card',
      result: 'adjusted'
    }],
    view: {
      ...base.view,
      recordCount: 2,
      recordTotal: 2,
      todayPunchCount: 2,
      todayPunchTotal: 2,
      adjustmentCount: 2,
      adjustmentTotal: 2
    }
  };
}

function reviewStartResponse(overrides = {}) {
  const review = reviewResponse();
  return {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    staff: review.staff,
    clockedInNow: review.clockedInNow,
    periods: review.periods,
    view: review.view,
    ...overrides
  };
}

function staffRecord(index) {
  const suffix = index.toString(16).padStart(12, '0');
  return {
    punchId: `gib-m1-staff-${(0x30000000 + index).toString(16)}-1111-4111-8111-${suffix}`,
    timestamp: '2026-08-18T09:00:00-04:00',
    date: '2026-08-18',
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: 'clockIn',
    site: 'Rev',
    device: 'Staff Clock tablet',
    build: 'm1b-staff-clock',
    note: '',
    status: 'ACTIVE',
    source: 'Tablet'
  };
}

function staffAudit(index, record, operation = 'correct') {
  const suffix = (index + 1).toString(16).padStart(12, '0');
  return {
    requestId: `gib-m1-staff-request-${(0x40000000 + index).toString(16)}-aaaa-4aaa-8aaa-${suffix}`,
    actionTime: '2026-08-18T17:28:00-04:00',
    adminName: 'Andrew Smith',
    operation,
    staffId: record.staffId,
    staffName: record.staffName,
    punchTimestamp: record.timestamp,
    punchAction: record.punchAction,
    reason: operation === 'void' ? 'Wrong punch' : 'Missed punch',
    result: operation === 'void' ? 'voided' : 'added',
    linkedPunchId: record.punchId
  };
}

function renderStaffTimeRuntime(data, { showOlder = false } = {}) {
  const functions = sourceBetween(
    adminHtml,
    'function makeElement(',
    'function newStaffUuid('
  );
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
      this.value = '';
      this.hidden = false;
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    append(...children) {
      this.children.push(...children);
    }

    replaceChildren(...children) {
      this.children = [...children];
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  }
  const nodes = {};
  const context = vm.createContext({
    Date,
    Intl,
    Object,
    nodes,
    data: structuredClone(data),
    createElement: tagName => new FakeElement(tagName)
  });
  new vm.Script(`
    const TIME_ZONE = 'America/New_York';
    let currentStaffTime = null;
    const document = { createElement };
    function $(selector) {
      if (!nodes[selector]) nodes[selector] = createElement('div');
      return nodes[selector];
    }
    function inputField(label, input) {
      const field = createElement('label');
      field.textContent = label;
      field.appendChild(input);
      return field;
    }
    function shiftDate(dateString, days) {
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
    }
    function validStaffTimestamp(value) {
      return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-(?:04|05):00$/.test(value)
        && Number.isFinite(Date.parse(value));
    }
    let staffOlderHistoryExpanded = ${showOlder ? 'true' : 'false'};
    ${functions}
    renderStaffTime(data);
  `, { filename: 'staff-time-admin-render.js' }).runInContext(context);
  return nodes;
}

function elementText(element) {
  return [
    element.textContent,
    ...element.children.map(elementText)
  ].filter(Boolean).join(' ');
}

function countElements(element, predicate) {
  return Number(predicate(element)) + element.children.reduce(
    (count, child) => count + countElements(child, predicate),
    0
  );
}

async function runPagination(initial, streams, { staleOnce = false, pageSize = 500 } = {}) {
  const functions = sourceBetween(
    adminHtml,
    'function validStaffId(',
    'function validDiagnosticIssueResponse('
  );
  const context = vm.createContext({
    Date,
    Object,
    Set,
    Map,
    JSON,
    TextEncoder,
    initial,
    streams,
    staleOnce,
    pageSize,
    calls: []
  });
  new vm.Script(`
    const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_TIMESTAMP_PATTERN = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}-(?:04|05):00$/;
    const STAFF_TIME_VIEW_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
    const STAFF_TIME_PAGE_LIMIT = 500;
    const STAFF_TIME_PAGE_MAX_BYTES = 200_000;
    const STAFF_TIME_RECORD_LIMIT = 500;
    const STAFF_TIME_ATTENTION_LIMIT = 600;
    const STAFF_TIME_AUDIT_LIMIT = 500;
    const SITE = 'Rev';
    const API = { staffTime: '/staff-time' };
    let testMode = true;
    let currentAdminName = 'Andrew Smith';
    let staffTimeLoadGeneration = 7;
    let staleRemaining = staleOnce ? 1 : 0;
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
    function shiftDate(dateString, days) {
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
    }
    async function requestJson(_url, body) {
      calls.push(JSON.parse(JSON.stringify(body)));
      if (body.operation === 'review') return JSON.parse(JSON.stringify(initial));
      if (staleRemaining && body.stream === 'records') {
        staleRemaining -= 1;
        const error = new Error('stale');
        error.status = 409;
        error.data = { ok: false, result: 'stale', code: 'STAFF_TIME_VIEW_STALE' };
        throw error;
      }
      const source = streams[body.stream];
      const items = source.slice(body.offset, body.offset + pageSize);
      const endOffset = body.offset + items.length;
      return {
        ok: true,
        test: true,
        adminName: 'Andrew Smith',
        viewToken: initial.view.token,
        stream: body.stream,
        offset: body.offset,
        items: JSON.parse(JSON.stringify(items)),
        nextOffset: endOffset === source.length ? null : endOffset
      };
    }
    ${functions}
    globalThis.hooks = { loadStaffTimeReviewView };
  `, { filename: 'staff-time-admin-pagination.js' }).runInContext(context);
  const data = await context.hooks.loadStaffTimeReviewView(7);
  return { data, calls: context.calls };
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
  assert.match(app, /Staff Time records[\s\S]*Show older history[\s\S]*Staff time audit/u);
  assert.equal(idCount('staffTimeOlderHistory'), 1);
  assert.match(app, /aria-controls="staffTimeRecords" aria-expanded="false" hidden/u);
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
  const pagingSource = sourceBetween(
    adminHtml,
    'async function fetchStaffTimeReviewStream(',
    'function validStaffMutationResponse('
  );
  assert.match(pagingSource, /requestJson\(API\.staffTime, \{\s*operation: 'reviewPage'/u);
  assert.match(pagingSource, /validStaffTimeReviewPageResponse\(page/u);
  assert.match(pagingSource, /requestJson\(API\.staffTime, \{ operation: 'review' \}\)/u);
  assert.match(pagingSource, /validStaffTimeReviewStartResponse\(initial\)/u);
  const loadSource = sourceBetween(adminHtml, 'async function loadStaffTime(', 'async function submitStaffCorrection(');
  assert.match(loadSource, /loadStaffTimeReviewView\(generation\)/u);
  const initializeSource = sourceBetween(
    adminHtml,
    'async function initialize(',
    "$('#loginButton').addEventListener('click'"
  );
  assert.doesNotMatch(initializeSource, /loadReview|loadStaffTime/u);
  assert.match(initializeSource, /setLoggedOut\(\)/u);
  assert.doesNotMatch(adminHtml, /localStorage|sessionStorage/u);
  assert.equal((adminHtml.match(/id="loginAdminName"/gu) || []).length, 1);
});

test('review validation requires every canonical Staff time field and rejects drift', () => {
  const {
    validStaffTimeReviewStartResponse,
    validStaffTimeReviewPageResponse,
    validStaffTimeReviewResponse
  } = validatorRuntime();
  const start = reviewStartResponse();
  assert.equal(validStaffTimeReviewStartResponse(start), true);
  assert.equal(validStaffTimeReviewStartResponse({ ...start, records: [] }), false);
  assert.equal(validStaffTimeReviewStartResponse({
    ...start,
    view: { ...start.view, token: 'not-a-view-token' }
  }), false);
  assert.equal(validStaffTimeReviewStartResponse({
    ...start,
    view: { ...start.view, recordCount: 501, recordTotal: 501 }
  }), false);
  assert.equal(validStaffTimeReviewStartResponse({
    ...start,
    view: { ...start.view, attentionCount: 601, attentionOccurrenceCount: 601 }
  }), false);
  assert.equal(validStaffTimeReviewStartResponse({
    ...start,
    view: { ...start.view, recordTotal: 2, recordsTruncated: false }
  }), false);

  const page = {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    viewToken: VIEW_TOKEN,
    stream: 'records',
    offset: 0,
    items: [reviewResponse().records[0]],
    nextOffset: null
  };
  const expectedPage = { viewToken: VIEW_TOKEN, stream: 'records', offset: 0 };
  assert.equal(validStaffTimeReviewPageResponse(page, expectedPage), true);
  assert.equal(validStaffTimeReviewPageResponse({ ...page, offset: 1 }, expectedPage), false);
  assert.equal(validStaffTimeReviewPageResponse({ ...page, extra: true }, expectedPage), false);
  const oversizedPageRecord = { ...reviewResponse().records[0], note: 'x'.repeat(400) };
  const oversizedPage = {
    ...page,
    items: Array.from({ length: 500 }, () => oversizedPageRecord)
  };
  assert.ok(new TextEncoder().encode(JSON.stringify(oversizedPage)).byteLength > 200_000);
  assert.equal(validStaffTimeReviewPageResponse(oversizedPage, expectedPage), false);

  const valid = reviewResponse();
  assert.equal(validStaffTimeReviewResponse(valid), true);

  const largeSafeTotals = structuredClone(valid);
  largeSafeTotals.periods.current.totals[0].completedShifts = 2_001;
  largeSafeTotals.periods.current.totals[0].totalSeconds = 15 * 24 * 60 * 60;
  assert.equal(validStaffTimeReviewResponse(largeSafeTotals), true);
  largeSafeTotals.periods.current.totals[0].totalSeconds += 1;
  assert.equal(validStaffTimeReviewResponse(largeSafeTotals), false);

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
  tabletWithoutOptionalFields.view.adjustmentCount = 0;
  tabletWithoutOptionalFields.view.adjustmentTotal = 0;
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

  const missingClockedRecord = structuredClone(valid);
  missingClockedRecord.clockedInNow[0].punchId = PUNCH_TWO;
  assert.equal(validStaffTimeReviewResponse(missingClockedRecord), false);

  const missingAttentionRecord = structuredClone(valid);
  missingAttentionRecord.needsAttention = [{
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    code: 'missing_clock_out',
    message: 'Missing punch',
    linkedPunchIds: [PUNCH_TWO],
    occurrenceCount: 1
  }];
  missingAttentionRecord.view.attentionCount = 1;
  missingAttentionRecord.view.attentionOccurrenceCount = 1;
  assert.equal(validStaffTimeReviewResponse(missingAttentionRecord), false);

  const mismatchedAudit = structuredClone(valid);
  mismatchedAudit.audit[0].punchTimestamp = '2026-08-18T17:26:00-04:00';
  assert.equal(validStaffTimeReviewResponse(mismatchedAudit), false);

  const adjusted = adjustedReviewResponse();
  assert.equal(validStaffTimeReviewResponse(adjusted), true);
  const partialAdjustmentEvidence = structuredClone(adjusted);
  delete partialAdjustmentEvidence.records[0].originalDate;
  assert.equal(validStaffTimeReviewResponse(partialAdjustmentEvidence), false);
  const wrongAdjustmentLink = structuredClone(adjusted);
  wrongAdjustmentLink.audit[0].clockOutPunchId = PUNCH_TWO;
  assert.equal(validStaffTimeReviewResponse(wrongAdjustmentLink), false);
  const impossibleAdjustment = structuredClone(adjusted);
  impossibleAdjustment.audit[0].correctedClockOutAt = '2026-08-18T08:30:00-04:00';
  assert.equal(validStaffTimeReviewResponse(impossibleAdjustment), false);
  const driftedLatestAdjustment = structuredClone(adjusted);
  driftedLatestAdjustment.audit[0].correctedClockOutAt = '2026-08-18T17:31:00-04:00';
  assert.equal(validStaffTimeReviewResponse(driftedLatestAdjustment), false);
  const driftedLatestRequest = structuredClone(adjusted);
  driftedLatestRequest.records[1].adjustmentRequestId = REQUEST_TWO;
  assert.equal(validStaffTimeReviewResponse(driftedLatestRequest), false);
  const chainedAdjustment = structuredClone(adjusted);
  chainedAdjustment.records[0].timestamp = '2026-08-18T09:10:00-04:00';
  chainedAdjustment.records[0].adjustmentRequestId = REQUEST_TWO;
  chainedAdjustment.records[1].timestamp = '2026-08-18T17:45:00-04:00';
  chainedAdjustment.records[1].adjustmentRequestId = REQUEST_TWO;
  chainedAdjustment.todayPunches[0].timestamp = chainedAdjustment.records[0].timestamp;
  chainedAdjustment.todayPunches[1].timestamp = chainedAdjustment.records[1].timestamp;
  chainedAdjustment.periods.current.totals[0].totalSeconds = 30_900;
  chainedAdjustment.audit.unshift({
    ...chainedAdjustment.audit[0],
    requestId: REQUEST_TWO,
    actionTime: '2026-08-18T18:00:00-04:00',
    originalClockInAt: '2026-08-18T09:15:00-04:00',
    originalClockOutAt: '2026-08-18T17:30:00-04:00',
    correctedClockInAt: chainedAdjustment.records[0].timestamp,
    correctedClockOutAt: chainedAdjustment.records[1].timestamp
  });
  chainedAdjustment.view.auditCount = 2;
  chainedAdjustment.view.auditTotal = 2;
  assert.equal(validStaffTimeReviewResponse(chainedAdjustment), true);
  const brokenAdjustmentChain = structuredClone(chainedAdjustment);
  brokenAdjustmentChain.audit[1].correctedClockOutAt = '2026-08-18T17:29:00-04:00';
  assert.equal(validStaffTimeReviewResponse(brokenAdjustmentChain), false);
  const wrongAdjustmentCount = structuredClone(adjusted);
  wrongAdjustmentCount.view.adjustmentCount = 1;
  assert.equal(validStaffTimeReviewResponse(wrongAdjustmentCount), false);

  const extraField = structuredClone(valid);
  extraField.secret = 'must-not-render';
  assert.equal(validStaffTimeReviewResponse(extraField), false);
});

test('10k+ Staff time totals use bounded priority streams, variable pages, and bounded DOM', async () => {
  const records = Array.from({ length: 500 }, (_, index) => staffRecord(index));
  records[0] = {
    ...records[0],
    timestamp: '2026-08-17T09:00:00-04:00',
    date: '2026-08-17',
    device: 'Admin Staff Time',
    note: 'Priority correction evidence',
    source: 'Admin-added',
    adminName: 'Andrew Smith'
  };
  records[1] = {
    ...records[1],
    timestamp: '2026-08-16T09:00:00-04:00',
    date: '2026-08-16',
    note: 'Priority VOID evidence',
    status: 'VOID'
  };
  const attention = Array.from({ length: 600 }, (_, index) => ({
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    code: `issue_${index.toString().padStart(3, '0')}`,
    message: `Mandy Test issue group ${index + 1}.`,
    linkedPunchIds: [records[index % records.length].punchId],
    occurrenceCount: index === 0 ? 9_404 : 1
  }));
  const audit = Array.from({ length: 500 }, (_, index) => staffAudit(
    index,
    records[index % records.length],
    index === 1 ? 'void' : 'correct'
  ));
  const initial = reviewStartResponse({
    clockedInNow: [{
      punchId: records[2].punchId,
      staffId: records[2].staffId,
      staffName: records[2].staffName,
      clockInAt: records[2].timestamp
    }],
    periods: {
      ...reviewResponse().periods,
      current: {
        ...reviewResponse().periods.current,
        totals: [{
          staffId: 'mandy-test',
          staffName: 'Mandy Test',
          completedShifts: 10_001,
          totalSeconds: 10_001,
          needsAttention: true
        }]
      }
    },
    view: {
      token: VIEW_TOKEN,
      today: '2026-08-18',
      recordCount: records.length,
      recordTotal: 10_503,
      todayPunchCount: 498,
      todayPunchTotal: 10_501,
      adjustmentCount: 2,
      adjustmentTotal: 2,
      attentionCount: attention.length,
      attentionOccurrenceCount: 10_003,
      auditCount: audit.length,
      auditTotal: 10_001,
      recordsTruncated: true,
      auditTruncated: true
    }
  });

  const { data, calls } = await runPagination(
    initial,
    { records, attention, audit },
    { pageSize: 137, staleOnce: true }
  );
  assert.equal(data.view.recordTotal, 10_503);
  assert.equal(data.view.todayPunchTotal, 10_501);
  assert.equal(data.view.attentionOccurrenceCount, 10_003);
  assert.equal(data.view.auditTotal, 10_001);
  assert.equal(data.records.length, 500);
  assert.equal(data.todayPunches.length, 498);
  assert.equal(data.needsAttention.length, 600);
  assert.equal(data.audit.length, 500);
  assert.equal(data.records[0].source, 'Admin-added');
  assert.equal(data.records[1].status, 'VOID');
  assert.equal(data.audit[0].linkedPunchId, data.records[0].punchId);
  assert.equal(data.audit[1].operation, 'void');
  assert.deepEqual(JSON.parse(JSON.stringify(data.needsAttention)), attention);
  assert.deepEqual(JSON.parse(JSON.stringify(data.audit)), audit);
  assert.deepEqual(
    calls.filter(call => call.operation === 'reviewPage').map(call => [call.stream, call.offset]),
    [
      ['records', 0],
      ['records', 0],
      ['records', 137],
      ['records', 274],
      ['records', 411],
      ['attention', 0],
      ['attention', 137],
      ['attention', 274],
      ['attention', 411],
      ['attention', 548],
      ['audit', 0],
      ['audit', 137],
      ['audit', 274],
      ['audit', 411]
    ]
  );
  assert.equal(calls.filter(call => call.operation === 'review').length, 2);
  assert.ok(calls.filter(call => call.operation === 'reviewPage').every(call => (
    Object.keys(call).sort().join(',') === 'offset,operation,stream,viewToken'
  )));

  const nodes = renderStaffTimeRuntime(data);
  assert.equal(nodes['#staffTimeSummary'].textContent, '1 clocked in · 10,501 today');
  assert.equal(nodes['#staffTodayPunches'].children.length, 499);
  assert.equal(nodes['#staffNeedsAttention'].children.length, 600);
  assert.equal(nodes['#staffTimeRecords'].children.length, 501);
  assert.equal(nodes['#staffTimeAudit'].children.length, 501);
  assert.match(elementText(nodes['#staffTodayPunches']), /Showing latest 498 of 10,501/u);
  assert.match(elementText(nodes['#staffTimeRecords']), /Showing latest 500 of 10,503/u);
  assert.match(elementText(nodes['#staffTimeAudit']), /Showing latest 500 of 10,001/u);
  assert.match(elementText(nodes['#staffTimeRecords']), /Admin-added/u);
  assert.match(elementText(nodes['#staffTimeRecords']), /VOID/u);
  assert.match(elementText(nodes['#staffTimeAudit']), /Marked wrong punch as VOID/u);
  assert.equal(countElements(
    nodes['#staffTimeRecords'],
    element => element.className === 'staff-void-form'
  ), 499);
});

test('a stale Staff time page restarts the whole view once', async () => {
  const review = reviewResponse();
  const initial = reviewStartResponse();
  const streams = {
    records: review.records,
    attention: review.needsAttention,
    audit: review.audit
  };
  const { data, calls } = await runPagination(initial, streams, { staleOnce: true });
  assert.equal(data.records.length, 1);
  assert.equal(calls.filter(call => call.operation === 'review').length, 2);
  assert.deepEqual(
    calls.filter(call => call.operation === 'reviewPage').map(call => call.stream),
    ['records', 'records', 'audit']
  );
});

test('rendering covers all review collections with safe Admin-added, VOID, totals, and audit labels', () => {
  const renderSource = sourceBetween(adminHtml, 'function renderStaffTimeRecords(', 'function newStaffUuid(');
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

test('Staff Time records default to the latest seven New York calendar days and reveal fetched history newest first', () => {
  const data = reviewResponse();
  data.records = [
    {
      ...staffRecord(901),
      timestamp: '2026-08-11T23:50:00-04:00',
      date: '2026-08-11'
    },
    {
      ...staffRecord(902),
      timestamp: '2026-08-18T08:00:00-04:00',
      date: '2026-08-18'
    },
    {
      ...staffRecord(903),
      timestamp: '2026-08-12T00:01:00-04:00',
      date: '2026-08-12'
    },
    {
      ...staffRecord(904),
      timestamp: '2026-08-19T00:01:00-04:00',
      date: '2026-08-19'
    }
  ];
  data.view = {
    ...data.view,
    recordCount: 4,
    recordTotal: 4,
    todayPunchCount: 1,
    todayPunchTotal: 1,
    adjustmentCount: 0,
    adjustmentTotal: 0
  };

  const defaultNodes = renderStaffTimeRuntime(data);
  assert.equal(defaultNodes['#staffTimeRecords'].children.length, 2);
  assert.match(elementText(defaultNodes['#staffTimeRecords'].children[0]), /Aug 18/u);
  assert.match(elementText(defaultNodes['#staffTimeRecords'].children[1]), /Aug 12/u);
  assert.doesNotMatch(elementText(defaultNodes['#staffTimeRecords']), /Aug 11/u);
  assert.doesNotMatch(elementText(defaultNodes['#staffTimeRecords']), /Aug 19/u);
  assert.equal(defaultNodes['#staffTimeOlderHistory'].hidden, false);
  assert.equal(defaultNodes['#staffTimeOlderHistory'].textContent, 'Show older history');
  assert.equal(defaultNodes['#staffTimeOlderHistory'].attributes['aria-expanded'], 'false');
  assert.match(defaultNodes['#staffTimeHistoryScope'].textContent, /2026-08-12 through 2026-08-18, newest first/u);
  assert.match(defaultNodes['#staffTimeHistoryScope'].textContent, /Items needing attention remain above/u);
  assert.match(defaultNodes['#staffTimeHistoryScope'].textContent, /1 older punch is preserved/u);

  const expandedNodes = renderStaffTimeRuntime(data, { showOlder: true });
  assert.equal(expandedNodes['#staffTimeRecords'].children.length, 4);
  assert.match(elementText(expandedNodes['#staffTimeRecords'].children[3]), /Aug 11/u);
  assert.equal(expandedNodes['#staffTimeOlderHistory'].textContent, 'Hide older history');
  assert.equal(expandedNodes['#staffTimeOlderHistory'].attributes['aria-expanded'], 'true');
  assert.equal(data.records.length, 4);

  const toggleSource = sourceBetween(
    adminHtml,
    "$('#staffTimeOlderHistory').addEventListener('click'",
    "$('#staffTimeRecords').addEventListener('input'"
  );
  assert.match(toggleSource, /staffOlderHistoryExpanded = !staffOlderHistoryExpanded/u);
  assert.match(toggleSource, /renderStaffTimeRecords\(currentStaffTime\)/u);
});

test('completed shifts render one clear adjustment form plus original and corrected audit evidence', () => {
  const nodes = renderStaffTimeRuntime(adjustedReviewResponse());
  assert.equal(countElements(
    nodes['#staffTimeRecords'],
    element => element.className === 'staff-adjustment-form'
  ), 1);
  const recordText = elementText(nodes['#staffTimeRecords']);
  assert.match(recordText, /Adjust punch/u);
  assert.match(recordText, /Current clock-in \(before this change\)/u);
  assert.match(recordText, /Current clock-out \(before this change\)/u);
  assert.match(recordText, /Proposed corrected clock-in · America\/New_York/u);
  assert.match(recordText, /Proposed corrected clock-out · America\/New_York/u);
  assert.match(recordText, /Clock-in time zone/u);
  assert.match(recordText, /Clock-out time zone/u);
  assert.match(recordText, /EDT \(UTC−4\)/u);
  assert.match(recordText, /EST \(UTC−5\)/u);
  assert.match(recordText, /Original source time/u);
  assert.match(recordText, /Adjusted/u);
  const auditText = elementText(nodes['#staffTimeAudit']);
  assert.match(auditText, /Adjusted clock-in and clock-out/u);
  assert.match(auditText, /Original:/u);
  assert.match(auditText, /Corrected:/u);
  assert.match(auditText, /Manager verified the written time card/u);
});

test('correction IDs are permanent for an exact retry and regenerate only after input changes', () => {
  const functions = sourceBetween(adminHtml, 'function newStaffUuid()', 'function recordElement(');
  const uuids = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    '12345678-1234-4234-8234-123456789abc',
    '87654321-4321-4321-8321-cba987654321'
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
    globalThis.hooks = {
      staffTimestampForInputs,
      staffCorrectionIdentityFor,
      staffVoidRequestIdFor,
      staffAdjustmentRequestIdFor
    };
  `, { filename: 'staff-time-admin-identities.js' }).runInContext(context);

  assert.equal(context.hooks.staffTimestampForInputs('2026-08-18', '17:27'), '2026-08-18T17:27:00-04:00');
  assert.equal(context.hooks.staffTimestampForInputs('2026-08-18', '17:27:43'), '2026-08-18T17:27:43-04:00');
  assert.equal(context.hooks.staffTimestampForInputs('2026-01-18', '17:27'), '2026-01-18T17:27:00-05:00');
  assert.equal(context.hooks.staffTimestampForInputs('2026-03-08', '02:30'), '');
  assert.equal(context.hooks.staffTimestampForInputs('2026-11-01', '01:30'), '2026-11-01T01:30:00-04:00');
  assert.equal(context.hooks.staffTimestampForInputs('2026-11-01', '01:30', '-05:00'), '2026-11-01T01:30:00-05:00');
  assert.equal(context.hooks.staffTimestampForInputs('2026-01-18', '17:27', '-04:00', true), '');

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

  const adjustForm = { dataset: {} };
  const adjustment = {
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    clockInPunchId: PUNCH_ONE,
    clockOutPunchId: PUNCH_TWO,
    originalClockInAt: '2026-08-18T09:00:00-04:00',
    originalClockOutAt: '2026-08-18T17:00:00-04:00',
    correctedClockInAt: '2026-08-18T09:15:00-04:00',
    correctedClockOutAt: '2026-08-18T17:30:00-04:00',
    reason: 'Manager verified the written time card'
  };
  const firstAdjustment = context.hooks.staffAdjustmentRequestIdFor(adjustForm, adjustment);
  const retryAdjustment = context.hooks.staffAdjustmentRequestIdFor(adjustForm, adjustment);
  assert.equal(retryAdjustment, firstAdjustment);
  const changedAdjustment = context.hooks.staffAdjustmentRequestIdFor(adjustForm, {
    ...adjustment,
    correctedClockOutAt: '2026-08-18T17:45:00-04:00'
  });
  assert.notEqual(changedAdjustment, firstAdjustment);
});

test('correction, adjustment, and VOID mutations require reasons, confirmation, and exact acknowledgments', () => {
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

  const adjustmentMarkupSource = sourceBetween(
    adminHtml,
    'function staffAdjustmentForm(',
    'function staffCompletedShiftByClockIn('
  );
  assert.match(adjustmentMarkupSource, /Current clock-in/u);
  assert.match(adjustmentMarkupSource, /Current clock-out/u);
  assert.match(adjustmentMarkupSource, /Proposed corrected clock-in/u);
  assert.match(adjustmentMarkupSource, /Proposed corrected clock-out/u);
  assert.match(adjustmentMarkupSource, /reason\.required = true/u);
  assert.match(adjustmentMarkupSource, /reason\.maxLength = 240/u);
  assert.match(adjustmentMarkupSource, /staff-adjust-review/u);
  assert.match(adjustmentMarkupSource, /Review punch adjustment before saving/u);
  assert.match(adjustmentMarkupSource, /Cancel review and edit/u);

  const readAdjustmentSource = sourceBetween(
    adminHtml,
    'function readStaffAdjustment(',
    'function setStaffFormWorking('
  );
  assert.match(readAdjustmentSource, /staffCompletedShiftByClockIn\(currentStaffTime\.records\)/u);
  assert.match(readAdjustmentSource, /staffId: completedShift\.clockIn\.staffId/u);
  assert.match(readAdjustmentSource, /staffName: completedShift\.clockIn\.staffName/u);
  assert.match(readAdjustmentSource, /staffTimestampForInputs\(date, time, offset, true\)/u);
  assert.match(readAdjustmentSource, /Date\.parse\(correctedClockOutAt\) - Date\.parse\(correctedClockInAt\)/u);
  assert.match(readAdjustmentSource, /elapsed > 18 \* 60 \* 60 \* 1_000/u);
  assert.match(readAdjustmentSource, /Date\.parse\(correctedClockInAt\) > Date\.now\(\)/u);
  assert.match(readAdjustmentSource, /reason\.length < 3/u);

  const adjustmentSource = sourceBetween(
    adminHtml,
    'async function submitStaffAdjustment(',
    'async function submitStaffVoid('
  );
  assert.ok(adjustmentSource.indexOf('staffAdjustmentRequestIdFor(form, adjustment)') < adjustmentSource.indexOf('requestJson(API.staffTime, request)'));
  assert.ok(adjustmentSource.indexOf('form.dataset.staffReviewedFingerprint !== fingerprint') < adjustmentSource.indexOf('requestJson(API.staffTime, request)'));
  assert.match(adjustmentSource, /operation: 'adjust'/u);
  assert.match(adjustmentSource, /showStaffAdjustmentReview\(form, adjustment\)/u);
  assert.match(adjustmentSource, /Confirm and save adjustment/u);
  assert.doesNotMatch(adjustmentSource, /window\.confirm/u);
  assert.match(adjustmentSource, /Retry keeps the same permanent request ID/u);
  assert.match(adjustmentSource, /error\.status === 409/u);
  assert.match(adjustmentSource, /await loadStaffTime\(\{ quiet: true \}\)/u);
  const adjustmentRequestSource = sourceBetween(
    adjustmentSource,
    'const request = Object.freeze({',
    'const expected = Object.freeze({'
  );
  assert.doesNotMatch(adjustmentRequestSource, /staffId|staffName/u);

  const inlineReviewSource = sourceBetween(
    adminHtml,
    'function clearStaffAdjustmentReview(',
    'function setStaffFormWorking('
  );
  assert.match(inlineReviewSource, /Review this punch adjustment/u);
  assert.match(inlineReviewSource, /Staff: \$\{adjustment\.staffName\}/u);
  assert.match(inlineReviewSource, /Current clock-in:/u);
  assert.match(inlineReviewSource, /Current clock-out:/u);
  assert.match(inlineReviewSource, /Proposed clock-in:/u);
  assert.match(inlineReviewSource, /Proposed clock-out:/u);
  assert.match(inlineReviewSource, /Reason: \$\{adjustment\.reason\}/u);
  assert.match(inlineReviewSource, /source punches will remain unchanged/u);
  assert.match(inlineReviewSource, /permanently audited/u);
  assert.match(inlineReviewSource, /staffReviewedFingerprint/u);
  assert.match(inlineReviewSource, /Confirm and save adjustment/u);

  const adjustmentEvents = sourceBetween(
    adminHtml,
    "$('#staffTimeRecords').addEventListener('click'",
    "$('#staffTimeRecords').addEventListener('submit'"
  );
  assert.match(adjustmentEvents, /data-staff-adjust-cancel/u);
  assert.match(adjustmentEvents, /clearStaffAdjustmentReview\(form\)/u);
  assert.match(adjustmentEvents, /Review canceled\. Edit the times or reason/u);

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

  const adjustExpected = {
    operation: 'adjust',
    requestId: REQUEST_ONE,
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    clockInPunchId: PUNCH_ONE,
    clockOutPunchId: PUNCH_TWO,
    originalClockInAt: '2026-08-18T09:00:00-04:00',
    originalClockOutAt: '2026-08-18T17:00:00-04:00',
    correctedClockInAt: '2026-08-18T09:15:00-04:00',
    correctedClockOutAt: '2026-08-18T17:30:00-04:00',
    reason: 'Manager verified the written time card'
  };
  const adjustResponse = {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    operation: 'adjust',
    requestId: REQUEST_ONE,
    result: 'adjusted',
    linkedPunchIds: [PUNCH_ONE, PUNCH_TWO],
    auditActionNumber: 3,
    confirmation: {
      actionTime: '2026-08-18T17:45:00-04:00',
      adminName: 'Andrew Smith',
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      changed: 'both',
      clockInPunchId: PUNCH_ONE,
      clockOutPunchId: PUNCH_TWO,
      originalClockInAt: adjustExpected.originalClockInAt,
      originalClockOutAt: adjustExpected.originalClockOutAt,
      correctedClockInAt: adjustExpected.correctedClockInAt,
      correctedClockOutAt: adjustExpected.correctedClockOutAt,
      reason: adjustExpected.reason
    }
  };
  assert.equal(validStaffMutationResponse(adjustResponse, adjustExpected), true);
  assert.equal(validStaffMutationResponse({
    ...adjustResponse,
    linkedPunchIds: [PUNCH_TWO, PUNCH_ONE]
  }, adjustExpected), false);
  assert.equal(validStaffMutationResponse({
    ...adjustResponse,
    confirmation: { ...adjustResponse.confirmation, correctedClockOutAt: '2026-08-18T17:45:00-04:00' }
  }, adjustExpected), false);
  assert.equal(validStaffMutationResponse({
    ...adjustResponse,
    confirmation: { ...adjustResponse.confirmation, staffName: 'Front Desk Test Two' }
  }, adjustExpected), false);
});

test('Adjust punch uses inline review first and sends only after the second explicit submit', async () => {
  const reviewFunctions = sourceBetween(
    adminHtml,
    'function clearStaffAdjustmentReview(',
    'function focusStaffTimeHash('
  );
  const submitFunction = sourceBetween(
    adminHtml,
    'async function submitStaffAdjustment(',
    'async function submitStaffVoid('
  );
  const context = vm.createContext({ Object, Array, JSON, calls: [], loadCount: 0, focusCount: 0 });
  new vm.Script(`
    const API = { staffTime: '/staff-time' };
    const adjustment = Object.freeze({
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      clockInPunchId: '${PUNCH_ONE}',
      clockOutPunchId: '${PUNCH_TWO}',
      originalClockInAt: '2026-08-18T09:00:00-04:00',
      originalClockOutAt: '2026-08-18T17:00:00-04:00',
      correctedClockInAt: '2026-08-18T09:15:00-04:00',
      correctedClockOutAt: '2026-08-18T17:30:00-04:00',
      reason: 'Manager verified the written time card'
    });
    const review = {
      hidden: true,
      replaceChildren(...children) { this.children = children; },
      focus() { focusCount += 1; }
    };
    const cancel = { hidden: true, disabled: false };
    const submit = { textContent: 'Review adjustment', disabled: false };
    const status = {};
    const controls = [submit, cancel];
    const attributes = { 'aria-busy': 'false' };
    const form = {
      dataset: {},
      elements: controls,
      getAttribute(name) { return attributes[name] || ''; },
      setAttribute(name, value) { attributes[name] = String(value); },
      querySelector(selector) {
        if (selector === '[data-staff-adjust-review]') return review;
        if (selector === '[data-staff-adjust-cancel]') return cancel;
        if (selector === 'button[type="submit"]') return submit;
        if (selector === '.staff-adjust-status') return status;
        return null;
      }
    };
    function readStaffAdjustment() { return adjustment; }
    function staffAdjustmentFingerprint(value) { return JSON.stringify(value); }
    function staffAdjustmentRequestIdFor(target, value) {
      target.dataset.staffRequestId = target.dataset.staffRequestId || '${REQUEST_ONE}';
      target.dataset.staffFingerprint = staffAdjustmentFingerprint(value);
      return target.dataset.staffRequestId;
    }
    function makeElement(tagName, className, textContent) { return { tagName, className, textContent }; }
    function staffTimestampLabel(value) { return value; }
    function showMessage(target, message) { target.message = message; }
    function validStaffMutationResponse() { return true; }
    async function requestJson(url, body) {
      calls.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return { result: 'adjusted' };
    }
    function toast() {}
    async function loadStaffTime() { loadCount += 1; return true; }
    function setLoggedOut() {}
    ${reviewFunctions}
    ${submitFunction}
    globalThis.hooks = { form, review, cancel, submit, submitStaffAdjustment };
  `, { filename: 'staff-time-inline-adjustment.js' }).runInContext(context);

  await context.hooks.submitStaffAdjustment(context.hooks.form);
  assert.equal(context.calls.length, 0);
  assert.equal(context.hooks.review.hidden, false);
  assert.equal(context.hooks.cancel.hidden, false);
  assert.equal(context.hooks.submit.textContent, 'Confirm and save adjustment');
  assert.equal(context.focusCount, 1);

  await context.hooks.submitStaffAdjustment(context.hooks.form);
  assert.equal(context.calls.length, 1);
  assert.deepEqual(Object.keys(context.calls[0].body).sort(), [
    'clockInPunchId', 'clockOutPunchId', 'correctedClockInAt', 'correctedClockOutAt',
    'operation', 'originalClockInAt', 'originalClockOutAt', 'reason', 'requestId'
  ]);
  assert.equal(context.calls[0].body.operation, 'adjust');
  assert.equal(context.loadCount, 1);
  assert.equal(context.hooks.submit.textContent, 'Confirm and save adjustment');
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
