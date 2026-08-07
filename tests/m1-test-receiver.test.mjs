import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const codeSource = read('integrations/google-apps-script/Code.gs');
const receiverSource = read('integrations/google-apps-script/GibM1Receiver.gs');
const claspIgnore = read('integrations/google-apps-script/.claspignore');
const projectGitIgnore = read('integrations/google-apps-script/.gitignore');
const manifest = JSON.parse(read('integrations/google-apps-script/appsscript.json'));

const EXPECTED_TITLE = 'RBJJ M1 \u2014 TEST';
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

function makeSheet(initialRows = [], options = {}) {
  const values = initialRows.map(row => [...row]);
  const numberFormats = new Map();
  const operations = [];
  let maxRows = Math.max(options.maxRows || 1000, values.length);
  let frozenRows = 0;
  return {
    values,
    appendRow(row) {
      operations.push({ type: 'appendRow', row: values.length + 1 });
      values.push([...row]);
    },
    deleteRow(rowNumber) {
      values.splice(rowNumber - 1, 1);
    },
    getDataRange() {
      return { getValues: () => values.map(row => [...row]) };
    },
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
          const rows = [];
          for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
            const source = values[startRow - 1 + rowOffset] || [];
            const row = [];
            for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
              row.push(source[startColumn - 1 + columnOffset] ?? '');
            }
            rows.push(row);
          }
          return rows;
        },
        setValues(rows) {
          if (typeof options.beforeSetValues === 'function') {
            options.beforeSetValues({ startRow, startColumn, rowCount, columnCount, rows });
          }
          operations.push({ type: 'setValues', row: startRow, column: startColumn });
          rows.forEach((source, rowOffset) => {
            const rowIndex = startRow - 1 + rowOffset;
            if (!values[rowIndex]) values[rowIndex] = [];
            source.forEach((value, columnOffset) => {
              values[rowIndex][startColumn - 1 + columnOffset] = value;
            });
          });
          return this;
        },
        setNumberFormat(format) {
          for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
            for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
              const row = startRow + rowOffset;
              const column = startColumn + columnOffset;
              numberFormats.set(`${row}:${column}`, format);
              operations.push({ type: 'numberFormat', row, column, format });
            }
          }
          return this;
        }
      };
    },
    setFrozenRows(count) {
      frozenRows = count;
    },
    getMaxRows() {
      return maxRows;
    },
    insertRowsAfter(afterRow, count) {
      assert.equal(afterRow, maxRows);
      maxRows += count;
      operations.push({ type: 'insertRowsAfter', row: afterRow, count });
    },
    get frozenRows() {
      return frozenRows;
    },
    get numberFormats() {
      return new Map(numberFormats);
    },
    get operations() {
      return operations.map(operation => ({ ...operation }));
    }
  };
}

function kioskRow(overrides = {}) {
  return {
    RowID: 'test-row-001',
    Timestamp: '2026-08-06 09:00:00',
    Date: '2026-08-06',
    'Class Label': '9:00 AM QA TEST BJJ',
    'Duration (hr)': 1,
    Instructor: 'QA Test Instructor',
    Site: 'Rev',
    Device: 'TEST browser',
    Build: 'm1-readable-ack-test',
    Notes: 'QA TEST ONLY',
    ...overrides
  };
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
    row.Device,
    row.Build,
    row.Notes,
    status
  ];
}

function receiverRequest(rows, overrides = {}) {
  return {
    token: 'unit-receiver-token',
    action: 'kioskSignIn',
    target: 'test',
    rows,
    ...overrides
  };
}

function createHarness({
  initialRows = [SIGNIN_HEADERS],
  properties = {},
  driveMatchCount = 1,
  failAfterAppends = null,
  lockAvailable = true,
  sheetMaxRows = 1000
} = {}) {
  const propertyValues = new Map(Object.entries({
    GIB_M1_TEST_SPREADSHEET_ID: 'unit-test-spreadsheet-id',
    GIB_M1_RECEIVER_TRANSPORT_TOKEN: 'unit-receiver-token',
    GIB_M1_LEGACY_KIOSK_TOKEN: 'unit-legacy-token',
    GIB_M1_ADMIN_ACTION_TOKEN: 'unit-admin-token',
    GIB_M1_RECOVERY_TOKEN: 'unit-recovery-token',
    ...properties
  }));
  let appendFailureAfter = failAfterAppends;
  let appendAttempts = 0;
  const signins = makeSheet(initialRows, {
    maxRows: sheetMaxRows,
    beforeSetValues({ startRow, startColumn, columnCount }) {
      if (startRow < 2 || startColumn !== 1 || columnCount !== SIGNIN_HEADERS.length) return;
      if (Number.isInteger(appendFailureAfter) && appendAttempts >= appendFailureAfter) {
        throw new Error('simulated append failure');
      }
      appendAttempts += 1;
    }
  });

  const sheets = new Map([['Signins', signins]]);
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
  let spreadsheetOpens = 0;
  const driveQueries = [];
  const driveFiles = Array.from({ length: driveMatchCount }, (_, index) => ({
    getId: () => index === 0 ? 'unit-test-spreadsheet-id' : `unit-test-spreadsheet-id-${index + 1}`,
    getMimeType: () => 'application/vnd.google-apps.spreadsheet'
  }));

  const scriptProperties = {
    getProperty: name => propertyValues.get(name) || '',
    setProperty(name, value) {
      propertyValues.set(name, String(value));
      return this;
    }
  };
  const context = {
    module: { exports: {} },
    exports: {},
    console,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return {
          text,
          setMimeType() { return this; }
        };
      }
    },
    DriveApp: {
      getFilesByName(name) {
        driveQueries.push(name);
        let index = 0;
        return {
          hasNext: () => index < driveFiles.length,
          next: () => driveFiles[index++]
        };
      }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => lockAvailable,
        releaseLock() {}
      })
    },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
    PropertiesService: {
      getScriptProperties: () => scriptProperties
    },
    SpreadsheetApp: {
      openById(id) {
        spreadsheetOpens += 1;
        if (id !== 'unit-test-spreadsheet-id') throw new Error('unexpected spreadsheet');
        return spreadsheet;
      },
      flush() {}
    },
    ScriptApp: {
      getScriptId: () => 'private-unit-script-id'
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
          ? '2026-08-07 09:00:00'
          : '2026-08-07';
      }
    }
  };
  const vmContext = vm.createContext(context);
  vm.runInContext(codeSource, vmContext, { filename: 'Code.gs' });
  vm.runInContext(receiverSource, vmContext, { filename: 'GibM1Receiver.gs' });

  return {
    apps: vmContext,
    signins,
    propertyValues,
    driveQueries,
    get spreadsheetOpens() { return spreadsheetOpens; },
    clearAppendFailure() { appendFailureAfter = null; },
    post(body) {
      const output = vmContext.doPost({
        postData: { contents: JSON.stringify(body) }
      });
      return JSON.parse(output.text);
    }
  };
}

test('tracked Apps Script topology is TEST-only and contains no private identifiers', () => {
  assert.match(codeSource, /function doPost\(e\)\s*\{\s*return adReceiverV2_\(e\)/u);
  assert.match(codeSource, /var GIB_M1_ALLOWED_TARGET = 'test'/u);
  assert.match(codeSource, /GIB_M1_TEST_SPREADSHEET_ID/u);
  assert.match(codeSource, /DriveApp\.getFilesByName\(GIB_M1_TEST_SPREADSHEET_TITLE_\)/u);
  assert.match(codeSource, /matches\.length !== 1/u);
  assert.doesNotMatch(codeSource, /AKfy[A-Za-z0-9_-]{20,}|\b1[A-Za-z0-9_-]{30,}\b/u);
  assert.deepEqual(manifest.webapp, {
    access: 'ANYONE_ANONYMOUS',
    executeAs: 'USER_DEPLOYING'
  });
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.match(claspIgnore, /!Code\.gs/u);
  assert.match(claspIgnore, /!GibM1Receiver\.gs/u);
  assert.match(claspIgnore, /!appsscript\.json/u);
  assert.match(projectGitIgnore, /^\.clasp\.json$/mu);
  assert.match(projectGitIgnore, /^\.clasprc\.json$/mu);
  assert.match(projectGitIgnore, /^credentials\.json$/mu);
});

test('TEST runtime derives its server-only token and resolves the unique Sheet without stored secrets', () => {
  const expectedToken = createHash('sha256')
    .update('gib-m1-test:private-unit-script-id', 'utf8')
    .digest('base64url');
  const harness = createHarness({
    properties: {
      GIB_M1_TEST_SPREADSHEET_ID: '',
      GIB_M1_RECEIVER_TRANSPORT_TOKEN: ''
    }
  });
  const response = harness.post(receiverRequest([kioskRow()], { token: expectedToken }));
  assert.equal(response.ok, true);
  assert.equal(response.target, 'test');
  assert.equal(response.results[0].result, 'added');
  assert.deepEqual(harness.driveQueries, [EXPECTED_TITLE]);
  assert.equal(harness.spreadsheetOpens, 1);
  assert.doesNotMatch(codeSource, /private-unit-script-id/u);
});

test('provisioning resolves exactly one title, initializes headers, and returns no ID or token', () => {
  const harness = createHarness({ initialRows: [] });
  const result = harness.apps.provisionGibM1TestReceiver();
  assert.deepEqual([...harness.signins.values[0]], SIGNIN_HEADERS);
  assert.equal(harness.signins.frozenRows, 1);
  assert.equal(harness.propertyValues.get('GIB_M1_TEST_SPREADSHEET_ID'), 'unit-test-spreadsheet-id');
  assert.deepEqual(harness.driveQueries, [EXPECTED_TITLE]);
  assert.equal(result.target, 'test');
  assert.equal(result.spreadsheetMatches, 1);
  assert.equal(result.headerCount, SIGNIN_HEADERS.length);
  assert.equal(result.dataRowCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /unit-test-spreadsheet-id|unit-receiver-token/u);
});

test('provisioning rejects duplicate exact-title spreadsheets without replacing the stored ID', () => {
  const harness = createHarness({
    initialRows: [],
    driveMatchCount: 2,
    properties: { GIB_M1_TEST_SPREADSHEET_ID: 'previous-private-id' }
  });
  assert.throws(
    () => harness.apps.provisionGibM1TestReceiver(),
    /exactly one Google Sheet/u
  );
  assert.equal(harness.propertyValues.get('GIB_M1_TEST_SPREADSHEET_ID'), 'previous-private-id');
  assert.equal(harness.spreadsheetOpens, 0);
});

test('explicit kiosk action uses receiver transport auth while omitted action stays legacy-compatible', () => {
  const explicit = createHarness();
  assert.equal(explicit.post(receiverRequest([kioskRow()])).results[0].result, 'added');

  const explicitLegacy = createHarness();
  assert.equal(explicitLegacy.post(receiverRequest([kioskRow()], {
    token: 'unit-legacy-token'
  })).result, 'rejected');
  assert.equal(explicitLegacy.spreadsheetOpens, 0);

  const legacy = createHarness();
  const legacyResponse = legacy.post({
    token: 'unit-legacy-token',
    rows: [kioskRow()]
  });
  assert.equal(legacyResponse.results[0].result, 'added');

  const legacyWithReceiverToken = createHarness();
  assert.equal(legacyWithReceiverToken.post({
    token: 'unit-receiver-token',
    rows: [kioskRow()]
  }).result, 'rejected');

  const missingTarget = createHarness();
  assert.equal(missingTarget.post({
    token: 'unit-receiver-token',
    action: 'kioskSignIn',
    rows: [kioskRow()]
  }).result, 'rejected');
  assert.equal(missingTarget.spreadsheetOpens, 0);
});

test('standalone TEST wrapper rejects a production target before Sheet access', () => {
  const harness = createHarness();
  const response = harness.post(receiverRequest([kioskRow()], { target: 'production' }));
  assert.equal(response.result, 'rejected');
  assert.equal(harness.spreadsheetOpens, 0);
  assert.equal(harness.signins.values.length, 1);
});

test('two fake rows receive one readable result each and write exact RowIDs', () => {
  const harness = createHarness();
  const rows = [
    kioskRow({ RowID: 'test-row-101' }),
    kioskRow({
      RowID: 'test-row-102',
      Timestamp: '2026-08-06 10:00:00',
      'Class Label': '10:00 AM QA TEST BJJ',
      Instructor: 'QA Second Test Instructor'
    })
  ];
  const response = harness.post(receiverRequest(rows));
  assert.equal(response.ok, true);
  assert.equal(response.target, 'test');
  assert.deepEqual(
    response.results.map(result => [result.rowId, result.result]),
    [['test-row-101', 'added'], ['test-row-102', 'added']]
  );
  assert.deepEqual(harness.signins.values.slice(1).map(row => row[0]), ['test-row-101', 'test-row-102']);
  assert.deepEqual(
    harness.signins.operations.map(operation => [operation.type, operation.row, operation.column || '', operation.format || '']),
    [
      ['numberFormat', 2, 2, '@'],
      ['numberFormat', 2, 3, '@'],
      ['setValues', 2, 1, ''],
      ['numberFormat', 3, 2, '@'],
      ['numberFormat', 3, 3, '@'],
      ['setValues', 3, 1, '']
    ]
  );
});

test('a full Signins grid expands before a literal-text row write', () => {
  const harness = createHarness({ sheetMaxRows: 1 });
  const response = harness.post(receiverRequest([kioskRow({ RowID: 'test-row-grid-growth' })]));
  assert.equal(response.results[0].result, 'added');
  assert.deepEqual(harness.signins.operations[0], {
    type: 'insertRowsAfter',
    row: 1,
    count: 1
  });
  assert.equal(harness.signins.numberFormats.get('2:2'), '@');
  assert.equal(harness.signins.numberFormats.get('2:3'), '@');
  assert.equal(harness.signins.values[1][1], '2026-08-06 09:00:00');
  assert.equal(harness.signins.values[1][2], '2026-08-06');
});

test('TEST fake-name enforcement is per row in a mixed batch', () => {
  const harness = createHarness();
  const response = harness.post(receiverRequest([
    kioskRow({ RowID: 'test-row-fake' }),
    kioskRow({
      RowID: 'test-row-real-name',
      Timestamp: '2026-08-06 10:00:00',
      Instructor: 'Ordinary Instructor'
    })
  ]));
  assert.equal(response.ok, true);
  assert.deepEqual(
    response.results.map(result => [result.rowId, result.result]),
    [['test-row-fake', 'added'], ['test-row-real-name', 'rejected']]
  );
  assert.equal(harness.signins.values.length, 2);
  assert.equal(harness.signins.values[1][0], 'test-row-fake');
});

test('exact replay is idempotent and changed content under one RowID is rejected', () => {
  const harness = createHarness();
  const row = kioskRow({ RowID: 'test-row-replay' });
  assert.equal(harness.post(receiverRequest([row])).results[0].result, 'added');
  assert.equal(harness.post(receiverRequest([row])).results[0].result, 'already exists');
  assert.equal(harness.post(receiverRequest([{
    ...row,
    Notes: 'QA TEST changed payload'
  }])).results[0].result, 'rejected');
  assert.equal(harness.signins.values.length, 2);
});

test('duplicate input RowIDs fail closed before Sheet access', () => {
  const harness = createHarness();
  const response = harness.post(receiverRequest([
    kioskRow({ RowID: 'test-row-duplicate' }),
    kioskRow({
      RowID: 'test-row-duplicate',
      Timestamp: '2026-08-06 10:00:00'
    })
  ]));
  assert.equal(response.ok, false);
  assert.equal(response.target, 'test');
  assert.equal(response.result, 'rejected');
  assert.deepEqual(response.results.map(result => result.result), ['rejected', 'rejected']);
  assert.equal(harness.spreadsheetOpens, 0);
  assert.equal(harness.signins.values.length, 1);
});

test('VOID or duplicate stored RowIDs are conflicts and can never append', () => {
  const row = kioskRow({ RowID: 'test-row-stored-conflict' });
  const voidHarness = createHarness({
    initialRows: [SIGNIN_HEADERS, sheetRow(row, 'VOID')]
  });
  assert.equal(voidHarness.post(receiverRequest([row])).results[0].result, 'rejected');
  assert.equal(voidHarness.signins.values.length, 2);

  const duplicateHarness = createHarness({
    initialRows: [SIGNIN_HEADERS, sheetRow(row), sheetRow(row)]
  });
  assert.equal(duplicateHarness.post(receiverRequest([row])).results[0].result, 'rejected');
  assert.equal(duplicateHarness.signins.values.length, 3);
});

test('partial append failure is readable and retry completes without duplicates', () => {
  const harness = createHarness({ failAfterAppends: 1 });
  const rows = [
    kioskRow({ RowID: 'test-row-partial-1' }),
    kioskRow({
      RowID: 'test-row-partial-2',
      Timestamp: '2026-08-06 10:00:00',
      Instructor: 'QA Partial Test Instructor'
    })
  ];
  const first = harness.post(receiverRequest(rows));
  assert.deepEqual(first.results.map(result => result.result), ['added', 'failed']);
  assert.equal(harness.signins.values.length, 2);

  harness.clearAppendFailure();
  const retry = harness.post(receiverRequest(rows));
  assert.deepEqual(retry.results.map(result => result.result), ['already exists', 'added']);
  assert.deepEqual(
    harness.signins.values.slice(1).map(row => row[0]),
    ['test-row-partial-1', 'test-row-partial-2']
  );
});
