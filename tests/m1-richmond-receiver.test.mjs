import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const wrapperSource = readFileSync(new URL(
  'integrations/google-apps-script/richmond-test/Code.gs',
  ROOT
), 'utf8');
const receiverSource = readFileSync(new URL(
  'integrations/google-apps-script/GibM1Receiver.gs',
  ROOT
), 'utf8');
const manifest = JSON.parse(readFileSync(new URL(
  'integrations/google-apps-script/richmond-test/appsscript.json',
  ROOT
), 'utf8'));

const SHEET_TITLE = 'Richmond BJJ M1 — TEST';
const SIGNIN_HEADERS = Object.freeze([
  'RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor',
  'Site', 'Device', 'Build', 'Notes', 'Status'
]);
const AUDIT_HEADERS = Object.freeze([
  'Action Number', 'Admin Name', 'Action Time', 'Instructor', 'Class Date',
  'Class', 'Site', 'Duration', 'Required Reason', 'Final Result',
  'Linked Sign-in Record ID'
]);

function derivedSecret(prefix, scriptId = 'richmond-private-unit-script-id') {
  return createHash('sha256').update(`${prefix}:${scriptId}`, 'utf8').digest('base64url');
}

function makeSheet(name, initialRows) {
  const values = initialRows.map(row => [...row]);
  let frozenRows = 0;
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
  const scriptId = 'richmond-private-unit-script-id';
  const signins = makeSheet('Signins', [SIGNIN_HEADERS]);
  const audit = makeSheet('Admin Audit', [AUDIT_HEADERS]);
  const spreadsheet = {
    getId: () => 'richmond-private-unit-sheet-id',
    getName: () => SHEET_TITLE,
    getSheetByName: name => name === 'Signins' ? signins : name === 'Admin Audit' ? audit : null,
    getSheets: () => [signins, audit]
  };
  const properties = new Map(provisioned ? [
    ['GIB_M1_RICHMOND_TEST_SPREADSHEET_ID', spreadsheet.getId()],
    ['GIB_M1_DEPLOYMENT_TARGET_LOCK', 'test'],
    ['GIB_M1_INSTALLATION_LOCK', 'richmond'],
    ['GIB_M1_ENVIRONMENT_LOCK', 'test'],
    ['GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED', 'richmond-test-v1']
  ] : []);
  let spreadsheetOpens = 0;
  const context = vm.createContext({
    console,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return { text, setMimeType() { return this; } };
      }
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
              getMimeType: () => 'application/vnd.google-apps.spreadsheet'
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
      formatDate(_value, _timeZone, pattern) {
        return pattern === 'yyyy-MM-dd HH:mm:ss'
          ? '2026-08-21 12:00:00'
          : '2026-08-21';
      }
    }
  });
  vm.runInContext(wrapperSource, context, { filename: 'RichmondCode.gs' });
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
    Instructor: 'Richmond QA Test',
    Site: 'Richmond',
    Device: 'Richmond TEST Browser',
    Build: 'richmond-test-unit',
    Notes: 'QA TEST ONLY',
    ...overrides
  };
}

function kioskRequest(overrides = {}) {
  return {
    token: derivedSecret('gib-m1-richmond-test'),
    action: 'kioskSignIn',
    target: 'test',
    installation: 'richmond',
    environment: 'test',
    rows: [kioskRow()],
    ...overrides
  };
}

test('Richmond Apps Script is a separate TEST-only web app with no private identifiers', () => {
  assert.match(wrapperSource, /Richmond BJJ M1 — TEST/u);
  assert.match(wrapperSource, /GIB_M1_STAFF_CLOCK_ENABLED = false/u);
  assert.match(wrapperSource, /GIB_M1_RICHMOND_INSTALLATION_ = 'richmond'/u);
  assert.match(wrapperSource, /GIB_M1_RICHMOND_ENVIRONMENT_ = 'test'/u);
  assert.match(wrapperSource, /GIB_M1_RICHMOND_DEVICE_ = 'Richmond TEST Browser'/u);
  assert.doesNotMatch(wrapperSource, /AKfy[A-Za-z0-9_-]{20,}|\b1[A-Za-z0-9_-]{30,}\b/u);
  assert.deepEqual(manifest.webapp, {
    access: 'ANYONE_ANONYMOUS',
    executeAs: 'USER_DEPLOYING'
  });
  assert.equal(manifest.timeZone, 'America/New_York');
});

test('Richmond kiosk accepts its exact locked envelope and keeps one permanent RowID on retry', () => {
  const harness = createHarness();
  const first = harness.post(kioskRequest());
  const retry = harness.post(kioskRequest());
  assert.equal(first.results[0].result, 'added');
  assert.equal(retry.results[0].result, 'already exists');
  assert.equal(first.results[0].linkedRecordId, kioskRow().RowID);
  assert.equal(retry.results[0].linkedRecordId, kioskRow().RowID);
  assert.equal(harness.signins.values.length, 2);
  assert.equal(harness.signins.values[1][0], kioskRow().RowID);
});

test('Rev, production, unknown, wrong-device, and Staff requests are rejected before Sheet access', () => {
  const cases = [
    kioskRequest({ installation: 'rev' }),
    kioskRequest({ target: 'production' }),
    kioskRequest({ environment: 'production' }),
    kioskRequest({ rows: [kioskRow({ Device: 'Rev Front Desk' })] }),
    { ...kioskRequest(), action: 'staffClockSnapshot', rows: undefined }
  ];
  cases.forEach(body => {
    const harness = createHarness();
    assert.equal(harness.post(body).result, 'rejected');
    assert.equal(harness.spreadsheetOpens, 0);
    assert.equal(harness.signins.values.length, 1);
  });
});

test('one-time provisioning binds exactly one empty Richmond Sheet and permanently closes', () => {
  const harness = createHarness({ provisioned: false });
  const request = {
    action: 'provisionRichmondTest',
    provisioningSecret: derivedSecret('gib-m1-richmond-test-provisioning'),
    target: 'test',
    installation: 'richmond',
    environment: 'test'
  };
  const response = harness.post(request);
  assert.equal(response.ok, true);
  assert.equal(response.target, 'test');
  assert.equal(response.installation, 'richmond');
  assert.equal(response.environment, 'test');
  assert.equal(response.spreadsheetTitle, SHEET_TITLE);
  assert.equal(response.signinsRows, 0);
  assert.equal(response.auditRows, 0);
  assert.equal(response.provisioningClosed, true);
  assert.equal(harness.properties.get('GIB_M1_DEPLOYMENT_TARGET_LOCK'), 'test');
  assert.equal(harness.properties.get('GIB_M1_INSTALLATION_LOCK'), 'richmond');
  assert.equal(harness.properties.get('GIB_M1_ENVIRONMENT_LOCK'), 'test');
  assert.equal(harness.post(request).result, 'rejected');
  assert.doesNotMatch(JSON.stringify(response), /richmond-private-unit-(?:script|sheet)-id/u);
});

test('provisioning rejects duplicate exact-title Richmond Sheets without persisting any lock', () => {
  const harness = createHarness({ provisioned: false, duplicateSheets: true });
  const response = harness.post({
    action: 'provisionRichmondTest',
    provisioningSecret: derivedSecret('gib-m1-richmond-test-provisioning'),
    target: 'test',
    installation: 'richmond',
    environment: 'test'
  });
  assert.equal(response.result, 'rejected');
  assert.equal(harness.properties.size, 0);
});
