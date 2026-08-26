import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const wrapperSource = readFileSync(new URL(
  'integrations/google-apps-script/richmond-production/Code.gs',
  ROOT
), 'utf8');
const receiverSource = readFileSync(new URL(
  'integrations/google-apps-script/GibM1Receiver.gs',
  ROOT
), 'utf8');

const SHEET_TITLE = 'Richmond BJJ M1 — PRODUCTION';
const SIGNIN_HEADERS = Object.freeze([
  'RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor',
  'Site', 'Device', 'Build', 'Notes', 'Status'
]);
const AUDIT_HEADERS = Object.freeze([
  'Action Number', 'Admin Name', 'Action Time', 'Instructor', 'Class Date',
  'Class', 'Site', 'Duration', 'Required Reason', 'Final Result',
  'Linked Sign-in Record ID'
]);
const ROW_ID = 'gib-m1-11111111-1111-4111-8111-111111111111';
const OTHER_ROW_ID = 'gib-m1-22222222-2222-4222-8222-222222222222';
const REASON = 'Installation check — void after verification';

function derivedSecret(prefix, scriptId = 'richmond-signin-void-unit-script-id') {
  return createHash('sha256').update(`${prefix}:${scriptId}`, 'utf8').digest('base64url');
}

function signin(overrides = {}) {
  return {
    rowId: ROW_ID,
    timestamp: '2026-08-26 06:59:00',
    date: '2026-08-26',
    classLabel: '6:00 AM–7:00 AM Muay Thai Fundamentals',
    duration: 1,
    instructor: 'Andrew Smith',
    site: 'Richmond',
    device: 'Richmond Front Desk Tablet',
    build: 'richmond-production-unit',
    notes: 'Install check only',
    status: 'OK',
    ...overrides
  };
}

function signinSheetRow(value = signin()) {
  return [
    value.rowId,
    value.timestamp,
    value.date,
    value.classLabel,
    value.duration,
    value.instructor,
    value.site,
    value.device,
    value.build,
    value.notes,
    value.status
  ];
}

function auditSheetRow(value = signin(), overrides = {}) {
  return [
    overrides.actionNumber ?? 1,
    overrides.adminName ?? 'Andrew Smith',
    overrides.actionTime ?? '2026-08-26 12:00:00',
    value.instructor,
    value.date,
    value.classLabel,
    value.site,
    value.duration,
    overrides.reason ?? REASON,
    overrides.result ?? 'voided',
    value.rowId
  ];
}

function makeSheet(name, initialRows, timeline) {
  const values = initialRows.map(row => [...row]);
  let maxRows = Math.max(100, values.length);
  return {
    name,
    values,
    getName: () => name,
    getDataRange: () => ({ getValues: () => values.map(row => [...row]) }),
    getLastRow: () => values.length,
    getLastColumn() {
      let last = 0;
      values.forEach(row => row.forEach((value, index) => {
        if (value !== '' && value != null) last = Math.max(last, index + 1);
      }));
      return last;
    },
    getMaxRows: () => maxRows,
    insertRowsAfter(_row, count) {
      timeline.push(`${name}:insertRowsAfter`);
      maxRows += count;
    },
    appendRow(row) {
      timeline.push(`${name}:appendRow`);
      values.push([...row]);
      return this;
    },
    setFrozenRows() {},
    getRange(startRow, startColumn, rowCount, columnCount) {
      return {
        getValues() {
          return Array.from({ length: rowCount }, (_unused, rowOffset) =>
            Array.from({ length: columnCount }, (_unusedColumn, columnOffset) =>
              values[startRow - 1 + rowOffset]?.[startColumn - 1 + columnOffset] ?? ''
            )
          );
        },
        setValues(rows) {
          timeline.push(`${name}:setValues`);
          rows.forEach((source, rowOffset) => {
            const targetIndex = startRow - 1 + rowOffset;
            if (!values[targetIndex]) values[targetIndex] = [];
            source.forEach((value, columnOffset) => {
              values[targetIndex][startColumn - 1 + columnOffset] = value;
            });
          });
          return this;
        },
        setValue(value) {
          timeline.push(`${name}:setValue:${startRow}:${startColumn}:${value}`);
          if (!values[startRow - 1]) values[startRow - 1] = [];
          values[startRow - 1][startColumn - 1] = value;
          return this;
        },
        setNumberFormat() { return this; }
      };
    }
  };
}

function createHarness({
  rows = [signin()],
  auditRows = [],
  writesEnabled = true,
  signinHeaders = SIGNIN_HEADERS,
  auditHeaders = AUDIT_HEADERS,
  lockAvailable = true,
  failFlushCalls = []
} = {}) {
  const scriptId = 'richmond-signin-void-unit-script-id';
  const timeline = [];
  const signins = makeSheet('Signins', [signinHeaders, ...rows.map(signinSheetRow)], timeline);
  const audit = makeSheet('Admin Audit', [auditHeaders, ...auditRows], timeline);
  const spreadsheet = {
    getId: () => 'richmond-signin-void-unit-sheet-id',
    getName: () => SHEET_TITLE,
    getSheetByName: name => name === 'Signins' ? signins : name === 'Admin Audit' ? audit : null,
    getSheets: () => [signins, audit]
  };
  const properties = new Map([
    ['GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_ID', spreadsheet.getId()],
    ['GIB_M1_DEPLOYMENT_TARGET_LOCK', 'production'],
    ['GIB_M1_INSTALLATION_LOCK', 'richmond'],
    ['GIB_M1_ENVIRONMENT_LOCK', 'production'],
    ['GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED', 'richmond-production-v1'],
    ['GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', writesEnabled ? 'true' : 'false']
  ]);
  const failingFlushCalls = new Set(failFlushCalls);
  let flushCalls = 0;
  let lockAttempts = 0;
  let lockReleases = 0;
  let spreadsheetOpens = 0;

  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-08-26T16:00:00.000Z'])); }
    static now() { return Date.parse('2026-08-26T16:00:00.000Z'); }
  }

  const context = vm.createContext({
    console,
    Date: FixedDate,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) { return { text, setMimeType() { return this; } }; }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          lockAttempts += 1;
          timeline.push('lock:try');
          return lockAvailable;
        },
        releaseLock() {
          lockReleases += 1;
          timeline.push('lock:release');
        }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => properties.get(name) || '',
        setProperty(name, value) { properties.set(name, String(value)); return this; },
        setProperties(values) {
          Object.entries(values).forEach(([name, value]) => properties.set(name, String(value)));
          return this;
        }
      })
    },
    ScriptApp: { getScriptId: () => scriptId },
    SpreadsheetApp: {
      openById(id) {
        spreadsheetOpens += 1;
        assert.equal(id, spreadsheet.getId());
        return spreadsheet;
      },
      flush() {
        flushCalls += 1;
        timeline.push(`flush:${flushCalls}`);
        if (failingFlushCalls.has(flushCalls)) throw new Error('Synthetic flush failure');
      }
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64EncodeWebSafe: bytes => Buffer
        .from(bytes.map(value => value < 0 ? value + 256 : value))
        .toString('base64url'),
      computeDigest(_algorithm, value) {
        return [...createHash('sha256').update(String(value), 'utf8').digest()];
      },
      computeHmacSha256Signature: () => [],
      formatDate(_value, _timeZone, pattern) {
        return pattern === 'yyyy-MM-dd HH:mm:ss'
          ? '2026-08-26 12:00:00'
          : '2026-08-26';
      }
    }
  });
  vm.runInContext(wrapperSource, context, { filename: 'RichmondProductionCode.gs' });
  vm.runInContext(receiverSource, context, { filename: 'GibM1Receiver.gs' });
  return {
    signins,
    audit,
    timeline,
    properties,
    failingFlushCalls,
    get flushCalls() { return flushCalls; },
    get lockAttempts() { return lockAttempts; },
    get lockReleases() { return lockReleases; },
    get spreadsheetOpens() { return spreadsheetOpens; },
    post(body) {
      const output = context.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(output.text);
    }
  };
}

function productionRequest(action, values = {}) {
  return {
    token: derivedSecret('gib-m1-richmond-production'),
    adminActionToken: derivedSecret('gib-m1-richmond-production-admin'),
    action,
    target: 'production',
    installation: 'richmond',
    environment: 'production',
    ...values
  };
}

function voidRequest(overrides = {}) {
  const rowId = overrides.rowId || ROW_ID;
  return productionRequest('voidInstructorSignin', {
    requestId: `gib-m1-admin-void-${rowId}`,
    rowId,
    adminName: 'Andrew Smith',
    reason: REASON,
    ...overrides
  });
}

test('Richmond instructor void writes one audit before one canonical status change and replays exactly', () => {
  const harness = createHarness();
  const request = voidRequest();
  const first = harness.post(request);
  assert.deepEqual(first, {
    ok: true,
    result: 'voided',
    requestId: request.requestId,
    linkedRecordId: ROW_ID,
    auditActionNumber: 1,
    confirmation: {
      adminName: 'Andrew Smith',
      rowId: ROW_ID,
      timestamp: '2026-08-26 06:59:00',
      date: '2026-08-26',
      classLabel: '6:00 AM–7:00 AM Muay Thai Fundamentals',
      duration: 1,
      instructor: 'Andrew Smith',
      site: 'Richmond',
      device: 'Richmond Front Desk Tablet',
      build: 'richmond-production-unit',
      notes: 'Install check only',
      status: 'VOID',
      reason: REASON
    }
  });
  assert.equal(harness.signins.values.length, 2);
  assert.equal(harness.signins.values[1][10], 'VOID');
  assert.equal(harness.audit.values.length, 2);
  assert.deepEqual(harness.timeline.filter(item => (
    item.includes('appendRow') || item.includes('setValue') || item.startsWith('flush:')
  )), [
    'Admin Audit:appendRow',
    'flush:1',
    'Signins:setValue:2:11:VOID',
    'flush:2'
  ]);
  assert.equal(harness.timeline.some(item => item.includes('delete')), false);

  const replayTimelineLength = harness.timeline.length;
  const replay = harness.post(request);
  assert.equal(replay.result, 'already voided');
  assert.equal(replay.auditActionNumber, first.auditActionNumber);
  assert.equal(harness.audit.values.length, 2);
  assert.equal(harness.signins.values.length, 2);
  assert.equal(harness.timeline.slice(replayTimelineLength).some(item => (
    item.includes('appendRow') || item.includes('setValue') || item.startsWith('flush:')
  )), false);
  assert.equal(harness.lockAttempts, 2);
  assert.equal(harness.lockReleases, 2);

  const review = harness.post(productionRequest('dailyReview', { date: '2026-08-26' }));
  assert.deepEqual(review.records, []);
  assert.equal(review.auditHistory.length, 1);
  assert.equal(review.auditHistory[0].result, 'voided');
  assert.equal(review.auditHistory[0].linkedRecordId, ROW_ID);
});

test('Richmond instructor void heals an audit-first interrupted write without another audit', () => {
  const harness = createHarness({ failFlushCalls: [1] });
  const request = voidRequest();
  const interrupted = harness.post(request);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.result, 'failed');
  assert.equal(harness.audit.values.length, 2);
  assert.equal(harness.signins.values[1][10], 'OK');

  harness.failingFlushCalls.clear();
  const healed = harness.post(request);
  assert.equal(healed.ok, true);
  assert.equal(healed.result, 'voided');
  assert.equal(healed.auditActionNumber, 1);
  assert.equal(harness.audit.values.length, 2);
  assert.equal(harness.signins.values[1][10], 'VOID');
  assert.equal(harness.post(request).result, 'already voided');
  assert.equal(harness.audit.values.length, 2);
});

test('Richmond instructor void rejects changed semantics and reused request identity without mutation', () => {
  const harness = createHarness();
  const request = voidRequest();
  assert.equal(harness.post(request).result, 'voided');
  const baselineSignins = JSON.stringify(harness.signins.values);
  const baselineAudit = JSON.stringify(harness.audit.values);

  const changedCases = [
    voidRequest({ reason: 'Different authorized reason' }),
    voidRequest({ adminName: 'Stuart Turner' }),
    voidRequest({ requestId: 'gib-m1-admin-void-wrong' }),
    voidRequest({ rowId: OTHER_ROW_ID, requestId: request.requestId })
  ];
  changedCases.forEach(body => {
    const response = harness.post(body);
    assert.equal(response.ok, false);
    assert.equal(response.result, 'rejected');
    assert.equal(JSON.stringify(harness.signins.values), baselineSignins);
    assert.equal(JSON.stringify(harness.audit.values), baselineAudit);
  });
});

test('Richmond instructor void fails closed for gates, drift, ambiguous RowID, and ineligible rows', () => {
  const pending = createHarness({ writesEnabled: false });
  assert.equal(pending.post(voidRequest()).result, 'rejected');
  assert.equal(pending.spreadsheetOpens, 0);

  const cases = [
    { rows: [], expected: 'rejected' },
    { rows: [signin(), signin()], expected: 'rejected' },
    { rows: [signin({ site: 'Rev' })], expected: 'rejected' },
    { rows: [signin({ device: 'Admin Daily Review' })], expected: 'rejected' },
    { rows: [signin({ instructor: 'QA Fake Instructor' })], expected: 'rejected' },
    { rows: [signin({ status: 'REVIEW' })], expected: 'rejected' },
    { rows: [signin({ status: 'VOID' })], expected: 'rejected' },
    { rows: [signin()], signinHeaders: [...SIGNIN_HEADERS, 'Unexpected'], expected: 'failed' },
    { rows: [signin()], auditHeaders: [...AUDIT_HEADERS.slice(0, 10), 'Wrong'], expected: 'failed' },
    { rows: [signin()], auditHeaders: [...AUDIT_HEADERS, 'Unexpected'], expected: 'failed' }
  ];
  cases.forEach(options => {
    const harness = createHarness(options);
    const beforeSignins = JSON.stringify(harness.signins.values);
    const beforeAudit = JSON.stringify(harness.audit.values);
    const response = harness.post(voidRequest());
    assert.equal(response.result, options.expected);
    assert.equal(JSON.stringify(harness.signins.values), beforeSignins);
    assert.equal(JSON.stringify(harness.audit.values), beforeAudit);
  });

  const conflictAudit = createHarness({
    rows: [signin({ status: 'VOID' })],
    auditRows: [auditSheetRow(signin(), { reason: 'Different reason' })]
  });
  assert.equal(conflictAudit.post(voidRequest()).result, 'rejected');
  assert.equal(conflictAudit.audit.values.length, 2);

  const revEnvelope = createHarness();
  assert.equal(revEnvelope.post(voidRequest({ installation: 'rev' })).result, 'rejected');
  assert.equal(revEnvelope.spreadsheetOpens, 0);
  assert.equal(revEnvelope.post(productionRequest('staffTimeVoid')).result, 'rejected');
  assert.equal(revEnvelope.spreadsheetOpens, 0);
  assert.equal(receiverSource.includes(ROW_ID), false);
  assert.equal(wrapperSource.includes(ROW_ID), false);
});
