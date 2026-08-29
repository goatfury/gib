import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { installationProfile } from '../m1/installation-profile-core.mjs';
import {
  DAY_ROLLOVER_CHECK_INTERVAL_MS,
  appendBatchToState,
  applyAcknowledgements,
  blankLocalState,
  createDayRolloverController,
  createPermanentRowId,
  evaluateAcknowledgements,
  formatDateInTimeZone,
  formatTimestampInTimeZone,
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

function productionAck(results) {
  return { ok: true, production: true, results };
}

function result(rowId, status, linkedRecordId = rowId) {
  return { rowId, result: status, linkedRecordId };
}

class FakeEventTarget {
  constructor() {
    this.visibilityState = 'hidden';
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  dispatch(type) {
    for (const callback of this.listeners.get(type) || []) callback({ type });
  }
}

function rolloverHarness(form = { name: '', notes: '', selectedClasses: [] }) {
  const documentTarget = new FakeEventTarget();
  const windowTarget = new FakeEventTarget();
  const displayedDates = [];
  const replacements = [];
  const cancelled = [];
  let scheduledCallback = null;
  let scheduledInterval = null;
  let scheduleCalls = 0;
  let now = new Date('2026-08-10T03:59:59Z');
  const controller = createDayRolloverController({
    getDateKey: () => formatDateInTimeZone(now),
    isFormInProgress: () => Boolean(
      form.name.trim()
      || form.notes.trim()
      || form.selectedClasses.length
    ),
    updateDisplayedDay: dateKey => displayedDates.push(dateKey),
    replaceClasses: dateKey => replacements.push(dateKey),
    schedule(callback, interval) {
      scheduleCalls += 1;
      scheduledCallback = callback;
      scheduledInterval = interval;
      return 41;
    },
    cancelSchedule: id => cancelled.push(id),
    documentTarget,
    windowTarget
  });

  return {
    controller,
    documentTarget,
    windowTarget,
    displayedDates,
    replacements,
    cancelled,
    get scheduleCalls() { return scheduleCalls; },
    get scheduledInterval() { return scheduledInterval; },
    setMonday() { now = new Date('2026-08-10T04:00:00Z'); },
    runScheduledCheck() { scheduledCallback(); }
  };
}

function kioskFunctionSource(name) {
  const start = kioskHtml.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, name);
  const next = kioskHtml.indexOf('\n  function ', start + 12);
  return kioskHtml.slice(start, next === -1 ? kioskHtml.length : next);
}

test('new sign-in rows store explicitly zero-padded seconds 0 through 9 in ledger and queue', () => {
  for (let second = 0; second <= 9; second += 1) {
    const instant = new Date(`2026-08-09T19:57:0${second}Z`);
    const expected = `2026-08-09 15:57:0${second}`;
    const value = row(IDS[0], {
      Timestamp: formatTimestampInTimeZone(instant),
      Date: '2026-08-09'
    });
    const batch = localBatch([value]);
    const stored = JSON.parse(JSON.stringify(
      appendBatchToState(blankLocalState(), batch.ledger, batch.queue)
    ));
    assert.equal(stored.ledger[0].Timestamp, expected);
    assert.equal(stored.queue[0].Timestamp, expected);
  }

  const signInSource = kioskHtml.match(/function signIn\(\)\s*\{[\s\S]*?\r?\n  \}\r?\n\r?\n  function voidLastSignin/u)?.[0] || '';
  assert.match(kioskHtml, /function fmtTS\(d\)\s*\{\s*return formatTimestampInTimeZone\(d, TZ\);\s*\}/u);
  assert.match(signInSource, /const now = new Date\(\);[\s\S]*?const timestamp = fmtTS\(now\);/u);
  assert.match(signInSource, /'Timestamp': timestamp/u);
  assert.match(signInSource, /appendBatchToState\(loadLocalState\(\), ledgerRows, queuedRows\)[\s\S]*?persistLocalState\(state\)/u);
});

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

test('review-required confirmation clears only that row and retains visible review status', () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const applied = applyAcknowledgements(
    state,
    state.queue,
    ack([result(IDS[0], 'review required')]),
    '2026-08-07T13:00:01.000Z'
  );
  assert.equal(applied.readable, true);
  assert.deepEqual(applied.confirmedRowIds, [IDS[0]]);
  assert.equal(applied.state.queue.length, 0);
  assert.equal(applied.state.ledger[0].Status, 'REVIEW');
  assert.equal(applied.state.ledger[0].__syncResult, 'review required');
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

test('Admin-linked already-exists acknowledgement clears one delayed row and is replay-safe', () => {
  const value = row(IDS[0]);
  const batch = localBatch([value]);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const payload = ack([result(IDS[0], 'already exists', 'gib-admin-not-synced-correction')]);

  const first = applyAcknowledgements(
    state,
    state.queue,
    payload,
    '2026-08-29T12:00:00.000Z'
  );
  assert.equal(first.readable, true);
  assert.deepEqual(first.confirmedRowIds, [IDS[0]]);
  assert.equal(first.state.queue.length, 0);
  assert.equal(first.state.ledger.length, 1);
  assert.equal(first.state.ledger[0].RowID, IDS[0]);
  assert.equal(first.state.ledger[0].__syncResult, 'already exists');

  const replay = applyAcknowledgements(
    first.state,
    state.queue,
    payload,
    '2026-08-29T12:00:00.000Z'
  );
  assert.deepEqual(replay.state, first.state);
  assert.deepEqual(replay.confirmedRowIds, [IDS[0]]);
});

test('legacy confirmation clears only the exact two waiting RowIDs and leaves input state untouched', () => {
  const values = [
    row(IDS[0], { Timestamp: '2026-08-09 15:57:3', Date: '2026-08-09' }),
    row(IDS[1], {
      Timestamp: '2026-08-09 15:57:3',
      Date: '2026-08-09',
      'Class Label': 'TEST Class B'
    }),
    row(IDS[2], {
      Timestamp: '2026-08-10 09:00:00',
      Date: '2026-08-10',
      'Class Label': 'TEST unrelated waiting row'
    })
  ];
  const batch = localBatch(values);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const submitted = state.queue.slice(0, 2);
  const unrelatedLedger = structuredClone(state.ledger[2]);
  const unrelatedQueue = structuredClone(state.queue[2]);
  const stateBefore = structuredClone(state);

  const applied = applyAcknowledgements(
    state,
    submitted,
    productionAck([
      result(IDS[0], 'added'),
      result(IDS[1], 'added')
    ]),
    '2026-08-09T20:01:00.000Z',
    { productionOrigin: true }
  );

  assert.deepEqual(applied.confirmedRowIds, [IDS[0], IDS[1]]);
  assert.deepEqual(applied.state.queue.map(value => value.RowID), [IDS[2]]);
  assert.deepEqual(applied.state.ledger.map(value => value.RowID), [IDS[0], IDS[1], IDS[2]]);
  assert.deepEqual(applied.state.ledger.slice(0, 2).map(value => value.Timestamp), [
    '2026-08-09 15:57:3',
    '2026-08-09 15:57:3'
  ]);
  assert.deepEqual(applied.state.ledger[2], unrelatedLedger);
  assert.deepEqual(applied.state.queue[0], unrelatedQueue);
  assert.deepEqual(state, stateBefore);
});

test('legacy retry clears only one RowID while an identical sibling stays duplicate-safe', () => {
  const values = [
    row(IDS[0], {
      Timestamp: '2026-08-09 15:57:3',
      Date: '2026-08-09',
      'Class Label': 'TEST Class A'
    }),
    row(IDS[1], {
      Timestamp: '2026-08-09 15:57:3',
      Date: '2026-08-09',
      'Class Label': 'TEST Class A'
    }),
    row(IDS[2], { 'Class Label': 'TEST unrelated waiting row' })
  ];
  const batch = localBatch(values);
  const state = appendBatchToState(blankLocalState(), batch.ledger, batch.queue);
  const submitted = state.queue.slice(0, 1);
  const siblingBefore = structuredClone(state.queue[1]);
  const beforeLostAck = structuredClone(state);

  const lostAck = applyAcknowledgements(
    state,
    submitted,
    '<unreadable>',
    'first',
    { productionOrigin: true }
  );
  assert.deepEqual(lostAck.state, beforeLostAck);

  const replay = applyAcknowledgements(
    lostAck.state,
    submitted,
    productionAck([result(IDS[0], 'already exists')]),
    'second',
    { productionOrigin: true }
  );
  assert.deepEqual(replay.state.queue.map(value => value.RowID), [IDS[1], IDS[2]]);
  assert.deepEqual(replay.state.queue[0], siblingBefore);
  assert.deepEqual(replay.state.ledger.map(value => value.RowID), [IDS[0], IDS[1], IDS[2]]);
  assert.equal(new Set(replay.state.ledger.map(value => value.RowID)).size, 3);

  const duplicateReplay = applyAcknowledgements(
    replay.state,
    submitted,
    productionAck([result(IDS[0], 'already exists')]),
    'second',
    { productionOrigin: true }
  );
  assert.deepEqual(duplicateReplay.state, replay.state);
});

test('New York rollover requests Monday class replacement on the minute and every wake or foreground path', () => {
  const scenarios = [
    ['minute interval', harness => harness.runScheduledCheck()],
    ['Samsung resume', harness => harness.documentTarget.dispatch('resume')],
    ['visible foreground', harness => {
      harness.documentTarget.visibilityState = 'visible';
      harness.documentTarget.dispatch('visibilitychange');
    }],
    ['window focus', harness => harness.windowTarget.dispatch('focus')],
    ['back-forward cache pageshow', harness => harness.windowTarget.dispatch('pageshow')]
  ];

  assert.equal(formatDateInTimeZone(new Date('2026-08-10T03:59:59Z')), '2026-08-09');
  assert.equal(formatDateInTimeZone(new Date('2026-08-10T04:00:00Z')), '2026-08-10');
  assert.equal(DAY_ROLLOVER_CHECK_INTERVAL_MS, 60_000);

  for (const [name, trigger] of scenarios) {
    const harness = rolloverHarness();
    harness.controller.start();
    assert.equal(harness.scheduledInterval, DAY_ROLLOVER_CHECK_INTERVAL_MS, name);
    harness.setMonday();
    trigger(harness);
    assert.deepEqual(harness.displayedDates, ['2026-08-10'], name);
    assert.deepEqual(harness.replacements, ['2026-08-10'], name);
    harness.controller.stop();
    assert.deepEqual(harness.cancelled, [41], name);
  }
});

test('rollover lifecycle is idempotent and hidden or stopped events are inert', () => {
  const harness = rolloverHarness();
  harness.controller.start();
  harness.controller.start();
  assert.equal(harness.scheduleCalls, 1);
  assert.equal(harness.documentTarget.listeners.get('visibilitychange').size, 1);
  assert.equal(harness.windowTarget.listeners.get('pageshow').size, 1);

  harness.setMonday();
  harness.documentTarget.visibilityState = 'hidden';
  harness.documentTarget.dispatch('visibilitychange');
  assert.deepEqual(harness.replacements, []);

  harness.controller.stop();
  harness.controller.stop();
  assert.deepEqual(harness.cancelled, [41]);
  harness.documentTarget.visibilityState = 'visible';
  harness.documentTarget.dispatch('visibilitychange');
  harness.documentTarget.dispatch('resume');
  harness.windowTarget.dispatch('focus');
  harness.windowTarget.dispatch('pageshow');
  assert.deepEqual(harness.replacements, []);
});

test('same-day class refresh defers until the active form is cleared', () => {
  const form = { name: 'QA Legacy Instructor', notes: '', selectedClasses: [] };
  const harness = rolloverHarness(form);
  harness.controller.start();
  const deferred = harness.controller.requestRefresh();
  assert.deepEqual(deferred, { changed: false, deferred: true });
  assert.deepEqual(harness.replacements, []);
  assert.equal(harness.controller.snapshot().pendingDate, '2026-08-09');

  form.name = '';
  harness.controller.checkNow();
  assert.deepEqual(harness.replacements, ['2026-08-09']);
  harness.controller.stop();
});

test('rollover defers class replacement for name, notes, or selections without a mutation path', () => {
  const activeForms = [
    { name: 'QA Legacy Instructor', notes: '', selectedClasses: [] },
    { name: '', notes: 'TEST note', selectedClasses: [] },
    { name: '', notes: '', selectedClasses: ['TEST Class A'] }
  ];

  for (const form of activeForms) {
    const formBefore = structuredClone(form);
    const harness = rolloverHarness(form);
    harness.controller.start();
    harness.setMonday();
    harness.documentTarget.dispatch('resume');

    assert.deepEqual(harness.displayedDates, ['2026-08-10']);
    assert.deepEqual(harness.replacements, []);
    assert.deepEqual(form, formBefore);
    assert.deepEqual(harness.controller.snapshot(), {
      renderedDate: '2026-08-09',
      pendingDate: '2026-08-10',
      started: true
    });

    form.name = '';
    form.notes = '';
    form.selectedClasses.length = 0;
    harness.controller.flushPending();
    assert.deepEqual(harness.replacements, ['2026-08-10']);
    assert.deepEqual(harness.displayedDates, ['2026-08-10']);
    assert.equal(harness.controller.snapshot().pendingDate, '');
    harness.controller.stop();
  }

  assert.doesNotMatch(
    createDayRolloverController.toString(),
    /localStorage|sessionStorage|fetch|requestAcknowledgements/u
  );
});

test('actual rollover renderer leaves every protected local-data byte and device authorization unchanged', () => {
  const schedule = {
    days: {
      Monday: ['TEST Class Monday'],
      Tuesday: [],
      Wednesday: [],
      Thursday: [],
      Friday: [],
      Saturday: [],
      Sunday: ['TEST Class Sunday']
    },
    source: 'test',
    updatedAt: '2026-08-09T12:00:00.000Z'
  };
  const seededStorage = new Map([
    ['gib_m1_local_state_v2', JSON.stringify({
      version: 2,
      ledger: [{ RowID: IDS[0], Status: 'OK' }],
      queue: [{ RowID: IDS[0], Timestamp: '2026-08-09 15:57:3' }]
    })],
    ['gib_m1_signins_v1', JSON.stringify([{ RowID: IDS[0], Status: 'OK' }])],
    ['gib_m1_sync_queue_v1', JSON.stringify([{ RowID: IDS[0] }])],
    ['gib_m1_sync_auto_v1', 'false'],
    ['gib_m1_device_label_v1', 'TEST tablet'],
    ['gib_m1_device_v1', JSON.stringify({ siteCode: 'TEST' })],
    ['gib_m1_schedule_v1', JSON.stringify(schedule)],
    ['gib_m1_series_v1', JSON.stringify([{
      id: 'series_test',
      label: 'TEST Temporary Class',
      days: ['Monday'],
      startDate: '2026-08-10',
      endDate: '2026-08-10',
      enabled: true
    }])],
    ['gib_m1_duration_rules_v1', JSON.stringify([{ match: 'TEST', duration: 1 }])],
    ['gib_m1_instructor_names_v1', JSON.stringify(['QA Legacy Instructor'])],
    ['gib_m1_admin_pin_v1', 'TEST-PIN-SENTINEL']
  ]);
  const storageBefore = JSON.stringify([...seededStorage]);
  const storageWrites = [];
  const localStorage = {
    getItem: key => seededStorage.get(key) ?? null,
    setItem(key, value) {
      storageWrites.push(['setItem', key]);
      seededStorage.set(key, String(value));
    },
    removeItem(key) {
      storageWrites.push(['removeItem', key]);
      seededStorage.delete(key);
    },
    clear() {
      storageWrites.push(['clear']);
      seededStorage.clear();
    }
  };
  const classWrap = {
    children: [],
    style: {},
    set innerHTML(value) {
      assert.equal(value, '');
      this.children = [];
    },
    appendChild(value) { this.children.push(value); }
  };
  const hint = {
    textContent: '',
    classList: { add() {}, remove() {} }
  };
  const dayLabel = { textContent: '' };
  const documentTarget = new FakeEventTarget();
  documentTarget.cookie = '__Host-gib_m1_production_device=TEST-AUTH-SENTINEL';
  documentTarget.createElement = tagName => ({
    tagName,
    appendChild() {},
    type: '',
    value: '',
    textContent: ''
  });
  const windowTarget = new FakeEventTarget();
  const context = vm.createContext({
    IS_RICHMOND: false,
    localStorage,
    document: documentTarget,
    SCHEDULE_KEY: 'gib_m1_schedule_v1',
    SCHEDULE_MODE_KEY: 'gib_m1_schedule_mode_v1',
    SERIES_KEY: 'gib_m1_series_v1',
    DAYS: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    DEFAULT_SCHEDULE: {},
    canonicalScheduleMemory: null,
    canonicalScheduleMemoryOrigin: null,
    isPlainObject: value => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    normalizeDayKey: value => value,
    normalizeSeriesItem: value => value,
    seriesLabel: value => value.label,
    renderScheduleStatuses() {},
    $: selector => ({
      '#todayName': dayLabel,
      '#classListWrap': classWrap,
      '#classesHint': hint
    })[selector]
  });
  const rendererSource = [
    'safeParse',
    'dayNameForDateKey',
    'updateDisplayedDay',
    'loadLocalScheduleOverride',
    'localOverrideMode',
    'loadSchedule',
    'loadSeries',
    'seriesIsActiveForDate',
    'seriesClassesForDate',
    'mergeUniqueClasses',
    'parseStartMinutes',
    'sortClassesChronologically',
    'classesForDateKey',
    'renderClassesForDateKey'
  ].map(kioskFunctionSource).join('\n');
  new vm.Script(rendererSource, { filename: 'm1-rollover-renderer.js' }).runInContext(context);

  let now = new Date('2026-08-10T03:59:59Z');
  let formActive = true;
  context.renderClassesForDateKey('2026-08-09');
  const controller = createDayRolloverController({
    getDateKey: () => formatDateInTimeZone(now),
    isFormInProgress: () => formActive,
    updateDisplayedDay: context.updateDisplayedDay,
    replaceClasses: context.renderClassesForDateKey,
    schedule: () => 1,
    cancelSchedule() {},
    documentTarget,
    windowTarget
  });
  controller.start();
  now = new Date('2026-08-10T04:00:00Z');
  documentTarget.dispatch('resume');
  assert.equal(classWrap.children.length, 1);
  formActive = false;
  controller.checkNow();
  windowTarget.dispatch('focus');
  windowTarget.dispatch('pageshow');
  controller.stop();

  assert.equal(dayLabel.textContent, ' · (Today: Monday)');
  assert.equal(classWrap.children.length, 2);
  assert.deepEqual(storageWrites, []);
  assert.equal(JSON.stringify([...seededStorage]), storageBefore);
  assert.equal(documentTarget.cookie, '__Host-gib_m1_production_device=TEST-AUTH-SENTINEL');
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
  assert.equal(Object.hasOwn(captured.init, 'mode'), false);
  assert.equal(Object.hasOwn(captured.init, 'redirect'), false);
  assert.equal(captured.init.body.includes(secretCanary), false);
  assert.equal(captured.init.body.includes('token'), false);
  assert.equal(captured.init.body.includes('__batchId'), false);
  assert.equal(captured.init.body.includes('target'), false);
});

test('production transport explicitly includes only the host-only same-origin credential', async () => {
  const secretCanary = 'CANARY-INTERNAL-MUST-NOT-LEAK';
  const value = row(IDS[0], { __privateCanary: secretCanary });
  let captured;
  await requestAcknowledgements([value], {
    productionOrigin: true,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify(productionAck([result(IDS[0], 'added')])), { status: 200 });
    }
  });
  const body = JSON.parse(captured.init.body);
  assert.equal(captured.url, '/api/m1-kiosk-sync');
  assert.equal(captured.init.credentials, 'same-origin');
  assert.equal(captured.init.mode, 'same-origin');
  assert.equal(captured.init.redirect, 'error');
  assert.deepEqual(Object.keys(body), ['rows']);
  assert.deepEqual(Object.keys(body.rows[0]), [
    'RowID',
    'Timestamp',
    'Date',
    'Class Label',
    'Duration (hr)',
    'Instructor',
    'Site',
    'Device',
    'Build',
    'Notes'
  ]);
  assert.equal(captured.init.body.includes(secretCanary), false);
  assert.equal(captured.init.body.includes('token'), false);
  assert.equal(captured.init.body.includes('target'), false);

  let nonBooleanInit;
  await requestAcknowledgements([value], {
    productionOrigin: 'true',
    fetchImpl: async (_url, init) => {
      nonBooleanInit = init;
      return new Response(JSON.stringify(ack([result(IDS[0], 'added')])), { status: 200 });
    }
  });
  assert.equal(nonBooleanInit.credentials, 'omit');
  assert.equal(Object.hasOwn(nonBooleanInit, 'mode'), false);
  assert.equal(Object.hasOwn(nonBooleanInit, 'redirect'), false);
});

test('TEST and production acknowledgment envelopes remain exact and origin-bound', () => {
  const submitted = [row(IDS[0])];
  const testPayload = ack([result(IDS[0], 'added')]);
  const prodPayload = productionAck([result(IDS[0], 'added')]);

  assert.equal(evaluateAcknowledgements(submitted, testPayload).readable, true);
  assert.equal(evaluateAcknowledgements(submitted, prodPayload).readable, false);
  assert.equal(evaluateAcknowledgements(submitted, prodPayload, { productionOrigin: true }).readable, true);
  assert.equal(evaluateAcknowledgements(submitted, testPayload, { productionOrigin: true }).readable, false);

  const badProductionPayloads = [
    { ...prodPayload, production: false },
    { ...prodPayload, test: true },
    { ok: true, results: prodPayload.results }
  ];
  for (const payload of badProductionPayloads) {
    assert.equal(
      evaluateAcknowledgements(submitted, payload, { productionOrigin: true }).readable,
      false
    );
  }
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

test('kiosk wires guarded New York day rollover without a refresh or storage mutation', () => {
  assert.match(kioskHtml, /dayRolloverController = createDayRolloverController\(\{/u);
  assert.match(kioskHtml, /getDateKey: \(\) => fmtDate\(new Date\(\)\)/u);
  assert.match(kioskHtml, /isFormInProgress: kioskFormInProgress/u);
  assert.match(kioskHtml, /dayRolloverController\.start\(\);/u);
  assert.match(kioskHtml, /function showKiosk\(\)[\s\S]*?populateClassesForToday\(\);/u);
  assert.match(kioskHtml, /function resetKioskForm\(\)[\s\S]*?dayRolloverController\?\.checkNow\(\);/u);
  assert.match(kioskHtml, /function kioskFormInProgress\(\)[\s\S]*?#nameInput[\s\S]*?#notesInput[\s\S]*?selectedClasses\(\)\.length/u);
  assert.doesNotMatch(
    createDayRolloverController.toString(),
    /reload|location\.|localStorage|sessionStorage/u
  );
  const rolloverInit = kioskHtml.match(
    /dayRolloverController = createDayRolloverController\(\{[\s\S]*?dayRolloverController\.checkNow\(\);/u
  )?.[0] || '';
  assert.ok(rolloverInit);
  assert.doesNotMatch(
    rolloverInit,
    /persistLocalState|safeSet|removeItem|syncNow|requestAcknowledgements|fetch\(/u
  );
  assert.match(
    kioskFunctionSource('refreshScheduleViews'),
    /dayRolloverController\s*\?\s*dayRolloverController\.requestRefresh\(\)/u
  );
  assert.match(rolloverInit, /replaceClasses: renderClassesForDateKey/u);

  const actualRolloverPath = [
    'updateDisplayedDay',
    'loadSchedule',
    'loadSeries',
    'seriesClassesForDate',
    'classesForDateKey',
    'renderClassesForDateKey',
    'populateClassesForToday'
  ].map(kioskFunctionSource).join('\n') + rolloverInit;
  assert.doesNotMatch(
    actualRolloverPath,
    /persistLocalState|safeSet\(|localStorage\.(?:setItem|removeItem|clear)|save(?:Device|Schedule|Series|DurationRules)|upsertName|setAdminPin|syncNow|requestAcknowledgements|fetch\(/u
  );
});

test('kiosk selects production transport only from the exact canonical origins', () => {
  assert.match(kioskHtml, /const PRODUCTION_ORIGIN = 'https:\/\/gib-live\.netlify\.app';/u);
  assert.match(kioskHtml, /const IS_PRODUCTION_ORIGIN = location\.origin === PRODUCTION_ORIGIN;/u);
  assert.match(kioskHtml, /const RICHMOND_PRODUCTION_ORIGIN = 'https:\/\/gib-richmond-live\.netlify\.app';/u);
  assert.match(
    kioskHtml,
    /const IS_RICHMOND_PRODUCTION_ORIGIN = IS_RICHMOND_PRODUCTION[\s\S]*location\.origin === RICHMOND_PRODUCTION_ORIGIN[\s\S]*INSTALLATION\.allowedOrigin === RICHMOND_PRODUCTION_ORIGIN;/u
  );
  assert.match(
    kioskHtml,
    /const IS_REVOLUTION_PRODUCTION_ORIGIN = !IS_RICHMOND[\s\S]*INSTALLATION\.installationId === 'rev'[\s\S]*IS_PRODUCTION_ORIGIN;/u
  );
  assert.match(
    kioskHtml,
    /const IS_PRODUCTION_SYNC_ORIGIN = IS_REVOLUTION_PRODUCTION_ORIGIN\s*\|\| IS_RICHMOND_PRODUCTION_ORIGIN;/u
  );
  assert.doesNotMatch(kioskHtml, /endsWith\([^\n]*gib-live|includes\([^\n]*gib-live/u);
  assert.match(kioskHtml, /requestAcknowledgements\(submittedRows, \{[\s\S]*?productionOrigin: IS_PRODUCTION_SYNC_ORIGIN[\s\S]*?\}\);/u);
  assert.equal(
    [...kioskHtml.matchAll(/productionOrigin: IS_PRODUCTION_SYNC_ORIGIN/gu)].length,
    3
  );
  assert.match(kioskHtml, /2026-08-29 M1B TEST sign-in-sync-recovery-candidate/u);
  assert.match(kioskHtml, /secure host-only cookie/u);

  const transportSource = kioskHtml.match(
    /const PRODUCTION_ORIGIN = 'https:\/\/gib-live\.netlify\.app';[\s\S]*?const IS_PRODUCTION_SYNC_ORIGIN = IS_REVOLUTION_PRODUCTION_ORIGIN\s*\|\| IS_RICHMOND_PRODUCTION_ORIGIN;/u
  )?.[0];
  assert.ok(transportSource);
  const selectsProductionTransport = Function(
    'location',
    'INSTALLATION',
    'IS_RICHMOND',
    'IS_RICHMOND_PRODUCTION',
    `"use strict"; ${transportSource}; return IS_PRODUCTION_SYNC_ORIGIN;`
  );
  assert.equal(selectsProductionTransport(
    { origin: 'https://gib-live.netlify.app' },
    installationProfile('rev'),
    false,
    false
  ), true);
  assert.equal(selectsProductionTransport(
    { origin: 'https://gib-richmond-live.netlify.app' },
    installationProfile('richmond', 'production', 'active'),
    true,
    true
  ), true);
  assert.equal(selectsProductionTransport(
    { origin: 'https://gib-live.netlify.app' },
    installationProfile('richmond', 'production', 'active'),
    true,
    true
  ), false);
  assert.equal(selectsProductionTransport(
    { origin: 'https://gib-richmond-live.netlify.app' },
    installationProfile('rev'),
    false,
    false
  ), false);
});

test('turning auto-sync OFF before a pending timer fires prevents the send', () => {
  const normalizedKioskHtml = kioskHtml.replace(/\r\n/gu, '\n');
  const autoSyncBlock = normalizedKioskHtml.match(
    /\/\/ Attempt auto-sync if configured\s*([\s\S]*?)\n  \}\n\n  function voidLastSignin/u
  )?.[1] || '';
  assert.ok(autoSyncBlock.includes('window.setTimeout'));

  const storage = new Map([['gib_m1_sync_auto_v1', 'true']]);
  let pendingTimer = null;
  let syncCalls = 0;
  const context = vm.createContext({
    BACKEND_ENABLED: true,
    SYNC_AUTO_KEY: 'gib_m1_sync_auto_v1',
    localStorage: { getItem: key => storage.get(key) ?? null },
    syncNow: () => { syncCalls += 1; },
    window: {
      setTimeout(callback, delay) {
        assert.equal(delay, 15_500);
        pendingTimer = callback;
        return 1;
      }
    }
  });

  new vm.Script(autoSyncBlock, { filename: 'm1-auto-sync-block.js' }).runInContext(context);
  assert.equal(typeof pendingTimer, 'function');
  storage.set('gib_m1_sync_auto_v1', 'false');
  pendingTimer();
  assert.equal(syncCalls, 0);

  storage.set('gib_m1_sync_auto_v1', 'true');
  pendingTimer = null;
  new vm.Script(autoSyncBlock, { filename: 'm1-auto-sync-block.js' }).runInContext(context);
  pendingTimer();
  assert.equal(syncCalls, 1);
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
