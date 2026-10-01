import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadDigestScheduleSnapshots } from '../netlify/functions/_lib/m1-attendance-digest-source.mjs';
import { revolutionReminderEligibility } from '../netlify/functions/_lib/m1-reminder-eligibility.mjs';
import { buildAttendanceDigest, defaultDigestConfiguration, renderAttendanceDigest } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';

class Store {
  entries = new Map();
  async getWithMetadata(key) { return structuredClone(this.entries.get(key) || null); }
  async set(key, raw, options) {
    const prior = this.entries.get(key);
    if (options.onlyIfNew && prior || options.onlyIfMatch && prior?.etag !== options.onlyIfMatch) return { modified: false };
    this.entries.set(key, { data: JSON.parse(raw), etag: String(Number(prior?.etag || 0) + 1) });
    return { modified: true };
  }
}
const item = (date, start = '22:00', extra = {}) => ({ label: '6:00 PM TEST class', startAt: date + 'T' + start + ':00.000Z', endAt: null, cancelled: false, ...extra });
async function source(gym, date, labels, now, store = new Store(), reviewSnapshots = []) {
  const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/New_York' }).format(new Date(date + 'T16:00:00Z'));
  return { store, value: await loadDigestScheduleSnapshots({ gym, dates: [date], now, store, closingTime: '20:00', cutoffConfirmed: true, classFinishCutoffConfirmed: false, reviewSnapshots }, {
    addedStore: new Store(), currentSchedule: { site: gym === 'rev' ? 'Rev' : 'Richmond', timezone: 'America/New_York', current: true, fallback: 'none', fetchedAt: new Date(now).toISOString(), version: 'synthetic-dated', days: { [dayName]: labels } }
  }) };
}
function digest(gym, date, schedule, now) {
  const configuration = defaultDigestConfiguration({ target: 'test', profile: { installationId: gym, environment: 'test', gymName: gym } });
  return buildAttendanceDigest({ jobDate: date, now, configuration, schedules: [schedule], snapshots: [{ gym,
    attendance: { ok: true, ledger: { ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true, gym, from: '2026-09-07', to: date,
      days: datesThrough(date).map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) } },
    staff: { ok: true, complete: true, items: [] } }] });
}

test('approved forward rule changes eligibility at 8pm, never stored finish times or historical days', async () => {
  const date = '2026-09-29', before = Date.parse('2026-09-29T23:59:00Z'), due = Date.parse('2026-09-30T00:00:00Z');
  const result = await source('rev', date, ['6:00 PM TEST class'], before);
  assert.equal(result.value.days[0].status, 'complete');
  const row = result.value.days[0].occurrences[0];
  assert.equal(row.endAt, null); assert.equal(row.reminderEligibleAt, '2026-09-30T00:00:00.000Z');
  assert.equal(digest('rev', date, result.value, before).itemCount, 0);
  assert.equal(digest('rev', date, result.value, due).itemCount, 1);
  const saved = structuredClone([...result.store.entries]);
  assert.equal(saved[0][1].data.base[0].endAt, null);
  assert.equal(Object.hasOwn(saved[0][1].data.base[0], 'reminderEligibleAt'), false);
  await source('rev', date, ['7:00 PM TEST replacement'], Date.parse('2026-09-30T16:00:00Z'), result.store);
  assert.deepEqual([...result.store.entries], saved);
  const old = await source('rev', '2026-09-28', ['6:00 PM TEST old'], Date.parse('2026-09-29T00:00:00Z'));
  assert.equal(old.value.days[0].code, 'CLASS_FINISH_UNCONFIRMED');
});

test('known late finishes and Richmond ranges stay later; the rule cannot mark new late starts or another gym finished', async () => {
  const date = '2026-09-29', now = Date.parse('2026-09-30T00:00:00Z');
  for (const gym of ['rev', 'richmond']) {
    const result = await source(gym, date, ['7:15 PM–9:00 PM TEST late'], now);
    assert.equal(result.value.days[0].occurrences[0].endAt, '2026-09-30T01:00:00.000Z');
    assert.equal(digest(gym, date, result.value, now).itemCount, 0);
    assert.equal(digest(gym, date, result.value, now + 86400000).itemCount, 1);
  }
  for (const [gym, candidateDate, value] of [['richmond','2026-09-29',item(date)], ['rev','2026-09-28',item('2026-09-28')],
    ['rev',date,item(date,'00:00')], ['rev',date,item(date,'22:00',{endAt:'2026-09-30T02:00:00.000Z'})]]) {
    assert.equal(revolutionReminderEligibility(gym,candidateDate,value),null);
  }
  assert.equal(revolutionReminderEligibility('rev','2026-11-01',item('2026-11-01','23:00')).reminderEligibleAt,'2026-11-02T01:00:00.000Z');
  assert.equal(revolutionReminderEligibility('rev','2027-03-14',item('2027-03-14','22:00')).reminderEligibleAt,'2027-03-15T00:00:00.000Z');
});

test('all 55 current Revolution entries use the prospective rule without saving invented finishes', async () => {
  const schedule=JSON.parse(readFileSync(new URL('../m1/shared-schedule.json',import.meta.url),'utf8'));
  let count=0;
  for (const [index,labels] of Object.values(schedule.days).entries()) {
    const date=new Date(Date.parse('2026-10-05T00:00:00Z')+index*86400000).toISOString().slice(0,10);
    const result=await source('rev',date,labels,Date.parse(date+'T23:00:00-04:00'));
    assert.equal(result.value.days[0].status,'complete');
    for(const row of result.value.days[0].occurrences) { assert.equal(row.endAt,null); assert.ok(row.reminderEligibleAt); count++; }
    assert.ok([...result.store.entries.values()][0].data.base.every(row=>row.endAt===null));
  }
  assert.equal(count,55);
});

test('Richmond three known unresolved classes remain separate from missing historical coverage and cancellations', async () => {
  const date = '2026-09-29', now = Date.parse('2026-09-30T00:00:00Z');
  const base = ['6:00 AM–7:00 AM Muay Thai Fundamentals','7:00 AM–8:00 AM Brazilian Jiu-Jitsu No-Gi','6:00 PM–7:00 PM Muay Thai Fundamentals','7:15 PM–9:00 PM Brazilian Jiu-Jitsu No-Gi Fundamentals'];
  const old = await source('richmond','2026-09-23',[],now,new Store(),[{ date:'2026-09-23',base,reviewedAt:'2026-09-24T12:00:00.000Z' }]);
  old.value.days[0].occurrences[0].cancelled = true;
  const result = digest('richmond',date,old.value,now);
  assert.equal(result.itemCount,3); assert.equal(result.readFailures.length,1); assert.equal(result.readFailures[0].dates.length,22);
  assert.ok(result.groups[0].items.every(value=>value.date==='2026-09-23'));
  const rendered=renderAttendanceDigest(result,defaultDigestConfiguration({target:'test',profile:{installationId:'richmond',environment:'test',gymName:'Richmond'}}));
  assert.match(rendered.text,/could not be confirmed for 22 dates/); assert.match(rendered.text,/No missing instructors were inferred/);
  assert.doesNotMatch(rendered.text,/andrew@|#staff-time|deploy-preview-89/);
});

test('mismatched rule evidence and missing storage still fail safely', async () => {
  const date='2026-09-29', now=Date.parse('2026-09-30T00:00:00Z');
  const result=await source('rev',date,['6:00 PM TEST class'],now);
  result.value.days[0].occurrences[0].reminderEligibleAt='2026-09-29T22:01:00.000Z';
  assert.equal(digest('rev',date,result.value,now).itemCount,0);
  assert.ok(digest('rev',date,result.value,now).readFailures.length);
  const store=new Store(); store.set=async()=>({modified:true});
  assert.equal((await source('rev',date,['6:00 PM TEST class'],now,store)).value.days[0].code,'SCHEDULE_STORAGE_UNAVAILABLE');
});
