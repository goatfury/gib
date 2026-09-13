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

function rankCandidate(candidate, cells) {
  const evidence = candidate.items.find(item => item.role === 'current_rank');
  const unknown = reason => ({ known: false, belt: '', marks: null, markType: '', evidenceRef: evidence?.ref ?? '', requiresAuditedResolution: true, reason });
  // Former-student headers describe several earlier belt blocks, not a reliable
  // current belt. Preserve those items without inventing a current rank.
  if (candidate.status === 'archived') return unknown('archived_block_does_not_establish_current_belt');
  if (candidate.issues.includes('unrecognized_header') || candidate.issues.includes('layout_mismatch')) return unknown('unrecognized_current_rank_layout');
  if (candidate.layout === 'black' && !String(evidence?.value ?? '').trim()) {
    return unknown(hasContent([cells[1] ?? describeLegacyCell(null)]) ? 'black_unlabeled_column_requires_resolution' : 'current_rank_blank');
  }
  const text = normalized(evidence?.value);
  if (!text || text === '?') return unknown(text === '?' ? 'current_rank_unknown' : 'current_rank_blank');
  const label = candidate.layout === 'black' ? /^(\d+)\s+degrees?$/ : /^(\d+)\s+stripes?$/;
  const match = text.match(label);
  const explicitNumber = evidence?.type === 'number' && Number.isSafeInteger(evidence.value) && evidence.value >= 0;
  const marks = explicitNumber ? evidence.value : match ? Number(match[1]) : null;
  if (!Number.isSafeInteger(marks)) return unknown('current_rank_label_requires_resolution');
  return {
    known: true, belt: candidate.sheetName, marks,
    markType: candidate.layout === 'black' ? 'degrees' : 'stripes',
    evidenceRef: evidence.ref, requiresAuditedResolution: false, reason: '',
  };
}

function cellRole(layout, column) {
  if (column === 0) return 'name';
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
export function mapLegacyBook({ sheets, registry = [] }) {
  if (!Array.isArray(sheets) || !Array.isArray(registry)) throw new TypeError('sheets and registry must be arrays');
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
      candidate.currentRank = rankCandidate(candidate, cells);
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
