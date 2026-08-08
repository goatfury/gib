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
const ROW_ID = 'gib-m1-12345678-1234-4123-8123-123456789abc';

function makeSheet(initialRows = [], onWrite = () => {}) {
  const values = initialRows.map(row => [...row]);
  const numberFormats = new Map();
  let maxRows = Math.max(1000, values.length);
  let frozenRows = 0;
  return {
    values,
    numberFormats,
    get frozenRows() { return frozenRows; },
    deleteRow(rowNumber) {
      onWrite('deleteRow');
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
  strictWithoutWrapper = false
} = {}) {
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
  const recordSheetWrite = operation => sheetWriteEvents.push(operation);
  let signins = initialRows === null ? null : makeSheet(initialRows, recordSheetWrite);
  let spreadsheetOpens = 0;
  let spreadsheetCreates = 0;
  let driveQueries = 0;
  const spreadsheetId = 'production-spreadsheet-id';
  const spreadsheet = {
    getId: () => spreadsheetId,
    getName: () => EXPECTED_TITLE,
    getSheetByName(name) {
      return name === 'Signins' ? signins : null;
    },
    insertSheet(name) {
      assert.equal(name, 'Signins');
      recordSheetWrite('insertSheet');
      signins = makeSheet([], recordSheetWrite);
      return signins;
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
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return { text, setMimeType() { return this; } };
      }
    },
    DriveApp: {
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
        return Buffer.from(bytes.map(value => value < 0 ? value + 256 : value)).toString('base64url');
      },
      computeDigest(_algorithm, value, charset) {
        assert.equal(charset, 'UTF_8');
        return [...createHash('sha256').update(String(value), 'utf8').digest()];
      },
      computeHmacSha256Signature(value, secret, charset) {
        assert.equal(charset, 'UTF_8');
        return [...createHmac('sha256', String(secret)).update(String(value), 'utf8').digest()];
      },
      formatDate(_value, _zone, pattern) {
        return pattern === 'yyyy-MM-dd HH:mm:ss'
          ? '2026-08-07 12:00:00'
          : '2026-08-07';
      }
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
