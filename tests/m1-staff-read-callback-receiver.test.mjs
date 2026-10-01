import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const NOW = Date.parse('2026-09-28T16:00:00Z');
const ID = '43b9a750-f21f-4c8d-847a-c3743ff33c76';
const REVIEWER = 'Stuart Turner';
const TOKEN = 'a'.repeat(64);
const DATA = {
  staffTimeReviewV2: {}, staffRecoveryReview: {},
  staffTimeReviewPageV2: { viewToken: TOKEN, stream: 'records', offset: 0 },
  staffTimeHistoryPageV2: { viewToken: TOKEN, offset: 0 },
  staffTimeShiftLookupV3: { viewToken: TOKEN, mode: 'recent', staffId: '', date: '' }
};
const originalHash = (original, reviewer = REVIEWER) => createHash('sha256').update(JSON.stringify(['m1-staff-read/v1', 'test', 'rev', reviewer, original.action, original.data]), 'utf8').digest('hex');
function envelope(action = 'staffTimeReviewV2') {
  const original = { action, data: structuredClone(DATA[action]) };
  return { token: 'synthetic-receiver', adminActionToken: 'synthetic-admin', target: 'test', action: 'managerReviewReadCallbackProof', gym: 'rev', from: '2026-09-07', to: '2026-09-28', adminName: REVIEWER,
    binding: { schema: 'm1-test-read-callback/v1', requestId: ID, target: 'test', gym: 'rev', action: 'staffClockRead', from: '2026-09-07', to: '2026-09-28', createdAt: NOW, expiresAt: NOW + 60000, originalHash: originalHash(original), staffAction: action }, original };
}
function harness() {
  let locked = false, acquired = 0, released = 0, reads = 0, clock = NOW, uuid = 0;
  const sent = [], logs = [], props = new Map([
    ['GIB_M1_TEST_SPREADSHEET_ID', 'synthetic-sheet'], ['GIB_M1_RECEIVER_TRANSPORT_TOKEN', 'synthetic-receiver'], ['GIB_M1_ADMIN_ACTION_TOKEN', 'synthetic-admin'], ['GIB_M1_LEGACY_KIOSK_TOKEN', 'synthetic-legacy']
  ]);
  const options = { result: { ok: true, target: 'test', syntheticPrivateRecords: [{ name: 'PRIVATE TEST instructor — é' }] }, busy: false, thrownRead: false, lostReply: false, callbackStatus: 200 };
  const ctx = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    console: { log: value => logs.push(value), warn: value => logs.push(value) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput(text) { if (options.lostReply && text.includes('CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE')) throw new Error('PRIVATE ContentService failure'); return { getContent: () => text, setMimeType() { return this; } }; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) || null, setProperty: (key, value) => props.set(key, value), getKeys: () => [...props.keys()], deleteProperty: key => props.delete(key) }) },
    LockService: { getScriptLock: () => ({ tryLock(ms) { assert.equal(ms, 10000); assert.equal(locked, false, 'no outer callback lock'); if (options.busy) return false; locked = true; acquired++; clock += 11; return true; }, releaseLock() { assert.equal(locked, true); locked = false; released++; clock += 3; } }) },
    SpreadsheetApp: { openById() { throw new Error('Unexpected shared Sheet access'); }, flush() { throw new Error('Unexpected write'); } },
    Utilities: {
      Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      formatDate: () => '2026-09-28', getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      newBlob: text => ({ getBytes: () => [...Buffer.from(text, 'utf8')] }),
      computeDigest(algorithm, text, charset) { assert.equal(charset, 'utf8'); return [...createHash(algorithm).update(text, charset).digest()]; },
      computeHmacSha256Signature(text, secret, charset) { assert.equal(charset, 'utf8'); return [...createHmac('sha256', secret).update(text, charset).digest()]; }
    },
    UrlFetchApp: { fetch(url, init) { assert.equal(locked, false, 'callback delivery is after lock release'); sent.push({ url, init }); return { getResponseCode: () => options.callbackStatus, getContentText: () => JSON.stringify({ ok: true, accepted: true, requestId: ID }) }; } }
  });
  for (const file of ['Code.gs', 'GibM1Receiver.gs', 'GibM1ManagerReview.gs', 'GibM1StaffRecovery.gs', 'GibM1TestReadCallback.gs']) vm.runInContext(readFileSync(new URL(`../integrations/google-apps-script/${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
  // Actual receiver authentication, routing, lock and callback are exercised.
  // Only the authoritative Sheet-read boundary uses a private isolated fixture.
  function read() { assert.equal(locked, true); reads++; clock += 7; if (options.thrownRead) throw new Error('PRIVATE record read failure'); return structuredClone(options.result); }
  for (const name of ['staffClockReadPagedSummary_', 'staffClockReadPage_', 'staffClockReadHistoryPage_', 'staffClockReadShiftLookup_']) ctx[name] = read;
  ctx.openExpectedSpreadsheet_ = () => ({ getName: () => 'RBJJ M1 — TEST' });
  ctx.staffRecoveryState_ = () => { read(); return { items: [] }; };
  ctx.staffRecoveryPublic_ = () => ({ items: [] });
  return { ctx, props, options, sent, logs, post: value => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(value) } }).getContent()),
    counts: () => ({ acquired, released, reads, locked }), receipts: () => [...props].filter(([key]) => key.startsWith('M1_TEST_READ_TRACE_V1_')).map(([, value]) => JSON.parse(value)),
    clock: value => { clock = value; } };
}

test('all five exact Staff reads use their ordinary receiver lock and private signed TEST callback', () => {
  for (const action of Object.keys(DATA)) {
    const h = harness(), request = envelope(action); h.ctx.testRevolutionStartReadTrace();
    const ordinary = h.post(request);
    assert.deepEqual(ordinary, { ok: false, code: 'CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE' });
    assert.equal(h.sent.length, 1, action); assert.deepEqual(h.counts(), { acquired: 1, released: 1, reads: 1, locked: false });
    const { url, init } = h.sent[0], payload = JSON.parse(init.payload);
    assert.equal(url, 'https://deploy-preview-89--gib-live.netlify.app/api/m1-test-read-result');
    assert.deepEqual(payload.binding, request.binding);
    assert.deepEqual(payload.result, action === 'staffRecoveryReview' ? { ok: true, target: 'test', recovery: { items: [] } } : h.options.result);
    assert.equal(init.headers['X-GIB-M1-Read-Signature'], createHmac('sha256', request.adminActionToken).update(`m1-test-read-callback/v1\n${init.payload}`, 'utf8').digest('hex'));
    assert.equal(init.followRedirects, false); assert.equal(init.timeoutSeconds, 10);
    const [receipt] = h.receipts(); assert.equal(receipt.requestId, ID); assert.equal(receipt.error, 'none'); assert.equal(receipt.acknowledged, true);
    assert.ok(receipt.events.some(event => event.stage === 'google.lock' && event.state === 'released'));
    assert.doesNotMatch(JSON.stringify([ordinary, h.logs, receipt]), /PRIVATE|synthetic-admin|synthetic-receiver|viewToken|https:/);
    assert.equal(h.ctx.GIB_M1_ACTIVE_STAFF_READ_TRACE_, null);
  }
});

test('a lost ordinary ContentService response does not prevent the completed authoritative callback', () => {
  const h = harness(); h.options.lostReply = true;
  assert.deepEqual(h.post(envelope()), { ok: false, result: 'failed', message: 'The receiver could not complete the request.' });
  assert.equal(h.sent.length, 1); assert.deepEqual(JSON.parse(h.sent[0].init.payload).result, h.options.result);
  assert.deepEqual(h.counts(), { acquired: 1, released: 1, reads: 1, locked: false });
});

test('strict typed stale and too_large outcomes survive while unrelated failures never become callback results', () => {
  for (const action of Object.keys(DATA).filter(action => action !== 'staffRecoveryReview')) {
    for (const result of ['stale', 'too_large', 'failed', 'rejected']) {
      const h = harness(); h.options.result = { ok: false, target: 'test', result };
      h.post(envelope(action));
      const allowed = result === 'stale' && action !== 'staffTimeReviewV2' || result === 'too_large' && action === 'staffTimeShiftLookupV3';
      assert.equal(h.sent.length, Number(allowed), `${action}/${result}`);
    }
  }
  for (const invalid of [
    { ok: false, target: 'test', result: 'stale', extra: true }, { ok: false, result: 'stale' },
    { ok: true, target: 'production' }, null, []
  ]) { const h = harness(); h.options.result = invalid; h.post(envelope('staffTimeReviewPageV2')); assert.equal(h.sent.length, 0); }
  for (const mode of ['busy', 'thrownRead']) { const h = harness(); h.options[mode] = true; h.post(envelope()); assert.equal(h.sent.length, 0); assert.equal(h.counts().locked, false); }
});

test('wrong auth/hash/reviewer/scope/fields and every write action reject before authoritative data access', () => {
  const changes = [
    b => { b.token = 'wrong'; }, b => { b.adminActionToken = 'wrong'; }, b => { b.adminName = 'Andrew Smith'; }, b => { b.adminName = 'Unknown'; },
    b => { b.binding.originalHash = 'b'.repeat(64); }, b => { b.binding.staffAction = 'staffTimeReviewPageV2'; },
    b => { b.binding.gym = 'richmond'; }, b => { b.gym = 'richmond'; }, b => { b.binding.extra = true; }, b => { b.extra = true; },
    b => { b.original.extra = true; }, b => { b.original.data.extra = true; }, b => { b.original.data.token = 'injected'; },
    b => { b.binding.createdAt = NOW + 1; b.binding.expiresAt = NOW + 60001; }, b => { b.binding.expiresAt = NOW; },
    b => { b.binding.requestId = 'not-a-uuid'; }, b => { b.binding.to = '2026-09-27'; },
    ...['staffTimeCorrect', 'staffTimeAdjust', 'staffTimeVoid', 'staffClockPunch', 'staffRecoveryStart', 'staffRecoveryDecide', 'managerReviewSave', 'managerReviewVoid', 'unknown'].map(action => b => { b.original.action = action; b.binding.staffAction = action; b.binding.originalHash = originalHash(b.original); })
  ];
  for (const change of changes) { const h = harness(), request = envelope(); change(request); h.post(request); assert.equal(h.sent.length, 0); assert.deepEqual(h.counts(), { acquired: 0, released: 0, reads: 0, locked: false }); }
  for (const variant of ['production', 'richmond', 'richmond-production', 'wrong-title']) {
    const h = harness(), request = envelope();
    if (variant === 'production') { h.ctx.GIB_M1_ALLOWED_TARGET = 'production'; h.ctx.GIB_M1_MANAGER_REVIEW_LIVE_ENABLED = true; h.ctx.EXPECTED_SPREADSHEET_NAME = 'RBJJ M1 — PRODUCTION'; request.target = request.binding.target = 'production'; request.action = 'managerReviewReadCallback'; request.binding.schema = 'm1-manager-read-callback/v1'; }
    if (variant === 'richmond') h.ctx.GIB_M1_RICHMOND_INSTALLATION_ = true;
    if (variant === 'richmond-production') h.ctx.GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ = true;
    if (variant === 'wrong-title') h.ctx.EXPECTED_SPREADSHEET_NAME = 'Other Sheet';
    h.post(request); assert.equal(h.sent.length, 0); assert.equal(h.counts().reads, 0); assert.equal(h.counts().acquired, 0);
  }
});

test('existing Staff data constraints remain enforced before hashing, without canonicalizing their order', () => {
  const h = harness();
  for (const action of Object.keys(DATA)) assert.equal(h.ctx.gibM1StaffCallbackOriginalHash_(envelope(action).original, REVIEWER, 'test'), envelope(action).binding.originalHash);
  for (const [action, data] of [
    ['staffTimeReviewPageV2', { viewToken: TOKEN, stream: 'unknown', offset: 0 }],
    ['staffTimeReviewPageV2', { viewToken: TOKEN, stream: 'records', offset: -1 }],
    ['staffTimeHistoryPageV2', { viewToken: 'bad', offset: 0 }],
    ['staffTimeShiftLookupV3', { viewToken: TOKEN, mode: 'recent', staffId: 'other', date: '' }],
    ['staffTimeShiftLookupV3', { viewToken: TOKEN, mode: 'exactDate', staffId: 'test-staff', date: '2026-02-30' }],
    ['staffTimeShiftLookupV3', { viewToken: TOKEN, mode: 'recent' }]
  ]) assert.equal(h.ctx.gibM1StaffCallbackOriginalHash_({ action, data }, REVIEWER, 'test'), '');
  const reordered = { action: 'staffTimeReviewPageV2', data: { offset: 0, stream: 'records', viewToken: TOKEN } };
  assert.equal(h.ctx.gibM1StaffCallbackOriginalHash_(reordered, REVIEWER, 'test'), originalHash(reordered));
  assert.notEqual(originalHash(reordered), envelope(reordered.action).binding.originalHash);
});

test('expiry and failed callback acceptance never produce a success in the ordinary response', () => {
  const expired = harness(); expired.clock(NOW + 60000); expired.post(envelope()); assert.equal(expired.sent.length, 0); assert.equal(expired.counts().reads, 0);
  const h = harness(); h.ctx.testRevolutionStartReadTrace(); h.options.callbackStatus = 503;
  assert.equal(h.post(envelope()).ok, false); assert.equal(h.sent.length, 1);
  assert.equal(h.receipts()[0].error, 'callback_http'); assert.equal(h.receipts()[0].acknowledged, false);
});
