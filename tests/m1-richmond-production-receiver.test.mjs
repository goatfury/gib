import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { handleManagerReview } from '../netlify/functions/m1-manager-review.mjs';
import { handleAdminAdd } from '../netlify/functions/m1-admin-add.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { buildAttendanceDigest, defaultDigestConfiguration } from '../netlify/functions/_lib/m1-attendance-digest.mjs';

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
        setNumberFormat() { return this; },
        setValue(value) { return this.setValues([[value]]); }
      };
    },
    get frozenRows() { return frozenRows; }
  };
}

function createHarness({ provisioned = true, duplicateSheets = false, liveFeatures = false, optionalSheets = [], managerReview = false, managerReviewSetting = 'active', now = FIXED_RICHMOND_NOW } = {}) {
  const scriptId = 'richmond-production-unit-script-id';
  const signins = makeSheet('Signins', [SIGNIN_HEADERS]);
  const audit = makeSheet('Admin Audit', [AUDIT_HEADERS]);
  const spreadsheet = {
    getId: () => 'richmond-production-unit-sheet-id',
    getName: () => SHEET_TITLE,
    getSheetByName: name => [signins, audit, ...optionalSheets].find(sheet => sheet.getName() === name) || null,
    getSheets: () => [signins, audit, ...optionalSheets],
    insertSheet(name) { const sheet = makeSheet(name, []); optionalSheets.push(sheet); return sheet; }
  };
  const properties = new Map(provisioned ? [
    ['GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_ID', spreadsheet.getId()],
    ['GIB_M1_DEPLOYMENT_TARGET_LOCK', 'production'],
    ['GIB_M1_INSTALLATION_LOCK', 'richmond'],
    ['GIB_M1_ENVIRONMENT_LOCK', 'production'],
    ['GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED', 'richmond-production-v1'],
    ['GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'false']
  ] : []);
  if (managerReview && managerReviewSetting != null) properties.set('GIB_M1_MANAGER_REVIEW_LIVE_PILOT', managerReviewSetting);
  let spreadsheetOpens = 0;
  const context = vm.createContext({
    console,
    Date: now === FIXED_RICHMOND_NOW ? FixedReceiverDate : class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
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
  if (liveFeatures) vm.runInContext(readFileSync(new URL('integrations/google-apps-script/GibM1LiveFeatures.gs', ROOT), 'utf8'), context);
  if (managerReview) vm.runInContext(readFileSync(new URL('integrations/google-apps-script/GibM1ManagerReview.gs', ROOT), 'utf8'), context);
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

// Exercise the enabled production entrypoints, but only with in-memory Sheets,
// synthetic credentials and a fake transport. Nothing here reaches a real gym.
function managerFixture() {
  const now = Date.parse('2026-09-30T00:05:00Z'), date = '2026-09-29';
  const origin = 'https://gib-richmond-live.netlify.app';
  const page = 'isolated-manager-page-012345678901234567890123';
  const journals = [], h = createHarness({ managerReview: true, liveFeatures: true, optionalSheets: journals, now });
  h.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'true');
  h.properties.set('GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED', 'true');
  const env = {
    GIB_M1_ENVIRONMENT: 'production', GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED: 'true',
    GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true',
    GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/ISOLATED_RICHMOND/exec',
    GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: derivedSecret('gib-m1-richmond-production'),
    GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: derivedSecret('gib-m1-richmond-production-admin'),
    GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'isolated silver mountain meadow',
    GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'isolated-rich-device-01234567890123456789'
  };
  const runtime = runtimeConfig(env, { admin: true, requestUrl: origin + '/api/m1-manager-review', installationId: 'richmond', environment: 'production', activation: 'active' });
  assert.ok(runtime);
  const cookie = createAdminSession('Trey Martin', runtime.sessionSecret, now, page, runtime);
  const labels = ['9:00 AM Fundamentals', '1:00 PM Open Mat', '5:00 PM Adult BJJ'];
  const calls = [], fault = { lose: null, receipt: null };
  const dependencies = { enabled: true, target: 'production', installationId: 'richmond', environment: 'production', activation: 'active',
    env, now, dateNow: new Date(now), traceLog() {},
    context: { site: { name: 'gib-richmond-live', id: '9b7757a9-70f4-4977-9ca2-270b41e34007' }, deploy: { context: 'production', published: true } },
    schedule: { current: true, timezone: 'America/New_York', days: { Tuesday: labels } },
    addedStore: { getWithMetadata: async () => null },
    fetch: async (url, options) => {
      assert.equal(url, runtime.webhookUrl);
      const body = JSON.parse(options.body); calls.push(body);
      const result = h.post(body);
      if (fault.lose === body.action) { fault.lose = null; throw new TypeError('Isolated lost confirmation after central saving'); }
      if (body.action === 'managerReviewRead' && result.receipt && fault.receipt) fault.receipt(result);
      return new Response(JSON.stringify(result));
    }
  };
  const request = (path, body, extra = {}) => new Request(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Host: new URL(origin).host, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
      Cookie: ADMIN_COOKIE + '=' + cookie, [ADMIN_REQUEST_HEADER]: page, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const run = (body, overrides = {}, headers = {}) => handleManagerReview(request('/api/m1-manager-review', body, headers), { ...dependencies, ...overrides });
  const read = async () => { const response = await run({ action: 'read' }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const original = (day, suffix, decisions) => ({ action: 'partial', requestId: 'manager-richmond-' + suffix.padEnd(20, '0'), date,
    revision: day.revision, attendanceHash: day.attendanceHash, scheduleHash: day.scheduleHash, decisions });
  const ledger = () => h.post(productionRequest('managerReviewRead', { gym: 'richmond', from: '2026-09-07', to: date, check: null, adminName: 'Trey Martin' }));
  const digest = () => {
    const current = ledger(); assert.equal(current.ok, true);
    const configuration = defaultDigestConfiguration({ target: 'production', liveFeatures: { reminders: true }, profile: { installationId: 'richmond', environment: 'production', activation: 'active', gymName: 'Richmond BJJ' } });
    const schedules = [{ gym: 'richmond', timezone: 'America/New_York', days: current.days.map(day => ({ date: day.date,
      status: 'complete', observedAt: day.date + 'T12:00:00.000Z', sourceVersion: 'isolated-known-schedule',
      occurrences: day.date === date ? labels.map((label, i) => ({ label, startAt: date + 'T' + ['13', '17', '21'][i] + ':00:00.000Z',
        endAt: date + 'T' + ['14', '18', '22'][i] + ':00:00.000Z', cancelled: false })) : [] })) }];
    return buildAttendanceDigest({ jobDate: date, configuration, schedules, now,
      snapshots: [{ gym: 'richmond', attendance: { ok: true, ledger: current }, staff: { ok: true, complete: true, items: [], notApplicable: true } }] });
  };
  return { h, now, date, journals, dependencies, calls, fault, labels, request, run, read, original, ledger, digest };
}

test('Richmond production class decisions and an instructor addition recover their original requests once and affect fresh reminders', async () => {
  const f = managerFixture();
  let day = (await f.read()).days.find(day => day.date === f.date);
  const cancellation = f.original(day, 'cancel', [{ label: f.labels[0], outcome: 'not-held' }]);
  f.fault.lose = 'managerReviewSave';
  assert.equal((await f.run(cancellation)).status, 503);
  assert.equal(f.journals[0].values.length, 2, 'lost reply does not erase the saved decision or its audit');
  for (let reload = 0; reload < 2; reload++) {
    const response = await f.run(structuredClone(cancellation));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).receipt, { saved: true, requestId: cancellation.requestId, revision: 1 });
  }
  assert.equal(f.calls.filter(call => call.action === 'managerReviewSave').length, 1);
  assert.equal(f.journals[0].values.length, 2);
  assert.deepEqual(f.journals[0].values[1].slice(0, 5), [cancellation.requestId, 'richmond', f.date, 1, 'Trey Martin']);
  assert.equal(f.digest().groups[0].items.some(item => item.summary.includes(f.labels[0])), false, 'saved cancellation is not missing attendance');

  day = (await f.read()).days.find(day => day.date === f.date);
  const unknown = f.original(day, 'unknown', [...cancellation.decisions, { label: f.labels[1], outcome: 'unknown' }]);
  f.fault.lose = 'managerReviewSave';
  assert.equal((await f.run(unknown)).status, 503);
  assert.equal((await f.run(structuredClone(unknown))).status, 200);
  assert.equal((await f.run(structuredClone(unknown))).status, 200);
  assert.equal(f.journals[0].values.length, 3, 'one history row per original decision request');
  day = (await f.read()).days.find(day => day.date === f.date);
  assert.equal(day.complete, false);
  assert.equal(day.classes.find(item => item.label === f.labels[1]).outcome, 'unknown');
  assert.equal((await f.run({ ...f.original(day, 'complete', unknown.decisions), action: 'complete' })).status, 409);

  const addition = { requestId: 'm1-' + f.date + '-' + '1'.repeat(24), date: f.date, classLabel: f.labels[2], duration: 1,
    instructor: 'Alex Morgan', site: 'Richmond', notes: '', reason: 'Forgot to sign into this class' };
  f.fault.lose = 'addMissedInstructor';
  assert.equal((await handleAdminAdd(f.request('/api/m1-admin-add', addition), f.dependencies)).status, 504);
  for (let reload = 0; reload < 2; reload++) assert.equal((await handleAdminAdd(f.request('/api/m1-admin-add', structuredClone(addition)), f.dependencies)).status, 200);
  assert.equal(f.h.signins.values.length, 2); assert.equal(f.h.audit.values.length, 2);
  assert.equal(f.h.audit.values[1][1], 'Trey Martin');
  assert.equal(f.h.audit.values[1][10], f.h.signins.values[1][0], 'addition has its matching permanent-record audit');
  const digest = f.digest();
  assert.equal(digest.itemCount, 2, 'the unknown occurrence retains both its missing sign-in and its unresolved question');
  assert.ok(digest.groups[0].items.some(item => item.kind === 'class-question'));
  assert.ok(digest.groups[0].items.every(item => item.summary.includes(f.labels[1])));

  const late = kioskRow({ Date: f.date, Timestamp: f.date + ' 09:05:00', 'Class Label': f.labels[0] });
  assert.equal(f.h.post(productionRequest('kioskSignIn', { rows: [late] })).ok, true);
  assert.ok(f.digest().groups[0].items.some(item => item.kind === 'attendance-conflict'), 'a cancellation never silently erases contradictory teaching');
  assert.equal(f.h.signins.values.length, 3);
  assert.equal(f.h.context.GIB_M1_STAFF_CLOCK_ENABLED, false);
});

test('Richmond review recovery rejects mismatched or incomplete evidence without dispatching another save', async () => {
  const f = managerFixture(), day = (await f.read()).days.find(day => day.date === f.date);
  const original = f.original(day, 'receipt', [{ label: f.labels[0], outcome: 'not-held' }]);
  assert.equal((await f.run(original)).status, 200);
  for (const corrupt of [result => { delete result.receipt.revision; }, result => { result.receipt.requestId += '-wrong'; }, result => { result.receipt.revision += 1; }]) {
    f.fault.receipt = corrupt;
    assert.equal((await f.run(structuredClone(original))).status, 503);
  }
  f.fault.receipt = null;
  assert.equal((await f.run({ ...original, decisions: [{ label: f.labels[0], outcome: 'unknown' }] })).status, 503);
  assert.equal((await f.run(original)).status, 200);
  assert.equal(f.calls.filter(call => call.action === 'managerReviewSave').length, 1);
  assert.equal(f.journals[0].values.length, 2);
});

test('overlapping Richmond decision requests retain one original audit and reject a stale competing change', async () => {
  const f = managerFixture(), day = (await f.read()).days.find(day => day.date === f.date);
  const original = f.original(day, 'overlap', [{ label: f.labels[0], outcome: 'not-held' }]);
  const repeated = await Promise.all([f.run(original), f.run(structuredClone(original))]);
  assert.ok(repeated.every(response => response.status === 200));
  assert.equal(f.journals[0].values.length, 2);
  assert.equal((await f.run({ ...original, requestId: original.requestId + '-other', decisions: [{ label: f.labels[0], outcome: 'unknown' }] })).status, 409);
  assert.equal(f.journals[0].values.length, 2);
});

test('Richmond Google manager activation is exact and reminder-only reads never authorize decision recovery or writes', () => {
  for (const value of [null, 'false', 'true', 'ACTIVE']) {
    const h = createHarness({ managerReview: true, managerReviewSetting: value, liveFeatures: true });
    h.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'true');
    const read = productionRequest('managerReviewRead', { gym: 'richmond', from: '2026-09-07', to: '2026-08-21', check: null });
    assert.equal(h.context.managerReviewEnabled_(), false);
    assert.equal(h.post(read).ok, false); assert.equal(h.spreadsheetOpens, 0);
    h.properties.set('GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED', 'true');
    assert.equal(h.context.gibM1RichmondProductionActionValid_(read), true);
    assert.equal(h.context.gibM1RichmondProductionActionValid_({ ...read, check: { requestId: 'manager-original0000000000' } }), false);
    assert.equal(h.context.gibM1RichmondProductionActionValid_({ ...read, action: 'managerReviewSave' }), false);
    assert.equal(h.context.managerReviewEnabled_(), false, 'reminders do not switch on manager edits');
  }
});

test('enabled Richmond review keeps authenticated own-gym, write, publication and reviewer restrictions', async () => {
  const f = managerFixture(), before = f.calls.length;
  assert.equal((await f.run({ action: 'read' }, {}, { Cookie: '' })).status, 401);
  assert.equal((await f.run({ action: 'read' }, {}, { [ADMIN_REQUEST_HEADER]: 'wrong' })).status, 403);
  assert.equal((await f.run({ action: 'read' }, {}, { Origin: 'https://gib-live.netlify.app' })).status, 403);
  assert.equal((await f.run({ action: 'read' }, { enabled: false })).status, 404);
  for (const patch of [{ target: 'test' }, { installationId: 'rev' }, { activation: 'pending' },
    { context: { ...f.dependencies.context, site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' } } },
    { context: { ...f.dependencies.context, deploy: { context: 'production', published: false } } }]) {
    assert.equal((await f.run({ action: 'read' }, patch)).status, 403);
  }
  assert.equal(f.calls.length, before, 'rejected app requests never reach Google');
  const base = { gym: 'richmond', from: '2026-09-07', to: f.date, check: null, adminName: 'Trey Martin' };
  for (const patch of [{ gym: 'rev' }, { installation: 'rev' }, { target: 'test' }, { environment: 'test' },
    { token: 'wrong' }, { adminActionToken: 'wrong' }, { adminName: 'Unauthorized Reviewer' }]) {
    assert.equal(f.h.post(productionRequest('managerReviewRead', { ...base, ...patch })).ok, false);
  }
  f.h.properties.set('GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED', 'false');
  assert.equal(f.h.post(productionRequest('managerReviewRead', base)).ok, false);
  assert.equal((await f.run({ action: 'read' }, { env: { ...f.dependencies.env, GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED: 'false' } })).status, 401);
  f.h.properties.set('GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED', 'true');
  const day = (await f.read()).days.find(day => day.date === f.date);
  f.h.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'false');
  assert.equal((await f.run(f.original(day, 'writesoff', [{ label: f.labels[0], outcome: 'not-held' }]))).status, 503);
  assert.equal(f.journals.length, 0); assert.equal(f.h.signins.values.length, 1); assert.equal(f.h.audit.values.length, 1);
});

test('enabled Trey production correction remains Richmond-only, auditable after deactivation, and accepts only validated retained journals', () => {
  const journals = [makeSheet('Manager Reviews', [['Request ID', 'Gym', 'Date', 'Revision', 'Reviewer', 'Time', 'Action', 'Attendance hash', 'Schedule hash', 'Decisions', 'Reviewed data', 'Request hash']]),
    makeSheet('MailApp Attempts', [['Message ID', 'Event', 'Payload Hash', 'Gym', 'Opportunity Date', 'Request ID', 'Attempted At', 'Completed At', 'Code', 'Sender']])];
  const h = createHarness({ liveFeatures: true, optionalSheets: journals });
  h.properties.set('GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED', 'true');
  const row = kioskRow(); assert.equal(h.post(productionRequest('kioskSignIn', { rows: [row] })).ok, true);
  const correction = productionRequest('voidInstructorSignin', { adminName: 'Trey Martin', rowId: row.RowID,
    requestId: 'gib-m1-admin-void-' + row.RowID, reason: 'Isolated correction fixture' });
  assert.equal(h.post(correction).result, 'rejected'); assert.equal(h.audit.values.length, 1);
  h.properties.set('GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED', 'true');
  const saved = h.post(correction); assert.equal(saved.result, 'voided'); assert.equal(saved.confirmation.adminName, 'Trey Martin');
  assert.equal(h.post(correction).result, 'already voided'); assert.equal(h.audit.values.length, 2);
  h.properties.set('GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED', 'false');
  const review = h.post(productionRequest('dailyReview', { date: row.Date })); assert.equal(review.ok, true);
  assert.equal(review.auditHistory[0].adminName, 'Trey Martin'); assert.equal(review.records.length, 0, 'VOID records are preserved centrally and excluded from teaching');
  assert.equal(h.post({ ...correction, installation: 'rev' }).result, 'rejected');
  assert.equal(h.post(productionRequest('ledgerStatus')).ok, true);
  journals[1].values[0][0] = 'Wrong schema';
  assert.equal(h.post(productionRequest('ledgerStatus')).result, 'rejected');
  assert.equal(h.context.GIB_M1_STAFF_CLOCK_ENABLED, false);
});

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
