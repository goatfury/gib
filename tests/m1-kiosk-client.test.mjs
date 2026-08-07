import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  appendBatchToState,
  applyAcknowledgements,
  blankLocalState,
  createPermanentRowId,
  evaluateAcknowledgements,
  removeBatchFromState,
  requestAcknowledgements,
  validPermanentRowId
} from '../m1/sync-core.mjs';

const kioskHtml = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const syncSource = readFileSync(new URL('../m1/sync-core.mjs', import.meta.url), 'utf8');

const IDS = Object.freeze([
  'gib-m1-00000000-0000-4000-8000-000000000001',
  'gib-m1-00000000-0000-4000-8000-000000000002',
  'gib-m1-00000000-0000-4000-8000-000000000003',
  'gib-m1-00000000-0000-4000-8000-000000000004'
]);

function row(rowId, overrides = {}) {
  return {
    RowID: rowId,
    Timestamp: '2026-08-07 09:00:00',
    Date: '2026-08-07',
    'Class Label': 'TEST BJJ Fundamentals',
    'Duration (hr)': 1,
    Instructor: 'QA Test Instructor',
    Site: 'TEST',
    Device: 'TEST browser',
    Build: 'test-build',
    Notes: 'DO NOT PAY',
    __batchId: IDS[3],
    ...overrides
  };
}

function localBatch(rows) {
  const ledger = rows.map(value => ({ ...value, Status: 'OK' }));
  const queue = rows.map(value => ({ ...value }));
  return { ledger, queue };
}

function ack(results) {
  return { ok: true, test: true, results };
}

function result(rowId, status, linkedRecordId = rowId) {
  return { rowId, result: status, linkedRecordId };
}

test('secure UUID RowIDs are permanent, opaque, and fail closed without crypto', () => {
  const created = createPermanentRowId({
    randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  });
  assert.equal(created, 'gib-m1-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(validPermanentRowId(created), true);
  assert.throws(() => createPermanentRowId({}), /Secure row identity is unavailable/u);
  assert.equal(created.includes('Instructor'), false);
});

test('normal fake sign-in saves one shared RowID to ledger and queue before send', async () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  let state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const durableBytes = JSON.stringify(state);
  let fetchCalls = 0;
  const payload = await requestAcknowledgements(state.queue, {
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      const durable = JSON.parse(durableBytes);
      assert.equal(durable.ledger[0].RowID, IDS[0]);
      assert.equal(durable.queue[0].RowID, IDS[0]);
      const sent = JSON.parse(init.body);
      assert.equal(sent.rows[0].RowID, IDS[0]);
      return new Response(JSON.stringify(ack([result(IDS[0], 'added')])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  state = applyAcknowledgements(state, state.queue, payload, '2026-08-07T13:00:01.000Z').state;
  assert.equal(fetchCalls, 1);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.queue.length, 0);
});

test('two fake classes in the same second retain distinct RowIDs in one durable batch', () => {
  const rows = [
    row(IDS[0]),
    row(IDS[1], { 'Class Label': 'TEST No-Gi BJJ' })
  ];
  const batch = localBatch(rows);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  assert.deepEqual(state.ledger.map(value => value.RowID), [IDS[0], IDS[1]]);
  assert.deepEqual(state.queue.map(value => value.RowID), [IDS[0], IDS[1]]);
  assert.equal(new Set(state.queue.map(value => value.RowID)).size, 2);
});

test('rapid duplicate persistence attempt is rejected instead of creating a second row', () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const first = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  assert.throws(
    () => appendBatchToState(first, batch.ledger, batch.queue),
    /unique permanent row identities/u
  );
  assert.equal(first.ledger.length, 1);
  assert.equal(first.queue.length, 1);
});

test('undo removes the matching unsent ledger and queue rows together', () => {
  const values = [row(IDS[0]), row(IDS[1], { 'Class Label': 'TEST Judo' })];
  const batch = localBatch(values);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const undone = removeBatchFromState(state, IDS[3]);
  assert.equal(undone.ledger.length, 0);
  assert.equal(undone.queue.length, 0);
});

test('refresh and browser close/reopen preserve both ledger and waiting queue', () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const saved = JSON.stringify(appendBatchToState(blankLocalState(), batch.ledger, batch.queue));
  const afterRefresh = JSON.parse(saved);
  const afterReopen = JSON.parse(JSON.stringify(afterRefresh));
  assert.equal(afterRefresh.ledger[0].RowID, IDS[0]);
  assert.equal(afterRefresh.queue[0].RowID, IDS[0]);
  assert.deepEqual(afterReopen, afterRefresh);
});

test('internet unavailable before send performs no fetch and leaves state untouched', async () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  let fetchCalls = 0;
  await assert.rejects(requestAcknowledgements(state.queue, {
    online: false,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response();
    }
  }), /offline/u);
  assert.equal(fetchCalls, 0);
  assert.equal(state.queue.length, 1);
});

test('connection loss during send and browser timeout leave the queue unchanged', async () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  for (const error of [new TypeError('connection lost'), new DOMException('timed out', 'AbortError')]) {
    await assert.rejects(requestAcknowledgements(state.queue, {
      fetchImpl: async () => { throw error; }
    }));
    assert.equal(state.queue.length, 1);
  }
});

test('Netlify timeout and unreadable JSON leave the queue unchanged', async () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  await assert.rejects(requestAcknowledgements(state.queue, {
    fetchImpl: async () => new Response('{"ok":false}', { status: 504 })
  }), /did not confirm/u);
  await assert.rejects(requestAcknowledgements(state.queue, {
    fetchImpl: async () => new Response('<html>not json</html>', { status: 200 })
  }));
  assert.equal(state.queue.length, 1);
});

test('incomplete, duplicate, unrelated, and malformed results clear no rows', () => {
  const values = [row(IDS[0]), row(IDS[1], { 'Class Label': 'TEST Judo' })];
  const batch = localBatch(values);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const badPayloads = [
    ack([result(IDS[0], 'added')]),
    ack([result(IDS[0], 'added'), result(IDS[0], 'already exists')]),
    ack([result(IDS[0], 'added'), result(IDS[2], 'added')]),
    { ok: true, test: true, results: [{ rowId: IDS[0], result: 'added' }, result(IDS[1], 'added')] },
    ack([result(IDS[0], 'added'), result(IDS[1], 'unclear')])
  ];
  for (const payload of badPayloads) {
    const applied = applyAcknowledgements(state, state.queue, payload, 'now');
    assert.equal(applied.readable, false);
    assert.deepEqual(applied.state.queue.map(value => value.RowID), [IDS[0], IDS[1]]);
  }
});

test('one accepted and one rejected clears only the uniquely confirmed row', () => {
  const values = [row(IDS[0]), row(IDS[1], { 'Class Label': 'TEST Judo' })];
  const batch = localBatch(values);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const applied = applyAcknowledgements(state, state.queue, ack([
    result(IDS[0], 'added'),
    result(IDS[1], 'rejected', '')
  ]), '2026-08-07T13:00:01.000Z');
  assert.equal(applied.readable, true);
  assert.deepEqual(applied.confirmedRowIds, [IDS[0]]);
  assert.deepEqual(applied.state.queue.map(value => value.RowID), [IDS[1]]);
  assert.equal(applied.state.ledger[0].__syncResult, 'added');
  assert.equal(applied.state.ledger[1].__syncResult, undefined);
});

test('added requires its linked record to be the submitted RowID', () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const applied = applyAcknowledgements(
    state,
    state.queue,
    ack([result(IDS[0], 'added', IDS[1])]),
    'now'
  );
  assert.equal(applied.readable, true);
  assert.equal(applied.confirmedRowIds.length, 0);
  assert.equal(applied.state.queue.length, 1);
});

test('exact retry uses the same RowID and already exists removes it once', () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const lostAck = applyAcknowledgements(state, state.queue, '<unreadable>', 'first');
  assert.equal(lostAck.state.queue[0].RowID, IDS[0]);
  const replay = applyAcknowledgements(
    lostAck.state,
    lostAck.state.queue,
    ack([result(IDS[0], 'already exists')]),
    'second'
  );
  assert.equal(replay.state.queue.length, 0);
  assert.equal(replay.state.ledger.length, 1);
  assert.equal(replay.state.ledger[0].RowID, IDS[0]);
});

test('a row queued while a request is in flight is not removed by the older response', () => {
  const first = localBatch([row(IDS[0])]);
  const submittedState = appendBatchToState(blankLocalState(), first.ledger, first.queue);
  const submittedRows = submittedState.queue.map(value => ({ ...value }));
  const second = localBatch([row(IDS[1], { __batchId: IDS[2] })]);
  const latestState = appendBatchToState(submittedState, second.ledger, second.queue);
  const applied = applyAcknowledgements(
    latestState,
    submittedRows,
    ack([result(IDS[0], 'added')]),
    'now'
  );
  assert.deepEqual(applied.state.queue.map(value => value.RowID), [IDS[1]]);
});

test('browser request is same-origin JSON and contains no credential or internal fields', async () => {
  const secretCanary = 'CANARY-SECRET-MUST-NOT-LEAK';
  const value = row(IDS[0], { __privateCanary: secretCanary });
  let captured;
  await requestAcknowledgements([value], {
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify(ack([result(IDS[0], 'added')])), { status: 200 });
    }
  });
  assert.equal(captured.url, '/api/m1-kiosk-sync');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.credentials, 'omit');
  assert.equal(captured.init.body.includes(secretCanary), false);
  assert.equal(captured.init.body.includes('token'), false);
  assert.equal(captured.init.body.includes('__batchId'), false);
  assert.equal(captured.init.body.includes('target'), false);
});

test('kiosk source has the real double-click guard and no direct Google transport path', () => {
  assert.match(kioskHtml, /function signIn\(\)\s*\{\s*if \(signInLocked\) return;\s*signInLocked = true;/u);
  assert.match(kioskHtml, /appendBatchToState\(loadLocalState\(\), ledgerRows, queuedRows\)[\s\S]*persistLocalState\(state\)/u);
  assert.match(kioskHtml, /requestAcknowledgements\(submittedRows/u);
  assert.doesNotMatch(kioskHtml, /mode:\s*['"]no-cors['"]/u);
  assert.doesNotMatch(kioskHtml, /SYNC_URL_KEY|SYNC_TOKEN_KEY/u);
  assert.doesNotMatch(kioskHtml, /script\.google\.com\/macros/u);
  assert.doesNotMatch(syncSource, /script\.google\.com\/macros/u);
});

test('the kiosk module script compiles after resolving its static import', () => {
  const source = kioskHtml.match(/<script type="module">([\s\S]*?)<\/script>/u)?.[1] || '';
  const withoutImport = source.replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/u, '');
  assert.ok(withoutImport.includes('function signIn()'));
  assert.doesNotThrow(() => new vm.Script(withoutImport, { filename: 'm1-index-inline-module.js' }));
});

test('CSV remains ledger-local and requires no internet or sync request', () => {
  const buildCsvBody = kioskHtml.match(/function buildCSV\(\)\s*\{([\s\S]*?)\n  \}/u)?.[1] || '';
  assert.match(buildCsvBody, /loadSignins\(\)/u);
  assert.doesNotMatch(buildCsvBody, /fetch\(|requestAcknowledgements|SYNC_ENDPOINT/u);
  assert.match(kioskHtml, /Export CSV compatible with payroll/u);
});

test('acknowledgment evaluator accepts only the three exact clearing results', () => {
  for (const status of ['added', 'already exists', 'review required']) {
    const evaluated = evaluateAcknowledgements([row(IDS[0])], ack([result(IDS[0], status)]));
    assert.deepEqual(evaluated.confirmedRowIds, [IDS[0]]);
  }
  for (const status of ['rejected', 'failed']) {
    const evaluated = evaluateAcknowledgements([row(IDS[0])], ack([result(IDS[0], status, '')]));
    assert.deepEqual(evaluated.confirmedRowIds, []);
  }
});
