import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Run the actual Apps Script receiver against controlled Session, LockService,
// and SpreadsheetApp boundaries. These tests inject failures deterministically;
// the release also requires real private TEST workbook and browser readback.
const source = readFileSync(new URL('../promotions/Code.gs', import.meta.url), 'utf8');
const copy = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const WORKBOOK_TITLE = 'GYM IN A BOX Promotions — PRIVATE SYNTHETIC TEST';
const OWNER = 'test-manager@example.invalid';
const BOOK_ID = 'synthetic-private-test-workbook';
const LEGACY_TABS = ['Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student'];
const FIXED_NOW = '2026-09-13T15:20:30.000Z';
const STUDENT_HEADERS = ['student_id', 'display_name', 'distinguishing_label', 'status', 'rank_known', 'belt', 'marks', 'mark_type', 'revision', 'last_event_id', 'legacy_refs', 'history_note'];
const HISTORY_HEADERS = [
  'event_id', 'request_id', 'student_id', 'revision', 'event_kind', 'event_date_ny', 'recorded_at_utc',
  'display_name', 'distinguishing_label', 'before_status', 'after_status', 'before_rank_known',
  'before_belt', 'before_marks', 'before_mark_type', 'after_rank_known', 'after_belt', 'after_marks',
  'after_mark_type', 'approver_id', 'approver_label', 'recorder_identity', 'corrects_event_id',
  'reason', 'legacy_refs', 'history_note', 'payload_fingerprint'
];
const STUDENTS = [
  { id: 'fixture-student-001', name: 'TEST Stripe Student', label: 'Evening group', known: true, belt: 'Blue Belt', marks: 2 },
  { id: 'fixture-student-002', name: 'TEST Duplicate Name', label: 'Morning group', known: true, belt: 'White Belt', marks: 1 },
  { id: 'fixture-student-003', name: 'TEST Duplicate Name', label: 'Evening group', known: true, belt: 'Purple Belt', marks: 3 },
  { id: 'fixture-student-004', name: 'TEST Unknown Rank', label: 'Legacy unknown', known: false, belt: '', marks: '' },
  { id: 'fixture-student-005', name: 'TEST Black Degree', label: 'Synthetic degree case', known: true, belt: 'Black Belt', marks: 5 },
  { id: 'fixture-student-006', name: 'TEST Former Student', label: 'Historical archived', known: true, belt: 'Brown Belt', marks: 2, status: 'archived' }
];

function seedSheets() {
  const students = [];
  const history = [];
  for (const [index, student] of STUDENTS.entries()) {
    const legacy = `${student.belt || 'White Belt'}!A${index + 2}:D${index + 2}`;
    const note = index % 2 ? 'Unknown historical date: ?; Transplant' : 'Early 2014; original date remains blank';
    const eventId = `fixture-event-${String(index + 1).padStart(3, '0')}`;
    const rank = student.known ? (student.belt === 'Black Belt' ? 'degrees' : 'stripes') : '';
    const status = student.status || 'active';
    students.push([student.id, student.name, student.label, status, student.known, student.belt, student.marks, rank, 1, eventId, legacy, note]);
    history.push([
      eventId, `fixture-request-${String(index + 1).padStart(3, '0')}`, student.id, 1, 'REGISTER', '', '',
      student.name, student.label, '', status, '', '', '', '', student.known, student.belt, student.marks,
      rank, '', '', 'SYNTHETIC FIXTURE', '', '', legacy, note, ''
    ]);
  }
  return [['Students', [STUDENT_HEADERS, ...students]], ['Promotion History', [HISTORY_HEADERS, ...history]]];
}

function formattedDate(value, timezone, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  if (pattern === 'yyyy-MM-dd') return day;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ss") return `${day}T${time}`;
  if (pattern === 'yyyy-MM-dd HH:mm:ss') return `${day} ${time}`;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ss'Z'") return `${day}T${time}Z`;
  throw new Error(`Unexpected date pattern: ${pattern}`);
}

function makeSheet(name, initialRows, faults, operations) {
  const values = copy(initialRows);
  const formats = new Map();
  const fault = (kind, payload) => {
    if (['Students', 'Promotion History'].includes(name)) faults.assertLocked?.();
    if (faults[kind]?.({ name, values, ...payload })) throw new Error(`Injected ${kind} failure in ${name}`);
  };
  const range = (row, column, height = 1, width = 1) => ({
    getValues() {
      fault('read', { row, column, height, width });
      operations.push({ kind: 'read', name, row, column, height, width });
      return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => copy(values[row + y - 1]?.[column + x - 1] ?? '')));
    },
    getDisplayValues() { return this.getValues().map(line => line.map(value => String(value))); },
    getValue() { return this.getValues()[0][0]; },
    setValues(rows) {
      assert.equal(rows.length, height);
      assert.ok(rows.every(line => line.length === width));
      fault('writeBefore', { row, column, rows: copy(rows) });
      rows.forEach((line, y) => {
        if (!values[row + y - 1]) values[row + y - 1] = [];
        line.forEach((value, x) => {
          // Native Sheets consumes one leading apostrophe as its text marker.
          // Exercise this explicitly where the hosted workbook exposed it.
          const stored = faults.nativeTextMarkers && typeof value === 'string' && value.startsWith("'")
            ? value.slice(1) : value;
          values[row + y - 1][column + x - 1] = copy(stored);
        });
      });
      operations.push({ kind: 'write', name, row, column, rows: copy(rows) });
      fault('writeAfter', { row, column, rows: copy(rows) });
      return this;
    },
    setValue(value) { return this.setValues([[value]]); },
    setNumberFormat(format) {
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) formats.set(`${row + y}:${column + x}`, format);
      return this;
    },
    setNumberFormats(rows) { rows.forEach((line, y) => line.forEach((value, x) => formats.set(`${row + y}:${column + x}`, value))); return this; },
    clearContent() {
      fault('writeBefore', { row, column, rows: [] });
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (values[row + y - 1]) values[row + y - 1][column + x - 1] = '';
      operations.push({ kind: 'clearRange', name, row, column, height, width });
      return this;
    }
  });
  return {
    name, values, formats,
    getName: () => name,
    getLastRow: () => values.length,
    getLastColumn: () => Math.max(0, ...values.map(line => line.length)),
    getMaxRows: () => Math.max(1000, values.length),
    getMaxColumns: () => 100,
    getRange: range,
    getDataRange() { return range(1, 1, Math.max(1, values.length), Math.max(1, this.getLastColumn())); },
    appendRow(row) { range(values.length + 1, 1, 1, row.length).setValues([row]); return this; },
    clearContents() { fault('writeBefore', { row: 1, rows: [] }); values.length = 0; operations.push({ kind: 'clearSheet', name }); return this; },
    setFrozenRows() { return this; },
    autoResizeColumns() { return this; },
    insertRowsAfter() { return this; },
    insertColumnsAfter() { return this; }
  };
}

function createHarness({
  activeEmail = OWNER, effectiveEmail = OWNER, owner = OWNER,
  workbookTitle = WORKBOOK_TITLE, timezone = 'America/New_York', now = FIXED_NOW,
  lockAvailable = true, sheets: suppliedSheets = seedSheets(), nativeTextMarkers = false
} = {}) {
  const operations = [];
  const faults = { nativeTextMarkers };
  const sheets = new Map();
  const clock = { now };
  const counters = { opens: 0, locks: 0, releases: 0, flushes: 0, held: false };
  faults.assertLocked = () => assert.equal(counters.held, true, 'authoritative reads and writes must hold the script lock');
  const properties = new Map([['TEST_OWNER_EMAIL', owner], ['TEST_WORKBOOK_ID', BOOK_ID]]);
  for (const [index, name] of LEGACY_TABS.entries()) {
    // Deliberately inconsistent historical structures, blanks, dates, and notes.
    const rows = index % 2 ? [
      ['Name', 'Stripe 1', '', 'Historical annotation'],
      [`TEST Legacy ${index}`, '', new Date('2022-02-03T12:00:00Z'), 'Unknown date; retain this note'],
      ['', '', '', '']
    ] : [
      ['Name', 'Belt Date', 'Degree', 'Notes', ''],
      [`TEST Legacy ${index}`, 'circa 2019?', 5, 'Keep punctuation, spacing  and blanks', '']
    ];
    sheets.set(name, makeSheet(name, rows, faults, operations));
  }
  for (const [name, rows] of suppliedSheets || []) sheets.set(name, makeSheet(name, rows, faults, operations));
  const book = {
    getName: () => workbookTitle,
    getId: () => BOOK_ID,
    getSpreadsheetTimeZone: () => timezone,
    getSheetByName: name => sheets.get(name) || null,
    getSheets: () => [...sheets.values()],
    insertSheet(name) {
      assert.ok(!sheets.has(name), `Cannot replace sheet ${name}`);
      const sheet = makeSheet(name, [], faults, operations); sheets.set(name, sheet);
      operations.push({ kind: 'insertSheet', name }); return sheet;
    }
  };
  class ControlledDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return Date.parse(clock.now); }
  }
  const context = vm.createContext({
    console, Date: ControlledDate,
    Session: {
      getActiveUser: () => ({ getEmail: () => activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => effectiveEmail })
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || '',
      getProperties: () => Object.fromEntries(properties)
    }) },
    LockService: { getScriptLock: () => ({
      tryLock(milliseconds) { assert.ok(milliseconds > 0); counters.locks += 1; counters.held = lockAvailable; return lockAvailable; },
      releaseLock() { assert.equal(counters.held, true); counters.held = false; counters.releases += 1; }
    }) },
    SpreadsheetApp: {
      openById(id) { assert.equal(id, BOOK_ID); counters.opens += 1; return book; },
      flush() { counters.flushes += 1; if (faults.flush?.()) throw new Error('Injected flush failure'); }
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' }, DigestAlgorithm: { SHA_256: 'SHA_256' },
      getUuid: randomUUID,
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()],
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      formatDate: formattedDate
    },
    HtmlService: { createHtmlOutput: text => ({ text, setTitle() { return this; }, addMetaTag() { return this; } }) }
  });
  vm.runInContext(source, context, { filename: 'promotions/Code.gs' });
  return {
    context, sheets, operations, faults, properties, counters, clock,
    call(request) { return plain(context.promotionRequest(copy(request))); },
    freshSession() { return createHarness({ now: clock.now, nativeTextMarkers, sheets: [...sheets].map(([name, sheet]) => [name, copy(sheet.values)]) }); },
    legacySnapshot() { return copy(LEGACY_TABS.map(name => [name, sheets.get(name).values])); }
  };
}

function expectFailure(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (code) assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, 'string');
  assert.equal(Object.hasOwn(result, 'data'), false, 'rejected calls must not leak roster data');
  return result;
}

function expectSuccess(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.data);
  return result.data;
}

const requestId = () => `req-${randomUUID()}`;
const readStudent = (h, studentId = STUDENTS[0].id) => expectSuccess(h.call({ operation: 'readStudent', studentId }));
const stripeRequest = (overrides = {}) => ({
  operation: 'recordPromotion', requestId: requestId(), studentId: STUDENTS[0].id,
  expectedRevision: 1, action: 'stripe', approverId: 'TEST-COACH-A', ...overrides
});
const rankRequest = (overrides = {}) => ({
  operation: 'confirmRank', requestId: requestId(), studentId: STUDENTS[3].id,
  expectedRevision: 1, rank: { belt: 'White Belt', marks: 2 }, approverId: 'TEST-COACH-B',
  reason: 'TEST explicit current rank verified', ...overrides
});
const historyRows = h => copy(h.sheets.get('Promotion History').values);
const registerRequest = (overrides = {}) => ({
  operation: 'registerStudent', requestId: requestId(), displayName: 'TEST Newly Registered',
  distinguishingLabel: 'Synthetic new group', historyNote: 'No historical rank inferred', ...overrides
});

test('blank or unauthorized active/effective sessions reveal no roster and perform no spreadsheet work', () => {
  for (const options of [
    { activeEmail: '' }, { effectiveEmail: '' },
    { activeEmail: 'unapproved@example.invalid' }, { effectiveEmail: 'unapproved@example.invalid' },
    { owner: '' }
  ]) {
    const h = createHarness(options);
    for (const request of [{ operation: 'bootstrap' }, {
      operation: 'registerStudent', requestId: 'TEST-unauthorized-request', displayName: 'TEST Student', distinguishingLabel: 'TEST group'
    }]) expectFailure(h.call(request));
    const page = h.context.doGet().text;
    assert.match(page, /Private TEST access required/u);
    assert.doesNotMatch(page, /TEST Stripe Student|fixture-student|synthetic-private-test-workbook/u);
    assert.equal(h.counters.opens, 0);
    assert.equal(h.operations.length, 0);
  }
});

test('workbook identity and New York timezone must match before the promotion roster can be read or written', () => {
  for (const options of [{ workbookTitle: 'Unrelated workbook' }, { timezone: 'UTC' }]) {
    const h = createHarness(options);
    expectFailure(h.call({ operation: 'bootstrap' }));
    expectFailure(h.call(stripeRequest()));
    assert.equal(h.operations.length, 0);
  }
});

test('bootstrap returns only fixed fictional approvers and separates identical names by stable student identity', () => {
  const h = createHarness();
  const data = expectSuccess(h.call({ operation: 'bootstrap' }));
  assert.equal(data.todayNY, '2026-09-13');
  assert.equal(data.testOnly, true);
  assert.deepEqual(data.approvers.map(person => person.id), ['TEST-COACH-A', 'TEST-COACH-B']);
  const duplicates = data.students.filter(student => student.displayName === 'TEST Duplicate Name');
  assert.equal(duplicates.length, 2);
  assert.equal(new Set(duplicates.map(student => student.studentId)).size, 2);
  assert.equal(new Set(duplicates.map(student => student.distinguishingLabel)).size, 2);
  assert.ok(data.students.every(student => student.studentId));
});

test('one stripe appends exactly one dated event and keeps the before/after rank and server recorder', () => {
  const h = createHarness();
  const before = historyRows(h);
  const data = expectSuccess(h.call(stripeRequest()));
  assert.equal(data.student.belt, 'Blue Belt');
  assert.equal(data.student.marks, 3);
  assert.equal(data.student.revision, 2);
  assert.equal(data.receipt.eventDateNY, '2026-09-13');
  assert.equal(data.receipt.recordedAtUTC, FIXED_NOW);
  assert.equal(data.receipt.before.belt, 'Blue Belt');
  assert.equal(data.receipt.before.marks, 2);
  assert.equal(data.receipt.after.marks, 3);
  assert.equal(data.receipt.approverId, 'TEST-COACH-A');
  assert.ok(data.receipt.approverLabel);
  assert.equal(data.receipt.recorderIdentity, OWNER);
  assert.notEqual(data.receipt.recorderIdentity, data.receipt.approverLabel);
  assert.match(data.receipt.eventId, /^evt-/u);
  assert.deepEqual(historyRows(h).slice(0, before.length), before, 'prior history remains byte/value-identical');
  assert.equal(historyRows(h).length, before.length + 1);
  const fresh = readStudent(h.freshSession());
  assert.equal(fresh.student.lastEventId, data.receipt.eventId);
  assert.equal(fresh.history.at(-1).eventId, data.receipt.eventId);
});

test('client recorder spoofing and unapproved approver choices cannot write a promotion', () => {
  const h = createHarness();
  const before = historyRows(h);
  for (const extra of [
    { recorderIdentity: 'Spoofed manager' }, { recorder: OWNER }, { recordedAtUTC: '2000-01-01T00:00:00Z' },
    { eventDateNY: '2000-01-01' }, { approverId: OWNER }, { approverId: 'TEST-COACH-C' }
  ]) expectFailure(h.call(stripeRequest(extra)));
  assert.deepEqual(historyRows(h), before);
});

test('same request retry returns the original receipt once while changed payload conflicts', () => {
  const h = createHarness();
  const request = stripeRequest();
  const beforeCount = historyRows(h).length;
  const first = expectSuccess(h.call(request));
  h.clock.now = '2026-09-14T15:20:30.000Z';
  const retry = expectSuccess(h.call(request));
  assert.deepEqual(retry.receipt, first.receipt);
  assert.equal(historyRows(h).length, beforeCount + 1);
  assert.equal(retry.student.marks, 3);
  expectFailure(h.call({ ...request, approverId: 'TEST-COACH-B' }), 'REQUEST_CONFLICT');
  assert.equal(historyRows(h).length, beforeCount + 1);
});

test('two writers reading the same revision cannot each add a stripe', () => {
  const h = createHarness();
  const firstView = readStudent(h);
  const secondView = readStudent(h);
  const first = stripeRequest({ expectedRevision: firstView.student.revision });
  const second = stripeRequest({ expectedRevision: secondView.student.revision });
  expectSuccess(h.call(first));
  expectFailure(h.call(second));
  const final = readStudent(h);
  assert.equal(final.student.marks, 3);
  assert.equal(final.student.revision, 2);
  assert.equal(final.history.filter(event => event.eventKind !== 'REGISTER').length, 1);
  assert.equal(h.counters.locks, h.counters.releases);
});

test('unavailable script lock rejects all authoritative data reads and writes', () => {
  const h = createHarness({ lockAvailable: false });
  const before = historyRows(h);
  expectFailure(h.call({ operation: 'bootstrap' }));
  expectFailure(h.call(stripeRequest()));
  assert.deepEqual(historyRows(h), before);
  assert.equal(h.operations.length, 0, 'destination metadata may be checked, but row contents stay behind the lock');
  assert.equal(h.counters.releases, 0);
});

test('lost response after committed append retries the original request without awarding another stripe', () => {
  const h = createHarness();
  const request = stripeRequest();
  const original = historyRows(h);
  let fail = true;
  h.faults.writeAfter = event => {
    if (event.name === 'Promotion History' && event.row > original.length && fail) { fail = false; return true; }
    return false;
  };
  const ambiguous = h.call(request);
  assert.equal(historyRows(h).length, original.length + 1, 'the injected error occurs after the authoritative append');
  assert.equal(typeof ambiguous.ok, 'boolean');
  delete h.faults.writeAfter;
  const recovered = expectSuccess(h.call(request));
  assert.equal(recovered.student.marks, 3);
  assert.equal(historyRows(h).length, original.length + 1);
  const checked = expectSuccess(h.call({ operation: 'checkSave', requestId: request.requestId }));
  assert.equal(checked.receipt.eventId, recovered.receipt.eventId);
});

test('a history readback failure after append does not duplicate the committed event on retry', () => {
  const h = createHarness();
  const request = stripeRequest();
  const original = historyRows(h);
  h.faults.read = event => event.name === 'Promotion History' && event.values.length > original.length;
  h.call(request);
  assert.equal(historyRows(h).length, original.length + 1);
  delete h.faults.read;
  const recovered = expectSuccess(h.call(request));
  assert.equal(recovered.student.marks, 3);
  assert.equal(historyRows(h).length, original.length + 1);
});

test('Students view write failure keeps history authoritative and checkSave repairs the derived view', () => {
  const h = createHarness();
  const original = historyRows(h);
  h.faults.writeBefore = event => event.name === 'Students';
  const request = stripeRequest();
  const saved = expectSuccess(h.call(request));
  assert.equal(saved.viewPending, true);
  assert.equal(saved.student.marks, 3);
  assert.equal(historyRows(h).length, original.length + 1);
  const pending = expectSuccess(h.call({ operation: 'checkSave', requestId: request.requestId }));
  assert.equal(pending.viewPending, true);
  assert.deepEqual(pending.receipt, saved.receipt);
  assert.equal(readStudent(h).student.marks, 3, 'ordinary reads use history even while the view is stale');
  delete h.faults.writeBefore;
  const refreshed = expectSuccess(h.call({ operation: 'checkSave', requestId: request.requestId }));
  assert.equal(refreshed.viewPending, false);
  assert.equal(refreshed.student.marks, 3);
  const viewRow = h.sheets.get('Students').values.find(row => row[0] === STUDENTS[0].id);
  assert.equal(Number(viewRow[6]), 3);
  assert.equal(historyRows(h).length, original.length + 1);
});

test('belt transition preserves every prior event, unknown historical date, and annotation', () => {
  const h = createHarness();
  const first = expectSuccess(h.call(stripeRequest()));
  const before = readStudent(h);
  const rowsBefore = historyRows(h);
  const changed = expectSuccess(h.call(stripeRequest({
    expectedRevision: 2, action: 'belt', belt: 'Purple Belt', approverId: 'TEST-COACH-B'
  })));
  assert.equal(changed.student.belt, 'Purple Belt');
  assert.equal(changed.student.marks, 0);
  assert.equal(changed.receipt.before.belt, 'Blue Belt');
  assert.equal(changed.receipt.before.marks, 3);
  assert.equal(changed.receipt.approverId, 'TEST-COACH-B');
  assert.deepEqual(historyRows(h).slice(0, rowsBefore.length), rowsBefore);
  const after = readStudent(h);
  assert.deepEqual(after.history.slice(0, before.history.length), before.history);
  assert.equal(after.history[0].eventDateNY, '');
  assert.equal(after.history[1].eventId, first.receipt.eventId);
  assert.equal(after.student.historyNote, before.student.historyNote);
  assert.equal(after.student.legacyRefs, before.student.legacyRefs);
});

test('audited latest-event correction appends a link and reason without altering the mistaken event', () => {
  const h = createHarness();
  const mistaken = expectSuccess(h.call(stripeRequest()));
  const original = historyRows(h);
  const request = {
    operation: 'correctLatest', requestId: requestId(), studentId: STUDENTS[0].id,
    expectedRevision: 2, correctsEventId: mistaken.receipt.eventId,
    rank: { belt: 'Blue Belt', marks: 2 }, approverId: 'TEST-COACH-B', reason: 'TEST accidental extra stripe'
  };
  expectFailure(h.call({ ...request, reason: '' }));
  assert.deepEqual(historyRows(h), original);
  const corrected = expectSuccess(h.call(request));
  assert.equal(corrected.student.marks, 2);
  assert.equal(corrected.receipt.correctsEventId, mistaken.receipt.eventId);
  assert.equal(corrected.receipt.reason, request.reason);
  assert.equal(corrected.receipt.before.marks, 3);
  assert.deepEqual(historyRows(h).slice(0, original.length), original);
  expectFailure(h.call({ ...request, requestId: requestId(), expectedRevision: 3 }));
  assert.equal(historyRows(h).length, original.length + 1, 'an old nonlatest event cannot be corrected in place');
});

test('unknown current rank requires an explicit resolution before any promotion', () => {
  const h = createHarness();
  const original = readStudent(h, STUDENTS[3].id);
  assert.equal(original.student.rankKnown, false);
  expectFailure(h.call(stripeRequest({ studentId: STUDENTS[3].id })));
  expectFailure(h.call(rankRequest({ reason: '' })));
  const resolved = expectSuccess(h.call(rankRequest()));
  assert.equal(resolved.student.rankKnown, true);
  assert.equal(resolved.student.belt, 'White Belt');
  assert.equal(resolved.student.marks, 2);
  assert.equal(resolved.receipt.before.rankKnown, false);
  expectFailure(h.call(rankRequest({ requestId: requestId(), expectedRevision: 2 })));
  const promoted = expectSuccess(h.call(stripeRequest({ studentId: STUDENTS[3].id, expectedRevision: 2 })));
  assert.equal(promoted.student.marks, 3);
  assert.equal(readStudent(h, STUDENTS[3].id).history[0].eventDateNY, '');
});

test('missing student requires explicit registration and duplicate names retain separate identities', () => {
  const h = createHarness();
  expectFailure(h.call(stripeRequest({ studentId: 'fixture-missing-student' })));
  const request = registerRequest();
  const first = expectSuccess(h.call(request));
  assert.equal(first.student.rankKnown, false);
  assert.equal(first.student.historyNote, request.historyNote);
  assert.match(first.student.studentId, /^stu-/u);
  expectFailure(h.call(registerRequest()));
  const differentPerson = expectSuccess(h.call(registerRequest({ distinguishingLabel: 'Different synthetic group' })));
  assert.notEqual(differentPerson.student.studentId, first.student.studentId);
  assert.equal(differentPerson.student.displayName, first.student.displayName);
  const retry = expectSuccess(h.call(request));
  assert.equal(retry.student.studentId, first.student.studentId);
});

test('black-belt degrees can advance five to six without ordinary stripe limits or a belt transition', () => {
  const h = createHarness();
  const data = expectSuccess(h.call(stripeRequest({ studentId: STUDENTS[4].id })));
  assert.equal(data.student.belt, 'Black Belt');
  assert.equal(data.student.markType, 'degrees');
  assert.equal(data.student.marks, 6);
  assert.equal(data.receipt.before.marks, 5);
  assert.equal(data.receipt.after.marks, 6);
});

test('ordinary stripes never automatically change the belt and archived students cannot be promoted', () => {
  const h = createHarness();
  const fourth = expectSuccess(h.call(stripeRequest({ studentId: STUDENTS[2].id })));
  assert.equal(fourth.student.belt, 'Purple Belt');
  assert.equal(fourth.student.marks, 4);
  const next = expectSuccess(h.call(stripeRequest({ studentId: STUDENTS[2].id, expectedRevision: 2 })));
  assert.equal(next.student.belt, 'Purple Belt');
  assert.equal(next.student.marks, 5, 'this TEST tool does not invent ordinary stripe eligibility rules');
  expectFailure(h.call(stripeRequest({ studentId: STUDENTS[5].id })));
});

test('New York promotion dates use actual midnight and daylight-saving boundaries', () => {
  for (const [instant, expected] of [
    ['2026-09-14T03:59:59.000Z', '2026-09-13'], ['2026-09-14T04:00:00.000Z', '2026-09-14'],
    ['2026-03-08T04:59:59.000Z', '2026-03-07'], ['2026-03-08T05:00:00.000Z', '2026-03-08'],
    ['2026-11-02T04:59:59.000Z', '2026-11-01'], ['2026-11-02T05:00:00.000Z', '2026-11-02']
  ]) {
    const h = createHarness({ now: instant });
    const data = expectSuccess(h.call(stripeRequest()));
    assert.equal(data.receipt.eventDateNY, expected);
    assert.equal(data.receipt.recordedAtUTC, instant);
  }
});

test('all six legacy rank tabs retain exact values, blanks, dates, terminology and structure after every mutation', () => {
  const h = createHarness();
  const before = h.legacySnapshot();
  expectSuccess(h.call({ operation: 'bootstrap' }));
  const promotion = expectSuccess(h.call(stripeRequest()));
  expectSuccess(h.call({
    operation: 'correctLatest', requestId: requestId(), studentId: STUDENTS[0].id,
    expectedRevision: 2, correctsEventId: promotion.receipt.eventId,
    rank: { belt: 'Blue Belt', marks: 2 }, approverId: 'TEST-COACH-A', reason: 'TEST corrected extra stripe'
  }));
  expectSuccess(h.call(rankRequest()));
  expectSuccess(h.call(registerRequest()));
  expectSuccess(h.call(stripeRequest({ studentId: STUDENTS[4].id })));
  assert.deepEqual(h.legacySnapshot(), before);
  assert.equal(h.operations.filter(operation => LEGACY_TABS.includes(operation.name)).length, 0);
});

test('new typed spreadsheet formula text is rejected and literal ordinary text stays unchanged', () => {
  const h = createHarness();
  const before = historyRows(h);
  for (const value of ['=SUM(1,2)', '+SUM(1,2)', '-2+3', '@SUM(1,2)', '\t=SUM(1,2)']) {
    expectFailure(h.call(registerRequest({ displayName: value })));
    expectFailure(h.call(registerRequest({ distinguishingLabel: value })));
  }
  assert.deepEqual(historyRows(h), before);
  const displayName = 'TEST O’Connor, Jr.';
  const data = expectSuccess(h.call(registerRequest({ displayName, historyNote: 'Unknown date; preserve punctuation, commas and blanks.' })));
  assert.equal(data.student.displayName, displayName);
  assert.equal(readStudent(h, data.student.studentId).student.historyNote, 'Unknown date; preserve punctuation, commas and blanks.');
});

test('flush failure after append is recoverable by the same request from a fresh receiver session', () => {
  const h = createHarness();
  const request = stripeRequest();
  const original = historyRows(h);
  let failed = false;
  h.faults.flush = () => { if (!failed) { failed = true; return true; } return false; };
  expectFailure(h.call(request), 'UNAVAILABLE');
  assert.equal(historyRows(h).length, original.length + 1);
  const newSession = h.freshSession();
  const recovered = expectSuccess(newSession.call(request));
  assert.equal(recovered.student.marks, 3);
  assert.equal(recovered.receipt.requestId, request.requestId);
  assert.equal(historyRows(newSession).length, original.length + 1);
});

test('a failed append leaves history unchanged and the exact same request remains safe to retry', () => {
  const h = createHarness();
  const request = stripeRequest();
  const original = historyRows(h);
  h.faults.writeBefore = event => event.name === 'Promotion History';
  expectFailure(h.call(request), 'UNAVAILABLE');
  assert.deepEqual(historyRows(h), original);
  delete h.faults.writeBefore;
  const saved = expectSuccess(h.call(request));
  assert.equal(saved.student.marks, 3);
  assert.equal(historyRows(h).length, original.length + 1);
});

test('a retry after later promotions returns its original receipt and cannot revert the current student view', () => {
  const h = createHarness();
  const request = stripeRequest();
  const first = expectSuccess(h.call(request));
  const second = expectSuccess(h.call(stripeRequest({ expectedRevision: 2 })));
  const count = historyRows(h).length;
  const retry = expectSuccess(h.call(Object.fromEntries(Object.entries(request).reverse())));
  assert.deepEqual(retry.receipt, first.receipt, 'key order must not change an identical request fingerprint');
  assert.deepEqual(retry.student, second.student, 'a receipt and the current rank are distinct facts');
  assert.equal(historyRows(h).length, count);
});

test('Students cells never become rank authority, even when edited to a different revision and belt', () => {
  const h = createHarness();
  const row = h.sheets.get('Students').values.find(value => value[0] === STUDENTS[0].id);
  row[5] = 'Black Belt'; row[6] = 99; row[7] = 'degrees'; row[8] = 999;
  const current = readStudent(h);
  assert.equal(current.student.belt, 'Blue Belt');
  assert.equal(current.student.marks, 2);
  assert.equal(current.student.revision, 1);
  const saved = expectSuccess(h.call(stripeRequest()));
  assert.equal(saved.student.belt, 'Blue Belt');
  assert.equal(saved.student.marks, 3);
  const restored = h.sheets.get('Students').values.find(value => value[0] === STUDENTS[0].id);
  assert.equal(restored[5], 'Blue Belt');
  assert.equal(Number(restored[8]), 2);
});

test('an unknown request is explicitly not found and checking it creates no record', () => {
  const h = createHarness();
  const original = historyRows(h);
  const data = expectSuccess(h.call({ operation: 'checkSave', requestId: requestId() }));
  assert.equal(data.status, 'not_found');
  assert.equal(Object.hasOwn(data, 'receipt'), false);
  assert.deepEqual(historyRows(h), original);
});

test('malformed or unsupported write fields cannot silently change rank or history', () => {
  const h = createHarness();
  const original = historyRows(h);
  for (const request of [
    stripeRequest({ action: 'stripe', belt: 'Black Belt' }),
    stripeRequest({ expectedRevision: 1.5 }), stripeRequest({ expectedRevision: '1' }),
    stripeRequest({ action: 'belt', belt: 'Gold Belt' }),
    rankRequest({ rank: { belt: 'Blue Belt', marks: -1 } }),
    rankRequest({ rank: { belt: 'Blue Belt', marks: 1.25 } }),
    rankRequest({ rank: { belt: 'Blue Belt', marks: '2' } }),
    rankRequest({ rank: { belt: 'Blue Belt', marks: 2, markType: 'degrees' } }),
    registerRequest({ distinguishingLabel: '' }), { operation: 'deleteStudent', studentId: STUDENTS[0].id }
  ]) expectFailure(h.call(request), 'VALIDATION');
  assert.deepEqual(historyRows(h), original);
});

test('an altered append readback cannot be reported as the exact promotion that was requested', () => {
  const h = createHarness();
  const original = historyRows(h);
  h.faults.writeAfter = event => {
    if (event.name === 'Promotion History' && event.row > original.length) {
      event.values.at(-1)[HISTORY_HEADERS.indexOf('approver_label')] = 'TEST Wrong Readback';
    }
    return false;
  };
  expectFailure(h.call(stripeRequest()), 'UNAVAILABLE');
  assert.equal(historyRows(h).length, original.length + 1, 'unknown confirmation must not imply nothing was committed');
});

test('native Sheets text markers preserve quoted legacy references and formula-looking carried metadata exactly', () => {
  const quotedReference = "'Blue Belt'!A2:K2";
  const supplied = seedSheets();
  supplied[0][1][1][STUDENT_HEADERS.indexOf('legacy_refs')] = quotedReference;
  supplied[1][1][1][HISTORY_HEADERS.indexOf('legacy_refs')] = quotedReference;
  supplied[0][1][1][STUDENT_HEADERS.indexOf('history_note')] = '=literal historical annotation';
  supplied[1][1][1][HISTORY_HEADERS.indexOf('history_note')] = '=literal historical annotation';
  const h = createHarness({ sheets: supplied, nativeTextMarkers: true });
  const probe = makeSheet('Native text-marker probe', [], { nativeTextMarkers: true }, []);
  probe.appendRow([quotedReference]);
  assert.equal(probe.values[0][0], "Blue Belt'!A2:K2", 'unescaped append reproduces the observed native failure');
  const literalValues = [quotedReference, '=literal historical annotation', '+literal note', '-literal note', '@literal note'];
  probe.appendRow(plain(h.context.literalPromotionRow_(literalValues)));
  assert.deepEqual(probe.values[1], literalValues, 'one escaped text marker round-trips every literal value');

  const original = historyRows(h);
  const saved = expectSuccess(h.call(stripeRequest()));
  assert.equal(saved.viewPending, false);
  assert.equal(saved.receipt.after.legacyRefs, quotedReference);
  assert.equal(saved.receipt.after.historyNote, '=literal historical annotation');
  assert.equal(historyRows(h).at(-1)[HISTORY_HEADERS.indexOf('legacy_refs')], quotedReference);
  const view = h.sheets.get('Students').values.find(row => row[0] === STUDENTS[0].id);
  assert.equal(view[STUDENT_HEADERS.indexOf('legacy_refs')], quotedReference);
  assert.equal(view[STUDENT_HEADERS.indexOf('history_note')], '=literal historical annotation');
  assert.deepEqual(historyRows(h).slice(0, original.length), original);
  assert.equal(readStudent(h.freshSession()).student.legacyRefs, quotedReference);
});

test('post-append metadata corruption remains unknown on retry and checkSave until one exact repair recovers the original receipt', () => {
  const quotedReference = "'Blue Belt'!A2:K2";
  const column = HISTORY_HEADERS.indexOf('legacy_refs');
  const supplied = seedSheets();
  supplied[0][1][1][STUDENT_HEADERS.indexOf('legacy_refs')] = quotedReference;
  supplied[1][1][1][column] = quotedReference;
  const h = createHarness({ sheets: supplied, nativeTextMarkers: true });
  const request = stripeRequest();
  const original = historyRows(h);
  h.faults.writeAfter = event => {
    if (event.name === 'Promotion History' && event.row > original.length) event.values.at(-1)[column] = quotedReference.slice(1);
    return false;
  };
  const initial = expectFailure(h.call(request), 'UNAVAILABLE');
  assert.equal(initial.error.retryable, true);
  const committed = historyRows(h).at(-1);
  const eventId = committed[HISTORY_HEADERS.indexOf('event_id')];
  assert.equal(historyRows(h).length, original.length + 1);
  delete h.faults.writeAfter;
  const corruptSnapshot = historyRows(h);
  for (const pending of [request, { operation: 'checkSave', requestId: request.requestId }]) {
    const result = expectFailure(h.call(pending), 'UNAVAILABLE');
    assert.equal(result.error.retryable, true, 'a previously appended request must not be described as definitely unsaved');
    assert.deepEqual(historyRows(h), corruptSnapshot, 'retry and checkSave must not append or silently repair metadata');
  }
  expectFailure(h.call({ operation: 'readStudent', studentId: request.studentId }), 'TEST_DESTINATION_INVALID');
  assert.deepEqual(historyRows(h), corruptSnapshot, 'the immutable metadata validator stays strict');

  // Model only the separately authorized one-cell TEST repair, outside the app.
  h.sheets.get('Promotion History').values.at(-1)[column] = quotedReference;
  const repaired = historyRows(h);
  assert.deepEqual(repaired.at(-1).filter((_, index) => index !== column), committed.filter((_, index) => index !== column));
  const recovered = expectSuccess(h.call(request));
  assert.equal(recovered.receipt.eventId, eventId);
  assert.equal(recovered.receipt.requestId, request.requestId);
  assert.equal(recovered.student.marks, 3);
  assert.equal(recovered.student.legacyRefs, quotedReference);
  assert.deepEqual(historyRows(h), repaired, 'the original receipt is recovered with zero additional history appends');
  assert.equal(expectSuccess(h.call({ operation: 'checkSave', requestId: request.requestId })).receipt.eventId, eventId);
});
