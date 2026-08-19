import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STAFF_OPEN_SHIFT_LIMIT_MS,
  STAFF_PAY_PERIOD_ANCHOR,
  STAFF_PUNCH_ID_PATTERN,
  buildStaffReview,
  createStaffPunchId,
  evaluateStaffState,
  formatStaffElapsed,
  mergeStaffRecords,
  payPeriodOptions,
  payPeriodRange,
  sameStaffRecord,
  validStaffDate,
  validStaffMember,
  validStaffPunchId,
  validStaffRecord,
  validStaffTimestamp
} from '../m1/staff-clock-core.mjs';

let idCounter = 0;

function nextPunchId() {
  idCounter += 1;
  return `gib-m1-staff-00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

function staffRecord(overrides = {}) {
  const timestamp = overrides.timestamp || '2026-08-18T09:00:00-04:00';
  return {
    punchId: nextPunchId(),
    timestamp,
    date: timestamp.slice(0, 10),
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: 'clockIn',
    site: 'TEST',
    device: 'TEST tablet',
    build: 'M1B TEST',
    note: '',
    status: 'ACTIVE',
    source: 'Tablet',
    ...overrides
  };
}

function shift(clockInTimestamp, clockOutTimestamp, overrides = {}) {
  return [
    staffRecord({ timestamp: clockInTimestamp, ...overrides, punchAction: 'clockIn' }),
    staffRecord({ timestamp: clockOutTimestamp, ...overrides, punchAction: 'clockOut' })
  ];
}

function totalFor(review, period, staffId = 'mandy-test') {
  return review.payPeriods[period].staffTotals.find(item => item.staffId === staffId);
}

test('Staff punch IDs are permanent, scoped UUID-v4 values and fail closed without secure randomness', () => {
  const cryptoApi = {
    randomUUID: () => 'ABCDEF12-3456-4ABC-8DEF-1234567890AB'
  };
  const punchId = createStaffPunchId(cryptoApi);
  assert.equal(punchId, 'gib-m1-staff-abcdef12-3456-4abc-8def-1234567890ab');
  assert.match(punchId, STAFF_PUNCH_ID_PATTERN);
  assert.equal(validStaffPunchId(punchId), true);
  assert.equal(validStaffPunchId('gib-m1-abcdef12-3456-4abc-8def-1234567890ab'), false);
  const uppercasePunchId = ['gib-m1-staff', 'ABCDEF12-3456-4ABC-8DEF-1234567890AB'].join('-');
  assert.equal(validStaffPunchId(uppercasePunchId), false);
  assert.throws(() => createStaffPunchId(null), /Secure Staff Clock identity is unavailable/u);
  assert.throws(
    () => createStaffPunchId({ randomUUID: () => 'predictable' }),
    /could not be created/u
  );
});

test('Staff members and records use one strict browser-safe contract', () => {
  assert.equal(validStaffMember({ staffId: 'mandy-test', staffName: 'Mandy Test' }), true);
  assert.equal(validStaffMember({ staffId: 'Mandy', staffName: 'Mandy Test' }), false);
  assert.equal(validStaffMember({ staffId: 'mandy-test', staffName: 'Mandy Test', active: true }), false);
  assert.equal(validStaffDate('2026-02-28'), true);
  assert.equal(validStaffDate('2026-02-29'), false);

  const base = staffRecord();
  assert.equal(validStaffRecord(base), true);
  assert.equal(sameStaffRecord(base, { ...base }), true);
  assert.equal(validStaffRecord({
    ...base,
    source: 'Admin-added',
    adminName: 'Andrew Smith',
    linkedPunchId: nextPunchId()
  }), true);
  assert.equal(validStaffRecord({ ...base, status: 'VOID' }), true);
  assert.equal(validStaffRecord({ ...base, adminName: '', linkedPunchId: '' }), true);
  assert.equal(sameStaffRecord(base, { ...base, adminName: '', linkedPunchId: '' }), true);

  for (const changed of [
    { ...base, punchId: 'bad' },
    { ...base, date: '2026-08-17' },
    { ...base, staffId: 'Mandy Test' },
    { ...base, staffName: ' Mandy Test' },
    { ...base, punchAction: 'in' },
    { ...base, site: '=TEST' },
    { ...base, device: '' },
    { ...base, build: '' },
    { ...base, note: '=HYPERLINK("bad")' },
    { ...base, status: 'active' },
    { ...base, source: 'kiosk' },
    { ...base, adminName: ' Andrew Smith' },
    { ...base, linkedPunchId: 'bad' },
    { ...base, unexpected: true }
  ]) assert.equal(validStaffRecord(changed), false, JSON.stringify(changed));
});

test('timestamps must be parseable offset-bearing New York local instants', () => {
  assert.equal(validStaffTimestamp('2026-08-18T17:27:00-04:00'), true);
  assert.equal(validStaffTimestamp('2026-01-18T17:27:00-05:00'), true);
  assert.equal(validStaffTimestamp('2026-11-01T01:30:00-04:00'), true);
  assert.equal(validStaffTimestamp('2026-11-01T01:30:00-05:00'), true);
  assert.equal(validStaffTimestamp('2026-03-08T02:30:00-05:00'), false, 'nonexistent NY time');
  assert.equal(validStaffTimestamp('2026-08-18T17:27:00Z'), false);
  assert.equal(validStaffTimestamp('2026-08-18 17:27:00-04:00'), false);
  assert.equal(validStaffTimestamp('not-a-time'), false);
});

test('confirmed and pending records merge by permanent ID with confirmed data winning', () => {
  const confirmed = staffRecord();
  const exactPending = { ...confirmed };
  const exact = mergeStaffRecords([confirmed], [exactPending, exactPending]);
  assert.deepEqual(exact.records, [confirmed]);
  assert.deepEqual(exact.attention, []);

  const changedPending = { ...confirmed, punchAction: 'clockOut' };
  const conflict = mergeStaffRecords([confirmed], [changedPending]);
  assert.deepEqual(conflict.records, [confirmed], 'confirmed Google record is authoritative');
  assert.deepEqual(conflict.attention.map(item => item.code), ['CONFLICTING_DUPLICATE']);
  assert.equal(conflict.attention[0].punchId, confirmed.punchId);

  const pendingId = nextPunchId();
  const pendingIn = staffRecord({ punchId: pendingId });
  const pendingOut = { ...pendingIn, punchAction: 'clockOut' };
  const ambiguousPending = mergeStaffRecords([], [pendingIn, pendingOut]);
  assert.deepEqual(ambiguousPending.records, [], 'ambiguous local content is never guessed');
  assert.deepEqual(ambiguousPending.attention.map(item => item.code), ['CONFLICTING_DUPLICATE']);

  const confirmedId = nextPunchId();
  const confirmedIn = staffRecord({ punchId: confirmedId });
  const confirmedOut = { ...confirmedIn, punchAction: 'clockOut' };
  const ambiguousConfirmed = mergeStaffRecords([confirmedIn, confirmedOut], []);
  assert.deepEqual(ambiguousConfirmed.records, [], 'corrupt confirmed duplicates are never guessed');
  assert.deepEqual(ambiguousConfirmed.attention.map(item => item.code), ['CONFLICTING_DUPLICATE']);
});

test('merge validates every record and retains VOID records for visible audit history', () => {
  const voided = staffRecord({ status: 'VOID' });
  const merged = mergeStaffRecords([voided], []);
  assert.deepEqual(merged.records, [voided]);
  assert.throws(() => mergeStaffRecords([{ ...voided, status: 'voided' }], []), /invalid/u);
  assert.throws(() => mergeStaffRecords({}, []), /must be arrays/u);
});

test('empty, clocked-in, clocked-out, and exact completed-shift states are explicit', () => {
  const empty = evaluateStaffState('mandy-test', [], {
    now: '2026-08-18T12:00:00-04:00',
    staffName: 'Mandy Test'
  });
  assert.equal(empty.clockedIn, false);
  assert.equal(empty.nextPunchAction, 'clockIn');
  assert.equal(empty.needsAttention, false);
  assert.deepEqual(empty.completedShifts, []);

  const clockIn = staffRecord({ timestamp: '2026-08-18T09:00:00-04:00' });
  const open = evaluateStaffState('mandy-test', [clockIn], {
    now: '2026-08-18T12:00:00-04:00'
  });
  assert.equal(open.clockedIn, true);
  assert.equal(open.clockInRecord, clockIn);
  assert.equal(open.nextPunchAction, 'clockOut');
  assert.equal(open.needsAttention, false, 'a normal current open shift is not a warning');

  const records = [
    clockIn,
    staffRecord({ timestamp: '2026-08-18T12:37:42-04:00', punchAction: 'clockOut' })
  ];
  const closed = evaluateStaffState('mandy-test', records, {
    now: '2026-08-18T13:00:00-04:00'
  });
  assert.equal(closed.clockedIn, false);
  assert.equal(closed.nextPunchAction, 'clockIn');
  assert.equal(closed.needsAttention, false);
  assert.equal(closed.completedShifts.length, 1);
  assert.equal(closed.completedShifts[0].elapsedMilliseconds, (3 * 60 * 60 + 37 * 60 + 42) * 1_000);
  assert.equal(formatStaffElapsed(closed.completedShifts[0].elapsedMilliseconds), '3 hr 37 min');
});

test('an open shift becomes attention only after 18 hours or a New York date change', () => {
  const exactlyEighteen = staffRecord({ timestamp: '2026-08-18T00:00:00-04:00' });
  const boundary = evaluateStaffState('mandy-test', [exactlyEighteen], {
    now: '2026-08-18T18:00:00-04:00'
  });
  assert.equal(STAFF_OPEN_SHIFT_LIMIT_MS, 18 * 60 * 60 * 1_000);
  assert.equal(boundary.needsAttention, false);
  assert.equal(boundary.clockedIn, true);

  const overLimit = evaluateStaffState('mandy-test', [exactlyEighteen], {
    now: '2026-08-18T18:00:01-04:00'
  });
  assert.deepEqual(overLimit.attention.map(item => item.code), ['MISSING_CLOCK_OUT']);
  assert.equal(overLimit.clockedIn, true);
  assert.equal(overLimit.nextPunchAction, null);

  const priorDay = staffRecord({ timestamp: '2026-08-18T23:30:00-04:00' });
  const afterMidnight = evaluateStaffState('mandy-test', [priorDay], {
    now: '2026-08-19T00:15:00-04:00'
  });
  assert.deepEqual(afterMidnight.attention.map(item => item.code), ['MISSING_CLOCK_OUT']);
  assert.equal(afterMidnight.clockedIn, true);
});

test('orphan, repeated, simultaneous, and future punches stop ordinary actions without guessing', () => {
  const outOnly = staffRecord({ punchAction: 'clockOut' });
  const orphan = evaluateStaffState('mandy-test', [outOnly], {
    now: '2026-08-18T10:00:00-04:00'
  });
  assert.equal(orphan.clockedIn, null);
  assert.equal(orphan.nextPunchAction, null);
  assert.deepEqual(orphan.attention.map(item => item.code), ['CLOCK_OUT_WITHOUT_CLOCK_IN']);

  const repeatedIn = evaluateStaffState('mandy-test', [
    staffRecord({ timestamp: '2026-08-18T09:00:00-04:00' }),
    staffRecord({ timestamp: '2026-08-18T10:00:00-04:00' })
  ], { now: '2026-08-18T11:00:00-04:00' });
  assert.equal(repeatedIn.clockedIn, null);
  assert.deepEqual(repeatedIn.attention.map(item => item.code), ['REPEATED_CLOCK_IN']);

  const repeatedOut = evaluateStaffState('mandy-test', [
    ...shift('2026-08-18T09:00:00-04:00', '2026-08-18T10:00:00-04:00'),
    staffRecord({ timestamp: '2026-08-18T11:00:00-04:00', punchAction: 'clockOut' })
  ], { now: '2026-08-18T12:00:00-04:00' });
  assert.equal(repeatedOut.completedShifts.length, 1, 'completed work before the contradiction stays exact');
  assert.deepEqual(repeatedOut.attention.map(item => item.code), ['REPEATED_CLOCK_OUT']);

  const sameTime = evaluateStaffState('mandy-test', [
    staffRecord({ timestamp: '2026-08-18T09:00:00-04:00' }),
    staffRecord({ timestamp: '2026-08-18T09:00:00-04:00', punchAction: 'clockOut' })
  ], { now: '2026-08-18T10:00:00-04:00' });
  assert.equal(sameTime.clockedIn, null);
  assert.deepEqual(sameTime.attention.map(item => item.code), ['SIMULTANEOUS_PUNCHES']);

  const future = evaluateStaffState('mandy-test', [
    staffRecord({ timestamp: '2026-08-18T13:00:00-04:00' })
  ], { now: '2026-08-18T12:00:00-04:00' });
  assert.equal(future.clockedIn, null);
  assert.deepEqual(future.attention.map(item => item.code), ['FUTURE_PUNCH']);
});

test('unreasonably long completed shifts remain exact but require Admin attention', () => {
  const records = shift('2026-08-18T01:00:00-04:00', '2026-08-18T20:00:01-04:00');
  const state = evaluateStaffState('mandy-test', records, {
    now: '2026-08-18T21:00:00-04:00'
  });
  assert.equal(state.clockedIn, false);
  assert.equal(state.nextPunchAction, null);
  assert.equal(state.completedShifts[0].elapsedMilliseconds, (19 * 60 * 60 + 1) * 1_000);
  assert.deepEqual(state.attention.map(item => item.code), ['UNREASONABLY_LONG_SHIFT']);
});

test('VOID punches are preserved for review but ignored by state and totals', () => {
  const wrongOut = staffRecord({
    timestamp: '2026-08-18T08:00:00-04:00',
    punchAction: 'clockOut',
    status: 'VOID'
  });
  const corrected = shift('2026-08-18T09:00:00-04:00', '2026-08-18T12:00:00-04:00', {
    source: 'Admin-added',
    adminName: 'Stuart Turner'
  });
  const state = evaluateStaffState('mandy-test', [wrongOut, ...corrected], {
    now: '2026-08-18T13:00:00-04:00'
  });
  assert.equal(state.needsAttention, false);
  assert.equal(state.completedShifts.length, 1);
  assert.equal(state.completedShifts[0].elapsedMilliseconds, 3 * 60 * 60 * 1_000);

  const review = buildStaffReview({
    confirmedRecords: [wrongOut, ...corrected],
    staffMembers: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }],
    now: '2026-08-18T13:00:00-04:00'
  });
  assert.equal(review.records.includes(wrongOut), true);
  assert.equal(review.todayPunches.includes(wrongOut), true);
  assert.equal(totalFor(review, 'current').completedShifts, 1);
});

test('external duplicate attention blocks actions but retains unambiguous completed work', () => {
  const records = shift('2026-08-18T09:00:00-04:00', '2026-08-18T10:00:00-04:00');
  const state = evaluateStaffState('mandy-test', records, {
    now: '2026-08-18T11:00:00-04:00',
    attention: [{
      code: 'CONFLICTING_DUPLICATE',
      staffId: 'mandy-test',
      punchId: records[0].punchId,
      timestamp: records[0].timestamp,
      date: records[0].date
    }]
  });
  assert.equal(state.clockedIn, null);
  assert.equal(state.nextPunchAction, null);
  assert.equal(state.completedShifts.length, 1);
  assert.equal(state.needsAttention, true);
});

test('14-day Monday-through-Sunday periods repeat from the 2026-08-10 anchor', () => {
  assert.equal(STAFF_PAY_PERIOD_ANCHOR, '2026-08-10');
  assert.deepEqual(payPeriodRange('2026-08-10'), {
    startDate: '2026-08-10',
    endDate: '2026-08-23'
  });
  assert.deepEqual(payPeriodRange('2026-08-23'), {
    startDate: '2026-08-10',
    endDate: '2026-08-23'
  });
  assert.deepEqual(payPeriodRange('2026-08-24'), {
    startDate: '2026-08-24',
    endDate: '2026-09-06'
  });
  assert.deepEqual(payPeriodRange('2026-08-10', -1), {
    startDate: '2026-07-27',
    endDate: '2026-08-09'
  });
  assert.deepEqual(payPeriodRange('2026-08-09'), {
    startDate: '2026-07-27',
    endDate: '2026-08-09'
  });
  assert.deepEqual(payPeriodOptions('2026-08-18'), {
    current: {
      key: 'current',
      label: 'Current pay period',
      startDate: '2026-08-10',
      endDate: '2026-08-23'
    },
    previous: {
      key: 'previous',
      label: 'Previous pay period',
      startDate: '2026-07-27',
      endDate: '2026-08-09'
    }
  });
  assert.throws(() => payPeriodRange('2026-02-29'), /valid pay-period date/u);
});

test('pay-period totals count completed shifts by Clock In date and sum exact elapsed time once', () => {
  const currentFirst = shift(
    '2026-08-10T09:00:00-04:00',
    '2026-08-10T09:00:59.500-04:00'
  );
  const currentSecond = shift(
    '2026-08-11T09:00:00-04:00',
    '2026-08-11T09:00:59.500-04:00'
  );
  const previous = shift(
    '2026-08-09T09:00:00-04:00',
    '2026-08-09T12:37:42-04:00'
  );
  const review = buildStaffReview({
    confirmedRecords: [...previous, ...currentFirst],
    pendingRecords: currentSecond,
    staffMembers: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }],
    now: '2026-08-18T12:00:00-04:00'
  });
  const currentTotal = totalFor(review, 'current');
  const previousTotal = totalFor(review, 'previous');
  assert.equal(currentTotal.completedShifts, 2);
  assert.equal(currentTotal.totalMilliseconds, 119_000);
  assert.equal(currentTotal.formattedTotal, '0 hr 1 min', 'milliseconds are summed before display truncation');
  assert.equal(previousTotal.completedShifts, 1);
  assert.equal(previousTotal.totalMilliseconds, (3 * 60 * 60 + 37 * 60 + 42) * 1_000);
  assert.equal(previousTotal.formattedTotal, '3 hr 37 min');
  assert.equal(currentTotal.needsAttention, false);
  assert.equal(previousTotal.needsAttention, false);
});

test('a shift crossing a pay-period boundary stays with its Clock In period without rounding', () => {
  const records = shift(
    '2026-08-23T23:30:00-04:00',
    '2026-08-24T01:00:00-04:00'
  );
  const review = buildStaffReview({
    confirmedRecords: records,
    staffMembers: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }],
    now: '2026-08-24T12:00:00-04:00'
  });
  assert.equal(totalFor(review, 'current').completedShifts, 0);
  assert.equal(totalFor(review, 'previous').completedShifts, 1);
  assert.equal(totalFor(review, 'previous').totalMilliseconds, 90 * 60 * 1_000);
});

test('elapsed time follows absolute instants across the New York DST overlap', () => {
  const records = shift(
    '2026-11-01T01:30:00-04:00',
    '2026-11-01T01:30:00-05:00'
  );
  const state = evaluateStaffState('mandy-test', records, {
    now: '2026-11-01T02:00:00-05:00'
  });
  assert.equal(state.needsAttention, false);
  assert.equal(state.completedShifts.length, 1);
  assert.equal(state.completedShifts[0].elapsedMilliseconds, 60 * 60 * 1_000);
  assert.equal(formatStaffElapsed(state.completedShifts[0].elapsedMilliseconds), '1 hr 0 min');
});

test('review projection combines Google and waiting punches without touching unrelated Staff identities', () => {
  const mandyIn = staffRecord({ timestamp: '2026-08-18T09:00:00-04:00' });
  const formerShift = shift(
    '2026-08-08T09:00:00-04:00',
    '2026-08-08T11:00:00-04:00',
    { staffId: 'former-test', staffName: 'Former Staff Test' }
  );
  const voidedToday = staffRecord({
    timestamp: '2026-08-18T08:00:00-04:00',
    punchAction: 'clockOut',
    status: 'VOID',
    source: 'Admin-added',
    adminName: 'Andrew Smith'
  });
  const review = buildStaffReview({
    confirmedRecords: [...formerShift, voidedToday],
    pendingRecords: [mandyIn],
    staffMembers: [
      { staffId: 'mandy-test', staffName: 'Mandy Test' },
      { staffId: 'front-desk-test-two', staffName: 'Front Desk Test Two' }
    ],
    now: '2026-08-19T02:00:00.000Z'
  });

  assert.equal(review.today, '2026-08-18');
  assert.deepEqual(review.clockedInNow.map(state => state.staffId), ['mandy-test']);
  assert.equal(review.todayPunches.length, 2);
  assert.equal(review.todayPunches.includes(voidedToday), true);
  assert.deepEqual(review.attention, []);
  assert.deepEqual(
    review.staffStates.map(state => state.staffId).sort(),
    ['former-test', 'front-desk-test-two', 'mandy-test']
  );
  assert.equal(totalFor(review, 'previous', 'former-test').completedShifts, 1);
  assert.equal(totalFor(review, 'current', 'front-desk-test-two').completedShifts, 0);
});

test('review exposes contradictory records once and marks only the affected totals', () => {
  const conflictingId = nextPunchId();
  const confirmed = staffRecord({ punchId: conflictingId });
  const pending = { ...confirmed, punchAction: 'clockOut' };
  const otherShift = shift(
    '2026-08-18T09:00:00-04:00',
    '2026-08-18T10:00:00-04:00',
    { staffId: 'front-desk-test-two', staffName: 'Front Desk Test Two' }
  );
  const review = buildStaffReview({
    confirmedRecords: [confirmed, ...otherShift],
    pendingRecords: [pending],
    staffMembers: [
      { staffId: 'mandy-test', staffName: 'Mandy Test' },
      { staffId: 'front-desk-test-two', staffName: 'Front Desk Test Two' }
    ],
    now: '2026-08-18T12:00:00-04:00'
  });

  assert.deepEqual(review.attention.map(item => item.code), ['CONFLICTING_DUPLICATE']);
  assert.equal(review.staffStates.find(state => state.staffId === 'mandy-test').clockedIn, null);
  assert.equal(totalFor(review, 'current', 'mandy-test').needsAttention, true);
  assert.equal(totalFor(review, 'current', 'front-desk-test-two').needsAttention, false);
  assert.equal(totalFor(review, 'current', 'front-desk-test-two').completedShifts, 1);
});

test('formatStaffElapsed never rounds, subtracts breaks, or applies overtime rules', () => {
  assert.equal(formatStaffElapsed(0), '0 hr 0 min');
  assert.equal(formatStaffElapsed(59_999), '0 hr 0 min');
  assert.equal(formatStaffElapsed(60_000), '0 hr 1 min');
  assert.equal(formatStaffElapsed((42 * 60 * 60 + 17 * 60 + 59) * 1_000), '42 hr 17 min');
  assert.throws(() => formatStaffElapsed(-1), /non-negative/u);
  assert.throws(() => formatStaffElapsed(Number.NaN), /finite/u);
});
