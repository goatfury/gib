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

function renderStaffTimeRuntime(data) {
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
  const initializeSource = sourceBetween(adminHtml, 'async function initialize(', "$('#loginButton')");
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
