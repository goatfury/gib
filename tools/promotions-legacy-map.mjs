import { createHash } from 'node:crypto';

// Pure mapping preparation. This module has no file, network, or workbook writes.
export const LEGACY_SHEET_NAMES = Object.freeze([
  'Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student',
]);

const clone = value => structuredClone(value);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const normalized = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const columnName = index => {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
};
const quotedSheet = name => "'" + name.replaceAll("'", "''") + "'";

/** Preserve a native Sheets CellData object, including literal and displayed dates. */
export function describeLegacyCell(input) {
  const raw = clone(input ?? null);
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new TypeError('Invalid native date');
    return { type: 'date', value: input.toISOString(), display: input.toISOString(), raw };
  }
  if (input === null || input === undefined || input === '') return { type: 'blank', value: '', display: '', raw };
  if (typeof input !== 'object') {
    if (!['string', 'number', 'boolean'].includes(typeof input) || (typeof input === 'number' && !Number.isFinite(input))) {
      throw new TypeError('Unsupported legacy cell value');
    }
    return { type: typeof input, value: input, display: String(input), raw };
  }
  const entered = input.userEnteredValue ?? {};
  const effective = input.effectiveValue ?? entered;
  const stored = 'formulaValue' in entered || !Object.keys(entered).length ? effective : entered;
  let type = 'blank';
  let value = '';
  for (const [key, candidateType] of [['stringValue', 'string'], ['numberValue', 'number'], ['boolValue', 'boolean'], ['errorValue', 'error']]) {
    if (key in stored) { type = candidateType; value = clone(stored[key]); break; }
  }
  if (type === 'number' && ['DATE', 'DATE_TIME', 'TIME'].includes(input.effectiveFormat?.numberFormat?.type ?? input.userEnteredFormat?.numberFormat?.type)) type = 'date_serial';
  if ('formulaValue' in entered) type = 'formula';
  return {
    type, value, display: input.formattedValue ?? (typeof value === 'object' ? '' : String(value)), raw,
    ...('formulaValue' in entered ? { formula: entered.formulaValue } : {}),
  };
}

function headerLayout(cells) {
  const h = cells.map(cell => normalized(cell.value));
  if (h[0] !== 'name') return null;
  if (h[3] === 'rank awarded' && h[2] === 'date') return 'black';
  if (!['rank awarded', 'current rank awarded'].includes(h[1])) return null;
  if (h[2] === 'instructor') return 'white';
  if (h.some(value => value.includes('blue 4') || value === 'blue belt')) return 'purple';
  if (h.some(value => value.includes('4th white') || value.includes('3rd white'))) return 'blue';
  if (h.some(value => value.includes('4th purple'))) return 'brown';
  if (h[1] === 'rank awarded' && h[6] === 'belt' && h[11] === 'belt') return 'brown';
  return null;
}

const rankColumn = layout => layout === 'unknown' ? null : layout === 'black' ? 3 : 1;
function sourceMetadata(cell) {
  const result = {};
  for (const key of ['note', 'hyperlink', 'chipRuns']) {
    const value = cell.raw?.[key];
    if (value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) result[key] = clone(value);
  }
  return result;
}
const hasContent = cells => cells.some(cell => cell.type !== 'blank' || cell.display !== '' || Object.keys(sourceMetadata(cell)).length > 0);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthNumber = text => MONTHS.findIndex(name => name === text || name.slice(0, 3) === text.replace(/\.$/, '')) + 1;
const calendarDate = (year, month, day) => {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isInteger(year) && year >= 1000 && year <= 9999 && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
};

/** Interpret only recognized date forms. Raw values remain in candidate.items. */
export function interpretLegacyAwardDate(item, { asOfDateNY = '' } = {}) {
  const sourceText = String(item?.display ?? item?.value ?? '').trim();
  const base = { known: false, value: '', precision: 'missing', sourceText, evidenceRef: item?.ref ?? '', reason: 'date_not_recorded', supportsAward: false };
  const uncertain = (precision, reason, supportsAward = true) => ({ ...base, precision, reason, supportsAward });
  const exact = value => !value ? uncertain('invalid', 'invalid_calendar_date', false)
    : asOfDateNY && value > asOfDateNY ? uncertain('invalid', 'future_source_date', false)
      : { ...base, known: true, value, precision: 'day', reason: '', supportsAward: true };
  if (!item || !String(item.value ?? '').trim()) return base;
  if (item.type === 'date') return exact(String(item.value).slice(0, 10));
  if (item.type === 'date_serial') {
    const format = item.raw?.effectiveFormat?.numberFormat ?? item.raw?.userEnteredFormat?.numberFormat ?? {};
    if (format.type === 'TIME') return uncertain('annotation', 'time_is_not_an_award_date', false);
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(item.value) * 86400000);
    if (!Number.isFinite(item.value) || Number.isNaN(date.getTime())) return uncertain('invalid', 'invalid_native_date', false);
    const value = date.toISOString().slice(0, 10);
    if (asOfDateNY && value > asOfDateNY) return uncertain('invalid', 'future_source_date', false);
    // Sheets can store a hidden first day for a displayed month/year. The book
    // did not show an exact award day; never manufacture it from that serial.
    const pattern = String(format.pattern ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
    if (pattern && !pattern.includes('d')) return uncertain(pattern.includes('m') ? 'month' : 'year', 'source_date_has_no_day');
    return exact(value);
  }
  if (item.type !== 'string') return uncertain('annotation', 'not_a_literal_award_date', false);
  const text = normalized(item.value);
  if (/^\?+$/.test(text)) return uncertain('uncertain', 'source_date_unknown', false);
  let match;
  if ((match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return exact(calendarDate(+match[1], +match[2], +match[3]));
  if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\.?$/))) return exact(calendarDate(+match[3], +match[1], +match[2]));
  if ((match = text.match(/^([a-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/)) && monthNumber(match[1])) return exact(calendarDate(+match[3], monthNumber(match[1]), +match[2]));
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(text)) return uncertain('uncertain', 'two_digit_year_requires_resolution');
  if (/^(?:early|mid|late|about|circa)\s+\d{4}$/.test(text)) return uncertain('approximate', 'approximate_source_date');
  if ((match = text.match(/^([a-z]+\.?)\s+(\d{4})(\?)?$/)) && monthNumber(match[1])) return uncertain(match[3] ? 'uncertain' : 'month', match[3] ? 'uncertain_source_date' : 'source_date_has_no_day');
  if (/^(?:0?[1-9]|1[0-2])\/\d{4}$/.test(text)) return uncertain('month', 'source_date_has_no_day');
  if (/^\d{4}$/.test(text)) return uncertain('year', 'source_date_has_no_day');
  if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\?$/))) return calendarDate(+match[3], +match[1], +match[2]) ? uncertain('uncertain', 'uncertain_source_date') : uncertain('invalid', 'invalid_calendar_date', false);
  if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\(belt\)$/))) return { ...exact(calendarDate(+match[3], +match[1], +match[2])), annotation: 'Belt' };
  // Transplant can date arrival while already holding the rank. Preserve the
  // recorded date text without treating it as an original promotion date.
  if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\(transplant\)$/))) return calendarDate(+match[3], +match[1], +match[2]) ? uncertain('annotated', 'annotated_date_requires_resolution') : uncertain('invalid', 'invalid_calendar_date', false);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}\s*,\s*\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return uncertain('conflicting', 'multiple_dates_require_resolution');
  return uncertain('annotation', 'annotation_does_not_establish_award', false);
}

// Column bounds are explicit per documented layout. Repeated labels to the
// right describe earlier belts and must never count toward this belt's rank.
function currentAwardColumns(candidate) {
  const start = candidate.layout === 'black' ? 4 : candidate.layout === 'white' ? 3 : 2;
  const end = candidate.layout === 'black' ? 8 : 6;
  return candidate.items.filter(item => item.column - 1 >= start && item.column - 1 <= end).flatMap(item => {
    const header = normalized(item.header);
    const match = header.match(/^(\d+)\s+stripes?$/);
    const marks = match ? +match[1] : (header === 'belt' || header === normalized(candidate.sheetName)) ? 0 : null;
    return marks === null ? [] : [{ item, marks }];
  });
}

function rankCandidate(candidate, { asOfDateNY }) {
  const summary = candidate.items.find(item => item.role === 'current_rank');
  const missingDate = interpretLegacyAwardDate(null);
  const unknown = (reason, evidenceRefs = [summary?.ref].filter(Boolean), conflicts = []) => ({
    known: false, belt: '', marks: null, markType: '', evidenceRef: evidenceRefs[0] ?? '', evidenceRefs,
    date: missingDate, requiresAuditedResolution: true, reason, conflicts, interpretation: reason,
  });
  if (candidate.status === 'archived') return unknown('archived_block_does_not_establish_current_belt');
  if (candidate.issues.includes('unrecognized_header') || candidate.issues.includes('layout_mismatch')) return unknown('unrecognized_current_rank_layout');
  const text = normalized(summary?.value);
  const label = candidate.layout === 'black' ? /^(\d+)\s+degrees?$/ : /^(\d+)\s+stripes?$/;
  const match = summary?.type === 'string' ? text.match(label) : null;
  const numeric = summary?.type === 'number' && Number.isSafeInteger(summary.value) && summary.value >= 0;
  const summaryMarks = numeric ? summary.value : match ? +match[1] : null;
  const isBaseSummary = summary?.type === 'string' && ['belt', normalized(candidate.sheetName)].includes(text);
  const columns = currentAwardColumns(candidate).map(({ item, marks }) => {
    const date = interpretLegacyAwardDate(item, { asOfDateNY });
    const explicitBase = marks === 0 && item.type === 'string' && ['belt', normalized(candidate.sheetName)].includes(normalized(item.value));
    return { item, marks, date, supported: date.supportsAward || explicitBase };
  });
  const awards = columns.filter(item => item.supported).sort((a, b) => b.marks - a.marks);
  const highest = awards[0];
  const conflicts = [];
  // A bare "Belt" is not an explicit zero-mark assertion. It cannot conflict
  // with a positive labeled stripe award, nor establish zero without evidence.
  const statedMarks = summaryMarks;
  if (statedMarks !== null && highest && highest.marks > statedMarks) conflicts.push({
    code: 'summary_conflicts_with_labeled_award', evidenceRefs: [summary.ref, highest.item.ref],
    summaryMarks: statedMarks, awardMarks: highest.marks,
  });
  const historicalConflicts = [];
  const selectedMarks = summaryMarks ?? highest?.marks;
  for (const upper of awards) for (const lower of awards) {
    if (upper.marks > lower.marks && upper.date.known && lower.date.known && upper.date.value < lower.date.value) conflicts.push({
      code: 'award_chronology_conflict', evidenceRefs: [upper.item.ref, lower.item.ref],
    });
  }
  // A contradiction confined to older, lower marks does not erase a later
  // independently recorded current award. Retain it as historical uncertainty.
  for (let i = conflicts.length - 1; i >= 0; i--) {
    if (conflicts[i].code === 'award_chronology_conflict' && !conflicts[i].evidenceRefs.includes(awards.find(award => award.marks === selectedMarks)?.item.ref)) {
      historicalConflicts.unshift(...conflicts.splice(i, 1));
    }
  }
  if (conflicts.length) return unknown('conflicting_source_rank', [...new Set(conflicts.flatMap(conflict => conflict.evidenceRefs))], conflicts);
  // A genuinely explicit summary outranks older lower-mark source awards, but
  // a blank/?/arbitrary label cannot invalidate a recoverable labeled award.
  const marks = summaryMarks ?? highest?.marks;
  if (!Number.isSafeInteger(marks)) return unknown(text === '?' ? 'current_rank_unknown' : !text ? 'current_rank_blank' : 'current_rank_label_requires_resolution');
  const award = awards.find(item => item.marks === marks);
  const sameColumn = columns.find(item => item.marks === marks);
  let date = award?.date ?? sameColumn?.date ?? missingDate;
  const evidenceRefs = [...new Set([...(summaryMarks !== null || isBaseSummary ? [summary.ref] : []), ...(award ? [award.item.ref] : [])])];
  // The separate Black Date cell only dates an explicit D summary; it has no
  // authority to date a rank inferred from a different award column.
  if (candidate.layout === 'black' && summaryMarks !== null) {
    const summaryDate = interpretLegacyAwardDate(candidate.items[2], { asOfDateNY });
    if (summaryDate.known && date.known && summaryDate.value !== date.value) date = { ...date, known: false, value: '', precision: 'conflicting', reason: 'summary_and_award_dates_conflict' };
    else if (summaryDate.supportsAward && !date.supportsAward) date = summaryDate;
    if (summaryDate.supportsAward) evidenceRefs.push(candidate.items[2].ref);
  }
  return {
    known: true, belt: candidate.sheetName, marks, markType: candidate.layout === 'black' ? 'degrees' : 'stripes',
    evidenceRef: award?.item.ref ?? summary.ref, evidenceRefs, date,
    requiresAuditedResolution: false, reason: '', conflicts: [], historicalConflicts,
    interpretation: award ? `Labeled ${award.item.header} in the current ${candidate.sheetName} block${summaryMarks !== null ? ' agrees with the explicit rank summary' : ''}.` : 'Explicit current-rank summary; no exact matching award date is established.',
  };
}

function cellRole(layout, column) {
  if (column === 0) return 'name';
  if (layout === 'black' && column === 1) return 'surname';
  if (column === rankColumn(layout)) return 'current_rank';
  if (layout === 'white' && column === 2) return 'instructor';
  return 'history';
}

function sourceItems(sheetName, row, cells, header, layout, width) {
  return Array.from({ length: width }, (_, column) => {
    const cell = cells[column] ?? describeLegacyCell(null);
    const headerCell = header[column] ?? describeLegacyCell(null);
    return {
      ...clone(cell), header: headerCell.display, headerCell: clone(headerCell),
      column: column + 1, ref: `${quotedSheet(sheetName)}!${columnName(column)}${row}`,
      role: cellRole(layout, column), unlabeled: headerCell.display === '',
    };
  });
}

function meaningfulIdentityCell(cell) {
  const metadata = sourceMetadata(cell);
  return {
    type: cell.type, value: cell.value, ...(cell.formula ? { formula: cell.formula } : {}),
    ...(Object.keys(metadata).length ? { sourceMetadata: metadata } : {}),
  };
}

function identityCells(cells) {
  const result = cells.map(meaningfulIdentityCell);
  // Native rowData can omit trailing empty cells in otherwise identical reads.
  while (result.length && result.at(-1).type === 'blank' && !result.at(-1).sourceMetadata) result.pop();
  return result;
}

/**
 * Input sheets: {name, rows: Array<Array<Sheets CellData | primitive>>}.
 * Registry: explicit {studentId, distinguishingLabel, sourceFingerprint, sourceRef}.
 * Returns candidates and preserved source items. It creates no IDs or events.
 */
export function mapLegacyBook({ sheets, registry = [], asOfDateNY = '' }) {
  if (!Array.isArray(sheets) || !Array.isArray(registry)) throw new TypeError('sheets and registry must be arrays');
  if (asOfDateNY && (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDateNY) || !calendarDate(...asOfDateNY.split('-').map(Number)))) throw new TypeError('asOfDateNY must be an exact valid date');
  const candidates = [];
  const blocks = [];
  const orphanItems = [];
  const issues = [];
  const seenSheets = new Set();
  for (const sheet of sheets) {
    if (!sheet || !LEGACY_SHEET_NAMES.includes(sheet.name) || !Array.isArray(sheet.rows)) {
      issues.push({ code: 'unsupported_sheet_input', sheetName: sheet?.name ?? '' });
      continue;
    }
    if (seenSheets.has(sheet.name)) throw new TypeError('Duplicate sheet name');
    seenSheets.add(sheet.name);
    let block = null;
    for (const [index, row] of sheet.rows.entries()) {
      if (!Array.isArray(row)) throw new TypeError('Each source row must be an array');
      const cells = row.map(describeLegacyCell);
      const rowNumber = index + 1;
      if (normalized(cells[0]?.value) === 'name') {
        const layout = headerLayout(cells);
        block = { sheetName: sheet.name, headerRow: rowNumber, layout: layout ?? 'unknown', header: cells };
        blocks.push(clone(block));
        continue;
      }
      if (!hasContent(cells)) continue;
      if (!block) {
        issues.push({ code: 'row_without_header', sheetName: sheet.name, row: rowNumber });
        orphanItems.push(...sourceItems(sheet.name, rowNumber, cells, [], 'unknown', cells.length));
        continue;
      }
      const width = Math.max(cells.length, block.header.length);
      const referenceWidth = Math.max(identityCells(cells).length, identityCells(block.header).length);
      const items = sourceItems(sheet.name, rowNumber, cells, block.header, block.layout, width);
      const nameCell = cells[0] ?? describeLegacyCell(null);
      if (nameCell.type === 'blank' || !String(nameCell.value).trim()) {
        orphanItems.push(...items);
        issues.push({ code: 'annotation_without_student', sheetName: sheet.name, row: rowNumber });
        continue;
      }
      const candidate = {
        sheetName: sheet.name, sourceRow: rowNumber, sourceRef: `${quotedSheet(sheet.name)}!A${rowNumber}:${columnName(referenceWidth - 1)}${rowNumber}`,
        headerRef: `${quotedSheet(sheet.name)}!A${block.headerRow}:${columnName(identityCells(block.header).length - 1)}${block.headerRow}`,
        layout: block.layout, displayName: String(nameCell.value), status: sheet.name === 'Former student' ? 'archived' : 'active',
        items, issues: [],
      };
      if (block.layout === 'unknown') candidate.issues.push('unrecognized_header');
      if (sheet.name !== 'Former student' && block.layout !== normalized(sheet.name).split(' ')[0]) candidate.issues.push('layout_mismatch');
      // Coordinates and display formatting are excluded so row moves retain the
      // binding. Changed content/headers cannot silently inherit an old identity.
      candidate.sourceFingerprint = fingerprint({
        sheet: sheet.name, layout: block.layout,
        header: identityCells(block.header), cells: identityCells(cells),
      });
      // Only the documented Black layout (including its archived block) has a
      // split name in A/B. Preserve all other A-only names verbatim. This derived
      // display repair does not enter the historical content fingerprint.
      const surname = cells[1];
      const blackRankMarker = /^(?:black\s+)?belt$|^\?+$|^\d+\s+(?:degrees?|stripes?)$/.test(normalized(surname?.value));
      if (block.layout === 'black' && normalized(block.header[1]?.value) === '' && surname?.type === 'string' && String(surname.value).trim() && !blackRankMarker) {
        candidate.displayName = `${String(nameCell.value).trim()} ${String(surname.value).trim()}`;
        candidate.nameEvidence = { interpretation: 'documented_black_split_name', evidenceRefs: [items[0].ref, items[1].ref] };
      } else {
        candidate.nameEvidence = { interpretation: block.layout === 'black' && blackRankMarker ? 'complete_black_name_with_b_rank_marker' : 'complete_name_in_column_a', evidenceRefs: [items[0].ref, ...(block.layout === 'black' && blackRankMarker ? [items[1].ref] : [])] };
      }
      candidate.currentRank = rankCandidate(candidate, { asOfDateNY });
      candidates.push(candidate);
    }
  }
  for (const name of LEGACY_SHEET_NAMES) if (!seenSheets.has(name)) issues.push({ code: 'source_sheet_missing', sheetName: name });
  const sourceCounts = new Map();
  for (const candidate of candidates) sourceCounts.set(candidate.sourceFingerprint, (sourceCounts.get(candidate.sourceFingerprint) ?? 0) + 1);
  const validRegistry = registry.map(entry => {
    if (!entry || ![entry.studentId, entry.distinguishingLabel, entry.sourceFingerprint, entry.sourceRef].every(value => typeof value === 'string' && value.trim())) {
      throw new TypeError('Registry entries require explicit student ID, distinguishing label, fingerprint, and source reference');
    }
    return clone(entry);
  });
  const matchedBindings = new Set();
  for (const candidate of candidates) {
    const matches = validRegistry.filter(entry => entry.sourceFingerprint === candidate.sourceFingerprint);
    const unique = new Map(matches.map(entry => [JSON.stringify([entry.studentId, entry.distinguishingLabel, entry.sourceRef]), entry]));
    candidate.identity = { status: 'needs_assignment', studentId: null, distinguishingLabel: null, sourceMoved: false };
    if (sourceCounts.get(candidate.sourceFingerprint) > 1) {
      candidate.identity.status = 'needs_resolution';
      candidate.issues.push('duplicate_source_fingerprint');
    } else if (unique.size > 1) {
      candidate.identity.status = 'needs_resolution';
      candidate.issues.push('conflicting_registry_bindings');
    } else if (unique.size === 1) {
      const binding = [...unique.values()][0];
      candidate.identity = {
        status: 'assigned', studentId: binding.studentId, distinguishingLabel: binding.distinguishingLabel,
        sourceMoved: binding.sourceRef !== candidate.sourceRef, previousSourceRef: binding.sourceRef,
      };
      matchedBindings.add(candidate.sourceFingerprint);
      if (candidate.identity.sourceMoved) candidate.issues.push('source_row_moved');
    }
  }
  return {
    candidates, blocks, orphanItems, issues,
    unmatchedBindings: validRegistry.filter(entry => !matchedBindings.has(entry.sourceFingerprint)).map(entry => ({ ...entry, code: 'source_changed_removed_or_ambiguous' })),
  };
}

/** Prepare an explicit binding for caller review; does not persist a registry. */
export function createLegacyBinding(candidate, { studentId, distinguishingLabel }) {
  if (!candidate?.sourceFingerprint || !candidate.sourceRef || candidate.issues?.includes('duplicate_source_fingerprint')) throw new TypeError('A unique source candidate is required');
  if (![studentId, distinguishingLabel].every(value => typeof value === 'string' && value.trim())) throw new TypeError('Explicit student ID and distinguishing label are required');
  return { studentId, distinguishingLabel, sourceFingerprint: candidate.sourceFingerprint, sourceRef: candidate.sourceRef };
}
