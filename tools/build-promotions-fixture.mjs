import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

// Synthetic fixture only. Run with the bundled artifact runtime.
// Destination IDs belong in private runtime configuration, never in this file.
export const STUDENT_HEADERS = [
  'student_id', 'display_name', 'distinguishing_label', 'status',
  'rank_known', 'belt', 'marks', 'mark_type', 'revision',
  'last_event_id', 'legacy_refs', 'history_note',
];
export const HISTORY_HEADERS = [
  'event_id', 'request_id', 'student_id', 'revision', 'event_kind',
  'event_date_ny', 'recorded_at_utc', 'display_name', 'distinguishing_label',
  'before_status', 'after_status', 'before_rank_known', 'before_belt',
  'before_marks', 'before_mark_type', 'after_rank_known', 'after_belt',
  'after_marks', 'after_mark_type', 'approver_id', 'approver_label',
  'recorder_identity', 'corrects_event_id', 'reason', 'legacy_refs',
  'history_note', 'payload_fingerprint',
];
export const WORKBOOK_TITLE = 'GYM IN A BOX Promotions — PRIVATE SYNTHETIC TEST';
export const TIME_ZONE = 'America/New_York';

const rank = (belt, marks) => ({ rank_known: true, belt, marks, mark_type: belt === 'Black Belt' ? 'degrees' : 'stripes' });
const seeds = [
  ['TEST Alex Example', 'Blue group', 'active', rank('Blue Belt', 1), "'Blue Belt'!A2:K2", 'Synthetic history: native date, literal date text, blank, ? and Transplant.'],
  ['TEST Jordan Example', 'Morning group', 'active', rank('White Belt', 0), "'White Belt'!A2:G2", 'Synthetic zero-stripe baseline; historical dates and instructor blank.'],
  ['TEST Jordan Example', 'Evening group', 'active', rank('White Belt', 2), "'White Belt'!A3:G3", 'Separate synthetic student with the same name; first-stripe date ?.'],
  ['TEST Casey Example', 'Rank unconfirmed', 'active', { rank_known: false, belt: '', marks: '', mark_type: '' }, "'Purple Belt'!A4:Q4", 'Synthetic source says ?; tab placement is not a verified rank.'],
  ['TEST Taylor Example', 'Black group', 'active', rank('Black Belt', 5), "'Black Belt'!A2:M2", 'Synthetic black-belt baseline is 5 degrees; original annotation Early 2014.'],
  ['TEST Rowan Example', 'Purple group', 'active', rank('Purple Belt', 4), "'Purple Belt'!A2:Q2", 'Synthetic prior Blue Belt history remains intact through a belt change.'],
  ['TEST Ellis Example', 'Brown group', 'active', rank('Brown Belt', 1), "'Brown Belt'!A2:L2", 'Synthetic legacy belt date is Transplant; several earlier dates remain blank.'],
  ['TEST Morgan Example', 'Former student', 'archived', rank('Brown Belt', 2), "'Former student'!A2:N6", 'Synthetic archived record with embedded historical headers and a blank current date.'],
];
const blankEvent = () => Object.fromEntries(HISTORY_HEADERS.map(h => [h, '']));
export function buildFixture(recordedAt = new Date().toISOString()) {
  const history = seeds.map(([display_name, distinguishing_label, status, currentRank, legacy_refs, history_note], index) => {
    const suffix = String(index + 1).padStart(3, '0');
    return {
      ...blankEvent(),
      event_id: 'fixture-event-' + suffix,
      request_id: 'fixture-request-' + suffix,
      student_id: 'fixture-student-' + suffix,
      revision: 1,
      event_kind: 'REGISTER',
      recorded_at_utc: recordedAt,
      display_name, distinguishing_label,
      after_status: status,
      after_rank_known: currentRank.rank_known,
      after_belt: currentRank.belt,
      after_marks: currentRank.marks,
      after_mark_type: currentRank.mark_type,
      recorder_identity: 'SYNTHETIC FIXTURE',
      reason: 'Synthetic legacy baseline; promotion date unknown',
      legacy_refs, history_note,
    };
  });
  const students = history.map(event => ({
    student_id: event.student_id,
    display_name: event.display_name,
    distinguishing_label: event.distinguishing_label,
    status: event.after_status,
    rank_known: event.after_rank_known,
    belt: event.after_belt,
    marks: event.after_marks,
    mark_type: event.after_mark_type,
    revision: event.revision,
    last_event_id: event.event_id,
    legacy_refs: event.legacy_refs,
    history_note: event.history_note,
  }));
  const date = value => new Date(value + 'T12:00:00.000Z');
  const legacy = [
    {
      name: 'Black Belt',
      rows: [
        ['Name', '', 'Date', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Black Belt', '4 stripes', '3 stripes', '2 stripes', '1 stripe'],
        ['TEST Taylor Example', '', '', '5 degrees', date('2021-02-12'), 'November 2017', '', '?', 'Early 2014', '', '', '', ''],
      ],
    },
    {
      name: 'Brown Belt',
      rows: [
        ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt'],
        ['TEST Ellis Example', '1 stripes', '', '', '', date('2024-06-15'), 'Transplant', '?', '', '', '', ''],
      ],
    },
    {
      name: 'Purple Belt',
      rows: [
        ['Name', 'Current Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', 'Blue 4 stripes', '3 stripes', '', '', 'Blue belt', '', '', '', '', 'How they started?'],
        ['TEST Rowan Example', '4 stripes', date('2024-07-01'), '?', 'Spring 2022', '', '06/05/2021', '4 stripes', date('2020-02-03'), '', 'March 2018', '', '', '', '', '', 'Transplant'],
        [],
        ['TEST Casey Example', '?', '', '', '', '', 'Early 2014', '', '', '', '', '', '', '', '', '', 'Rank unconfirmed'],
      ],
    },
    {
      name: 'Blue Belt',
      rows: [
        ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', '4th White', '3rd White', '2nd White'],
        ['TEST Alex Example', '1 stripe', '', '', '', date('2024-05-21'), '06/05/2023', 'Transplant', '?', '', 'March 2018'],
      ],
    },
    {
      name: 'White Belt',
      rows: [
        ['Name', 'Current Rank awarded', 'Instructor', '4 stripes', '3 stripes', '2 stripes', '1 stripe'],
        ['TEST Jordan Example', '0 stripe', '', '', '', '', ''],
        ['TEST Jordan Example', '2 stripe', '', '', '', date('2024-05-12'), '?'],
      ],
    },
    {
      name: 'Former student',
      rows: [
        ['Name', '', 'Date', 'Rank awarded', '3 stripes', '2 stripes', '1 stripe', '', '4th Brown', '3rd Brown', '2nd Brown'],
        ['TEST Morgan Example', '', '', '2 stripes', '', date('2022-03-09'), '?', '', '', '', '', '', '', ''],
        [],
        ['Name', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Belt', '4th purple'],
        ['TEST Morgan Example', 'Belt', '', '', '', '', 'Transplant', 'Early 2014'],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', 'Historical annotation preserved.'],
      ],
    },
  ];
  return { title: WORKBOOK_TITLE, timeZone: TIME_ZONE, recordedAt, studentHeaders: STUDENT_HEADERS, historyHeaders: HISTORY_HEADERS, students, history, legacy };
}

const letters = number => {
  let output = '';
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) output = String.fromCharCode(65 + ((value - 1) % 26)) + output;
  return output;
};
function writeSheet(workbook, name, rows, isRegistry = false) {
  const sheet = workbook.worksheets.add(name);
  const width = Math.max(...rows.map(row => row.length));
  const matrix = rows.map(row => Array.from({ length: width }, (_, i) => row[i] ?? null));
  const used = sheet.getRange('A1:' + letters(width) + matrix.length);
  // Preserve literal legacy date strings as text. Real Date objects and
  // numeric counts receive their explicit formats below.
  used.setNumberFormat('@');
  used.values = matrix;
  used.format.font = { name: 'Arial', size: 11, color: '#111827' };
  used.format.verticalAlignment = 'center';
  used.format.wrapText = true;
  used.format.rowHeight = isRegistry ? 56 : 38;
  used.format.columnWidth = isRegistry ? 22 : 19;
  const header = sheet.getRange('A1:' + letters(width) + '1');
  header.format.fill = '#F3F4F6';
  header.format.font = { name: 'Arial', size: 11, bold: true, color: '#111827' };
  header.format.rowHeight = 42;
  sheet.getRange('A1:A' + matrix.length).format.columnWidth = isRegistry ? 29 : 29;
  if (isRegistry) {
    rows[0].forEach((heading, index) => {
      const range = sheet.getRange(letters(index + 1) + '1:' + letters(index + 1) + matrix.length);
      if (/(display_name|distinguishing_label)/.test(heading)) range.format.columnWidth = 28;
      if (/(legacy_refs|history_note|reason)/.test(heading)) range.format.columnWidth = 48;
      if (heading === 'recorded_at_utc') range.format.columnWidth = 29;
      if (/(^revision$|^marks$|_marks$)/.test(heading)) range.setNumberFormat('0');
    });
  }
  matrix.forEach((row, r) => row.forEach((value, c) => {
    if (value instanceof Date) sheet.getRange(letters(c + 1) + (r + 1)).setNumberFormat('m/d/yyyy');
  }));
  sheet.freezePanes.freezeRows(1);
  if (isRegistry) sheet.freezePanes.freezeColumns(1);
  sheet.showGridLines = true;
  return sheet;
}

export async function writeFixture(outputDir, recordedAt) {
  const fixture = buildFixture(recordedAt);
  assert.equal(fixture.students.length, 8);
  assert.equal(new Set(fixture.students.map(s => s.student_id)).size, 8);
  assert.equal(fixture.students.filter(s => s.display_name === 'TEST Jordan Example').length, 2);
  assert.equal(fixture.students[3].rank_known, false);
  assert.equal(fixture.students[3].marks, '');
  assert.equal(fixture.students[4].marks, 5);
  assert.equal(fixture.students[4].mark_type, 'degrees');
  assert.equal(fixture.students[7].status, 'archived');
  fixture.history.forEach(event => {
    assert.equal(event.event_date_ny, '');
    assert.equal(event.approver_id, '');
    assert.equal(event.approver_label, '');
  });
  const workbook = Workbook.create();
  writeSheet(workbook, 'Students', [STUDENT_HEADERS, ...fixture.students.map(s => STUDENT_HEADERS.map(h => s[h]))], true);
  writeSheet(workbook, 'Promotion History', [HISTORY_HEADERS, ...fixture.history.map(e => HISTORY_HEADERS.map(h => e[h]))], true);
  fixture.legacy.forEach(sheet => writeSheet(workbook, sheet.name, sheet.rows));
  workbook.recalculate();
  await fs.mkdir(outputDir, { recursive: true });
  const scans = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 30 }, maxChars: 2000 });
  await fs.writeFile(path.join(outputDir, 'fixture-formula-scan.jsonl'), scans.ndjson);
  for (const name of ['Students', 'Promotion History', ...fixture.legacy.map(s => s.name)]) {
    const ranges = name === 'Students' ? ['A1:F9', 'G1:L9'] :
      name === 'Promotion History' ? ['A1:I9', 'J1:R9', 'S1:AA9'] :
        [name === 'Purple Belt' ? 'A1:Q4' : name === 'Former student' ? 'A1:N6' : 'A1:M3'];
    for (let index = 0; index < ranges.length; index++) {
      const preview = await workbook.render({ sheetName: name, range: ranges[index], scale: 1.5, format: 'png' });
      await fs.writeFile(path.join(outputDir, name.replaceAll(' ', '-').toLowerCase() + '-' + (index + 1) + '.png'), new Uint8Array(await preview.arrayBuffer()));
    }
  }
  const output = await SpreadsheetFile.exportXlsx(workbook);
  const xlsxPath = path.join(outputDir, 'promotions-synthetic-fixture.xlsx');
  await output.save(xlsxPath);
  // The artifact exporter normalizes ISO timestamp strings. On native
  // import, restore History G2:G9 from fixture.history via stringValue and
  // set the spreadsheet timezone to TIME_ZONE. Neither change touches the
  // six legacy source tabs. The JSON manifest retains the exact contract.
  await fs.writeFile(path.join(outputDir, 'synthetic-fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify({ xlsxPath, sheetCount: 8, students: 8, baselineEvents: 8, title: WORKBOOK_TITLE, timeZone: TIME_ZONE, nativeFinishingRequired: ['America/New_York timezone', 'exact ISO History timestamp strings from manifest'] }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = path.resolve(process.argv[2] || 'work/promotions-fixture');
  await writeFixture(outputDir, process.argv[3]);
}
