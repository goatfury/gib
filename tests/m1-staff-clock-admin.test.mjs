import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const adminHtml = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');
const installationProfileSource = readFileSync(
  new URL('../m1/installation-profile-core.mjs', import.meta.url),
  'utf8'
);

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
    const STAFF_TIME_SHIFT_LOOKUP_LIMIT = 20;
    const STAFF_TIME_SHIFT_LOOKUP_MAX_BYTES = 80_000;
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
      validStaffCompletedShift,
      validStaffTimeShiftLookupResponse,
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
    shiftStaff: [
      { staffId: 'mandy-test', staffName: 'Mandy Test' },
      { staffId: 'front-desk-test-three', staffName: 'Front Desk Test Three' }
    ],
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
    shiftStaff: review.shiftStaff,
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

function completedHistoryShift(index = 950, overrides = {}) {
  const clockIn = {
    ...staffRecord(index),
    timestamp: '2026-08-11T09:00:00-04:00',
    date: '2026-08-11',
    punchAction: 'clockIn'
  };
  const clockOut = {
    ...staffRecord(index + 1),
    timestamp: '2026-08-11T17:00:00-04:00',
    date: '2026-08-11',
    punchAction: 'clockOut'
  };
  return { clockIn, clockOut, latestAdjustment: null, ...overrides };
}

function shiftLookup(overrides = {}) {
  return {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    viewToken: VIEW_TOKEN,
    mode: 'recent',
    dateFrom: '2026-08-12',
    dateThrough: '2026-08-18',
    staffId: '',
    date: '',
    total: 0,
    items: [],
    truncated: false,
    ...overrides
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

function renderStaffTimeRuntime(data, {
  recentLookup = shiftLookup(),
  recentLoading = false,
  recentError = '',
  recentVisibleLimit = 8,
  olderLookup = null,
  olderQuery = null,
  olderLoading = false,
  olderError = '',
  advancedLoading = false,
  advancedLoaded = true,
  advancedError = '',
  renderAdvancedStateOnly = false
} = {}) {
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
  const nodes = {
    '#staffNeedsAttentionSection': new FakeElement('section'),
    '#staffCorrectionPanel': new FakeElement('section')
  };
  nodes['#staffCorrectionPanel'].hidden = true;
  const context = vm.createContext({
    Date,
    Intl,
    Object,
    nodes,
    data: structuredClone(data),
    recentLookup: structuredClone(recentLookup),
    recentLoading,
    recentError,
    recentVisibleLimit,
    olderLookup: structuredClone(olderLookup),
    olderQuery: structuredClone(olderQuery),
    olderLoading,
    olderError,
    advancedLoading,
    advancedLoaded,
    advancedError,
    renderAdvancedStateOnly,
    createElement: tagName => new FakeElement(tagName)
  });
  new vm.Script(`
    const TIME_ZONE = 'America/New_York';
    const STAFF_RECENT_INITIAL_LIMIT = 8;
    const STAFF_RECENT_INCREMENT = 8;
    const STAFF_RECENT_MAX_VISIBLE = 20;
    const STAFF_ATTENTION_ACTIONS = Object.freeze({
      missing_clock_out: Object.freeze({ punchAction: 'clockOut', linkedPunchAction: 'clockIn' }),
      clock_out_without_clock_in: Object.freeze({ punchAction: 'clockIn', linkedPunchAction: 'clockOut' })
    });
    let currentStaffTime = null;
    let currentStaffRecentLookup = recentLookup;
    let currentStaffAttention = data.needsAttention;
    let staffRecentVisibleLimit = recentVisibleLimit;
    let staffRecentLoading = recentLoading;
    let staffRecentLoadError = recentError;
    let currentStaffOlderShiftLookup = olderLookup;
    let currentStaffOlderShiftQuery = olderQuery;
    let staffOlderShiftLoading = olderLoading;
    let staffOlderShiftError = olderError;
    let staffAdvancedLoading = advancedLoading;
    let staffAdvancedLoaded = advancedLoaded;
    let staffAdvancedError = advancedError;
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
    function showMessage(element, message) {
      element.textContent = message || '';
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
    ${functions}
    if (renderAdvancedStateOnly) {
      renderStaffTimePrimary(data);
      renderStaffTimeAdvancedState();
    } else {
      renderStaffTime(data);
    }
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

async function runPagination(initial, streams, {
  staleOnce = false,
  pageSize = 500,
  recentLookup = shiftLookup(),
  shiftLookupFailure = false
} = {}) {
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
    recentLookup,
    shiftLookupFailure,
    calls: []
  });
  new vm.Script(`
    const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_TIMESTAMP_PATTERN = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}-(?:04|05):00$/;
    const STAFF_TIME_VIEW_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
    const STAFF_TIME_PAGE_LIMIT = 500;
    const STAFF_TIME_PAGE_MAX_BYTES = 200_000;
    const STAFF_TIME_SHIFT_LOOKUP_LIMIT = 20;
    const STAFF_TIME_SHIFT_LOOKUP_MAX_BYTES = 80_000;
    const STAFF_TIME_RECORD_LIMIT = 500;
    const STAFF_TIME_ATTENTION_LIMIT = 600;
    const STAFF_TIME_AUDIT_LIMIT = 500;
    const STAFF_TIME_READ_TIMEOUT_MS = 25_000;
    const STAFF_TIME_READ_REQUEST_OPTIONS = Object.freeze({
      timeoutMs: STAFF_TIME_READ_TIMEOUT_MS,
      timeoutMessage: 'Staff Time took too long to load. Retry below.'
    });
    const SITE = 'Rev';
    const API = { staffTime: '/staff-time' };
    let testMode = true;
    let currentAdminName = 'Andrew Smith';
    let staffTimeLoadGeneration = 7;
    let currentStaffRecentLookup = null;
    let staffRecentLoadError = '';
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
      if (body.operation === 'shiftLookup') {
        if (shiftLookupFailure) throw new Error('matching receiver unavailable');
        return JSON.parse(JSON.stringify({
          ...recentLookup,
          viewToken: body.viewToken,
          mode: body.mode
        }));
      }
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
    globalThis.hooks = {
      loadStaffTimeReviewView,
      loadStaffTimeAdvancedReview,
      validStaffTimeStaleError,
      lookupState: () => ({
        lookup: currentStaffRecentLookup,
        error: staffRecentLoadError
      })
    };
  `, { filename: 'staff-time-admin-pagination.js' }).runInContext(context);
  let start = await context.hooks.loadStaffTimeReviewView(7);
  let data;
  try {
    data = await context.hooks.loadStaffTimeAdvancedReview(start, 7);
  } catch (error) {
    if (!context.hooks.validStaffTimeStaleError(error)) throw error;
    start = await context.hooks.loadStaffTimeReviewView(7);
    data = await context.hooks.loadStaffTimeAdvancedReview(start, 7);
  }
  return { data, calls: context.calls, lookupState: context.hooks.lookupState() };
}

function configureLoginEntryRuntime(hostname) {
  const source = sourceBetween(
    adminHtml,
    'function configureAdminLoginEntry(',
    'async function loadProductionLedgerStatus('
  );
  const nodes = {
    '#testEntry': { style: { display: 'unchanged' } },
    '#passphraseField': { hidden: false },
    '#loginButton': { hidden: false },
    '#loginCopy': { textContent: 'production login copy' },
    '#testEntryHeading': { textContent: 'original test heading' },
    '#testEntryCopy': { textContent: 'original test copy' },
    '#testLoginButton': { className: 'btn warn', textContent: 'Enter TEST Admin' },
    '#loginAdminName': { value: 'Stuart Turner' }
  };
  const context = vm.createContext({ nodes, location: { hostname } });
  new vm.Script(`
    const IS_RICHMOND = false;
    const IS_RICHMOND_PRODUCTION = false;
    const TEST_ADMIN_HOST_PATTERN = /^(?:deploy-preview-[0-9]+|[a-f0-9]{24})--gib-live[.]netlify[.]app$/i;
    function $(selector) { return nodes[selector]; }
    ${source}
    globalThis.result = configureAdminLoginEntry();
  `, { filename: 'admin-login-entry.js' }).runInContext(context);
  return { nodes, result: context.result };
}

function tabletPairingAdminRuntime({ reviewFailure = '', approveFailure = '', rejectFailure = '' } = {}) {
  const source = sourceBetween(
    adminHtml,
    'function validTabletPairingCode(',
    'async function requestJson('
  );
  const now = Date.now();
  const reviewResponse = {
    ok: true,
    result: 'pending',
    installationId: 'rev',
    gymName: 'Revolution BJJ',
    origin: 'https://gib-live.netlify.app',
    deviceLabel: 'Revolution BJJ front desk',
    requestedAt: new Date(now - 60 * 60_000).toISOString(),
    expiresAt: new Date(now + 11 * 60 * 60_000).toISOString()
  };
  const approveResponse = {
    ok: true,
    result: 'approved',
    installationId: 'rev',
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk',
    approvedAt: new Date(now).toISOString()
  };
  const rejectResponse = {
    ok: true,
    result: 'rejected',
    installationId: 'rev',
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk'
  };
  const nodes = {
    '#tabletPairingCode': { value: 'abcde-fghjk', focusCount: 0, focus() { this.focusCount += 1; } },
    '#tabletPairingReviewButton': { disabled: false },
    '#tabletPairingMessage': { message: '', tone: '' },
    '#tabletPairingReview': { hidden: true },
    '#tabletPairingGym': { textContent: '' },
    '#tabletPairingOrigin': { textContent: '' },
    '#tabletPairingDevice': { textContent: '' },
    '#tabletPairingRequested': { textContent: '' },
    '#tabletPairingExpires': { textContent: '' },
    '#tabletPairingApproveButton': {
      disabled: false,
      focusCount: 0,
      focus() { this.focusCount += 1; }
    },
    '#tabletPairingRejectButton': { disabled: false },
    '#tabletPairingCancelButton': { disabled: false },
    '#tabletPairingApprovalMessage': { message: '', tone: '' }
  };
  const context = vm.createContext({
    Date,
    Intl,
    JSON,
    Object,
    nodes,
    reviewResponse,
    approveResponse,
    rejectResponse,
    reviewFailure,
    approveFailure,
    rejectFailure,
    calls: [],
    loggedOutMessage: ''
  });
  new vm.Script(`
    const TIME_ZONE = 'America/New_York';
    const INSTALLATION = Object.freeze({
      installationId: 'rev',
      gymName: 'Revolution BJJ',
      deviceLabel: 'Revolution BJJ front desk'
    });
    const STAFF_CLOCK_PAIRING_CONFIG = Object.freeze({
      origin: 'https://gib-live.netlify.app',
      expiresInSeconds: 43_200
    });
    const TABLET_PAIRING_AVAILABLE = true;
    const TABLET_PAIRING_REVIEW_LIFETIME_MS = 15 * 60_000;
    const API = Object.freeze({ tabletPairing: '/api/m1-admin-tablet-pairing' });
    let adminRequestToken = 'a'.repeat(64);
    let reviewedTabletPairingCode = '';
    function $(selector) { return nodes[selector]; }
    function clean(value) {
      return String(value == null ? '' : value).normalize('NFKC').trim().replace(/\\s+/g, ' ');
    }
    function exactObjectKeys(value, expectedKeys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const actual = Object.keys(value).sort();
      const expected = [...expectedKeys].sort();
      return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
    }
    function validIsoTimestamp(value) {
      return typeof value === 'string'
        && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(value)
        && Number.isFinite(Date.parse(value));
    }
    function showMessage(target, message, tone = 'error') {
      target.message = message;
      target.tone = tone;
    }
    function setLoggedOut(message) { loggedOutMessage = message; }
    async function requestJson(url, body) {
      calls.push({ url, body: JSON.parse(JSON.stringify(body)) });
      if (body.operation === 'review') {
        if (reviewFailure) throw Object.assign(new Error(reviewFailure), { status: 410 });
        return JSON.parse(JSON.stringify(reviewResponse));
      }
      if (body.operation === 'reject') {
        if (rejectFailure) throw Object.assign(new Error(rejectFailure), { status: 500 });
        return JSON.parse(JSON.stringify(rejectResponse));
      }
      if (approveFailure) throw Object.assign(new Error(approveFailure), { status: 500 });
      return JSON.parse(JSON.stringify(approveResponse));
    }
    ${source}
    globalThis.hooks = {
      validTabletPairingCode,
      normalizeTabletPairingCode,
      validTabletPairingReviewResponse,
      validTabletPairingApproveResponse,
      validTabletPairingRejectResponse,
      clearTabletPairingReview,
      reviewTabletPairing,
      approveTabletPairing,
      rejectTabletPairing,
      reviewedCode: () => reviewedTabletPairingCode
    };
  `, { filename: 'admin-tablet-pairing.js' }).runInContext(context);
  return { context, hooks: context.hooks, nodes, reviewResponse, approveResponse, rejectResponse };
}

test('Admin exposes exactly two compact, mutually exclusive manager modes', () => {
  const app = sourceBetween(adminHtml, '<section id="appPanel"', '<div id="toast"');
  const dailyPosition = app.indexOf('id="sign-ins"');
  const staffPosition = app.indexOf('id="staff-time"');
  assert.ok(dailyPosition >= 0);
  assert.ok(staffPosition > dailyPosition);
  assert.equal((app.match(/class="(?:[^"]* )?mode-panel(?: [^"]*)?"/gu) || []).length, 2);
  assert.match(app, /role="tablist"[^>]*aria-label="Admin mode"[\s\S]*href="#sign-ins"[^>]*role="tab"[\s\S]*href="#staff-time"[^>]*role="tab"/u);
  assert.match(app, /<section id="sign-ins"[^>]*role="tabpanel"/u);
  assert.match(app, /<section id="staff-time"[^>]*role="tabpanel"[^>]*hidden/u);
  assert.equal(idCount('staff-time'), 1);
  assert.match(app, /Needs attention[\s\S]*Clocked in now[\s\S]*Recent completed shifts/u);
  assert.match(app, /<details id="staffPayPeriods"[^>]*>\s*<summary>Pay-period totals<\/summary>/u);
  assert.doesNotMatch(app.match(/<details id="staffPayPeriods"[^>]*>/u)?.[0] || '', /\bopen\b/u);
  assert.match(app, /id="staffCorrectionOpen"[^>]*aria-controls="staffCorrectionPanel"[^>]*aria-expanded="false"[^>]*>Add missed punch/u);
  assert.match(app, /<section id="staffCorrectionPanel"[^>]*hidden/u);
  assert.match(app, /Recent completed shifts[\s\S]*Find an older shift[\s\S]*Advanced records and audit/u);
  assert.equal(idCount('staffRecentShifts'), 1);
  assert.equal(idCount('staffOlderShiftFinder'), 1);
  assert.equal(idCount('staffOlderShiftResults'), 1);
  assert.equal(idCount('staffTimeAdvanced'), 1);
  assert.match(app, /<details id="staffOlderShiftFinder"[^>]*>[\s\S]*<summary>Find an older shift<\/summary>/u);
  assert.match(app, /<details id="staffTimeAdvanced"[^>]*>[\s\S]*Advanced records and audit[\s\S]*staffTimeRecords[\s\S]*staffTimeAudit/u);
  const advancedMarkup = sourceBetween(app, '<details id="staffTimeAdvanced"', '</details>\n        </div>\n      </section>');
  assert.match(advancedMarkup, /Today’s punches[\s\S]*Staff Time records[\s\S]*Staff time audit/u);
  assert.doesNotMatch(advancedMarkup, /Needs attention/u);
  assert.match(advancedMarkup, /Open this section to load advanced records and audit/u);
  assert.match(advancedMarkup, /staffTimeAdvancedRetry[^>]*hidden/u);
  assert.doesNotMatch(app.match(/<details id="staffOlderShiftFinder"[^>]*>/u)?.[0] || '', /\bopen\b/u);
  assert.doesNotMatch(app.match(/<details id="staffTimeAdvanced"[^>]*>/u)?.[0] || '', /\bopen\b/u);
  assert.doesNotMatch(app, /Load older completed shifts|staffTimeOlderHistory|staffCompletedShiftHistory/u);
  const staffStyles = sourceBetween(adminHtml, '.staff-time-panel {', '@media (max-width:');
  assert.match(staffStyles, /overflow:\s*visible/u);
  assert.doesNotMatch(staffStyles, /overflow-y:\s*(?:auto|scroll)|max-height/u);
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
  assert.match(pagingSource, /operation: 'shiftLookup'/u);
  assert.match(pagingSource, /mode: 'recent'/u);
  assert.match(pagingSource, /validStaffTimeShiftLookupResponse\(lookup, expected\)/u);
  assert.match(pagingSource, /fetchStaffTimeShiftLookup\(\s*initial,\s*\{ mode: 'recent' \},\s*generation/u);
  assert.match(
    pagingSource,
    /requestJson\(\s*API\.staffTime,\s*\{ operation: 'review' \},\s*STAFF_TIME_READ_REQUEST_OPTIONS/u
  );
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

test('Deploy Preview presents one production-credential-free TEST Admin entry while production stays unchanged', () => {
  const loginMarkup = sourceBetween(adminHtml, '<section id="loginPanel"', '<section id="appPanel"');
  assert.ok(loginMarkup.indexOf('id="loginAdminName"') < loginMarkup.indexOf('id="testEntry"'));
  assert.ok(loginMarkup.indexOf('id="testEntry"') < loginMarkup.indexOf('id="passphraseField"'));
  assert.ok(loginMarkup.indexOf('id="testEntry"') < loginMarkup.indexOf('class="login-actions"'));
  for (const hostname of [
    'deploy-preview-74--gib-live.netlify.app',
    '1234567890abcdef12345678--gib-live.netlify.app'
  ]) {
    const { nodes, result } = configureLoginEntryRuntime(hostname);
    assert.equal(result, true);
    assert.equal(nodes['#testEntry'].style.display, 'block');
    assert.equal(nodes['#passphraseField'].hidden, true);
    assert.equal(nodes['#loginButton'].hidden, true);
    assert.equal(nodes['#testLoginButton'].className, 'btn primary');
    assert.equal(nodes['#testLoginButton'].textContent, 'Enter TEST Admin');
    assert.match(nodes['#loginCopy'].textContent, /Choose Andrew Smith or Stuart Turner/u);
    assert.match(nodes['#loginCopy'].textContent, /Production credentials are not used/u);
    assert.match(nodes['#testEntryCopy'].textContent, /copied TEST Sheet/u);
    assert.match(nodes['#testEntryCopy'].textContent, /Production credentials are not used/u);
    assert.equal(nodes['#loginAdminName'].value, 'Stuart Turner');
  }

  const production = configureLoginEntryRuntime('gib-live.netlify.app');
  assert.equal(production.result, false);
  assert.equal(production.nodes['#testEntry'].style.display, 'none');
  assert.equal(production.nodes['#passphraseField'].hidden, false);
  assert.equal(production.nodes['#loginButton'].hidden, false);
  assert.equal(production.nodes['#loginCopy'].textContent, 'production login copy');
  assert.equal(production.nodes['#testLoginButton'].className, 'btn warn');
  assert.match(adminHtml, /\.test-entry \.btn\.primary \{ width: 100%; font-size: 1rem; \}/u);
});

test('Admin tablet pairing is profile-gated, cross-device, and never persists a code', () => {
  const app = sourceBetween(adminHtml, '<section id="appPanel"', '<div id="toast"');
  assert.equal(idCount('tabletPairing'), 1);
  assert.equal(idCount('tabletPairingForm'), 1);
  assert.equal(idCount('tabletPairingCode'), 1);
  assert.equal(idCount('tabletPairingReview'), 1);
  assert.equal(idCount('tabletPairingApproveButton'), 1);
  assert.equal(idCount('tabletPairingRejectButton'), 1);
  assert.equal(idCount('tabletPairingCancelButton'), 1);
  assert.match(app, /id="tabletPairing"[^>]*hidden/u);
  assert.match(app, /Authorize a Staff Clock tablet/u);
  assert.match(app, /Enter the short code from the Staff Clock tablet, then review the exact request/u);
  assert.match(app, /Review before approving[\s\S]*Gym[\s\S]*Origin[\s\S]*Device[\s\S]*Requested[\s\S]*Expires/u);
  assert.match(app, /Confirm tablet authorization/u);
  assert.match(app, /Reject pairing request/u);
  assert.match(app, /remains valid for up to 15 minutes/u);
  assert.match(adminHtml, /tabletPairing:\s*'\/api\/m1-admin-tablet-pairing'/u);

  const availabilitySource = sourceBetween(
    adminHtml,
    'const STAFF_CLOCK_PAIRING_ENABLED',
    'function richmondProductionAdminCopy('
  );
  assert.match(availabilitySource, /INSTALLATION\.featureFlags\.staffClockPairing === true/u);
  assert.match(availabilitySource, /STAFF_CLOCK_PAIRING_CONFIG\.expiresInSeconds >= 60/u);
  assert.match(availabilitySource, /STAFF_CLOCK_PAIRING_CONFIG\.expiresInSeconds <= 12 \* 60 \* 60/u);
  assert.match(availabilitySource, /INSTALLATION\.allowedOrigin === STAFF_CLOCK_PAIRING_CONFIG\.origin/u);
  assert.match(availabilitySource, /location\.origin === STAFF_CLOCK_PAIRING_CONFIG\.origin/u);
  assert.doesNotMatch(availabilitySource, /IS_RICHMOND|installationId\s*===\s*'rev'/u);
  assert.equal(
    (installationProfileSource.match(/featureFlags: Object\.freeze\(\{ staffClock: false, staffClockPairing: false \}\)/gu) || []).length,
    3
  );
  assert.equal(
    (installationProfileSource.match(/featureFlags: Object\.freeze\(\{ staffClock: true, staffClockPairing: true \}\)/gu) || []).length,
    1
  );
  assert.match(adminHtml, /const INSTALLATION = globalThis\.M1_INSTALLATION_PROFILE/u);
  assert.match(adminHtml, /\$\('#tabletPairing'\)\.hidden = !TABLET_PAIRING_AVAILABLE/u);

  const pairingSource = sourceBetween(
    adminHtml,
    'function validTabletPairingCode(',
    'async function requestJson('
  );
  assert.match(pairingSource, /requestJson\(API\.tabletPairing, \{\s*operation: 'review',\s*pairingCode: code\s*\}\)/u);
  assert.match(pairingSource, /requestJson\(API\.tabletPairing, \{\s*operation: 'approve',\s*pairingCode: code\s*\}\)/u);
  assert.match(pairingSource, /requestJson\(API\.tabletPairing, \{\s*operation: 'reject',\s*pairingCode: code\s*\}\)/u);
  assert.doesNotMatch(pairingSource, /location|URLSearchParams|localStorage|sessionStorage/u);
  assert.doesNotMatch(adminHtml, /tabletAuthorize|tabletInstall|authorizeTablet=1|localStorage|sessionStorage|URLSearchParams/u);

  const requestSource = sourceBetween(adminHtml, 'async function requestJson(', 'function setLoggedOut(');
  assert.match(requestSource, /headers\[ADMIN_REQUEST_HEADER\] = adminRequestToken/u);
  assert.match(requestSource, /credentials:\s*'same-origin'/u);
  assert.match(requestSource, /mode:\s*'same-origin'/u);
  assert.match(requestSource, /redirect:\s*'error'/u);
  assert.match(requestSource, /cache:\s*'no-store'/u);
});

test('Admin requests reject redirects and stay on the authenticated same-origin transport', async () => {
  const requestSource = sourceBetween(adminHtml, 'async function requestJson(', 'function setLoggedOut(');
  let captured = null;
  const data = await Function('fetch', `
    const ADMIN_REQUEST_HEADER = 'X-GIB-M1-Admin-Request-Token';
    let adminRequestToken = 'a'.repeat(64);
    ${requestSource}
    return requestJson('/api/m1-admin-tablet-pairing', {
      operation: 'review',
      pairingCode: 'ABCDE-FGHJK'
    });
  `)(async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true }; }
    };
  });

  assert.deepEqual(data, { ok: true });
  assert.equal(captured.url, '/api/m1-admin-tablet-pairing');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.credentials, 'same-origin');
  assert.equal(captured.options.mode, 'same-origin');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.cache, 'no-store');
  assert.equal(captured.options.headers['X-GIB-M1-Admin-Request-Token'], 'a'.repeat(64));
  assert.deepEqual(JSON.parse(captured.options.body), {
    operation: 'review',
    pairingCode: 'ABCDE-FGHJK'
  });
});

test('Admin pairing validators accept 12-hour requests and bind approval/rejection responses to this installation', () => {
  const { hooks, reviewResponse, approveResponse, rejectResponse } = tabletPairingAdminRuntime();
  for (const code of ['01234-56789', 'ABCDE-FGHJK', 'MNPQR-STVWX']) {
    assert.equal(hooks.validTabletPairingCode(code), true, code);
  }
  for (const code of [
    'abcde-fghjk',
    'ABCDE-FGHIJ',
    'ABCDE-FGHJL',
    'ABCDE-FGHOJ',
    'ABCDE-FGHUJ',
    'ABCD-FGHJK',
    'ABCDE-FGHJKL',
    'ABCDEFGHIJ'
  ]) {
    assert.equal(hooks.validTabletPairingCode(code), false, code);
  }
  assert.equal(hooks.normalizeTabletPairingCode('  abcde - fghjk  '), 'ABCDE-FGHJK');

  assert.equal(hooks.validTabletPairingReviewResponse(reviewResponse, 'ABCDE-FGHJK'), true);
  assert.equal(
    Date.parse(reviewResponse.expiresAt) - Date.parse(reviewResponse.requestedAt),
    12 * 60 * 60_000
  );
  assert.equal(hooks.validTabletPairingReviewResponse({
    ...reviewResponse,
    extra: true
  }, 'ABCDE-FGHJK'), false);
  assert.equal(hooks.validTabletPairingReviewResponse({
    ...reviewResponse,
    installationId: 'richmond'
  }, 'ABCDE-FGHJK'), false);
  assert.equal(hooks.validTabletPairingReviewResponse({
    ...reviewResponse,
    origin: 'https://gib-richmond-live.netlify.app'
  }, 'ABCDE-FGHJK'), false);
  assert.equal(hooks.validTabletPairingReviewResponse({
    ...reviewResponse,
    deviceLabel: 'Another tablet'
  }, 'ABCDE-FGHJK'), false);
  assert.equal(hooks.validTabletPairingReviewResponse({
    ...reviewResponse,
    expiresAt: new Date(Date.parse(reviewResponse.expiresAt) + 2_000).toISOString()
  }, 'ABCDE-FGHJK'), false);
  assert.equal(hooks.validTabletPairingReviewResponse(reviewResponse, 'ABCDE-FGHIJ'), false);

  assert.equal(hooks.validTabletPairingApproveResponse(approveResponse), true);
  assert.equal(hooks.validTabletPairingApproveResponse({
    ...approveResponse,
    installationId: 'richmond'
  }), false);
  assert.equal(hooks.validTabletPairingApproveResponse({
    ...approveResponse,
    deviceLabel: 'Another tablet'
  }), false);
  assert.equal(hooks.validTabletPairingApproveResponse({
    ...approveResponse,
    extra: true
  }), false);

  const approvedAt = Date.parse(approveResponse.approvedAt);
  assert.equal(hooks.validTabletPairingApproveResponse({
    ...approveResponse,
    approvedAt: new Date(approvedAt + 5_000).toISOString()
  }, approvedAt), true, 'the five-second future-skew boundary is accepted');
  assert.equal(hooks.validTabletPairingApproveResponse({
    ...approveResponse,
    approvedAt: new Date(approvedAt + 5_001).toISOString()
  }, approvedAt), false, 'timestamps beyond the future-skew boundary are rejected');
  assert.equal(hooks.validTabletPairingApproveResponse({
    ...approveResponse,
    approvedAt: new Date(approvedAt - 15 * 60_000).toISOString()
  }, approvedAt), true, 'the 15-minute review readback boundary is accepted');
  assert.equal(hooks.validTabletPairingApproveResponse({
    ...approveResponse,
    approvedAt: new Date(approvedAt - 15 * 60_000 - 1).toISOString()
  }, approvedAt), false, 'timestamps older than the readback boundary are rejected');

  assert.equal(hooks.validTabletPairingRejectResponse(rejectResponse), true);
  assert.equal(hooks.validTabletPairingRejectResponse({
    ...rejectResponse,
    installationId: 'richmond'
  }), false);
  assert.equal(hooks.validTabletPairingRejectResponse({
    ...rejectResponse,
    extra: true
  }), false);
});

test('Admin pairing reviews first, approves separately, and clears memory and DOM state', async () => {
  const { context, hooks, nodes } = tabletPairingAdminRuntime();

  await hooks.reviewTabletPairing();
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [{
    url: '/api/m1-admin-tablet-pairing',
    body: { operation: 'review', pairingCode: 'ABCDE-FGHJK' }
  }]);
  assert.equal(hooks.reviewedCode(), 'ABCDE-FGHJK');
  assert.equal(nodes['#tabletPairingCode'].value, 'ABCDE-FGHJK');
  assert.equal(nodes['#tabletPairingReview'].hidden, false);
  assert.equal(nodes['#tabletPairingGym'].textContent, 'Revolution BJJ');
  assert.equal(nodes['#tabletPairingOrigin'].textContent, 'https://gib-live.netlify.app');
  assert.equal(nodes['#tabletPairingDevice'].textContent, 'Revolution BJJ front desk');
  assert.match(nodes['#tabletPairingRequested'].textContent, /America\/New_York time/u);
  assert.match(nodes['#tabletPairingExpires'].textContent, /America\/New_York time/u);
  assert.equal(nodes['#tabletPairingApproveButton'].focusCount, 1);
  assert.equal(nodes['#tabletPairingMessage'].tone, 'success');

  await hooks.approveTabletPairing();
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [
    {
      url: '/api/m1-admin-tablet-pairing',
      body: { operation: 'review', pairingCode: 'ABCDE-FGHJK' }
    },
    {
      url: '/api/m1-admin-tablet-pairing',
      body: { operation: 'approve', pairingCode: 'ABCDE-FGHJK' }
    }
  ]);
  assert.equal(hooks.reviewedCode(), '');
  assert.equal(nodes['#tabletPairingCode'].value, '');
  assert.equal(nodes['#tabletPairingReview'].hidden, true);
  assert.equal(nodes['#tabletPairingGym'].textContent, '');
  assert.equal(nodes['#tabletPairingOrigin'].textContent, '');
  assert.equal(nodes['#tabletPairingDevice'].textContent, '');
  assert.equal(nodes['#tabletPairingRequested'].textContent, '');
  assert.equal(nodes['#tabletPairingExpires'].textContent, '');
  assert.match(nodes['#tabletPairingMessage'].message, /authorized/u);

  const eventSource = sourceBetween(
    adminHtml,
    "$\('#tabletPairingForm'\).addEventListener('submit'",
    "$\('#tabletDiagnosticButton'\).addEventListener('click'"
  );
  assert.match(eventSource, /tabletPairingCode'\)\.addEventListener\('input'[\s\S]*clearTabletPairingReview\(\)/u);
  assert.match(eventSource, /tabletPairingRejectButton'\)\.addEventListener\('click', rejectTabletPairing\)/u);
  assert.match(eventSource, /tabletPairingCancelButton'\)\.addEventListener\('click'[\s\S]*clearTabletPairingReview\(\{ clearCode: true \}\)/u);
  const sessionSource = sourceBetween(adminHtml, 'function setLoggedOut(', 'async function login(');
  assert.equal(
    (sessionSource.match(/clearTabletPairingReview\(\{ clearCode: true \}\)/gu) || []).length,
    2
  );
});

test('Admin explicitly rejects a reviewed request and invalidates the displayed code', async () => {
  const { context, hooks, nodes } = tabletPairingAdminRuntime();
  await hooks.reviewTabletPairing();
  await hooks.rejectTabletPairing();

  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [
    {
      url: '/api/m1-admin-tablet-pairing',
      body: { operation: 'review', pairingCode: 'ABCDE-FGHJK' }
    },
    {
      url: '/api/m1-admin-tablet-pairing',
      body: { operation: 'reject', pairingCode: 'ABCDE-FGHJK' }
    }
  ]);
  assert.equal(hooks.reviewedCode(), '');
  assert.equal(nodes['#tabletPairingCode'].value, '');
  assert.equal(nodes['#tabletPairingReview'].hidden, true);
  assert.match(nodes['#tabletPairingMessage'].message, /pairing rejected/u);
  assert.match(nodes['#tabletPairingMessage'].message, /can no longer be approved/u);
});

test('Admin pairing rejects changed codes and requires a fresh review after an HTTP approval failure', async () => {
  const changed = tabletPairingAdminRuntime();
  await changed.hooks.reviewTabletPairing();
  changed.nodes['#tabletPairingCode'].value = '01234-56789';
  await changed.hooks.approveTabletPairing();
  assert.equal(changed.context.calls.length, 1);
  assert.equal(changed.hooks.reviewedCode(), '');
  assert.equal(changed.nodes['#tabletPairingReview'].hidden, true);
  assert.match(changed.nodes['#tabletPairingMessage'].message, /code changed/u);

  const reviewFailure = tabletPairingAdminRuntime({ reviewFailure: 'Pairing code expired. Request a new code.' });
  await reviewFailure.hooks.reviewTabletPairing();
  assert.equal(reviewFailure.nodes['#tabletPairingReviewButton'].disabled, false);
  assert.equal(reviewFailure.nodes['#tabletPairingReview'].hidden, true);
  assert.equal(
    reviewFailure.nodes['#tabletPairingMessage'].message,
    'Pairing code expired. Request a new code.'
  );

  const approvalFailure = tabletPairingAdminRuntime({ approveFailure: 'Pairing approval did not complete.' });
  await approvalFailure.hooks.reviewTabletPairing();
  await approvalFailure.hooks.approveTabletPairing();
  assert.equal(approvalFailure.nodes['#tabletPairingApproveButton'].disabled, false);
  assert.equal(approvalFailure.nodes['#tabletPairingReview'].hidden, true);
  assert.equal(approvalFailure.hooks.reviewedCode(), '');
  assert.equal(approvalFailure.nodes['#tabletPairingCode'].value, 'ABCDE-FGHJK');
  assert.equal(approvalFailure.nodes['#tabletPairingApprovalMessage'].message, '');
  assert.match(approvalFailure.nodes['#tabletPairingMessage'].message, /review this pairing code again/iu);
});

test('TEST Admin entry preserves the direct Staff Clock hash and activates only that mode', async () => {
  const loginSource = sourceBetween(adminHtml, 'async function login(', 'async function logout(');
  const modeSource = sourceBetween(adminHtml, 'function requestedManagerMode(', 'function setLoggedOut(');
  const nodes = {
    '#loginMessage': {},
    '#loginAdminName': { value: 'Stuart Turner' },
    '#testLoginButton': { disabled: false },
    '#loginButton': { disabled: false },
    '#loginPassphrase': { value: 'production credential must not be used' },
    '#appPanel': { hidden: true },
    '#sign-ins': {
      hidden: false,
      focus() { this.focused = true; }
    },
    '#staff-time': {
      hidden: true,
      focus() { this.focused = true; },
    },
    '#dailyModeControl': {
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }
    },
    '#staffModeControl': {
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }
    }
  };
  const context = vm.createContext({
    nodes,
    location: { hash: '#staff-time' },
    calls: [],
    events: [],
    window: { requestAnimationFrame(callback) { callback(); } }
  });
  new vm.Script(`
    const API = { login: '/login' };
    const IS_RICHMOND_PRODUCTION = false;
    const ADMIN_MUTATIONS_ENABLED = true;
    const STAFF_CLOCK_ENABLED = true;
    let adminRequestToken = '';
    function $(selector) { return nodes[selector]; }
    function showMessage(target, message) { target.message = message; }
    async function requestJson(url, body) {
      calls.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return { requestToken: 'a'.repeat(32), adminName: body.adminName, test: true };
    }
    function setLoggedIn() {
      nodes['#appPanel'].hidden = false;
      events.push('logged-in');
      applyManagerMode();
    }
    function beginStaffShiftLookupLoading() { events.push('shift-loading'); }
    function defaultYesterday() { return '2026-08-26'; }
    async function loadReview() { events.push('review-loaded'); }
    async function loadStaffTime() { events.push('staff-loaded'); }
    ${modeSource}
    ${loginSource}
    globalThis.hooks = { login };
  `, { filename: 'test-admin-direct-staff-time.js' }).runInContext(context);

  await context.hooks.login(true);
  assert.equal(context.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls[0].body)), {
    adminName: 'Stuart Turner',
    passphrase: '',
    testShortcut: true
  });
  assert.deepEqual(
    Array.from(context.events),
    ['logged-in', 'shift-loading', 'staff-loaded', 'review-loaded']
  );
  assert.equal(nodes['#sign-ins'].hidden, true);
  assert.equal(nodes['#staff-time'].hidden, false);
  assert.equal(nodes['#dailyModeControl'].attributes['aria-selected'], 'false');
  assert.equal(nodes['#staffModeControl'].attributes['aria-selected'], 'true');
  assert.equal(nodes['#staff-time'].focused, true);
  assert.equal(context.location.hash, '#staff-time');
});

test('repeated Arrow, Home, and End navigation keeps focus on the manager mode tabs', () => {
  const modeSource = sourceBetween(adminHtml, 'function requestedManagerMode(', 'function setLoggedOut(');
  const keyboardSource = sourceBetween(
    adminHtml,
    "$('#managerModes').addEventListener('keydown'",
    "$('#previousDay').addEventListener('click'"
  );
  const hashSource = sourceBetween(
    adminHtml,
    "window.addEventListener('hashchange'",
    "window.addEventListener('message'"
  );

  const document = { activeElement: null };
  let managerKeydown = null;
  let hashChange = null;
  const focusable = (href = '') => ({
    hidden: false,
    href,
    attributes: {},
    focus() { document.activeElement = this; },
    getAttribute(name) { return name === 'href' ? this.href : this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = String(value); }
  });
  const nodes = {
    '#appPanel': { hidden: false },
    '#managerModes': {
      addEventListener(type, handler) {
        if (type === 'keydown') managerKeydown = handler;
      },
      contains(element) {
        return element === nodes['#dailyModeControl'] || element === nodes['#staffModeControl'];
      }
    },
    '#dailyModeControl': focusable('#sign-ins'),
    '#staffModeControl': focusable('#staff-time'),
    '#sign-ins': focusable(),
    '#staff-time': focusable()
  };
  const location = { currentHash: '#sign-ins' };
  Object.defineProperty(location, 'hash', {
    get() { return this.currentHash; },
    set(value) {
      this.currentHash = value;
      if (hashChange) hashChange();
    }
  });
  const window = {
    requestAnimationFrame(callback) { callback(); },
    addEventListener(type, handler) {
      if (type === 'hashchange') hashChange = handler;
    }
  };
  const context = vm.createContext({ document, location, nodes, window });
  new vm.Script(`
    const STAFF_CLOCK_ENABLED = true;
    function $(selector) { return nodes[selector]; }
    ${modeSource}
    ${keyboardSource}
    ${hashSource}
    globalThis.hooks = { applyManagerMode };
  `, { filename: 'staff-time-manager-tabs.js' }).runInContext(context);

  assert.ok(managerKeydown);
  assert.ok(hashChange);
  context.hooks.applyManagerMode();
  nodes['#dailyModeControl'].focus();
  const press = key => {
    let prevented = false;
    managerKeydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  };
  press('ArrowRight');
  assert.equal(document.activeElement, nodes['#staffModeControl']);
  press('ArrowLeft');
  assert.equal(document.activeElement, nodes['#dailyModeControl']);
  press('End');
  assert.equal(document.activeElement, nodes['#staffModeControl']);
  press('Home');
  assert.equal(document.activeElement, nodes['#dailyModeControl']);
});

test('#staff-time starts Staff Clock loading without waiting for Daily sign-ins', async () => {
  const loginSource = sourceBetween(adminHtml, 'async function login(', 'async function logout(');
  const context = vm.createContext({ events: [], releaseDaily: null });
  new vm.Script(`
    const API = { login: '/login' };
    const IS_RICHMOND_PRODUCTION = false;
    const ADMIN_MUTATIONS_ENABLED = true;
    const STAFF_CLOCK_ENABLED = true;
    const location = { hash: '#staff-time' };
    let adminRequestToken = '';
    const nodes = {
      '#loginMessage': {},
      '#loginAdminName': { value: 'Stuart Turner' },
      '#testLoginButton': { disabled: false },
      '#loginButton': { disabled: false },
      '#loginPassphrase': { value: 'must-not-be-used' }
    };
    function $(selector) { return nodes[selector]; }
    function showMessage(target, message) { target.message = message; }
    async function requestJson(_url, body) {
      events.push('login');
      return { requestToken: 'a'.repeat(32), adminName: body.adminName, test: true };
    }
    function setLoggedIn() { events.push('logged-in'); }
    function beginStaffShiftLookupLoading() { events.push('staff-loading-state'); }
    function defaultYesterday() { return '2026-08-26'; }
    function requestedManagerMode() { return location.hash === '#staff-time' ? 'staff-time' : 'sign-ins'; }
    function applyManagerMode() { events.push('mode-applied'); }
    function loadReview() {
      events.push('daily-start');
      return new Promise(resolve => { releaseDaily = resolve; });
    }
    async function loadStaffTime() { events.push('staff-start'); }
    ${loginSource}
    globalThis.hooks = { login, release: () => releaseDaily() };
  `, { filename: 'staff-time-direct-load-priority.js' }).runInContext(context);

  const loginPromise = context.hooks.login(true);
  await new Promise(resolve => setImmediate(resolve));
  const staffStartedBeforeDailyFinished = context.events.includes('staff-start');
  context.hooks.release();
  await loginPromise;
  assert.equal(staffStartedBeforeDailyFinished, true);
  assert.ok(context.events.indexOf('staff-start') > context.events.indexOf('staff-loading-state'));
});

test('a fresh Admin entry resets stale page scroll before review begins', () => {
  const sessionSource = sourceBetween(adminHtml, 'function setLoggedIn(', 'async function login(');
  assert.match(sessionSource, /const firstEntry = \$\('#appPanel'\)\.hidden/u);
  assert.match(
    sessionSource,
    /if \(firstEntry\) \{[\s\S]*window\.requestAnimationFrame\([\s\S]*window\.scrollTo\(0, 0\)/u
  );
});

test('review validation requires every canonical Staff time field and rejects drift', () => {
  const {
    validStaffTimeReviewStartResponse,
    validStaffTimeReviewPageResponse,
    validStaffTimeShiftLookupResponse,
    validStaffTimeReviewResponse
  } = validatorRuntime();
  const start = reviewStartResponse();
  assert.equal(validStaffTimeReviewStartResponse(start), true);
  const alternateClockedIn = structuredClone(start);
  alternateClockedIn.clockedInNow = [{
    punchId: PUNCH_TWO,
    staffId: 'front-desk-test-three',
    staffName: 'Front Desk Test Three',
    clockInAt: '2026-08-18T09:00:00-04:00'
  }];
  assert.equal(validStaffTimeReviewStartResponse(alternateClockedIn), true);
  const unknownClockedInStaff = structuredClone(start);
  unknownClockedInStaff.clockedInNow[0].staffId = 'unknown-test-staff';
  unknownClockedInStaff.clockedInNow[0].staffName = 'Unknown Test Staff';
  assert.equal(validStaffTimeReviewStartResponse(unknownClockedInStaff), false);
  const mismatchedClockedInName = structuredClone(start);
  mismatchedClockedInName.clockedInNow[0].staffName = 'Front Desk Test Three';
  assert.equal(validStaffTimeReviewStartResponse(mismatchedClockedInName), false);
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

  const recentShift = completedHistoryShift(880, {
    clockIn: {
      ...completedHistoryShift(880).clockIn,
      timestamp: '2026-08-12T09:00:00-04:00',
      date: '2026-08-12'
    },
    clockOut: {
      ...completedHistoryShift(880).clockOut,
      timestamp: '2026-08-12T17:00:00-04:00',
      date: '2026-08-12'
    }
  });
  const recentLookup = shiftLookup({ total: 1, items: [recentShift] });
  const expectedRecentLookup = {
    viewToken: VIEW_TOKEN,
    mode: 'recent',
    today: '2026-08-18',
    staffId: '',
    date: ''
  };
  assert.equal(validStaffTimeShiftLookupResponse(recentLookup, expectedRecentLookup), true);
  assert.equal(validStaffTimeShiftLookupResponse({ ...recentLookup, extra: true }, expectedRecentLookup), false);
  assert.equal(validStaffTimeShiftLookupResponse({ ...recentLookup, truncated: true }, expectedRecentLookup), false);
  assert.equal(validStaffTimeShiftLookupResponse({
    ...recentLookup,
    total: 1,
    items: [],
    truncated: true
  }, expectedRecentLookup), false);
  assert.equal(validStaffTimeShiftLookupResponse({ ...recentLookup, dateFrom: '2026-08-11' }, expectedRecentLookup), false);

  const exactLookup = shiftLookup({
    mode: 'exactDate',
    dateFrom: '2026-08-11',
    dateThrough: '2026-08-11',
    staffId: 'mandy-test',
    date: '2026-08-11',
    total: 1,
    items: [completedHistoryShift(890)]
  });
  const expectedExactLookup = {
    viewToken: VIEW_TOKEN,
    mode: 'exactDate',
    today: '2026-08-18',
    staffId: 'mandy-test',
    date: '2026-08-11'
  };
  assert.equal(validStaffTimeShiftLookupResponse(exactLookup, expectedExactLookup), true);
  assert.equal(validStaffTimeShiftLookupResponse({ ...exactLookup, staffId: 'andrew-test' }, expectedExactLookup), false);
  assert.equal(validStaffTimeShiftLookupResponse({ ...exactLookup, date: '2026-08-10' }, expectedExactLookup), false);

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
      ['attention', 0],
      ['attention', 137],
      ['attention', 274],
      ['attention', 411],
      ['attention', 548],
      ['records', 0],
      ['attention', 0],
      ['attention', 137],
      ['attention', 274],
      ['attention', 411],
      ['attention', 548],
      ['records', 0],
      ['records', 137],
      ['records', 274],
      ['records', 411],
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
  assert.deepEqual(
    calls.filter(call => call.operation === 'shiftLookup'),
    [
      { operation: 'shiftLookup', viewToken: VIEW_TOKEN, mode: 'recent' },
      { operation: 'shiftLookup', viewToken: VIEW_TOKEN, mode: 'recent' }
    ]
  );
  assert.ok(
    calls.findIndex(call => call.operation === 'reviewPage' && call.stream === 'attention')
      < calls.findIndex(call => call.operation === 'shiftLookup'),
    'Needs attention must load before recent completed shifts'
  );
  assert.ok(
    calls.findIndex(call => call.operation === 'shiftLookup')
      < calls.findIndex(call => call.operation === 'reviewPage' && call.stream === 'records'),
    'recent completed shifts must load before Advanced records and audit'
  );

  const nodes = renderStaffTimeRuntime(data);
  assert.equal(nodes['#staffTimeSummary'].textContent, '600 need attention · 1 clocked in');
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
  assert.deepEqual(
    calls.filter(call => call.operation === 'shiftLookup'),
    [
      { operation: 'shiftLookup', viewToken: VIEW_TOKEN, mode: 'recent' },
      { operation: 'shiftLookup', viewToken: VIEW_TOKEN, mode: 'recent' }
    ]
  );
});

test('recent completed shifts have explicit loading, success, failure, and retry states with no pagination', async () => {
  const loadingNodes = renderStaffTimeRuntime(reviewResponse(), {
    recentLookup: null,
    recentLoading: true
  });
  assert.match(elementText(loadingNodes['#staffRecentShifts']), /Loading recent completed shifts/u);
  assert.equal(loadingNodes['#staffRecentShifts'].attributes['aria-busy'], 'true');
  assert.equal(loadingNodes['#staffRecentShiftsRetry'].hidden, true);
  assert.match(loadingNodes['#staffRecentShiftsMessage'].textContent, /last seven New York calendar days/u);

  const recentShift = completedHistoryShift(980, {
    clockIn: {
      ...completedHistoryShift(980).clockIn,
      timestamp: '2026-08-12T09:00:00-04:00',
      date: '2026-08-12',
      staffName: 'Front Desk Test Three'
    },
    clockOut: {
      ...completedHistoryShift(980).clockOut,
      timestamp: '2026-08-12T17:00:00-04:00',
      date: '2026-08-12',
      staffName: 'Front Desk Test Three'
    }
  });
  const recent = shiftLookup({ total: 1, items: [recentShift] });
  const review = reviewResponse();
  const { data, calls, lookupState } = await runPagination(
    reviewStartResponse(),
    {
      records: review.records,
      attention: review.needsAttention,
      audit: review.audit
    },
    { recentLookup: recent }
  );
  assert.deepEqual(
    calls.filter(call => call.operation === 'shiftLookup'),
    [{ operation: 'shiftLookup', viewToken: VIEW_TOKEN, mode: 'recent' }]
  );
  assert.equal(lookupState.lookup.items.length, 1);
  const successNodes = renderStaffTimeRuntime(data, { recentLookup: recent });
  assert.match(elementText(successNodes['#staffRecentShifts']), /Front Desk Test Three/u);
  assert.equal(successNodes['#staffRecentShifts'].children.length, 1);
  assert.match(successNodes['#staffRecentShiftsMessage'].textContent, /2026-08-12 through 2026-08-18/u);

  const tenRecentShifts = Array.from({ length: 10 }, (_, index) => completedHistoryShift(1000 + index * 2));
  const cappedLookup = shiftLookup({ total: 10, items: tenRecentShifts });
  const cappedNodes = renderStaffTimeRuntime(data, { recentLookup: cappedLookup });
  assert.equal(cappedNodes['#staffRecentShifts'].children.length, 8);
  assert.equal(cappedNodes['#staffRecentShowMore'].hidden, false);
  assert.match(cappedNodes['#staffRecentShiftsMessage'].textContent, /Showing newest 8 of 10/u);
  assert.match(elementText(cappedNodes['#staffRecentShifts'].children[0]), /Duration 8 hr 0 min/u);
  const expandedNodes = renderStaffTimeRuntime(data, {
    recentLookup: cappedLookup,
    recentVisibleLimit: 16
  });
  assert.equal(expandedNodes['#staffRecentShifts'].children.length, 10);
  assert.equal(expandedNodes['#staffRecentShowMore'].hidden, true);

  const failure = await runPagination(
    reviewStartResponse(),
    {
      records: review.records,
      attention: review.needsAttention,
      audit: review.audit
    },
    { shiftLookupFailure: true }
  );
  assert.equal(failure.data.records.length, review.records.length);
  assert.equal(failure.lookupState.lookup, null);
  assert.match(failure.lookupState.error, /matching receiver unavailable/u);
  const failureNodes = renderStaffTimeRuntime(failure.data, {
    recentLookup: null,
    recentError: failure.lookupState.error
  });
  assert.match(elementText(failureNodes['#staffRecentShifts']), /matching receiver unavailable/u);
  assert.equal(failureNodes['#staffRecentShiftsRetry'].hidden, false);
  assert.match(failureNodes['#staffRecentShiftsMessage'].textContent, /did not load.*Retry below/u);

  const beginSource = sourceBetween(
    adminHtml,
    'function beginStaffShiftLookupLoading()',
    'function renderStaffRecentShifts()'
  );
  const renderSource = sourceBetween(
    adminHtml,
    'function renderStaffRecentShifts()',
    'function renderStaffTime(data)'
  );
  const retrySource = sourceBetween(
    adminHtml,
    'async function retryStaffRecentShifts()',
    'function readStaffOlderShiftQuery('
  );
  assert.match(beginSource, /staffRecentLoading = true[\s\S]*renderStaffRecentShifts\(\)/u);
  assert.match(renderSource, /aria-busy[\s\S]*Loading recent completed shifts/u);
  assert.match(renderSource, /Recent completed shifts did not load\. Retry below/u);
  assert.match(renderSource, /lookup\.items\.slice\(0, staffRecentVisibleLimit\)/u);
  assert.match(retrySource, /fetchStaffTimeShiftLookup\([\s\S]*mode: 'recent'/u);
  assert.match(retrySource, /staffRecentVisibleLimit = Math\.min\([\s\S]*STAFF_RECENT_MAX_VISIBLE[\s\S]*STAFF_RECENT_INCREMENT/u);
  assert.doesNotMatch(adminHtml, /operation: 'historyPage'|Load older completed shifts/u);
});

test('Needs attention allows only one exact clocked-in match before Advanced validation', async () => {
  const data = reviewResponse();
  const frontDeskClockOut = {
    ...staffRecord(818),
    punchId: PUNCH_TWO,
    staffId: 'front-desk-test-three',
    staffName: 'Front Desk Test Three',
    punchAction: 'clockOut',
    timestamp: '2026-08-18T17:00:00-04:00',
    date: '2026-08-18'
  };
  data.records = [data.records[0], frontDeskClockOut];
  data.needsAttention = [
    {
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      code: 'missing_clock_out',
      message: 'Mandy Test is missing a clock-out.',
      linkedPunchIds: [PUNCH_ONE],
      occurrenceCount: 1
    },
    {
      staffId: 'front-desk-test-three',
      staffName: 'Front Desk Test Three',
      code: 'clock_out_without_clock_in',
      message: 'Front Desk Test Three has a clock-out without a matching clock-in.',
      linkedPunchIds: [PUNCH_TWO],
      occurrenceCount: 1
    },
    {
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      code: 'shift_too_long',
      message: 'Mandy Test has a shift that needs review.',
      linkedPunchIds: [PUNCH_ONE, PUNCH_TWO],
      occurrenceCount: 1
    }
  ];
  const attentionActions = nodes => nodes['#staffNeedsAttention'].children.map(row => row.children.find(
    child => child.className === 'btn ghost small staff-attention-action'
  ));
  const assertReviewOnly = action => {
    assert.ok(action);
    assert.equal(action.textContent, 'Review records');
    assert.equal(action.dataset.staffAttentionAdvanced, 'true');
    assert.equal(Object.hasOwn(action.dataset, 'staffCorrectionStaff'), false);
    assert.equal(Object.hasOwn(action.dataset, 'staffCorrectionAction'), false);
  };
  const assertResolveOnly = (action, label, staffId, code) => {
    assert.ok(action);
    assert.equal(action.textContent, label);
    assert.equal(action.dataset.staffAttentionResolve, 'true');
    assert.equal(action.dataset.staffAttentionStaff, staffId);
    assert.equal(action.dataset.staffAttentionCode, code);
    assert.equal(Object.hasOwn(action.dataset, 'staffCorrectionStaff'), false);
    assert.equal(Object.hasOwn(action.dataset, 'staffCorrectionAction'), false);
  };
  const assertDirectCorrection = (action, staffId, punchAction) => {
    assert.ok(action);
    assert.equal(action.textContent, `Add missed ${punchAction === 'clockOut' ? 'Clock Out' : 'Clock In'}`);
    assert.equal(action.dataset.staffCorrectionStaff, staffId);
    assert.equal(action.dataset.staffCorrectionAction, punchAction);
    assert.equal(Object.hasOwn(action.dataset, 'staffAttentionResolve'), false);
    assert.equal(Object.hasOwn(action.dataset, 'staffAttentionAdvanced'), false);
  };

  const primaryShell = {
    ...data,
    records: [],
    todayPunches: [],
    audit: []
  };
  const primaryNodes = renderStaffTimeRuntime(primaryShell, {
    advancedLoaded: false,
    renderAdvancedStateOnly: true
  });
  assert.equal(primaryNodes['#staffNeedsAttentionSection'].hidden, false);
  assert.equal(primaryNodes['#staffNeedsAttention'].children.length, 3);
  const primaryActions = attentionActions(primaryNodes);
  assertDirectCorrection(primaryActions[0], 'mandy-test', 'clockOut');
  assertResolveOnly(
    primaryActions[1],
    'Review records',
    'front-desk-test-three',
    'clock_out_without_clock_in'
  );
  assertReviewOnly(primaryActions[2]);

  const validatedNodes = renderStaffTimeRuntime(data, { advancedLoaded: true });
  const validatedActions = attentionActions(validatedNodes);
  assert.ok(validatedActions.every(Boolean));
  assertDirectCorrection(validatedActions[0], 'mandy-test', 'clockOut');
  assertResolveOnly(
    validatedActions[1],
    'Review records',
    'front-desk-test-three',
    'clock_out_without_clock_in'
  );
  assertReviewOnly(validatedActions[2]);

  const invalidData = {
    ...data,
    needsAttention: [
      {
        staffId: 'mandy-test',
        staffName: 'Mandy Test',
        code: 'missing_clock_out',
        message: 'Linked punch is missing.',
        linkedPunchIds: [],
        occurrenceCount: 1
      },
      {
        staffId: 'mandy-test',
        staffName: 'Mandy Test',
        code: 'missing_clock_out',
        message: 'Linked punch is unknown.',
        linkedPunchIds: [staffRecord(819).punchId],
        occurrenceCount: 1
      },
      {
        staffId: 'mandy-test',
        staffName: 'Mandy Test',
        code: 'missing_clock_out',
        message: 'More than one punch is linked.',
        linkedPunchIds: [PUNCH_ONE, PUNCH_TWO],
        occurrenceCount: 1
      },
      {
        staffId: 'front-desk-test-three',
        staffName: 'Front Desk Test Three',
        code: 'missing_clock_out',
        message: 'The linked clock-in belongs to another staff member.',
        linkedPunchIds: [PUNCH_ONE],
        occurrenceCount: 1
      },
      {
        staffId: 'mandy-test',
        staffName: 'Mandy Test Mismatch',
        code: 'missing_clock_out',
        message: 'The linked clock-in has a mismatched staff name.',
        linkedPunchIds: [PUNCH_ONE],
        occurrenceCount: 1
      },
      {
        staffId: 'mandy-test',
        staffName: 'Mandy Test',
        code: 'missing_clock_out',
        message: 'More than one attention occurrence is grouped here.',
        linkedPunchIds: [PUNCH_ONE],
        occurrenceCount: 2
      },
      {
        staffId: 'mandy-test',
        staffName: 'Mandy Test',
        code: 'shift_too_long',
        message: 'Another attention code is not directly correctable.',
        linkedPunchIds: [PUNCH_ONE],
        occurrenceCount: 1
      },
      {
        staffId: 'mandy-test',
        staffName: 'Mandy Test',
        code: 'missing_clock_out',
        message: 'Linked punch belongs to another staff member.',
        linkedPunchIds: [PUNCH_TWO],
        occurrenceCount: 1
      }
    ]
  };
  const invalidNodes = renderStaffTimeRuntime(invalidData, { advancedLoaded: true });
  const invalidActions = attentionActions(invalidNodes);
  invalidActions.slice(0, 6).forEach((action, index) => {
    const item = invalidData.needsAttention[index];
    assertResolveOnly(action, 'Review records', item.staffId, item.code);
  });
  assertReviewOnly(invalidActions[6]);
  assertResolveOnly(invalidActions[7], 'Review records', 'mandy-test', 'missing_clock_out');

  const resolutionSource = sourceBetween(
    adminHtml,
    'function validatedStaffAttentionAction(',
    'function renderStaffTimeAdvanced('
  );
  const resolveFixture = async (item, records, advancedResult = true) => {
    const calls = { loads: 0, opened: [], advancedOpened: 0 };
    const nodes = {
      '#staffTimeMessage': {},
      '#staffTimeAdvanced': {
        open: false,
        querySelector() { return { focus() {} }; },
        scrollIntoView() { calls.advancedOpened += 1; }
      }
    };
    const action = {
      textContent: 'Review linked punch',
      disabled: false,
      isConnected: true,
      dataset: {
        staffAttentionStaff: item.staffId,
        staffAttentionCode: item.code
      }
    };
    const context = vm.createContext({
      action,
      advancedResult,
      calls,
      item: structuredClone(item),
      nodes,
      records: structuredClone(records)
    });
    new vm.Script(`
      const STAFF_ATTENTION_ACTIONS = Object.freeze({
        missing_clock_out: Object.freeze({ punchAction: 'clockOut', linkedPunchAction: 'clockIn' }),
        clock_out_without_clock_in: Object.freeze({ punchAction: 'clockIn', linkedPunchAction: 'clockOut' })
      });
      let staffAdvancedLoaded = false;
      let currentStaffTime = { needsAttention: [item], records };
      function $(selector) { return nodes[selector]; }
      function showMessage() {}
      async function loadStaffTimeAdvanced() {
        calls.loads += 1;
        if (advancedResult) staffAdvancedLoaded = true;
        return advancedResult;
      }
      function openStaffCorrectionPanel(value) { calls.opened.push(value); }
      ${resolutionSource}
      globalThis.hooks = { resolveStaffAttentionAction };
    `, { filename: 'staff-attention-exact-link.js' }).runInContext(context);
    await context.hooks.resolveStaffAttentionAction(action);
    return calls;
  };

  const validOrphanOut = await resolveFixture(data.needsAttention[1], data.records);
  assert.deepEqual(JSON.parse(JSON.stringify(validOrphanOut.opened)), [{
    staffId: 'front-desk-test-three',
    punchAction: 'clockIn'
  }]);

  for (const invalidItem of [
    invalidData.needsAttention[0],
    invalidData.needsAttention[1],
    invalidData.needsAttention[2],
    invalidData.needsAttention[3],
    invalidData.needsAttention[4],
    invalidData.needsAttention[7]
  ]) {
    const invalidResolution = await resolveFixture(invalidItem, invalidData.records);
    assert.equal(invalidResolution.loads, 1);
    assert.deepEqual(invalidResolution.opened, []);
    assert.equal(invalidResolution.advancedOpened, 1);
  }

  const formMarkup = sourceBetween(
    adminHtml,
    '<section id="staffCorrectionPanel"',
    '</section>\n\n          <section class="staff-time-block"'
  );
  assert.match(formMarkup, /\bhidden\b/u);
  assert.match(formMarkup, /id="staffCorrectionCancel"/u);
  const actionSource = sourceBetween(
    adminHtml,
    "$('#staffNeedsAttention').addEventListener('click'",
    "$('#staffCorrectionForm').addEventListener('input'"
  );
  assert.match(actionSource, /data-staff-attention-resolve/u);
  assert.match(actionSource, /resolveStaffAttentionAction/u);
  assert.match(actionSource, /data-staff-correction-staff/u);

  const directCalls = { advanced: 0, opened: [], resolved: 0 };
  let attentionClick = null;
  const directAction = {
    dataset: {
      staffCorrectionStaff: 'mandy-test',
      staffCorrectionAction: 'clockOut'
    }
  };
  const directContext = vm.createContext({ directAction, directCalls });
  new vm.Script(`
    const list = {
      addEventListener(type, handler) {
        if (type === 'click') globalThis.attentionClick = handler;
      }
    };
    function $(selector) { return selector === '#staffNeedsAttention' ? list : null; }
    function showStaffAdvancedTask() { directCalls.advanced += 1; }
    function openStaffCorrectionPanel(value) { directCalls.opened.push(value); }
    async function resolveStaffAttentionAction() { directCalls.resolved += 1; }
    ${actionSource}
  `, { filename: 'staff-attention-direct-clock-out.js' }).runInContext(directContext);
  attentionClick = directContext.attentionClick;
  assert.ok(attentionClick);
  attentionClick({
    target: {
      closest(selector) {
        return selector === '[data-staff-correction-staff]' ? directAction : null;
      }
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(directCalls.opened)), [{
    staffId: 'mandy-test',
    punchAction: 'clockOut'
  }]);
  assert.equal(directCalls.advanced, 0);
  assert.equal(directCalls.resolved, 0);
});

test('attention correction and Advanced actions scroll their opened target into view', () => {
  const openCorrectionSource = sourceBetween(
    adminHtml,
    'function openStaffCorrectionPanel(',
    'function closeStaffCorrectionPanel('
  );
  assert.match(
    openCorrectionSource,
    /panel\.hidden = false[\s\S]*panel\.scrollIntoView\(/u
  );

  const attentionSource = sourceBetween(
    adminHtml,
    "$('#staffNeedsAttention').addEventListener('click'",
    "$('#staffCorrectionForm').addEventListener('input'"
  );
  assert.match(attentionSource, /showStaffAdvancedTask\(\)/u);
  const advancedTaskSource = sourceBetween(
    adminHtml,
    'function showStaffAdvancedTask(',
    'async function resolveStaffAttentionAction('
  );
  assert.match(advancedTaskSource, /\.open = true[\s\S]*\.focus\([\s\S]*\.scrollIntoView\(/u);
});

test('older shift finder is collapsed and handles exact staff-date success, no-results, error, and retry', () => {
  const finderMarkup = sourceBetween(
    adminHtml,
    '<details id="staffOlderShiftFinder"',
    '<details id="staffTimeAdvanced"'
  );
  assert.match(finderMarkup, /<summary>Find an older shift<\/summary>/u);
  assert.doesNotMatch(finderMarkup.match(/<details[^>]*>/u)?.[0] || '', /\bopen\b/u);
  assert.match(finderMarkup, /id="staffOlderShiftStaff" name="staffId" required/u);
  assert.match(finderMarkup, /id="staffOlderShiftDate" name="date" type="date" required/u);
  assert.match(finderMarkup, /id="staffOlderShiftRetry"[^>]*hidden/u);

  const query = { mode: 'exactDate', staffId: 'mandy-test', date: '2026-07-01' };
  const loadingNodes = renderStaffTimeRuntime(reviewResponse(), {
    olderQuery: query,
    olderLoading: true
  });
  assert.match(elementText(loadingNodes['#staffOlderShiftResults']), /Loading the selected staff member and exact date/u);
  assert.equal(loadingNodes['#staffOlderShiftResults'].attributes['aria-busy'], 'true');
  assert.equal(loadingNodes['#staffOlderShiftSubmit'].disabled, true);
  assert.match(loadingNodes['#staffOlderShiftMessage'].textContent, /Finding the older completed shift/u);

  const olderShift = completedHistoryShift(985, {
    clockIn: {
      ...completedHistoryShift(985).clockIn,
      timestamp: '2026-07-01T09:00:00-04:00',
      date: '2026-07-01'
    },
    clockOut: {
      ...completedHistoryShift(985).clockOut,
      timestamp: '2026-07-01T17:00:00-04:00',
      date: '2026-07-01'
    }
  });
  const exactLookup = shiftLookup({
    mode: 'exactDate',
    dateFrom: query.date,
    dateThrough: query.date,
    staffId: query.staffId,
    date: query.date,
    total: 1,
    items: [olderShift]
  });
  const successNodes = renderStaffTimeRuntime(reviewResponse(), {
    olderLookup: exactLookup,
    olderQuery: query
  });
  assert.match(elementText(successNodes['#staffOlderShiftResults']), /Jul 1/u);
  assert.match(successNodes['#staffOlderShiftMessage'].textContent, /Found 1 completed shift/u);

  const emptyLookup = shiftLookup({
    mode: 'exactDate',
    dateFrom: query.date,
    dateThrough: query.date,
    staffId: query.staffId,
    date: query.date
  });
  const emptyNodes = renderStaffTimeRuntime(reviewResponse(), {
    olderLookup: emptyLookup,
    olderQuery: query
  });
  assert.match(elementText(emptyNodes['#staffOlderShiftResults']), /No completed shifts found/u);

  const errorNodes = renderStaffTimeRuntime(reviewResponse(), {
    olderQuery: query,
    olderError: 'The older shift could not be loaded. Lookup timed out.'
  });
  assert.match(elementText(errorNodes['#staffOlderShiftResults']), /Lookup timed out/u);
  assert.equal(errorNodes['#staffOlderShiftRetry'].hidden, false);
  assert.match(errorNodes['#staffOlderShiftMessage'].textContent, /same staff member and exact date/u);

  const fetchSource = sourceBetween(
    adminHtml,
    'async function fetchStaffTimeShiftLookup(',
    'function assembleStaffTimeReview('
  );
  assert.match(fetchSource, /operation: 'shiftLookup'[\s\S]*mode: 'exactDate'[\s\S]*staffId: expected\.staffId[\s\S]*date: expected\.date/u);
  const searchSource = sourceBetween(
    adminHtml,
    'function readStaffOlderShiftQuery(',
    'async function submitStaffCorrection('
  );
  assert.match(searchSource, /date > shiftDate\(currentStaffTime\.view\.today, -7\)/u);
  assert.match(searchSource, /currentStaffOlderShiftQuery = query/u);
  assert.match(searchSource, /staffOlderShiftLoadGeneration/u);
  assert.match(searchSource, /retryStaffOlderShiftLookup[\s\S]*currentStaffOlderShiftQuery/u);
  assert.match(
    searchSource,
    /validStaffTimeStaleError\(error\)[\s\S]*await loadStaffTime\(\{ quiet: true \}\)[\s\S]*currentStaffOlderShiftQuery = query[\s\S]*Staff time changed while searching\. Retry the same staff member and date\.[\s\S]*renderStaffOlderShiftLookup\(\)/u
  );
});

test('recent and older workflows stay usable while Advanced loads or fails explicitly', () => {
  const recentShift = completedHistoryShift(986, {
    clockIn: {
      ...completedHistoryShift(986).clockIn,
      timestamp: '2026-08-18T09:00:00-04:00',
      date: '2026-08-18'
    },
    clockOut: {
      ...completedHistoryShift(986).clockOut,
      timestamp: '2026-08-18T17:00:00-04:00',
      date: '2026-08-18'
    }
  });
  const recent = shiftLookup({ total: 1, items: [recentShift] });
  const loadingNodes = renderStaffTimeRuntime(reviewResponse(), {
    recentLookup: recent,
    advancedLoading: true,
    advancedLoaded: false,
    renderAdvancedStateOnly: true
  });
  assert.match(elementText(loadingNodes['#staffRecentShifts']), /Duration 8 hr 0 min/u);
  assert.match(elementText(loadingNodes['#staffTimeRecords']), /Loading individual punch records/u);
  assert.match(elementText(loadingNodes['#staffTimeAudit']), /Loading the correction audit/u);
  assert.equal(loadingNodes['#staffTimeAdvancedRetry'].hidden, true);
  assert.equal(loadingNodes['#staffNeedsAttentionSection'].hidden, false);
  assert.match(elementText(loadingNodes['#staffNeedsAttention']), /No Staff Clock issues need attention/u);

  const errorNodes = renderStaffTimeRuntime(reviewResponse(), {
    recentLookup: recent,
    advancedLoaded: false,
    advancedError: 'Advanced records and audit could not be loaded. Lookup timed out.',
    renderAdvancedStateOnly: true
  });
  assert.match(elementText(errorNodes['#staffRecentShifts']), /Duration 8 hr 0 min/u);
  assert.match(elementText(errorNodes['#staffTimeRecords']), /Lookup timed out/u);
  assert.equal(errorNodes['#staffTimeAdvancedRetry'].hidden, false);
  assert.match(errorNodes['#staffTimeAdvancedMessage'].textContent, /did not load.*Retry below/u);
  assert.equal(errorNodes['#staffNeedsAttentionSection'].hidden, false);

  const primaryLoad = sourceBetween(
    adminHtml,
    'async function loadStaffTimeReviewOnce(',
    'async function loadStaffTimeAdvancedReview('
  );
  const advancedLoad = sourceBetween(
    adminHtml,
    'async function loadStaffTimeAdvancedReview(',
    'function validStaffTimeStaleError('
  );
  assert.match(
    primaryLoad,
    /fetchStaffTimeReviewStream\([\s\S]*'attention'[\s\S]*fetchStaffTimeShiftLookup/u
  );
  assert.match(advancedLoad, /'records'[\s\S]*'audit'/u);
  assert.doesNotMatch(advancedLoad, /'attention'/u);
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

test('recent completed shifts render one row per pair while Advanced keeps the raw records', () => {
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

  const recent = shiftLookup({
    total: 2,
    items: [
      completedHistoryShift(950, {
        clockIn: {
          ...completedHistoryShift(950).clockIn,
          timestamp: '2026-08-18T09:00:00-04:00',
          date: '2026-08-18'
        },
        clockOut: {
          ...completedHistoryShift(950).clockOut,
          timestamp: '2026-08-18T17:00:00-04:00',
          date: '2026-08-18'
        }
      }),
      completedHistoryShift(960, {
        clockIn: {
          ...completedHistoryShift(960).clockIn,
          timestamp: '2026-08-12T09:00:00-04:00',
          date: '2026-08-12'
        },
        clockOut: {
          ...completedHistoryShift(960).clockOut,
          timestamp: '2026-08-12T17:00:00-04:00',
          date: '2026-08-12'
        }
      })
    ]
  });
  const nodes = renderStaffTimeRuntime(data, { recentLookup: recent });
  assert.equal(nodes['#staffRecentShifts'].children.length, 2);
  assert.match(elementText(nodes['#staffRecentShifts'].children[0]), /Aug 18/u);
  assert.match(elementText(nodes['#staffRecentShifts'].children[1]), /Aug 12/u);
  assert.equal(nodes['#staffTimeRecords'].children.length, 4);
  assert.match(elementText(nodes['#staffTimeRecords']), /Aug 11/u);
  assert.match(elementText(nodes['#staffTimeRecords']), /Aug 19/u);
  assert.match(nodes['#staffRecentShiftsMessage'].textContent, /Showing newest 2 of 2 completed shifts/u);
  assert.equal(data.records.length, 4);
  assert.doesNotMatch(adminHtml, /operation: 'historyPage'|Load older completed shifts/u);
});

test('one recent lookup accepts and renders a legitimate mixed re-pair without attaching the former audit', async () => {
  const { validStaffCompletedShift, validStaffTimeShiftLookupResponse } = validatorRuntime();
  const baseShift = completedHistoryShift(970);
  const mixedShift = {
    ...baseShift,
    clockIn: {
      ...baseShift.clockIn,
      timestamp: '2026-08-12T08:55:00-04:00',
      date: '2026-08-12',
      originalTimestamp: baseShift.clockIn.timestamp,
      originalDate: baseShift.clockIn.date,
      adjustmentRequestId: REQUEST_ONE
    },
    clockOut: {
      ...baseShift.clockOut,
      timestamp: '2026-08-12T17:00:00-04:00',
      date: '2026-08-12',
      device: 'Admin Staff Time',
      note: 'Missed clock-out',
      source: 'Admin-added',
      adminName: 'Andrew Smith'
    },
    latestAdjustment: null
  };
  assert.equal(validStaffCompletedShift(mixedShift), true);

  const sharedWithoutAudit = structuredClone(mixedShift);
  sharedWithoutAudit.clockOut.originalTimestamp = sharedWithoutAudit.clockOut.timestamp;
  sharedWithoutAudit.clockOut.originalDate = sharedWithoutAudit.clockOut.date;
  sharedWithoutAudit.clockOut.adjustmentRequestId = REQUEST_ONE;
  assert.equal(validStaffCompletedShift(sharedWithoutAudit), false);

  const adjusted = adjustedReviewResponse();
  const completeAdjustedShift = {
    clockIn: adjusted.records[0],
    clockOut: adjusted.records[1],
    latestAdjustment: adjusted.audit[0]
  };
  assert.equal(validStaffCompletedShift(completeAdjustedShift), true);
  assert.equal(validStaffCompletedShift({
    ...completeAdjustedShift,
    latestAdjustment: {
      ...completeAdjustedShift.latestAdjustment,
      correctedClockOutAt: '2026-08-18T17:31:00-04:00'
    }
  }), false);

  const lookup = shiftLookup({
    total: 1,
    items: [mixedShift]
  });
  assert.equal(validStaffTimeShiftLookupResponse(lookup, {
    viewToken: VIEW_TOKEN,
    mode: 'recent',
    today: '2026-08-18',
    staffId: '',
    date: ''
  }), true);

  const initialReview = reviewResponse();
  const { calls } = await runPagination(
    reviewStartResponse(),
    {
      records: initialReview.records,
      attention: initialReview.needsAttention,
      audit: initialReview.audit
    },
    { recentLookup: lookup }
  );
  assert.deepEqual(
    calls.filter(call => call.operation === 'shiftLookup'),
    [{ operation: 'shiftLookup', viewToken: VIEW_TOKEN, mode: 'recent' }]
  );

  const renderData = reviewResponse();
  renderData.records = [];
  const nodes = renderStaffTimeRuntime(renderData, { recentLookup: lookup });
  assert.equal(countElements(
    nodes['#staffRecentShifts'],
    element => element.className === 'staff-adjustment-form'
  ), 1);
  const historyText = elementText(nodes['#staffRecentShifts']);
  assert.match(historyText, /Adjust punch/u);
  assert.match(historyText, /Clock-in · Tablet/u);
  assert.match(historyText, /Clock-out · Admin-added/u);
  assert.match(historyText, /Existing punch correction/u);
  assert.match(historyText, /Clock-in retains an earlier correction/u);
  assert.doesNotMatch(historyText, /Latest audit:/u);
});

test('completed shifts render one clear adjustment form plus original and corrected audit evidence', () => {
  const data = adjustedReviewResponse();
  const historyShift = {
    clockIn: data.records[0],
    clockOut: data.records[1],
    latestAdjustment: data.audit[0]
  };
  data.records = [];
  const nodes = renderStaffTimeRuntime(data, {
    recentLookup: shiftLookup({
      total: 1,
      items: [historyShift]
    })
  });
  assert.equal(countElements(
    nodes['#staffRecentShifts'],
    element => element.className === 'staff-adjustment-form'
  ), 1);
  const recordText = elementText(nodes['#staffRecentShifts']);
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
  assert.match(readAdjustmentSource, /currentStaffRecentLookup\?\.items/u);
  assert.match(readAdjustmentSource, /currentStaffOlderShiftLookup\?\.items/u);
  assert.match(readAdjustmentSource, /lookupShift \|\| \(currentStaffTime/u);
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
    "['#staffRecentShifts', '#staffOlderShiftResults', '#staffTimeRecords'].forEach(selector => {",
    "$('#reviewSection').addEventListener('click'"
  );
  assert.match(adjustmentEvents, /\$\(selector\)\.addEventListener\('click'/u);
  assert.match(adjustmentEvents, /\$\(selector\)\.addEventListener\('input'/u);
  assert.match(adjustmentEvents, /\$\(selector\)\.addEventListener\('submit'/u);
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
    'async function loadStaffTime('
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

test('deep links select one manager mode and the default remains Daily sign-ins', () => {
  const modeSource = sourceBetween(adminHtml, 'function requestedManagerMode(', 'function setLoggedOut(');
  assert.match(modeSource, /STAFF_CLOCK_ENABLED && location\.hash === '#staff-time'[\s\S]*\? 'staff-time'[\s\S]*: 'sign-ins'/u);
  assert.match(modeSource, /daily\.hidden = staffActive/u);
  assert.match(modeSource, /staff\.hidden = !staffActive \|\| !STAFF_CLOCK_ENABLED/u);
  assert.match(modeSource, /dailyControl\.setAttribute\('aria-selected', staffActive \? 'false' : 'true'\)/u);
  assert.match(modeSource, /staffControl\.setAttribute\('aria-selected', staffActive \? 'true' : 'false'\)/u);
  assert.match(modeSource, /panel\.focus\(\{ preventScroll: true \}\)/u);
  assert.doesNotMatch(modeSource, /\.open\s*=/u);
  assert.match(
    adminHtml,
    /window\.addEventListener\('hashchange'[\s\S]*managerModes[\s\S]*contains\(document\.activeElement\)[\s\S]*applyManagerMode\(\{ focus: !modeControlHasFocus \}\)/u
  );
  const staffMarkup = sourceBetween(adminHtml, '<section id="staff-time"', '<div id="toast"');
  assert.doesNotMatch(staffMarkup, /passphrase|password|PIN|token|secret/iu);
});
