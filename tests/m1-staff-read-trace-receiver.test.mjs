import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ID = 'd794fbee-f99c-4a12-b2b0-d087009532bb';
const NOW = Date.parse('2026-09-28T16:00:00Z');
const PREFIX = 'M1_TEST_READ_TRACE_V1_';
const READS = ['staffTimeReviewV2', 'staffTimeReviewPageV2', 'staffTimeHistoryPageV2', 'staffTimeShiftLookupV3', 'staffRecoveryReview'];
const body = (action = READS[0], extra = {}) => ({ action, target: 'test', token: 'synthetic-receiver', adminActionToken: 'synthetic-admin', staffReadTraceId: ID, ...extra });

function harness() {
  let stamp = NOW, uuid = 0, acquired = 0, released = 0, tries = 0, fault = '', locked = false;
  const properties = new Map([
    ['GIB_M1_TEST_SPREADSHEET_ID', 'synthetic-sheet'],
    ['GIB_M1_RECEIVER_TRANSPORT_TOKEN', 'synthetic-receiver'],
    ['GIB_M1_ADMIN_ACTION_TOKEN', 'synthetic-admin'],
    ['GIB_M1_LEGACY_KIOSK_TOKEN', 'synthetic-legacy']
  ]), logs = [];
  const diagnosticFault = operation => { if (fault === operation) throw new Error('PRIVATE diagnostic error/token/URL'); };
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [stamp])); } static now() { return stamp; } },
    console: { log(value) { diagnosticFault('console'); logs.push(value); } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) { if (key.startsWith('M1_TEST_READ_TRACE')) diagnosticFault('getProperty'); return properties.get(key) || null; },
      getKeys() { diagnosticFault('getKeys'); return [...properties.keys()]; },
      setProperty(key, value) { diagnosticFault('setProperty'); assert.equal(locked, false, 'receipt storage happens after the authoritative lock releases'); properties.set(key, value); },
      deleteProperty(key) { diagnosticFault('deleteProperty'); properties.delete(key); }
    }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ getContent: () => text, setMimeType() { return this; } }) },
    LockService: { getScriptLock() {
      tries++;
      if (fault === 'getLock') throw new Error('PRIVATE lock backend error');
      return {
        tryLock(milliseconds) { assert.equal(milliseconds, 10000); stamp += 13; if (fault === 'busy') return false; assert.equal(locked, false); locked = true; acquired++; return true; },
        releaseLock() { assert.equal(locked, true); locked = false; released++; stamp += 2; }
      };
    } },
    Utilities: { getUuid() { diagnosticFault('uuid'); return `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`; } },
    SpreadsheetApp: { openById() { throw new Error('Unexpected Sheet access'); }, flush() { throw new Error('Unexpected Sheet mutation'); } }
  });
  for (const file of ['Code.gs', 'GibM1Receiver.gs', 'GibM1ManagerReview.gs', 'GibM1StaffRecovery.gs', 'GibM1TestReadCallback.gs']) {
    vm.runInContext(readFileSync(new URL(`../integrations/google-apps-script/${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  // Exercise the real entrypoint/auth/action/lock/response boundaries. The read
  // boundary is an isolated fixture; it never touches shared Sheets or records.
  const result = { ok: true, target: 'test', privateStaffName: 'PRIVATE staff payload', privateToken: 'PRIVATE response token' };
  const read = () => { stamp += 29; if (fault === 'read') throw new Error('PRIVATE Sheet contents and exception'); return structuredClone(result); };
  const originalLookup = context.staffClockReadShiftLookup_;
  for (const name of ['staffClockReadPagedSummary_', 'staffClockReadPage_', 'staffClockReadHistoryPage_', 'staffClockReadShiftLookup_']) context[name] = read;
  context.openExpectedSpreadsheet_ = () => ({ getName: () => 'RBJJ M1 — TEST' });
  context.staffRecoveryState_ = () => { read(); return { items: [] }; };
  context.staffRecoveryPublic_ = () => ({ items: [] });
  return {
    context, properties, logs, result, originalLookup,
    fault(value) { fault = value; },
    arm() { context.testRevolutionStartReadTrace(); },
    post(value) { return context.doPost({ postData: { contents: JSON.stringify(value) } }).getContent(); },
    receipts() { return [...properties].filter(([key]) => key.startsWith(PREFIX)).map(([, value]) => JSON.parse(value)); },
    locks() { return { acquired, released, tries, locked }; }
  };
}

test('each authenticated TEST Staff read retains same-ID stage timings without altering the reply or adding locks', () => {
  for (const action of READS) {
    const h = harness(), expected = h.post(body(action, { staffReadTraceId: undefined }));
    h.arm();
    assert.equal(h.post(body(action)), expected, action);
    const [receipt] = h.receipts();
    assert.equal(receipt.requestId, ID); assert.equal(receipt.error, 'none'); assert.equal(receipt.stage, 'google.result');
    assert.deepEqual(receipt.events.map(({ stage, state }) => [stage, state]), [
      ['google.request', 'accepted'], ['google.lock', 'waiting'], ['google.lock', 'acquired'],
      ['google.read', 'start'], ['google.read', 'response'], ['google.lock', 'released'], ['google.result', 'validated']
    ]);
    assert.deepEqual(receipt.events.map(event => event.elapsedMs), [0, 0, 13, 13, 42, 44, 44]);
    assert.equal(receipt.elapsedMs, 44); assert.equal(receipt.status, null); assert.equal(receipt.acknowledged, null);
    assert.deepEqual(h.locks(), { acquired: 2, released: 2, tries: 2, locked: false });
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|synthetic|https:|staffReadTraceId|privateStaffName/);
    assert.equal(h.context.GIB_M1_ACTIVE_STAFF_READ_TRACE_, null);
  }
});

test('busy, failed read and later same-ID success preserve separate receipts and original failure responses', () => {
  const h = harness(); h.arm();
  h.fault('busy');
  assert.deepEqual(JSON.parse(h.post(body())), { ok: false, result: 'failed', message: 'Staff time was busy. Nothing changed.' });
  h.fault('read');
  assert.deepEqual(JSON.parse(h.post(body())), { ok: false, result: 'failed', message: 'The receiver could not complete the request.' });
  h.fault(''); assert.equal(JSON.parse(h.post(body())).ok, true);
  const receipts = h.receipts(); assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map(({ requestId, error, stage }) => ({ requestId, error, stage })), [
    { requestId: ID, error: 'read_rejected', stage: 'google.lock' },
    { requestId: ID, error: 'thrown_exception', stage: 'google.read' },
    { requestId: ID, error: 'none', stage: 'google.result' }
  ]);
  assert.ok(receipts[0].events.some(event => event.state === 'unavailable'));
  assert.ok(receipts[1].events.some(event => event.state === 'released'));
  assert.doesNotMatch(JSON.stringify(receipts), /PRIVATE|Sheet contents/);
});

test('an actual lookup catch retains the existing stale result and reports a fixed exception category', () => {
  const h = harness(); h.arm();
  const c = h.context;
  c.staffClockReadShiftLookup_ = h.originalLookup;
  c.staffClockViewState_ = () => ({ today: '2026-09-28', staffState: { all: [] } });
  c.staffClockDateFromMs_ = () => '2026-09-22';
  c.staffClockCache_ = () => ({});
  c.staffClockCacheReadJson_ = () => ({ history: { total: 1 } });
  c.staffClockManifestMatches_ = () => true;
  c.staffClockCacheReadJsonStatus_ = () => ({ status: 'hit', value: {} });
  c.staffClockHistoryIndexMatches_ = () => true;
  c.staffClockHistoryFirstDateAtMost_ = () => { throw new Error('PRIVATE cache/record evidence'); };
  c.staffClockInvalidateCachedView_ = () => {};
  assert.deepEqual(JSON.parse(h.post(body('staffTimeShiftLookupV3', { viewToken: 'a'.repeat(64), mode: 'recent' }))), { ok: false, target: 'test', result: 'stale' });
  const [receipt] = h.receipts();
  assert.equal(receipt.error, 'thrown_exception'); assert.equal(receipt.stage, 'google.read');
  assert.ok(receipt.events.some(event => event.stage === 'google.read' && event.state === 'failed'));
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|cache\/record/);
});

test('plain unsuccessful results are not mislabeled as lock failures or thrown exceptions', () => {
  const h = harness(); h.arm(); h.result.ok = false; h.result.result = 'stale';
  assert.equal(JSON.parse(h.post(body())).result, 'stale');
  assert.equal(h.receipts()[0].stage, 'google.result'); assert.equal(h.receipts()[0].error, 'read_rejected');
});

test('unarmed requests do not construct a collector or recheck Admin authentication for diagnostics', () => {
  const h = harness(), auth = h.context.adminActionAuthorized_;
  let authCalls = 0;
  h.context.adminActionAuthorized_ = value => { authCalls++; return auth(value); };
  h.context.gibM1ReadTraceReceipt_ = () => { assert.fail('Unarmed trace must not create a collector'); };
  assert.equal(JSON.parse(h.post(body())).ok, true);
  assert.equal(authCalls, 1); assert.equal(h.receipts().length, 0);
});

test('unarmed, expired, malformed, unauthorized, production, Richmond and write calls remain untraced', () => {
  for (const variant of ['unarmed', 'expired', 'bad-id', 'bad-admin', 'bad-token', 'production', 'richmond', 'richmond-production', 'wrong-title', 'write', 'kiosk']) {
    const h = harness(); if (variant !== 'unarmed') h.arm();
    let input = body();
    if (variant === 'expired') h.properties.set('M1_TEST_READ_TRACE_UNTIL', String(NOW - 1));
    if (variant === 'bad-id') input.staffReadTraceId = 'PRIVATE invalid ID';
    if (variant === 'bad-admin') input.adminActionToken = 'wrong';
    if (variant === 'bad-token') input.token = 'wrong';
    if (variant === 'production') { h.context.GIB_M1_ALLOWED_TARGET = 'production'; input.target = 'production'; }
    if (variant === 'richmond') h.context.GIB_M1_RICHMOND_INSTALLATION_ = true;
    if (variant === 'richmond-production') h.context.GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ = true;
    if (variant === 'wrong-title') h.context.EXPECTED_SPREADSHEET_NAME = 'Other TEST Sheet';
    if (variant === 'write') { input.action = 'staffTimeCorrect'; h.context.staffTimeCorrectAction_ = () => h.context.staffClockWithLock_('busy', () => h.context.jsonResult_({ ok: true })); }
    if (variant === 'kiosk') { input.action = 'staffClockSnapshotV2'; h.context.staffClockSnapshotV2Action_ = () => h.context.staffClockWithLock_('busy', () => h.context.jsonResult_({ ok: true })); }
    const response = h.post(input);
    assert.equal(h.receipts().length, 0, variant); assert.equal(h.context.GIB_M1_ACTIVE_STAFF_READ_TRACE_, null);
    if (['bad-admin', 'bad-token'].includes(variant)) assert.equal(JSON.parse(response).result, 'rejected');
  }
});

test('property, collector, logger and UUID failures cannot alter authoritative success or lock ownership', () => {
  for (const failure of ['getProperty', 'getKeys', 'setProperty', 'deleteProperty', 'uuid', 'console', 'collector', 'event', 'finish', 'hook']) {
    const h = harness(), expected = h.post(body()); h.arm();
    if (failure === 'deleteProperty') h.properties.set(`${PREFIX}${NOW - 1}_00000000-0000-4000-8000-000000000000`, '{}');
    if (failure === 'collector') h.context.gibM1ReadTraceReceipt_ = () => { throw new Error('PRIVATE collector'); };
    if (failure === 'event') h.context.gibM1ReadTraceReceipt_ = () => ({ event() { throw new Error('PRIVATE event'); }, finish() {} });
    if (failure === 'finish') h.context.gibM1ReadTraceReceipt_ = () => ({ event() {}, finish() { throw new Error('PRIVATE finish'); } });
    if (failure === 'hook') h.context.gibM1StaffReadTraceEvent_ = () => { throw new Error('PRIVATE hook'); };
    h.fault(failure);
    if (failure === 'console') h.context.Utilities.getUuid = () => { throw new Error('PRIVATE UUID'); };
    assert.equal(h.post(body()), expected, failure);
    assert.deepEqual(h.locks(), { acquired: 2, released: 2, tries: 2, locked: false }, failure);
    assert.equal(h.context.GIB_M1_ACTIVE_STAFF_READ_TRACE_, null);
  }
});

test('server-only trace field is compatible with existing exact Staff page/lookup input extraction', () => {
  const h = harness(), c = h.context, token = 'a'.repeat(64);
  for (const [fn, input, extra] of [
    ['staffClockPageRequest_', { viewToken: token, stream: 'records', offset: 0 }, true],
    ['staffClockHistoryPageRequest_', { viewToken: token, offset: 0 }],
    ['staffClockShiftLookupRequest_', { viewToken: token, mode: 'recent' }]
  ]) {
    assert.deepEqual(c[fn]({ ...input, staffReadTraceId: ID }, extra), c[fn](input, extra));
  }
  assert.equal(c.staffClockShiftLookupRequest_({ viewToken: token, mode: 'recent', staffId: 'forged', staffReadTraceId: ID }), null);
});
