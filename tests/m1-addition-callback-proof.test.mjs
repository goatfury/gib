import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { additionCheckHash, validateAdditionCheckCallback } from '../netlify/functions/_lib/m1-admin-add-check-proof.mjs';
import { makeBinding, callbackURL, SIGNATURE_HEADER, signature } from '../netlify/functions/_lib/m1-test-read-callback.mjs';

const now = Date.parse('2026-09-24T19:00:00Z');
const id = '11111111-2222-4333-8444-555555555555';
const reviewer = 'Stuart Turner';
const original = { requestId: 'm1-2026-09-23-111111112222222233333333', date: '2026-09-23', classLabel: '6:00 PM TEST class', duration: 1, instructor: 'TEST retained instructor', site: 'Rev', notes: 'DO NOT PAY', reason: 'TEST preserved addition' };
const originalKeys = ['requestId', 'date', 'classLabel', 'duration', 'instructor', 'site', 'notes', 'reason'];
const source = name => readFileSync(new URL(`../integrations/google-apps-script/${name}`, import.meta.url), 'utf8');

// This harness executes the actual receiver against memory-only Sheets. Writes
// are allowed solely while seeding fixture records, then made fatal for the read.
function google(target = 'test', seed = true) {
  const sheets = new Map(), sent = [], observations = [], sleeps = [];
  const tokens = { transport: `synthetic-${target}-transport-1234567890`, admin: `synthetic-${target}-admin-1234567890abcdef` };
  const properties = new Map([['GIB_M1_RECEIVER_TRANSPORT_TOKEN', tokens.transport], ['GIB_M1_ADMIN_ACTION_TOKEN', tokens.admin]]);
  let stamp = now;
  let sealed = false, lockHeld = false, lockCount = 0, releaseCount = 0;
  const mutate = () => { if (sealed) throw new Error('A callback proof attempted a Sheet write'); };
  const sheet = initial => {
    const rows = structuredClone(initial), notes = new Map();
    return { rows, appendRow(row) { mutate(); rows.push([...row]); }, getDataRange: () => ({ getValues: () => { if (sealed) observations.push({ name: 'sheet-read', locked: lockHeld }); return structuredClone(rows); } }), getLastRow: () => rows.length, getLastColumn: () => rows[0]?.length || 0, getMaxRows: () => 1000, setFrozenRows() { mutate(); },
      getRange(startRow, startColumn, rowCount, columnCount) { return {
        getValues: () => Array.from({ length: rowCount }, (_, offset) => (rows[startRow - 1 + offset] || []).slice(startColumn - 1, startColumn - 1 + columnCount)),
        getNotes: () => Array.from({ length: rowCount }, (_, offset) => [notes.get(startRow + offset) || '']),
        setValues(values) { mutate(); values.forEach((row, offset) => { const destination = rows[startRow - 1 + offset] ||= []; row.forEach((value, column) => { destination[startColumn - 1 + column] = value; }); }); return this; },
        setNumberFormat() { mutate(); return this; }
      }; }
    };
  };
  sheets.set('Signins', sheet([['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Device', 'Build', 'Notes', 'Status']]));
  const spreadsheetName = target === 'test' ? 'RBJJ M1 — TEST' : 'RBJJ M1 — PRODUCTION';
  const spreadsheet = { getName: () => spreadsheetName, getSheetByName: name => sheets.get(name), insertSheet(name) { mutate(); const value = sheet([]); sheets.set(name, value); return value; } };
  const formatDate = (date, timeZone, pattern) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}:${parts.second}`;
    if (pattern === 'yyyy-MM-dd') return day;
    if (pattern === 'yyyy-MM-dd HH:mm:ss') return `${day} ${time}`;
    if (pattern === "yyyy-MM-dd'T'HH:mm:ss") return `${day}T${time}`;
    if (pattern === 'Z') { const offset = Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60000); return `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}${String(Math.abs(offset) % 60).padStart(2, '0')}`; }
    throw new Error('Unexpected fixture date format');
  };
  const propertyStore = { getProperty: name => properties.get(name) || '', setProperty: (name, value) => properties.set(name, value), deleteProperty: name => properties.delete(name), getKeys: () => [...properties.keys()] };
  const ctx = vm.createContext({ Date: class extends Date { constructor(...args) { super(...(args.length ? args : [stamp])); } static now() { return stamp; } }, console: { log() {}, warn() {} },
    EXPECTED_SPREADSHEET_NAME: spreadsheetName, ...(target === 'test' ? { TEST_SPREADSHEET_ID: 'synthetic-test-sheet' } : { SPREADSHEET_ID: 'synthetic-production-contract-sheet' }), GIB_M1_ALLOWED_TARGET: target,
    GIB_M1_MANAGER_REVIEW_TEST_ENABLED: target === 'test', GIB_M1_MANAGER_REVIEW_LIVE_ENABLED: target === 'production', GIB_M1_REVOLUTION_REMOVAL_ENABLED: true,
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, getContent() { return text; }, setMimeType() { return this; } }) },
    LockService: { getScriptLock: () => ({ tryLock() { assert.equal(lockHeld, false, 'no nested lock acquisition'); lockHeld = true; lockCount++; return true; }, releaseLock() { assert.equal(lockHeld, true); lockHeld = false; releaseCount++; } }) },
    PropertiesService: { getScriptProperties: () => propertyStore },
    SpreadsheetApp: { openById: () => spreadsheet, flush() { mutate(); } },
    Utilities: { formatDate, sleep(ms) { assert.equal(lockHeld, false, 'fault delay must not hold the attendance lock'); sleeps.push(ms); stamp += ms; }, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }), computeDigest: (_algorithm, value) => [...createHash('sha256').update(value).digest()], computeHmacSha256Signature: (text, secret) => [...createHmac('sha256', secret).update(text).digest()] },
    UrlFetchApp: { fetch(url, options) { assert.equal(lockHeld, false, 'Google must release the attendance lock before callback delivery'); sent.push({ url, options }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, accepted: true, requestId: JSON.parse(options.payload).binding.requestId }) }; } }
  });
  for (const name of ['GibM1Receiver.gs', 'GibM1ManagerReview.gs', 'GibM1TestReadCallback.gs']) vm.runInContext(source(name), ctx);
  const post = body => JSON.parse(ctx.adReceiverV2_({ postData: { contents: JSON.stringify(body) } }).text);
  const envelope = { token: tokens.transport, adminActionToken: tokens.admin, target, adminName: reviewer };
  let receipt;
  if (seed) {
    receipt = post({ ...envelope, action: 'addMissedInstructor', ...original }); assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(post({ ...envelope, action: 'addMissedInstructor', ...original, requestId: 'm1-2026-09-23-aaaaaaaaaaaaaaaaaaaaaaaa', instructor: 'TEST second instructor' }).ok, true);
  }
  sealed = true; lockCount = 0; releaseCount = 0;
  for (const name of ['dailyReviewAction_']) {
    if (typeof ctx[name] !== 'function') continue;
    const fn = ctx[name]; ctx[name] = (...args) => { observations.push({ name, locked: lockHeld }); return fn(...args); };
  }
  const body = { ...envelope, action: target === 'test' ? 'managerReviewReadCallbackProof' : 'managerReviewReadCallback', gym: 'rev', from: '2026-09-07', to: '2026-09-24', original,
    binding: { ...makeBinding(id, now, 'adminAdditionCheckRead', target), originalHash: additionCheckHash(original, reviewer, target), date: original.date } };
  return { ctx, post, body, receipt, sent, observations, tokens, sheets, properties, propertyStore, sleeps, clock: () => stamp, snapshot: () => JSON.stringify([...sheets].map(([name, value]) => [name, value.rows])), locks: () => ({ lockCount, releaseCount, lockHeld }) };
}

test('addition hash binds every exact original field and rejects invalid originals instead of reusing a valid hash', () => {
  const expected = createHash('sha256').update(JSON.stringify(['adminAdditionCheckRead', 'test', 'rev', reviewer, ...originalKeys.map(key => original[key])])).digest('hex');
  assert.equal(additionCheckHash(original, reviewer, 'test'), expected);
  for (const key of originalKeys) {
    let changed;
    try { changed = additionCheckHash({ ...original, [key]: key === 'duration' ? 0.5 : original[key] + '-changed' }, reviewer, 'test'); }
    catch (error) { assert.match(error.message, /Invalid original addition/); continue; }
    assert.notEqual(changed, expected, key);
  }
  assert.notEqual(additionCheckHash(original, 'Andrew Smith', 'test'), expected);
  assert.notEqual(additionCheckHash(original, reviewer, 'production'), expected);
});

test('actual Google addition proof reads the retained row, audit and manager ledger under one lock, writes nothing, then signs a private callback', () => {
  for (const target of ['test', 'production']) {
    const g = google(target), before = g.snapshot();
    const ordinary = g.post(g.body);
    assert.equal(ordinary.ok, false); assert.doesNotMatch(JSON.stringify(ordinary), /records|auditHistory|ledger|TEST retained|Stuart Turner|originalHash/);
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].url, callbackURL(target));
    assert.deepEqual(g.locks(), { lockCount: 1, releaseCount: 1, lockHeld: false });
    assert.ok(g.observations.some(item => item.name === 'dailyReviewAction_' && item.locked));
    assert.ok(g.observations.every(item => item.locked));
    assert.equal(g.snapshot(), before);
    const { options } = g.sent[0], payload = JSON.parse(options.payload);
    assert.equal(options.headers[SIGNATURE_HEADER], signature(options.payload, g.tokens.admin, target));
    const confirmed = validateAdditionCheckCallback(payload.result, original, reviewer, target);
    const { ok: _ok, ...receipt } = g.receipt;
    assert.deepEqual(confirmed.receipt, receipt);
    assert.equal(confirmed.ledger.target, target);
    assert.equal(confirmed.ledger.days.find(day => day.date === original.date).records.length, 2);
    assert.equal(payload.result.dailyRead.adminName, reviewer);
    assert.equal(payload.result.dailyRead.test, target === 'test');
    if (target === 'production') assert.equal(payload.result.dailyRead.records[0].removal.eligible, true);
  }
});

test('Google rejects mismatched original hash, reviewer, date, environment and action before acquiring the attendance lock', () => {
  for (const change of [
    body => { body.binding.originalHash = 'b'.repeat(64); }, body => { body.adminName = 'Andrew Smith'; },
    body => { body.binding.date = '2026-09-22'; }, body => { body.original = { ...body.original, instructor: 'TEST other instructor' }; },
    body => { body.binding.target = 'production'; }, body => { body.binding.action = 'managerReviewBadgeRead'; },
    body => { delete body.adminName; }, body => { body.original = { ...body.original, unexpected: true }; }
  ]) {
    const g = google(), body = structuredClone(g.body), before = g.snapshot(); change(body);
    g.post(body);
    assert.equal(g.sent.length, 0); assert.deepEqual(g.locks(), { lockCount: 0, releaseCount: 0, lockHeld: false }); assert.equal(g.snapshot(), before);
  }
});

test('complete absent proof stays unconfirmed, while mismatched or incomplete proof wrappers throw instead of claiming success', () => {
  const missing = google('test', false); missing.post(missing.body);
  assert.equal(missing.sent.length, 1);
  const absent = JSON.parse(missing.sent[0].options.payload).result;
  assert.equal(validateAdditionCheckCallback(absent, original, reviewer, 'test').receipt, null);
  const g = google(); g.post(g.body);
  const valid = JSON.parse(g.sent[0].options.payload).result;
  for (const change of [
    value => { value.originalHash = 'b'.repeat(64); }, value => { value.reviewer = 'Andrew Smith'; }, value => { value.date = '2026-09-22'; },
    value => { value.target = 'production'; }, value => { value.gym = 'richmond'; }, value => { value.extra = true; },
    value => { delete value.dailyRead.auditHistory; }, value => { value.ledger.complete = false; }, value => { value.ledger.days.pop(); },
    value => { value.dailyRead.test = false; }, value => { value.dailyRead.adminName = 'Andrew Smith'; }
  ]) { const invalid = structuredClone(valid); change(invalid); assert.throws(() => validateAdditionCheckCallback(invalid, original, reviewer, 'test')); }
  assert.equal(validateAdditionCheckCallback({ ...valid, dailyRead: { ...valid.dailyRead, records: [] } }, original, reviewer, 'test').receipt, null);
});

test('ordinary manager badge callback retains its ledger-only contract and cannot carry an addition original', () => {
  const g = google();
  const body = { ...g.body, binding: makeBinding(id, now, 'managerReviewBadgeRead', 'test') }; delete body.adminName; delete body.original;
  g.post(body);
  assert.equal(g.sent.length, 1);
  const result = JSON.parse(g.sent[0].options.payload).result;
  assert.equal(result.schema, 'm1-manager-review/v1');
  assert.equal(Object.hasOwn(result, 'dailyRead'), false); assert.equal(Object.hasOwn(result, 'originalHash'), false);
  const contaminated = google(); contaminated.post({ ...body, original });
  assert.equal(contaminated.sent.length, 0);
});

test('unarmed or unreadable TEST slow-fault instrumentation adds no lock and cannot prevent a normal manager callback', () => {
  for (const failPropertyRead of [false, true]) {
    const g = google();
    if (failPropertyRead) {
      const get = g.propertyStore.getProperty;
      g.propertyStore.getProperty = name => { if (name === 'M1_TEST_SLOW_MANAGER') throw new Error('synthetic unavailable instrumentation'); return get(name); };
    }
    const body = { ...g.body, binding: makeBinding(id, now, 'managerReviewRead', 'test') }; delete body.original;
    g.post(body);
    assert.equal(g.sent.length, 1); assert.deepEqual(g.sleeps, []);
    assert.deepEqual(g.locks(), { lockCount: 1, releaseCount: 1, lockHeld: false });
  }
});

test('editor-armed TEST slow callback delays exactly one manager read by 35 seconds after its authoritative lock is released', () => {
  const g = google(), before = g.snapshot();
  g.ctx.testRevolutionSlowManagerCallback();
  const body = { ...g.body, binding: makeBinding(id, now, 'managerReviewRead', 'test') }; delete body.original;
  g.post(body);
  assert.deepEqual(g.sleeps, [35000]); assert.equal(g.sent.length, 1);
  assert.deepEqual(g.locks(), { lockCount: 2, releaseCount: 2, lockHeld: false });
  assert.equal(g.properties.has('M1_TEST_SLOW_MANAGER'), false);
  assert.deepEqual(JSON.parse(g.properties.get('M1_TEST_SLOW_MANAGER_RECEIPT')), { requestId: id, fault: 'slow-manager-read', delayMs: 35000, status: 200, acknowledged: true });
  g.post({ ...body, binding: makeBinding('22222222-3333-4444-8555-666666666666', g.clock(), 'managerReviewRead', 'test') });
  assert.deepEqual(g.sleeps, [35000]); assert.equal(g.sent.length, 2);
  assert.deepEqual(g.locks(), { lockCount: 3, releaseCount: 3, lockHeld: false });
  assert.equal(g.snapshot(), before);
});

test('production cannot arm, consume or report the TEST slow callback fault', () => {
  const g = google('production');
  for (const name of ['testRevolutionSlowManagerCallback', 'testRevolutionSlowManagerCallbackReceipt']) assert.throws(() => g.ctx[name](), /TEST project required/);
  g.properties.set('M1_TEST_SLOW_MANAGER', String(now + 120000));
  const body = { ...g.body, binding: makeBinding(id, now, 'managerReviewRead', 'production') }; delete body.original;
  g.post(body);
  assert.equal(g.sent.length, 1); assert.deepEqual(g.sleeps, []);
  assert.equal(g.properties.get('M1_TEST_SLOW_MANAGER'), String(now + 120000));
  assert.equal(g.properties.has('M1_TEST_SLOW_MANAGER_RECEIPT'), false);
  assert.deepEqual(g.locks(), { lockCount: 1, releaseCount: 1, lockHeld: false });
});
