import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildStaffReview,
  evaluateStaffState
} from '../m1/staff-clock-core.mjs';

const kioskHtml = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../m1/staff-clock-client.mjs', import.meta.url), 'utf8');
const installationProfileSource = readFileSync(
  new URL('../m1/installation-profile-core.mjs', import.meta.url),
  'utf8'
);

function between(source, start, end) {
  const normalizedSource = source.replace(/\r\n?/gu, '\n');
  const normalizedStart = start.replace(/\r\n?/gu, '\n');
  const normalizedEnd = end.replace(/\r\n?/gu, '\n');
  const from = normalizedSource.indexOf(normalizedStart);
  const to = normalizedSource.indexOf(normalizedEnd, from + normalizedStart.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return normalizedSource.slice(from, to);
}

function record({ id, timestamp, action, status = 'ACTIVE', source = 'Tablet' }) {
  return {
    punchId: `gib-m1-staff-${id}`,
    timestamp,
    date: timestamp.slice(0, 10),
    staffId: 'mandy-test',
    staffName: 'Mandy Test',
    punchAction: action,
    site: 'Rev TEST',
    device: 'Staff Clock tablet',
    build: '2026-08-18 M1B TEST staff-clock-operational-candidate',
    note: '',
    status,
    source
  };
}

const CLOCK_IN = record({
  id: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-08-18T09:00:00-04:00',
  action: 'clockIn'
});
const CLOCK_OUT = record({
  id: '22222222-2222-4222-8222-222222222222',
  timestamp: '2026-08-18T17:07:59-04:00',
  action: 'clockOut'
});

test('Instructor Sign-In stays complete and first; Staff Clock is one compact sibling card', () => {
  const instructor = kioskHtml.indexOf('<section id="kiosk"');
  const staff = kioskHtml.indexOf('<section id="staffClock"');
  const admin = kioskHtml.indexOf('<section id="admin"');
  assert.ok(instructor >= 0 && staff > instructor && admin > staff);

  const instructorMarkup = kioskHtml.slice(instructor, staff);
  for (const id of ['nameInput', 'classListWrap', 'btnSignIn']) {
    assert.match(instructorMarkup, new RegExp(`id="${id}"`, 'u'));
  }

  const staffMarkup = kioskHtml.slice(staff, admin);
  assert.equal((staffMarkup.match(/id="staffClockName"/gu) || []).length, 1);
  assert.equal((staffMarkup.match(/id="btnStaffClockAction"/gu) || []).length, 1);
  assert.equal((staffMarkup.match(/id="btnStaffClockDone"/gu) || []).length, 1);
  assert.match(staffMarkup, /aria-live="polite"/u);
  assert.match(staffMarkup, />Clock in</u);
  assert.match(staffMarkup, />Done</u);
});

test('the roster is server-derived and limited to one blank initial option in HTML', () => {
  const select = between(kioskHtml, '<select id="staffClockName"', '</select>');
  assert.equal((select.match(/<option\b/gu) || []).length, 1);
  assert.match(select, /Select staff member/u);
  assert.doesNotMatch(kioskHtml, /Mandy Test|Front Desk Test Two|Front Desk Test Three/u);
  assert.doesNotMatch(clientSource, /Mandy Test|Front Desk Test Two|Front Desk Test Three/u);
  assert.match(clientSource, /saveStaffClockPeople/u);
  assert.match(clientSource, /validatedStaffClockSnapshot/u);
});

test('missing authorization and empty-roster failures are explicit recovery states', () => {
  const staffMarkup = between(kioskHtml, '<section id="staffClock"', '<section id="admin"');
  const pairingMarkup = between(
    staffMarkup,
    '<div id="staffClockPairingCodeWrap"',
    '<div class="staff-clock-availability-actions">'
  );
  const availabilitySource = between(
    clientSource,
    'function setStaffClockAvailability(state)',
    'function showStaffClockAuthorizationRequired()'
  );
  assert.ok(staffMarkup.indexOf('id="staffClockAvailability"') < staffMarkup.indexOf('id="staffClockControls"'));
  assert.match(staffMarkup, /id="staffClockControls" class="staff-clock-controls" hidden/u);
  assert.match(staffMarkup, /Loading Staff Clock…/u);
  assert.match(staffMarkup, /id="staffClockPairingCodeWrap"[^>]*hidden/u);
  assert.match(staffMarkup, /id="staffClockPairingInstructions"[^>]*hidden/u);
  assert.match(pairingMarkup, /Pairing code/u);
  assert.match(pairingMarkup, /separate phone or computer/u);
  assert.match(pairingMarkup, /id="staffClockPairingAdminUrl"/u);
  assert.match(
    clientSource,
    /adminUrl\.textContent = new URL\('\/m1\/admin\/', STAFF_CLOCK_PAIRING_CONFIG\.origin\)\.href/u
  );
  assert.doesNotMatch(pairingMarkup, /<a\b|href=|authorizeTablet/iu);
  assert.match(availabilitySource, /title\.textContent = 'This tablet needs authorization';/u);
  assert.match(availabilitySource, /staffClockAvailability === 'ready' && !staffClockPeople\.length/u);
  assert.match(availabilitySource, /staffClockAvailability = 'unavailable'/u);
  assert.match(availabilitySource, /controls\.hidden = !ready/u);
  assert.match(availabilitySource, /select\.disabled = !ready/u);
  assert.match(clientSource, /Staff Clock is unavailable/u);
  assert.match(clientSource, /error\?\.staffClockStatus === 401/u);
  assert.match(clientSource, /staffClockAvailability !== 'ready'/u);
});

test('tablet pairing uses only an in-memory short code and never navigates to Admin', () => {
  const pairingSource = between(
    clientSource,
    'function validStaffClockPairingCode(value)',
    'function validatedStaffClockSnapshotStart(value)'
  );

  assert.match(
    pairingSource,
    /\^\[0-9A-HJ-KM-NP-TV-Z\]\{5\}-\[0-9A-HJ-KM-NP-TV-Z\]\{5\}\$/u
  );
  assert.match(pairingSource, /staffClockPairingCode = data\.pairingCode/u);
  assert.match(pairingSource, /staffClockPairingCode = ''/u);
  assert.doesNotMatch(pairingSource, /localStorage|sessionStorage|URLSearchParams/u);
  assert.doesNotMatch(
    pairingSource,
    /location\.(?:href|assign|replace)|window\.open|document\.location/u
  );
  assert.doesNotMatch(kioskHtml, /\?authorizeTablet(?:=1)?/u);
  assert.doesNotMatch(clientSource, /\?authorizeTablet(?:=1)?/u);
});

test('tablet pairing is enabled by the installation profile and remains absent from Richmond', () => {
  const pairingAvailabilitySource = between(
    clientSource,
    'const STAFF_CLOCK_PAIRING_ENABLED',
    'if (\n'
  );

  assert.equal(
    (installationProfileSource.match(/featureFlags: Object\.freeze\(\{ staffClock: false, staffClockPairing: false \}\)/gu) || []).length,
    3
  );
  assert.equal(
    (installationProfileSource.match(/featureFlags: Object\.freeze\(\{ staffClock: true, staffClockPairing: true \}\)/gu) || []).length,
    1
  );
  assert.match(kioskHtml, /const STAFF_CLOCK_ENABLED = INSTALLATION\.featureFlags\.staffClock === true/u);
  assert.match(
    kioskHtml,
    /const STAFF_CLOCK_PAIRING_ENABLED = INSTALLATION\.featureFlags\.staffClockPairing === true/u
  );
  assert.match(
    installationProfileSource,
    /dataset\.m1StaffClockPairing = String\(profile\.featureFlags\.staffClockPairing\)/u
  );
  assert.match(kioskHtml, /html:not\(\[data-m1-staff-clock="true"\]\) #staffClock/u);
  assert.match(pairingAvailabilitySource, /featureFlags\?\.staffClockPairing === true/u);
  assert.match(pairingAvailabilitySource, /installationProfile\?\.allowedOrigin === STAFF_CLOCK_PAIRING_CONFIG\.origin/u);
  assert.match(pairingAvailabilitySource, /location\.origin === STAFF_CLOCK_PAIRING_CONFIG\.origin/u);
  assert.doesNotMatch(pairingAvailabilitySource, /Richmond|richmond|installationId|siteCode|'rev'/u);
});

test('Staff Clock state and transport remain isolated from Instructor Sign-In', () => {
  assert.match(clientSource, /gib_m1b_staff_clock_state_v1/u);
  assert.match(clientSource, /gib_m1b_staff_clock_staff_v1/u);
  assert.match(clientSource, /\/api\/m1-staff-clock/u);
  assert.doesNotMatch(clientSource, /gib_m1_signins_v1|gib_m1_sync_queue_v1|m1-kiosk-sync/u);
  assert.doesNotMatch(clientSource, /localStorage\.clear/u);

  const resetSource = between(kioskHtml, 'function resetDevice()', 'function factoryReset()');
  const factorySource = between(kioskHtml, 'function factoryReset()', 'function getSiteCode(');
  assert.match(resetSource, /!k\.startsWith\('gib_m1b_'\)/u);
  assert.match(factorySource, /!k\.startsWith\('gib_m1b_'\)/u);
});

test('a punch is durably saved before sync and duplicate taps are locked', () => {
  const actionSource = between(
    clientSource,
    'function performStaffClockAction()',
    'function resetStaffClockCard()'
  );
  assert.ok(actionSource.indexOf('saveStaffClockState') < actionSource.indexOf('syncStaffClockQueue'));
  assert.match(actionSource, /staffClockActionLocked\s*\|\| staffClockConfirmationActive/u);
  assert.match(actionSource, /createStaffClockPunchId\(\)/u);
  assert.match(actionSource, /punchAction: expectedAction/u);
  assert.match(actionSource, /status: 'ACTIVE'/u);
  assert.match(actionSource, /source: 'Tablet'/u);
  assert.match(actionSource, /queue: \[\.\.\.state\.queue, punch\]/u);
});

test('confirmation, offline retention, and retry lifecycle stay visible and automatic', () => {
  assert.match(clientSource, /window\.setTimeout\([\s\S]*?800/u);
  assert.match(clientSource, /waiting to sync/iu);
  assert.match(clientSource, /STAFF_CLOCK_RETRY_INTERVAL_MS = 30_000/u);
  assert.match(clientSource, /window\.addEventListener\('online'/u);
  assert.match(clientSource, /\['focus', 'pageshow'\]/u);
  assert.match(clientSource, /document\.addEventListener\('visibilitychange'/u);
  assert.match(clientSource, /navigator\.onLine/u);
});

test('state-aware UX clocks out next and shows exact unrounded elapsed time', () => {
  const state = evaluateStaffState('mandy-test', [CLOCK_IN], {
    now: new Date('2026-08-18T13:00:00-04:00')
  });
  assert.equal(state.clockedIn, true);
  assert.equal(state.nextPunchAction, 'clockOut');
  assert.equal(state.needsAttention, false);

  const review = buildStaffReview({
    confirmedRecords: [CLOCK_IN, CLOCK_OUT],
    staffMembers: [{ staffId: 'mandy-test', staffName: 'Mandy Test' }],
    now: new Date('2026-08-18T18:00:00-04:00')
  });
  const total = review.payPeriods.current.staffTotals[0];
  assert.equal(total.completedShifts, 1);
  assert.equal(total.totalMilliseconds, 29_279_000);
});

test('ambiguous prior-day and contradictory punches stop ordinary clocking', () => {
  const priorDay = record({
    id: '33333333-3333-4333-8333-333333333333',
    timestamp: '2026-08-17T21:00:00-04:00',
    action: 'clockIn'
  });
  const overnight = evaluateStaffState('mandy-test', [priorDay], {
    now: new Date('2026-08-18T08:00:00-04:00')
  });
  assert.equal(overnight.clockedIn, true);
  assert.equal(overnight.nextPunchAction, null);
  assert.equal(overnight.needsAttention, true);

  const repeated = evaluateStaffState('mandy-test', [CLOCK_IN, {
    ...CLOCK_OUT,
    punchAction: 'clockIn'
  }], { now: new Date('2026-08-18T18:00:00-04:00') });
  assert.equal(repeated.clockedIn, null);
  assert.equal(repeated.needsAttention, true);
  assert.match(clientSource, /statusElement\.textContent = 'Needs attention'/u);
});

test('local Admin summary is compact and secure corrections live in the existing Admin app', () => {
  const adminMarkup = between(kioskHtml, '<section id="admin"', '<div id="toast"');
  const recent = adminMarkup.indexOf('id="recentSignins"');
  const staff = adminMarkup.indexOf('id="staffTimeSection"');
  assert.ok(recent >= 0 && staff > recent);
  assert.match(clientSource, /Clocked in now/u);
  assert.match(clientSource, /Today’s punches/u);
  assert.match(clientSource, /Needs attention/u);
  assert.match(clientSource, /Pay-period totals/u);
  assert.match(clientSource, /\/m1\/admin\/#staff-time/u);
  assert.match(clientSource, /waiting to sync/iu);
});
