import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { handleManagerReview, assembleManagerRead } from '../netlify/functions/m1-manager-review.mjs';
import { managerReviewScope } from '../netlify/functions/_lib/m1-manager-scope.mjs';
import { localNow, dayPlan, proposedReview } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { emptyAddedClasses, publicAddedClasses } from '../netlify/functions/_lib/m1-added-classes.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';

const morning = Date.parse('2026-09-22T15:00:00Z');
const taught = '9:00 AM TEST BJJ', canceled = '10:00 AM TEST canceled', evening = '6:00 PM TEST BJJ';
const reviewer = 'Stuart Turner';
const source = name => readFileSync(new URL(`../integrations/google-apps-script/${name}`, import.meta.url), 'utf8');

// Actual receiver + actual Netlify handler. Only the Google/Sheets APIs and the
// wire delivery are memory fakes; no manager read, save, hash or receipt logic is replaced.
function fixture(target = 'test', liveEnabled = true) {
  let now = morning, loss = false, readsUnavailable = false, lockHeld = false, sequence = 0;
  const sheets = new Map(), calls = [];
  const tokens = { transport: `synthetic-${target}-transport-1234567890`, admin: `synthetic-${target}-admin-1234567890abcdef` };
  const origin = target === 'test' ? 'https://deploy-preview-89--gib-live.netlify.app' : 'https://gib-live.netlify.app';
  const env = target === 'test'
    ? { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER/exec', GIB_TEST_WEBHOOK_TOKEN: tokens.transport, GIB_TEST_ADMIN_ACTION_TOKEN: tokens.admin }
    : { GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION_CONTRACT_RECEIVER/exec', GIB_M1_PRODUCTION_WEBHOOK_TOKEN: tokens.transport, GIB_M1_ADMIN_ACTION_TOKEN: tokens.admin, GIB_M1_ADMIN_PASSPHRASE: 'isolated fictional contract words' };
  const sheet = initial => {
    const rows = structuredClone(initial);
    return { rows, appendRow(row) { assert.equal(lockHeld, true); rows.push([...row]); }, getDataRange: () => ({ getValues: () => structuredClone(rows) }), getLastRow: () => rows.length,
      getLastColumn: () => rows[0]?.length || 0, getMaxRows: () => 1000, setFrozenRows() {},
      getRange(row, column, height, width) { return {
        getValues: () => Array.from({ length: height }, (_, i) => (rows[row - 1 + i] || []).slice(column - 1, column - 1 + width)),
        getNotes: () => Array.from({ length: height }, () => ['']),
        setNumberFormat() { return this; },
        setValues(values) { assert.equal(lockHeld, true); values.forEach((value, i) => { const destination = rows[row - 1 + i] ||= []; value.forEach((cell, j) => { destination[column - 1 + j] = cell; }); }); return this; },
        setValue(value) { assert.equal(lockHeld, true); rows[row - 1][column - 1] = value; return this; }
      }; }
    };
  };
  sheets.set('Signins', sheet([['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Device', 'Build', 'Notes', 'Status']]));
  const name = target === 'test' ? 'RBJJ M1 — TEST' : 'RBJJ M1 — PRODUCTION';
  const spreadsheet = { getName: () => name, getSheetByName: name => sheets.get(name), insertSheet(name) { assert.equal(lockHeld, true); const value = sheet([]); sheets.set(name, value); return value; } };
  const properties = new Map([['GIB_M1_RECEIVER_TRANSPORT_TOKEN', tokens.transport], ['GIB_M1_ADMIN_ACTION_TOKEN', tokens.admin]]);
  const formatDate = (date, timeZone, pattern) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}:${parts.second}`;
    if (pattern === 'yyyy-MM-dd') return day;
    if (pattern === 'yyyy-MM-dd HH:mm:ss') return `${day} ${time}`;
    if (pattern === "yyyy-MM-dd'T'HH:mm:ss") return `${day}T${time}`;
    if (pattern === 'Z') return '-0400'; // Both fixed fixture dates are in New York daylight time.
    throw new Error('Unexpected fixture date format');
  };
  const context = vm.createContext({ Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    EXPECTED_SPREADSHEET_NAME: name, ...(target === 'test' ? { TEST_SPREADSHEET_ID: 'synthetic-test-sheet' } : { SPREADSHEET_ID: 'synthetic-production-contract-sheet' }),
    GIB_M1_ALLOWED_TARGET: target, GIB_M1_MANAGER_REVIEW_TEST_ENABLED: target === 'test', GIB_M1_MANAGER_REVIEW_LIVE_ENABLED: target === 'production' && liveEnabled,
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ getContent: () => text, setMimeType() { return this; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || '' }) },
    SpreadsheetApp: { openById: () => spreadsheet, flush() { assert.equal(lockHeld, true); } },
    LockService: { getScriptLock: () => ({ tryLock() { assert.equal(lockHeld, false, 'no nested attendance lock'); lockHeld = true; return true; }, releaseLock() { assert.equal(lockHeld, true); lockHeld = false; } }) },
    Utilities: { formatDate, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, text) => [...createHash('sha256').update(text).digest()] }
  });
  for (const file of ['GibM1Receiver.gs', 'GibM1ManagerReview.gs']) vm.runInContext(source(file), context);
  const post = body => JSON.parse(context.adReceiverV2_({ postData: { contents: JSON.stringify(body) } }).getContent());
  const envelope = () => ({ token: tokens.transport, adminActionToken: tokens.admin, target, adminName: reviewer, gym: 'rev', from: '2026-09-07', to: localNow(new Date(now)).date });
  const transport = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(structuredClone(body));
    if (readsUnavailable && body.action === 'managerReviewRead') throw new Error('Synthetic connection unavailable');
    const result = post(body);
    if (loss && body.action === 'managerReviewSave') {
      loss = false; assert.equal(result.saved, true, JSON.stringify(result));
      throw new Error('Synthetic ordinary reply lost after authoritative save');
    }
    return Response.json(result);
  };
  const deps = () => ({ enabled: true, target, env, now, fetch: transport, nativeHttps: transport,
    context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: target === 'test' ? 'deploy-preview' : 'production', published: target === 'production' } },
    schedule: { current: true, timezone: 'America/New_York', days: { Tuesday: [taught, canceled, evening] } }, addedStore: { getWithMetadata: async () => null } });
  const request = (body, name = reviewer) => {
    const proof = 's'.repeat(43), runtime = runtimeConfig(env, { admin: true, requestUrl: origin });
    const cookie = createAdminSession(name, runtime.sessionSecret, now, proof);
    return new Request(`${origin}/api/m1-manager-review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`, [ADMIN_REQUEST_HEADER]: proof }, body: JSON.stringify(body) });
  };
  const ledger = () => post({ ...envelope(), action: 'managerReviewRead' });
  const view = async () => { const req = request({ action: 'read' }); return assembleManagerRead(ledger(), req, managerReviewScope(req, deps()), deps()); };
  const input = async (action, date, decisions = []) => {
    const day = (await view()).days.find(day => day.date === date);
    return { action, requestId: `manager-synthetic-request-${String(++sequence).padStart(16, '0')}`, date, revision: day.revision, attendanceHash: day.attendanceHash, scheduleHash: day.scheduleHash, decisions };
  };
  const save = async (body, overrides = {}, name = reviewer) => {
    const response = await handleManagerReview(request(body, name), { ...deps(), ...overrides });
    return { status: response.status, body: await response.json() };
  };
  const add = (date, suffix, instructor = `TEST instructor ${suffix}`, classLabel = taught) => {
    const body = { ...envelope(), action: 'addMissedInstructor', requestId: `m1-${date}-${suffix.repeat(24)}`, date, classLabel, duration: 1, instructor, site: 'Rev', notes: 'DO NOT PAY', reason: 'TEST isolated fixture' };
    const receipt = post(body); assert.equal(receipt.ok, true, JSON.stringify(receipt)); return { body, receipt };
  };
  return { context, target, sheets, calls, post, envelope, ledger, view, input, save, add, request, deps,
    loseNextSaveReply() { loss = true; }, failReads(value) { readsUnavailable = value; }, setTime(value) { now = Date.parse(value); },
    journal: () => structuredClone(sheets.get('Manager Reviews')?.rows || []),
    attendanceAndAudit: () => JSON.stringify([...sheets].filter(([name]) => name !== 'Manager Reviews').map(([name, sheet]) => [name, sheet.rows])) };
}

for (const target of ['test', 'production']) {
  test(`${target}: lost partial save is centrally confirmed on original retry without repeating the write or dropping unknowns`, async () => {
    const f = fixture(target); f.add('2026-09-22', '1'); f.add('2026-09-22', '2');
    const before = f.attendanceAndAudit();
    const original = await f.input('partial', '2026-09-22', [{ label: taught, outcome: 'unknown' }, { label: canceled, outcome: 'not-held' }]);
    const originalWire = JSON.stringify(original);
    f.loseNextSaveReply();
    const lost = await f.save(original);
    assert.equal(lost.status, 503); assert.equal(lost.body.ok, false); assert.equal(Object.hasOwn(lost.body, 'receipt'), false);
    assert.equal(f.journal().length, 2, 'the lost reply must follow one authoritative append');
    const savedHistory = f.journal();
    f.failReads(true);
    const stillUnknown = await f.save(original);
    assert.equal(stillUnknown.status, 503); assert.equal(stillUnknown.body.ok, false); assert.equal(Object.hasOwn(stillUnknown.body, 'receipt'), false);
    assert.deepEqual(f.journal(), savedHistory);
    f.failReads(false);
    const recovered = await f.save(JSON.parse(originalWire));
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.deepEqual(recovered.body.receipt, { saved: true, requestId: original.requestId, revision: 1 });
    const day = recovered.body.days.find(day => day.date === original.date);
    assert.equal(day.complete, false); assert.equal(day.revision, 1); assert.equal(day.classes.find(row => row.label === taught).records.length, 2);
    assert.equal(day.classes.find(row => row.label === taught).outcome, 'unknown');
    assert.equal(day.classes.find(row => row.label === canceled).outcome, 'not-held');
    assert.equal(day.classes.find(row => row.label === evening).upcoming, true);
    assert.deepEqual(f.journal(), savedHistory); assert.equal(f.attendanceAndAudit(), before); assert.equal(JSON.stringify(original), originalWire);
    assert.equal(f.calls.filter(body => body.action === 'managerReviewSave').length, 1);
    assert.ok(f.calls.filter(body => body.action === 'managerReviewRead').every(body => JSON.stringify(body.check) === originalWire));
    const directRetry = f.post(f.calls.find(body => body.action === 'managerReviewSave'));
    assert.equal(directRetry.retry, true); assert.equal(directRetry.revision, 1); assert.deepEqual(f.journal(), savedHistory);
  });

  test(`${target}: original complete-save receipt survives later attendance and another review without restoring the old all-clear`, async () => {
    const f = fixture(target); f.add('2026-09-21', '1'); f.add('2026-09-21', '2');
    const original = await f.input('complete', '2026-09-21');
    f.loseNextSaveReply(); assert.equal((await f.save(original)).status, 503);
    const originalHistory = f.journal(); assert.equal(originalHistory.length, 2);
    assert.equal((await f.view()).days.find(day => day.date === original.date).complete, true);
    const late = f.add(original.date, '3', 'TEST legitimate additional instructor');
    const afterLate = f.attendanceAndAudit();
    assert.equal((await f.view()).days.find(day => day.date === original.date).complete, false);
    const recovered = await f.save(structuredClone(original));
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body)); assert.equal(recovered.body.receipt.revision, 1);
    const reopened = recovered.body.days.find(day => day.date === original.date);
    assert.equal(reopened.complete, false); assert.equal(reopened.changed, true); assert.equal(reopened.classes[0].records.length, 3);
    assert.deepEqual(f.journal(), originalHistory);
    const later = await f.input('partial', original.date, [{ label: taught, outcome: 'unknown' }]);
    assert.equal((await f.save(later, {}, 'Andrew Smith')).status, 200);
    const laterHistory = f.journal(); assert.equal(laterHistory.length, 3);
    const retriedAgain = await f.save(original);
    assert.equal(retriedAgain.status, 200, JSON.stringify(retriedAgain.body)); assert.equal(retriedAgain.body.receipt.revision, 1);
    const current = retriedAgain.body.days.find(day => day.date === original.date);
    assert.equal(current.revision, 2); assert.equal(current.complete, false); assert.equal(current.reviewer, 'Andrew Smith');
    assert.equal(current.classes[0].outcome, 'unknown');
    assert.deepEqual(f.journal(), laterHistory); assert.equal(f.attendanceAndAudit(), afterLate);
    assert.equal(f.calls.filter(body => body.action === 'managerReviewSave').length, 2);
    // The real receiver's idempotent write retry also preserves the later journal.
    assert.equal(f.post(f.calls.find(body => body.action === 'managerReviewSave')).retry, true);
    assert.deepEqual(f.post(late.body), late.receipt, 'same addition ID returns its original receipt');
    assert.deepEqual(f.journal(), laterHistory); assert.equal(f.attendanceAndAudit(), afterLate);
  });
}

test('actual Netlify validation preserves occurrence cancellation, blocks unknown/upcoming/recorded teaching, then permits a resolved day', async () => {
  const f = fixture(); f.add('2026-09-22', '1'); f.add('2026-09-22', '2');
  const before = f.attendanceAndAudit();
  const attempt = async (action, decisions) => f.save(await f.input(action, '2026-09-22', decisions));
  for (const [action, decisions] of [
    ['complete', []], ['complete', [{ label: taught, outcome: 'unknown' }]],
    ['partial', [{ label: taught, outcome: 'not-held' }]], ['partial', [{ label: evening, outcome: 'not-held' }]]
  ]) assert.equal((await attempt(action, decisions)).status, 409);
  assert.equal(f.journal().length, 0);
  assert.equal((await attempt('partial', [{ label: canceled, outcome: 'not-held' }, { label: taught, outcome: 'unknown' }])).status, 200);
  const partial = (await f.view()).days.find(day => day.date === '2026-09-22');
  assert.equal(partial.complete, false); assert.equal(partial.canComplete, false);
  f.setTime('2026-09-23T00:00:00Z'); // 8 PM on September 22 in the gym's time zone.
  assert.equal((await attempt('complete', [{ label: canceled, outcome: 'not-held' }, { label: evening, outcome: 'not-held' }])).status, 200);
  const completed = (await f.view()).days.find(day => day.date === '2026-09-22');
  assert.equal(completed.complete, true); assert.equal(completed.canComplete, true); assert.equal(completed.revision, 2);
  assert.equal(completed.classes.filter(row => row.outcome === 'not-held').length, 2);
  assert.equal(completed.classes.find(row => row.label === taught).records.length, 2);
  assert.equal(f.journal().length, 3); assert.equal(f.attendanceAndAudit(), before);
  assert.ok((await f.view()).days.filter(day => day.date !== completed.date).every(day => !day.decisions.length));
});

test('original save recovery rejects a changed decision or reviewer under the retained request ID and preserves history', async () => {
  const f = fixture(); f.add('2026-09-21', '1');
  const original = await f.input('partial', '2026-09-21', [{ label: taught, outcome: 'unknown' }]);
  f.loseNextSaveReply(); assert.equal((await f.save(original)).status, 503);
  const history = f.journal(), records = f.attendanceAndAudit();
  assert.equal((await f.save({ ...original, decisions: [] })).status, 503);
  assert.equal((await f.save(original, {}, 'Andrew Smith')).status, 503);
  assert.equal(f.calls.filter(body => body.action === 'managerReviewSave').length, 1);
  assert.deepEqual(f.journal(), history); assert.equal(f.attendanceAndAudit(), records);
  assert.equal((await f.save(original)).status, 200); assert.deepEqual(f.journal(), history);
});

test('production save remains blocked by either live switch and never uses the TEST receiver or a preview publication', async () => {
  const f = fixture('production');
  const original = await f.input('complete', '2026-09-21');
  for (const overrides of [
    { enabled: false }, { target: 'test' },
    { context: { ...f.deps().context, deploy: { context: 'deploy-preview', published: false } } }
  ]) {
    const result = await f.save(original, overrides); assert.ok([403, 404].includes(result.status));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.journal().length, 0);
  f.context.GIB_M1_MANAGER_REVIEW_LIVE_ENABLED = false;
  const blocked = await f.save(original);
  assert.equal(blocked.status, 503); assert.equal(blocked.body.ok, false); assert.equal(f.journal().length, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].target, 'production');
  assert.equal(f.post({ ...f.envelope(), target: 'test', action: 'managerReviewRead' }).ok, false);
});

test('partial proposal may retain only a current inherited cancellation conflict; it remains unresolved and cannot bypass freshness or upcoming guards', () => {
  const stamp = new Date(morning), schedule = { current: true, timezone: 'America/New_York', days: { Tuesday: [taught, canceled, evening] } };
  const added = publicAddedClasses(emptyAddedClasses('rev'), +stamp);
  const decision = { label: canceled, outcome: 'not-held' };
  const record = { recordId: 'original-late-id', date: '2026-09-22', classLabel: canceled, instructor: 'TEST late instructor', duration: 1, reviewRequired: false };
  const day = { date: record.date, attendanceHash: 'b'.repeat(64), records: [record], warnings: [],
    review: { revision: 3, action: 'complete', attendanceHash: 'a'.repeat(64), scheduleHash: 'c'.repeat(64), decisions: [decision], snapshot: { base: schedule.days.Tuesday } } };
  const input = { action: 'partial', requestId: 'manager-partial-conflict-0000000000000001', date: day.date, revision: 3, attendanceHash: day.attendanceHash,
    scheduleHash: dayPlan(day, schedule, added, stamp).scheduleHash, decisions: [decision, { label: taught, outcome: 'unknown' }] };
  const before = JSON.stringify(day), saved = proposedReview(input, day, schedule, added, stamp);
  assert.deepEqual(saved.decisions, input.decisions);
  assert.deepEqual(saved.snapshot.classes.find(row => row.label === canceled).records, [record]);
  const plan = dayPlan({ ...day, review: saved }, schedule, added, stamp);
  assert.equal(plan.classes.find(row => row.label === canceled).conflict, true);
  assert.equal(plan.classes.find(row => row.label === canceled).unresolved, true);
  assert.equal(plan.complete, false); assert.equal(plan.canComplete, false); assert.equal(JSON.stringify(day), before);
  for (const change of [{ action: 'complete' }, { revision: 2 }, { attendanceHash: 'a'.repeat(64) }, { scheduleHash: 'a'.repeat(64) }]) {
    assert.throws(() => proposedReview({ ...input, ...change }, day, schedule, added, stamp));
  }
  // Neither historical permission nor an unknown in the current revision counts.
  for (const decisions of [[], [{ label: canceled, outcome: 'unknown' }]]) {
    assert.throws(() => proposedReview(input, { ...day, review: { ...day.review, decisions } }, schedule, added, stamp), /Recorded teaching/);
  }
  const futureDay = { ...day, records: [{ ...record, classLabel: evening }], review: { ...day.review, decisions: [{ label: evening, outcome: 'not-held' }] } };
  assert.throws(() => proposedReview({ ...input, decisions: [{ label: evening, outcome: 'not-held' }] }, futureDay, schedule, added, stamp), /upcoming/);
});

for (const target of ['test', 'production']) {
  test(`${target}: late teaching conflict permits unrelated partial progress without changing records, old history or same-request recovery`, async () => {
    const f = fixture(target); f.add('2026-09-22', '1');
    const cancellation = { label: canceled, outcome: 'not-held' };
    const original = await f.input('partial', '2026-09-22', [cancellation]);
    f.loseNextSaveReply(); assert.equal((await f.save(original)).status, 503);
    const oldHistory = f.journal(); assert.equal(oldHistory.length, 2);
    const stale = await f.input('partial', original.date, [cancellation, { label: taught, outcome: 'unknown' }]);
    const late = f.add(original.date, '2', 'TEST actual late instructor', canceled);
    const records = f.attendanceAndAudit();
    assert.equal((await f.save(stale)).status, 409, 'unsaved old attendance hash cannot use the inherited-decision exception');
    const recoveredOriginal = await f.save(original);
    assert.equal(recoveredOriginal.status, 200); assert.equal(recoveredOriginal.body.receipt.revision, 1);
    assert.equal(recoveredOriginal.body.days.find(day => day.date === original.date).classes.find(row => row.label === canceled).conflict, true);
    assert.deepEqual(f.journal(), oldHistory);
    const progress = await f.input('partial', original.date, [cancellation, { label: taught, outcome: 'unknown' }]);
    const partial = await f.save(progress);
    assert.equal(partial.status, 200, JSON.stringify(partial.body)); assert.equal(partial.body.receipt.revision, 2);
    const day = (await f.view()).days.find(day => day.date === original.date), conflicting = day.classes.find(row => row.label === canceled);
    assert.equal(day.complete, false); assert.equal(day.canComplete, false); assert.equal(conflicting.conflict, true); assert.equal(conflicting.unresolved, true);
    assert.equal(conflicting.records[0].recordId, late.receipt.linkedRecordId);
    assert.equal(day.classes.find(row => row.label === taught).outcome, 'unknown');
    assert.deepEqual(f.journal().slice(0, oldHistory.length), oldHistory); assert.equal(f.attendanceAndAudit(), records);
    const progressHistory = f.journal();
    assert.equal((await f.save(progress)).body.receipt.revision, 2); assert.deepEqual(f.journal(), progressHistory);
    assert.equal((await f.save({ ...stale, attendanceHash: progress.attendanceHash })).status, 409, 'current hash cannot excuse an old unsaved review revision');
    // Even after all class times pass, inherited conflict cannot complete the day.
    f.setTime('2026-09-23T00:00:00Z');
    const complete = await f.input('complete', original.date, [cancellation, { label: evening, outcome: 'not-held' }]);
    assert.equal((await f.save(complete)).status, 409); assert.deepEqual(f.journal(), progressHistory);
    // Once resolved in a new partial revision, an old not-held may not be reintroduced.
    const resolved = await f.input('partial', original.date, [{ label: taught, outcome: 'unknown' }]);
    assert.equal((await f.save(resolved)).status, 200);
    const resolvedHistory = f.journal(); assert.equal(resolvedHistory.length, 4);
    assert.equal((await f.save(await f.input('partial', original.date, [cancellation]))).status, 409);
    const originalAfterResolution = await f.save(original);
    assert.equal(originalAfterResolution.status, 200); assert.equal(originalAfterResolution.body.receipt.revision, 1);
    const current = originalAfterResolution.body.days.find(day => day.date === original.date);
    assert.equal(current.revision, 3); assert.equal(current.complete, false); assert.equal(current.classes.find(row => row.label === canceled).outcome, '');
    assert.deepEqual(f.journal(), resolvedHistory); assert.equal(f.attendanceAndAudit(), records);
    assert.equal(f.calls.filter(body => body.action === 'managerReviewSave').length, 3);
  });
}
