import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  sanitizeStaffClockSnapshot,
  sanitizeStaffClockSyncResults,
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
  voidRequestTwo: 'gib-m1-staff-request-10000000-0000-4000-8000-000000000003'
});

function makeSheet(initialRows = []) {
  const values = initialRows.map(row => [...row]);
  const operations = [];
  let maxRows = Math.max(1000, values.length);
  let frozenRows = 0;
  return {
    values,
    operations,
    appendRow(row) { values.push([...row]); },
    deleteRow(rowNumber) { values.splice(rowNumber - 1, 1); },
    getDataRange() { return { getValues: () => values.map(row => [...row]) }; },
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
    setFrozenRows(count) { frozenRows = count; },
    get frozenRows() { return frozenRows; },
    getMaxRows() { return maxRows; },
    insertRowsAfter(_row, count) { maxRows += count; }
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
  let spreadsheetOpens = 0;
  const context = {
    module: { exports: {} }, exports: {}, console, Date: FixedDate,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) { return { text, setMimeType() { return this; } }; }
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
      formatDate
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

test('TEST provisioner creates only the exact Staff Clock tabs and fake active seed', () => {
  const harness = createHarness({ includeStaffSheets: false });
  const signinsBefore = structuredClone(harness.signins.values);
  const adminAuditBefore = structuredClone(harness.adminAudit.values);
  const result = harness.apps.provisionGibM1TestReceiver();

  assert.deepEqual(harness.sheets.get('Staff Clock Staff').values, [STAFF_HEADERS, ...STAFF_ROWS]);
  assert.deepEqual(harness.sheets.get('Staff Time').values, [TIME_HEADERS]);
  assert.deepEqual(harness.sheets.get('Staff Time Audit').values, [AUDIT_HEADERS]);
  assert.equal(harness.sheets.get('Staff Clock Staff').frozenRows, 1);
  assert.equal(result.staffCount, 3);
  assert.equal(result.staffTimeCount, 0);
  assert.equal(result.staffAuditCount, 0);
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

test('a stored near-future open punch is attention, not clocked-in state', () => {
  const harness = createHarness({
    timeRows: [timeRow({ timestamp: '2026-08-18T18:04:00-04:00' })]
  });
  const review = harness.post(adminBody('staffTimeReview'));
  assert.deepEqual(review.needsAttention.map(issue => issue.code), ['future_punch']);
  assert.deepEqual(review.clockedInNow, []);
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

test('Netlify-produced requests and strict sanitizers accept every receiver success envelope', () => {
  const harness = createHarness();
  const now = new Date(NOW_ISO);
  const inputPunch = punch();
  const sync = harness.post(receiverBody('staffClockPunch', { punches: [inputPunch] }));
  assert.ok(sanitizeStaffClockSyncResults(sync, [inputPunch], 'test'));

  const snapshot = harness.post(receiverBody('staffClockSnapshot'));
  assert.ok(sanitizeStaffClockSnapshot(snapshot, 'test', { now }));

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

  const review = harness.post(adminBody('staffTimeReview'));
  assert.ok(sanitizeStaffTimeReview(review, 'test', { now }));

  const expectedVoid = {
    requestId: IDS.voidRequest,
    punchId: IDS.in,
    reason: 'Wrong TEST punch',
    adminName: 'Andrew Smith'
  };
  const voided = harness.post(adminBody('staffTimeVoid', expectedVoid));
  assert.ok(sanitizeStaffTimeVoidResult(voided, expectedVoid, 'test', { now }));
});
