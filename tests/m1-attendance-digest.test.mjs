import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttendanceDigest, defaultDigestConfiguration, renderAttendanceDigest, digestDue, DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';

const now = Date.parse('2026-09-25T02:30:00Z'), today = '2026-09-24';
const configuration = () => defaultDigestConfiguration({ target: 'test', profile: { installationId: 'rev', gymName: 'Revolution BJJ' } }, { GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true' });
const ledger = (gym = 'rev', to = today) => ({ ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true, gym, from: '2026-09-07', to,
  days: datesThrough(to).map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) });
const snapshots = () => [{ gym: 'rev', attendance: { ok: true, ledger: ledger() }, staff: { ok: true, complete: true, items: [] } }];
const schedules = (gym = 'rev', to = today) => ({ gym, timezone: 'America/New_York', days: datesThrough(to).map(date => ({ date, status: 'complete', observedAt: date + 'T12:00:00.000Z', sourceVersion: 'actual-' + date, occurrences: [] })) });
const occurrence = (patch = {}) => ({ label: '6:00 PM TEST BJJ', startAt: '2026-09-24T22:00:00.000Z', endAt: '2026-09-24T23:00:00.000Z', cancelled: false, ...patch });
const instructor = (patch = {}) => ({ recordId: 'original-id', date: today, classLabel: '6:00 PM TEST BJJ', instructor: 'TEST One', duration: 1, reviewRequired: false, ...patch });
function build(change = () => {}, stamp = now) {
  const input = { jobDate: today, snapshots: snapshots(), schedules: [schedules()], configuration: configuration(), now: stamp };
  change(input); return buildAttendanceDigest(input);
}

test('one valid instructor satisfies a finished class; unreviewed days and additional instructor slots never trigger email', () => {
  const value = build(input => {
    input.schedules[0].days.at(-1).occurrences.push(occurrence());
    input.snapshots[0].attendance.ledger.days.at(-1).records.push(instructor());
  });
  assert.equal(value.shouldCapture, false); assert.equal(value.itemCount, 0); assert.deepEqual(value.readFailures, []);
  assert.equal(build().shouldCapture, false);
});

test('missing sign-ins require confirmed class finish; upcoming and in-progress classes are excluded', () => {
  for (const [stamp, expected] of [[Date.parse('2026-09-24T21:00:00Z'), 0], [Date.parse('2026-09-24T22:30:00Z'), 0], [Date.parse('2026-09-24T23:00:00Z'), 1]]) {
    const value = build(input => { input.schedules[0].days.at(-1).occurrences.push(occurrence()); }, stamp);
    assert.equal(value.itemCount, expected);
  }
});

test('resolved cancellations stay excluded while recorded-teaching contradictions and existing warnings remain attention items', () => {
  const saved = { revision: 1, action: 'partial', decisions: [{ label: '6:00 PM TEST BJJ', outcome: 'not-held' }], snapshot: { base: [] },
    attendanceHash: 'a'.repeat(64), scheduleHash: 'b'.repeat(64), time: '2026-09-24T23:00:00Z' };
  const cancelled = build(input => { input.schedules[0].days.at(-1).occurrences.push(occurrence()); input.snapshots[0].attendance.ledger.days.at(-1).review = saved; });
  assert.equal(cancelled.shouldCapture, false);
  const conflict = build(input => {
    input.schedules[0].days.at(-1).occurrences.push(occurrence());
    Object.assign(input.snapshots[0].attendance.ledger.days.at(-1), { review: saved, records: [instructor()], warnings: [{ code: 'EXISTING_CONFLICT', message: 'Existing issue remains.' }] });
  });
  assert.equal(conflict.itemCount, 2); assert.ok(conflict.groups[0].items.every(item => item.kind === 'attendance-conflict'));
  assert.equal(build(input => input.schedules[0].days.at(-1).occurrences.push(occurrence({ cancelled: true }))).shouldCapture, false);
});

test('distinct same-code row warnings retain separate digest identities and resolved cancellations need no guessed finish', () => {
  const warnings = build(input => input.snapshots[0].attendance.ledger.days.at(-1).warnings.push(
    { code: 'UNREADABLE_ROW', displayId: 'sheet-row-19', message: 'One Sheet row needs review.' },
    { code: 'UNREADABLE_ROW', displayId: 'sheet-row-20', message: 'One Sheet row needs review.' }
  ));
  assert.equal(warnings.itemCount, 2);
  assert.equal(new Set(warnings.groups[0].items.map(item => item.id)).size, 2);
  const canceled = build(input => {
    input.configuration.cutoffConfirmed = false;
    input.schedules[0].days.at(-1).occurrences.push(occurrence({ cancelled: true, endAt: null }));
  });
  assert.equal(canceled.itemCount, 0); assert.deepEqual(canceled.readFailures, []); assert.equal(canceled.shouldCapture, false);
  const conflict = build(input => {
    input.configuration.cutoffConfirmed = false;
    input.schedules[0].days.at(-1).occurrences.push(occurrence({ cancelled: true, endAt: null }));
    input.snapshots[0].attendance.ledger.days.at(-1).records.push(instructor());
  });
  assert.equal(conflict.itemCount, 1); assert.equal(conflict.groups[0].items[0].kind, 'attendance-conflict');
  assert.deepEqual(conflict.readFailures, []);
});

test('unresolved earlier dated occurrences carry forward and a late upload removes the issue in the next daily digest', () => {
  const date = '2026-09-20';
  const before = build(input => input.schedules[0].days.find(day => day.date === date).occurrences.push(occurrence({ startAt: date + 'T22:00:00.000Z', endAt: date + 'T23:00:00.000Z' })));
  assert.equal(before.itemCount, 1); assert.equal(before.groups[0].items[0].date, date);
  const after = build(input => {
    input.schedules[0].days.find(day => day.date === date).occurrences.push(occurrence({ startAt: date + 'T22:00:00.000Z', endAt: date + 'T23:00:00.000Z' }));
    input.snapshots[0].attendance.ledger.days.find(day => day.date === date).records.push(instructor({ date }));
  });
  assert.equal(after.shouldCapture, false);
});

test('missing or incomplete authoritative reads and unknown dated schedule are separate failures, never presumed missing people', () => {
  for (const mode of ['attendance', 'incomplete', 'schedule', 'finish', 'staff']) {
    const value = build(input => {
      if (mode === 'attendance') input.snapshots[0].attendance = { ok: false, code: 'READ_FAILED' };
      if (mode === 'incomplete') input.snapshots[0].attendance.ledger.days.pop();
      if (mode === 'schedule') input.schedules[0].days = [];
      if (mode === 'finish') input.schedules[0].days.at(-1).occurrences.push(occurrence({ endAt: null }));
      if (mode === 'staff') input.snapshots[0].staff = { ok: false, code: 'READ_FAILED' };
    });
    assert.equal(value.itemCount, 0, mode); assert.equal(value.shouldCapture, true, mode); assert.equal(value.readFailures.length, 1, mode);
  }
});

test('an explicit confirmed closing-time cutoff is distinct from actual class end and never guessed from paid hours', () => {
  const change = input => input.schedules[0].days.at(-1).occurrences.push(occurrence({ endAt: null, finishedAtCutoff: '2026-09-25T02:00:00.000Z', finishBasis: 'confirmed-gym-close' }));
  assert.equal(build(change, Date.parse('2026-09-25T01:59:00Z')).itemCount, 0);
  assert.equal(build(change).itemCount, 1);
  const unconfirmed = build(input => { change(input); input.configuration.cutoffConfirmed = false; });
  assert.equal(unconfirmed.itemCount, 0); assert.equal(unconfirmed.readFailures[0].component, 'schedule');
});

test('pending staff proposals appear with original item identity; resolved items disappear without mutating attendance', () => {
  const value = build(input => input.snapshots[0].staff.items.push({ id: 'original-proposal-id', kind: 'time-correction', staffName: 'TEST Staff', date: '2026-09-23', status: 'pending', summary: 'Previous finish time awaits review.' }));
  assert.equal(value.itemCount, 1); assert.equal(value.groups[0].items[0].kind, 'time-correction'); assert.match(value.groups[0].items[0].url, /#staff-time$/);
  assert.equal(build().shouldCapture, false);
});

test('isolated multi-gym fixtures stay grouped and never let one gym sign-in satisfy another', () => {
  const config = configuration(); config.gyms.push({ id: 'richmond', name: 'Richmond BJJ', timezone: 'America/New_York', adminUrl: 'https://gib-richmond-test.netlify.app/m1/admin/' });
  const gyms = snapshots(); gyms.push({ gym: 'richmond', attendance: { ok: true, ledger: ledger('richmond') }, staff: { ok: true, complete: true, items: [] } });
  gyms[0].attendance.ledger.days.at(-1).records.push(instructor());
  const dates = [schedules(), schedules('richmond')]; dates.forEach(schedule => schedule.days.at(-1).occurrences.push(occurrence()));
  const value = buildAttendanceDigest({ jobDate: today, snapshots: gyms, schedules: dates, configuration: config, now });
  assert.equal(value.groups[0].items.length, 0); assert.equal(value.groups[1].items.length, 1); assert.match(value.groups[1].items[0].url, /^https:\/\/gib-richmond-test/);
  assert.throws(() => buildAttendanceDigest({ jobDate: today, snapshots: gyms, schedules: dates, configuration: configuration(), now }), /configured gyms/);
});

test('rendered HTML and plain text preserve safe direct authenticated links and explicitly identify unsent capture', () => {
  const value = build(input => input.snapshots[0].staff.items.push({ id: 'pending', kind: 'staff-conflict', staffName: '<img src=x>', date: today, status: 'pending', summary: 'Review "quoted" hours & punches.' }));
  const rendered = renderAttendanceDigest(value);
  assert.match(rendered.html, /&lt;img src=x&gt;/); assert.doesNotMatch(rendered.html, /<img|<script/);
  assert.match(rendered.text, /actual email sending is disabled/); assert.match(rendered.text, /address not configured/);
  assert.match(rendered.text, new RegExp(DIGEST_ORIGIN.replace(/[.]/g, '\\.'))); assert.match(rendered.html, /real delivery has not been tested/);
});

test('duplicate permanent IDs and teaching on canceled occurrences cannot silently satisfy a clean digest', () => {
  const duplicate = build(input => {
    input.schedules[0].days.at(-1).occurrences.push(occurrence());
    input.snapshots[0].attendance.ledger.days.at(-1).records.push(instructor(), instructor({ instructor: 'TEST Other' }));
  });
  assert.equal(duplicate.groups[0].items.filter(item => item.kind === 'missing-instructor').length, 1);
  assert.equal(duplicate.groups[0].items.filter(item => item.kind === 'attendance-conflict').length, 1);
  const cancelled = build(input => {
    input.schedules[0].days.at(-1).occurrences.push(occurrence({ cancelled: true }));
    input.snapshots[0].attendance.ledger.days.at(-1).records.push(instructor());
  });
  assert.equal(cancelled.itemCount, 1); assert.equal(cancelled.groups[0].items[0].kind, 'attendance-conflict');
});

test('scheduled capture waits for configuration and final finish even when the configured check time has passed', () => {
  const config = configuration(), dates = [schedules()];
  assert.equal(digestDue(today, now, { ...config, cutoffConfirmed: false }, dates), 'awaiting-configuration');
  assert.equal(digestDue(today, Date.parse('2026-09-25T01:59:00Z'), config, dates), 'not-due');
  dates[0].days.at(-1).occurrences.push(occurrence({ endAt: '2026-09-25T03:00:00.000Z' }));
  assert.equal(digestDue(today, now, config, dates), 'not-due');
  assert.equal(digestDue(today, Date.parse('2026-09-25T03:01:00Z'), config, dates), 'due');
});
