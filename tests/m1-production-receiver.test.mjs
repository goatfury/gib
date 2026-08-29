import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const wrapperSource = read('integrations/google-apps-script/production/Code.gs');
const receiverSource = read('integrations/google-apps-script/GibM1Receiver.gs');
const manifest = JSON.parse(read('integrations/google-apps-script/production/appsscript.json'));
const claspIgnore = read('integrations/google-apps-script/production/.claspignore');
const projectGitIgnore = read('integrations/google-apps-script/production/.gitignore');

const EXPECTED_TITLE = 'RBJJ M1 \u2014 PRODUCTION';
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
const ADMIN_AUDIT_HEADERS = Object.freeze([
  'Action Number', 'Admin Name', 'Action Time', 'Instructor', 'Class Date',
  'Class', 'Site', 'Duration', 'Required Reason', 'Final Result',
  'Linked Sign-in Record ID'
]);
const STAFF_HEADERS = Object.freeze(['Staff ID', 'Staff Name', 'Active']);
const STAFF_ROWS = Object.freeze([Object.freeze(['mandy', 'Mandy', true])]);
const STAFF_TIME_HEADERS = Object.freeze([
  'Punch ID',
  'Timestamp',
  'Date',
  'Staff ID',
  'Staff Name',
  'Action',
  'Site',
  'Device',
  'Build',
  'Note',
  'Status',
  'Source',
  'Admin Name',
  'Linked Punch ID'
]);
const STAFF_AUDIT_HEADERS = Object.freeze([
  'Request ID',
  'Action Time',
  'Admin Name',
  'Staff ID',
  'Staff Name',
  'Punch Timestamp',
  'Action',
  'Required Reason',
  'Result',
  'Linked Punch ID'
]);
const ROW_ID = 'gib-m1-12345678-1234-4123-8123-123456789abc';
const STAFF_PUNCH_ID = 'gib-m1-staff-20000000-0000-4000-8000-000000000001';
const STAFF_REQUEST_ID = 'gib-m1-staff-request-20000000-0000-4000-8000-000000000002';
const NOW_ISO = '2026-08-19T16:00:00.000Z';

function makeSheet(initialRows = [], onWrite = () => {}) {
  const values = initialRows.map(row => [...row]);
  const numberFormats = new Map();
  let maxRows = Math.max(1000, values.length);
  let frozenRows = 0;
  let dataRangeReads = 0;
  return {
    values,
    numberFormats,
    appendRow(row) {
      onWrite('appendRow');
      values.push([...row]);
    },
    get frozenRows() { return frozenRows; },
    deleteRow(rowNumber) {
      onWrite('deleteRow');
      values.splice(rowNumber - 1, 1);
    },
    getDataRange() {
      dataRangeReads += 1;
      return { getValues: () => values.map(row => [...row]) };
    },
    get dataRangeReads() { return dataRangeReads; },
    getLastRow() {
      return values.length;
    },
    getLastColumn() {
      let lastColumn = 0;
      values.forEach(row => row.forEach((value, index) => {
        if (value !== '' && value != null) lastColumn = Math.max(lastColumn, index + 1);
      }));
      return lastColumn;
    },
    getRange(startRow, startColumn, rowCount, columnCount) {
      return {
        getValues() {
          return Array.from({ length: rowCount }, (_unused, rowOffset) => {
            const source = values[startRow - 1 + rowOffset] || [];
            return Array.from({ length: columnCount }, (_unusedColumn, columnOffset) => (
              source[startColumn - 1 + columnOffset] ?? ''
            ));
          });
        },
        setValues(rows) {
          onWrite('setValues');
          rows.forEach((source, rowOffset) => {
            const rowIndex = startRow - 1 + rowOffset;
            if (!values[rowIndex]) values[rowIndex] = [];
            source.forEach((value, columnOffset) => {
              values[rowIndex][startColumn - 1 + columnOffset] = value;
            });
          });
          return this;
        },
        setValue(value) {
          onWrite('setValue');
          if (!values[startRow - 1]) values[startRow - 1] = [];
          values[startRow - 1][startColumn - 1] = value;
          return this;
        },
        setNumberFormat(format) {
          onWrite('setNumberFormat');
          for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
            for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
              numberFormats.set(`${startRow + rowOffset}:${startColumn + columnOffset}`, format);
            }
          }
          return this;
        }
      };
    },
    getMaxRows() {
      return maxRows;
    },
    insertRowsAfter(_afterRow, count) {
      onWrite('insertRowsAfter');
      maxRows += count;
    },
    setFrozenRows(count) {
      onWrite('setFrozenRows');
      frozenRows = count;
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

function sheetRow(row, status = 'OK') {
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

function kioskRow(overrides = {}) {
  return {
    RowID: ROW_ID,
    Timestamp: '2026-08-06 09:00:00',
    Date: '2026-08-06',
    'Class Label': '9:00 AM BJJ',
    'Duration (hr)': 1,
    Instructor: 'Real Instructor',
    Site: 'Rev BJJ',
    Device: 'Production kiosk',
    Build: 'm1-production-candidate',
    Notes: '',
    ...overrides
  };
}

function staffPunch(overrides = {}) {
  return {
    punchId: STAFF_PUNCH_ID,
    timestamp: '2026-08-19T09:00:00-04:00',
    date: '2026-08-19',
    staffId: 'mandy',
    staffName: 'Mandy',
    punchAction: 'clockIn',
    site: 'Rev',
    device: 'Production tablet',
    build: 'm1b-production-release',
    note: '',
    ...overrides
  };
}

function generatedStaffPunchId(index) {
  return `gib-m1-staff-30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function staffTimeRow(overrides = {}) {
  const value = staffPunch(overrides);
  return [
    value.punchId,
    value.timestamp,
    value.date,
    value.staffId,
    value.staffName,
    value.punchAction,
    value.site,
    value.device,
    value.build,
    value.note,
    overrides.status || 'ACTIVE',
    overrides.source || 'Tablet',
    overrides.adminName || '',
    overrides.linkedPunchId || ''
  ];
}

function staffAuditRow(overrides = {}) {
  return [
    overrides.requestId || STAFF_REQUEST_ID,
    overrides.actionTime || '2026-08-19T11:00:00-04:00',
    overrides.adminName || 'Andrew Smith',
    overrides.staffId || 'mandy',
    overrides.staffName || 'Mandy',
    overrides.punchTimestamp || '2026-08-18T09:00:00-04:00',
    overrides.action || 'clockIn',
    overrides.reason || 'Forgotten punch',
    overrides.result || 'added',
    overrides.linkedPunchId || STAFF_PUNCH_ID
  ];
}

function createFile(id) {
  return {
    getId: () => id,
    getMimeType: () => 'application/vnd.google-apps.spreadsheet',
    isTrashed: () => false
  };
}

function createHarness({
  initialRows = [SIGNIN_HEADERS],
  propertyValues: initialProperties = {},
  driveMatchCount = 1,
  wrapper = true,
  strictWithoutWrapper = false,
  includeStaffSheets = false,
  staffRows = STAFF_ROWS,
  timeRows = [],
  auditRows = [],
  nowIso = NOW_ISO
} = {}) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowIso])); }
    static now() { return Date.parse(nowIso); }
  }
  const propertyValues = new Map(Object.entries({
    GIB_M1_PRODUCTION_SPREADSHEET_ID: 'production-spreadsheet-id',
    GIB_M1_DEPLOYMENT_TARGET_LOCK: 'production',
    GIB_M1_RECEIVER_TRANSPORT_TOKEN: '',
    GIB_M1_LEGACY_KIOSK_TOKEN: 'production-legacy-token',
    GIB_M1_ADMIN_ACTION_TOKEN: 'production-admin-token',
    GIB_M1_RECOVERY_TOKEN: 'production-recovery-token',
    GIB_M1_PROVISIONING_CLOSED: 'closed-v1',
    ...initialProperties
  }));
  const sheetWriteEvents = [];
  const propertyWriteEvents = [];
  const cacheValues = new Map();
  const spreadsheetRevision = Date.parse('2026-08-19T12:00:00-04:00');
  const recordSheetWrite = operation => sheetWriteEvents.push(operation);
  let signins = initialRows === null ? null : makeSheet(initialRows, recordSheetWrite);
  const sheets = new Map();
  if (signins) sheets.set('Signins', signins);
  if (includeStaffSheets) {
    sheets.set('Staff Clock Staff', makeSheet([STAFF_HEADERS, ...staffRows], recordSheetWrite));
    sheets.set('Staff Time', makeSheet([STAFF_TIME_HEADERS, ...timeRows], recordSheetWrite));
    sheets.set('Staff Time Audit', makeSheet([STAFF_AUDIT_HEADERS, ...auditRows], recordSheetWrite));
  }
  let spreadsheetOpens = 0;
  let spreadsheetCreates = 0;
  let driveQueries = 0;
  const spreadsheetId = 'production-spreadsheet-id';
  const spreadsheet = {
    getId: () => spreadsheetId,
    getName: () => EXPECTED_TITLE,
    getSheetByName(name) {
      return sheets.get(name) || null;
    },
    insertSheet(name) {
      recordSheetWrite('insertSheet');
      if (name === 'Signins') {
        signins = makeSheet([], recordSheetWrite);
        sheets.set(name, signins);
        return signins;
      }
      if (name === 'Admin Audit') {
        const adminAudit = makeSheet([], recordSheetWrite);
        sheets.set(name, adminAudit);
        return adminAudit;
      }
      assert.fail(`Unexpected sheet insertion: ${name}`);
    }
  };
  let files = Array.from({ length: driveMatchCount }, (_unused, index) => (
    createFile(index === 0 ? spreadsheetId : `duplicate-spreadsheet-${index}`)
  ));
  const scriptId = 'private-production-script-id';
  const derivedToken = createHash('sha256')
    .update(`gib-m1-production:${scriptId}`, 'utf8')
    .digest('base64url');
  const provisioningSecret = createHash('sha256')
    .update(`gib-m1-production-provisioning:${scriptId}`, 'utf8')
    .digest('base64url');

  const context = {
    module: { exports: {} },
    exports: {},
    console,
    Date: FixedDate,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return { text, setMimeType() { return this; } };
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: key => cacheValues.get(key) || null,
        put(key, value) { cacheValues.set(key, String(value)); },
        remove(key) { cacheValues.delete(key); },
        removeAll(keys) { keys.forEach(key => cacheValues.delete(key)); }
      })
    },
    DriveApp: {
      getFileById(id) {
        assert.equal(id, spreadsheetId);
        return { getLastUpdated: () => new Date(spreadsheetRevision) };
      },
      getFilesByName(title) {
        driveQueries += 1;
        assert.equal(title, EXPECTED_TITLE);
        let index = 0;
        return {
          hasNext: () => index < files.length,
          next: () => files[index++]
        };
      }
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} })
    },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => propertyValues.get(name) || '',
        setProperty(name, value) {
          propertyWriteEvents.push({ operation: 'setProperty', names: [name] });
          propertyValues.set(name, String(value));
          return this;
        },
        setProperties(values, deleteAllOthers = false) {
          propertyWriteEvents.push({
            operation: 'setProperties',
            names: Object.keys(values).sort()
          });
          if (deleteAllOthers) propertyValues.clear();
          for (const [name, value] of Object.entries(values)) {
            propertyValues.set(name, String(value));
          }
          return this;
        }
      })
    },
    ScriptApp: { getScriptId: () => scriptId },
    SpreadsheetApp: {
      create(title) {
        spreadsheetCreates += 1;
        assert.equal(title, EXPECTED_TITLE);
        files = [createFile(spreadsheetId)];
        return spreadsheet;
      },
      openById(id) {
        spreadsheetOpens += 1;
        assert.equal(id, spreadsheetId);
        return spreadsheet;
      },
      flush() {}
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64EncodeWebSafe(bytes) {
        assert.ok(bytes.every(value => Number.isInteger(value) && value >= -128 && value <= 127));
        return Buffer.from(bytes.map(value => value < 0 ? value + 256 : value)).toString('base64url');
      },
      base64DecodeWebSafe(value) {
        return [...Buffer.from(String(value), 'base64url')];
      },
      computeDigest(_algorithm, value, charset) {
        assert.equal(charset, 'UTF_8');
        return [...createHash('sha256').update(String(value), 'utf8').digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      },
      computeHmacSha256Signature(value, secret, charset) {
        assert.equal(charset, 'UTF_8');
        return [...createHmac('sha256', String(secret)).update(String(value), 'utf8').digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      },
      newBlob(value) {
        return {
          getBytes: () => [...Buffer.from(String(value), 'utf8')]
        };
      },
      formatDate
    }
  };
  if (!wrapper) {
    context.SPREADSHEET_ID = spreadsheetId;
    context.EXPECTED_SPREADSHEET_NAME = EXPECTED_TITLE;
    context.SHEET_NAME = 'Signins';
    if (strictWithoutWrapper) context.GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK = true;
  }
  const vmContext = vm.createContext(context);
  if (wrapper) vm.runInContext(wrapperSource, vmContext);
  vm.runInContext(receiverSource, vmContext);
  return {
    apps: vmContext,
    derivedToken,
    provisioningSecret,
    propertyValues,
    cacheValues,
    sheets,
    get signins() { return signins; },
    get spreadsheetOpens() { return spreadsheetOpens; },
    get spreadsheetCreates() { return spreadsheetCreates; },
    get driveQueries() { return driveQueries; },
    get sheetWrites() { return sheetWriteEvents.length; },
    get sheetWriteEvents() { return [...sheetWriteEvents]; },
    get propertyWrites() { return propertyWriteEvents.length; },
    get propertyWriteEvents() { return propertyWriteEvents.map(event => ({ ...event })); },
    post(body) {
      const event = {
        postData: { contents: JSON.stringify(body) }
      };
      const output = wrapper ? vmContext.doPost(event) : vmContext.adReceiverV2_(event);
      return JSON.parse(output.text);
    }
  };
}

function provisioningRequest(harness, overrides = {}) {
  return {
    action: 'provisionProductionReceiver',
    target: 'production',
    provisioningSecret: harness.provisioningSecret,
    ...overrides
  };
}

function assertBooleanCountResponse(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  for (const [key, item] of Object.entries(value)) {
    assert.ok(
      typeof item === 'boolean' || (Number.isInteger(item) && item >= 0),
      `Provisioning response field ${key} must be a sanitized boolean or count.`
    );
  }
}

function assertNoProvisioningAccess(harness) {
  assert.equal(harness.driveQueries, 0);
  assert.equal(harness.spreadsheetOpens, 0);
  assert.equal(harness.spreadsheetCreates, 0);
  assert.equal(harness.sheetWrites, 0);
  assert.equal(harness.propertyWrites, 0);
}

test('production package is separate, locked, executable, and contains no private identifier', () => {
  assert.match(wrapperSource, /var GIB_M1_ALLOWED_TARGET = 'production'/u);
  assert.match(wrapperSource, /var GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK = true/u);
  assert.match(wrapperSource, /var GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE = false/u);
  assert.match(wrapperSource, /var GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA = true/u);
  assert.match(wrapperSource, /RBJJ M1 \u2014 PRODUCTION/u);
  assert.match(wrapperSource, /var GIB_M1_PROVISION_ACTION_ = 'provisionProductionReceiver'/u);
  assert.match(wrapperSource, /gib-m1-production-provisioning:/u);
  assert.match(wrapperSource, /var GIB_M1_PROVISIONING_CLOSED_VALUE_ = 'closed-v1'/u);
  assert.match(
    wrapperSource,
    /function doPost\(e\)[\s\S]*gibM1HandleProductionProvisioningPost_\(e\)[\s\S]*return adReceiverV2_\(e\)/u
  );
  assert.doesNotMatch(wrapperSource, /function doGet\s*\(/u);
  assert.doesNotMatch(wrapperSource, /RBJJ M1 \u2014 TEST|GIB_M1_TEST_SPREADSHEET_TITLE_/u);
  assert.match(wrapperSource, /forbiddenSpreadsheetProperty: 'GIB_M1_TEST_SPREADSHEET_ID'/u);
  assert.doesNotMatch(wrapperSource, /AKfy[A-Za-z0-9_-]{20,}|\b1[A-Za-z0-9_-]{30,}\b/u);
  assert.deepEqual(manifest.webapp, {
    access: 'ANYONE_ANONYMOUS',
    executeAs: 'USER_DEPLOYING'
  });
  assert.equal(Object.hasOwn(manifest, 'executionApi'), false);
  assert.match(claspIgnore, /!Code\.gs/u);
  assert.match(claspIgnore, /!GibM1Receiver\.gs/u);
  assert.match(projectGitIgnore, /^\.clasp\.json$/mu);
  assert.match(projectGitIgnore, /^credentials\*\.json$/mu);
});

test('production accepts a real instructor and permanently replays one UUID only once', () => {
  const harness = createHarness();
  const request = {
    token: harness.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow()]
  };
  const first = harness.post(request);
  const replay = harness.post(request);
  assert.equal(first.ok, true);
  assert.equal(first.target, 'production');
  assert.equal(first.results[0].result, 'added');
  assert.equal(replay.results[0].result, 'already exists');
  assert.equal(harness.signins.values.length, 2);
  assert.equal(harness.signins.values[1][5], 'Real Instructor');
});

test('Revolution production preserves a first-fold Admin instant and fails ambiguous delayed work closed', () => {
  const harness = createHarness({ nowIso: '2026-11-01T05:30:00.000Z' });
  const event = kioskRow({
    RowID: 'gib-m1-60606060-6060-4060-8060-606060606060',
    Timestamp: '2026-11-01 01:15:00',
    Date: '2026-11-01'
  });
  const added = harness.post({
    token: harness.derivedToken,
    adminActionToken: 'production-admin-token',
    action: 'addMissedInstructor',
    target: 'production',
    requestId: 'rev-dst-not-synced',
    adminName: 'Andrew Smith',
    date: event.Date,
    classLabel: event['Class Label'],
    duration: event['Duration (hr)'],
    instructor: event.Instructor,
    site: event.Site,
    notes: event.Notes,
    reason: 'Not Synced'
  });
  assert.equal(added.result, 'added');
  const audit = harness.sheets.get('Admin Audit');
  assert.deepEqual(audit.values[0], [...ADMIN_AUDIT_HEADERS]);
  assert.equal(audit.values[1][2], '2026-11-01T05:30:00.000Z');
  assert.equal(audit.numberFormats.get('2:3'), '@');

  const signinsBefore = structuredClone(harness.signins.values);
  const auditBefore = structuredClone(audit.values);
  const request = {
    token: harness.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [event]
  };
  assert.deepEqual(harness.post(request).results, [{
    rowId: event.RowID,
    result: 'rejected',
    linkedRecordId: ''
  }]);
  assert.equal(harness.post(request).results[0].result, 'rejected');
  assert.deepEqual(harness.signins.values, signinsBefore);
  assert.deepEqual(audit.values, auditBefore);
});

test('production rejects changed, VOID, or duplicate stored permanent RowIDs without append', () => {
  const base = kioskRow();
  const changed = createHarness({ initialRows: [SIGNIN_HEADERS, sheetRow(base)] });
  assert.equal(changed.post({
    token: changed.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [{ ...base, Notes: 'changed' }]
  }).results[0].result, 'rejected');
  assert.equal(changed.signins.values.length, 2);

  const voided = createHarness({ initialRows: [SIGNIN_HEADERS, sheetRow(base, 'VOID')] });
  assert.equal(voided.post({
    token: voided.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [base]
  }).results[0].result, 'rejected');
  assert.equal(voided.signins.values.length, 2);

  const duplicated = createHarness({
    initialRows: [SIGNIN_HEADERS, sheetRow(base), sheetRow(base)]
  });
  assert.equal(duplicated.post({
    token: duplicated.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [base]
  }).results[0].result, 'rejected');
  assert.equal(duplicated.signins.values.length, 3);
});

test('production requires the permanent UUID format', () => {
  const harness = createHarness();
  const response = harness.post({
    token: harness.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow({ RowID: 'legacy-row-id' })]
  });
  assert.equal(response.results[0].result, 'rejected');
  assert.equal(harness.signins.values.length, 1);
});

test('production runtime fails closed if the exact Signins schema drifts', () => {
  const headers = [...SIGNIN_HEADERS];
  headers[2] = 'Wrong Date';
  const harness = createHarness({ initialRows: [headers] });
  const response = harness.post({
    token: harness.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow()]
  });
  assert.equal(response.result, 'failed');
  assert.equal(harness.signins.values.length, 1);
});

test('production wrapper returns the complete read-only Daily Review contract', () => {
  const harness = createHarness({
    initialRows: [SIGNIN_HEADERS, sheetRow(kioskRow())]
  });
  const response = harness.post({
    token: harness.derivedToken,
    adminActionToken: 'production-admin-token',
    action: 'dailyReview',
    target: 'production',
    date: '2026-08-06'
  });
  assert.deepEqual(Object.keys(response).sort(), [
    'auditHistory',
    'date',
    'ok',
    'records',
    'warnings'
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.date, '2026-08-06');
  assert.equal(response.records.length, 1);
  assert.equal(response.records[0].displayId, 'sheet-row-2');
  assert.equal(response.records[0].recordId, ROW_ID);
  assert.equal(response.records[0].source, 'Kiosk');
  assert.deepEqual(response.warnings, []);
  assert.deepEqual(response.auditHistory, []);
  assert.equal(harness.sheetWrites, 0);
  assert.equal(harness.propertyWrites, 0);
});

test('production Staff Clock reads only Mandy from exact empty tabs without writing', () => {
  const harness = createHarness({ includeStaffSheets: true });
  const signinsBefore = structuredClone(harness.signins.values);
  const snapshot = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotV2',
    target: 'production'
  });
  const snapshotToken = snapshot.view.token;
  assert.match(snapshotToken, /^[0-9a-f]{64}$/u);

  assert.deepEqual(snapshot, {
    ok: true,
    target: 'production',
    staff: [{ staffId: 'mandy', staffName: 'Mandy' }],
    clockedInNow: [],
    periods: {
      current: {
        startDate: '2026-08-10',
        endDate: '2026-08-23',
        totals: [{
          staffId: 'mandy',
          staffName: 'Mandy',
          completedShifts: 0,
          totalSeconds: 0,
          needsAttention: false
        }]
      },
      previous: {
        startDate: '2026-07-27',
        endDate: '2026-08-09',
        totals: [{
          staffId: 'mandy',
          staffName: 'Mandy',
          completedShifts: 0,
          totalSeconds: 0,
          needsAttention: false
        }]
      }
    },
    view: {
      token: snapshotToken,
      today: '2026-08-19',
      recordCount: 0,
      recordTotal: 0,
      todayPunchCount: 0,
      todayPunchTotal: 0,
      adjustmentCount: 0,
      adjustmentTotal: 0,
      attentionCount: 0,
      attentionOccurrenceCount: 0,
      auditCount: 0,
      auditTotal: 0,
      recordsTruncated: false,
      auditTruncated: false
    }
  });

  const review = harness.post({
    token: harness.derivedToken,
    adminActionToken: 'production-admin-token',
    adminName: 'Andrew Smith',
    action: 'staffTimeReviewV2',
    target: 'production'
  });
  const reviewToken = review.view.token;
  assert.match(reviewToken, /^[0-9a-f]{64}$/u);
  assert.deepEqual(review, {
    ...snapshot,
    shiftStaff: [{ staffId: 'mandy', staffName: 'Mandy' }],
    view: {
      ...snapshot.view,
      token: reviewToken
    }
  });
  assert.notEqual(reviewToken, snapshotToken);

  const legacySnapshot = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshot',
    target: 'production'
  });
  assert.deepEqual(legacySnapshot, {
    ok: true,
    target: 'production',
    staff: [{ staffId: 'mandy', staffName: 'Mandy' }],
    records: []
  });
  const legacyReview = harness.post({
    token: harness.derivedToken,
    adminActionToken: 'production-admin-token',
    adminName: 'Andrew Smith',
    action: 'staffTimeReview',
    target: 'production'
  });
  assert.deepEqual(legacyReview, {
    ...legacySnapshot,
    audit: [],
    clockedInNow: [],
    todayPunches: [],
    needsAttention: [],
    periods: snapshot.periods
  });
  assert.deepEqual(harness.sheets.get('Staff Clock Staff').values, [STAFF_HEADERS, ...STAFF_ROWS]);
  assert.deepEqual(harness.sheets.get('Staff Time').values, [STAFF_TIME_HEADERS]);
  assert.deepEqual(harness.sheets.get('Staff Time Audit').values, [STAFF_AUDIT_HEADERS]);
  assert.deepEqual(harness.signins.values, signinsBefore);
  assert.equal(harness.sheetWrites, 0);
  assert.equal(harness.propertyWrites, 0);
});

test('production Staff Clock pages exact records and attention while Admin adds audit and stale tokens fail closed', () => {
  const timeRow = staffTimeRow({
    timestamp: '2026-08-18T09:00:00-04:00',
    date: '2026-08-18'
  });
  const auditRow = staffAuditRow();
  const harness = createHarness({
    includeStaffSheets: true,
    timeRows: [timeRow],
    auditRows: [auditRow]
  });
  const kioskSummary = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotV2',
    target: 'production'
  });
  assert.deepEqual(Object.keys(kioskSummary).sort(), [
    'clockedInNow',
    'ok',
    'periods',
    'staff',
    'target',
    'view'
  ]);
  assert.deepEqual(kioskSummary.clockedInNow, [{
    punchId: STAFF_PUNCH_ID,
    staffId: 'mandy',
    staffName: 'Mandy',
    clockInAt: '2026-08-18T09:00:00-04:00'
  }]);
  assert.deepEqual(kioskSummary.view, {
    token: kioskSummary.view.token,
    today: '2026-08-19',
    recordCount: 1,
    recordTotal: 1,
    todayPunchCount: 0,
    todayPunchTotal: 0,
    adjustmentCount: 0,
    adjustmentTotal: 0,
    attentionCount: 1,
    attentionOccurrenceCount: 1,
    auditCount: 0,
    auditTotal: 0,
    recordsTruncated: false,
    auditTruncated: false
  });
  assert.match(kioskSummary.view.token, /^[0-9a-f]{64}$/u);

  const recordsPage = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotPageV2',
    target: 'production',
    viewToken: kioskSummary.view.token,
    stream: 'records',
    offset: 0
  });
  assert.deepEqual(recordsPage, {
    ok: true,
    target: 'production',
    viewToken: kioskSummary.view.token,
    stream: 'records',
    offset: 0,
    items: [{
      punchId: STAFF_PUNCH_ID,
      timestamp: '2026-08-18T09:00:00-04:00',
      date: '2026-08-18',
      staffId: 'mandy',
      staffName: 'Mandy',
      punchAction: 'clockIn',
      site: 'Rev',
      device: 'Production tablet',
      build: 'm1b-production-release',
      note: '',
      status: 'ACTIVE',
      source: 'Tablet',
      adminName: '',
      linkedPunchId: ''
    }],
    nextOffset: null
  });
  const attentionPage = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotPageV2',
    target: 'production',
    viewToken: kioskSummary.view.token,
    stream: 'attention',
    offset: 0
  });
  assert.deepEqual(attentionPage, {
    ok: true,
    target: 'production',
    viewToken: kioskSummary.view.token,
    stream: 'attention',
    offset: 0,
    items: [{
      staffId: 'mandy',
      staffName: 'Mandy',
      code: 'missing_clock_out',
      message: 'Mandy may be missing a Clock Out.',
      linkedPunchIds: [STAFF_PUNCH_ID],
      occurrenceCount: 1
    }],
    nextOffset: null
  });
  assert.deepEqual(harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotPageV2',
    target: 'production',
    viewToken: kioskSummary.view.token,
    stream: 'audit',
    offset: 0
  }), { ok: false, target: 'production', result: 'rejected' });

  const adminSummary = harness.post({
    token: harness.derivedToken,
    adminActionToken: 'production-admin-token',
    action: 'staffTimeReviewV2',
    target: 'production'
  });
  assert.deepEqual(Object.keys(adminSummary).sort(), [
    'clockedInNow',
    'ok',
    'periods',
    'shiftStaff',
    'staff',
    'target',
    'view'
  ]);
  assert.equal(adminSummary.view.recordCount, 1);
  assert.equal(adminSummary.view.attentionCount, 1);
  assert.equal(adminSummary.view.auditCount, 1);
  assert.notEqual(adminSummary.view.token, kioskSummary.view.token);

  const auditPage = harness.post({
    token: harness.derivedToken,
    adminActionToken: 'production-admin-token',
    action: 'staffTimeReviewPageV2',
    target: 'production',
    viewToken: adminSummary.view.token,
    stream: 'audit',
    offset: 0
  });
  assert.deepEqual(auditPage, {
    ok: true,
    target: 'production',
    viewToken: adminSummary.view.token,
    stream: 'audit',
    offset: 0,
    items: [{
      requestId: STAFF_REQUEST_ID,
      actionTime: '2026-08-19T11:00:00-04:00',
      adminName: 'Andrew Smith',
      staffId: 'mandy',
      staffName: 'Mandy',
      punchTimestamp: '2026-08-18T09:00:00-04:00',
      operation: 'correct',
      punchAction: 'clockIn',
      reason: 'Forgotten punch',
      result: 'added',
      linkedPunchId: STAFF_PUNCH_ID
    }],
    nextOffset: null
  });

  harness.sheets.get('Staff Time').values.push(staffTimeRow({
    punchId: generatedStaffPunchId(999),
    timestamp: '2026-08-19T12:00:00-04:00',
    date: '2026-08-19',
    note: 'view changed'
  }));
  assert.deepEqual(harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotPageV2',
    target: 'production',
    viewToken: kioskSummary.view.token,
    stream: 'records',
    offset: 0
  }), { ok: false, target: 'production', result: 'stale' });
  assert.equal(harness.sheetWrites, 0);
  assert.equal(harness.propertyWrites, 0);
});

test('production Staff Clock page offsets follow the UTF-8 byte bound instead of fixed 500-row boundaries', () => {
  const unicodeNote = '界'.repeat(400);
  const timeRows = Array.from({ length: 500 }, (_unused, index) => staffTimeRow({
    punchId: generatedStaffPunchId(index + 1),
    timestamp: '2026-08-19T09:00:00-04:00',
    date: '2026-08-19',
    note: unicodeNote,
    status: 'VOID'
  }));
  const harness = createHarness({ includeStaffSheets: true, timeRows });
  const summary = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotV2',
    target: 'production'
  });
  assert.equal(summary.view.recordCount, 500);

  const first = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotPageV2',
    target: 'production',
    viewToken: summary.view.token,
    stream: 'records',
    offset: 0
  });
  assert.equal(first.ok, true);
  assert.ok(first.items.length > 0 && first.items.length < 500);
  assert.equal(first.nextOffset, first.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 80_000);

  const second = harness.post({
    token: harness.derivedToken,
    action: 'staffClockSnapshotPageV2',
    target: 'production',
    viewToken: summary.view.token,
    stream: 'records',
    offset: first.nextOffset
  });
  assert.equal(second.ok, true);
  assert.equal(second.offset, first.nextOffset);
  assert.ok(second.items.length > 0);
  assert.equal(second.nextOffset, second.offset + second.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(second), 'utf8') <= 80_000);
  assert.equal(harness.sheetWrites, 0);
  assert.equal(harness.propertyWrites, 0);
});

test('production Staff Clock rejects TEST roster values and schema drift without writing', () => {
  const fakeRoster = createHarness({
    includeStaffSheets: true,
    staffRows: [['mandy-test', 'Mandy Test', true]]
  });
  assert.equal(fakeRoster.post({
    token: fakeRoster.derivedToken,
    action: 'staffClockSnapshot',
    target: 'production'
  }).result, 'failed');
  assert.equal(fakeRoster.sheetWrites, 0);

  const drifted = createHarness({ includeStaffSheets: true });
  drifted.sheets.get('Staff Time').values[0][2] = 'Wrong Date';
  assert.equal(drifted.post({
    token: drifted.derivedToken,
    action: 'staffClockSnapshot',
    target: 'production'
  }).result, 'failed');
  assert.equal(drifted.sheetWrites, 0);
});

test('production Staff Clock punch is target-isolated and permanently replay-safe', () => {
  const harness = createHarness({ includeStaffSheets: true });
  const signinsBefore = structuredClone(harness.signins.values);
  const request = {
    token: harness.derivedToken,
    action: 'staffClockPunch',
    target: 'production',
    punches: [staffPunch()]
  };

  const added = harness.post(request);
  const recoveredAfterLostConfirmation = harness.post(request);
  const conflictingReplay = harness.post({
    ...request,
    punches: [staffPunch({ note: 'changed after the permanent ID was used' })]
  });

  assert.deepEqual(added.results, [{
    punchId: STAFF_PUNCH_ID,
    result: 'added',
    linkedPunchId: STAFF_PUNCH_ID
  }]);
  assert.deepEqual(recoveredAfterLostConfirmation.results, [{
    punchId: STAFF_PUNCH_ID,
    result: 'already exists',
    linkedPunchId: STAFF_PUNCH_ID
  }]);
  assert.equal(conflictingReplay.results[0].result, 'rejected');
  assert.equal(harness.sheets.get('Staff Time').values.length, 2);
  assert.equal(harness.sheets.get('Staff Time').values[1][3], 'mandy');
  assert.equal(harness.sheets.get('Staff Time').values[1][4], 'Mandy');
  assert.deepEqual(harness.signins.values, signinsBefore);
  assert.deepEqual(harness.sheets.get('Staff Time Audit').values, [STAFF_AUDIT_HEADERS]);
});

test('production Staff Clock requires production tablet and Admin authorization before Sheet access', () => {
  const wrongTablet = createHarness({ includeStaffSheets: true });
  assert.equal(wrongTablet.post({
    token: 'unit-receiver-token',
    action: 'staffClockSnapshot',
    target: 'production'
  }).result, 'rejected');
  assert.equal(wrongTablet.spreadsheetOpens, 0);

  const wrongTarget = createHarness({ includeStaffSheets: true });
  assert.equal(wrongTarget.post({
    token: wrongTarget.derivedToken,
    action: 'staffClockSnapshot',
    target: 'test'
  }).result, 'rejected');
  assert.equal(wrongTarget.spreadsheetOpens, 0);

  const missingAdmin = createHarness({ includeStaffSheets: true });
  assert.equal(missingAdmin.post({
    token: missingAdmin.derivedToken,
    action: 'staffTimeReview',
    target: 'production'
  }).result, 'rejected');
  assert.equal(missingAdmin.spreadsheetOpens, 0);

  const wrongAdmin = createHarness({ includeStaffSheets: true });
  assert.equal(wrongAdmin.post({
    token: wrongAdmin.derivedToken,
    adminActionToken: 'unit-admin-token',
    action: 'staffTimeReview',
    target: 'production'
  }).result, 'rejected');
  assert.equal(wrongAdmin.spreadsheetOpens, 0);

  const missingCorrectionAdmin = createHarness({ includeStaffSheets: true });
  assert.equal(missingCorrectionAdmin.post({
    token: missingCorrectionAdmin.derivedToken,
    action: 'staffTimeCorrect',
    target: 'production'
  }).result, 'rejected');
  assert.equal(missingCorrectionAdmin.spreadsheetOpens, 0);

  const unlocked = createHarness({
    includeStaffSheets: true,
    propertyValues: { GIB_M1_DEPLOYMENT_TARGET_LOCK: '' }
  });
  assert.equal(unlocked.post({
    token: unlocked.derivedToken,
    action: 'staffClockSnapshot',
    target: 'production'
  }).result, 'rejected');
  assert.equal(unlocked.spreadsheetOpens, 0);
});

test('all production auth paths reject TEST and missing persisted target locks before Sheet access', () => {
  for (const body of [
    { action: 'kioskSignIn', target: 'test', rows: [kioskRow()] },
    { action: 'dailyReview', target: 'test', adminActionToken: 'production-admin-token', date: '2026-08-06' },
    { action: 'recoveryList', target: 'test', recoveryToken: 'production-recovery-token', fromDate: '2026-08-06' }
  ]) {
    const harness = createHarness();
    const response = harness.post({ token: harness.derivedToken, ...body });
    assert.equal(response.result, 'rejected');
    assert.equal(harness.spreadsheetOpens, 0);
  }

  for (const body of [
    { action: 'kioskSignIn', target: 'production', rows: [kioskRow()] },
    { action: 'dailyReview', target: 'production', adminActionToken: 'production-admin-token', date: '2026-08-06' },
    { action: 'recoveryList', target: 'production', recoveryToken: 'production-recovery-token', fromDate: '2026-08-06' }
  ]) {
    const unlocked = createHarness({
      propertyValues: { GIB_M1_DEPLOYMENT_TARGET_LOCK: '' }
    });
    assert.equal(unlocked.post({ token: unlocked.derivedToken, ...body }).result, 'rejected');
    assert.equal(unlocked.spreadsheetOpens, 0);
  }
});

test('production never accepts the targetless legacy contract', () => {
  const harness = createHarness();
  const response = harness.post({
    token: 'production-legacy-token',
    rows: [kioskRow()]
  });
  assert.equal(response.result, 'rejected');
  assert.equal(harness.spreadsheetOpens, 0);
});

test('a stored TEST transport token can never override the production-derived credential', () => {
  const harness = createHarness({
    propertyValues: { GIB_M1_RECEIVER_TRANSPORT_TOKEN: 'test-receiver-token' }
  });
  const rejected = harness.post({
    token: 'test-receiver-token',
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow()]
  });
  assert.equal(rejected.result, 'rejected');
  assert.equal(harness.spreadsheetOpens, 0);

  const accepted = harness.post({
    token: harness.derivedToken,
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow()]
  });
  assert.equal(accepted.results[0].result, 'added');
});

test('a strict target-lock flag fails closed if the wrapper target is missing', () => {
  const harness = createHarness({ wrapper: false, strictWithoutWrapper: true });
  const response = harness.post({
    token: 'any-token',
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow()]
  });
  assert.equal(response.result, 'rejected');
  assert.equal(harness.spreadsheetOpens, 0);
});

test('production provisioning rejects inexact fields, action, target, and credentials before resource access', () => {
  const invalidRequests = [
    harness => provisioningRequest(harness, { provisioningSecret: 'A'.repeat(43) }),
    harness => provisioningRequest(harness, { provisioningSecret: harness.derivedToken }),
    harness => provisioningRequest(harness, { target: 'Production' }),
    harness => provisioningRequest(harness, { action: 'provisionProductionReceiver ' }),
    harness => provisioningRequest(harness, { unexpected: true }),
    harness => provisioningRequest(harness, { provisioningSecret: undefined })
  ];

  for (const makeRequest of invalidRequests) {
    const harness = createHarness();
    const response = harness.post(makeRequest(harness));
    assert.deepEqual(response, { ok: false, rejected: true });
    assertBooleanCountResponse(response);
    assertNoProvisioningAccess(harness);
  }

  const testProject = createHarness({
    driveMatchCount: 0,
    propertyValues: {
      GIB_M1_PRODUCTION_SPREADSHEET_ID: '',
      GIB_M1_DEPLOYMENT_TARGET_LOCK: '',
      GIB_M1_TEST_SPREADSHEET_ID: 'private-test-spreadsheet-id'
    }
  });
  const testProjectResponse = testProject.post(provisioningRequest(testProject));
  assert.deepEqual(testProjectResponse, { ok: false, rejected: true });
  assertBooleanCountResponse(testProjectResponse);
  assertNoProvisioningAccess(testProject);
});

test('receiver and provisioning credentials cannot cross-authorize', () => {
  const provisioningWithReceiver = createHarness();
  const provisioningResponse = provisioningWithReceiver.post(provisioningRequest(
    provisioningWithReceiver,
    { provisioningSecret: provisioningWithReceiver.derivedToken }
  ));
  assert.deepEqual(provisioningResponse, { ok: false, rejected: true });
  assertNoProvisioningAccess(provisioningWithReceiver);

  const kioskWithProvisioning = createHarness();
  const kioskResponse = kioskWithProvisioning.post({
    token: kioskWithProvisioning.provisioningSecret,
    action: 'kioskSignIn',
    target: 'production',
    rows: [kioskRow()]
  });
  assert.equal(kioskResponse.result, 'rejected');
  assertNoProvisioningAccess(kioskWithProvisioning);
  assert.notEqual(kioskWithProvisioning.provisioningSecret, kioskWithProvisioning.derivedToken);
});

test('zero exact-title Sheets creates one, persists the lock, closes, and cannot replay', () => {
  const harness = createHarness({
    initialRows: null,
    driveMatchCount: 0,
    propertyValues: {
      GIB_M1_PRODUCTION_SPREADSHEET_ID: '',
      GIB_M1_DEPLOYMENT_TARGET_LOCK: '',
      GIB_M1_PROVISIONING_CLOSED: ''
    }
  });
  const request = provisioningRequest(harness);
  const result = harness.post(request);
  assert.deepEqual(Object.keys(result).sort(), [
    'created',
    'dataRowCount',
    'headerCount',
    'ok',
    'provisioningClosed',
    'sheetStored',
    'spreadsheetMatches',
    'targetLocked'
  ]);
  assert.deepEqual(result, {
    ok: true,
    created: true,
    spreadsheetMatches: 1,
    headerCount: SIGNIN_HEADERS.length,
    dataRowCount: 0,
    sheetStored: true,
    targetLocked: true,
    provisioningClosed: true
  });
  assertBooleanCountResponse(result);
  assert.equal(harness.spreadsheetCreates, 1);
  assert.equal(harness.driveQueries, 2);
  assert.equal(harness.spreadsheetOpens, 1);
  assert.deepEqual([...harness.signins.values[0]], SIGNIN_HEADERS);
  assert.equal(harness.signins.frozenRows, 1);
  assert.equal(harness.propertyValues.get('GIB_M1_PRODUCTION_SPREADSHEET_ID'), 'production-spreadsheet-id');
  assert.equal(harness.propertyValues.get('GIB_M1_DEPLOYMENT_TARGET_LOCK'), 'production');
  assert.equal(harness.propertyValues.get('GIB_M1_PROVISIONING_CLOSED'), 'closed-v1');
  assert.deepEqual(harness.propertyWriteEvents, [{
    operation: 'setProperties',
    names: [
      'GIB_M1_DEPLOYMENT_TARGET_LOCK',
      'GIB_M1_PRODUCTION_SPREADSHEET_ID',
      'GIB_M1_PROVISIONING_CLOSED'
    ]
  }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /production-spreadsheet-id|private-production-script-id|provisioningSecret|RBJJ/u
  );

  const beforeReplay = {
    driveQueries: harness.driveQueries,
    spreadsheetOpens: harness.spreadsheetOpens,
    spreadsheetCreates: harness.spreadsheetCreates,
    sheetWrites: harness.sheetWrites,
    propertyWrites: harness.propertyWrites
  };
  const replay = harness.post(request);
  assert.deepEqual(replay, { ok: false, rejected: true });
  assertBooleanCountResponse(replay);
  assert.deepEqual({
    driveQueries: harness.driveQueries,
    spreadsheetOpens: harness.spreadsheetOpens,
    spreadsheetCreates: harness.spreadsheetCreates,
    sheetWrites: harness.sheetWrites,
    propertyWrites: harness.propertyWrites
  }, beforeReplay);
});

test('one exact-title empty Sheet verifies without creating another', () => {
  const harness = createHarness({
    propertyValues: {
      GIB_M1_PRODUCTION_SPREADSHEET_ID: '',
      GIB_M1_DEPLOYMENT_TARGET_LOCK: '',
      GIB_M1_PROVISIONING_CLOSED: ''
    }
  });
  const result = harness.post(provisioningRequest(harness));
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.spreadsheetMatches, 1);
  assert.equal(result.dataRowCount, 0);
  assertBooleanCountResponse(result);
  assert.equal(harness.driveQueries, 1);
  assert.equal(harness.spreadsheetOpens, 1);
  assert.equal(harness.spreadsheetCreates, 0);
  assert.equal(harness.propertyValues.get('GIB_M1_PROVISIONING_CLOSED'), 'closed-v1');
});

test('two exact-title Sheets fail closed before Sheet or property mutation', () => {
  const harness = createHarness({
    driveMatchCount: 2,
    propertyValues: {
      GIB_M1_PRODUCTION_SPREADSHEET_ID: '',
      GIB_M1_DEPLOYMENT_TARGET_LOCK: '',
      GIB_M1_PROVISIONING_CLOSED: ''
    }
  });
  const response = harness.post(provisioningRequest(harness));
  assert.deepEqual(response, { ok: false, rejected: true });
  assertBooleanCountResponse(response);
  assert.equal(harness.driveQueries, 1);
  assert.equal(harness.spreadsheetOpens, 0);
  assert.equal(harness.spreadsheetCreates, 0);
  assert.equal(harness.sheetWrites, 0);
  assert.equal(harness.propertyWrites, 0);
});

test('wrong headers and a nonempty first-time Sheet fail without persistent mutation', () => {
  const wrongHeaders = createHarness({
    initialRows: [[...SIGNIN_HEADERS.slice(0, 2), 'Wrong Date', ...SIGNIN_HEADERS.slice(3)]],
    propertyValues: {
      GIB_M1_PRODUCTION_SPREADSHEET_ID: '',
      GIB_M1_DEPLOYMENT_TARGET_LOCK: '',
      GIB_M1_PROVISIONING_CLOSED: ''
    }
  });
  const wrongHeaderResponse = wrongHeaders.post(provisioningRequest(wrongHeaders));
  assert.deepEqual(wrongHeaderResponse, { ok: false, rejected: true });
  assertBooleanCountResponse(wrongHeaderResponse);
  assert.equal(wrongHeaders.spreadsheetCreates, 0);
  assert.equal(wrongHeaders.sheetWrites, 0);
  assert.equal(wrongHeaders.propertyWrites, 0);
  assert.equal(wrongHeaders.propertyValues.get('GIB_M1_PRODUCTION_SPREADSHEET_ID'), '');

  const nonempty = createHarness({
    initialRows: [SIGNIN_HEADERS, sheetRow(kioskRow())],
    propertyValues: {
      GIB_M1_PRODUCTION_SPREADSHEET_ID: '',
      GIB_M1_DEPLOYMENT_TARGET_LOCK: '',
      GIB_M1_PROVISIONING_CLOSED: ''
    }
  });
  const nonemptyResponse = nonempty.post(provisioningRequest(nonempty));
  assert.deepEqual(nonemptyResponse, { ok: false, rejected: true });
  assertBooleanCountResponse(nonemptyResponse);
  assert.equal(nonempty.spreadsheetCreates, 0);
  assert.equal(nonempty.sheetWrites, 0);
  assert.equal(nonempty.propertyWrites, 0);
  assert.equal(nonempty.propertyValues.get('GIB_M1_PRODUCTION_SPREADSHEET_ID'), '');
  assert.equal(nonempty.propertyValues.get('GIB_M1_DEPLOYMENT_TARGET_LOCK'), '');
  assert.equal(nonempty.propertyValues.get('GIB_M1_PROVISIONING_CLOSED'), '');
});
