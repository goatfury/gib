import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// All identities, destinations and source cells in this file are fictional.
// These tests execute the actual receiver and require its shared commit lock.
const source = readFileSync(new URL('../promotions/Code.gs', import.meta.url), 'utf8');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => digest(JSON.stringify(canonical(value)));
const plain = value => JSON.parse(JSON.stringify(value));
const typed = value => value === '' ? { type: 'blank', value: '' }
  : value instanceof Date ? { type: 'date', value: value.toISOString() } : { type: typeof value, value };
const display = value => value instanceof Date ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' }).format(value) : String(value ?? '');
const numberFormat = value => value instanceof Date ? 'm/d/yyyy' : 'General';
const SHEETS = ['Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student'];
const OWNER = 'synthetic-manager@example.invalid';
const BOOK = 'synthetic-repair-test-workbook';
const LIVE_BOOK = 'synthetic-isolated-live-workbook';
const STUDENT_HEADERS = ['student_id', 'display_name', 'distinguishing_label', 'status', 'rank_known', 'belt', 'marks', 'mark_type', 'revision', 'last_event_id', 'legacy_refs', 'history_note'];
const HISTORY_HEADERS = ['event_id', 'request_id', 'student_id', 'revision', 'event_kind', 'event_date_ny', 'recorded_at_utc', 'display_name', 'distinguishing_label', 'before_status', 'after_status', 'before_rank_known', 'before_belt', 'before_marks', 'before_mark_type', 'after_rank_known', 'after_belt', 'after_marks', 'after_mark_type', 'approver_id', 'approver_label', 'recorder_identity', 'corrects_event_id', 'reason', 'legacy_refs', 'history_note', 'payload_fingerprint'];

function createHarness({ active = OWNER, effective = OWNER, lockAvailable = true, saved } = {}) {
  const faults = {};
  const operations = [];
  let held = false;
  const properties = new Map([
    ['TEST_OWNER_EMAIL', OWNER], ['TEST_WORKBOOK_ID', BOOK],
    ['LIVE_ENABLED', 'true'], ['LIVE_WORKBOOK_ID', LIVE_BOOK], ['LIVE_WORKBOOK_TITLE', 'Synthetic isolated live destination']
  ]);
  const rows = new Map(SHEETS.map(name => [name, [['Name', '', 'Date', 'Rank awarded', '4 stripes']]]));
  rows.get('Black Belt').push(
    ['TEST Avery', "Juniper-O'Neill", '', '', new Date('2023-02-25T05:00:00.000Z')],
    ['TEST Avery', 'Fern', '', '', ''],
    ['TEST Robin', 'Finch', '', '0 degrees', ''],
    ['TEST Robin', 'Finch', '', '0 degrees', '']
  );
  rows.get('Former student').push(['TEST Renée', 'Archive', '', '', '']);
  rows.set('Students', [STUDENT_HEADERS]);
  const baselines = [];
  for (const [index, item] of [
    ['Black Belt', 2, 'TEST Avery', false], ['Black Belt', 3, 'TEST Avery', false],
    ['Black Belt', 4, 'TEST Robin', true], ['Black Belt', 5, 'TEST Robin', true],
    ['Former student', 2, 'TEST Renée', false]
  ].entries()) {
    const [sheet, row, name, known] = item;
    const refs = JSON.stringify([{ range: `'${sheet}'!A${row}:E${row}`, fingerprint: String(index + 1).repeat(64) }]);
    baselines.push([
      `seed-event-${index + 1}`, `seed-request-${index + 1}`, `seed-student-${index + 1}`, 1, 'REGISTER', '', '2026-09-01T12:00:00.000Z',
      name, `Legacy ${sheet} row ${row}`, '', sheet === 'Former student' ? 'archived' : 'active', '', '', '', '',
      known, known ? 'Black Belt' : '', known ? 0 : '', known ? 'degrees' : '', '', '', 'LEGACY BASELINE IMPORT', '',
      'Legacy baseline import; manifest=promotions-live-baseline-v1; promotion date unknown.', refs, 'Original note; exact spelling and blanks retained.', ''
    ]);
  }
  rows.set('Promotion History', [HISTORY_HEADERS, ...baselines]);
  if (saved) for (const [name, values] of saved) rows.set(name, structuredClone(values));
  function sheet(name, values) {
    const formulas = new Map();
    const notes = new Map();
    const displays = new Map();
    const formats = new Map();
    const range = (row, column, height = 1, width = 1) => ({
      getValues() {
        assert.equal(held, true, 'all authoritative and source reads share the write lock');
        if (faults.read?.({ name, row })) throw new Error('Injected read failure');
        operations.push({ type: 'read', name, row, column });
        return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => structuredClone(values[row + y - 1]?.[column + x - 1] ?? '')));
      },
      getFormulas() { return [[formulas.get(`${row}:${column}`) || '']]; },
      getNotes() { assert.equal(held, true); return [[notes.get(`${row}:${column}`) || '']]; },
      getDisplayValues() { assert.equal(held, true); return [[displays.get(`${row}:${column}`) ?? display(values[row - 1]?.[column - 1])]]; },
      getNumberFormats() { assert.equal(held, true); return [[formats.get(`${row}:${column}`) ?? numberFormat(values[row - 1]?.[column - 1])]]; },
      setValues(incoming) {
        assert.equal(held, true, 'derived writes share the write lock');
        if (faults.writeBefore?.({ name, row })) throw new Error('Injected pre-write failure');
        for (let y = 0; y < height; y += 1) {
          values[row + y - 1] ||= [];
          for (let x = 0; x < width; x += 1) {
            const value = incoming[y][x];
            values[row + y - 1][column + x - 1] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : structuredClone(value);
          }
        }
        operations.push({ type: 'write', name, row });
        if (faults.writeAfter?.({ name, row })) throw new Error('Injected lost append confirmation');
      },
      clearContent() { assert.equal(held, true); for (let y = 0; y < height; y += 1) values[row + y - 1] = Array(width).fill(''); }
    });
    return {
      values, formulas, notes, displays, formats, getLastColumn: () => Math.max(...values.map(line => line.length)), getLastRow: () => values.length,
      getRange: range, appendRow: row => range(values.length + 1, 1, 1, row.length).setValues([row])
    };
  }
  const sheets = new Map([...rows].map(([name, values]) => [name, sheet(name, values)]));
  const liveSheets = new Map([...rows].map(([name, values]) => [name, sheet(name, structuredClone(values))]));
  const opened = [];
  const context = vm.createContext({
    Date, console,
    Session: { getActiveUser: () => ({ getEmail: () => active }), getEffectiveUser: () => ({ getEmail: () => effective }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties.get(name) || '' }) },
    LockService: { getScriptLock: () => ({ tryLock() { faults.beforeLock?.(); held = lockAvailable; return lockAvailable; }, releaseLock() { assert.equal(held, true); held = false; } }) },
    SpreadsheetApp: {
      openById(id) {
        assert.equal([BOOK, LIVE_BOOK].includes(id), true); opened.push(id);
        return { getId: () => id, getName: () => id === BOOK ? 'GYM IN A BOX Promotions — PRIVATE SYNTHETIC TEST' : 'Synthetic isolated live destination',
          getSpreadsheetTimeZone: () => 'America/New_York', getSheetByName: name => (id === BOOK ? sheets : liveSheets).get(name) };
      },
      flush() { assert.equal(held, true); if (faults.flush?.()) throw new Error('Injected flush failure'); }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }, getUuid: randomUUID,
      computeDigest: (_, text) => [...createHash('sha256').update(String(text)).digest()],
      formatDate: value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
    }
  });
  vm.runInContext(source, context);
  return {
    context, sheets, liveSheets, properties, operations, faults, opened,
    call: request => plain(context.promotionRequest(request)), repair: request => plain(context.promotionRepair(request)),
    snapshot: () => structuredClone([...sheets].map(([name, value]) => [name, value.values])),
    rows: () => structuredClone(sheets.get('Promotion History').values)
  };
}

function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
function failure(result, code) { assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code, JSON.stringify(result)); return result; }
const student = (h, id = 'seed-student-1') => success(h.call({ operation: 'readStudent', studentId: id })).student;
const sign = repair => {
  const { repairId, ...identity } = repair;
  return { operation: 'applyRepair', repair: { ...identity, repairId: 'repair-' + hash(identity) } };
};
function proposal(h, field = 'identity', id = 'seed-student-1', changes = {}, headerRow = 1) {
  const current = student(h, id);
  const source = JSON.parse(current.legacyRefs)[0].range.match(/^'(.+)'!A(\d+):E\d+$/);
  const cells = [];
  for (const row of [headerRow, Number(source[2])]) for (let column = 0; column < 5; column += 1) cells.push({
    sheet: source[1], cell: String.fromCharCode(65 + column) + row, value: typed(h.sheets.get(source[1]).values[row - 1][column]),
    display: display(h.sheets.get(source[1]).values[row - 1][column]), numberFormat: numberFormat(h.sheets.get(source[1]).values[row - 1][column])
  });
  const before = field === 'identity' ? { displayName: current.displayName, distinguishingLabel: current.distinguishingLabel }
    : Object.fromEntries(['rankKnown', 'belt', 'marks', 'markType', 'lastPromotionDateNY'].map(key => [key, current[key]]));
  const surname = h.sheets.get(source[1]).values[Number(source[2]) - 1][1];
  const after = field === 'identity' ? { ...before, displayName: current.displayName.trim() + ' ' + surname }
    : { rankKnown: true, belt: 'Black Belt', marks: 4, markType: 'degrees', lastPromotionDateNY: '2023-02-25' };
  return sign({
    schema: 'promotions-data-repair-v1', manifestId: 'synthetic-repair-manifest-v1', target: 'test', workbookId: BOOK,
    studentId: id, expectedRevision: current.revision, expectedLastEventId: current.lastEventId,
    expectedSourceFingerprint: digest(current.legacyRefs), field, before, after,
    evidence: { interpretation: field === 'identity' ? 'Established split-name source columns A and B.' : 'The exact source date is under the labeled fourth Black Belt stripe column; the summary is blank.', headerRefs: [`'${source[1]}'!A${headerRow}:E${headerRow}`], cells },
    ...changes
  });
}
const promote = (h, current, extra = {}) => h.call({
  operation: 'recordPromotion', requestId: 'req-' + randomUUID(), studentId: current.studentId,
  expectedRevision: current.revision, action: 'stripe', approverId: 'TEST-COACH-A', ...extra
});

function sourceConflictHarness() {
  const h = createHarness();
  const sourceRows = h.sheets.get('Blue Belt').values;
  sourceRows.splice(0, sourceRows.length,
    ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes'],
    ['TEST Source Conflict', '2 stripes', '', new Date('2019-03-19T04:00:00.000Z'), new Date('2015-04-23T04:00:00.000Z')]
  );
  const row = h.sheets.get('Promotion History').values.find(value => value[2] === 'seed-student-3');
  for (const [field, value] of Object.entries({ display_name: 'TEST Source Conflict', distinguishing_label: 'Legacy Blue Belt row 2',
    after_belt: 'Blue Belt', after_marks: 2, after_mark_type: 'stripes',
    legacy_refs: JSON.stringify([{ range: "'Blue Belt'!A2:E2", fingerprint: 'b'.repeat(64) }])
  })) row[HISTORY_HEADERS.indexOf(field)] = value;
  return h;
}

function conflictProposal(h) {
  const request = proposal(h, 'rank', 'seed-student-3');
  return sign({ ...request.repair, after: { rankKnown: false, belt: '', marks: null, markType: '', lastPromotionDateNY: '' },
    evidence: { ...request.repair.evidence, interpretation: 'The explicit current summary says 2 stripes while the current Blue Belt block records a dated third stripe. Preserve both original entries and require resolution.',
      rankConflict: { summaryRef: "'Blue Belt'!B2", awardRefs: ["'Blue Belt'!D2"] }
    }
  });
}

test('audited identity and rank repairs replay while every original row, ID and source cell is preserved', () => {
  const h = createHarness(); const original = h.rows(); const sources = h.snapshot().filter(([name]) => SHEETS.includes(name));
  const named = success(h.repair(proposal(h)));
  assert.equal(named.student.displayName, "TEST Avery Juniper-O'Neill");
  assert.equal(named.student.studentId, 'seed-student-1'); assert.equal(named.student.lastPromotionDateNY, '');
  const ranked = success(h.repair(proposal(h, 'rank')));
  assert.equal(ranked.student.marks, 4); assert.equal(ranked.student.markType, 'degrees'); assert.equal(ranked.student.lastPromotionDateNY, '2023-02-25');
  assert.equal(ranked.receipt.approverLabel, ''); assert.equal(ranked.receipt.repair.field, 'rank');
  const fresh = createHarness({ saved: h.snapshot() });
  assert.deepEqual(student(fresh), ranked.student);
  assert.deepEqual(h.rows().slice(0, original.length), original);
  assert.deepEqual(h.snapshot().filter(([name]) => SHEETS.includes(name)), sources);
  assert.equal(h.sheets.get('Students').values.find(row => row[0] === 'seed-student-1')[1], ranked.student.displayName);
  const read = success(h.call({ operation: 'readStudent', studentId: 'seed-student-1' }));
  assert.equal(read.history[0].after.displayName, 'TEST Avery');
  assert.equal(read.history[1].after.rankKnown, false);
  assert.equal(read.history[2].repair.evidence.cells.find(cell => cell.cell === 'E2').value.value, '2023-02-25T05:00:00.000Z');
});

test('an untouched known baseline becomes explicitly uncertain when its summary conflicts with a higher dated current-belt award', () => {
  const h = sourceConflictHarness(); const original = h.rows(); const sourceRows = structuredClone(h.sheets.get('Blue Belt').values);
  const request = conflictProposal(h); const repaired = success(h.repair(request));
  assert.equal(repaired.student.rankKnown, false); assert.equal(repaired.student.belt, ''); assert.equal(repaired.student.marks, null);
  assert.equal(repaired.student.markType, ''); assert.equal(repaired.student.lastPromotionDateNY, '');
  assert.equal(repaired.student.displayName, 'TEST Source Conflict'); assert.equal(repaired.student.studentId, 'seed-student-3');
  assert.equal(repaired.receipt.repair.before.marks, 2); assert.deepEqual(repaired.receipt.repair.evidence.rankConflict, request.repair.evidence.rankConflict);
  assert.deepEqual(h.rows().slice(0, original.length), original); assert.deepEqual(h.sheets.get('Blue Belt').values, sourceRows);
  assert.deepEqual(success(h.repair(request)).receipt, repaired.receipt); assert.equal(h.rows().length, original.length + 1);
  assert.deepEqual(student(createHarness({ saved: h.snapshot() }), 'seed-student-3'), repaired.student);
  failure(promote(h, repaired.student), 'RANK_UNKNOWN');
  const confirmed = success(h.call({ operation: 'confirmRank', requestId: 'explicit-conflict-resolution', studentId: 'seed-student-3', expectedRevision: repaired.student.revision,
    rank: { belt: 'Blue Belt', marks: 3 }, reason: 'TEST instructor explicitly resolved the conflicting source rank.', approverName: 'TEST Coach' }));
  assert.equal(confirmed.student.marks, 3); assert.equal(confirmed.receipt.eventKind, 'RANK_CONFIRM');
});

test('unknown rank repairs require actual conflicting summary and dated award evidence and cannot cross later application rank history', () => {
  for (const defect of ['missingProof', 'sameMarks', 'earlierAward', 'arbitraryText', 'otherBlock', 'knownAfter', 'nonemptyDate']) {
    const h = sourceConflictHarness();
    if (defect === 'sameMarks') h.sheets.get('Blue Belt').values[0][3] = '2 stripes';
    if (defect === 'arbitraryText') h.sheets.get('Blue Belt').values[1][3] = 'A miscellaneous annotation';
    const initial = h.rows(); let request = conflictProposal(h);
    if (defect === 'missingProof') { delete request.repair.evidence.rankConflict; request = sign(request.repair); }
    if (defect === 'earlierAward') request = sign({ ...request.repair, evidence: { ...request.repair.evidence, rankConflict: { ...request.repair.evidence.rankConflict, awardRefs: ["'Blue Belt'!E2"] } } });
    if (defect === 'otherBlock') request = sign({ ...request.repair, evidence: { ...request.repair.evidence, rankConflict: { ...request.repair.evidence.rankConflict, awardRefs: ["'Blue Belt'!H2"] } } });
    if (defect === 'knownAfter') request = sign({ ...request.repair, after: { ...request.repair.before, marks: 3 } });
    if (defect === 'nonemptyDate') request = sign({ ...request.repair, after: { ...request.repair.after, lastPromotionDateNY: '2019-03-19' } });
    failure(h.repair(request), 'VALIDATION'); assert.deepEqual(h.rows(), initial, defect);
  }
  const unknown = createHarness(); const originalUnknown = unknown.rows(); const noChange = proposal(unknown, 'rank');
  failure(unknown.repair(sign({ ...noChange.repair, after: { ...noChange.repair.before }, evidence: { ...noChange.repair.evidence,
    rankConflict: { summaryRef: "'Black Belt'!D2", awardRefs: ["'Black Belt'!E2"] }
  } })), 'VALIDATION'); assert.deepEqual(unknown.rows(), originalUnknown);
  const h = sourceConflictHarness(); const originalProposal = conflictProposal(h); const awarded = success(promote(h, student(h, 'seed-student-3')));
  failure(h.repair(originalProposal), 'STALE_REPAIR');
  success(h.call({ operation: 'correctLatest', requestId: 'later-app-rank-correction', studentId: 'seed-student-3', expectedRevision: awarded.student.revision,
    correctsEventId: awarded.receipt.eventId, rank: { belt: 'Blue Belt', marks: 2 }, reason: 'TEST later instructor correction.', approverName: 'TEST Coach' }));
  const preserved = h.rows(); failure(h.repair(conflictProposal(h)), 'RANK_REPAIR_CONFLICT'); assert.deepEqual(h.rows(), preserved);
});

test('same-first-name identities, true duplicate full names and archived names remain distinct existing students', () => {
  const h = createHarness();
  for (let id = 1; id <= 5; id += 1) success(h.repair(proposal(h, 'identity', `seed-student-${id}`)));
  const students = success(h.call({ operation: 'bootstrap' })).students;
  assert.equal(students.length, 5);
  assert.equal(students[0].displayName, "TEST Avery Juniper-O'Neill"); assert.equal(students[1].displayName, 'TEST Avery Fern');
  assert.equal(students[2].displayName, 'TEST Robin Finch'); assert.equal(students[3].displayName, 'TEST Robin Finch');
  assert.notEqual(students[2].studentId, students[3].studentId);
  assert.equal(students[4].displayName, 'TEST Renée Archive'); assert.equal(students[4].status, 'archived');
  failure(h.repair(proposal(h, 'rank', 'seed-student-5')), 'RANK_REPAIR_CONFLICT');
});

test('exact legacy before names retain whitespace and controls without weakening strict corrected names', () => {
  for (const originalName of ['TEST Avery ', 'TEST Avery\r']) {
    const h = createHarness();
    h.sheets.get('Black Belt').values[1][0] = originalName;
    h.sheets.get('Promotion History').values[1][HISTORY_HEADERS.indexOf('display_name')] = originalName;
    const original = h.rows(); const request = proposal(h);
    assert.equal(request.repair.before.displayName, originalName);
    const changedBefore = sign({ ...request.repair, before: { ...request.repair.before, displayName: originalName.trim() } });
    failure(h.repair(changedBefore), 'STALE_REPAIR');
    for (const invalidAfter of ["TEST Avery Juniper-O'Neill ", "TEST Avery\rJuniper-O'Neill"]) {
      failure(h.repair(sign({ ...request.repair, after: { ...request.repair.after, displayName: invalidAfter } })), 'VALIDATION');
    }
    const repaired = success(h.repair(request));
    assert.equal(repaired.student.displayName, "TEST Avery Juniper-O'Neill");
    assert.equal(repaired.receipt.repair.before.displayName, originalName);
    assert.deepEqual(h.rows().slice(0, original.length), original);
    const fresh = createHarness({ saved: h.snapshot() });
    const history = success(fresh.call({ operation: 'readStudent', studentId: 'seed-student-1' }));
    assert.equal(history.history[0].after.displayName, originalName);
    assert.deepEqual(history.student, repaired.student);
  }
});

test('archived name repairs bind the explicitly reviewed later header block rather than row one', () => {
  const h = createHarness(); const former = h.sheets.get('Former student').values;
  former.splice(0, former.length,
    ['Former students by historical belt', '', '', '', ''], ['', '', '', '', ''], ['Older unrelated block', '', '', '', ''],
    ['Name', '', 'Date', 'Rank awarded', '4 stripes'], ['TEST Renée', 'Archive', '', '', '']
  );
  const baseline = h.sheets.get('Promotion History').values.find(row => row[2] === 'seed-student-5');
  baseline[HISTORY_HEADERS.indexOf('legacy_refs')] = JSON.stringify([{ range: "'Former student'!A5:E5", fingerprint: '5'.repeat(64) }]);
  const original = h.rows();
  failure(h.repair(proposal(h, 'identity', 'seed-student-5')), 'VALIDATION');
  const request = proposal(h, 'identity', 'seed-student-5', {}, 4);
  const result = success(h.repair(request));
  assert.equal(result.student.displayName, 'TEST Renée Archive'); assert.equal(result.student.status, 'archived'); assert.equal(result.student.rankKnown, false);
  assert.deepEqual(result.receipt.repair.evidence.headerRefs, ["'Former student'!A4:E4"]);
  assert.deepEqual(h.rows().slice(0, original.length), original);
  assert.deepEqual(student(createHarness({ saved: h.snapshot() }), 'seed-student-5'), result.student);
});

test('repairs are unavailable to tablet/ordinary operations, anonymous users and an unauthorized effective owner', () => {
  const request = proposal(createHarness());
  for (const options of [{ active: '' }, { active: 'other@example.invalid' }, { effective: '' }, { effective: 'other@example.invalid' }]) {
    const h = createHarness(options); failure(h.repair(request), 'UNAUTHORIZED'); assert.deepEqual(h.opened, []);
  }
  const h = createHarness(); const initial = h.rows();
  failure(h.call(request), 'VALIDATION');
  failure(plain(h.context.promotionRequestWithRecorder_(request, 'm1-test-device-1234567890abcdef12345678', { target: 'test' })), 'VALIDATION');
  assert.deepEqual(h.rows(), initial);
});

test('live repairs require the exact separately approved fingerprint and verified destination', () => {
  const h = createHarness(); const initial = h.rows(); const request = proposal(h, 'identity', 'seed-student-1', { target: 'live', workbookId: LIVE_BOOK });
  h.opened.length = 0;
  failure(h.repair(request), 'REPAIR_NOT_APPROVED'); assert.deepEqual(h.opened, []);
  h.properties.set('LIVE_REPAIR_APPROVED_FINGERPRINT', hash(request));
  const changed = sign({ ...request.repair, manifestId: 'another-reviewed-manifest' });
  failure(h.repair(changed), 'REPAIR_NOT_APPROVED');
  success(h.repair(request)); assert.deepEqual(h.opened, [LIVE_BOOK]); assert.deepEqual(h.rows(), initial);
  const wrong = proposal(h, 'identity', 'seed-student-2', { workbookId: LIVE_BOOK });
  failure(h.repair(wrong), 'REPAIR_DESTINATION_CHANGED'); assert.deepEqual(h.rows(), initial);
});

test('revoking exact live approval while the repair waits for the lock prevents all workbook access', () => {
  const h = createHarness(); const request = proposal(h, 'identity', 'seed-student-1', { target: 'live', workbookId: LIVE_BOOK });
  h.properties.set('LIVE_REPAIR_APPROVED_FINGERPRINT', hash(request)); h.opened.length = 0;
  h.faults.beforeLock = () => h.properties.delete('LIVE_REPAIR_APPROVED_FINGERPRINT');
  failure(h.repair(request), 'REPAIR_NOT_APPROVED'); assert.deepEqual(h.opened, []);
});

test('a second identical run and an interrupted multi-record run resume without duplicate repairs', () => {
  const h = createHarness(); const first = proposal(h); const second = proposal(h, 'identity', 'seed-student-2'); const initial = h.rows();
  success(h.repair(first)); const once = h.rows();
  assert.deepEqual(success(h.repair(first)).receipt, success(h.repair(first)).receipt); assert.deepEqual(h.rows(), once);
  const fresh = createHarness({ saved: h.snapshot() }); success(fresh.repair(first)); success(fresh.repair(second)); success(fresh.repair(second));
  assert.equal(fresh.rows().length, initial.length + 2); assert.deepEqual(fresh.rows().slice(0, initial.length), initial);
});

test('lost append/flush/readback confirmation and failed Students rebuilding recover the exact durable receipt', () => {
  for (const fault of ['writeAfter', 'flush', 'read', 'view']) {
    const h = createHarness(); const request = proposal(h); const initial = h.rows().length;
    if (fault === 'writeAfter') h.faults.writeAfter = ({ name }) => name === 'Promotion History';
    if (fault === 'flush') h.faults.flush = () => true;
    if (fault === 'read') h.faults.read = ({ name, row }) => name === 'Promotion History' && row === 2 && h.rows().length > initial;
    if (fault === 'view') h.faults.writeBefore = ({ name }) => name === 'Students';
    const result = h.repair(request);
    if (fault === 'view') assert.equal(success(result).viewPending, true); else assert.equal(failure(result, 'UNAVAILABLE').error.retryable, true);
    assert.equal(h.rows().length, initial + 1);
    const fresh = createHarness({ saved: h.snapshot() });
    const retry = success(fresh.repair(request)); assert.equal(retry.viewPending, false); assert.equal(fresh.rows().length, initial + 1);
    const checked = success(fresh.call({ operation: 'checkSave', requestId: 'req-' + request.repair.repairId }));
    assert.deepEqual(checked.receipt, retry.receipt); assert.equal(checked.status, 'confirmed');
  }
});

test('pre-append interruption and unavailable lock do not write and permit an exact retry', () => {
  const h = createHarness(); const request = proposal(h); const initial = h.rows();
  h.faults.writeBefore = ({ name }) => name === 'Promotion History'; failure(h.repair(request), 'UNAVAILABLE'); assert.deepEqual(h.rows(), initial);
  delete h.faults.writeBefore; success(h.repair(request));
  const blocked = createHarness({ lockAvailable: false }); failure(blocked.repair(request), 'BUSY'); assert.deepEqual(blocked.opened, []);
});

test('a concurrent promotion invalidates old proposals, survives a newly reviewed name repair, and blocks old rank repair', () => {
  const h = createHarness(); const id = 'seed-student-3'; const name = proposal(h, 'identity', id); const rank = proposal(h, 'rank', id);
  // A real competing receiver commits after proposal construction and before
  // the repair's shared lock is acquired; checks must read the resulting head.
  let competed = false;
  h.faults.beforeLock = () => {
    if (competed) return; competed = true;
    delete h.faults.beforeLock;
    success(promote(h, { studentId: id, revision: 1 }));
  };
  failure(h.repair(name), 'STALE_REPAIR'); failure(h.repair(rank), 'STALE_REPAIR');
  const current = success(h.repair(proposal(h, 'identity', id))).student;
  assert.equal(current.displayName, 'TEST Robin Finch'); assert.equal(current.marks, 1);
  failure(h.repair(proposal(h, 'rank', id)), 'RANK_REPAIR_CONFLICT');
  assert.equal(student(h, id).marks, 1);
});

test('later promotions and original pending attribution survive exact repair and ordinary request reconciliation', () => {
  const h = createHarness(); const id = 'seed-student-3';
  const pending = { operation: 'recordPromotion', requestId: 'pending-request-original', studentId: id, expectedRevision: 1, action: 'stripe', approverId: 'TEST-COACH-B' };
  const saved = success(h.call(pending)); const repair = proposal(h, 'identity', id); const repaired = success(h.repair(repair));
  const newer = success(promote(h, repaired.student));
  h.sheets.get('Black Belt').values[3][1] = 'Source edited after durable repair';
  const retried = success(h.repair(repair)); assert.equal(retried.student.marks, 2); assert.equal(retried.student.lastEventId, newer.receipt.eventId);
  assert.deepEqual(success(h.call(pending)).receipt, saved.receipt);
  const checked = success(h.call({ operation: 'checkSave', requestId: pending.requestId }));
  assert.equal(checked.receipt.approverId, 'TEST-COACH-B'); assert.equal(checked.receipt.after.displayName, 'TEST Robin');
  assert.equal(checked.student.displayName, 'TEST Robin Finch');
  assert.equal(h.rows().filter(row => row[1] === pending.requestId).length, 1);
});

test('an instructor can correct the latest real promotion across name repairs using the current revision', () => {
  const h = createHarness(); const id = 'seed-student-3';
  const awarded = success(promote(h, student(h, id)));
  const named = success(h.repair(proposal(h, 'identity', id)));
  const correction = { operation: 'correctLatest', requestId: 'name-safe-rank-correction', studentId: id,
    expectedRevision: named.student.revision, correctsEventId: awarded.receipt.eventId,
    rank: { belt: 'Black Belt', marks: 0 }, reason: 'TEST latest instructor award was entered twice.', approverName: 'TEST Coach' };
  failure(h.call({ ...correction, expectedRevision: awarded.student.revision }), 'STALE_REVISION');
  const corrected = success(h.call(correction));
  assert.equal(corrected.student.displayName, 'TEST Robin Finch'); assert.equal(corrected.student.marks, 0);
  assert.equal(corrected.receipt.before.marks, 1); assert.equal(corrected.receipt.correctsEventId, awarded.receipt.eventId);
  assert.deepEqual(student(createHarness({ saved: h.snapshot() }), id), corrected.student);
  const ranked = success(h.repair(proposal(h, 'rank')));
  const namedAfterRank = success(h.repair(proposal(h)));
  for (const correctsEventId of [ranked.receipt.eventId, 'seed-event-1']) failure(h.call({
    ...correction, requestId: 'blocked-' + randomUUID(), studentId: 'seed-student-1', expectedRevision: namedAfterRank.student.revision, correctsEventId
  }), 'CORRECTION_NOT_LATEST');
});

test('changed source values/headers/formulas, source binding, revision, head and before values are rejected under the lock', () => {
  for (const defect of ['surname', 'summary', 'header', 'formula', 'sourceNote', 'headerNote', 'displayPrecision', 'numberFormatPrecision', 'fingerprint', 'revision', 'head', 'before', 'missingCell', 'otherStudentCell']) {
    const h = createHarness(); let request = proposal(h); const initial = h.rows();
    if (defect === 'surname') h.sheets.get('Black Belt').values[1][1] = 'Changed';
    if (defect === 'summary') h.sheets.get('Black Belt').values[1][3] = '5 degrees';
    if (defect === 'header') h.sheets.get('Black Belt').values[0][4] = 'Previous belt stripe';
    if (defect === 'sourceNote') h.sheets.get('Black Belt').notes.set('2:5', 'This date is only an estimate.');
    if (defect === 'headerNote') h.sheets.get('Black Belt').notes.set('1:5', 'Previous belt column.');
    if (defect === 'displayPrecision') h.sheets.get('Black Belt').displays.set('2:5', 'February 2023');
    if (defect === 'numberFormatPrecision') h.sheets.get('Black Belt').formats.set('2:5', 'mmmm yyyy');
    if (defect === 'formula') h.sheets.get('Black Belt').formulas.set('2:2', '="Juniper-O\'Neill"');
    if (defect === 'fingerprint') request = sign({ ...request.repair, expectedSourceFingerprint: 'f'.repeat(64) });
    if (defect === 'revision') request = sign({ ...request.repair, expectedRevision: 2 });
    if (defect === 'head') request = sign({ ...request.repair, expectedLastEventId: 'different-event-head' });
    if (defect === 'before') request = sign({ ...request.repair, before: { ...request.repair.before, displayName: 'Wrong name' } });
    if (defect === 'missingCell') request = sign({ ...request.repair, evidence: { ...request.repair.evidence, cells: request.repair.evidence.cells.slice(1) } });
    if (defect === 'otherStudentCell') request = sign({ ...request.repair, evidence: { ...request.repair.evidence, cells: [...request.repair.evidence.cells, { sheet: 'Black Belt', cell: 'A3', value: typed('TEST Avery'), display: 'TEST Avery', numberFormat: 'General' }] } });
    failure(h.repair(request)); assert.deepEqual(h.rows(), initial, defect);
  }
});

test('a native source note added while waiting for the lock prevents the reviewed repair', () => {
  const h = createHarness(); const request = proposal(h, 'rank'); const initial = h.rows();
  h.faults.beforeLock = () => h.sheets.get('Black Belt').notes.set('2:5', 'This date is uncertain.');
  failure(h.repair(request), 'SOURCE_CHANGED'); assert.deepEqual(h.rows(), initial);
});

test('omitted native default text formats need no invented value while numeric/date formats stay mandatory', () => {
  const h = createHarness(); const request = proposal(h);
  const inertDefaults = sign({ ...request.repair, evidence: { ...request.repair.evidence,
    cells: request.repair.evidence.cells.map(cell => ({ ...cell, numberFormat: cell.value.type === 'date' ? cell.numberFormat : null }))
  } });
  success(h.repair(inertDefaults));
  for (const type of ['date', 'number']) {
    const fresh = createHarness();
    if (type === 'number') fresh.sheets.get('Black Belt').values[1][4] = 4;
    const next = proposal(fresh); const original = fresh.rows();
    const missingFormat = sign({ ...next.repair, evidence: { ...next.repair.evidence,
      cells: next.repair.evidence.cells.map(cell => ({ ...cell, numberFormat: cell.value.type === type ? null : cell.numberFormat }))
    } });
    failure(fresh.repair(missingFormat), 'VALIDATION'); assert.deepEqual(fresh.rows(), original);
  }
});

test('strict history validates repair schema and cannot silently permit identity changes in ordinary events', () => {
  const h = createHarness(); const repaired = success(h.repair(proposal(h))); const saved = h.snapshot();
  for (const [field, value] of [
    ['event_kind', 'CORRECTION'], ['display_name', 'Unaudited replacement'], ['after_marks', 1], ['after_status', 'archived'],
    ['reason', '{}'], ['payload_fingerprint', '0'.repeat(64)], ['request_id', 'different-request'],
    ['approver_label', 'An instructor'], ['recorder_identity', 'm1-test-device-1234567890abcdef12345678'],
    ['legacy_refs', '[]'], ['history_note', 'A changed note'], ['corrects_event_id', 'seed-event-1']
  ]) {
    const broken = structuredClone(saved); broken.find(([name]) => name === 'Promotion History')[1].at(-1)[HISTORY_HEADERS.indexOf(field)] = value;
    failure(createHarness({ saved: broken }).call({ operation: 'readStudent', studentId: 'seed-student-1' }), 'TEST_DESTINATION_INVALID');
  }
  failure(h.call({ operation: 'correctLatest', requestId: 'ordinary-correction-after-repair', studentId: 'seed-student-1', expectedRevision: repaired.student.revision,
    correctsEventId: repaired.receipt.eventId, rank: { belt: 'Black Belt', marks: 0 }, reason: 'An instructor cannot turn an identity repair into a rank correction.', approverName: 'TEST Instructor' }), 'CORRECTION_NOT_LATEST');
});

test('invalid, no-op, cross-field and forged deterministic repairs cannot change history', () => {
  const h = createHarness(); const request = proposal(h); const initial = h.rows();
  const malformed = [
    { ...request, extra: true }, { ...request, operation: 'bulkRepair' },
    { ...request, repair: { ...request.repair, repairId: 'repair-' + '0'.repeat(64) } },
    sign({ ...request.repair, after: { ...request.repair.before } }),
    sign({ ...request.repair, after: { ...request.repair.after, marks: 4 } }),
    sign({ ...request.repair, field: 'renameEveryone' }),
    sign({ ...proposal(h, 'rank').repair, after: { rankKnown: true, belt: 'Black Belt', marks: 4, markType: 'degrees', lastPromotionDateNY: '2023-02-30' } }),
    sign({ ...request.repair, evidence: { ...request.repair.evidence, cells: [...request.repair.evidence.cells, request.repair.evidence.cells[0]] } })
  ];
  for (const bad of malformed) { failure(h.repair(bad)); assert.deepEqual(h.rows(), initial); }
});
