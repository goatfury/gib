import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildStaffReview } from '../m1/staff-clock-core.mjs';
import { sanitizeStaffClockSnapshot, sanitizeStaffTimeReview, sanitizeStaffViewPage } from '../netlify/functions/_lib/m1-staff-clock-contracts.mjs';

const NOW = '2026-08-18T18:00:00-04:00';
const IDS = { previous: punchId(1), current: punchId(2), out: punchId(3), approved: punchId(4), next: punchId(5), nextOut: punchId(6), recovery: requestId(1), decision: requestId(2), laterDecision: requestId(3) };
const TIME_HEADERS = ['Punch ID', 'Timestamp', 'Date', 'Staff ID', 'Staff Name', 'Action', 'Site', 'Device', 'Build', 'Note', 'Status', 'Source', 'Admin Name', 'Linked Punch ID'];
const AUDIT_HEADERS = ['Request ID', 'Action Time', 'Admin Name', 'Staff ID', 'Staff Name', 'Punch Timestamp', 'Action', 'Required Reason', 'Result', 'Linked Punch ID'];
function punchId(n) { return `gib-m1-staff-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }
function requestId(n) { return `gib-m1-staff-request-10000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }
function punch(overrides = {}) {
  const timestamp = overrides.timestamp || '2026-08-18T15:00:00-04:00';
  return { punchId: IDS.current, timestamp, date: timestamp.slice(0, 10), staffId: 'mandy-test', staffName: 'Mandy Test', punchAction: 'clockIn', site: 'Rev', device: 'TEST tablet', build: 'synthetic-test-build', note: '', ...overrides };
}
function timeRow(p, overrides = {}) { return [p.punchId, p.timestamp, p.date, p.staffId, p.staffName, p.punchAction, p.site, p.device, p.build, p.note, overrides.status || 'ACTIVE', overrides.source || 'Tablet', overrides.adminName || '', overrides.linkedPunchId || '']; }
const kiosk = (action, data = {}) => ({ action, target: 'test', token: 'synthetic-receiver-token', ...data });
const admin = (action, data = {}) => kiosk(action, { adminActionToken: 'synthetic-admin-token', adminName: 'Andrew Smith', ...data });
const recovery = (overrides = {}) => ({ requestId: IDS.recovery, previousClockInPunchId: IDS.previous, punch: punch(), proposedFinishAt: null, ...overrides });
const decision = (overrides = {}) => ({ requestId: IDS.decision, recoveryRequestId: IDS.recovery, revision: 0, decision: 'approve', finishAt: '2026-08-17T17:00:00-04:00', punchId: IDS.approved, reason: 'Confirmed TEST prior finish', ...overrides });

function harness({ previousAt = '2026-08-17T09:00:00-04:00', now = NOW, includeRecovery = true } = {}) {
  const sheets = new Map(), cache = new Map(), operations = [];
  const properties = new Map([['GIB_M1_TEST_SPREADSHEET_ID', 'synthetic-sheet-id'], ['GIB_M1_RECEIVER_TRANSPORT_TOKEN', 'synthetic-receiver-token'], ['GIB_M1_LEGACY_KIOSK_TOKEN', 'synthetic-legacy-token'], ['GIB_M1_ADMIN_ACTION_TOKEN', 'synthetic-admin-token']]);
  let fault = null, locked = false, acquired = 0, released = 0;
  function write(event, work) {
    const matched = fault && fault.match(event);
    const mode = matched && fault.phase;
    if (matched) fault = null;
    if (mode === 'before') throw new Error('Synthetic interrupted write');
    work(); operations.push(event);
    if (mode === 'after') throw new Error('Synthetic lost write acknowledgment');
  }
  function sheet(name, rows = []) {
    const values = structuredClone(rows);
    const object = { values,
      appendRow(row) { write({ sheet: name, type: 'appendRow', rows: [row] }, () => values.push([...row])); },
      getDataRange: () => ({ getValues: () => structuredClone(values) }), getLastRow: () => values.length, getLastColumn: () => Math.max(0, ...values.map(row => row.length)), getMaxRows: () => 1000,
      setFrozenRows() {}, insertRowsAfter() {},
      getRange(row, column, rowCount = 1, columnCount = 1) { return {
        getValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => values[row - 1 + r]?.[column - 1 + c] ?? '')),
        setValues(rows) { write({ sheet: name, type: 'setValues', rows }, () => rows.forEach((valuesToSet, r) => { const dest = values[row - 1 + r] ||= []; valuesToSet.forEach((value, c) => { dest[column - 1 + c] = value; }); })); return this; },
        setValue(value) { return this.setValues([[value]]); }, setNumberFormat() { return this; }
      }; }
    };
    sheets.set(name, object); return object;
  }
  sheet('Signins', [['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Device', 'Build', 'Notes', 'Status'], ['synthetic-instructor-sentinel', '2026-08-17 09:00:00', '2026-08-17', 'TEST class', 1, 'TEST instructor', 'Rev', '', '', '', 'VOID']]);
  sheet('Admin Audit', [['Action Number', 'Admin Name', 'Action Time', 'Instructor', 'Class Date', 'Class', 'Site', 'Duration', 'Required Reason', 'Final Result', 'Linked Sign-in Record ID']]);
  sheet('Staff Clock Staff', [['Staff ID', 'Staff Name', 'Active'], ['mandy-test', 'Mandy Test', true], ['other-test', 'Other Test', true]]);
  sheet('Staff Time', [TIME_HEADERS, ...(previousAt ? [timeRow(punch({ punchId: IDS.previous, timestamp: previousAt }))] : [])]);
  sheet('Staff Time Audit', [AUDIT_HEADERS]);
  const spreadsheet = { getId: () => 'synthetic-sheet-id', getName: () => 'RBJJ M1 — TEST', getSheetByName: name => sheets.get(name) || null, insertSheet: name => sheet(name) };
  const formatDate = (date, timeZone, pattern) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}:${parts.second}`;
    if (pattern === 'yyyy-MM-dd') return day;
    if (pattern === 'yyyy-MM-dd HH:mm:ss') return `${day} ${time}`;
    if (pattern === "yyyy-MM-dd'T'HH:mm:ss") return `${day}T${time}`;
    if (pattern === 'Z') { const offset = Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60000); return `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}${String(Math.abs(offset) % 60).padStart(2, '0')}`; }
    throw new Error('Unexpected date fixture format');
  };
  const ctx = vm.createContext({ Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return Date.parse(now); } }, console: { log() {}, warn() {} },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, getContent: () => text, setMimeType() { return this; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties.get(name) || '', setProperty: (name, value) => properties.set(name, String(value)), deleteProperty: name => properties.delete(name) }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key) || null, put: (key, value) => cache.set(key, String(value)), remove: key => cache.delete(key), removeAll: keys => keys.forEach(key => cache.delete(key)) }) },
    DriveApp: { getFileById: () => ({ getLastUpdated: () => new Date(now) }) }, ScriptApp: { getScriptId: () => 'synthetic-test-script' },
    LockService: { getScriptLock: () => ({ tryLock() { assert.equal(locked, false, 'no nested Staff recovery lock'); locked = true; acquired++; return true; }, releaseLock() { assert.equal(locked, true); locked = false; released++; } }) },
    SpreadsheetApp: { openById: () => spreadsheet, flush() {} },
    Utilities: { Charset: { UTF_8: 'UTF_8' }, DigestAlgorithm: { SHA_256: 'SHA_256' }, formatDate, computeDigest: (_, value) => [...createHash('sha256').update(String(value)).digest()], newBlob: value => ({ getBytes: () => Buffer.from(String(value), 'utf8') }), base64EncodeWebSafe: bytes => Buffer.from(bytes.map(value => value < 0 ? value + 256 : value)).toString('base64url'), base64DecodeWebSafe: value => [...Buffer.from(String(value), 'base64url')] }
  });
  for (const file of ['Code.gs', 'GibM1Receiver.gs', 'GibM1ManagerReview.gs', ...(includeRecovery ? ['GibM1StaffRecovery.gs'] : [])]) vm.runInContext(readFileSync(new URL(`../integrations/google-apps-script/${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
  return { ctx, sheets, operations, properties, snapshot: () => JSON.stringify([...sheets].map(([name, value]) => [name, value.values])),
    post: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text),
    failOnce: (match, phase = 'before') => { fault = { match, phase }; }, locks: () => ({ acquired, released, locked }) };
}
const start = (h, value = recovery()) => h.post(kiosk('staffRecoveryStart', { recovery: value }));
const decide = (h, value = decision()) => h.post(admin('staffRecoveryDecide', { decision: value }));
const readRecovery = h => h.post(kiosk('staffRecoveryRead'));
const totals = review => review.periods.current.totals.find(item => item.staffId === 'mandy-test');
function paged(h, authenticated = false) {
  const body = authenticated ? admin : kiosk;
  const response = h.post(body(authenticated ? 'staffTimeReviewV2' : 'staffClockSnapshotV2'));
  const summary = (authenticated ? sanitizeStaffTimeReview : sanitizeStaffClockSnapshot)(response, 'test', { now: new Date(NOW) });
  assert.ok(summary, JSON.stringify(response));
  const records = [];
  for (let offset = 0; offset < summary.view.recordCount;) {
    const fields = { viewToken: summary.view.token, stream: 'records', offset };
    const result = h.post(body(authenticated ? 'staffTimeReviewPageV2' : 'staffClockSnapshotPageV2', fields));
    const page = sanitizeStaffViewPage(result, 'test', fields, { now: new Date(NOW) });
    assert.ok(page, JSON.stringify(result)); records.push(...page.items);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(records.length, summary.view.recordCount);
  return { summary, records };
}

test('explicit new start preserves its actual ID/time, journals first and permits current/later shifts while prior hours stay unresolved', () => {
  const h = harness(), initialInstructor = structuredClone(h.sheets.get('Signins').values), initialAudit = structuredClone(h.sheets.get('Admin Audit').values);
  const saved = start(h);
  assert.equal(saved.ok, true, JSON.stringify(saved)); assert.equal(saved.receipt.startedAt, recovery().punch.timestamp);
  assert.equal(saved.recovery.items[0].revision, 0); assert.equal(saved.recovery.items[0].proposedFinishAt, null);
  const requested = h.operations.findIndex(event => event.sheet === 'Staff Recovery' && event.rows[0][2] === 'requested');
  const punched = h.operations.findIndex(event => event.sheet === 'Staff Time');
  assert.ok(requested >= 0 && punched > requested, 'request is retained before the new punch');
  assert.equal(h.sheets.get('Staff Time').values[2][0], IDS.current); assert.equal(h.sheets.get('Staff Time').values[2][1], recovery().punch.timestamp);
  const snapshot = h.post(kiosk('staffClockSnapshot'));
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const current = snapshot.records.find(row => row.punchId === IDS.current);
  assert.equal(current.recoveryRequestId, IDS.recovery); assert.equal(current.previousClockInPunchId, IDS.previous);
  assert.equal(paged(h).records.find(row => row.punchId === IDS.current).recoveryRequestId, IDS.recovery);
  assert.equal(h.post(kiosk('staffClockPunch', { punches: [punch({ punchId: IDS.out, timestamp: '2026-08-18T16:00:00-04:00', punchAction: 'clockOut' })] })).results[0].result, 'added');
  assert.equal(h.post(kiosk('staffClockPunch', { punches: [punch({ punchId: IDS.next, timestamp: '2026-08-18T16:30:00-04:00' }), punch({ punchId: IDS.nextOut, timestamp: '2026-08-18T17:00:00-04:00', punchAction: 'clockOut' })] })).results.every(item => item.result === 'added'), true);
  const review = h.post(admin('staffTimeReview'));
  assert.equal(review.ok, true, JSON.stringify(review)); assert.equal(totals(review).totalSeconds, 5400); assert.equal(totals(review).needsAttention, true);
  assert.ok(review.needsAttention.some(item => item.code === 'missing_clock_out_recovery'));
  assert.equal(paged(h, true).summary.periods.current.totals.find(row => row.staffId === 'mandy-test').totalSeconds, 5400);
  const browser = buildStaffReview({ confirmedRecords: review.records, now: NOW });
  assert.equal(browser.staffStates.find(item => item.staffId === 'mandy-test').nextPunchAction, 'clockIn');
  assert.equal(readRecovery(h).recovery.items[0].status, 'pending');
  assert.deepEqual(h.sheets.get('Signins').values, initialInstructor); assert.deepEqual(h.sheets.get('Admin Audit').values, initialAudit);
  assert.equal(h.locks().acquired, h.locks().released); assert.equal(h.locks().locked, false);
});

test('an exact retry or lost reply reuses original request, punch, proposal and receipt; changed same-ID content conflicts', () => {
  const h = harness(), value = recovery({ proposedFinishAt: '2026-08-17T17:00:00-04:00' });
  const first = start(h, value), before = h.snapshot();
  assert.equal(first.ok, true, JSON.stringify(first)); assert.deepEqual(start(h, value), first); assert.equal(h.snapshot(), before);
  assert.equal(start(h, { ...value, proposedFinishAt: null }).result, 'conflict');
  assert.equal(start(h, { ...value, punch: { ...value.punch, timestamp: '2026-08-18T15:01:00-04:00' } }).result, 'conflict');
  assert.equal(h.snapshot(), before); assert.equal(h.sheets.get('Staff Recovery').values.length, 2); assert.equal(h.sheets.get('Staff Time').values.length, 3);
});

test('start failures after journaling or after punch persistence recover exactly once with the original request', () => {
  for (const phase of ['before', 'after']) {
    const h = harness(); h.failOnce(event => event.sheet === 'Staff Time', phase);
    const failed = start(h); assert.equal(failed.ok, false);
    assert.equal(h.sheets.get('Staff Recovery').values.length, 2);
    if (phase === 'before') assert.equal(readRecovery(h).ok, false, 'unfinished central read cannot pretend no recovery exists');
    const recovered = start(h); assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(h.sheets.get('Staff Time').values.filter(row => row[0] === IDS.current).length, 1);
    assert.equal(h.sheets.get('Staff Recovery').values.length, 2);
    assert.deepEqual(start(h).receipt, recovered.receipt);
  }
});

test('manager approval adds one audited real old finish and resolves only that recovery, including finish equal to new start', () => {
  for (const finishAt of ['2026-08-18T11:00:00-04:00', '2026-08-18T15:00:00-04:00']) {
    const h = harness({ previousAt: '2026-08-18T09:00:00-04:00' }); assert.equal(start(h).ok, true);
    const input = decision({ finishAt }), approved = decide(h, input);
    assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.receipt.revision, 1); assert.equal(approved.recovery.items[0].status, 'approved');
    assert.equal(h.sheets.get('Staff Time').values.filter(row => row[0] === IDS.approved).length, 1);
    assert.equal(h.sheets.get('Staff Time Audit').values.filter(row => row[0] === IDS.decision).length, 1);
    const before = h.snapshot(); assert.deepEqual(decide(h, input), approved); assert.equal(h.snapshot(), before);
    assert.equal(h.post(kiosk('staffClockPunch', { punches: [punch({ punchId: IDS.out, timestamp: '2026-08-18T17:00:00-04:00', punchAction: 'clockOut' })] })).results[0].result, 'added');
    const review = h.post(admin('staffTimeReview'));
    assert.equal(review.ok, true, JSON.stringify(review)); assert.equal(totals(review).needsAttention, false);
    assert.equal(totals(review).totalSeconds, ((Date.parse(finishAt) - Date.parse('2026-08-18T09:00:00-04:00')) / 1000) + 7200);
  }
});

test('null proposal and rejection never manufacture an old finish; later approval requires the new revision', () => {
  const h = harness(); assert.equal(start(h).ok, true);
  const rejected = decide(h, decision({ decision: 'reject', finishAt: null, punchId: null, reason: 'TEST finish still unknown' }));
  assert.equal(rejected.ok, true, JSON.stringify(rejected)); assert.equal(rejected.recovery.items[0].status, 'rejected'); assert.equal(rejected.receipt.revision, 1);
  assert.equal(h.sheets.get('Staff Time').values.length, 3); assert.equal(h.sheets.get('Staff Time Audit').values.length, 1);
  assert.equal(decide(h, decision({ requestId: IDS.laterDecision })).result, 'conflict');
  const approved = decide(h, decision({ requestId: IDS.laterDecision, revision: 1 }));
  assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.receipt.revision, 2);
});

test('interrupted approval after intent, after punch, after audit or before confirmation heals one punch and one immutable audit', () => {
  const faults = [
    [event => event.sheet === 'Staff Time', 'before'],
    [event => event.sheet === 'Staff Time', 'after'],
    [event => event.sheet === 'Staff Time Audit', 'after'],
    [event => event.sheet === 'Staff Recovery' && event.rows[0][2] === 'confirmed', 'before']
  ];
  for (const [match, phase] of faults) {
    const h = harness(); assert.equal(start(h).ok, true); h.failOnce(match, phase);
    assert.equal(decide(h).ok, false); assert.equal(readRecovery(h).ok, false, 'partially saved decision is not an all-clear');
    const recovered = decide(h); assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(h.sheets.get('Staff Time').values.filter(row => row[0] === IDS.approved).length, 1);
    assert.equal(h.sheets.get('Staff Time Audit').values.filter(row => row[0] === IDS.decision).length, 1);
    assert.equal(h.sheets.get('Staff Recovery').values.length, 4);
    const before = h.snapshot(); assert.deepEqual(decide(h), recovered); assert.equal(h.snapshot(), before);
  }
});

test('invalid, ambiguous or overlapping original/manager times leave all history unchanged', () => {
  for (const changed of [
    recovery({ proposedFinishAt: '2026-08-17T08:00:00-04:00' }), recovery({ proposedFinishAt: '2026-08-18T16:00:00-04:00' }), recovery({ proposedFinishAt: '2026-08-18T04:00:00-04:00' }),
    recovery({ previousClockInPunchId: IDS.next }), recovery({ punch: punch({ staffId: 'other-test', staffName: 'Other Test' }) }), recovery({ punch: punch({ timestamp: '2026-08-17T08:00:00-04:00' }) })
  ]) { const h = harness(), before = h.snapshot(); assert.equal(start(h, changed).ok, false); assert.equal(h.snapshot(), before); }
  const h = harness(); assert.equal(start(h).ok, true);
  for (const finishAt of ['2026-08-17T09:00:00-04:00', '2026-08-18T16:00:00-04:00', '2026-08-18T04:00:00-04:00', '2026-03-08T02:30:00-05:00']) {
    const before = h.snapshot(); assert.equal(decide(h, decision({ finishAt })).ok, false); assert.equal(h.snapshot(), before);
  }
  h.sheets.get('Staff Time').values.push(timeRow(punch({ punchId: IDS.next, timestamp: '2026-08-17T12:00:00-04:00', punchAction: 'clockOut' })));
  const before = h.snapshot(); assert.equal(decide(h).ok, false); assert.equal(h.snapshot(), before);
});

test('genuine overnight Clock Out remains ordinary and creates neither a recovery journal nor guessed hours', () => {
  const h = harness({ previousAt: '2026-08-17T22:00:00-04:00', now: '2026-08-18T06:00:00-04:00' });
  const saved = h.post(kiosk('staffClockPunch', { punches: [punch({ punchId: IDS.out, timestamp: '2026-08-18T06:00:00-04:00', punchAction: 'clockOut' })] }));
  assert.equal(saved.results[0].result, 'added', JSON.stringify(saved)); assert.equal(h.sheets.has('Staff Recovery'), false);
  assert.equal(totals(h.post(admin('staffTimeReview'))).totalSeconds, 8 * 3600);
});

test('unmodified records and schemas remain compatible when no recovery exists or entry controls are off', () => {
  const h = harness({ includeRecovery: false, previousAt: null });
  assert.equal(h.post(kiosk('staffClockPunch', { punches: [punch({ timestamp: '2026-08-18T09:00:00-04:00' })] })).results[0].result, 'added');
  const snapshot = h.post(kiosk('staffClockSnapshot'));
  assert.equal(paged(h).records.length, 1);
  assert.equal(Object.hasOwn(snapshot.records[0], 'recoveryRequestId'), false);
  assert.deepEqual(h.sheets.get('Staff Time').values[0], TIME_HEADERS); assert.deepEqual(h.sheets.get('Staff Time Audit').values[0], AUDIT_HEADERS);
  const withRecovery = harness(); assert.equal(start(withRecovery).ok, true); withRecovery.ctx.GIB_M1_MANAGER_REVIEW_TEST_ENABLED = false;
  assert.equal(start(withRecovery).ok, false);
  const retained = withRecovery.post(kiosk('staffClockSnapshot'));
  assert.equal(retained.ok, true, JSON.stringify(retained)); assert.equal(retained.records.find(row => row.punchId === IDS.current).recoveryRequestId, IDS.recovery);
});

test('paged projections retain a recovery predecessor older than both displayed payroll periods', () => {
  const h = harness({ previousAt: '2026-07-01T09:00:00-04:00' });
  assert.equal(start(h).ok, true);
  for (const authenticated of [false, true]) {
    const value = paged(h, authenticated);
    assert.ok(value.records.some(row => row.punchId === IDS.previous));
    assert.ok(value.records.some(row => row.punchId === IDS.current));
    const state = buildStaffReview({ confirmedRecords: value.records, now: NOW }).staffStates.find(row => row.staffId === 'mandy-test');
    assert.equal(state.nextPunchAction, 'clockOut'); assert.equal(state.recoveryPending.length, 1);
  }
});

test('a rejected proposal stops being outstanding only after an independently audited prior finish exists', () => {
  const h = harness(); assert.equal(start(h).ok, true);
  assert.equal(decide(h, decision({ decision: 'reject', finishAt: null, punchId: null, reason: 'TEST original proposal rejected' })).ok, true);
  const outstanding = () => h.ctx.staffRecoveryOutstanding_({ getName: () => 'RBJJ M1 — TEST', getSheetByName: name => h.sheets.get(name) || null });
  assert.ok(outstanding().items.some(item => item.proposalId === IDS.recovery));
  const corrected = h.post(admin('staffTimeCorrect', { requestId: IDS.laterDecision, punchId: IDS.approved, staffId: 'mandy-test', staffName: 'Mandy Test', punchAction: 'clockOut', timestamp: '2026-08-17T17:00:00-04:00', date: '2026-08-17', reason: 'Independent TEST prior finish', site: 'Rev', device: 'Admin Staff Time', build: 'm1b-staff-clock' }));
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(outstanding().items.some(item => item.proposalId === IDS.recovery), false);
  assert.equal(readRecovery(h).recovery.items[0].status, 'rejected', 'append-only decision history remains preserved');
});

test('TEST-only, Revolution-only and existing kiosk/Admin authentication gates reject before writes', () => {
  for (const setup of [h => { h.ctx.GIB_M1_MANAGER_REVIEW_TEST_ENABLED = false; }, h => { h.ctx.GIB_M1_ALLOWED_TARGET = 'production'; }, h => { h.ctx.GIB_M1_RICHMOND_INSTALLATION_ = true; }]) {
    const h = harness(); setup(h); const before = h.snapshot(); assert.equal(start(h).ok, false); assert.equal(h.snapshot(), before);
  }
  for (const body of [kiosk('staffRecoveryStart', { recovery: recovery(), token: 'wrong' }), kiosk('staffRecoveryStart', { recovery: recovery(), target: 'production' }), kiosk('staffRecoveryReview'), admin('staffRecoveryReview', { adminActionToken: 'wrong' }), admin('staffRecoveryDecide', { decision: decision(), adminName: 'Unauthorized TEST' })]) {
    const h = harness(), before = h.snapshot(); assert.equal(h.post(body).ok, false); assert.equal(h.snapshot(), before);
  }
  const h = harness(); assert.equal(start(h).ok, true); const before = h.snapshot();
  assert.equal(h.post(admin('staffRecoveryReview')).ok, true); assert.equal(readRecovery(h).ok, true); assert.equal(h.snapshot(), before);
});

test('inactive roster members retain pending and approved recovery history without blocking other staff or admitting new starts', () => {
  for (const approved of [false, true]) {
    const h = harness(); assert.equal(start(h).ok, true);
    if (approved) assert.equal(decide(h).ok, true);
    h.sheets.get('Staff Clock Staff').values[1][2] = false;
    const before = h.snapshot();
    const recoveryRead = readRecovery(h);
    assert.equal(recoveryRead.ok, true, JSON.stringify(recoveryRead));
    assert.equal(recoveryRead.recovery.items[0].status, approved ? 'approved' : 'pending');
    for (const action of ['staffClockSnapshot', 'staffTimeReview']) {
      const response = h.post(action === 'staffClockSnapshot' ? kiosk(action) : admin(action));
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.records.find(row => row.punchId === IDS.current).recoveryRequestId, IDS.recovery);
    }
    assert.equal(paged(h, true).records.find(row => row.punchId === IDS.current).previousClockInPunchId, IDS.previous);
    assert.equal(start(h, recovery({ requestId: requestId(90), previousClockInPunchId: IDS.current, punch: punch({ punchId: punchId(90), timestamp: '2026-08-18T17:00:00-04:00' }) })).ok, false);
    if (!approved) assert.equal(decide(h).ok, false, 'inactive approval is rejected before a new intent can block reads');
    assert.equal(h.snapshot(), before);
    const other = h.post(kiosk('staffClockPunch', { punches: [punch({ punchId: punchId(91), staffId: 'other-test', staffName: 'Other Test', timestamp: '2026-08-18T17:00:00-04:00' })] }));
    assert.equal(other.results[0].result, 'added', JSON.stringify(other));
    assert.equal(readRecovery(h).ok, true);
  }
});

test('existing audited VOID preserves linked recovery history and surfaces the conflict without blocking unrelated staff', () => {
  for (const [approved, punchId, category] of [
    [false, IDS.previous, 'previous-punch-void'], [false, IDS.current, 'new-punch-void'],
    [true, IDS.previous, 'previous-punch-void'], [true, IDS.current, 'new-punch-void'], [true, IDS.approved, 'finish-punch-void']
  ]) {
    const h = harness(); assert.equal(start(h).ok, true);
    if (approved) assert.equal(decide(h).ok, true);
    const retained = structuredClone(h.sheets.get('Staff Recovery').values);
    const body = admin('staffTimeVoid', { requestId: requestId(80), punchId, reason: 'TEST legitimate audited VOID' });
    const voided = h.post(body); assert.equal(voided.ok, true, JSON.stringify(voided));
    assert.equal(h.sheets.get('Staff Time').values.find(row => row[0] === punchId)[10], 'VOID');
    const state = readRecovery(h); assert.equal(state.ok, true, JSON.stringify(state));
    assert.deepEqual(state.recovery.items[0].conflicts, [category]);
    assert.equal(state.recovery.items[0].status, approved ? 'approved' : 'pending');
    assert.deepEqual(h.sheets.get('Staff Recovery').values, retained, 'VOID never rewrites recovery history');
    for (const action of ['staffClockSnapshot', 'staffTimeReview']) assert.equal(h.post(action === 'staffClockSnapshot' ? kiosk(action) : admin(action)).ok, true);
    assert.ok(paged(h, true).summary);
    const outstanding = h.ctx.staffRecoveryOutstanding_({ getSheetByName: name => h.sheets.get(name) || null });
    assert.ok(outstanding.items.some(item => item.proposalId === IDS.recovery && item.kind === 'staff-conflict'));
    const before = h.snapshot();
    assert.equal(h.post(body).ok, true, 'legacy same-ID VOID retry remains usable');
    if (!approved) assert.equal(decide(h).ok, false, 'mismatched active evidence cannot be approved');
    assert.equal(h.snapshot(), before);
    const other = h.post(kiosk('staffClockPunch', { punches: [punch({ punchId: IDS.next, staffId: 'other-test', staffName: 'Other Test' })] }));
    assert.equal(other.results[0].result, 'added');
  }
});

test('editor-only TEST fault loses one proven start reply and one read while preserving every punch, original ID and journal', () => {
  const h = harness();
  assert.equal(h.ctx.testRevolutionStaffRecoveryLostReply().armed, true);
  assert.equal(start(h).ok, false);
  const durable = h.snapshot();
  assert.equal(h.sheets.get('Staff Time').values.filter(row => row[0] === IDS.current).length, 1);
  assert.equal(h.sheets.get('Staff Recovery').values.length, 2);
  assert.equal(readRecovery(h).ok, false);
  assert.equal(readRecovery(h).ok, true);
  assert.equal(start(h).ok, true, 'the exact original retry confirms without another write');
  assert.equal(h.snapshot(), durable);
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.testRevolutionStaffRecoveryLostReplyReceipt())), { requestId: IDS.recovery, stage: 'saved-before-reply-loss' });
  assert.deepEqual(h.locks(), { acquired: 4, released: 4, locked: false });
  assert.equal(h.post(kiosk('testRevolutionStaffRecoveryLostReply')).ok, false, 'no public arming operation');
});

test('unarmed, expired or unavailable TEST fault storage cannot block reads; production cannot arm or consume a fault', () => {
  for (const mode of ['unarmed', 'expired', 'broken']) {
    const h = harness();
    if (mode === 'expired') h.properties.set('M1_TEST_STAFF_RECOVERY_LOST_REPLY', JSON.stringify({ staffId: 'mandy-test', expiresAt: Date.parse(NOW) - 1 }));
    if (mode === 'broken') {
      const original = h.ctx.PropertiesService.getScriptProperties;
      h.ctx.PropertiesService.getScriptProperties = () => { const value = original(); const read = value.getProperty; value.getProperty = name => { if (name.startsWith('M1_TEST_STAFF_RECOVERY_')) throw new Error('Synthetic fault-store failure'); return read(name); }; return value; };
    }
    assert.equal(start(h).ok, true); assert.equal(readRecovery(h).ok, true);
    assert.deepEqual(h.locks(), { acquired: 2, released: 2, locked: false });
  }
  const h = harness(); h.ctx.GIB_M1_ALLOWED_TARGET = 'production';
  for (const name of ['testRevolutionStaffRecoveryLostReply', 'testRevolutionStaffRecoveryLostReplyReceipt']) assert.throws(() => h.ctx[name](), /TEST project/);
  h.properties.set('M1_TEST_STAFF_RECOVERY_LOST_REPLY', JSON.stringify({ staffId: 'mandy-test', expiresAt: Date.parse(NOW) + 60000 }));
  assert.equal(h.ctx.staffRecoveryTestFault_('saved', { staffId: 'mandy-test', requestId: IDS.recovery }), false);
  assert.equal(h.properties.has('M1_TEST_STAFF_RECOVERY_LOST_REPLY'), true);
});
