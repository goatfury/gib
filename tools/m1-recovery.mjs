#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_SOURCE_SHA256 = 'fb1ae2454974ded9377f714db307e2fdca25439e80fc5cf032917e3fa1637eb3';
export const RECOVERY_INCIDENT_ID = 'M1-2026-08-03_04';
export const FIELD_NAMES = Object.freeze([
  'Timestamp',
  'Date',
  'Class Label',
  'Duration (hr)',
  'Instructor',
  'Site',
  'Notes',
]);

export class RecoveryAbortError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecoveryAbortError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RecoveryAbortError(code, message, details);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(value, secret) {
  if (!secret) fail('MISSING_PRIVATE_KEY', 'A private verification key is required.');
  return createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

export function parseCsv(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) fail('MALFORMED_CSV', 'The CSV contains an unterminated quoted field.');
  if (field.length || row.length) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

function exactText(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim();
}

function validCalendarDate(year, month, day) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() + 1 === month
    && candidate.getUTCDate() === day;
}

function canonicalDate(value) {
  const text = exactText(value);
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) match = [slash[0], slash[3], slash[1], slash[2]];
  }
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validCalendarDate(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function canonicalTimestamp(value) {
  const text = exactText(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;
  const date = canonicalDate(`${match[1]}-${match[2]}-${match[3]}`);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!date || hour > 23 || minute > 59 || second > 59) return null;
  return `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function fieldValue(row, displayName, camelName) {
  if (row && Object.prototype.hasOwnProperty.call(row, displayName)) return row[displayName];
  return row?.[camelName];
}

export function canonicalRecord(row) {
  const timestamp = canonicalTimestamp(fieldValue(row, 'Timestamp', 'timestamp'));
  const date = canonicalDate(fieldValue(row, 'Date', 'date'));
  const classLabel = exactText(fieldValue(row, 'Class Label', 'classLabel'));
  const durationNumber = Number(exactText(fieldValue(row, 'Duration (hr)', 'duration')));
  const instructor = exactText(fieldValue(row, 'Instructor', 'instructor'));
  const site = exactText(fieldValue(row, 'Site', 'site'));
  const notes = exactText(fieldValue(row, 'Notes', 'notes'));
  if (
    !timestamp
    || !date
    || timestamp.slice(0, 10) !== date
    || !classLabel
    || !Number.isFinite(durationNumber)
    || durationNumber <= 0
    || !instructor
    || !site
  ) return null;
  const fields = [timestamp, date, classLabel, String(durationNumber), instructor, site, notes];
  return Object.freeze({
    fields,
    key: JSON.stringify(fields),
    row: Object.freeze({
      Timestamp: timestamp,
      Date: date,
      'Class Label': classLabel,
      'Duration (hr)': durationNumber,
      Instructor: instructor,
      Site: site,
      Notes: notes,
    }),
  });
}

function semanticIdentity(record) {
  return JSON.stringify([
    record.fields[0],
    record.fields[1],
    record.fields[2],
    record.fields[4],
    record.fields[5],
  ]);
}

function frequencyMap(records) {
  const map = new Map();
  for (const record of records) {
    const bucket = map.get(record.key) || [];
    bucket.push(record);
    map.set(record.key, bucket);
  }
  return map;
}

function duplicateCount(map) {
  return [...map.values()].reduce((total, bucket) => total + Math.max(0, bucket.length - 1), 0);
}

function rowsFromCsv(bytes) {
  const parsed = parseCsv(bytes);
  if (!parsed.length || JSON.stringify(parsed[0]) !== JSON.stringify(FIELD_NAMES)) {
    fail('CSV_SCHEMA_MISMATCH', 'The source CSV headings do not match the required seven-field schema.');
  }
  if (parsed.some(row => row.length !== FIELD_NAMES.length)) {
    fail('CSV_COLUMN_MISMATCH', 'The source CSV contains a row with the wrong number of fields.');
  }
  return parsed.slice(1).map((values, sourceIndex) => ({
    sourceIndex,
    source: Object.fromEntries(FIELD_NAMES.map((name, index) => [name, values[index]])),
  }));
}

export function buildCandidatePlan({
  csvBytes,
  sheetRows,
  expectedSourceSha256 = EXPECTED_SOURCE_SHA256,
  fromDate,
  toDate,
  expectedCandidateCount,
}) {
  const sourceHash = sha256Hex(csvBytes);
  if (sourceHash !== String(expectedSourceSha256).toLowerCase()) {
    fail('SOURCE_HASH_MISMATCH', 'The source CSV checksum does not match the approved incident source.');
  }
  const start = canonicalDate(fromDate);
  const end = canonicalDate(toDate);
  if (!start || !end || start > end) fail('INVALID_DATE_SCOPE', 'The recovery date scope is invalid.');

  const csvRecords = rowsFromCsv(csvBytes).map(item => {
    const canonical = canonicalRecord(item.source);
    if (!canonical) fail('MALFORMED_SOURCE_ROW', 'The source CSV contains a malformed row.');
    return { ...canonical, sourceIndex: item.sourceIndex };
  });
  const sourceScope = csvRecords
    .filter(record => record.fields[1] >= start && record.fields[1] <= end)
    .sort((left, right) => left.key.localeCompare(right.key) || left.sourceIndex - right.sourceIndex)
    .map((record, index) => ({ ...record, candidateId: `REC-${String(index + 1).padStart(3, '0')}` }));

  const malformedSheetRows = [];
  const canonicalSheetRows = [];
  for (let index = 0; index < sheetRows.length; index += 1) {
    const canonical = canonicalRecord(sheetRows[index]);
    if (!canonical) {
      if (Object.values(sheetRows[index] || {}).some(value => exactText(value))) malformedSheetRows.push(index);
      continue;
    }
    if (canonical.fields[1] >= start && canonical.fields[1] <= end) canonicalSheetRows.push(canonical);
  }
  if (malformedSheetRows.length) {
    fail('MALFORMED_TARGET_ROW', 'The selected target contains malformed in-scope rows.', {
      malformedSheetRowCount: malformedSheetRows.length,
    });
  }

  const sheetBuckets = frequencyMap(canonicalSheetRows);
  const used = new Map();
  const candidates = [];
  for (const sourceRecord of sourceScope) {
    const consumed = used.get(sourceRecord.key) || 0;
    const available = (sheetBuckets.get(sourceRecord.key) || []).length;
    if (consumed < available) used.set(sourceRecord.key, consumed + 1);
    else candidates.push(sourceRecord);
  }

  const sheetOnly = [];
  for (const [key, bucket] of sheetBuckets) {
    sheetOnly.push(...bucket.slice(used.get(key) || 0));
  }
  const sheetByIdentity = new Map();
  for (const record of canonicalSheetRows) {
    const key = semanticIdentity(record);
    const bucket = sheetByIdentity.get(key) || [];
    bucket.push(record);
    sheetByIdentity.set(key, bucket);
  }
  const candidateByIdentity = new Map();
  const internalConflicts = [];
  for (const candidate of candidates) {
    const identity = semanticIdentity(candidate);
    const previous = candidateByIdentity.get(identity);
    if (previous && previous.key !== candidate.key) internalConflicts.push(candidate);
    else candidateByIdentity.set(identity, candidate);
  }
  const conflicts = internalConflicts.concat(candidates.filter(candidate => {
    return (sheetByIdentity.get(semanticIdentity(candidate)) || []).some(record => record.key !== candidate.key);
  }));
  if (conflicts.length) {
    fail('SEMANTIC_CONFLICT', 'The candidate set contains semantic conflicts and was not prepared.', {
      conflictCount: conflicts.length,
    });
  }
  if (Number.isInteger(expectedCandidateCount) && candidates.length > expectedCandidateCount) {
    fail('UNEXPECTED_CANDIDATE_GROWTH', 'The candidate set is larger than the approved maximum.', {
      candidateCount: candidates.length,
      expectedCandidateCount,
    });
  }

  return Object.freeze({
    sourceSha256: sourceHash,
    fromDate: start,
    toDate: end,
    sourceRowsInScope: sourceScope.length,
    sheetRowsInScope: canonicalSheetRows.length,
    exactIntersection: sourceScope.length - candidates.length,
    candidates: candidates.map(({ candidateId, row }) => Object.freeze({ candidateId, row })),
    sheetOnlyCount: sheetOnly.length,
    exactSheetDuplicateCount: duplicateCount(sheetBuckets),
    malformedSheetRowCount: malformedSheetRows.length,
    reducedByAlreadyPresent: Number.isInteger(expectedCandidateCount)
      ? Math.max(0, expectedCandidateCount - candidates.length)
      : 0,
  });
}

export function privateCandidateFingerprint(item, privateKey) {
  const canonical = canonicalRecord(item.row);
  if (!canonical) fail('MALFORMED_CANDIDATE', 'A recovery candidate is malformed.');
  return hmacHex(canonical.key, privateKey);
}

export function privateCandidateSetDigest(candidates, privateKey) {
  const material = candidates.map(item => {
    return `${item.candidateId}\u001f${privateCandidateFingerprint(item, privateKey)}`;
  }).sort().join('\n');
  return hmacHex(material, privateKey);
}

function writePrivateJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch {}
  return { path: path.resolve(filePath), sha256: sha256Hex(serialized) };
}

export function writePrivatePayload(filePath, plan) {
  return writePrivateJson(filePath, {
    schema: 'gib-m1-private-recovery-payload/v1',
    sourceSha256: plan.sourceSha256,
    fromDate: plan.fromDate,
    toDate: plan.toDate,
    candidates: plan.candidates.map(item => ({
      recoveryId: item.candidateId,
      ...item.row,
    })),
  });
}

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { fail('INVALID_JSON_ARTIFACT', 'A private JSON artifact could not be read.'); }
}

function saveJsonTarget(filePath, value) {
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, filePath);
  try { chmodSync(filePath, 0o600); } catch {}
}

export class JsonSheetAdapter {
  constructor({ filePath, targetAlias, expectedTargetProof, failAfterAdds = null }) {
    this.filePath = path.resolve(filePath);
    this.targetAlias = targetAlias;
    this.expectedTargetProof = expectedTargetProof;
    this.failAfterAdds = failAfterAdds;
    this.addedThisRun = 0;
  }

  load() {
    const state = readJson(this.filePath);
    if (
      state.schema !== 'gib-m1-test-sheet/v1'
      || state.targetAlias !== this.targetAlias
      || state.targetProof !== this.expectedTargetProof
      || !Array.isArray(state.rows)
    ) fail('TARGET_VERIFICATION_FAILED', 'The selected TEST target did not pass hard verification.');
    if (this.targetAlias !== 'TEST') fail('JSON_ADAPTER_TEST_ONLY', 'The JSON adapter is restricted to TEST.');
    return state;
  }

  async listRows() {
    return this.load().rows;
  }

  async appendCandidates(candidates, privateKey) {
    const state = this.load();
    const results = [];
    for (const item of candidates) {
      const candidate = canonicalRecord(item.row);
      const existing = state.rows.find(row => canonicalRecord(row)?.key === candidate.key);
      if (existing) {
        results.push({
          candidateId: item.candidateId,
          rowId: existing.RowID || existing.rowId || '',
          result: 'already exists',
          fingerprint: hmacHex(candidate.key, privateKey),
        });
        continue;
      }
      const conflict = state.rows.some(row => {
        const record = canonicalRecord(row);
        return record && semanticIdentity(record) === semanticIdentity(candidate) && record.key !== candidate.key;
      });
      if (conflict) fail('SEMANTIC_CONFLICT', 'The TEST target changed and now contains a semantic conflict.');
      if (Number.isInteger(this.failAfterAdds) && this.addedThisRun >= this.failAfterAdds) {
        const error = new RecoveryAbortError('SIMULATED_PARTIAL_FAILURE', 'A TEST-only partial failure was simulated.', {
          results,
        });
        throw error;
      }
      const rowId = `gib-recovery-${item.candidateId}`;
      state.rows.push({
        RowID: rowId,
        ...item.row,
        Device: 'M1 incident recovery',
        Build: 'm1-kiosk-sync-incident-repair',
        Status: 'OK',
      });
      this.addedThisRun += 1;
      saveJsonTarget(this.filePath, state);
      results.push({
        candidateId: item.candidateId,
        rowId,
        result: 'added',
        fingerprint: hmacHex(candidate.key, privateKey),
      });
    }
    return { ok: true, result: 'complete', targetProof: state.targetProof, results };
  }

  async rollback(receipt, privateKey) {
    const state = this.load();
    const removals = [];
    const seenRowIds = new Set();
    for (const item of receipt) {
      if (
        item.rowId !== `gib-recovery-${item.candidateId}`
        || seenRowIds.has(item.rowId)
      ) {
        fail('ROLLBACK_VERIFICATION_FAILED', 'The private receipt row identity did not verify.');
      }
      seenRowIds.add(item.rowId);
      const matches = state.rows.map((row, index) => ({ row, index, record: canonicalRecord(row) }))
        .filter(entry => (entry.row.RowID || entry.row.rowId) === item.rowId);
      if (
        matches.length !== 1
        || !matches[0].record
        || hmacHex(matches[0].record.key, privateKey) !== item.fingerprint
      ) fail('ROLLBACK_VERIFICATION_FAILED', 'The TEST target no longer matches the private receipt.');
      removals.push(matches[0].index);
    }
    removals.sort((left, right) => right - left).forEach(index => state.rows.splice(index, 1));
    saveJsonTarget(this.filePath, state);
    return { ok: true, result: 'rolled back', removed: removals.length, targetProof: state.targetProof };
  }
}

export class HttpSheetAdapter {
  constructor({ receiverUrl, receiverToken, recoveryToken, targetAlias, expectedTargetProof }) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(receiverUrl || '')) {
      fail('INVALID_RECEIVER_URL', 'The configured receiver URL is invalid.');
    }
    this.receiverUrl = receiverUrl;
    this.receiverToken = receiverToken;
    this.recoveryToken = recoveryToken;
    this.targetAlias = targetAlias;
    this.target = targetAlias === 'PRODUCTION' ? 'production' : 'test';
    this.expectedTargetProof = expectedTargetProof;
  }

  async post(body) {
    let response;
    try {
      response = await fetch(this.receiverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          ...body,
          token: this.receiverToken,
          recoveryToken: this.recoveryToken,
          target: this.target,
        }),
        redirect: 'follow',
      });
    } catch {
      fail('NETWORK_FAILURE', 'The receiver could not be reached.');
    }
    let value;
    try { value = JSON.parse(await response.text()); }
    catch { fail('UNREADABLE_RECEIVER_RESPONSE', 'The receiver response was not readable JSON.'); }
    if (!response.ok || !value || value.ok !== true) {
      fail('RECEIVER_REJECTED', 'The receiver rejected or failed the request.');
    }
    if (value.targetProof !== this.expectedTargetProof) {
      fail('TARGET_VERIFICATION_FAILED', 'The receiver target proof did not match.');
    }
    return value;
  }

  async listRows(fromDate) {
    const response = await this.post({ action: 'recoveryList', fromDate });
    if (!Array.isArray(response.records)) fail('INVALID_RECEIVER_RESPONSE', 'The receiver omitted recovery records.');
    return response.records;
  }

  async appendCandidates(candidates) {
    return this.post({
      action: 'recoverSignins',
      incidentId: RECOVERY_INCIDENT_ID,
      expectedTargetProof: this.expectedTargetProof,
      expectedCandidateCount: candidates.length,
      expectedCandidateSetDigest: privateCandidateSetDigest(candidates, this.recoveryToken),
      rows: candidates.map(item => ({ RecoveryID: item.candidateId, ...item.row })),
    });
  }

  async rollback(receipt) {
    return this.post({
      action: 'rollbackRecoveredSignins',
      incidentId: RECOVERY_INCIDENT_ID,
      expectedTargetProof: this.expectedTargetProof,
      receipt,
    });
  }
}

function requireWriteGate(targetAlias, expectedTargetProof, env) {
  if (env.M1_RECOVERY_ALLOW_WRITE !== `ALLOW_${targetAlias}_WRITE`) {
    fail('WRITE_GATE_CLOSED', 'The explicit recovery write gate is closed.');
  }
  if (
    targetAlias === 'PRODUCTION'
    && env.M1_RECOVERY_ALLOW_PRODUCTION !== expectedTargetProof
  ) fail('PRODUCTION_GATE_CLOSED', 'The production recovery gate is closed.');
}

export async function executePlan({ adapter, plan, targetAlias, expectedTargetProof, execute, receiptPath, env = process.env }) {
  if (!execute) {
    return {
      mode: 'dry-run',
      added: 0,
      alreadyPresent: plan.exactIntersection,
      candidateCount: plan.candidates.length,
      targetAlias,
    };
  }
  requireWriteGate(targetAlias, expectedTargetProof, env);
  if (plan.candidates.length === 0) {
    return {
      mode: 'execute',
      added: 0,
      alreadyPresent: plan.exactIntersection,
      candidateCount: 0,
      targetAlias,
      receipt: null,
    };
  }
  const response = await adapter.appendCandidates(plan.candidates, env.M1_RECOVERY_RECEIPT_KEY || adapter.recoveryToken);
  const results = Array.isArray(response.results) ? response.results : [];
  if (results.length !== plan.candidates.length || response.ok !== true) {
    fail('PARTIAL_OR_INVALID_EXECUTION', 'Recovery did not complete; a safe retry is required.', {
      resultCount: results.length,
    });
  }
  const receiptRows = results.filter(item => item.result === 'added').map(item => ({
    candidateId: item.candidateId,
    rowId: item.rowId,
    fingerprint: item.fingerprint,
  }));
  const receipt = writePrivateJson(receiptPath, {
    schema: 'gib-m1-private-recovery-receipt/v1',
    targetAlias,
    targetProof: expectedTargetProof,
    sourceSha256: plan.sourceSha256,
    inserted: receiptRows,
  });
  return {
    mode: 'execute',
    added: results.filter(item => item.result === 'added').length,
    alreadyPresent: plan.exactIntersection
      + results.filter(item => item.result === 'already exists').length,
    candidateCount: plan.candidates.length,
    targetAlias,
    receipt,
  };
}

function parseArguments(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    if (['--execute', '--http'].includes(argument)) flags.add(argument.slice(2));
    else values[argument.slice(2)] = argv[++index];
  }
  return { ...values, ...Object.fromEntries([...flags].map(flag => [flag, true])) };
}

function safeCliSummary(plan, result, payloadArtifact) {
  return {
    sourceSha256: plan.sourceSha256,
    targetAlias: result.targetAlias,
    mode: result.mode,
    sourceRowsInScope: plan.sourceRowsInScope,
    targetRowsInScope: plan.sheetRowsInScope,
    exactIntersection: plan.exactIntersection,
    candidateCount: plan.candidates.length,
    sheetOnlyCount: plan.sheetOnlyCount,
    exactSheetDuplicateCount: plan.exactSheetDuplicateCount,
    malformedSheetRowCount: plan.malformedSheetRowCount,
    reducedByAlreadyPresent: plan.reducedByAlreadyPresent,
    added: result.added,
    alreadyPresent: result.alreadyPresent,
    privatePayload: payloadArtifact,
    receipt: result.receipt || null,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const targetAlias = String(args['target-alias'] || '').toUpperCase();
  if (!['TEST', 'PRODUCTION'].includes(targetAlias)) fail('INVALID_TARGET_ALIAS', 'Use TEST or PRODUCTION as the target alias.');
  if (!args['expected-target-proof']) fail('MISSING_TARGET_PROOF', 'The expected target proof is required.');
  let adapter;
  if (args.http) {
    adapter = new HttpSheetAdapter({
      receiverUrl: process.env.M1_RECOVERY_RECEIVER_URL,
      receiverToken: process.env.M1_RECOVERY_RECEIVER_TOKEN,
      recoveryToken: process.env.M1_RECOVERY_MAINTENANCE_TOKEN,
      targetAlias,
      expectedTargetProof: args['expected-target-proof'],
    });
  } else {
    if (!args['sheet-json']) fail('MISSING_TEST_ADAPTER', 'A TEST Sheet JSON adapter is required.');
    adapter = new JsonSheetAdapter({
      filePath: args['sheet-json'],
      targetAlias,
      expectedTargetProof: args['expected-target-proof'],
      failAfterAdds: args['simulate-failure-after'] == null ? null : Number(args['simulate-failure-after']),
    });
  }
  if (args.rollback) {
    requireWriteGate(targetAlias, args['expected-target-proof'], process.env);
    const receipt = readJson(args.rollback);
    if (
      receipt.schema !== 'gib-m1-private-recovery-receipt/v1'
      || receipt.targetAlias !== targetAlias
      || receipt.targetProof !== args['expected-target-proof']
      || !Array.isArray(receipt.inserted)
      || !receipt.inserted.length
    ) fail('INVALID_PRIVATE_RECEIPT', 'The private recovery receipt did not verify.');
    const response = await adapter.rollback(
      receipt.inserted,
      process.env.M1_RECOVERY_RECEIPT_KEY || adapter.recoveryToken,
    );
    console.log(JSON.stringify({
      mode: 'rollback',
      targetAlias,
      removed: response.removed,
      targetVerified: response.targetProof === args['expected-target-proof'],
    }, null, 2));
    return;
  }
  if (!args.csv || !args['from-date'] || !args['to-date']) {
    fail('MISSING_ARGUMENT', 'Required recovery arguments are missing.');
  }
  const expectedCount = Number(args['expected-candidate-count']);
  if (!Number.isInteger(expectedCount) || expectedCount < 0) fail('INVALID_EXPECTED_COUNT', 'The expected candidate count is invalid.');
  const csvBytes = readFileSync(args.csv);
  const sheetRows = await adapter.listRows(args['from-date']);
  const plan = buildCandidatePlan({
    csvBytes,
    sheetRows,
    fromDate: args['from-date'],
    toDate: args['to-date'],
    expectedCandidateCount: expectedCount,
  });
  const payloadPath = args['private-payload'] || path.resolve('private', 'm1-recovery-payload.json');
  const payloadArtifact = writePrivatePayload(payloadPath, plan);
  const result = await executePlan({
    adapter,
    plan,
    targetAlias,
    expectedTargetProof: args['expected-target-proof'],
    execute: Boolean(args.execute),
    receiptPath: args.receipt || path.resolve('private', 'm1-recovery-receipt.json'),
  });
  console.log(JSON.stringify(safeCliSummary(plan, result, payloadArtifact), null, 2));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    const safeDetails = error instanceof RecoveryAbortError
      ? Object.fromEntries(Object.entries(error.details || {}).flatMap(([key, value]) => {
          if (typeof value === 'number' || typeof value === 'boolean') return [[key, value]];
          if (Array.isArray(value)) return [[`${key}Count`, value.length]];
          return [];
        }))
      : {};
    const safe = error instanceof RecoveryAbortError
      ? { ok: false, code: error.code, message: error.message, details: safeDetails }
      : { ok: false, code: 'UNEXPECTED_FAILURE', message: 'Recovery tooling failed safely.' };
    console.error(JSON.stringify(safe));
    process.exitCode = 1;
  });
}
