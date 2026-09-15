import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { applyAcknowledgements } from '../m1/sync-core.mjs';

const source = readFileSync(new URL('../tools/test-m1-kiosk-next-person.cjs', import.meta.url), 'utf8');
const start = source.indexOf('function savedLedgerPayload(row) {');
const end = source.indexOf('async function localState(', start);
assert.ok(start > 0 && end > start);
const clone = value => JSON.parse(JSON.stringify(value));
const ledger = {
  RowID: 'gib-m1-11111111-1111-4111-8111-111111111111', Timestamp: '2026-09-14 08:49:13',
  Date: '2026-09-14', 'Class Label': 'TEST Class', 'Duration (hr)': 1,
  Instructor: 'QA TEST Kiosk receipt test', Site: 'Rev', Notes: 'DO NOT PAY — synthetic TEST',
  __batchId: 'gib-m1-22222222-2222-4222-8222-222222222222', Status: 'OK'
};
const queue = { ...ledger, Device: '', Build: 'TEST build' };
delete queue.Status;

function harness(suite = 'instructor') {
  const context = vm.createContext({ assert, suite, clone, mode: 'instructor', mayAdoptNewRows: true,
    owned: new Map(), queuedRecords: new Map(), validateSynthetic() {},
    idOf: row => suite === 'staff' ? row.punchId : row.RowID });
  const methods = vm.runInContext(`${source.slice(start, end)}\n({ adopt, rememberQueuedRow });`, context);
  return { ...methods, context };
}

test('hosted runner accepts actual sync acknowledgment metadata while preserving the saved record', () => {
  const runner = harness();
  runner.adopt(ledger);
  runner.rememberQueuedRow(queue);
  for (const result of ['added', 'already exists']) {
    const acknowledged = applyAcknowledgements({ version: 2, ledger: [clone(ledger)], queue: [clone(queue)] }, [queue],
      { ok: true, test: true, results: [{ rowId: ledger.RowID, result, linkedRecordId: ledger.RowID }] }, '2026-09-14T12:49:49.535Z');
    assert.equal(acknowledged.state.queue.length, 0);
    runner.adopt(acknowledged.state.ledger[0]);
  }
  assert.deepEqual(runner.context.owned.get(ledger.RowID), ledger);
  assert.deepEqual(runner.context.queuedRecords.get(ledger.RowID), queue);
});

test('hosted runner still rejects changed saved data and unknown metadata after acknowledgment', () => {
  for (const [field, value] of Object.entries({ Timestamp: '2026-09-14 09:00:00', Date: '2026-09-15',
    'Class Label': 'Changed class', 'Duration (hr)': 2, Instructor: 'Changed instructor', Site: 'Other',
    Notes: 'Changed note', __batchId: 'changed-batch', Status: 'REVIEW', __unexpected: true })) {
    const runner = harness();
    runner.adopt(ledger);
    assert.throws(() => runner.adopt({ ...ledger, __syncResult: 'added', __syncedAt: '2026-09-14T12:49:49.535Z', [field]: value }),
      /A saved identity must keep its exact payload/u, field);
  }
});

test('hosted runner rejects incomplete or invalid acknowledgment metadata', () => {
  for (const metadata of [{ __syncResult: 'added' }, { __syncedAt: '2026-09-14T12:49:49.535Z' },
    { __syncResult: 'failed', __syncedAt: '2026-09-14T12:49:49.535Z' },
    { __syncResult: 'review required', __syncedAt: '2026-09-14T12:49:49.535Z' },
    { __syncResult: 'added', __syncedAt: 'yesterday' }, { __syncResult: 'added', __syncedAt: 1789390189535 },
    { __syncResult: 'added', __syncedAt: '2026-09-14' }]) {
    const runner = harness();
    runner.adopt(ledger);
    assert.throws(() => runner.adopt({ ...ledger, ...metadata }), /acknowledgment/u);
  }
});

test('hosted runner keeps the complete queued payload strict', () => {
  const runner = harness();
  runner.adopt(ledger);
  runner.rememberQueuedRow(queue);
  assert.throws(() => runner.rememberQueuedRow({ ...queue, __syncResult: 'added', __syncedAt: '2026-09-14T12:49:49.535Z' }),
    /entire original payload/u);
  assert.throws(() => runner.rememberQueuedRow({ ...queue, Build: 'changed build' }), /entire original payload/u);
});

test('hosted runner leaves staff record equality unchanged', () => {
  const runner = harness('staff');
  const staff = { punchId: 'synthetic-staff-id', timestamp: '2026-09-14T12:49:49.535Z', punchAction: 'clockIn' };
  runner.adopt(staff);
  runner.adopt(clone(staff));
  assert.throws(() => runner.adopt({ ...staff, __syncResult: 'added', __syncedAt: '2026-09-14T12:49:49.535Z' }),
    /A saved identity must keep its exact payload/u);
});
