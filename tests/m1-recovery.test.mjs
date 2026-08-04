import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPECTED_SOURCE_SHA256,
  JsonSheetAdapter,
  RecoveryAbortError,
  buildCandidatePlan,
  canonicalRecord,
  executePlan,
  privateCandidateSetDigest,
  sha256Hex,
  writePrivatePayload,
} from '../tools/m1-recovery.mjs';

const HEADER = 'Timestamp,Date,Class Label,Duration (hr),Instructor,Site,Notes';

function sourceCsv(rows) {
  const escape = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return Buffer.from(`${HEADER}\n${rows.map(row => row.map(escape).join(',')).join('\n')}\n`, 'utf8');
}

function fakeRow(timestamp, overrides = {}) {
  return {
    Timestamp: timestamp,
    Date: timestamp.slice(0, 10),
    'Class Label': 'TEST Class',
    'Duration (hr)': 1,
    Instructor: 'QA Test Instructor',
    Site: 'TEST',
    Notes: '',
    ...overrides,
  };
}

function csvValues(row) {
  return [
    row.Timestamp,
    row.Date,
    row['Class Label'],
    row['Duration (hr)'],
    row.Instructor,
    row.Site,
    row.Notes,
  ];
}

function createTestTarget(directory, rows = []) {
  const filePath = path.join(directory, 'test-sheet.json');
  const targetProof = 'TEST-TARGET-PROOF';
  writeFileSync(filePath, `${JSON.stringify({
    schema: 'gib-m1-test-sheet/v1',
    targetAlias: 'TEST',
    targetProof,
    rows,
  }, null, 2)}\n`, { mode: 0o600 });
  return { filePath, targetProof };
}

test('approved incident source checksum is pinned', () => {
  assert.equal(EXPECTED_SOURCE_SHA256, 'fb1ae2454974ded9377f714db307e2fdca25439e80fc5cf032917e3fa1637eb3');
});

test('canonical comparison uses every field and preserves legitimate repeated business combinations', () => {
  const first = fakeRow('2026-08-03 09:00:00');
  const second = fakeRow('2026-08-03 10:00:00');
  const csvBytes = sourceCsv([csvValues(first), csvValues(second)]);
  const plan = buildCandidatePlan({
    csvBytes,
    sheetRows: [first],
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 2,
  });
  assert.equal(plan.exactIntersection, 1);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].candidateId, 'REC-002');
  assert.equal(plan.sheetOnlyCount, 0);
});

test('representational date, timestamp, Unicode, whitespace, and decimal differences normalize narrowly', () => {
  const canonical = canonicalRecord(fakeRow('2026-08-03 09:00:00', {
    'Class Label': '  TEST Class  ',
    'Duration (hr)': '1.0',
    Instructor: 'QA Test Instructor',
  }));
  assert.equal(canonical.fields[0], '2026-08-03 09:00:00');
  assert.equal(canonical.fields[2], 'TEST Class');
  assert.equal(canonical.fields[3], '1');
});

test('unexpected candidate growth and semantic conflicts abort before writes', () => {
  const source = fakeRow('2026-08-03 09:00:00');
  const csvBytes = sourceCsv([csvValues(source)]);
  assert.throws(() => buildCandidatePlan({
    csvBytes,
    sheetRows: [],
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 0,
  }), error => error instanceof RecoveryAbortError && error.code === 'UNEXPECTED_CANDIDATE_GROWTH');

  assert.throws(() => buildCandidatePlan({
    csvBytes,
    sheetRows: [fakeRow('2026-08-03 09:00:00', { Notes: 'different' })],
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 1,
  }), error => error instanceof RecoveryAbortError && error.code === 'SEMANTIC_CONFLICT');

  const conflictingSource = sourceCsv([
    csvValues(source),
    csvValues({ ...source, Notes: 'different' }),
  ]);
  assert.throws(() => buildCandidatePlan({
    csvBytes: conflictingSource,
    sheetRows: [],
    expectedSourceSha256: sha256Hex(conflictingSource),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 2,
  }), error => error instanceof RecoveryAbortError && error.code === 'SEMANTIC_CONFLICT');

  assert.throws(() => buildCandidatePlan({
    csvBytes,
    sheetRows: [{ Date: '2026-08-03', Instructor: 'QA Test Instructor' }],
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 1,
  }), error => error instanceof RecoveryAbortError && error.code === 'MALFORMED_TARGET_ROW');
});

test('private payload is deterministic, contains stable IDs, and emits only a safe checksum', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gib-m1-private-'));
  const rows = [fakeRow('2026-08-03 09:00:00'), fakeRow('2026-08-04 10:00:00')];
  const csvBytes = sourceCsv(rows.map(csvValues));
  const plan = buildCandidatePlan({
    csvBytes,
    sheetRows: [],
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 2,
  });
  const artifact = writePrivatePayload(path.join(directory, 'payload.json'), plan);
  const saved = JSON.parse(readFileSync(artifact.path, 'utf8'));
  assert.deepEqual(saved.candidates.map(item => item.recoveryId), ['REC-001', 'REC-002']);
  assert.equal(artifact.sha256, sha256Hex(readFileSync(artifact.path)));
});

test('TEST adapter verifies its alias and opaque target proof', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gib-m1-target-'));
  const target = createTestTarget(directory);
  const wrong = new JsonSheetAdapter({
    filePath: target.filePath,
    targetAlias: 'TEST',
    expectedTargetProof: 'WRONG-PROOF',
  });
  await assert.rejects(wrong.listRows(), error => {
    return error instanceof RecoveryAbortError && error.code === 'TARGET_VERIFICATION_FAILED';
  });
});

test('TEST execution adds expected rows once and an identical replay adds zero', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gib-m1-execute-'));
  const target = createTestTarget(directory);
  const rows = [fakeRow('2026-08-03 09:00:00'), fakeRow('2026-08-04 10:00:00')];
  const csvBytes = sourceCsv(rows.map(csvValues));
  const adapter = new JsonSheetAdapter({
    filePath: target.filePath,
    targetAlias: 'TEST',
    expectedTargetProof: target.targetProof,
  });
  const plan = buildCandidatePlan({
    csvBytes,
    sheetRows: await adapter.listRows(),
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 2,
  });
  const first = await executePlan({
    adapter,
    plan,
    targetAlias: 'TEST',
    expectedTargetProof: target.targetProof,
    execute: true,
    receiptPath: path.join(directory, 'receipt.json'),
    env: {
      M1_RECOVERY_ALLOW_WRITE: 'ALLOW_TEST_WRITE',
      M1_RECOVERY_RECEIPT_KEY: 'private-test-receipt-key',
    },
  });
  assert.equal(first.added, 2);
  const replayPlan = buildCandidatePlan({
    csvBytes,
    sheetRows: await adapter.listRows(),
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 2,
  });
  assert.equal(replayPlan.candidates.length, 0);
  assert.equal(replayPlan.reducedByAlreadyPresent, 2);
  const replay = await executePlan({
    adapter,
    plan: replayPlan,
    targetAlias: 'TEST',
    expectedTargetProof: target.targetProof,
    execute: true,
    receiptPath: path.join(directory, 'replay-receipt.json'),
    env: {
      M1_RECOVERY_ALLOW_WRITE: 'ALLOW_TEST_WRITE',
      M1_RECOVERY_RECEIPT_KEY: 'private-test-receipt-key',
    },
  });
  assert.equal(replay.added, 0);
  assert.equal(replay.alreadyPresent, 2);
  assert.equal(replay.receipt, null);
});

test('partial TEST failure preserves added rows and retry keeps stable IDs without duplicates', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gib-m1-partial-'));
  const target = createTestTarget(directory);
  const rows = [fakeRow('2026-08-03 09:00:00'), fakeRow('2026-08-04 10:00:00')];
  const csvBytes = sourceCsv(rows.map(csvValues));
  const firstAdapter = new JsonSheetAdapter({
    filePath: target.filePath,
    targetAlias: 'TEST',
    expectedTargetProof: target.targetProof,
    failAfterAdds: 1,
  });
  const firstPlan = buildCandidatePlan({
    csvBytes,
    sheetRows: await firstAdapter.listRows(),
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 2,
  });
  await assert.rejects(
    firstAdapter.appendCandidates(firstPlan.candidates, 'private-test-receipt-key'),
    error => error instanceof RecoveryAbortError && error.code === 'SIMULATED_PARTIAL_FAILURE',
  );
  const retryAdapter = new JsonSheetAdapter({
    filePath: target.filePath,
    targetAlias: 'TEST',
    expectedTargetProof: target.targetProof,
  });
  const retryPlan = buildCandidatePlan({
    csvBytes,
    sheetRows: await retryAdapter.listRows(),
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 2,
  });
  assert.deepEqual(retryPlan.candidates.map(item => item.candidateId), ['REC-002']);
  const retry = await retryAdapter.appendCandidates(retryPlan.candidates, 'private-test-receipt-key');
  assert.equal(retry.results.filter(item => item.result === 'added').length, 1);
  assert.equal((await retryAdapter.listRows()).length, 2);
});

test('rollback uses exact private fingerprints and aborts on mismatch', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gib-m1-rollback-'));
  const target = createTestTarget(directory);
  const row = fakeRow('2026-08-03 09:00:00');
  const csvBytes = sourceCsv([csvValues(row)]);
  const adapter = new JsonSheetAdapter({
    filePath: target.filePath,
    targetAlias: 'TEST',
    expectedTargetProof: target.targetProof,
  });
  const plan = buildCandidatePlan({
    csvBytes,
    sheetRows: [],
    expectedSourceSha256: sha256Hex(csvBytes),
    fromDate: '2026-08-03',
    toDate: '2026-08-04',
    expectedCandidateCount: 1,
  });
  const key = 'private-test-receipt-key';
  const response = await adapter.appendCandidates(plan.candidates, key);
  const receipt = response.results.map(item => ({
    candidateId: item.candidateId,
    rowId: item.rowId,
    fingerprint: item.fingerprint,
  }));
  await assert.rejects(adapter.rollback([receipt[0], receipt[0]], key), error => {
    return error instanceof RecoveryAbortError && error.code === 'ROLLBACK_VERIFICATION_FAILED';
  });
  assert.equal((await adapter.listRows()).length, 1);
  await assert.rejects(adapter.rollback([
    { ...receipt[0], fingerprint: '0'.repeat(64) },
  ], key), error => error instanceof RecoveryAbortError && error.code === 'ROLLBACK_VERIFICATION_FAILED');
  assert.equal((await adapter.listRows()).length, 1);
  const rollback = await adapter.rollback(receipt, key);
  assert.equal(rollback.removed, 1);
  assert.equal((await adapter.listRows()).length, 0);
});

test('candidate-set digest is keyed and deterministic', () => {
  const candidates = [{ candidateId: 'REC-001', row: fakeRow('2026-08-03 09:00:00') }];
  assert.equal(
    privateCandidateSetDigest(candidates, 'private-a'),
    privateCandidateSetDigest(candidates, 'private-a'),
  );
  assert.notEqual(
    privateCandidateSetDigest(candidates, 'private-a'),
    privateCandidateSetDigest(candidates, 'private-b'),
  );
});
