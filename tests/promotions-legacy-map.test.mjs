import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyBinding, describeLegacyCell, mapLegacyBook } from '../tools/promotions-legacy-map.mjs';

const HEADERS = {
  black: ['Name', '', 'Date', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Black Belt', '4 stripes', '3 stripes', '2 stripes', '1 stripe'],
  brown: ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt'],
  purple: ['Name', 'Current Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', 'Blue 4 stripes', '3 stripes', '', '', 'Blue belt', '', '', '', '', 'How they started?'],
  blue: ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', '4th White', '3rd White', '2nd White'],
  white: ['Name', 'Current Rank awarded', 'Instructor', '4 stripes', '3 stripes', '2 stripes', '1 stripe'],
};
const nativeDate = () => ({
  userEnteredValue: { numberValue: 45352 }, effectiveValue: { numberValue: 45352 }, formattedValue: '3/1/2024',
  effectiveFormat: { numberFormat: { type: 'DATE', pattern: 'm/d/yyyy' } }, note: 'TEST original date note',
});
const nativeText = value => ({ userEnteredValue: { stringValue: value }, effectiveValue: { stringValue: value }, formattedValue: value });
const fixture = () => [
  { name: 'Black Belt', rows: [HEADERS.black, ['TEST Unlabeled Black', 'Unresolved', '', '', nativeDate(), '', '', '?', 'Early 2014'], ['TEST Explicit Degree', '', '', '5 degrees']] },
  { name: 'Brown Belt', rows: [HEADERS.brown, ['TEST Brown', '1 stripe', '', '', '', nativeDate(), 'Transplant']] },
  { name: 'Purple Belt', rows: [HEADERS.purple, ['TEST Purple', '4 stripes', nativeDate(), '?', '', '', '06/05/2023', '4 stripes', '', '', 'March 2018', '', '', '', '', '', 'Transplant']] },
  { name: 'Blue Belt', rows: [HEADERS.blue, ['TEST Blue', '1 stripe', '', '', '', nativeDate(), '06/05/2023', 'Transplant', '?', '', 'March 2018']] },
  { name: 'White Belt', rows: [HEADERS.white, ['TEST White', '0 stripe', '', '', '', '', '?']] },
  { name: 'Former student', rows: [
    ['Name', '', 'Date', 'Rank awarded', '3 stripes', '2 stripes', '1 stripe', '', '4th Brown'],
    ['TEST Archived Black', '', '', '2 degrees', '', nativeDate(), '?'], [],
    ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', '4th purple'],
    ['TEST Archived Brown', '2 stripes', '', '', '', '', 'Transplant'],
    ['Name', 'Current Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', 'Blue 4 stripes', '3 stripes'],
    ['TEST Archived Purple', '3 stripes'],
    ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', '4th White', '3rd White'],
    ['TEST Archived Blue', '1 stripe'],
    HEADERS.white,
    ['TEST Archived White', '0 stripe', '', '', '', '', '?'],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', 'TEST unattached historical annotation'],
  ] },
];
const candidate = (result, name) => result.candidates.find(row => row.displayName === name);

test('recognizes six tabs and all four embedded Former-student layouts without treating headers as students', () => {
  const result = mapLegacyBook({ sheets: fixture() });
  assert.equal(result.candidates.length, 11);
  assert.deepEqual(result.blocks.filter(block => block.sheetName === 'Former student').map(block => block.layout), ['black', 'brown', 'purple', 'blue', 'white']);
  assert.equal(result.candidates.filter(row => row.status === 'archived').length, 5);
  assert.ok(result.candidates.every(row => row.displayName !== 'Name'));
  const annotation = result.orphanItems.find(item => item.value === 'TEST unattached historical annotation');
  assert.equal(annotation.ref, "'Former student'!N12");
  assert.equal(annotation.unlabeled, true);
  assert.ok(result.issues.some(issue => issue.code === 'annotation_without_student'));
});

test('keeps native dates, literal dates, unknowns, annotations, headers, and exact cell references separately', () => {
  const result = mapLegacyBook({ sheets: fixture() });
  const blue = candidate(result, 'TEST Blue');
  const date = blue.items.find(item => item.ref === "'Blue Belt'!F2");
  assert.equal(date.type, 'date_serial');
  assert.equal(date.value, 45352);
  assert.equal(date.display, '3/1/2024');
  assert.deepEqual(date.raw, nativeDate());
  assert.equal(date.header, '1 stripe');
  assert.equal(blue.items.find(item => item.column === 7).type, 'string');
  assert.equal(blue.items.find(item => item.column === 7).value, '06/05/2023');
  assert.equal(blue.items.find(item => item.column === 9).value, '?');
  assert.equal(blue.items.find(item => item.column === 10).type, 'blank');
  assert.equal(blue.items.find(item => item.column === 11).value, 'March 2018');
  assert.equal(blue.items.find(item => item.column === 11).unlabeled, true);
  assert.equal(candidate(result, 'TEST Unlabeled Black Unresolved').items.find(item => item.column === 9).value, 'Early 2014');
});

test('retains repeated headers and unlabeled values rather than collapsing them by header name', () => {
  const result = mapLegacyBook({ sheets: fixture() });
  const black = candidate(result, 'TEST Unlabeled Black Unresolved');
  const repeated = black.items.filter(item => item.header === '4 stripes');
  assert.equal(repeated.length, 2);
  assert.deepEqual(repeated.map(item => item.ref), ["'Black Belt'!E2", "'Black Belt'!J2"]);
  const purple = candidate(result, 'TEST Purple');
  assert.equal(purple.items.find(item => item.column === 11).header, '');
  assert.equal(purple.items.find(item => item.column === 11).value, 'March 2018');
  assert.equal(purple.items.find(item => item.column === 17).header, 'How they started?');
});

test('Black dated awards recover rank despite a blank summary while archived rank stays unresolved', () => {
  const result = mapLegacyBook({ sheets: fixture() });
  const recovered = candidate(result, 'TEST Unlabeled Black Unresolved');
  assert.equal(recovered.currentRank.known, true);
  assert.equal(recovered.currentRank.marks, 4);
  assert.equal(recovered.currentRank.date.value, '2024-03-01');
  assert.equal(recovered.items.find(item => item.column === 2).value, 'Unresolved');
  assert.equal(candidate(result, 'TEST Explicit Degree').currentRank.marks, 5);
  assert.equal(candidate(result, 'TEST Explicit Degree').currentRank.markType, 'degrees');
  assert.equal(candidate(result, 'TEST White').currentRank.marks, 0);
  assert.equal(candidate(result, 'TEST White').currentRank.known, true);
  assert.ok(result.candidates.filter(row => row.status === 'archived').every(row => !row.currentRank.known));
  assert.equal(candidate(result, 'TEST Brown').currentRank.known, true);
  assert.ok(result.candidates.every(row => row.identity.status === 'needs_assignment'));
});

test('blank, question mark and Belt-only labels never become zero; stripe counts are not capped at four', () => {
  const sheets = fixture();
  sheets.find(sheet => sheet.name === 'White Belt').rows.push(['TEST Unknown', '?'], ['TEST Blank', ''], ['TEST Belt Only', 'Belt'], ['TEST Five', '5 stripes']);
  const result = mapLegacyBook({ sheets });
  for (const name of ['TEST Unknown', 'TEST Blank', 'TEST Belt Only']) {
    assert.deepEqual([candidate(result, name).currentRank.known, candidate(result, name).currentRank.marks], [false, null]);
  }
  assert.equal(candidate(result, 'TEST Five').currentRank.marks, 5);
});

test('same names remain separate; only explicit registry entries assign or join stable student identities', () => {
  const sheets = fixture();
  const white = sheets.find(sheet => sheet.name === 'White Belt');
  white.rows.push(['TEST Same Name', '1 stripe'], ['TEST Same Name', '2 stripes']);
  sheets.find(sheet => sheet.name === 'Former student').rows.push(['TEST Same Name', '1 stripe']);
  const first = mapLegacyBook({ sheets });
  const matches = first.candidates.filter(row => row.displayName === 'TEST Same Name');
  assert.equal(matches.length, 3);
  assert.ok(matches.every(row => row.identity.studentId === null));
  const registry = matches.map((row, i) => createLegacyBinding(row, { studentId: `TEST-MAP-ID-${i}`, distinguishingLabel: `TEST group ${i}` }));
  const assigned = mapLegacyBook({ sheets, registry }).candidates.filter(row => row.displayName === 'TEST Same Name');
  assert.equal(new Set(assigned.map(row => row.identity.studentId)).size, 3);
  // A cross-section link is allowed only through an explicit matching ID/label.
  registry[2].studentId = registry[0].studentId;
  registry[2].distinguishingLabel = registry[0].distinguishingLabel;
  const linked = mapLegacyBook({ sheets, registry }).candidates.filter(row => row.displayName === 'TEST Same Name');
  assert.equal(linked[2].identity.studentId, linked[0].identity.studentId);
});

test('row movement retains assigned identity and reports changed references without updating the registry', () => {
  const sheets = fixture();
  const first = candidate(mapLegacyBook({ sheets }), 'TEST Blue');
  const registry = [createLegacyBinding(first, { studentId: 'TEST-STABLE-BLUE', distinguishingLabel: 'TEST blue group' })];
  const oldRegistry = structuredClone(registry);
  sheets.find(sheet => sheet.name === 'Blue Belt').rows.splice(1, 0, []);
  const moved = candidate(mapLegacyBook({ sheets, registry }), 'TEST Blue');
  assert.equal(moved.identity.studentId, 'TEST-STABLE-BLUE');
  assert.equal(moved.identity.sourceMoved, true);
  assert.equal(moved.identity.previousSourceRef, "'Blue Belt'!A2:K2");
  assert.equal(moved.sourceRef, "'Blue Belt'!A3:K3");
  assert.equal(moved.sourceFingerprint, first.sourceFingerprint);
  assert.deepEqual(registry, oldRegistry);
});

test('changed source content never falls back to name matching or reuses a stale positional identity', () => {
  const sheets = fixture();
  const first = candidate(mapLegacyBook({ sheets }), 'TEST Blue');
  const registry = [createLegacyBinding(first, { studentId: 'TEST-STABLE-BLUE', distinguishingLabel: 'TEST blue group' })];
  sheets.find(sheet => sheet.name === 'Blue Belt').rows[1][1] = '2 stripes';
  const result = mapLegacyBook({ sheets, registry });
  assert.equal(candidate(result, 'TEST Blue').identity.status, 'needs_assignment');
  assert.equal(result.unmatchedBindings.length, 1);
  assert.equal(result.unmatchedBindings[0].studentId, 'TEST-STABLE-BLUE');
});

test('indistinguishable source duplicates and conflicting bindings are flagged instead of merged', () => {
  const sheets = fixture();
  const row = sheets.find(sheet => sheet.name === 'Blue Belt').rows[1];
  const first = candidate(mapLegacyBook({ sheets }), 'TEST Blue');
  const binding = createLegacyBinding(first, { studentId: 'TEST-STABLE-BLUE', distinguishingLabel: 'TEST blue group' });
  const conflict = mapLegacyBook({ sheets, registry: [binding, { ...binding, studentId: 'TEST-DIFFERENT-ID' }] });
  assert.equal(candidate(conflict, 'TEST Blue').identity.status, 'needs_resolution');
  sheets.find(sheet => sheet.name === 'Blue Belt').rows.push(structuredClone(row));
  const duplicated = mapLegacyBook({ sheets, registry: [binding] });
  assert.ok(duplicated.candidates.filter(item => item.displayName === 'TEST Blue').every(item => item.identity.status === 'needs_resolution'));
  assert.throws(() => createLegacyBinding(candidate(duplicated, 'TEST Blue'), { studentId: 'TEST-ID', distinguishingLabel: 'TEST label' }), /unique source/);
  assert.equal(candidate(duplicated, 'TEST White').currentRank.known, true);
});

test('native formulas and displayed text are inert source evidence; formatting/trailing blank changes do not change identity', () => {
  const sheets = fixture();
  const white = sheets.find(sheet => sheet.name === 'White Belt');
  white.rows[1][2] = { userEnteredValue: { formulaValue: '="TEST Instructor"' }, effectiveValue: { stringValue: 'TEST Instructor' }, formattedValue: 'TEST Instructor' };
  const first = candidate(mapLegacyBook({ sheets }), 'TEST White');
  const registry = [createLegacyBinding(first, { studentId: 'TEST-FORMATTED-WHITE', distinguishingLabel: 'TEST formatted source' })];
  assert.equal(first.items[2].type, 'formula');
  assert.equal(first.items[2].formula, '="TEST Instructor"');
  assert.equal(first.items[2].role, 'instructor');
  white.rows[1][2].formattedValue = 'TEST display-only variation';
  white.rows[1].push(null, null);
  const second = candidate(mapLegacyBook({ sheets, registry }), 'TEST White');
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
  assert.equal(second.identity.sourceMoved, false);
  assert.equal(second.identity.studentId, 'TEST-FORMATTED-WHITE');
  assert.equal(second.items[2].display, 'TEST display-only variation');
});

test('mapping never mutates matrices/registry, creates promotion events, or loses typed false/zero', () => {
  const sheets = fixture();
  const before = structuredClone(sheets);
  const result = mapLegacyBook({ sheets });
  assert.deepEqual(sheets, before);
  assert.equal('events' in result, false);
  assert.equal(describeLegacyCell({ effectiveValue: { boolValue: false }, formattedValue: 'FALSE' }).value, false);
  assert.equal(describeLegacyCell({ userEnteredValue: { numberValue: 0 }, formattedValue: '0' }).value, 0);
  assert.equal(describeLegacyCell(nativeText("'TEST literal reference")).value, "'TEST literal reference");
  assert.throws(() => mapLegacyBook({ sheets, registry: [{ studentId: 'TEST-ID' }] }), /Registry entries/);
});

test('unknown block layouts and orphan content remain inspectable without gating known records', () => {
  const sheets = fixture();
  sheets.find(sheet => sheet.name === 'Blue Belt').rows.push(['Name', 'Unrecognized heading'], ['TEST Unmapped', '2 stripes']);
  const result = mapLegacyBook({ sheets });
  assert.equal(candidate(result, 'TEST Unmapped').currentRank.known, false);
  assert.ok(candidate(result, 'TEST Unmapped').issues.includes('unrecognized_header'));
  assert.equal(candidate(result, 'TEST Unmapped').items[1].value, '2 stripes');
  assert.equal(candidate(result, 'TEST White').currentRank.known, true);
});

test('native note-only cells survive as orphan evidence and note edits invalidate a reviewed binding', () => {
  const sheets = fixture();
  const blue = sheets.find(sheet => sheet.name === 'Blue Belt');
  blue.rows.push(['', '', { note: 'TEST source annotation without a student' }]);
  let result = mapLegacyBook({ sheets });
  assert.equal(result.orphanItems.find(item => item.ref === "'Blue Belt'!C3").raw.note, 'TEST source annotation without a student');
  const first = candidate(result, 'TEST Blue');
  const registry = [createLegacyBinding(first, { studentId: 'TEST-NOTE-BINDING', distinguishingLabel: 'TEST source note' })];
  blue.rows[1][5].note = 'TEST changed provenance statement';
  result = mapLegacyBook({ sheets, registry });
  assert.equal(candidate(result, 'TEST Blue').identity.status, 'needs_assignment');
  assert.equal(result.unmatchedBindings.length, 1);
});

test('historical layout cues never authorize reading an unlabeled or differently labeled B as current rank', () => {
  const sheets = fixture();
  for (const name of ['White Belt', 'Blue Belt', 'Purple Belt', 'Brown Belt']) {
    const sheet = sheets.find(item => item.name === name);
    sheet.rows[0] = [...sheet.rows[0]];
    sheet.rows[0][1] = 'TEST unrelated note';
  }
  const result = mapLegacyBook({ sheets });
  for (const name of ['TEST White', 'TEST Blue', 'TEST Purple', 'TEST Brown']) {
    assert.equal(candidate(result, name).currentRank.known, false);
    assert.ok(candidate(result, name).issues.includes('unrecognized_header'));
  }
  assert.equal(candidate(result, 'TEST Explicit Degree').currentRank.known, true);
});

test('explicit native zero and integer counts use verified column units; date serials never become stripe counts', () => {
  const sheets = fixture();
  const white = sheets.find(sheet => sheet.name === 'White Belt');
  white.rows.push(['TEST Numeric Zero', { userEnteredValue: { numberValue: 0 }, formattedValue: '0' }]);
  white.rows.push(['TEST Native Date In Rank', nativeDate()]);
  sheets.find(sheet => sheet.name === 'Black Belt').rows.push(['TEST Numeric Degree', '', '', 6]);
  const result = mapLegacyBook({ sheets });
  assert.deepEqual([candidate(result, 'TEST Numeric Zero').currentRank.known, candidate(result, 'TEST Numeric Zero').currentRank.marks], [true, 0]);
  assert.equal(candidate(result, 'TEST Numeric Degree').currentRank.marks, 6);
  assert.equal(candidate(result, 'TEST Numeric Degree').currentRank.markType, 'degrees');
  assert.equal(candidate(result, 'TEST Native Date In Rank').currentRank.known, false);
});
