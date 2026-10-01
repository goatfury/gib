import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadDigestScheduleSnapshots } from '../netlify/functions/_lib/m1-attendance-digest-source.mjs';
import { addedClassesKey, mutateAddedClasses } from '../netlify/functions/_lib/m1-added-classes.mjs';
import { WORDPRESS_SCHEDULE_URL } from '../netlify/functions/_lib/m1-schedule-core.mjs';

const TODAY = '2026-09-25';
const NOW = Date.parse('2026-09-26T02:05:00.000Z'); // Still Friday in New York.
const observedAt = '2026-09-26T02:04:00.000Z';
const schedule = (overrides = {}) => ({ site: 'Rev', timezone: 'America/New_York', current: true, fallback: 'none', fetchedAt: observedAt, version: 'synthetic-authoritative-schedule', days: { Friday: ['6:00 PM TEST BJJ'] }, ...overrides });
class Store {
  entries = new Map(); sequence = 0; writes = [];
  async getWithMetadata(key, options) { assert.equal(options.consistency, 'strong'); const value = this.entries.get(key); return value ? structuredClone(value) : null; }
  async set(key, raw, options) {
    const previous = this.entries.get(key);
    if ((options.onlyIfNew && previous) || (options.onlyIfMatch && options.onlyIfMatch !== previous?.etag)) return { modified: false };
    this.entries.set(key, { data: JSON.parse(raw), etag: String(++this.sequence) }); this.writes.push(key); return { modified: true };
  }
}
function fixture() {
  const store = new Store(), addedStore = new Store();
  return { store, addedStore,
    args: { gym: 'rev', dates: [TODAY], now: NOW, store, closingTime: '22:00', cutoffConfirmed: true },
    deps: { currentSchedule: schedule(), addedStore } };
}
const dated = (date, base, reviewedAt = observedAt) => ({ date, base, reviewedAt });
const run = h => loadDigestScheduleSnapshots(h.args, h.deps);
const first = async h => (await run(h)).days[0];

test('observes only the actual New York date and persists a dated snapshot before applying the explicitly confirmed close', async () => {
  const h = fixture(), day = await first(h);
  assert.equal(day.status, 'complete'); assert.equal(day.observedAt, observedAt);
  assert.deepEqual(day.occurrences, [{ label: '6:00 PM TEST BJJ', startAt: '2026-09-25T22:00:00.000Z', endAt: null, cancelled: false, finishedAtCutoff: '2026-09-26T02:00:00.000Z', finishBasis: 'confirmed-gym-close' }]);
  assert.deepEqual(h.store.writes, ['schedules/test/rev/2026-09-25']);
  assert.equal(h.store.entries.get(h.store.writes[0]).data.date, TODAY);
  assert.match(day.sourceVersion, /^[a-f0-9]{64}$/);
});

test('the default internal loader supplies the real schedule handler with explicit TEST deployment scope', async () => {
  const h = fixture(); delete h.deps.currentSchedule;
  let fetched = 0;
  const fixtureBody = readFileSync(new URL('./fixtures/revolutionbjj-schedule-wordpress.json', import.meta.url), 'utf8');
  h.deps.scheduleDependencies = { env: {}, store: null, memory: { value: null, storedAt: 0, lastAttemptAt: 0, lastFailureReason: '' }, fetchImpl: async url => {
    assert.equal(url, WORDPRESS_SCHEDULE_URL); fetched++;
    const response = new Response(fixtureBody, { headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: WORDPRESS_SCHEDULE_URL }); return response;
  } };
  const result = await first(h);
  assert.equal(fetched, 1); assert.equal(result.status, 'complete', JSON.stringify(result)); assert.ok(result.occurrences.length >= 2);
  assert.equal(result.observedAt, new Date(NOW).toISOString());
});

test('unconfirmed cutoff never creates missing-class finish times but retains the observation for later confirmation', async () => {
  const h = fixture(); h.args.cutoffConfirmed = false;
  assert.deepEqual(await first(h), { date: TODAY, status: 'unavailable', code: 'CLASS_FINISH_UNCONFIRMED' });
  assert.equal(h.store.entries.size, 1);
  h.args.cutoffConfirmed = true;
  assert.equal((await first(h)).status, 'complete'); assert.equal(h.store.writes.length, 1, 'same observation is not duplicated');
  h.args.closingTime = '18:00';
  assert.equal((await first(h)).code, 'CLASS_FINISH_UNCONFIRMED', 'an occurrence at or after close is not presumed finished');
});

test('a confirmed reminder time is never treated as class-finish evidence and dated observations survive next-day reads', async () => {
  const h = fixture(); h.args.closingTime = '20:00'; h.args.cutoffConfirmed = true; h.args.classFinishCutoffConfirmed = false;
  assert.deepEqual(await first(h), { date: TODAY, status: 'unavailable', code: 'CLASS_FINISH_UNCONFIRMED' });
  const preserved = structuredClone([...h.store.entries]);
  assert.equal(h.store.entries.get('schedules/test/rev/' + TODAY).data.base[0].endAt, null);
  h.args.now = Date.parse('2026-09-27T00:00:00.000Z');
  assert.deepEqual(await first(h), { date: TODAY, status: 'unavailable', code: 'CLASS_FINISH_UNCONFIRMED' });
  assert.deepEqual([...h.store.entries], preserved, 'no historical schedule or finish is invented');
});

test('weekly current source never invents a past schedule; later validated review observations establish only their exact date', async () => {
  const h = fixture(); h.args.dates = ['2026-09-18', '2026-09-24', TODAY];
  h.args.reviewSnapshots = [dated('2026-09-24', ['7:00 AM TEST historical class'])];
  const days = (await run(h)).days;
  assert.equal(days[0].code, 'MISSING_DATED_SCHEDULE');
  assert.equal(days[1].status, 'complete'); assert.equal(days[1].observedAt, observedAt);
  assert.equal(days[1].occurrences[0].startAt, '2026-09-24T11:00:00.000Z');
  assert.equal(days[2].occurrences[0].label, '6:00 PM TEST BJJ');
  assert.equal(h.store.entries.has('schedules/test/rev/2026-09-18'), false);
});

test('an observed day survives reopening after midnight and cannot be replaced by the new weekly schedule', async () => {
  const h = fixture(); const original = await first(h), persisted = structuredClone([...h.store.entries]);
  h.args.now = Date.parse('2026-09-26T16:00:00.000Z');
  h.deps.loadCurrentSchedule = () => { throw new Error('past date must not fetch weekly source'); };
  const reopened = await first(h);
  assert.equal(reopened.status, 'complete'); assert.deepEqual(reopened.occurrences, original.occurrences); assert.deepEqual([...h.store.entries], persisted);
});

test('stale, fallback, wrong-gym, incomplete and failed current reads cannot reuse a previous today snapshot as success', async () => {
  const variants = [{ current: false }, { fallback: 'last-known-good' }, { fallback: 'bootstrap' }, { fallback: false }, { site: 'Richmond' }, { timezone: 'UTC' }, { fetchedAt: '2026-09-26T01:00:00.000Z' }, { fetchedAt: '2026-09-26T02:06:00.000Z' }, { days: {} }, { status: { current: false, fallback: 'last-known-good' } }];
  for (const variant of variants) {
    const h = fixture(); assert.equal((await first(h)).status, 'complete'); const stored = structuredClone([...h.store.entries]);
    h.deps.currentSchedule = schedule(variant);
    assert.equal((await first(h)).status, 'unavailable', JSON.stringify(variant)); assert.deepEqual([...h.store.entries], stored);
  }
  const h = fixture(); h.deps.loadCurrentSchedule = async () => { throw new Error('private upstream failure'); };
  assert.deepEqual(await first(h), { date: TODAY, status: 'unavailable', code: 'CURRENT_SCHEDULE_UNAVAILABLE' });
});

test('fresh central additions include a forgotten class and preserve an explicit cancellation without canceling a regular occurrence', async () => {
  const h = fixture();
  const created = await mutateAddedClasses(h.addedStore, 'rev', { action: 'create', requestId: 'synthetic-addition-one', expectedVersion: 0, series: { id: '', label: 'TEST forgotten class', time: '19:00', days: ['Friday'], startDate: TODAY, endDate: TODAY, enabled: true, cancelledDates: [] } }, NOW, 'Stuart Turner');
  const firstRead = await first(h); assert.equal(firstRead.occurrences.length, 2); assert.equal(firstRead.occurrences[1].cancelled, false);
  await mutateAddedClasses(h.addedStore, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-one', expectedVersion: 1, seriesId: created.seriesIds[0], date: TODAY }, NOW, 'Stuart Turner');
  const cancelled = await first(h);
  assert.equal(cancelled.occurrences[1].cancelled, true); assert.notEqual(cancelled.sourceVersion, firstRead.sourceVersion);
  h.deps.currentSchedule = schedule({ fetchedAt: '2026-09-26T02:04:30.000Z', days: { Friday: ['6:00 PM TEST BJJ', '7:00 PM TEST forgotten class'] } });
  assert.equal((await first(h)).occurrences[1].cancelled, false, 'independent regular occurrence remains scheduled');
});

test('explicit cancellations need no invented finish or confirmed cutoff and stay visible for recorded-teaching conflict checks', async () => {
  const h = fixture(); h.args.cutoffConfirmed = false; h.deps.currentSchedule = schedule({ days: { Friday: [] } });
  const created = await mutateAddedClasses(h.addedStore, 'rev', { action: 'create', requestId: 'synthetic-only-cancelled', expectedVersion: 0, series: { id: '', label: 'TEST cancelled class', time: '19:00', days: ['Friday'], startDate: TODAY, endDate: TODAY, enabled: true, cancelledDates: [] } }, NOW, 'Stuart Turner');
  await mutateAddedClasses(h.addedStore, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-only', expectedVersion: 1, seriesId: created.seriesIds[0], date: TODAY }, NOW, 'Stuart Turner');
  const day = await first(h);
  assert.equal(day.status, 'complete');
  assert.deepEqual(day.occurrences, [{ label: '7:00 PM TEST cancelled class', startAt: '2026-09-25T23:00:00.000Z', endAt: null, cancelled: true }]);
});

test('failed or wrong-target added-class reads make that coverage unavailable while preserving the observed regular timetable', async () => {
  const h = fixture();
  h.deps.addedStore = { getWithMetadata: async () => { throw new Error('private storage failure'); } };
  assert.equal((await first(h)).code, 'ADDED_CLASSES_UNAVAILABLE'); assert.equal(h.store.entries.size, 1);
  h.deps.addedStore = h.addedStore;
  h.addedStore.entries.set(addedClassesKey('rev', 'test'), { etag: 'bad', data: { target: 'production' } });
  assert.equal((await first(h)).code, 'ADDED_CLASSES_UNAVAILABLE');
});

test('explicit authoritative occurrence end times work without cutoff confirmation and never come from payroll duration defaults', async () => {
  const h = fixture(); h.args.dates = ['2026-09-24']; h.args.cutoffConfirmed = false;
  const occurrence = { label: '11:00 PM TEST overnight', startAt: '2026-09-25T03:00:00.000Z', endAt: '2026-09-25T04:00:00.000Z', cancelled: false };
  h.args.reviewSnapshots = [dated('2026-09-24', [occurrence])];
  assert.deepEqual((await first(h)).occurrences, [occurrence]);
  for (const change of [{ endAt: '2026-09-25T02:00:00.000Z' }, { endAt: '2026-09-27T04:00:00.000Z' }, { startAt: '2026-09-25T02:00:00.000Z' }, { duration: 1 }]) {
    const bad = fixture(); bad.args = { ...bad.args, dates: ['2026-09-24'], reviewSnapshots: [dated('2026-09-24', [{ ...occurrence, ...change }])] };
    assert.equal((await first(bad)).status, 'unavailable');
  }
});

test('all 23 current Richmond entries retain their official explicit finishes without a confirmed gym close', async () => {
  const richmond = JSON.parse(readFileSync(new URL('../m1/richmond-schedule.json', import.meta.url), 'utf8'));
  // Official https://www.richmondbjj.com/schedule observed September 29, 2026.
  // These expected ends are independently listed, not computed by the parser.
  const expected = {
    Monday: ['07:00', '08:00', '19:00', '21:00'], Tuesday: ['07:00', '08:00', '19:00', '21:00'],
    Wednesday: ['07:00', '08:00', '19:00', '21:00'], Thursday: ['07:00', '08:00', '19:00', '21:00'],
    Friday: ['07:00', '08:00', '19:00', '21:00'], Saturday: ['11:00', '13:00'], Sunday: ['11:00']
  };
  let count = 0;
  for (const [index, [weekday, ends]] of Object.entries(expected).entries()) {
    const date = new Date(Date.parse('2026-09-28T00:00:00Z') + index * 86400000).toISOString().slice(0, 10);
    const now = Date.parse(date + 'T23:00:00-04:00'), h = fixture();
    h.args = { ...h.args, gym: 'richmond', dates: [date], now, cutoffConfirmed: false, classFinishCutoffConfirmed: false };
    h.deps.currentSchedule = schedule({ site: 'Richmond', fetchedAt: new Date(now).toISOString(), days: richmond.days });
    const day = await first(h); assert.equal(day.status, 'complete', weekday); assert.equal(day.occurrences.length, ends.length);
    day.occurrences.forEach((occurrence, i) => {
      assert.equal(occurrence.label, richmond.days[weekday][i]);
      assert.equal(occurrence.endAt, new Date(date + 'T' + ends[i] + ':00-04:00').toISOString(), occurrence.label);
      assert.equal(Object.hasOwn(occurrence, 'finishedAtCutoff'), false); assert.equal(Object.hasOwn(occurrence, 'finishBasis'), false); count++;
    });
  }
  assert.equal(count, 23);
});

test('explicit end after the 20:00 reminder stays upcoming and reopens next day from the unchanged dated observation', async () => {
  const h = fixture(), label = '7:15 PM–9:00 PM TEST Richmond class';
  h.args = { ...h.args, gym: 'richmond', dates: [TODAY], now: Date.parse(TODAY + 'T20:00:00-04:00'), closingTime: '20:00', cutoffConfirmed: true, classFinishCutoffConfirmed: false };
  h.deps.currentSchedule = schedule({ site: 'Richmond', fetchedAt: new Date(h.args.now).toISOString(), days: { Friday: [label] } });
  const day = await first(h); assert.equal(day.status, 'complete'); assert.ok(Date.parse(day.occurrences[0].endAt) > h.args.now);
  const preserved = structuredClone([...h.store.entries]);
  assert.equal(preserved[0][1].data.base[0].endAt, null, 'original observation format is not rewritten by derived projection');
  h.args.now = Date.parse('2026-09-26T20:00:00-04:00');
  h.deps.loadCurrentSchedule = () => { throw new Error('past observation must not fetch a replacement schedule'); };
  const reopened = await first(h); assert.deepEqual(reopened.occurrences, day.occurrences); assert.ok(Date.parse(reopened.occurrences[0].endAt) < h.args.now);
  assert.deepEqual([...h.store.entries], preserved); assert.equal(h.store.writes.length, 1);
});

test('pre-existing dated range evidence is projected without history changes; missing dates never borrow the current week', async () => {
  const h = fixture(); h.args = { ...h.args, gym: 'richmond', dates: ['2026-09-23', '2026-09-24'], cutoffConfirmed: false };
  const original = { schema: 'm1-digest-dated-schedule/v1', target: 'test', gym: 'richmond', timezone: 'America/New_York',
    date: '2026-09-24', observedAt, sourceVersion: 'retained-explicit-range', base: [{ label: '7:15 PM–9:00 PM TEST retained class',
      startAt: '2026-09-24T23:15:00.000Z', endAt: null, cancelled: false }] };
  h.store.entries.set('schedules/test/richmond/2026-09-24', { data: structuredClone(original), etag: 'existing' });
  const before = structuredClone([...h.store.entries]);
  h.deps.loadCurrentSchedule = () => { throw new Error('historical dates must not fetch today'); };
  const days = (await run(h)).days;
  assert.equal(days[0].code, 'MISSING_DATED_SCHEDULE'); assert.equal(days[1].status, 'complete');
  assert.equal(days[1].occurrences[0].endAt, '2026-09-25T01:00:00.000Z'); assert.deepEqual([...h.store.entries], before); assert.equal(h.store.writes.length, 0);
});

test('all 55 historical Revolution start-only entries still require finish evidence before the approved reminder-rule date', async () => {
  const revolution = JSON.parse(readFileSync(new URL('../m1/shared-schedule.json', import.meta.url), 'utf8')); let count = 0;
  for (const [index, [weekday, labels]] of Object.entries(revolution.days).entries()) {
    const date = new Date(Date.parse('2026-09-21T00:00:00Z') + index * 86400000).toISOString().slice(0, 10), h = fixture();
    const now = Date.parse(date + 'T23:00:00-04:00');
    h.args = { ...h.args, dates: [date], now, closingTime: '20:00', cutoffConfirmed: true, classFinishCutoffConfirmed: false };
    h.deps.currentSchedule = schedule({ fetchedAt: new Date(now).toISOString(), days: revolution.days });
    assert.equal((await first(h)).code, 'CLASS_FINISH_UNCONFIRMED', weekday);
    const stored = h.store.entries.get('schedules/test/rev/' + date).data;
    assert.equal(stored.base.length, labels.length); assert.ok(stored.base.every(item => item.endAt === null)); count += labels.length;
  }
  assert.equal(count, 55);
});

test('range parsing refuses missing meridiem, invalid/reversed/overnight and DST-ambiguous finishes instead of guessing close', async () => {
  for (const label of ['6:00 PM–7:00 TEST no meridiem', '6:00 PM–25:00 PM TEST invalid', '6:00 PM–6:00 PM TEST equal',
    '6:00 PM–5:00 PM TEST reversed', '11:00 PM–1:00 AM TEST overnight', '6:00 PM–7:90 PM TEST invalid']) {
    const h = fixture(); h.deps.currentSchedule = schedule({ days: { Friday: [label] } });
    assert.equal((await first(h)).code, 'SCHEDULE_TIME_UNAVAILABLE', label);
  }
  for (const [date, label] of [['2026-11-01', '12:30 AM–1:30 AM TEST ambiguous finish'], ['2027-03-14', '1:30 AM–2:30 AM TEST nonexistent finish']]) {
    const h = fixture(); h.args = { ...h.args, dates: [date], now: Date.parse(date + 'T23:00:00Z') };
    h.deps.currentSchedule = schedule({ fetchedAt: new Date(h.args.now).toISOString(), days: { Sunday: [label] } });
    assert.equal((await first(h)).code, 'SCHEDULE_TIME_UNAVAILABLE', label);
  }
  const h = fixture(); h.args = { ...h.args, dates: ['2026-11-02'], now: Date.parse('2026-11-03T03:00:00Z'), cutoffConfirmed: false };
  h.deps.currentSchedule = schedule({ fetchedAt: new Date(h.args.now).toISOString(), days: { Monday: ['6:00 PM–7:00 PM TEST winter'] } });
  assert.equal((await first(h)).occurrences[0].endAt, '2026-11-03T00:00:00.000Z', 'winter offset comes from New York local time');
});

test('ambiguous/nonexistent DST wall times fail closed while explicit offsets and seasonal close times remain exact', async () => {
  for (const [date, label] of [['2026-11-01', '1:30 AM TEST ambiguous'], ['2027-03-14', '2:30 AM TEST nonexistent']]) {
    const h = fixture(); h.args = { ...h.args, dates: [date], now: Date.parse(date + 'T23:00:00.000Z'), reviewSnapshots: [] };
    h.deps.currentSchedule = schedule({ fetchedAt: new Date(h.args.now).toISOString(), days: { Sunday: [label] } });
    assert.equal((await first(h)).code, 'SCHEDULE_TIME_UNAVAILABLE');
  }
  const h = fixture(); h.args = { ...h.args, dates: ['2026-11-01'], now: Date.parse('2026-11-02T04:00:00.000Z') };
  h.deps.currentSchedule = schedule({ fetchedAt: new Date(h.args.now).toISOString(), days: { Sunday: [{ label: '1:30 AM TEST explicit', startAt: '2026-11-01T06:30:00.000Z', endAt: '2026-11-01T07:00:00.000Z', cancelled: false }, '6:00 PM TEST class'] } });
  const day = await first(h); assert.equal(day.status, 'complete'); assert.equal(day.occurrences[1].finishedAtCutoff, '2026-11-02T03:00:00.000Z');
});

test('failed writes and missing readback never claim persistence; a CAS winner remains newer and is not overwritten', async () => {
  for (const mode of ['throw', 'unconfirmed', 'missing']) {
    const h = fixture(), get = h.store.getWithMetadata.bind(h.store); let written = false;
    h.store.set = async () => { written = true; if (mode === 'throw') throw new Error('private write error'); return mode === 'unconfirmed' ? undefined : { modified: true }; };
    h.store.getWithMetadata = (...args) => written ? Promise.resolve(null) : get(...args);
    assert.equal((await first(h)).code, 'SCHEDULE_STORAGE_UNAVAILABLE');
  }
  const h = fixture(); const winner = fixture(); winner.deps.currentSchedule = schedule({ fetchedAt: '2026-09-26T02:04:30.000Z', days: { Friday: ['7:00 PM TEST later observation'] } });
  await first(winner);
  h.store.set = async key => { h.store.entries.set(key, structuredClone(winner.store.entries.get(key))); return { modified: false }; };
  const result = await first(h); assert.equal(result.status, 'complete'); assert.equal(result.occurrences[0].label, '7:00 PM TEST later observation');
});

test('invalid/cross-gym stored data, conflicting dated reviews and bounds fail closed without deleting history', async () => {
  const h = fixture(); await first(h); h.args.now = Date.parse('2026-09-26T16:00:00.000Z');
  h.store.entries.get('schedules/test/rev/2026-09-25').data.gym = 'richmond';
  assert.equal((await first(h)).code, 'SCHEDULE_STORAGE_UNAVAILABLE'); assert.equal(h.store.entries.size, 1);
  const conflict = fixture(); conflict.args.dates = ['2026-09-24']; conflict.args.reviewSnapshots = [dated('2026-09-24', []), dated('2026-09-24', ['6:00 PM TEST other'])];
  assert.equal((await first(conflict)).code, 'DATED_SCHEDULE_CONFLICT');
  for (const patch of [{ gym: 'production' }, { dates: [TODAY, TODAY] }, { dates: ['2026-09-06'] }, { dates: Array(3662).fill(TODAY) }, { closingTime: '25:00' }]) await assert.rejects(() => loadDigestScheduleSnapshots({ ...fixture().args, ...patch }, fixture().deps), /scope/);
  const future = fixture(); future.args.dates = ['2026-09-26']; assert.equal((await first(future)).code, 'FUTURE_SCHEDULE_UNAVAILABLE'); assert.equal(future.store.entries.size, 0);
});

test('per-gym date observations and added-class namespaces stay separate', async () => {
  const h = fixture(); await first(h);
  const richmond = await loadDigestScheduleSnapshots({ ...h.args, gym: 'richmond' }, { ...h.deps, currentSchedule: schedule({ site: 'Richmond', days: { Friday: ['7:00 PM TEST Richmond'] } }) });
  assert.equal(richmond.days[0].status, 'complete'); assert.equal(h.store.entries.size, 2);
  assert.ok(h.store.entries.has('schedules/test/rev/' + TODAY)); assert.ok(h.store.entries.has('schedules/test/richmond/' + TODAY));
  assert.ok(h.store.writes.every(key => key.startsWith('schedules/test/'))); assert.equal(h.addedStore.entries.size, 0);
});
