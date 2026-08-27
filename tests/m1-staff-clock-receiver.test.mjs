import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  sanitizeStaffClockSnapshot,
  sanitizeStaffClockSyncResults,
  sanitizeStaffViewPage,
  sanitizeStaffTimeAdjustmentRequest,
  sanitizeStaffTimeAdjustmentResult,
  sanitizeStaffTimeCorrectionResult,
  sanitizeStaffTimeReview,
  sanitizeStaffTimeVoidResult
} from '../netlify/functions/_lib/m1-staff-clock-contracts.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const codeSource = read('integrations/google-apps-script/Code.gs');
const receiverSource = read('integrations/google-apps-script/GibM1Receiver.gs');

const NOW_ISO = '2026-08-18T22:00:00.000Z';
const EXPECTED_TITLE = 'RBJJ M1 \u2014 TEST';
const SIGNIN_HEADERS = [
  'RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor',
  'Site', 'Device', 'Build', 'Notes', 'Status'
];
const STAFF_HEADERS = ['Staff ID', 'Staff Name', 'Active'];
const STAFF_ROWS = [
  ['mandy-test', 'Mandy Test', true],
  ['front-desk-test-two', 'Front Desk Test Two', true],
  ['front-desk-test-three', 'Front Desk Test Three', true]
];
const TIME_HEADERS = [
  'Punch ID', 'Timestamp', 'Date', 'Staff ID', 'Staff Name', 'Action', 'Site',
  'Device', 'Build', 'Note', 'Status', 'Source', 'Admin Name', 'Linked Punch ID'
];
const AUDIT_HEADERS = [
  'Request ID', 'Action Time', 'Admin Name', 'Staff ID', 'Staff Name',
  'Punch Timestamp', 'Action', 'Required Reason', 'Result', 'Linked Punch ID'
];
const ADJUSTMENT_HEADERS = [
  'Request ID', 'Action Time', 'Admin Name', 'Staff ID', 'Staff Name',
  'Clock In Punch ID', 'Clock Out Punch ID', 'Original Clock In', 'Original Clock Out',
  'Corrected Clock In', 'Corrected Clock Out', 'Changed', 'Required Reason', 'Result'
];
const ADMIN_AUDIT_HEADERS = [
  'Action Number', 'Admin Name', 'Action Time', 'Instructor', 'Class Date',
  'Class', 'Site', 'Duration', 'Required Reason', 'Final Result',
  'Linked Sign-in Record ID'
];

const IDS = Object.freeze({
  in: 'gib-m1-staff-00000000-0000-4000-8000-000000000001',
  out: 'gib-m1-staff-00000000-0000-4000-8000-000000000002',
  other: 'gib-m1-staff-00000000-0000-4000-8000-000000000003',
  correction: 'gib-m1-staff-00000000-0000-4000-8000-000000000004',
  request: 'gib-m1-staff-request-10000000-0000-4000-8000-000000000001',
  voidRequest: 'gib-m1-staff-request-10000000-0000-4000-8000-000000000002',
  voidRequestTwo: 'gib-m1-staff-request-10000000-0000-4000-8000-000000000003',
  adjustRequest: 'gib-m1-staff-request-10000000-0000-4000-8000-000000000004',
  adjustRequestTwo: 'gib-m1-staff-request-10000000-0000-4000-8000-000000000005',
  adjustRequestThree: 'gib-m1-staff-request-10000000-0000-4000-8000-000000000006'
});

function makeSheet(initialRows = []) {
  const values = initialRows.map(row => [...row]);
  const operations = [];
  let maxRows = Math.max(1000, values.length);
  let frozenRows = 0;
  let dataRangeReads = 0;
  return {
    values,
    operations,
    appendRow(row) {
      values.push([...row]);
      operations.push({ type: 'appendRow' });
    },
    deleteRow(rowNumber) {
      values.splice(rowNumber - 1, 1);
      operations.push({ type: 'deleteRow', rowNumber });
    },
    getDataRange() {
      dataRangeReads += 1;
      return { getValues: () => values.map(row => [...row]) };
    },
    get dataRangeReads() { return dataRangeReads; },
    getLastRow() { return values.length; },
    getLastColumn() {
      let last = 0;
      values.forEach(row => row.forEach((value, index) => {
        if (value !== '' && value != null) last = Math.max(last, index + 1);
      }));
      return last;
    },
    getRange(startRow, startColumn, rowCount, columnCount) {
      return {
        getValues() {
          return Array.from({ length: rowCount }, (_, rowOffset) => (
            Array.from({ length: columnCount }, (_, columnOffset) => (
              values[startRow - 1 + rowOffset]?.[startColumn - 1 + columnOffset] ?? ''
            ))
          ));
        },
        setValues(rows) {
          rows.forEach((row, rowOffset) => {
            const targetRow = startRow - 1 + rowOffset;
            if (!values[targetRow]) values[targetRow] = [];
            row.forEach((value, columnOffset) => {
              values[targetRow][startColumn - 1 + columnOffset] = value;
            });
          });
          operations.push({ type: 'setValues', startRow, startColumn, rowCount, columnCount });
          return this;
        },
        setValue(value) {
          if (!values[startRow - 1]) values[startRow - 1] = [];
          values[startRow - 1][startColumn - 1] = value;
          operations.push({ type: 'setValue', startRow, startColumn, value });
          return this;
        },
        setNumberFormat(format) {
          operations.push({ type: 'numberFormat', startRow, startColumn, rowCount, columnCount, format });
          return this;
        }
      };
    },
    setFrozenRows(count) {
      frozenRows = count;
      operations.push({ type: 'setFrozenRows', count });
    },
    get frozenRows() { return frozenRows; },
    getMaxRows() { return maxRows; },
    insertRowsAfter(row, count) {
      maxRows += count;
      operations.push({ type: 'insertRowsAfter', row, count });
    }
  };
}

function offsetFor(date, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).forEach(part => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  const localAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((localAsUtc - date.getTime()) / 60000);
}

function formatDate(dateValue, timeZone, pattern) {
  const date = new Date(dateValue);
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).forEach(part => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  if (pattern === 'yyyy-MM-dd') return day;
  if (pattern === 'yyyy-MM-dd HH:mm:ss') return `${day} ${time}`;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ss") return `${day}T${time}`;
  if (pattern === 'Z') {
    const offset = offsetFor(date, timeZone);
    const sign = offset < 0 ? '-' : '+';
    const absolute = Math.abs(offset);
    return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}${String(absolute % 60).padStart(2, '0')}`;
  }
  throw new Error(`Unsupported test format: ${pattern}`);
}

function timeRow({
  punchId = IDS.in,
  timestamp = '2026-08-18T09:00:00-04:00',
  staffId = 'mandy-test',
  staffName = 'Mandy Test',
  action = 'clockIn',
  status = 'ACTIVE',
  source = 'Tablet',
  adminName = '',
  note = '',
  site = 'Rev',
  device = 'TEST tablet',
  build = 'm1b-test-build',
  linkedPunchId = ''
} = {}) {
  return [
    punchId, timestamp, timestamp.slice(0, 10), staffId, staffName, action, site,
    device, build, note, status, source, adminName, linkedPunchId
  ];
}

function generatedPunchId(index) {
  return `gib-m1-staff-${(0x60000000 + index).toString(16)}-1111-4111-8111-${index.toString(16).padStart(12, '0')}`;
}

function generatedRequestId(index) {
  return `gib-m1-staff-request-${(0x70000000 + index).toString(16)}-1111-4111-8111-${index.toString(16).padStart(12, '0')}`;
}

function ordinaryPeriodTimeRows({ count, startIndex, date, staffId, staffName }) {
  return Array.from({ length: count }, (_, index) => {
    const seconds = (9 * 60 * 60) + index;
    const hour = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const minute = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const second = String(seconds % 60).padStart(2, '0');
    return timeRow({
      punchId: generatedPunchId(startIndex + index),
      timestamp: `${date}T${hour}:${minute}:${second}-04:00`,
      staffId,
      staffName,
      action: index % 2 === 0 ? 'clockIn' : 'clockOut'
    });
  });
}

function createHarness({
  staffRows = STAFF_ROWS,
  timeRows = [],
  auditRows = [],
  includeStaffSheets = true,
  lockAvailable = true,
  nowIso = NOW_ISO
} = {}) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowIso])); }
    static now() { return Date.parse(nowIso); }
  }
  const signins = makeSheet([
    SIGNIN_HEADERS,
    ['signin-sentinel', '2026-08-18 08:00:00', '2026-08-18', 'QA TEST', 1, 'QA Test', 'Rev', '', '', '', 'OK']
  ]);
  const adminAudit = makeSheet([
    ADMIN_AUDIT_HEADERS,
    [1, 'Andrew Smith', '2026-08-18 08:01:00', 'QA Test', '2026-08-18', 'QA TEST', 'Rev', 1, 'sentinel', 'added', 'signin-sentinel']
  ]);
  const sheets = new Map([
    ['Signins', signins],
    ['Admin Audit', adminAudit]
  ]);
  if (includeStaffSheets) {
    sheets.set('Staff Clock Staff', makeSheet([STAFF_HEADERS, ...staffRows]));
    sheets.set('Staff Time', makeSheet([TIME_HEADERS, ...timeRows]));
    sheets.set('Staff Time Audit', makeSheet([AUDIT_HEADERS, ...auditRows]));
  }
  const spreadsheet = {
    getId: () => 'unit-test-spreadsheet-id',
    getName: () => EXPECTED_TITLE,
    getSheetByName: name => sheets.get(name) || null,
    insertSheet(name) {
      const sheet = makeSheet();
      sheets.set(name, sheet);
      return sheet;
    }
  };
  const properties = new Map(Object.entries({
    GIB_M1_TEST_SPREADSHEET_ID: 'unit-test-spreadsheet-id',
    GIB_M1_RECEIVER_TRANSPORT_TOKEN: 'unit-receiver-token',
    GIB_M1_LEGACY_KIOSK_TOKEN: 'unit-legacy-token',
    GIB_M1_ADMIN_ACTION_TOKEN: 'unit-admin-token',
    GIB_M1_RECOVERY_TOKEN: 'unit-recovery-token'
  }));
  const cacheValues = new Map();
  let spreadsheetOpens = 0;
  const context = {
    module: { exports: {} }, exports: {}, console, Date: FixedDate,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) { return { text, setMimeType() { return this; } }; }
    },
    CacheService: {
      getScriptCache: () => ({
        get: key => cacheValues.get(key) || null,
        put(key, value) { cacheValues.set(key, String(value)); },
        remove(key) { cacheValues.delete(key); }
      })
    },
    DriveApp: {
      getFilesByName: () => {
        let read = false;
        return {
          hasNext: () => !read,
          next: () => {
            read = true;
            return {
              getId: () => 'unit-test-spreadsheet-id',
              getMimeType: () => 'application/vnd.google-apps.spreadsheet'
            };
          }
        };
      }
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => lockAvailable, releaseLock() {} })
    },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => properties.get(name) || '',
        setProperty(name, value) { properties.set(name, String(value)); return this; }
      })
    },
    ScriptApp: { getScriptId: () => 'private-unit-script-id' },
    SpreadsheetApp: {
      openById(id) {
        spreadsheetOpens += 1;
        assert.equal(id, 'unit-test-spreadsheet-id');
        return spreadsheet;
      },
      flush() {}
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64EncodeWebSafe: bytes => Buffer.from(bytes.map(value => value < 0 ? value + 256 : value)).toString('base64url'),
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()],
      computeHmacSha256Signature: () => [],
      formatDate,
      newBlob: value => ({ getBytes: () => Buffer.from(String(value), 'utf8') })
    }
  };
  const vmContext = vm.createContext(context);
  vm.runInContext(codeSource, vmContext, { filename: 'Code.gs' });
  vm.runInContext(receiverSource, vmContext, { filename: 'GibM1Receiver.gs' });
  return {
    apps: vmContext,
    sheets,
    signins,
    adminAudit,
    properties,
    cacheValues,
    get spreadsheetOpens() { return spreadsheetOpens; },
    post(body) {
      const result = vmContext.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(result.text);
    }
  };
}

function receiverBody(action, fields = {}) {
  return { action, target: 'test', token: 'unit-receiver-token', ...fields };
}

function adminBody(action, fields = {}) {
  return receiverBody(action, {
    adminActionToken: 'unit-admin-token',
    adminName: 'Andrew Smith',
    ...fields
  });
}

function readPagedStaffView(harness, { admin = false } = {}) {
  const now = new Date(NOW_ISO);
  const initialAction = admin ? 'staffTimeReviewV2' : 'staffClockSnapshotV2';
  const pageAction = admin ? 'staffTimeReviewPageV2' : 'staffClockSnapshotPageV2';
  const initialRaw = harness.post(admin
    ? adminBody(initialAction)
    : receiverBody(initialAction));
  const initial = admin
    ? sanitizeStaffTimeReview(initialRaw, 'test', { now })
    : sanitizeStaffClockSnapshot(initialRaw, 'test', { now });
  assert.ok(initial, `${initialAction} returns a strict paged-view summary`);

  const counts = {
    records: initial.view.recordCount,
    attention: initial.view.attentionCount,
    ...(admin ? { audit: initial.view.auditCount } : {})
  };
  const streams = {};
  const pageSizes = {};
  const pageByteLengths = {};
  for (const [stream, count] of Object.entries(counts)) {
    const items = [];
    const sizes = [];
    const byteLengths = [];
    let offset = 0;
    while (items.length < count) {
      const fields = { viewToken: initial.view.token, stream, offset };
      const raw = harness.post(admin ? adminBody(pageAction, fields) : receiverBody(pageAction, fields));
      byteLengths.push(Buffer.byteLength(JSON.stringify(raw), 'utf8'));
      const page = sanitizeStaffViewPage(raw, 'test', fields, { now });
      assert.ok(page, `${pageAction} returns a strict ${stream} page at ${offset}`);
      items.push(...page.items);
      sizes.push(page.items.length);
      if (page.nextOffset === null) break;
      assert.equal(page.nextOffset, offset + page.items.length);
      offset = page.nextOffset;
    }
    assert.equal(items.length, count, `${stream} pages exactly match the trusted initial count`);
    streams[stream] = items;
    pageSizes[stream] = sizes;
    pageByteLengths[stream] = byteLengths;
  }
  return { initial, streams, pageSizes, pageByteLengths };
}

function punch({
  punchId = IDS.in,
  timestamp = '2026-08-18T09:00:00-04:00',
  staffId = 'mandy-test',
  staffName = staffId === 'mandy-test' ? 'Mandy Test' : 'Front Desk Test Two',
  punchAction = 'clockIn',
  note = ''
} = {}) {
  return {
    punchId, timestamp, date: timestamp.slice(0, 10), staffId, staffName, punchAction,
    site: 'Rev', device: 'TEST tablet', build: 'm1b-test-build', note
  };
}

function correction(overrides = {}) {
  return adminBody('staffTimeCorrect', {
    requestId: IDS.request,
    punchId: IDS.correction,
    timestamp: '2026-08-17T09:00:00-04:00',
    date: '2026-08-17',
    staffId: 'front-desk-test-two',
    staffName: 'Front Desk Test Two',
    punchAction: 'clockIn',
    site: 'Rev',
    device: 'Admin Staff time',
    build: 'm1b-test-build',
    reason: 'Forgotten TEST punch',
    ...overrides
  });
}

function adjustment(overrides = {}) {
  return adminBody('staffTimeAdjust', {
    requestId: IDS.adjustRequest,
    clockInPunchId: IDS.in,
    clockOutPunchId: IDS.out,
    originalClockInAt: '2026-08-17T23:30:00-04:00',
    originalClockOutAt: '2026-08-18T02:30:00-04:00',
    correctedClockInAt: '2026-08-17T23:00:00-04:00',
    correctedClockOutAt: '2026-08-18T02:30:00-04:00',
    reason: 'Correct TEST shift start',
    ...overrides
  });
}

test('TEST provisioner creates the exact Staff Clock tabs and fake active seed', () => {
  const harness = createHarness({ includeStaffSheets: false });
  const signinsBefore = structuredClone(harness.signins.values);
  const adminAuditBefore = structuredClone(harness.adminAudit.values);
  const result = harness.apps.provisionGibM1TestReceiver();

  assert.deepEqual(harness.sheets.get('Staff Clock Staff').values, [STAFF_HEADERS, ...STAFF_ROWS]);
  assert.deepEqual(harness.sheets.get('Staff Time').values, [TIME_HEADERS]);
  assert.deepEqual(harness.sheets.get('Staff Time Audit').values, [AUDIT_HEADERS]);
  assert.deepEqual(harness.sheets.get('Staff Time Adjustments').values, [ADJUSTMENT_HEADERS]);
  assert.equal(harness.sheets.get('Staff Clock Staff').frozenRows, 1);
  assert.equal(harness.sheets.get('Staff Time Adjustments').frozenRows, 1);
  assert.equal(result.staffCount, 3);
  assert.equal(result.staffTimeCount, 0);
  assert.equal(result.staffAuditCount, 0);
  assert.equal(result.staffAdjustmentCount, 0);
  assert.deepEqual(harness.signins.values, signinsBefore);
  assert.deepEqual(harness.adminAudit.values, adminAuditBefore);
});

test('snapshot filters inactive fake staff and rejects production or malformed real-name state before writes', () => {
  const harness = createHarness({
    staffRows: [STAFF_ROWS[0], STAFF_ROWS[1], [STAFF_ROWS[2][0], STAFF_ROWS[2][1], false]]
  });
  const snapshot = harness.post(receiverBody('staffClockSnapshot'));
  assert.deepEqual(snapshot.staff.map(item => item.staffId), ['mandy-test', 'front-desk-test-two']);
  assert.deepEqual(snapshot.records, []);

  const production = harness.post({
    action: 'staffClockSnapshot', target: 'production', token: 'unit-receiver-token'
  });
  assert.equal(production.result, 'rejected');

  const productionCredentialValue = createHash('sha256')
    .update('gib-m1-production:private-production-script-id', 'utf8')
    .digest('base64url');
  const productionCredential = harness.post(receiverBody('staffClockSnapshot', {
    token: productionCredentialValue
  }));
  assert.equal(productionCredential.result, 'rejected');
  assert.equal(harness.spreadsheetOpens, 1);

  const malformed = createHarness({ staffRows: [['real-person', 'Ordinary Person', true]] });
  const before = structuredClone(malformed.sheets.get('Staff Time').values);
  assert.equal(malformed.post(receiverBody('staffClockSnapshot')).result, 'failed');
  assert.deepEqual(malformed.sheets.get('Staff Time').values, before);
});

test('ordinary Clock In and Clock Out are locked, offset-exact, replay-safe, and sequence-safe', () => {
  const harness = createHarness();
  const signinsBefore = structuredClone(harness.signins.values);
  const adminAuditBefore = structuredClone(harness.adminAudit.values);

  const clockInBody = receiverBody('staffClockPunch', { punches: [punch()] });
  const addedIn = harness.post(clockInBody);
  assert.deepEqual(addedIn.results, [{ punchId: IDS.in, result: 'added', linkedPunchId: IDS.in }]);
  assert.equal(harness.post(clockInBody).results[0].result, 'already exists');
  assert.equal(harness.post(receiverBody('staffClockPunch', {
    punches: [punch({ note: 'changed' })]
  })).results[0].result, 'rejected');
  assert.equal(harness.post(receiverBody('staffClockPunch', {
    punches: [punch({ punchId: IDS.other, timestamp: '2026-08-18T09:01:00-04:00' })]
  })).results[0].result, 'rejected');

  const addedOut = harness.post(receiverBody('staffClockPunch', {
    punches: [punch({
      punchId: IDS.out,
      timestamp: '2026-08-18T11:30:00-04:00',
      punchAction: 'clockOut'
    })]
  }));
  assert.equal(addedOut.results[0].result, 'added');
  assert.equal(harness.sheets.get('Staff Time').values.length, 3);

  const review = harness.post(adminBody('staffTimeReview'));
  assert.deepEqual(review.clockedInNow, []);
  const mandy = review.periods.current.totals.find(item => item.staffId === 'mandy-test');
  assert.equal(mandy.completedShifts, 1);
  assert.equal(mandy.totalSeconds, 9_000);
  assert.deepEqual(harness.signins.values, signinsBefore);
  assert.deepEqual(harness.adminAudit.values, adminAuditBefore);
});

test('completed pay-period hours remain after the staff member becomes inactive', () => {
  const inactiveWithoutHistory = ['inactive-without-history-test', 'Inactive Without History Test', false];
  const harness = createHarness({
    staffRows: [...STAFF_ROWS, inactiveWithoutHistory],
    timeRows: [
      timeRow({
        punchId: IDS.other,
        timestamp: '2026-08-03T09:00:00-04:00'
      }),
      timeRow({
        punchId: IDS.correction,
        timestamp: '2026-08-03T10:00:00-04:00',
        action: 'clockOut'
      })
    ]
  });
  assert.equal(harness.post(receiverBody('staffClockPunch', {
    punches: [punch({ timestamp: '2026-08-18T09:00:00-04:00' })]
  })).results[0].result, 'added');
  assert.equal(harness.post(receiverBody('staffClockPunch', {
    punches: [punch({
      punchId: IDS.out,
      timestamp: '2026-08-18T11:30:00-04:00',
      punchAction: 'clockOut'
    })]
  })).results[0].result, 'added');

  harness.sheets.get('Staff Clock Staff').values[1][2] = false;
  const timeBeforeReview = structuredClone(harness.sheets.get('Staff Time').values);
  const auditBeforeReview = structuredClone(harness.sheets.get('Staff Time Audit').values);
  const timeOperationCount = harness.sheets.get('Staff Time').operations.length;
  const auditOperationCount = harness.sheets.get('Staff Time Audit').operations.length;
  const signinsBeforeReview = structuredClone(harness.signins.values);
  const adminAuditBeforeReview = structuredClone(harness.adminAudit.values);

  const legacySnapshot = harness.post(receiverBody('staffClockSnapshot'));
  assert.equal(legacySnapshot.ok, true);
  assert.ok(!legacySnapshot.staff.some(item => item.staffId === 'mandy-test'));
  assert.equal(legacySnapshot.records.filter(item => item.staffId === 'mandy-test').length, 4);

  const snapshot = readPagedStaffView(harness);
  assert.ok(!snapshot.initial.staff.some(item => item.staffId === 'mandy-test'));
  assert.equal(snapshot.streams.records.filter(item => item.staffId === 'mandy-test').length, 2);
  assert.deepEqual(
    snapshot.initial.periods.current.totals.find(item => item.staffId === 'mandy-test'),
    {
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      completedShifts: 1,
      totalSeconds: 9_000,
      needsAttention: false
    }
  );
  assert.deepEqual(
    snapshot.initial.periods.previous.totals.find(item => item.staffId === 'mandy-test'),
    {
      staffId: 'mandy-test',
      staffName: 'Mandy Test',
      completedShifts: 1,
      totalSeconds: 3_600,
      needsAttention: false
    }
  );

  const adminSnapshot = readPagedStaffView(harness, { admin: true });
  assert.ok(!adminSnapshot.initial.staff.some(item => item.staffId === 'mandy-test'));
  assert.deepEqual(
    adminSnapshot.initial.periods.current.totals.find(item => item.staffId === 'mandy-test'),
    snapshot.initial.periods.current.totals.find(item => item.staffId === 'mandy-test')
  );
  assert.deepEqual(
    adminSnapshot.initial.periods.previous.totals.find(item => item.staffId === 'mandy-test'),
    snapshot.initial.periods.previous.totals.find(item => item.staffId === 'mandy-test')
  );

  const review = harness.post(adminBody('staffTimeReview'));
  const mandy = review.periods.current.totals.find(item => item.staffId === 'mandy-test');
  const previousMandy = review.periods.previous.totals.find(item => item.staffId === 'mandy-test');
  assert.deepEqual(mandy, {
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    completedShifts: 1,
    totalSeconds: 9_000,
    needsAttention: false
  });
  assert.deepEqual(previousMandy, {
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    completedShifts: 1,
    totalSeconds: 3_600,
    needsAttention: false
  });
  assert.ok(!review.periods.current.totals.some(item => (
    item.staffId === 'inactive-without-history-test'
  )));
  assert.deepEqual(harness.sheets.get('Staff Time').values, timeBeforeReview);
  assert.deepEqual(harness.sheets.get('Staff Time Audit').values, auditBeforeReview);
  assert.equal(harness.sheets.get('Staff Time').operations.length, timeOperationCount);
  assert.equal(harness.sheets.get('Staff Time Audit').operations.length, auditOperationCount);
  assert.deepEqual(harness.signins.values, signinsBeforeReview);
  assert.deepEqual(harness.adminAudit.values, adminAuditBeforeReview);
});

test('contradictory confirmed records surface Needs attention and block another ordinary punch', () => {
  const harness = createHarness({
    timeRows: [timeRow({ action: 'clockOut', punchId: IDS.out })]
  });
  const review = harness.post(adminBody('staffTimeReview'));
  assert.deepEqual(review.needsAttention.map(issue => issue.code), ['clock_out_without_clock_in']);
  const before = structuredClone(harness.sheets.get('Staff Time').values);
  const response = harness.post(receiverBody('staffClockPunch', {
    punches: [punch({ punchId: IDS.other, timestamp: '2026-08-18T10:00:00-04:00' })]
  }));
  assert.equal(response.results[0].result, 'needs attention');
  assert.deepEqual(harness.sheets.get('Staff Time').values, before);
});

test('an overnight open shift needs attention before the 18-hour threshold', () => {
  const harness = createHarness({
    nowIso: '2026-08-18T06:00:00.000Z',
    timeRows: [timeRow({ timestamp: '2026-08-17T23:30:00-04:00' })]
  });
  const review = harness.post(adminBody('staffTimeReview'));
  assert.deepEqual(review.needsAttention.map(issue => issue.code), ['missing_clock_out']);
  assert.equal(review.clockedInNow[0].clockInAt, '2026-08-17T23:30:00-04:00');

  const response = harness.post(receiverBody('staffClockPunch', {
    punches: [punch({
      punchId: IDS.out,
      timestamp: '2026-08-18T02:05:00-04:00',
      punchAction: 'clockOut'
    })]
  }));
  assert.equal(response.results[0].result, 'needs attention');
});

test('a completed shift over 18 hours stays in exact totals and needs attention', () => {
  const harness = createHarness({
    nowIso: '2026-08-19T01:00:00.000Z',
    timeRows: [
      timeRow({ timestamp: '2026-08-18T01:00:00-04:00' }),
      timeRow({
        punchId: IDS.out,
        timestamp: '2026-08-18T20:00:01-04:00',
        action: 'clockOut'
      })
    ]
  });
  const review = harness.post(adminBody('staffTimeReview'));
  assert.deepEqual(review.needsAttention.map(issue => issue.code), ['shift_too_long']);
  const total = review.periods.current.totals.find(item => item.staffId === 'mandy-test');
  assert.equal(total.completedShifts, 1);
  assert.equal(total.totalSeconds, 68_401);
  assert.equal(total.needsAttention, true);
});

test('state remains unknown after the first punch-order contradiction', () => {
  const harness = createHarness({
    timeRows: [
      timeRow({ timestamp: '2026-08-18T09:00:00-04:00' }),
      timeRow({ punchId: IDS.out, timestamp: '2026-08-18T10:00:00-04:00' }),
      timeRow({
        punchId: IDS.other,
        timestamp: '2026-08-18T11:00:00-04:00',
        action: 'clockOut'
      }),
      timeRow({ punchId: IDS.correction, timestamp: '2026-08-18T12:00:00-04:00' })
    ]
  });
  const review = harness.post(adminBody('staffTimeReview'));
  assert.deepEqual(review.needsAttention.map(issue => issue.code), ['repeated_clock_in']);
  assert.deepEqual(review.clockedInNow, []);
  assert.equal(review.periods.current.totals[0].completedShifts, 0);
});

test('a stored future punch beyond write skew remains visible as attention in paged views', () => {
  const harness = createHarness({
    timeRows: [timeRow({ timestamp: '2026-08-18T19:00:00-04:00' })]
  });
  const review = harness.post(adminBody('staffTimeReview'));
  assert.deepEqual(review.needsAttention.map(issue => issue.code), ['future_punch']);
  assert.deepEqual(review.clockedInNow, []);
  const kioskView = readPagedStaffView(harness);
  const adminView = readPagedStaffView(harness, { admin: true });
  assert.deepEqual(kioskView.streams.attention.map(issue => issue.code), ['future_punch']);
  assert.deepEqual(adminView.streams.attention.map(issue => issue.code), ['future_punch']);
  assert.deepEqual(kioskView.initial.clockedInNow, []);
  assert.deepEqual(adminView.initial.clockedInNow, []);
  assert.equal(kioskView.streams.records[0].timestamp, '2026-08-18T19:00:00-04:00');
  assert.equal(adminView.streams.records[0].timestamp, '2026-08-18T19:00:00-04:00');
});

test('Admin correction has one permanent request audit and heals a row-only interruption', () => {
  const harness = createHarness();
  const first = harness.post(correction());
  assert.equal(first.result, 'added');
  assert.equal(first.confirmation.adminName, 'Andrew Smith');
  assert.equal(first.confirmation.punchAction, 'clockIn');
  assert.equal(first.auditActionNumber, 1);
  assert.equal(harness.sheets.get('Staff Time Audit').values.length, 2);

  const replay = harness.post(correction());
  assert.equal(replay.result, 'already exists');
  assert.equal(harness.sheets.get('Staff Time').values.length, 2);
  assert.equal(harness.sheets.get('Staff Time Audit').values.length, 2);
  assert.equal(harness.post(correction({ reason: 'Changed TEST reason' })).result, 'conflict');

  const rowOnly = createHarness({
    timeRows: [timeRow({
      punchId: IDS.correction,
      timestamp: '2026-08-17T09:00:00-04:00',
      staffId: 'front-desk-test-two',
      staffName: 'Front Desk Test Two',
      action: 'clockIn',
      source: 'Admin-added',
      adminName: 'Andrew Smith',
      device: 'Admin Staff time',
      note: `Admin correction | Request: ${IDS.request} | Reason: Forgotten TEST punch`
    })]
  });
  const healed = rowOnly.post(correction());
  assert.equal(healed.result, 'already exists');
  assert.equal(rowOnly.sheets.get('Staff Time').values.length, 2);
  assert.equal(rowOnly.sheets.get('Staff Time Audit').values.length, 2);
});

test('adjusting clock-in, clock-out, or both preserves raw punches and drives cross-midnight totals', () => {
  const harness = createHarness({
    timeRows: [
      timeRow({ timestamp: '2026-08-17T23:30:00-04:00' }),
      timeRow({
        punchId: IDS.out,
        timestamp: '2026-08-18T02:30:00-04:00',
        action: 'clockOut'
      })
    ]
  });
  const rawBefore = structuredClone(harness.sheets.get('Staff Time').values);

  const inOnly = harness.post(adjustment());
  assert.equal(inOnly.result, 'adjusted');
  assert.equal(inOnly.confirmation.changed, 'clockIn');
  assert.equal(inOnly.auditActionNumber, 1);

  const outOnly = harness.post(adjustment({
    requestId: IDS.adjustRequestTwo,
    originalClockInAt: '2026-08-17T23:00:00-04:00',
    originalClockOutAt: '2026-08-18T02:30:00-04:00',
    correctedClockInAt: '2026-08-17T23:00:00-04:00',
    correctedClockOutAt: '2026-08-18T03:00:00-04:00',
    reason: 'Correct TEST shift end'
  }));
  assert.equal(outOnly.result, 'adjusted');
  assert.equal(outOnly.confirmation.changed, 'clockOut');
  assert.equal(outOnly.auditActionNumber, 2);

  const both = harness.post(adjustment({
    requestId: IDS.adjustRequestThree,
    originalClockInAt: '2026-08-17T23:00:00-04:00',
    originalClockOutAt: '2026-08-18T03:00:00-04:00',
    correctedClockInAt: '2026-08-17T23:15:00-04:00',
    correctedClockOutAt: '2026-08-18T02:45:00-04:00',
    reason: 'Correct both TEST shift times'
  }));
  assert.equal(both.result, 'adjusted');
  assert.equal(both.confirmation.changed, 'both');
  assert.equal(both.auditActionNumber, 3);

  const adjustmentSheet = harness.sheets.get('Staff Time Adjustments');
  assert.ok(adjustmentSheet, 'the append-only adjustment tab is created on the first authorized write');
  assert.deepEqual(adjustmentSheet.values[0], ADJUSTMENT_HEADERS);
  assert.equal(adjustmentSheet.values.length, 4);
  assert.deepEqual(
    adjustmentSheet.values.slice(1).map(row => [row[0], row[5], row[6], row[11], row[12], row[13]]),
    [
      [IDS.adjustRequest, IDS.in, IDS.out, 'clockIn', 'Correct TEST shift start', 'adjusted'],
      [IDS.adjustRequestTwo, IDS.in, IDS.out, 'clockOut', 'Correct TEST shift end', 'adjusted'],
      [IDS.adjustRequestThree, IDS.in, IDS.out, 'both', 'Correct both TEST shift times', 'adjusted']
    ]
  );
  assert.deepEqual(
    harness.sheets.get('Staff Time').values,
    rawBefore,
    'the permanent Staff Time records and timestamps stay byte-for-byte unchanged'
  );
  assert.deepEqual(
    harness.sheets.get('Staff Time').operations,
    [],
    'adjustments never update the original Staff Time rows'
  );

  const adminView = readPagedStaffView(harness, { admin: true });
  const effectiveById = Object.fromEntries(adminView.streams.records.map(record => [record.punchId, record]));
  assert.deepEqual({
    timestamp: effectiveById[IDS.in].timestamp,
    date: effectiveById[IDS.in].date,
    originalTimestamp: effectiveById[IDS.in].originalTimestamp,
    originalDate: effectiveById[IDS.in].originalDate,
    adjustmentRequestId: effectiveById[IDS.in].adjustmentRequestId
  }, {
    timestamp: '2026-08-17T23:15:00-04:00',
    date: '2026-08-17',
    originalTimestamp: '2026-08-17T23:30:00-04:00',
    originalDate: '2026-08-17',
    adjustmentRequestId: IDS.adjustRequestThree
  });
  assert.equal(effectiveById[IDS.out].timestamp, '2026-08-18T02:45:00-04:00');
  assert.equal(effectiveById[IDS.out].originalTimestamp, '2026-08-18T02:30:00-04:00');
  assert.equal(effectiveById[IDS.out].adjustmentRequestId, IDS.adjustRequestThree);
  const adminTotal = adminView.initial.periods.current.totals.find(item => item.staffId === 'mandy-test');
  assert.equal(adminTotal.completedShifts, 1);
  assert.equal(adminTotal.totalSeconds, 12_600);

  const auditByRequest = Object.fromEntries(
    adminView.streams.audit.map(record => [record.requestId, record])
  );
  assert.equal(Object.keys(auditByRequest).length, 3);
  assert.deepEqual(auditByRequest[IDS.adjustRequest], {
    requestId: IDS.adjustRequest,
    actionTime: '2026-08-18T18:00:00-04:00',
    adminName: 'Andrew Smith',
    operation: 'adjust',
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    clockInPunchId: IDS.in,
    clockOutPunchId: IDS.out,
    originalClockInAt: '2026-08-17T23:30:00-04:00',
    originalClockOutAt: '2026-08-18T02:30:00-04:00',
    correctedClockInAt: '2026-08-17T23:00:00-04:00',
    correctedClockOutAt: '2026-08-18T02:30:00-04:00',
    changed: 'clockIn',
    reason: 'Correct TEST shift start',
    result: 'adjusted'
  });
  assert.equal(auditByRequest[IDS.adjustRequestTwo].originalClockInAt, '2026-08-17T23:00:00-04:00');
  assert.equal(auditByRequest[IDS.adjustRequestTwo].correctedClockOutAt, '2026-08-18T03:00:00-04:00');
  assert.equal(auditByRequest[IDS.adjustRequestThree].correctedClockInAt, '2026-08-17T23:15:00-04:00');
  assert.equal(auditByRequest[IDS.adjustRequestThree].correctedClockOutAt, '2026-08-18T02:45:00-04:00');

  const kioskView = readPagedStaffView(harness);
  const kioskTotal = kioskView.initial.periods.current.totals.find(item => item.staffId === 'mandy-test');
  assert.equal(kioskTotal.completedShifts, 1);
  assert.equal(kioskTotal.totalSeconds, 12_600);
  assert.equal(
    kioskView.streams.records.find(record => record.punchId === IDS.in).timestamp,
    '2026-08-17T23:15:00-04:00'
  );
});

test('an exact adjustment retry is idempotent while changed payloads and stale preimages conflict', () => {
  const harness = createHarness({
    timeRows: [
      timeRow({ timestamp: '2026-08-17T23:30:00-04:00' }),
      timeRow({ punchId: IDS.out, timestamp: '2026-08-18T02:30:00-04:00', action: 'clockOut' })
    ]
  });
  const rawBefore = structuredClone(harness.sheets.get('Staff Time').values);
  const request = adjustment();
  const first = harness.post(request);
  assert.equal(first.result, 'adjusted');
  const adjustmentSheet = harness.sheets.get('Staff Time Adjustments');
  const afterFirstValues = structuredClone(adjustmentSheet.values);
  const afterFirstOperations = structuredClone(adjustmentSheet.operations);

  const replay = harness.post(request);
  assert.equal(replay.result, 'already adjusted');
  assert.equal(replay.auditActionNumber, first.auditActionNumber);
  assert.deepEqual(replay.confirmation, first.confirmation);
  assert.deepEqual(adjustmentSheet.values, afterFirstValues, 'an exact retry appends no second audit row');
  assert.deepEqual(adjustmentSheet.operations, afterFirstOperations, 'an exact retry performs no write');

  const sameIdChangedPayload = harness.post(adjustment({
    correctedClockOutAt: '2026-08-18T02:45:00-04:00'
  }));
  assert.equal(sameIdChangedPayload.result, 'conflict');
  assert.deepEqual(adjustmentSheet.values, afterFirstValues);

  const stalePreimage = harness.post(adjustment({
    requestId: IDS.adjustRequestTwo,
    correctedClockInAt: '2026-08-17T22:45:00-04:00'
  }));
  assert.equal(stalePreimage.result, 'conflict');
  assert.deepEqual(adjustmentSheet.values, afterFirstValues);
  assert.deepEqual(harness.sheets.get('Staff Time').values, rawBefore);
  assert.deepEqual(harness.sheets.get('Staff Time').operations, []);

  const browserRequest = {
    operation: 'adjust',
    requestId: IDS.adjustRequest,
    clockInPunchId: IDS.in,
    clockOutPunchId: IDS.out,
    originalClockInAt: '2026-08-17T23:30:00-04:00',
    originalClockOutAt: '2026-08-18T02:30:00-04:00',
    correctedClockInAt: '2026-08-17T23:00:00-04:00',
    correctedClockOutAt: '2026-08-18T02:30:00-04:00',
    reason: 'Correct TEST shift start'
  };
  const sanitizedRequest = sanitizeStaffTimeAdjustmentRequest(browserRequest, {
    now: new Date(NOW_ISO)
  });
  assert.ok(sanitizedRequest);
  const expected = { ...sanitizedRequest, adminName: 'Andrew Smith' };
  assert.ok(sanitizeStaffTimeAdjustmentResult(first, expected, 'test', { now: new Date(NOW_ISO) }));
  assert.ok(sanitizeStaffTimeAdjustmentResult(replay, expected, 'test', { now: new Date(NOW_ISO) }));
});

test('corrections, voids, and adjustments share one global request ID namespace', () => {
  const completedShift = [
    timeRow({ timestamp: '2026-08-17T23:30:00-04:00' }),
    timeRow({ punchId: IDS.out, timestamp: '2026-08-18T02:30:00-04:00', action: 'clockOut' })
  ];

  const correctionFirst = createHarness({ timeRows: completedShift });
  assert.equal(correctionFirst.post(correction()).result, 'added');
  const correctionAudit = structuredClone(correctionFirst.sheets.get('Staff Time Audit').values);
  assert.equal(
    correctionFirst.post(adjustment({ requestId: IDS.request })).result,
    'conflict',
    'an audit request ID cannot be reused for an adjustment'
  );
  assert.equal(correctionFirst.sheets.has('Staff Time Adjustments'), false);
  assert.deepEqual(correctionFirst.sheets.get('Staff Time Audit').values, correctionAudit);
  assert.equal(correctionFirst.post(correction()).result, 'already exists');

  const interruptedCorrection = createHarness({
    timeRows: [
      ...completedShift,
      timeRow({
        punchId: IDS.correction,
        timestamp: '2026-08-17T09:00:00-04:00',
        staffId: 'front-desk-test-two',
        staffName: 'Front Desk Test Two',
        source: 'Admin-added',
        adminName: 'Andrew Smith',
        device: 'Admin Staff time',
        note: `Admin correction | Request: ${IDS.request} | Reason: Forgotten TEST punch`
      })
    ]
  });
  assert.equal(
    interruptedCorrection.post(adjustment({ requestId: IDS.request })).result,
    'conflict',
    'an interrupted correction keeps ownership of its request ID until its audit heals'
  );
  assert.equal(
    interruptedCorrection.post(adminBody('staffTimeVoid', {
      requestId: IDS.request,
      punchId: IDS.in,
      reason: 'Wrong TEST punch'
    })).result,
    'conflict',
    'an interrupted correction request ID cannot be reused for a void'
  );
  assert.equal(interruptedCorrection.sheets.has('Staff Time Adjustments'), false);
  assert.equal(interruptedCorrection.post(correction()).result, 'already exists');
  assert.equal(interruptedCorrection.sheets.get('Staff Time Audit').values.length, 2);

  const voidTarget = timeRow({
    punchId: IDS.other,
    timestamp: '2026-08-18T09:00:00-04:00',
    staffId: 'front-desk-test-two',
    staffName: 'Front Desk Test Two'
  });
  const voidFirst = createHarness({ timeRows: [...completedShift, voidTarget] });
  const voidRequest = adminBody('staffTimeVoid', {
    requestId: IDS.voidRequest,
    punchId: IDS.other,
    reason: 'Wrong TEST punch'
  });
  assert.equal(voidFirst.post(voidRequest).result, 'voided');
  assert.equal(
    voidFirst.post(adjustment({ requestId: IDS.voidRequest })).result,
    'conflict',
    'a void audit request ID cannot be reused for an adjustment'
  );
  assert.equal(voidFirst.sheets.has('Staff Time Adjustments'), false);
  assert.equal(voidFirst.post(voidRequest).result, 'already voided');

  const adjustmentFirst = createHarness({ timeRows: completedShift });
  const exactAdjustment = adjustment();
  assert.equal(adjustmentFirst.post(exactAdjustment).result, 'adjusted');
  const adjustmentRows = structuredClone(
    adjustmentFirst.sheets.get('Staff Time Adjustments').values
  );
  assert.equal(
    adjustmentFirst.post(correction({ requestId: IDS.adjustRequest })).result,
    'conflict',
    'an adjustment request ID cannot be reused for a correction'
  );
  assert.equal(
    adjustmentFirst.post(adminBody('staffTimeVoid', {
      requestId: IDS.adjustRequest,
      punchId: IDS.in,
      reason: 'Wrong TEST punch'
    })).result,
    'conflict',
    'an adjustment request ID cannot be reused for a void'
  );
  assert.deepEqual(adjustmentFirst.sheets.get('Staff Time Audit').values, [AUDIT_HEADERS]);
  assert.deepEqual(adjustmentFirst.sheets.get('Staff Time Adjustments').values, adjustmentRows);
  assert.equal(adjustmentFirst.sheets.get('Staff Time').values[1][10], 'ACTIVE');
  assert.equal(adjustmentFirst.post(exactAdjustment).result, 'already adjusted');
});

test('adjustment validation rejects bad New York time, chronology, duration, and neighbor overlap without writes', () => {
  const previousIn = generatedPunchId(80_001);
  const previousOut = generatedPunchId(80_002);
  const nextIn = generatedPunchId(80_003);
  const nextOut = generatedPunchId(80_004);
  const harness = createHarness({
    timeRows: [
      timeRow({ punchId: previousIn, timestamp: '2026-08-18T07:00:00-04:00' }),
      timeRow({ punchId: previousOut, timestamp: '2026-08-18T08:00:00-04:00', action: 'clockOut' }),
      timeRow({ timestamp: '2026-08-18T09:00:00-04:00' }),
      timeRow({ punchId: IDS.out, timestamp: '2026-08-18T10:00:00-04:00', action: 'clockOut' }),
      timeRow({ punchId: nextIn, timestamp: '2026-08-18T11:00:00-04:00' }),
      timeRow({ punchId: nextOut, timestamp: '2026-08-18T12:00:00-04:00', action: 'clockOut' })
    ]
  });
  const rawBefore = structuredClone(harness.sheets.get('Staff Time').values);
  const base = {
    originalClockInAt: '2026-08-18T09:00:00-04:00',
    originalClockOutAt: '2026-08-18T10:00:00-04:00',
    correctedClockInAt: '2026-08-18T08:45:00-04:00',
    correctedClockOutAt: '2026-08-18T10:00:00-04:00'
  };
  const attempts = [
    [
      'rejected',
      adjustment({
        ...base,
        originalClockInAt: '2026-08-18T09:00:00-05:00',
        requestId: generatedRequestId(80_001)
      })
    ],
    [
      'rejected',
      adjustment({
        ...base,
        correctedClockInAt: '2026-08-18T10:30:00-04:00',
        requestId: generatedRequestId(80_002)
      })
    ],
    [
      'rejected',
      adjustment({
        ...base,
        correctedClockInAt: '2026-08-17T14:00:00-04:00',
        requestId: generatedRequestId(80_003)
      })
    ],
    [
      'conflict',
      adjustment({
        ...base,
        correctedClockInAt: '2026-08-18T07:59:00-04:00',
        requestId: generatedRequestId(80_004)
      })
    ],
    [
      'conflict',
      adjustment({
        ...base,
        correctedClockOutAt: '2026-08-18T11:01:00-04:00',
        requestId: generatedRequestId(80_005)
      })
    ],
    [
      'conflict',
      adjustment({
        ...base,
        originalClockInAt: '2026-08-18T09:01:00-04:00',
        requestId: generatedRequestId(80_006)
      })
    ]
  ];

  attempts.forEach(([expectedResult, request]) => {
    assert.equal(harness.post(request).result, expectedResult);
  });
  assert.equal(harness.sheets.has('Staff Time Adjustments'), false, 'rejected requests create no audit tab');
  assert.deepEqual(harness.sheets.get('Staff Time').values, rawBefore);
  assert.deepEqual(harness.sheets.get('Staff Time').operations, []);
});

test('void preserves the punch row, updates status, writes one audit, and replays exactly', () => {
  const harness = createHarness({ timeRows: [timeRow()] });
  const request = adminBody('staffTimeVoid', {
    requestId: IDS.voidRequest,
    punchId: IDS.in,
    reason: 'Wrong TEST punch'
  });
  const first = harness.post(request);
  assert.equal(first.result, 'voided');
  assert.equal(first.confirmation.status, 'VOID');
  assert.equal(first.confirmation.punchAction, 'clockIn');
  assert.equal(harness.sheets.get('Staff Time').values.length, 2, 'original row is preserved');
  assert.equal(harness.sheets.get('Staff Time').values[1][10], 'VOID');
  assert.equal(harness.sheets.get('Staff Time Audit').values.length, 2);

  assert.equal(harness.post(request).result, 'already voided');
  assert.equal(harness.sheets.get('Staff Time Audit').values.length, 2);
  assert.equal(harness.post({ ...request, reason: 'Changed TEST void reason' }).result, 'conflict');

  const distinctRequest = {
    ...request,
    requestId: IDS.voidRequestTwo,
    reason: 'Confirmed duplicate TEST void'
  };
  const alreadyVoided = harness.post(distinctRequest);
  assert.equal(alreadyVoided.result, 'already voided');
  assert.equal(alreadyVoided.auditActionNumber, 2);
  assert.equal(harness.sheets.get('Staff Time Audit').values.length, 3);
  const review = harness.post(adminBody('staffTimeReview'));
  assert.equal(review.records[0].status, 'VOID');
  assert.deepEqual(review.clockedInNow, []);
  assert.deepEqual(
    review.audit.map(item => [item.requestId, item.result]),
    [[IDS.voidRequest, 'voided'], [IDS.voidRequestTwo, 'already voided']]
  );
});

test('review returns today, audit, and exact anchored current/previous period totals without rounding', () => {
  const currentIn = timeRow({
    punchId: IDS.in,
    timestamp: '2026-08-10T09:00:00-04:00',
    action: 'clockIn'
  });
  const currentOut = timeRow({
    punchId: IDS.out,
    timestamp: '2026-08-10T10:30:45-04:00',
    action: 'clockOut'
  });
  const previousIn = timeRow({
    punchId: IDS.other,
    timestamp: '2026-08-03T09:00:00-04:00',
    staffId: 'front-desk-test-two',
    staffName: 'Front Desk Test Two',
    action: 'clockIn'
  });
  const previousOut = timeRow({
    punchId: IDS.correction,
    timestamp: '2026-08-03T10:00:00-04:00',
    staffId: 'front-desk-test-two',
    staffName: 'Front Desk Test Two',
    action: 'clockOut'
  });
  const harness = createHarness({ timeRows: [previousIn, previousOut, currentIn, currentOut] });
  const review = harness.post(adminBody('staffTimeReview'));
  assert.equal(review.ok, true);
  assert.deepEqual(
    [review.periods.current.startDate, review.periods.current.endDate],
    ['2026-08-10', '2026-08-23']
  );
  assert.deepEqual(
    [review.periods.previous.startDate, review.periods.previous.endDate],
    ['2026-07-27', '2026-08-09']
  );
  const current = review.periods.current.totals.find(item => item.staffId === 'mandy-test');
  const previous = review.periods.previous.totals.find(item => item.staffId === 'front-desk-test-two');
  assert.equal(current.totalSeconds, 5_445);
  assert.equal(previous.totalSeconds, 3_600);
  assert.deepEqual(review.todayPunches, []);
  assert.deepEqual(review.audit, []);
});

test('an old VOID adjacent to an unresolved punch remains visible with its audit evidence', () => {
  const activeClockInId = generatedPunchId(8_000);
  const voidClockOutId = generatedPunchId(8_001);
  const voidRequestId = 'gib-m1-staff-request-20000000-0000-4000-8000-000000000001';
  const harness = createHarness({
    timeRows: [
      timeRow({
        punchId: activeClockInId,
        timestamp: '2025-12-30T09:00:00-05:00'
      }),
      timeRow({
        punchId: voidClockOutId,
        timestamp: '2025-12-30T10:00:00-05:00',
        action: 'clockOut',
        status: 'VOID'
      })
    ],
    auditRows: [[
      voidRequestId, '2025-12-30T10:05:00-05:00', 'Andrew Smith',
      'mandy-test', 'Mandy Test', '2025-12-30T10:00:00-05:00',
      'void', 'Wrong old TEST punch', 'voided', voidClockOutId
    ]]
  });
  const before = new Map([...harness.sheets].map(([name, sheet]) => (
    [name, structuredClone(sheet.values)]
  )));
  const snapshot = readPagedStaffView(harness);
  assert.deepEqual(snapshot.streams.records.map(record => record.punchId), [
    activeClockInId,
    voidClockOutId
  ]);
  assert.deepEqual(snapshot.streams.attention.map(item => [item.code, item.linkedPunchIds]), [[
    'missing_clock_out',
    [activeClockInId]
  ]]);

  const review = readPagedStaffView(harness, { admin: true });
  assert.equal(
    review.streams.records.find(record => record.punchId === voidClockOutId).status,
    'VOID'
  );
  assert.deepEqual(review.streams.audit.map(item => [item.requestId, item.linkedPunchId]), [[
    voidRequestId,
    voidClockOutId
  ]]);

  for (const [name, sheet] of harness.sheets) {
    assert.deepEqual(sheet.values, before.get(name), `${name} rows remain byte-for-byte equivalent`);
    assert.deepEqual(sheet.operations, [], `${name} receives no write operation`);
  }
});

test('more than 10,000 same-day punches keep exact state and totals in a bounded immutable projection', () => {
  const ordinaryPeriodRows = ordinaryPeriodTimeRows({
    count: 10_002,
    startIndex: 0,
    date: '2026-08-18',
    staffId: 'mandy-test',
    staffName: 'Mandy Test'
  });
  const openPunchId = generatedPunchId(50_000);
  const issuePunchId = generatedPunchId(50_001);
  const voidPunchId = generatedPunchId(50_002);
  const correctedInId = generatedPunchId(50_003);
  const correctedOutId = generatedPunchId(50_004);
  const relevantRows = [
    timeRow({
      punchId: IDS.other,
      timestamp: '2026-08-03T09:00:00-04:00',
      staffId: 'front-desk-test-three',
      staffName: 'Front Desk Test Three',
      action: 'clockIn'
    }),
    timeRow({
      punchId: IDS.correction,
      timestamp: '2026-08-03T10:30:00-04:00',
      staffId: 'front-desk-test-three',
      staffName: 'Front Desk Test Three',
      action: 'clockOut'
    }),
    timeRow({
      punchId: correctedInId,
      timestamp: '2026-08-17T08:00:00-04:00',
      staffId: 'front-desk-test-two',
      staffName: 'Front Desk Test Two',
      action: 'clockIn',
      source: 'Admin-added',
      adminName: 'Andrew Smith',
      device: 'Admin Staff time',
      note: `Admin correction | Request: ${IDS.request} | Reason: Missed TEST punch`
    }),
    timeRow({
      punchId: correctedOutId,
      timestamp: '2026-08-17T09:00:00-04:00',
      staffId: 'front-desk-test-two',
      staffName: 'Front Desk Test Two',
      action: 'clockOut'
    }),
    timeRow({
      punchId: openPunchId,
      timestamp: '2026-08-18T12:00:00-04:00',
      staffId: 'mandy-test',
      staffName: 'Mandy Test'
    }),
    timeRow({
      punchId: issuePunchId,
      timestamp: '2025-12-31T09:00:00-05:00',
      staffId: 'attention-test',
      staffName: 'Attention Test',
      action: 'clockOut'
    }),
    timeRow({
      punchId: voidPunchId,
      timestamp: '2026-08-18T14:00:00-04:00',
      action: 'clockOut',
      status: 'VOID'
    })
  ];
  const auditRows = [
    [
      IDS.request, '2026-08-18T16:00:00-04:00', 'Andrew Smith',
      'front-desk-test-two', 'Front Desk Test Two', '2026-08-17T08:00:00-04:00',
      'clockIn', 'Missed TEST punch', 'added', correctedInId
    ],
    [
      IDS.voidRequest, '2026-08-18T17:00:00-04:00', 'Andrew Smith',
      'mandy-test', 'Mandy Test', '2026-08-18T14:00:00-04:00',
      'void', 'Wrong TEST punch', 'voided', voidPunchId
    ]
  ];
  const harness = createHarness({
    staffRows: [...STAFF_ROWS, ['attention-test', 'Attention Test', false]],
    timeRows: [...ordinaryPeriodRows, ...relevantRows],
    auditRows
  });
  const before = new Map([...harness.sheets].map(([name, sheet]) => (
    [name, structuredClone(sheet.values)]
  )));
  assert.ok(harness.sheets.get('Staff Time').values.length - 1 > 10_000);

  const snapshot = readPagedStaffView(harness);
  assert.equal(snapshot.pageSizes.records.reduce((sum, size) => sum + size, 0), 500);
  assert.ok(snapshot.pageSizes.records.every(size => size > 0 && size <= 500));
  assert.ok(snapshot.pageByteLengths.records.every(size => size <= 80_000));
  assert.deepEqual(snapshot.pageSizes.attention, [1]);
  assert.equal(snapshot.initial.view.recordCount, 500);
  assert.equal(snapshot.initial.view.recordTotal, 10_007);
  assert.equal(snapshot.initial.view.todayPunchCount, 497);
  assert.equal(snapshot.initial.view.todayPunchTotal, 10_004);
  assert.equal(snapshot.initial.view.adjustmentCount, 2);
  assert.equal(snapshot.initial.view.adjustmentTotal, 2);
  assert.equal(snapshot.initial.view.recordsTruncated, true);
  assert.equal(snapshot.initial.view.attentionCount, 1);
  assert.equal(snapshot.initial.view.attentionOccurrenceCount, 1);
  assert.equal(snapshot.initial.view.auditCount, 0);
  assert.equal(snapshot.initial.view.auditTotal, 0);
  assert.equal(snapshot.initial.view.auditTruncated, false);
  assert.equal(snapshot.streams.records.length, 500);
  assert.equal(
    new Set(snapshot.streams.records.map(record => record.punchId)).size,
    snapshot.streams.records.length,
    'record pages contain no gaps or duplicates'
  );
  assert.deepEqual(snapshot.streams.records.slice(0, 5).map(record => record.punchId), [
    openPunchId,
    issuePunchId,
    voidPunchId,
    correctedOutId,
    correctedInId
  ], 'open/issue evidence and correction/VOID evidence outrank the same-day tail');
  assert.deepEqual(
    snapshot.initial.clockedInNow.map(item => [item.staffId, item.punchId]),
    [['mandy-test', openPunchId]]
  );
  assert.deepEqual(snapshot.streams.attention.map(item => [item.code, item.linkedPunchIds]), [
    ['clock_out_without_clock_in', [issuePunchId]]
  ]);
  assert.equal(
    snapshot.streams.records.filter(record => record.date === snapshot.initial.view.today).length,
    snapshot.initial.view.todayPunchCount
  );
  const snapshotMandy = snapshot.initial.periods.current.totals.find(item => (
    item.staffId === 'mandy-test'
  ));
  assert.equal(snapshotMandy.completedShifts, 5_001);
  assert.equal(snapshotMandy.totalSeconds, 5_001);
  assert.equal(snapshot.streams.records.find(item => item.punchId === correctedInId).source, 'Admin-added');
  assert.ok(snapshot.streams.records.some(item => item.punchId === correctedOutId));
  assert.equal(snapshot.streams.records.find(item => item.punchId === voidPunchId).status, 'VOID');

  const review = readPagedStaffView(harness, { admin: true });
  assert.equal(review.pageSizes.records.reduce((sum, size) => sum + size, 0), 500);
  assert.ok(review.pageByteLengths.records.every(size => size <= 80_000));
  assert.deepEqual(review.pageSizes.attention, [1]);
  assert.deepEqual(review.pageSizes.audit, [2]);
  assert.equal(review.initial.view.recordTotal, 10_007);
  assert.equal(review.initial.view.recordCount, 500);
  assert.equal(review.initial.view.auditTotal, 2);
  assert.equal(review.initial.view.auditCount, 2);
  assert.equal(review.initial.view.auditTruncated, false);
  assert.notEqual(review.initial.view.token, snapshot.initial.view.token, 'Admin token is mode-bound');
  assert.deepEqual(
    review.initial.clockedInNow.map(item => [item.staffId, item.punchId]),
    [['mandy-test', openPunchId]]
  );
  const currentMandy = review.initial.periods.current.totals.find(item => item.staffId === 'mandy-test');
  const currentDesk = review.initial.periods.current.totals.find(item => item.staffId === 'front-desk-test-two');
  const previousDesk = review.initial.periods.previous.totals.find(item => (
    item.staffId === 'front-desk-test-three'
  ));
  assert.equal(currentMandy.completedShifts, 5_001);
  assert.equal(currentMandy.totalSeconds, 5_001);
  assert.equal(currentDesk.totalSeconds, 3_600);
  assert.equal(previousDesk.totalSeconds, 5_400);
  assert.equal(previousDesk.completedShifts, 1);
  assert.deepEqual(review.streams.attention.map(item => [item.code, item.linkedPunchIds]), [
    ['clock_out_without_clock_in', [issuePunchId]]
  ]);
  assert.equal(review.streams.records.find(item => item.punchId === correctedInId).source, 'Admin-added');
  assert.equal(review.streams.records.find(item => item.punchId === voidPunchId).status, 'VOID');
  assert.deepEqual(review.streams.audit.map(item => item.linkedPunchId), [voidPunchId, correctedInId]);

  for (const [name, sheet] of harness.sheets) {
    assert.deepEqual(sheet.values, before.get(name), `${name} rows remain byte-for-byte equivalent`);
    assert.deepEqual(sheet.operations, [], `${name} receives no write operation`);
  }
});

test('maximum-length Unicode records stay under the receiver byte ceiling across every page', () => {
  const staffId = 'unicode-test';
  const staffName = `${'測'.repeat(90)} TEST`;
  const rows = ordinaryPeriodTimeRows({
    count: 500,
    startIndex: 20_000,
    date: '2026-08-18',
    staffId,
    staffName
  });
  for (const row of rows) {
    row[6] = `${'測'.repeat(75)} TEST`;
    row[7] = `${'測'.repeat(115)} TEST`;
    row[8] = `${'測'.repeat(115)} TEST`;
    row[9] = '測'.repeat(400);
  }
  const harness = createHarness({
    staffRows: [[staffId, staffName, true]],
    timeRows: rows
  });
  const before = structuredClone(harness.sheets.get('Staff Time').values);

  const snapshot = readPagedStaffView(harness);
  assert.equal(snapshot.initial.view.recordCount, rows.length);
  assert.equal(snapshot.initial.view.todayPunchCount, rows.length);
  assert.ok(snapshot.pageSizes.records.length > 1, 'byte ceiling splits a nominal 500-item page');
  assert.equal(snapshot.pageSizes.records.reduce((sum, size) => sum + size, 0), rows.length);
  assert.ok(snapshot.pageSizes.records.every(size => size > 0 && size <= 500));
  assert.ok(snapshot.pageByteLengths.records.every(size => size <= 80_000));
  assert.deepEqual(
    snapshot.streams.records.map(record => record.punchId),
    rows.map(row => row[0]).reverse(),
    'variable pages assemble every Unicode record once in deterministic newest-first order'
  );
  assert.deepEqual(harness.sheets.get('Staff Time').values, before);
  assert.deepEqual(harness.sheets.get('Staff Time').operations, []);
});

test('Admin audit projection keeps only cross-linked included records when more than 500 adjustments reorder', () => {
  const rows = ordinaryPeriodTimeRows({
    count: 502,
    startIndex: 70_000,
    date: '2026-08-18',
    staffId: 'mandy-test',
    staffName: 'Mandy Test'
  });
  rows.forEach(row => {
    row[7] = 'Admin Staff time';
    row[8] = 'm1b-test-build';
    row[9] = 'Admin correction evidence';
    row[11] = 'Admin-added';
    row[12] = 'Andrew Smith';
  });
  const auditRows = rows.map((row, index) => {
    const actionSeconds = (15 * 60 * 60) + (rows.length - 1 - index);
    const hour = String(Math.floor(actionSeconds / 3600)).padStart(2, '0');
    const minute = String(Math.floor((actionSeconds % 3600) / 60)).padStart(2, '0');
    const second = String(actionSeconds % 60).padStart(2, '0');
    return [
      generatedRequestId(70_000 + index),
      `2026-08-18T${hour}:${minute}:${second}-04:00`,
      'Andrew Smith',
      'mandy-test',
      'Mandy Test',
      row[1],
      row[5],
      'Added missing TEST punch',
      'added',
      row[0]
    ];
  });
  const harness = createHarness({ timeRows: rows, auditRows });
  const beforeTime = structuredClone(harness.sheets.get('Staff Time').values);
  const beforeAudit = structuredClone(harness.sheets.get('Staff Time Audit').values);
  const review = readPagedStaffView(harness, { admin: true });

  assert.equal(review.initial.view.recordCount, 500);
  assert.equal(review.initial.view.recordTotal, 502);
  assert.equal(review.initial.view.adjustmentCount, 500);
  assert.equal(review.initial.view.adjustmentTotal, 502);
  assert.equal(review.initial.view.auditCount, 500);
  assert.equal(review.initial.view.auditTotal, 502);
  assert.equal(review.initial.view.recordsTruncated, true);
  assert.equal(review.initial.view.auditTruncated, true);
  const includedIds = new Set(review.streams.records.map(item => item.punchId));
  assert.equal(includedIds.has(rows[0][0]), false);
  assert.equal(includedIds.has(rows[1][0]), false);
  assert.ok(review.streams.audit.every(item => includedIds.has(item.linkedPunchId)));
  assert.deepEqual(review.streams.audit.slice(0, 2).map(item => item.linkedPunchId), [
    rows[2][0],
    rows[3][0]
  ], 'audit action order cannot reintroduce records omitted by record priority');
  assert.ok(review.pageByteLengths.audit.every(size => size <= 80_000));
  assert.deepEqual(harness.sheets.get('Staff Time').values, beforeTime);
  assert.deepEqual(harness.sheets.get('Staff Time Audit').values, beforeAudit);
  assert.deepEqual(harness.sheets.get('Staff Time').operations, []);
  assert.deepEqual(harness.sheets.get('Staff Time Audit').operations, []);
});

test('paged Staff Clock views are deterministic and reject stale or noncanonical pages', () => {
  const harness = createHarness({
    timeRows: [
      timeRow({ punchId: IDS.in }),
      timeRow({ punchId: IDS.out, timestamp: '2026-08-18T10:00:00-04:00', action: 'clockOut' })
    ]
  });
  const first = harness.post(receiverBody('staffClockSnapshotV2'));
  const replay = harness.post(receiverBody('staffClockSnapshotV2'));
  assert.match(first.view.token, /^[0-9a-f]{64}$/u);
  assert.equal(replay.view.token, first.view.token);

  for (const fields of [
    { viewToken: ` ${first.view.token}`, stream: 'records', offset: 0 },
    { viewToken: first.view.token.toUpperCase(), stream: 'records', offset: 0 },
    { viewToken: first.view.token, stream: ' records', offset: 0 },
    { viewToken: first.view.token, stream: 'audit', offset: 0 },
    { viewToken: first.view.token, stream: 'records', offset: first.view.recordCount }
  ]) {
    assert.deepEqual(harness.post(receiverBody('staffClockSnapshotPageV2', fields)), {
      ok: false,
      target: 'test',
      result: 'rejected'
    });
  }

  harness.sheets.get('Staff Clock Staff').values[1][2] = false;
  assert.deepEqual(harness.post(receiverBody('staffClockSnapshotPageV2', {
    viewToken: first.view.token,
    stream: 'records',
    offset: 0
  })), {
    ok: false,
    target: 'test',
    result: 'stale'
  });
});

test('immutable cached pages never rebuild Sheets and an evicted page forces one summary rebuild', () => {
  const harness = createHarness({
    timeRows: [
      timeRow({ punchId: IDS.in }),
      timeRow({ punchId: IDS.out, timestamp: '2026-08-18T10:00:00-04:00', action: 'clockOut' })
    ]
  });
  const timeSheet = harness.sheets.get('Staff Time');
  const auditSheet = harness.sheets.get('Staff Time Audit');
  const first = harness.post(receiverBody('staffClockSnapshotV2'));
  assert.equal(first.ok, true);
  assert.equal(timeSheet.dataRangeReads, 1, 'first summary performs one authoritative Time build');
  assert.equal(auditSheet.dataRangeReads, 0, 'kiosk summary never performs a full Audit read');

  const replay = harness.post(receiverBody('staffClockSnapshotV2'));
  assert.equal(replay.view.token, first.view.token);
  assert.equal(timeSheet.dataRangeReads, 1, 'same signature reuses the cached immutable summary');

  const pageRequest = {
    viewToken: first.view.token,
    stream: 'records',
    offset: 0
  };
  assert.equal(harness.post(receiverBody('staffClockSnapshotPageV2', pageRequest)).ok, true);
  assert.equal(timeSheet.dataRangeReads, 1, 'a valid page reads only lightweight state and cache');
  assert.deepEqual(harness.post(receiverBody('staffClockSnapshotPageV2', {
    ...pageRequest,
    viewToken: 'f'.repeat(64)
  })), { ok: false, target: 'test', result: 'stale' });
  assert.equal(timeSheet.dataRangeReads, 1, 'a random valid-shape token never scans Staff Time');

  const pageKey = [...harness.cacheValues.keys()].find(key => (
    key.includes(`-page-${first.view.token}-records-0`)
  ));
  assert.ok(pageKey, 'the bounded page is cached under its immutable token and offset');
  harness.cacheValues.delete(pageKey);
  assert.deepEqual(harness.post(receiverBody('staffClockSnapshotPageV2', pageRequest)), {
    ok: false,
    target: 'test',
    result: 'stale'
  });
  assert.equal(timeSheet.dataRangeReads, 1, 'cache eviction fails stale without a hidden full rebuild');

  const rebuilt = harness.post(receiverBody('staffClockSnapshotV2'));
  assert.equal(rebuilt.view.token, first.view.token);
  assert.equal(timeSheet.dataRangeReads, 2, 'one summary retry performs exactly one rebuild');
  assert.equal(harness.post(receiverBody('staffClockSnapshotV2')).view.token, rebuilt.view.token);
  assert.equal(timeSheet.dataRangeReads, 2, 'the rebuilt token is cached again');
});

test('repeated unresolved occurrences collapse by staff and code with newest evidence retained', () => {
  const firstIn = generatedPunchId(60_000);
  const firstOut = generatedPunchId(60_001);
  const latestIn = generatedPunchId(60_002);
  const latestOut = generatedPunchId(60_003);
  const harness = createHarness({
    timeRows: [
      timeRow({ punchId: firstIn, timestamp: '2026-08-15T00:00:00-04:00' }),
      timeRow({ punchId: firstOut, timestamp: '2026-08-15T19:00:01-04:00', action: 'clockOut' }),
      timeRow({ punchId: latestIn, timestamp: '2026-08-16T00:00:00-04:00' }),
      timeRow({ punchId: latestOut, timestamp: '2026-08-16T19:00:01-04:00', action: 'clockOut' })
    ]
  });
  const view = readPagedStaffView(harness);
  assert.equal(view.initial.view.attentionCount, 1);
  assert.equal(view.initial.view.attentionOccurrenceCount, 2);
  assert.deepEqual(view.streams.attention, [{
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    code: 'shift_too_long',
    message: 'Mandy Test has an unreasonably long shift.',
    linkedPunchIds: [latestIn, latestOut],
    occurrenceCount: 2
  }]);
  assert.deepEqual(view.streams.records.slice(0, 2).map(item => item.punchId), [
    latestOut,
    latestIn
  ]);
});

test('Netlify-produced requests and strict sanitizers accept every receiver success envelope', () => {
  const harness = createHarness();
  const now = new Date(NOW_ISO);
  const inputPunch = punch();
  const sync = harness.post(receiverBody('staffClockPunch', { punches: [inputPunch] }));
  assert.ok(sanitizeStaffClockSyncResults(sync, [inputPunch], 'test'));

  const snapshot = readPagedStaffView(harness);
  assert.ok(snapshot.initial);

  const expectedCorrection = {
    requestId: IDS.request,
    punchId: IDS.correction,
    timestamp: '2026-08-17T09:00:00-04:00',
    date: '2026-08-17',
    staffId: 'front-desk-test-two',
    staffName: 'Front Desk Test Two',
    punchAction: 'clockIn',
    reason: 'Forgotten TEST punch',
    adminName: 'Andrew Smith',
    site: 'Rev',
    device: 'Admin Staff time',
    build: 'm1b-test-build'
  };
  const corrected = harness.post(correction());
  assert.ok(sanitizeStaffTimeCorrectionResult(corrected, expectedCorrection, 'test'));

  const review = readPagedStaffView(harness, { admin: true });
  assert.ok(review.initial);

  const expectedVoid = {
    requestId: IDS.voidRequest,
    punchId: IDS.in,
    reason: 'Wrong TEST punch',
    adminName: 'Andrew Smith'
  };
  const voided = harness.post(adminBody('staffTimeVoid', expectedVoid));
  assert.ok(sanitizeStaffTimeVoidResult(voided, expectedVoid, 'test', { now }));
});
