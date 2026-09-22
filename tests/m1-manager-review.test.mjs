import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dayPlan, datesThrough, periodFor, localNow, proposedReview, validateRead } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { handleManagerReview } from '../netlify/functions/m1-manager-review.mjs';
import { emptyAddedClasses, publicAddedClasses } from '../netlify/functions/_lib/m1-added-classes.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
const now = new Date('2026-09-22T15:00:00Z');
const schedule = { current: true, timezone: 'America/New_York', days: { Tuesday: ['9:00 AM TEST BJJ', '6:00 PM TEST BJJ'] } };
const added = publicAddedClasses(emptyAddedClasses('rev'), +now);
const record = (name = 'TEST One', label = '9:00 AM TEST BJJ') => ({ recordId: `id-${name}`, date: '2026-09-21', classLabel: label, instructor: name, duration: 1, reviewRequired: false });
const day = (records = []) => ({ date: '2026-09-21', attendanceHash: 'a'.repeat(64), records, warnings: [], review: null });
const request = d => ({ action: 'complete', requestId: 'manager-1234567890123456', date: d.date, revision: 0, attendanceHash: d.attendanceHash, scheduleHash: dayPlan(d, schedule, added, now).scheduleHash, decisions: [] });
test('actual payroll dates, local midnight and unresolved rollover coverage', () => {
  assert.deepEqual(periodFor('2026-09-20'), { start: '2026-09-07', end: '2026-09-20' });
  assert.deepEqual(periodFor('2026-09-21'), { start: '2026-09-21', end: '2026-10-04' });
  assert.equal(localNow(new Date('2026-09-23T01:00:00Z')).date, '2026-09-22');
  assert.equal(datesThrough('2026-10-05')[0], '2026-09-07');
  assert.equal(datesThrough('2026-10-05').at(-1), '2026-10-05');
});
test('every instructor and unlisted class stays visible; historical timetable is not invented', () => {
  const plan = dayPlan(day([record(), record('TEST Two'), record('TEST Three', '10:00 AM TEST unscheduled')]), schedule, added, now);
  assert.equal(plan.historyKnown, false);
  assert.equal(plan.classes.length, 2);
  assert.equal(plan.classes[0].records.length, 2);
  assert.ok(plan.classes.every(row => !row.scheduled));
  assert.equal(plan.complete, false);
  assert.equal(plan.canComplete, true);
});
test('today includes schedule blanks, excludes upcoming from missing and cannot complete', () => {
  const d = { ...day(), date: '2026-09-22' };
  const plan = dayPlan(d, schedule, added, now);
  assert.equal(plan.classes.length, 2);
  assert.equal(plan.classes[1].upcoming, true);
  assert.equal(plan.canComplete, false);
  assert.throws(() => proposedReview(request(d), d, schedule, added, now), /upcoming/);
});
test('unknown remains pending; not-held cannot erase teaching', () => {
  const d = day([record()]);
  const input = request(d);
  input.decisions = [{ label: '9:00 AM TEST BJJ', outcome: 'unknown' }];
  assert.throws(() => proposedReview(input, d, schedule, added, now), /unknown/);
  input.action = 'partial';
  assert.equal(proposedReview(input, d, schedule, added, now).action, 'partial');
  input.decisions[0].outcome = 'not-held';
  assert.throws(() => proposedReview(input, d, schedule, added, now), /Recorded teaching/);
});
test('later real data reopens; identical upload does not; unrelated schedule revisions do not', () => {
  const d = day([record()]);
  const saved = proposedReview(request(d), d, schedule, added, now);
  d.review = { ...saved, reviewer: 'Andrew Smith', time: now.toISOString(), revision: 1 };
  assert.equal(dayPlan(d, schedule, added, now).complete, true);
  assert.equal(dayPlan(d, { ...schedule, days: { Tuesday: ['8:00 PM Changed today'] } }, added, now).complete, true);
  assert.equal(dayPlan({ ...d, attendanceHash: 'b'.repeat(64), records: [...d.records, record('TEST Late')] }, schedule, added, now).complete, false);
  assert.equal(dayPlan(d, schedule, added, now).complete, true);
});
test('current relevant schedule changes reopen a completed review', () => {
  const late = new Date('2026-09-23T03:00:00Z');
  const d = { ...day([record()]), date: '2026-09-22' };
  d.records[0].date = d.date;
  const one = { ...schedule, days: { Tuesday: ['9:00 AM TEST BJJ'] } };
  const input = { ...request(d), scheduleHash: dayPlan(d, one, added, late).scheduleHash };
  d.review = { ...proposedReview(input, d, one, added, late), revision: 1 };
  assert.equal(dayPlan(d, one, added, late).complete, true);
  assert.equal(dayPlan(d, schedule, added, late).complete, false);
});
test('stale attendance/reviewer/schedule and incomplete reads fail closed', () => {
  const d = day([record()]);
  for (const change of [{ attendanceHash: 'b'.repeat(64) }, { revision: 1 }, { scheduleHash: 'b'.repeat(64) }]) assert.throws(() => proposedReview({ ...request(d), ...change }, d, schedule, added, now), /changed/);
  assert.throws(() => validateRead({ ok: true, complete: true, days: [] }, 'rev', '2026-09-22'));
});

function sheet(initial = []) {
  const rows = structuredClone(initial);
  return { rows, getDataRange: () => ({ getValues: () => structuredClone(rows) }), getLastRow: () => rows.length, appendRow: r => rows.push([...r]), getRange: (r, c) => ({ setNumberFormat() { return this; }, setValues(values) { values.forEach((row, i) => { rows[r - 1 + i] = [...row]; }); }, setValue(value) { rows[r - 1][c - 1] = value; } }) };
}
function receiver() {
  const sheets = new Map();
  const records = [];
  let failWrite = false;
  const spreadsheet = { getName: () => 'RBJJ M1 — TEST', getSheetByName: name => sheets.get(name), insertSheet: name => { if (failWrite) throw new Error('TEST failed save'); const value = sheet(); sheets.set(name, value); return value; } };
  const context = vm.createContext({ Date, JSON, GIB_M1_MANAGER_REVIEW_TEST_ENABLED: true, GIB_M1_ADMIN_NAMES_: ['Andrew Smith', 'Stuart Turner'], configuredDeploymentTarget_: () => 'test', requestTarget_: b => b.target, adminActionAuthorized_: b => b.token === 'synthetic', rejectedAuthResult_: () => ({ ok: false }), jsonResult_: value => JSON.parse(JSON.stringify(value)), todayNewYork_: () => '2026-09-22', validCalendarDate_: s => /^\d{4}-\d{2}-\d{2}$/.test(s), displayDate_: s => String(s), openExpectedSpreadsheet_: () => spreadsheet, signinsSheet_: () => ({}), readSignins_: () => ({ records }), activeRecord_: r => r.status !== 'VOID', reviewRecordIssue_: () => false, publicRecord_: r => ({ ...record(r.instructor, r.classLabel), date: r.date, recordId: r.rowId }), obviousTestValue_: s => /TEST/.test(s), LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }, SpreadsheetApp: { flush() {} }, Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, text) => [...createHash('sha256').update(text).digest()] } });
  vm.runInContext(readFileSync(new URL('../integrations/google-apps-script/GibM1ManagerReview.gs', import.meta.url), 'utf8'), context);
  const call = body => context.managerReviewAction_({ token: 'synthetic', target: 'test', gym: 'rev', from: '2026-09-07', to: '2026-09-22', adminName: 'Andrew Smith', ...body });
  return { call, records, sheets, context, fail: () => { failWrite = true; } };
}
test('central journal survives sessions, is append-only and rejects simultaneous stale completion', () => {
  const r = receiver();
  const read = r.call({ action: 'managerReviewRead' });
  const d = read.days.find(d => d.date === '2026-09-21');
  const input = proposedReview(request(d), d, schedule, added, now);
  assert.equal(r.call({ action: 'managerReviewSave', date: d.date, review: input }).saved, true);
  assert.equal(r.call({ action: 'managerReviewSave', date: d.date, review: input }).retry, true);
  const reopened = r.call({ action: 'managerReviewRead', adminName: 'Stuart Turner' }).days.find(d => d.date === input.date);
  assert.equal(reopened.review.reviewer, 'Andrew Smith');
  assert.equal(reopened.review.revision, 1);
  const stale = r.call({ action: 'managerReviewSave', date: d.date, review: { ...input, requestId: 'manager-another1234567890' } });
  assert.equal(stale.conflict, true);
  assert.equal(r.sheets.get('Manager Reviews').rows.length, 2);
  const receipt = r.call({ action: 'managerReviewRead', check: input }).receipt;
  assert.equal(receipt.saved, true);
});
test('late upload between read and save is rejected under the attendance lock; failed save never succeeds', () => {
  const r = receiver();
  const d = r.call({ action: 'managerReviewRead' }).days.find(d => d.date === '2026-09-21');
  const input = proposedReview(request(d), d, schedule, added, now);
  r.records.push({ rowId: 'test-late', date: d.date, instructor: 'TEST Late', classLabel: '9:00 AM TEST BJJ', duration: 1, status: 'OK' });
  assert.equal(r.call({ action: 'managerReviewSave', date: d.date, review: input }).conflict, true);
  assert.equal(r.sheets.size, 0);
  const failed = receiver(); failed.fail();
  assert.throws(() => failed.call({ action: 'managerReviewSave', date: d.date, review: input }), /failed save/);
  assert.equal(failed.sheets.size, 0);
});
test('wrong gym, production target and unauthenticated receiver actions are denied', () => {
  const r = receiver();
  for (const override of [{ gym: 'richmond' }, { target: 'production' }, { token: 'wrong' }]) assert.equal(r.call({ action: 'managerReviewRead', ...override }).ok, false);
  r.context.GIB_M1_MANAGER_REVIEW_TEST_ENABLED = false;
  assert.equal(r.call({ action: 'managerReviewRead' }).ok, false);
});

test('ambiguous permanent IDs keep an otherwise complete day pending', () => {
  const r = receiver();
  r.records.push({ rowId: 'same-id', date: '2026-09-21', instructor: 'TEST One', classLabel: '9:00 AM TEST BJJ', duration: 1, status: 'OK' });
  r.records.push({ ...r.records[0], instructor: 'TEST Two' });
  const d = r.call({ action: 'managerReviewRead' }).days.find(d => d.date === '2026-09-21');
  assert.equal(d.records.length, 2);
  assert.equal(d.records.every(record => !record.correctable), true);
  assert.equal(dayPlan(d, schedule, added, now).canComplete, false);
});

test('TEST correction binds its date and preserves a conflicting existing audit', () => {
  const r = receiver();
  const original = { rowId: 'test-correction', date: '2026-09-21', instructor: 'TEST One', classLabel: '9:00 AM TEST BJJ', duration: 1, status: 'OK', site: 'Rev' };
  r.records.push(original);
  r.context.safeText_ = value => String(value).trim();
  r.context.exactText_ = r.context.cleanText_ = value => String(value ?? '').trim();
  r.context.GIB_M1_AUDIT_SHEET_ = 'Admin Audit';
  const audit = sheet([[], [1, 'Stuart Turner', '2026-09-22T15:00:00Z', 'TEST One', original.date, original.classLabel, 'Rev', 1, 'Prior reason', 'voided', original.rowId]]);
  r.sheets.set('Admin Audit', audit);
  r.context.adminAuditValues_ = value => value.rows;
  r.context.sameExactAdminAudit_ = (row, value) => row[1] === value.adminName && row[8] === value.reason;
  r.context.readSignins_ = () => ({ records: r.records, indexes: { status: 10 } });
  r.context.appendAdminAudit_ = () => { throw new Error('Existing audit must not be changed'); };
  const input = { action: 'managerReviewVoid', date: original.date, recordId: original.rowId, reason: 'Different reason', fingerprint: r.context.managerAttendanceHash_([original]) };
  assert.equal(r.call({ ...input, date: '2026-09-20' }).ok, false);
  assert.equal(r.call(input).conflict, true);
  assert.equal(original.status, 'OK');
  assert.equal(audit.rows.length, 2);
});

const origin = 'https://deploy-preview-999--gib-live.netlify.app';
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER/exec', GIB_TEST_WEBHOOK_TOKEN: 'synthetic-test-transport-1234567890', GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-test-admin-1234567890abcdef' };
const dependencies = { enabled: true, env, now: +now, context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } }, schedule, addedStore: { getWithMetadata: async () => null } };
test('public badge contains only day count; private API requires existing authenticated session', async () => {
  const ledger = receiver().call({ action: 'managerReviewRead' });
  ledger.days[0].records.push({ ...record('TEST Private Name'), date: ledger.days[0].date });
  const deps = { ...dependencies, fetch: async () => new Response(JSON.stringify(ledger)) };
  const response = await handleManagerReview(new Request(`${origin}/api/m1-manager-review`), deps);
  assert.equal(response.status, 200, await response.clone().text());
  const text = await response.text();
  assert.doesNotMatch(text, /TEST Private Name|reviewer|records|classes/);
  assert.equal(JSON.parse(text).pendingDays, 16);
  const denied = await handleManagerReview(new Request(`${origin}/api/m1-manager-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"read"}' }), deps);
  assert.equal(denied.status, 401);
  const runtime = runtimeConfig(env, { admin: true, requestUrl: origin });
  const requestToken = 'x'.repeat(43);
  const cookie = createAdminSession('Andrew Smith', runtime.sessionSecret, +now, requestToken);
  const response2 = await handleManagerReview(new Request(`${origin}/api/m1-manager-review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`, [ADMIN_REQUEST_HEADER]: requestToken }, body: '{"action":"read"}' }), deps);
  assert.equal(response2.status, 200);
  assert.match(await response2.text(), /TEST Private Name/);
});
test('production origins and incomplete or stale backend reads never report caught up', async () => {
  const blocked = await handleManagerReview(new Request('https://gib-live.netlify.app/api/m1-manager-review'), dependencies);
  assert.equal(blocked.status, 403);
  for (const value of [{ ok: true, days: [] }, { ok: false }, '<html>Google error</html>']) {
    const response = await handleManagerReview(new Request(`${origin}/api/m1-manager-review`), { ...dependencies, fetch: async () => new Response(typeof value === 'string' ? value : JSON.stringify(value)) });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /pendingDays/);
  }
});

test('save returns only a confirmed receipt, with the updated view read separately', async () => {
  const r = receiver();
  const ledger = r.call({ action: 'managerReviewRead' });
  const d = ledger.days.find(day => day.date === '2026-09-21');
  const runtime = runtimeConfig(env, { admin: true, requestUrl: origin });
  const requestToken = 'x'.repeat(43);
  const cookie = createAdminSession('Andrew Smith', runtime.sessionSecret, +now, requestToken);
  const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`, [ADMIN_REQUEST_HEADER]: requestToken };
  const actions = [];
  const deps = { ...dependencies, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    actions.push(body.action);
    return new Response(JSON.stringify(r.call({ ...body, token: 'synthetic' })));
  } };
  const saved = await handleManagerReview(new Request(`${origin}/api/m1-manager-review`, { method: 'POST', headers, body: JSON.stringify(request(d)) }), deps);
  const receipt = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(receipt.receipt.saved, true);
  assert.equal(receipt.days, undefined);
  assert.deepEqual(actions, ['managerReviewRead', 'managerReviewSave']);
  assert.equal(r.sheets.get('Manager Reviews').rows.length, 2);
  const view = await handleManagerReview(new Request(`${origin}/api/m1-manager-review`, { method: 'POST', headers, body: '{"action":"read"}' }), deps);
  assert.equal((await view.json()).days.find(day => day.date === d.date).complete, true);
});
