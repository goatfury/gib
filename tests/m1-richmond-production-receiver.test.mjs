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
const manifest = JSON.parse(readFileSync(new URL(
  'integrations/google-apps-script/richmond-production/appsscript.json',
  ROOT
), 'utf8'));

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
const FIXED_RICHMOND_NOW = Date.parse('2026-08-21T16:00:00Z');

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

function formatReceiverDate(dateValue, timeZone, pattern) {
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
  throw new Error(`Unsupported Richmond receiver test format: ${pattern}`);
}

class FixedReceiverDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED_RICHMOND_NOW);
  }

  static now() {
    return FIXED_RICHMOND_NOW;
  }
}

function derivedSecret(prefix, scriptId = 'richmond-production-unit-script-id') {
  return createHash('sha256').update(`${prefix}:${scriptId}`, 'utf8').digest('base64url');
}

function makeSheet(name, initialRows) {
  const values = initialRows.map(row => [...row]);
  let frozenRows = 0;
  let maxRows = Math.max(100, values.length);
  return {
    name,
    values,
    appendRow(row) { values.push([...row]); },
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
    insertRowsAfter(_row, count) { maxRows += count; },
    setFrozenRows(count) { frozenRows = count; },
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
          rows.forEach((source, rowOffset) => {
            const targetIndex = startRow - 1 + rowOffset;
            if (!values[targetIndex]) values[targetIndex] = [];
            source.forEach((value, columnOffset) => {
              values[targetIndex][startColumn - 1 + columnOffset] = value;
            });
          });
          return this;
        },
        setNumberFormat() { return this; }
      };
    },
    get frozenRows() { return frozenRows; }
  };
}

function createHarness({ provisioned = true, duplicateSheets = false } = {}) {
  const scriptId = 'richmond-production-unit-script-id';
  const signins = makeSheet('Signins', [SIGNIN_HEADERS]);
  const audit = makeSheet('Admin Audit', [AUDIT_HEADERS]);
  const spreadsheet = {
    getId: () => 'richmond-production-unit-sheet-id',
    getName: () => SHEET_TITLE,
    getSheetByName: name => name === 'Signins' ? signins : name === 'Admin Audit' ? audit : null,
    getSheets: () => [signins, audit]
  };
  const properties = new Map(provisioned ? [
    ['GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_ID', spreadsheet.getId()],
    ['GIB_M1_DEPLOYMENT_TARGET_LOCK', 'production'],
    ['GIB_M1_INSTALLATION_LOCK', 'richmond'],
    ['GIB_M1_ENVIRONMENT_LOCK', 'production'],
    ['GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED', 'richmond-production-v1'],
    ['GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'false']
  ] : []);
  let spreadsheetOpens = 0;
  const context = vm.createContext({
    console,
    Date: FixedReceiverDate,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) { return { text, setMimeType() { return this; } }; }
    },
    DriveApp: {
      getFilesByName(name) {
        assert.equal(name, SHEET_TITLE);
        const files = duplicateSheets ? [spreadsheet, spreadsheet] : [spreadsheet];
        let index = 0;
        return {
          hasNext: () => index < files.length,
          next() {
            const source = files[index++];
            return {
              getId: () => source.getId(),
              getMimeType: () => 'application/vnd.google-apps.spreadsheet',
              isTrashed: () => false
            };
          }
        };
      }
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} })
    },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
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
      flush() {}
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
      formatDate: formatReceiverDate
    }
  });
  vm.runInContext(wrapperSource, context, { filename: 'RichmondProductionCode.gs' });
  vm.runInContext(receiverSource, context, { filename: 'GibM1Receiver.gs' });
  return {
    context,
    properties,
    signins,
    audit,
    get spreadsheetOpens() { return spreadsheetOpens; },
    post(body) {
      const output = context.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(output.text);
    }
  };
}

function kioskRow(overrides = {}) {
  return {
    RowID: 'gib-m1-11111111-1111-4111-8111-111111111111',
    Timestamp: '2026-08-21 12:00:00',
    Date: '2026-08-21',
    'Class Label': '6:00 AM–7:00 AM Muay Thai Fundamentals',
    'Duration (hr)': 1,
    Instructor: 'Richmond Instructor',
    Site: 'Richmond',
    Device: 'Richmond Front Desk Tablet',
    Build: 'richmond-production-unit',
    Notes: '',
    ...overrides
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

test('Richmond production Apps Script is isolated, Staff Clock off, and identifier-free', () => {
  assert.match(wrapperSource, /Richmond BJJ M1 — PRODUCTION/u);
  assert.match(wrapperSource, /GIB_M1_STAFF_CLOCK_ENABLED = false/u);
  assert.match(wrapperSource, /GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ = 'richmond'/u);
  assert.match(wrapperSource, /GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_ = 'production'/u);
  assert.match(wrapperSource, /GIB_M1_RICHMOND_PRODUCTION_DEVICE_ = 'Richmond Front Desk Tablet'/u);
  assert.match(wrapperSource, /GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED_/u);
  assert.doesNotMatch(wrapperSource, /AKfy[A-Za-z0-9_-]{20,}|\b1[A-Za-z0-9_-]{30,}\b/u);
  assert.deepEqual(manifest.webapp, {
    access: 'ANYONE_ANONYMOUS',
    executeAs: 'USER_DEPLOYING'
  });
});

test('pending Apps Script allows empty-ledger reads but rejects every allowed mutation before Sheet access', () => {
  const readHarness = createHarness();
  const review = readHarness.post(productionRequest('dailyReview', { date: '2026-08-21' }));
  assert.equal(review.ok, true);
  assert.deepEqual(review.records, []);
  assert.deepEqual(review.auditHistory, []);

  const mutationCases = [
    productionRequest('kioskSignIn', { rows: [kioskRow()] }),
    productionRequest('addMissedInstructor', {
      requestId: '11111111-1111-4111-8111-111111111111',
      adminName: 'Andrew Smith',
      date: '2026-08-21',
      classLabel: kioskRow()['Class Label'],
      duration: 1,
      instructor: 'Richmond Instructor',
      site: 'Richmond',
      notes: '',
      reason: 'Missed tablet sign-in'
    })
  ];
  mutationCases.forEach(body => {
    const harness = createHarness();
    assert.equal(harness.post(body).result, 'rejected');
    assert.equal(harness.spreadsheetOpens, 0);
    assert.equal(harness.signins.values.length, 1);
    assert.equal(harness.audit.values.length, 1);
  });
});

test('pending Apps Script exposes only an authenticated empty-ledger status', () => {
  const harness = createHarness();
  const status = harness.post(productionRequest('ledgerStatus'));
  assert.deepEqual(status, {
    ok: true,
    target: 'production',
    installation: 'richmond',
    environment: 'production',
    empty: true,
    signinsRows: 0,
    auditRows: 0,
    writesEnabled: false
  });
  assert.equal(harness.spreadsheetOpens, 1);

  const unauthenticated = createHarness();
  const badStatus = productionRequest('ledgerStatus', { token: 'wrong-token' });
  assert.equal(unauthenticated.post(badStatus).result, 'rejected');
  assert.equal(unauthenticated.spreadsheetOpens, 0);

  const extraField = createHarness();
  assert.equal(extraField.post(productionRequest('ledgerStatus', { date: '2026-08-21' })).result, 'rejected');
  assert.equal(extraField.spreadsheetOpens, 0);
});

test('production envelope rejects TEST, Rev, wrong site/device, Staff Clock, and fake names', () => {
  const cases = [
    productionRequest('kioskSignIn', { installation: 'rev', rows: [kioskRow()] }),
    productionRequest('kioskSignIn', { target: 'test', rows: [kioskRow()] }),
    productionRequest('kioskSignIn', { environment: 'test', rows: [kioskRow()] }),
    productionRequest('kioskSignIn', { rows: [kioskRow({ Site: 'Rev' })] }),
    productionRequest('kioskSignIn', { rows: [kioskRow({ Device: 'Richmond TEST Browser' })] }),
    productionRequest('kioskSignIn', { rows: [kioskRow({ Instructor: 'QA Fake Instructor' })] }),
    productionRequest('instructorSearch', { instructor: 'QA Test Instructor', date: '2026-08-21' }),
    productionRequest('staffClockSnapshot')
  ];
  cases.forEach(body => {
    const harness = createHarness();
    harness.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'true');
    assert.equal(harness.post(body).result, 'rejected');
    assert.equal(harness.spreadsheetOpens, 0);
  });
});

test('Apps Script Richmond production rejects delimited fake-name markers without rejecting embedded letters', () => {
  const harness = createHarness();
  const rejectedNames = [
    'QA_Test',
    'Fake_Student',
    'QA1',
    'qA',
    'Demo Instructor',
    'Student-tEsT',
    'Coach.dEmO',
    '9fAkE'
  ];
  const acceptedNames = [
    'Qadir Smith',
    'Stefano Testa',
    'Mina Faker',
    'Demos Brown',
    'Nina Contesta',
    'Testé Martin'
  ];

  rejectedNames.forEach(name => assert.equal(
    harness.context.gibM1RichmondProductionObviousTestValue_(name),
    true,
    name
  ));
  acceptedNames.forEach(name => assert.equal(
    harness.context.gibM1RichmondProductionObviousTestValue_(name),
    false,
    name
  ));

  ['QA_Test', 'Fake_Student', 'QA1'].forEach(instructor => {
    const bypassHarness = createHarness();
    const response = bypassHarness.post(productionRequest('instructorSearch', {
      instructor,
      date: '2026-08-21'
    }));
    assert.equal(response.result, 'rejected', instructor);
    assert.equal(bypassHarness.spreadsheetOpens, 0, instructor);
    assert.equal(bypassHarness.signins.values.length, 1, instructor);
    assert.equal(bypassHarness.audit.values.length, 1, instructor);
  });
});

test('the Apps Script write gate must be explicitly enabled after provisioning', () => {
  const harness = createHarness();
  const request = productionRequest('kioskSignIn', { rows: [kioskRow()] });
  assert.equal(harness.post(request).result, 'rejected');
  harness.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'true');
  const enabled = harness.post(request);
  assert.equal(enabled.ok, true);
  assert.equal(enabled.target, 'production');
  assert.equal(enabled.results[0].result, 'added');
  assert.equal(harness.signins.values.length, 2);
});

test('Richmond shares the Not Synced late-event replacement without adding a payable duplicate', () => {
  const harness = createHarness();
  harness.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'true');
  const addition = productionRequest('addMissedInstructor', {
    requestId: 'richmond-not-synced',
    adminName: 'Andrew Smith',
    date: '2026-08-21',
    classLabel: kioskRow()['Class Label'],
    duration: 1,
    instructor: kioskRow().Instructor,
    site: 'Richmond',
    notes: '',
    reason: 'Not Synced'
  });
  const added = harness.post(addition);
  assert.equal(added.result, 'added');
  assert.equal(added.linkedRecordId, 'gib-admin-richmond-not-synced');

  const auditAfterAdmin = structuredClone(harness.audit.values);
  const lateRequest = productionRequest('kioskSignIn', {
    rows: [kioskRow({
      RowID: 'gib-m1-22222222-2222-4222-8222-222222222222',
      Timestamp: '2026-08-21 05:58:12'
    })]
  });
  const first = harness.post(lateRequest);
  const signinsAfterFirst = structuredClone(harness.signins.values);
  const retry = harness.post(lateRequest);

  assert.deepEqual(first.results, [{
    rowId: lateRequest.rows[0].RowID,
    result: 'already exists',
    linkedRecordId: added.linkedRecordId
  }]);
  assert.deepEqual(retry.results, first.results);
  assert.deepEqual(harness.signins.values, signinsAfterFirst);
  assert.deepEqual(harness.audit.values, auditAfterAdmin);
  assert.equal(harness.signins.values.length, 3);
  assert.equal(harness.signins.values[2][0], lateRequest.rows[0].RowID);
  assert.equal(harness.signins.values[2][7], 'Admin sync replacement receipt');
  assert.equal(harness.signins.values[2][8], added.linkedRecordId);
  assert.equal(harness.signins.values[2][10], 'VOID');

  const review = harness.post(productionRequest('dailyReview', { date: addition.date }));
  assert.equal(review.records.length, 1);
  assert.equal(review.records[0].recordId, added.linkedRecordId);
  assert.equal(review.records[0].reviewRequired, false);
  assert.equal(review.auditHistory.length, 1);
  assert.equal(review.auditHistory[0].linkedRecordId, added.linkedRecordId);
});

test('Richmond shares fail-closed fall-back chronology and still exposes no Staff Clock', () => {
  const harness = createHarness();
  harness.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'true');
  const sourceRow = kioskRow({
    Date: '2025-11-02',
    Timestamp: '2025-11-02 01:15:00'
  });
  const added = harness.post(productionRequest('addMissedInstructor', {
    requestId: 'richmond-dst-not-synced',
    adminName: 'Andrew Smith',
    date: sourceRow.Date,
    classLabel: sourceRow['Class Label'],
    duration: sourceRow['Duration (hr)'],
    instructor: sourceRow.Instructor,
    site: sourceRow.Site,
    notes: sourceRow.Notes,
    reason: 'Not Synced'
  }));
  assert.equal(added.result, 'added');
  harness.audit.values[1][2] = '2025-11-02 01:30:00';
  const before = structuredClone(harness.signins.values);
  const request = productionRequest('kioskSignIn', { rows: [sourceRow] });
  const first = harness.post(request);
  assert.deepEqual(first.results, [{
    rowId: sourceRow.RowID,
    result: 'rejected',
    linkedRecordId: ''
  }]);
  assert.deepEqual(harness.post(request).results, first.results);
  assert.deepEqual(harness.signins.values, before);
  assert.equal(harness.signins.values.some(row => row[7] === 'Admin sync replacement receipt'), false);
  assert.equal(harness.context.GIB_M1_STAFF_CLOCK_ENABLED, false);
});

test('one-time provisioning binds only the exact empty production Sheet and fixes writes OFF', () => {
  const harness = createHarness({ provisioned: false });
  const request = {
    action: 'provisionRichmondProduction',
    provisioningSecret: derivedSecret('gib-m1-richmond-production-provisioning'),
    target: 'production',
    installation: 'richmond',
    environment: 'production'
  };
  const response = harness.post(request);
  assert.equal(response.ok, true);
  assert.equal(response.signinsRows, 0);
  assert.equal(response.auditRows, 0);
  assert.equal(response.writesEnabled, false);
  assert.equal(harness.properties.get('GIB_M1_DEPLOYMENT_TARGET_LOCK'), 'production');
  assert.equal(harness.properties.get('GIB_M1_INSTALLATION_LOCK'), 'richmond');
  assert.equal(harness.properties.get('GIB_M1_ENVIRONMENT_LOCK'), 'production');
  assert.equal(harness.properties.get('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED'), 'false');
  assert.equal(harness.post(request).result, 'rejected');
  assert.doesNotMatch(JSON.stringify(response), /richmond-production-unit-(?:script|sheet)-id/u);
});

test('production provisioning rejects duplicate exact-title Sheets without persisting locks', () => {
  const harness = createHarness({ provisioned: false, duplicateSheets: true });
  const response = harness.post({
    action: 'provisionRichmondProduction',
    provisioningSecret: derivedSecret('gib-m1-richmond-production-provisioning'),
    target: 'production',
    installation: 'richmond',
    environment: 'production'
  });
  assert.equal(response.result, 'rejected');
  assert.equal(harness.properties.size, 0);
});
