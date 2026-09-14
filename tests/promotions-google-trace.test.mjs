import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../promotions/Code.gs', import.meta.url), 'utf8');
const PRIVATE = 'SYNTHETIC_PRIVATE_STUDENT_DEVICE_MESSAGE';
const NONCE = '0123456789abcdef0123456789abcdef';
const TEST_SECRET = 'synthetic-test-only-bridge-secret-000000000000';
const LIVE_SECRET = 'synthetic-live-only-bridge-secret-111111111111';
const mode = target => `m1-authorized-tablet-${target}-v1`;
const origin = target => target === 'test' ? 'https://deploy-preview-86--gib-live.netlify.app' : 'https://gib-live.netlify.app';
const signed = bytes => [...bytes].map(byte => byte > 127 ? byte - 256 : byte);

function harness({ result = { ok: true, data: { displayName: PRIVATE } }, processingFailure = false, loggerFailure = false, digestFailure = false, cacheFailure = false, actualReads = false } = {}) {
  const logs = []; let logCalls = 0; let requests = 0;
  const cache = new Map(); const cacheWrites = []; let cacheReads = 0; let activeUser = 'owner@example.invalid'; let locks = 0; let releases = 0;
  const state = { students: new Map([[PRIVATE, { studentId: PRIVATE, displayName: PRIVATE, status: 'active' }]]), events: [{ studentId: PRIVATE, eventId: 'synthetic-event' }], requests: new Map() };
  const properties = { TEST_OWNER_EMAIL: 'owner@example.invalid', TEST_BRIDGE_SECRET: TEST_SECRET, LIVE_BRIDGE_SECRET: LIVE_SECRET,
    TEST_BRIDGE_MODE: mode('test'), LIVE_BRIDGE_MODE: mode('live'), TEST_BRIDGE_ORIGIN: origin('test'), LIVE_BRIDGE_ORIGIN: origin('live'),
    TEST_BRIDGE_INSTALLATION: 'rev', LIVE_BRIDGE_INSTALLATION: 'rev', LIVE_ENABLED: 'true', TEST_WORKBOOK_ID: 'synthetic-test-book', LIVE_WORKBOOK_ID: 'synthetic-live-book', LIVE_WORKBOOK_TITLE: 'Synthetic Live' };
  const context = vm.createContext({
    console: { info(...args) { logCalls += 1; if (loggerFailure) throw Error(PRIVATE); logs.push(args); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }), getActiveUser: () => ({ getEmail: () => activeUser }) },
    CacheService: { getScriptCache: () => ({ get(key) { cacheReads += 1; return cache.get(key) ?? null; },
      put(key, value, ttl) { if (cacheFailure) throw Error(PRIVATE); cacheWrites.push({ key, value, ttl }); cache.set(key, value); } }) },
    LockService: { getScriptLock: () => ({ tryLock() { locks += 1; return true; }, releaseLock() { releases += 1; } }) },
    SpreadsheetApp: new Proxy({}, { get() { assert.fail('Read operations must not mutate promotion records'); } }),
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest(_algorithm, text) { if (digestFailure) throw Error(PRIVATE); return signed(createHash('sha256').update(text).digest()); },
      computeHmacSha256Signature: (text, key) => signed(createHmac('sha256', key).update(text).digest()),
      newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: mime => ({ text, mime, getContent: () => text }) }) }
  });
  vm.runInContext(source, context);
  if (actualReads) {
    context.verifiedPromotionWorkbook_ = () => ({});
    context.readPromotionHistory_ = () => state;
    context.promotionToday_ = () => '2026-09-14';
    context.buildPromotionEvent_ = () => assert.fail('Read operations must not build promotion events');
    context.confirmedPromotionResult_ = () => assert.fail('Read operations must not rebuild derived student views');
  } else context.promotionRequestWithRecorder_ = () => { requests += 1; if (processingFailure) throw Error(PRIVATE); return result; };
  return {
    logs, cache, cacheWrites, state, counts: () => ({ logCalls, requests, cacheReads, locks, releases }),
    setActiveUser(value) { activeUser = value; },
    read(traceId) { return JSON.parse(JSON.stringify(context.readTestResponseTrace(traceId))); },
    post(operation = 'bootstrap', target = 'test', invalidSignature = false) {
      const payload = { version: 1, mode: mode(target), target, installation: 'rev', origin: origin(target), issuedAt: Math.floor(Date.now() / 1000),
        nonce: NONCE, deviceIdentity: `m1-${target}-device-${'a'.repeat(24)}`, request: operation === 'bootstrap' ? { operation }
          : operation === 'readStudent' ? { operation, studentId: PRIVATE } : { operation, studentId: PRIVATE, approverName: 'Synthetic Coach' } };
      const signature = createHmac('sha256', target === 'test' ? TEST_SECRET : LIVE_SECRET)
        .update(`gib-promotions-${target}-bridge:v1\n${context.canonicalPromotionJson_(payload)}`).digest('hex');
      const output = context.doPost({ postData: { contents: JSON.stringify({ payload, signature: invalidSignature ? '0'.repeat(64) : signature }) } });
      assert.equal(output.mime, 'application/json');
      return JSON.parse(output.text);
    }
  };
}

function records(h) {
  return h.logs.map(args => {
    assert.equal(args.length, 1);
    assert.equal(args[0].includes(PRIVATE), false); assert.equal(args[0].includes(NONCE), false);
    const record = JSON.parse(args[0]); assert.equal(record.kind, 'GIB_TEST_RESPONSE_TRACE');
    assert.deepEqual(Object.keys(record).sort(), ['kind', 'stage', 'traceId', 'operation', 'elapsedMs', 'intendedResponseType', 'resultOK', 'errorCode'].sort());
    assert.equal(record.intendedResponseType, 'application/json');
    assert.ok(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0);
    return record;
  });
}

test('verified TEST reads correlate entry and JSON completion using the exact Netlify nonce hash domain', () => {
  const expectedTrace = createHash('sha256').update('gib-test-response-trace:v1\n' + NONCE).digest('hex').slice(0, 24);
  for (const operation of ['bootstrap', 'readStudent']) {
    const result = { ok: true, data: { displayName: PRIVATE } }; const h = harness({ result });
    const reply = h.post(operation);
    assert.deepEqual(reply, { bridge: mode('test'), target: 'test', installation: 'rev', requestNonce: NONCE, result });
    const log = records(h); assert.equal(log.length, 2);
    assert.deepEqual(log.map(item => item.stage), ['entry', 'completion']);
    assert.ok(log.every(item => item.traceId === expectedTrace && item.operation === operation));
    assert.equal(log[0].resultOK, null); assert.equal(log[0].errorCode, null);
    assert.equal(log[1].resultOK, true); assert.equal(log[1].errorCode, null);
    assert.ok(log[1].elapsedMs >= log[0].elapsedMs); assert.equal(h.counts().requests, 1);
  }
});

test('TEST failed results and thrown processing failures complete once without private error detail', () => {
  for (const [options, expectedCode, bare] of [
    [{ result: { ok: false, error: { code: 'NOT_FOUND', message: PRIVATE } } }, 'NOT_FOUND', false],
    [{ result: { ok: false, error: { code: PRIVATE, message: PRIVATE } } }, 'OTHER', false],
    [{ processingFailure: true }, 'UNAUTHORIZED', true]
  ]) {
    const h = harness(options); const reply = h.post('readStudent'); const log = records(h);
    assert.equal(log.length, 2); assert.equal(log[1].stage, 'completion'); assert.equal(log[1].resultOK, false); assert.equal(log[1].errorCode, expectedCode);
    if (bare) assert.deepEqual(reply, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authorized tablet access is required.', retryable: false } });
    else assert.deepEqual(reply.result, options.result);
  }
});

test('LIVE, TEST writes, checkSave and rejected authentication produce no response trace', () => {
  for (const [operation, target] of [['bootstrap', 'live'], ['readStudent', 'live'], ['recordPromotion', 'test'], ['confirmRank', 'test'], ['registerStudent', 'test'], ['correctLatest', 'test'], ['checkSave', 'test']]) {
    const h = harness(); assert.equal(h.post(operation, target).result.ok, true); assert.deepEqual(h.logs, []); assert.deepEqual(h.cacheWrites, []); assert.equal(h.counts().requests, 1);
  }
  const denied = harness(); assert.equal(denied.post('bootstrap', 'test', true).error.code, 'UNAUTHORIZED');
  assert.deepEqual(denied.logs, []); assert.deepEqual(denied.cacheWrites, []); assert.equal(denied.counts().requests, 0);
});

test('logger and diagnostic digest failures leave the original successful and failed responses unchanged', () => {
  for (const result of [{ ok: true, data: { displayName: PRIVATE } }, { ok: false, error: { code: 'BUSY', message: PRIVATE } }]) {
    for (const option of [{ loggerFailure: true }, { digestFailure: true }, { cacheFailure: true }]) {
      const h = harness({ ...option, result }); const reply = h.post('readStudent');
      assert.deepEqual(reply.result, result); assert.equal(Object.keys(reply).length, 5); assert.equal(h.counts().requests, 1);
      assert.equal(h.counts().logCalls, option.digestFailure ? 0 : 2);
    }
  }
});

test('TEST receipts contain only safe completion metadata and the exact prepared response fingerprint with a short expiry', () => {
  for (const [options, wrappedResponse] of [[{}, true], [{ processingFailure: true }, false], [{ loggerFailure: true }, true]]) {
    const h = harness(options); const reply = h.post('readStudent');
    assert.equal(h.cacheWrites.length, 1); const write = h.cacheWrites[0];
    const traceId = createHash('sha256').update('gib-test-response-trace:v1\n' + NONCE).digest('hex').slice(0, 24);
    assert.equal(write.key, 'promotions-test-response-trace:' + traceId); assert.equal(write.ttl, 1800);
    assert.equal(write.value.includes(PRIVATE), false); assert.equal(write.value.includes(NONCE), false);
    const found = h.read(traceId); assert.equal(found.status, 'present'); const receipt = found.receipt;
    assert.deepEqual(Object.keys(receipt).sort(), ['traceId', 'operation', 'processingMs', 'jsonPrepared', 'wrappedResponse', 'responseSha256', 'responseBytes', 'resultOK', 'errorCode'].sort());
    assert.equal(receipt.traceId, traceId); assert.equal(receipt.operation, 'readStudent'); assert.equal(receipt.jsonPrepared, true); assert.equal(receipt.wrappedResponse, wrappedResponse);
    assert.ok(Number.isInteger(receipt.processingMs) && receipt.processingMs >= 0);
    const text = JSON.stringify(reply);
    assert.equal(receipt.responseSha256, createHash('sha256').update(text).digest('hex')); assert.equal(receipt.responseBytes, Buffer.byteLength(text));
    h.cache.delete(write.key); assert.deepEqual(h.read(traceId), { status: 'absent', inconclusive: true });
  }
});

test('receipt retrieval requires the existing owner, rejects malformed identifiers, and never returns corrupt or private cache fields', () => {
  const h = harness(); h.post(); const traceId = records(h)[0].traceId;
  h.setActiveUser('different@example.invalid'); const before = h.counts().cacheReads;
  assert.throws(() => h.read(traceId), error => error.promotionCode === 'UNAUTHORIZED'); assert.equal(h.counts().cacheReads, before);
  h.setActiveUser('owner@example.invalid');
  for (const value of [null, '', traceId.toUpperCase(), ' '+traceId, traceId+'0', PRIVATE]) assert.throws(() => h.read(value), error => error.promotionCode === 'VALIDATION');
  assert.equal(h.counts().cacheReads, before);
  const key = h.cacheWrites[0].key; const original = JSON.parse(h.cache.get(key));
  for (const value of ['not-json', JSON.stringify({ ...original, private: PRIVATE }), JSON.stringify({ ...original, traceId: 'a'.repeat(24) }), JSON.stringify({ ...original, operation: 'checkSave' }), JSON.stringify({ ...original, errorCode: PRIVATE }), JSON.stringify({ ...original, responseSha256: PRIVATE })]) {
    h.cache.set(key, value); assert.deepEqual(h.read(traceId), { status: 'absent', inconclusive: true });
  }
});

test('actual bootstrap and readStudent processing change only nonce cache and the diagnostic receipt, never promotion records', () => {
  for (const operation of ['bootstrap', 'readStudent']) {
    const h = harness({ actualReads: true }); const snapshot = structuredClone(h.state);
    const reply = h.post(operation); assert.equal(reply.result.ok, true);
    assert.deepEqual(h.state, snapshot); assert.equal(h.counts().locks, 1); assert.equal(h.counts().releases, 1);
    assert.equal(h.cacheWrites.length, 2);
    assert.equal(h.cacheWrites[0].key, 'promotions-bridge:' + NONCE); assert.equal(h.cacheWrites[0].ttl, 180);
    assert.ok(h.cacheWrites[1].key.startsWith('promotions-test-response-trace:')); assert.equal(h.cacheWrites[1].ttl, 1800);
    const repeat = h.post(operation); assert.equal(repeat.result.error.code, 'UNAUTHORIZED', 'the existing consumed-nonce rule is unchanged');
    assert.deepEqual(h.state, snapshot);
  }
});
