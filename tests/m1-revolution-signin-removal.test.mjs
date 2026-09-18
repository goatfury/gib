import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { sanitizeDailyReviewPayload } from '../netlify/functions/_lib/m1-admin-contracts.mjs';

const ROOT = new URL('../', import.meta.url);
const wrapperSource = readFileSync(new URL(
  'integrations/google-apps-script/Code.gs',
  ROOT
), 'utf8');
const receiverSource = readFileSync(new URL(
  'integrations/google-apps-script/GibM1Receiver.gs',
  ROOT
), 'utf8');

const SHEET_TITLE = 'RBJJ M1 — TEST';
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

function derivedSecret(prefix, scriptId = 'revolution-removal-unit-script-id') {
  return createHash('sha256').update(`${prefix}:${scriptId}`, 'utf8').digest('base64url');
}

function signin(overrides = {}) {
  return {
    rowId: ROW_ID,
    timestamp: '2026-08-26 06:59:00',
    date: '2026-08-26',
    classLabel: '6:00 AM–7:00 AM Muay Thai Fundamentals',
    duration: 1,
    instructor: 'QA Removal Instructor',
    site: 'Rev',
    device: 'Front Desk Tablet (Rev)',
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
  const notes = new Map();
  let maxRows = Math.max(100, values.length);
  return {
    name,
    values,
    notes,
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
        getNotes() {
          return Array.from({ length: rowCount }, (_, offset) => [notes.get(startRow + offset) || '']);
        },
        setNote(value) {
          timeline.push(`${name}:setNote:${startRow}`);
          notes.set(startRow, value);
          return this;
        },
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
  const scriptId = 'revolution-removal-unit-script-id';
  const timeline = [];
  const signins = makeSheet('Signins', [signinHeaders, ...rows.map(signinSheetRow)], timeline);
  const audit = makeSheet('Admin Audit', [auditHeaders, ...auditRows], timeline);
  const spreadsheet = {
    getId: () => 'revolution-removal-unit-sheet-id',
    getName: () => SHEET_TITLE,
    getSheetByName: name => name === 'Signins' ? signins : name === 'Admin Audit' ? audit : null,
    getSheets: () => [signins, audit]
  };
  const properties = new Map([
    ['GIB_M1_TEST_SPREADSHEET_ID', spreadsheet.getId()],
    ['GIB_M1_ADMIN_ACTION_TOKEN', 'synthetic-admin-secret-distinct-1234567890'],
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
  vm.runInContext(wrapperSource, context, { filename: 'RevolutionTestCode.gs' });
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
    },
    voidEligible(record, records = [record]) {
      return context.richmondInstructorSigninVoidEligible_(
        record,
        record && record.rowId,
        records
      );
    }
  };
}

function testRequest(action, values = {}) {
  return {
    token: derivedSecret('gib-m1-test'),
    adminActionToken: 'synthetic-admin-secret-distinct-1234567890',
    action,
    target: 'test',
    installation: 'rev',
    environment: 'test',
    ...values
  };
}

function voidRequest(overrides = {}) {
  const rowId = overrides.rowId || ROW_ID;
  return testRequest('revolutionSigninRemoval', {
    removalVersion: 'revolution-instructor-removal-v1', operation: 'remove', fingerprint: '',
    requestId: `gib-m1-admin-void-${rowId}`,
    rowId,
    adminName: 'Andrew Smith',
    reason: REASON,
    ...overrides
  });
}

function dailyReview(harness) {
  return harness.post(testRequest('dailyReview', {
    date: '2026-08-26',
    removalVersion: 'revolution-instructor-removal-v1'
  }));
}


function removal(h, overrides = {}) {
  const record = dailyReview(h).records.find(r => r.recordId === (overrides.rowId || ROW_ID));
  return voidRequest({ fingerprint: record?.removal?.fingerprint || '', ...overrides });
}

test('Revolution removes only the selected kiosk record and retains every original field', () => {
  const h = createHarness({ rows: [signin(), signin({ rowId: OTHER_ROW_ID, instructor: 'QA Other Instructor' })] });
  const before = structuredClone(h.signins.values);
  const request = removal(h);
  const receipt = h.post(request);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.state, 'removed');
  assert.deepEqual(h.signins.values[1].slice(0, 10), before[1].slice(0, 10));
  assert.equal(h.signins.values[1][10], 'VOID');
  assert.deepEqual(h.signins.values[2], before[2]);
  assert.equal(h.audit.values.length, 2);
  assert.equal(dailyReview(h).records.length, 1);
  assert.equal(dailyReview(h).auditHistory[0].result, 'voided');
  assert.equal(h.post({ ...request, operation: 'check' }).state, 'removed');
  assert.equal(h.post({ ...request, adminName: 'Stuart Turner', reason: 'Different competing reason' }).state, 'removed');
  assert.equal(h.audit.values.length, 2);
  assert.equal(h.audit.values[1][1], 'Andrew Smith');
});

test('Admin-added entry created on a later date is removable only with its one matching addition audit', () => {
  const row = signin({ rowId: 'gib-admin-m1-2026-08-26-0123456789abcdef01234567', timestamp: '2026-08-27 08:00:00',
    date: '2026-08-25', device: 'Admin Daily Review', notes: 'Admin-added | Admin: Stuart Turner | Reason: Incorrect class' });
  row.rowId = 'gib-admin-m1-2026-08-25-0123456789abcdef01234567';
  row.timestamp = '2026-08-26 08:00:00';
  const addition = auditSheetRow(row, { adminName: 'Stuart Turner', reason: 'Incorrect class', result: 'added' });
  const h = createHarness({ rows: [row], auditRows: [addition] });
  const review = h.post(testRequest('dailyReview', { date: row.date, removalVersion: 'revolution-instructor-removal-v1' }));
  assert.equal(review.records[0].removal.eligible, true, JSON.stringify(review));
  const request = voidRequest({ rowId: row.rowId, fingerprint: review.records[0].removal.fingerprint });
  assert.equal(h.post(request).state, 'removed');
  assert.equal(h.audit.values.length, 3);
  assert.deepEqual(h.audit.values[1], addition);
  const noAudit = createHarness({ rows: [row] });
  const missing = noAudit.post(testRequest('dailyReview', { date: row.date, removalVersion: 'revolution-instructor-removal-v1' }));
  assert.equal(missing.records[0].removal.eligible, false);
});

test('audit/status interruption is recoverable by check then the same request without duplicate audit', () => {
  const h = createHarness({ failFlushCalls: [2] });
  const request = removal(h);
  assert.equal(h.post(request).ok, false);
  assert.equal(h.signins.values[1][10], 'OK');
  assert.equal(h.audit.values.length, 2);
  const pending = h.post({ ...request, operation: 'check' });
  assert.equal(pending.state, 'pending');
  assert.equal(dailyReview(h).records[0].removal.eligible, false);
  assert.equal(dailyReview(h).auditHistory.length, 0);
  assert.equal(h.post({ ...request, adminName: 'Stuart Turner' }).ok, false);
  assert.equal(h.signins.values[1][10], 'OK');
  assert.equal(h.post(request).state, 'removed');
  assert.equal(h.audit.values.length, 2);
});

test('lost acknowledgement reconciles durable status and audit without another write', () => {
  const h = createHarness({ failFlushCalls: [3] });
  const request = removal(h);
  assert.equal(h.post(request).ok, false);
  assert.equal(h.signins.values[1][10], 'VOID');
  const before = h.timeline.length;
  assert.equal(h.post({ ...request, operation: 'check' }).state, 'removed');
  assert.deepEqual(h.timeline.slice(before), ['lock:try', 'lock:release']);
  assert.equal(h.audit.values.length, 2);
});

test('stale business fields, duplicate identity, malformed records and foreign gym remain protected', () => {
  for (const [column, value] of [[1, '2026-08-26 06:58:00'], [3, 'Another class'], [7, ' Front Desk Tablet (Rev) '], [8, 'new build'], [9, 'Changed notes']]) {
    const h = createHarness(); const request = removal(h);
    h.signins.values[1][column] = value;
    assert.equal(h.post(request).ok, false);
    assert.equal(h.audit.values.length, 1);
    assert.equal(h.signins.values[1][10], 'OK');
  }
  for (const rows of [[signin(), signin()], [signin({ status: 'REVIEW', device: 'Kiosk collision review' })],
    [signin({ site: 'Richmond' })], [signin({ rowId: 'legacy' })]]) {
    const h = createHarness({ rows });
    assert.equal(dailyReview(h).records[0].removal.eligible, false);
    assert.equal(h.post(voidRequest({ fingerprint: 'a'.repeat(64) })).ok, false);
    assert.equal(h.audit.values.length, 1);
  }
});

test('receiver refuses unauthenticated, kiosk-only, wrong gym and wrong environment removal', () => {
  for (const changed of [{ token: '' }, { adminActionToken: '' }, { installation: 'richmond' },
    { environment: 'production' }, { target: 'production' }, { adminName: 'Not an admin' },
    { removalVersion: 'future-version' }, { extra: true }]) {
    const h = createHarness(); const request = removal(h);
    assert.equal(h.post({ ...request, ...changed }).ok, false);
    assert.equal(h.audit.values.length, 1);
    assert.equal(h.signins.values[1][10], 'OK');
  }
});

test('read-only check on an unstarted request does not mutate attendance or audits', () => {
  const h = createHarness(); const request = removal(h);
  const before = structuredClone([h.signins.values, h.audit.values]);
  assert.equal(h.post({ ...request, operation: 'check' }).state, 'not started');
  assert.deepEqual([h.signins.values, h.audit.values], before);
});

test('note-only interruption exposes the original operation for fresh-session recovery', () => {
  const h = createHarness({ failFlushCalls: [1] });
  const original = removal(h);
  assert.equal(h.post(original).ok, false);
  assert.equal(h.audit.values.length, 1);
  const record = dailyReview(h).records[0];
  assert.equal(record.removal.eligible, false);
  assert.equal(record.removal.pending.adminName, original.adminName);
  assert.equal(record.removal.pending.reason, original.reason);
  assert.equal(record.removal.fingerprint, original.fingerprint);
  const resumed = voidRequest({ rowId: record.recordId, fingerprint: record.removal.fingerprint,
    reason: record.removal.pending.reason });
  assert.equal(h.post({ ...resumed, operation: 'check' }).state, 'pending');
  assert.equal(h.audit.values.length, 1);
  assert.equal(h.post({ ...resumed, adminName: 'Stuart Turner' }).ok, false);
  assert.equal(h.post(resumed).state, 'removed');
  assert.equal(h.audit.values.length, 2);
});

test('pending recovery keeps the original fingerprint and protects unrelated cell notes', () => {
  const h = createHarness({ failFlushCalls: [1] });
  const request = removal(h);
  h.post(request);
  h.signins.values[1][9] = 'A later note edit';
  const record = dailyReview(h).records[0];
  assert.equal(record.removal.fingerprint, request.fingerprint);
  assert.equal(h.post({ ...request, operation: 'check' }).ok, false);
  assert.equal(h.signins.values[1][10], 'OK');
  assert.equal(h.audit.values.length, 1);
  const other = createHarness();
  other.signins.notes.set(2, 'Existing human note');
  assert.equal(dailyReview(other).records[0].removal.eligible, false);
  assert.equal(other.post(voidRequest({ fingerprint: request.fingerprint })).ok, false);
  assert.equal(other.signins.notes.get(2), 'Existing human note');
});

test('baseline Admin reads remain usable after a removal and configured kiosk labels are supported', () => {
  const h = createHarness({ rows: [signin({ device: 'Revolution front desk replacement tablet' })] });
  assert.equal(dailyReview(h).records[0].removal.eligible, true);
  assert.equal(h.post(removal(h)).state, 'removed');
  const legacy = h.post(testRequest('dailyReview', { date: '2026-08-26' }));
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.records, []);
  assert.deepEqual(legacy.auditHistory, []);
  assert.deepEqual(legacy.warnings, []);
  assert.equal(dailyReview(h).auditHistory.length, 1);
  assert.ok(sanitizeDailyReviewPayload(dailyReview(h), '2026-08-26', { allowRevolutionRemoval: true }), JSON.stringify(dailyReview(h)));
});
