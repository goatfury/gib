import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = name => readFileSync(new URL(`../integrations/google-apps-script/${name}`, import.meta.url), 'utf8');
const receiverSource = source('GibM1Receiver.gs');
const managerSource = source('GibM1ManagerReview.gs');
const wrapperSource = source('richmond-test/Code.gs');
const clone = value => JSON.parse(JSON.stringify(value));
const date = '2026-09-28';

function sheet(name, rows = []) {
  const values = clone(rows);
  return {
    values, getName: () => name, getLastRow: () => values.length, getMaxRows: () => 1000,
    getDataRange: () => ({ getValues: () => clone(values) }),
    appendRow: row => values.push(clone(row)), setFrozenRows() {},
    getRange(r, c, height = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => values[r - 1 + y]?.[c - 1 + x] ?? '')),
        setNumberFormat() { return this; },
        setValues(rows) {
          rows.forEach((row, y) => {
            values[r - 1 + y] ||= [];
            row.forEach((value, x) => { values[r - 1 + y][c - 1 + x] = value; });
          });
          return this;
        },
        setValue(value) { values[r - 1][c - 1] = value; return this; }
      };
    }
  };
}

function harness({ richmond = true } = {}) {
  const properties = new Map([
    ['GIB_M1_RICHMOND_TEST_SPREADSHEET_ID', 'synthetic-richmond-sheet'],
    ['GIB_M1_DEPLOYMENT_TARGET_LOCK', 'test'], ['GIB_M1_INSTALLATION_LOCK', 'richmond'],
    ['GIB_M1_ENVIRONMENT_LOCK', 'test'], ['GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED', 'richmond-test-v1']
  ]);
  const sheets = new Map();
  let title = 'Richmond BJJ M1 — TEST';
  const spreadsheet = {
    getName: () => title, getId: () => 'synthetic-richmond-sheet',
    getSheetByName: name => sheets.get(name),
    insertSheet(name) { const value = sheet(name); sheets.set(name, value); return value; }
  };
  const context = vm.createContext({
    Date, JSON, console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties.get(name) || '' }) },
    ScriptApp: { getScriptId: () => 'synthetic-richmond-script' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, spreadsheet.getId()); return spreadsheet; }, flush() {} },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, getContent: () => text, setMimeType() { return this; } }) },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' }, DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_algorithm, text) => [...createHash('sha256').update(text).digest()],
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      formatDate(value, _timezone, pattern) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(value).map(p => [p.type, p.value]));
        if (pattern === 'Z') return '-0400';
        const day = `${parts.year}-${parts.month}-${parts.day}`;
        return pattern === 'yyyy-MM-dd' ? day : `${day} ${parts.hour}:${parts.minute}:${parts.second}`;
      }
    }
  });
  if (richmond) vm.runInContext(wrapperSource, context);
  vm.runInContext(receiverSource, context);
  vm.runInContext(managerSource, context);
  context.todayNewYork_ = () => '2026-09-29';
  context.timestampNewYork_ = () => '2026-09-29 12:00:00';
  context.timestampExact_ = () => '2026-09-29T16:00:00.000Z';
  sheets.set('Signins', sheet('Signins', [clone(context.GIB_M1_SIGNINS_HEADERS_)]));
  sheets.set('Admin Audit', sheet('Admin Audit', [clone(context.GIB_M1_AUDIT_HEADERS_)]));
  const envelope = () => ({
    token: context.gibM1DerivedReceiverSecret_(), adminActionToken: context.gibM1DerivedAdminActionSecret_(),
    target: 'test', installation: 'richmond', environment: 'test', gym: 'richmond', adminName: 'Trey Martin',
    from: '2026-09-07', to: '2026-09-29'
  });
  return {
    context, properties, sheets, spreadsheet, rename: value => { title = value; },
    post: body => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ ...envelope(), ...body }) } }).text)
  };
}

const addition = overrides => ({
  action: 'addMissedInstructor', requestId: 'manager-add-12345678-1234-4123-8123-123456789012',
  date, classLabel: '9:00 AM TEST BJJ', duration: 1, instructor: 'QA TEST Instructor',
  site: 'Richmond', notes: 'Synthetic TEST fixture', reason: 'TEST missed class', ...overrides
});

test('Trey can add, reread, review, recover his save, and audit a Richmond TEST correction', () => {
  const h = harness();
  const added = h.post(addition());
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.confirmation.adminName, 'Trey Martin');
  assert.equal(h.post(addition()).linkedRecordId, added.linkedRecordId);
  assert.equal(h.sheets.get('Signins').values.length, 2);
  const record = h.context.readSignins_(h.sheets.get('Signins')).records[0];
  assert.equal(h.context.adminAttribution_(record).adminName, 'Trey Martin');
  const daily = h.post({ action: 'dailyReview', date });
  assert.equal(daily.ok, true);
  assert.equal(daily.auditHistory[0].adminName, 'Trey Martin');
  assert.equal(daily.warnings.length, 0);
  const day = h.post({ action: 'managerReviewRead' }).days.find(d => d.date === date);
  const review = {
    requestId: 'manager-trey1234567890123456', date, action: 'complete', revision: 0,
    attendanceHash: day.attendanceHash, scheduleHash: 'a'.repeat(64), decisions: [], snapshot: { records: day.records }
  };
  assert.equal(h.post({ action: 'managerReviewSave', date, review }).saved, true);
  assert.equal(h.post({ action: 'managerReviewSave', date, review }).retry, true);
  const readback = h.post({ action: 'managerReviewRead', check: review });
  assert.equal(readback.receipt.saved, true);
  assert.equal(readback.days.find(d => d.date === date).review.reviewer, 'Trey Martin');
  assert.equal(h.post({ action: 'managerReviewRead', check: review, adminName: 'Andrew Smith' }).ok, false);
  assert.equal(h.post({ action: 'managerReviewRead', check: review, adminName: 'Unknown Reviewer' }).ok, false);
  const removed = h.post({ action: 'managerReviewVoid', date, recordId: added.linkedRecordId, fingerprint: day.records[0].fingerprint, reason: 'TEST fixture correction' });
  assert.equal(removed.removed, true);
  const history = h.post({ action: 'dailyReview', date });
  assert.equal(history.ok, true);
  assert.equal(history.auditHistory.length, 2);
  assert.ok(history.auditHistory.every(row => row.adminName === 'Trey Martin'));
  assert.equal(history.warnings.length, 0);
});

test('every Richmond TEST persisted lock and title condition is required for Trey', () => {
  for (const key of ['GIB_M1_DEPLOYMENT_TARGET_LOCK', 'GIB_M1_INSTALLATION_LOCK', 'GIB_M1_ENVIRONMENT_LOCK', 'GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED', 'GIB_M1_RICHMOND_TEST_SPREADSHEET_ID']) {
    for (const value of ['', 'wrong']) {
      const h = harness();
      h.properties.set(key, value);
      assert.equal(h.context.instructorAdminNameAllowed_('Trey Martin'), false, `${key}/${value}`);
      assert.equal(h.post(addition()).ok, false);
      assert.equal(h.sheets.get('Signins').values.length, 1);
      assert.equal(h.sheets.get('Admin Audit').values.length, 1);
    }
  }
  for (const key of ['EXPECTED_SPREADSHEET_NAME', 'GIB_M1_RICHMOND_SPREADSHEET_TITLE_', 'GIB_M1_RICHMOND_INSTALLATION_', 'GIB_M1_RICHMOND_ENVIRONMENT_', 'GIB_M1_ALLOWED_TARGET']) {
    const h = harness();
    h.context[key] = 'wrong';
    assert.equal(h.context.instructorAdminNameAllowed_('Trey Martin'), false, key);
  }
  const renamed = harness();
  renamed.rename('Richmond BJJ M1 — PRODUCTION');
  assert.equal(renamed.post(addition()).ok, false);
  assert.equal(renamed.sheets.get('Signins').values.length, 1);
});

test('Trey is denied without the wrapper, outside its exact scope, and for another site', () => {
  const baseline = harness({ richmond: false }).context;
  assert.deepEqual(clone(baseline.GIB_M1_ADMIN_NAMES_), ['Andrew Smith', 'Stuart Turner']);
  assert.equal(baseline.instructorAdminNameAllowed_('Trey Martin'), false);
  for (const name of ['Andrew Smith', 'Stuart Turner']) assert.equal(baseline.instructorAdminNameAllowed_(name), true);
  for (const scope of [null, {}, { installation: 'rev', environment: 'test', gym: 'richmond', target: 'test' },
    { installation: 'richmond', environment: 'production', gym: 'richmond', target: 'test' },
    { installation: 'richmond', environment: 'test', gym: 'rev', target: 'test' },
    { installation: 'richmond', environment: 'test', gym: 'richmond', target: 'production' }]) {
    const h = harness();
    h.context.gibM1RichmondTestScope_ = () => scope;
    assert.equal(h.context.instructorAdminNameAllowed_('Trey Martin'), false);
    assert.equal(h.post({ action: 'managerReviewRead' }).ok, false);
  }
  const h = harness();
  assert.equal(h.context.instructorAdminNameAllowed_('Trey Martin', 'Rev'), false);
  assert.equal(h.context.instructorAdminNameAllowed_('trey martin'), false);
  h.context.gibM1RichmondTestScope_ = () => { throw new Error('Scope unavailable'); };
  assert.equal(h.context.instructorAdminNameAllowed_('Trey Martin'), false);
  h.context.GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ = 'richmond';
  assert.equal(h.context.instructorAdminNameAllowed_('Trey Martin'), false);
});

test('saved Trey history becomes unreadable outside Richmond TEST and cannot claim another gym', () => {
  const h = harness();
  assert.equal(h.post(addition()).ok, true);
  const day = h.post({ action: 'managerReviewRead' }).days.find(d => d.date === date);
  const review = { requestId: 'manager-history1234567890123456', date, action: 'partial', revision: 0, attendanceHash: day.attendanceHash, scheduleHash: 'a'.repeat(64), decisions: [], snapshot: {} };
  assert.equal(h.post({ action: 'managerReviewSave', date, review }).saved, true);
  h.sheets.get('Manager Reviews').values[1][1] = 'rev';
  assert.throws(() => h.context.managerJournal_(h.spreadsheet, false), /Review history conflict/);
  h.sheets.get('Manager Reviews').values[1][1] = 'richmond';
  h.properties.set('GIB_M1_ENVIRONMENT_LOCK', 'production');
  assert.throws(() => h.context.managerJournal_(h.spreadsheet, false), /Review history conflict/);
  const audit = h.context.readAdminAuditHistory_(h.spreadsheet, date);
  assert.equal(audit.history.length, 0);
  assert.equal(audit.warnings[0].code, 'UNREADABLE_AUDIT');
});

test('Revolution addition proof, removal and Staff checks retain the shared two-name contract', () => {
  const h = harness();
  const { action, ...original } = addition({ site: 'Rev' });
  assert.match(h.context.managerAdditionCheckHash_(original, 'Andrew Smith', 'test'), /^[a-f0-9]{64}$/);
  assert.throws(() => h.context.managerAdditionCheckHash_(original, 'Trey Martin', 'test'), /Invalid original addition binding/);
  const uuid = '12345678-1234-4123-8123-123456789012';
  const staff = { requestId: `gib-m1-staff-request-${uuid}`, punchId: `gib-m1-staff-${uuid}`, reason: 'TEST correction', adminName: 'Andrew Smith' };
  assert.ok(h.context.validateStaffTimeVoid_(staff));
  assert.equal(h.context.validateStaffTimeVoid_({ ...staff, adminName: 'Trey Martin' }), null);
  const record = { rowId: `gib-m1-${uuid}`, sheetRow: 2 };
  const operation = { adminName: 'Andrew Smith', fingerprint: 'a'.repeat(64), reason: 'TEST correction', removalVersion: 'revolution-instructor-removal-v1', requestId: `gib-m1-admin-void-${record.rowId}`, rowId: record.rowId };
  const removalContext = name => ({ notes: [[''], [JSON.stringify({ ...operation, adminName: name })]] });
  assert.equal(h.context.revolutionRemovalOperation_(record, removalContext('Andrew Smith')).adminName, 'Andrew Smith');
  assert.throws(() => h.context.revolutionRemovalOperation_(record, removalContext('Trey Martin')), /protected/);
  h.context.GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_ = 'Richmond BJJ M1 — PRODUCTION';
  const productionSheet = { getName: () => 'Richmond BJJ M1 — PRODUCTION' };
  const richmondVoid = { requestId: operation.requestId, rowId: record.rowId, adminName: 'Andrew Smith', reason: operation.reason };
  assert.ok(h.context.validateRichmondInstructorVoid_(richmondVoid, productionSheet));
  assert.equal(h.context.validateRichmondInstructorVoid_({ ...richmondVoid, adminName: 'Trey Martin' }, productionSheet), null);
});
