import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  evaluateStaffState,
  mergeStaffRecords,
  sameStaffRecord,
  validStaffMember,
  validStaffRecord
} from '../m1/staff-clock-core.mjs';

const kioskHtml = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../m1/staff-clock-client.mjs', import.meta.url), 'utf8');
const serviceWorkerSource = readFileSync(new URL('../m1/service-worker.js', import.meta.url), 'utf8');

function namedFunctionSource(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} must exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const parametersStart = source.indexOf('(', functionStart);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parametersEnd = index;
        break;
      }
    }
  }
  assert.notEqual(parametersEnd, -1, `${name} parameters must be complete`);
  const brace = source.indexOf('{', parametersEnd + 1);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

const fullRecord = Object.freeze({
  punchId: 'gib-m1-staff-123e4567-e89b-42d3-a456-426614174000',
  timestamp: '2026-08-18T09:30:00-04:00',
  date: '2026-08-18',
  staffId: 'front-desk-test-two',
  staffName: 'Front Desk Test Two',
  punchAction: 'clockIn',
  site: 'Rev TEST',
  device: 'Staff Clock tablet',
  build: '2026-08-18 M1B TEST staff-clock-operational-candidate',
  note: '',
  status: 'ACTIVE',
  source: 'Tablet',
  adminName: '',
  linkedPunchId: '',
  originalTimestamp: '',
  originalDate: '',
  adjustmentRequestId: ''
});

const VIEW_TOKEN = 'a'.repeat(64);
const ADJUSTMENT_REQUEST_ID = 'gib-m1-staff-request-123e4567-e89b-42d3-a456-426614174000';

function snapshotView(overrides = {}) {
  return {
    token: VIEW_TOKEN,
    today: fullRecord.date,
    recordCount: 1,
    recordTotal: 1,
    todayPunchCount: 1,
    todayPunchTotal: 1,
    adjustmentCount: 0,
    adjustmentTotal: 0,
    attentionCount: 0,
    attentionOccurrenceCount: 0,
    auditCount: 0,
    auditTotal: 0,
    recordsTruncated: false,
    auditTruncated: false,
    ...overrides
  };
}

function snapshotSummary(records = [fullRecord], staff = {
  staffId: fullRecord.staffId,
  staffName: fullRecord.staffName
}, overrides = {}) {
  const needsAttention = overrides.needsAttention || [];
  const view = snapshotView({
    recordCount: records.length,
    recordTotal: records.length,
    todayPunchCount: records.filter(record => record.date === fullRecord.date).length,
    todayPunchTotal: records.filter(record => record.date === fullRecord.date).length,
    attentionCount: needsAttention.length,
    attentionOccurrenceCount: needsAttention.reduce((sum, item) => sum + item.occurrenceCount, 0),
    ...overrides.view
  });
  return {
    records,
    clockedInNow: records.length ? [{
      punchId: records[0].punchId,
      staffId: records[0].staffId,
      staffName: records[0].staffName,
      clockInAt: records[0].timestamp
    }] : [],
    needsAttention,
    periods: {
      current: {
        startDate: '2026-08-10',
        endDate: '2026-08-23',
        totals: [{
          ...staff,
          completedShifts: 0,
          totalSeconds: 0,
          needsAttention: false
        }]
      },
      previous: {
        startDate: '2026-07-27',
        endDate: '2026-08-09',
        totals: [{
          ...staff,
          completedShifts: 0,
          totalSeconds: 0,
          needsAttention: false
        }]
      }
    },
    view
  };
}

function snapshotStart(target = 'test', overrides = {}) {
  const summary = snapshotSummary();
  return {
    ok: true,
    target,
    staff: [{ staffId: fullRecord.staffId, staffName: fullRecord.staffName }],
    clockedInNow: summary.clockedInNow,
    periods: summary.periods,
    view: summary.view,
    ...overrides
  };
}

function newYorkDate(value) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value).forEach(part => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function browserRecordNormalizer() {
  return Function('validStaffRecord', 'fmtDate', `
    const STAFF_PUNCH_ID_PATTERN = ${/^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u};
    ${namedFunctionSource(clientSource, 'cleanStaffClockText')}
    ${namedFunctionSource(clientSource, 'validStaffClockTimestamp')}
    return (${namedFunctionSource(clientSource, 'normalizeStaffClockRecord')});
  `)(validStaffRecord, newYorkDate);
}

function createPairingHarness(responses, options = {}) {
  const calls = [];
  const timers = [];
  const nowRef = { value: options.now ?? Date.now() };
  const nodes = {
    '#staffClockAvailability': { hidden: false },
    '#staffClockAvailabilityTitle': { textContent: '' },
    '#staffClockAvailabilityDetail': { textContent: '' },
    '#staffClockPairingCodeWrap': { hidden: true },
    '#staffClockPairingCode': { textContent: '' },
    '#staffClockPairingExpiry': { textContent: '' },
    '#staffClockPairingInstructions': { hidden: true },
    '#staffClockPairingAdminUrl': { textContent: '' },
    '#retryStaffClock': { hidden: true, textContent: '' },
    '#cancelStaffClockPairing': { hidden: true, disabled: false },
    '#staffClockControls': { hidden: false },
    '#staffClockName': { disabled: false },
    '#btnStaffClockAction': { disabled: false }
  };
  return Function(
    'responses',
    'calls',
    'timers',
    'nowRef',
    'nodes',
    'NativeDate',
    'online',
    'onRefresh',
    `
      const Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [nowRef.value])); }
        static now() { return nowRef.value; }
        static parse(value) { return NativeDate.parse(value); }
      };
      let nextTimerId = 1;
      const window = {
        setTimeout(callback, delay = 0) {
          const timer = { id: nextTimerId++, callback, delay, cancelled: false };
          timers.push(timer);
          return timer.id;
        },
        clearTimeout(id) {
          const timer = timers.find(item => item.id === id);
          if (timer) timer.cancelled = true;
        }
      };
      const navigator = { onLine: online };
      const installationProfile = {
        gymName: 'Revolution BJJ',
        deviceLabel: 'Revolution BJJ front desk'
      };
      const TZ = 'America/New_York';
      const STAFF_CLOCK_PAIRING_AVAILABLE = true;
      const STAFF_CLOCK_PAIRING_CONFIG = { origin: 'https://gib-live.netlify.app' };
      const STAFF_CLOCK_PAIRING_POLL_INTERVAL_MS = 30_000;
      const STAFF_CLOCK_PAIRING_APPROVED_POLL_MS = 250;
      const STAFF_CLOCK_PAIRING_MAX_LIFETIME_MS = 12 * 60 * 60_000;
      const STAFF_CLOCK_PAIRING_MAX_DELIVERY_WINDOW_MS = 2 * 60_000;
      let staffClockPairingPromise = null;
      let staffClockPairingPollTimer = null;
      let staffClockPairingCode = '';
      let staffClockPairingExpiresAt = '';
      let staffClockPairingDeliveryExpiresAt = '';
      let staffClockAvailability = 'loading';
      let staffClockPeople = [];
      let staffClockConfirmationActive = false;
      let staffClockAuthorizationRecoveryInProgress = false;
      let refreshCount = 0;
      const refreshPromises = [];
      const $ = selector => nodes[selector] || null;
      const postStaffClockPairing = async operation => {
        calls.push(operation);
        const next = responses.shift();
        if (next?.throws) {
          const error = new Error(next.message || 'network interrupted');
          if (Number.isSafeInteger(next.status)) error.staffClockPairingStatus = next.status;
          if (next.data) error.staffClockPairingData = next.data;
          throw error;
        }
        return next;
      };
      const refreshStaffClockSnapshot = () => {
        refreshCount += 1;
        const pending = Promise.resolve().then(onRefresh);
        refreshPromises.push(pending);
        return pending;
      };
      const refreshStaffClockRosterAfterAuthorization = refreshStaffClockSnapshot;
      ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
      ${namedFunctionSource(clientSource, 'setStaffClockAvailability')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingCode')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingTimestamp')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingPending')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingResult')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingApproved')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingExpired')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingAuthorizationRequired')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingRejected')}
      ${namedFunctionSource(clientSource, 'validStaffClockPairingTerminal')}
      ${namedFunctionSource(clientSource, 'clearStaffClockPairingTimer')}
      ${namedFunctionSource(clientSource, 'clearStaffClockPairingMemory')}
      ${namedFunctionSource(clientSource, 'staffClockPairingExpiresLabel')}
      ${namedFunctionSource(clientSource, 'renderStaffClockPairingPending')}
      ${namedFunctionSource(clientSource, 'renderStaffClockPairingExpired')}
      ${namedFunctionSource(clientSource, 'cancelStaffClockPairing')}
      ${namedFunctionSource(clientSource, 'scheduleStaffClockPairingPoll')}
      ${namedFunctionSource(clientSource, 'staffClockPairingStillCurrent')}
      ${namedFunctionSource(clientSource, 'runStaffClockPairing')}
      ${namedFunctionSource(clientSource, 'ensureStaffClockPairing')}
      ${namedFunctionSource(clientSource, 'restartStaffClockPairing')}
      return {
        run: runStaffClockPairing,
        ensure: ensureStaffClockPairing,
        restart: restartStaffClockPairing,
        cancel: cancelStaffClockPairing,
        advanceTo(value) { nowRef.value = value; },
        flushZeroTimers() {
          timers.filter(timer => !timer.cancelled && timer.delay === 0).forEach(timer => {
            timer.cancelled = true;
            timer.callback();
          });
        },
        async settleRefreshes() {
          await Promise.all(refreshPromises);
        },
        state() {
          return {
            availability: staffClockAvailability,
            code: staffClockPairingCode,
            expiresAt: staffClockPairingExpiresAt,
            deliveryExpiresAt: staffClockPairingDeliveryExpiresAt,
            refreshCount,
            recoveryInProgress: staffClockAuthorizationRecoveryInProgress,
            calls: [...calls],
            activeTimerDelays: timers.filter(timer => !timer.cancelled).map(timer => timer.delay),
            title: nodes['#staffClockAvailabilityTitle'].textContent,
            detail: nodes['#staffClockAvailabilityDetail'].textContent,
            displayedCode: nodes['#staffClockPairingCode'].textContent,
            expiryLabel: nodes['#staffClockPairingExpiry'].textContent,
            codeHidden: nodes['#staffClockPairingCodeWrap'].hidden,
            instructionsHidden: nodes['#staffClockPairingInstructions'].hidden,
            retryHidden: nodes['#retryStaffClock'].hidden,
            retryLabel: nodes['#retryStaffClock'].textContent,
            cancelHidden: nodes['#cancelStaffClockPairing'].hidden,
            controlsHidden: nodes['#staffClockControls'].hidden
          };
        }
      };
    `
  )(
    responses,
    calls,
    timers,
    nowRef,
    nodes,
    Date,
    options.online !== false,
    options.onRefresh || (() => null)
  );
}

test('Staff Clock is isolated from the inherited inline kiosk client', () => {
  const inlineModule = kioskHtml.match(/<script type="module">([\s\S]*?)<\/script>/u)?.[1] || '';
  assert.match(
    kioskHtml,
    /<script type="module" src="\.\/staff-clock-client\.mjs\?v=2026-08-28-tablet-pairing-r2"><\/script>/u
  );
  assert.doesNotMatch(inlineModule, /staff-clock-core|staffClockSyncPunch|syncStaffClockQueue|renderStaffTimeAdmin/u);
});

test('fresh and reset tablets never expose an empty functional Staff Clock selector', () => {
  const nodes = {
    '#staffClockAvailability': { hidden: false },
    '#staffClockAvailabilityTitle': { textContent: '' },
    '#staffClockAvailabilityDetail': { textContent: '' },
    '#staffClockPairingCodeWrap': { hidden: false },
    '#staffClockPairingCode': { textContent: 'STALE-CODE' },
    '#staffClockPairingExpiry': { textContent: 'stale expiry' },
    '#staffClockPairingInstructions': { hidden: false },
    '#retryStaffClock': { hidden: true },
    '#cancelStaffClockPairing': { hidden: false },
    '#staffClockControls': { hidden: false },
    '#staffClockName': { disabled: false },
    '#btnStaffClockAction': { disabled: false }
  };
  const harness = Function('nodes', `
    let staffClockAvailability = 'loading';
    let staffClockPeople = [];
    let staffClockConfirmationActive = false;
    const IS_PRODUCTION_ORIGIN = true;
    const $ = selector => nodes[selector] || null;
    ${namedFunctionSource(clientSource, 'setStaffClockAvailability')}
    return {
      setStaffClockAvailability,
      setPeople(value) { staffClockPeople = value; }
    };
  `)(nodes);

  harness.setStaffClockAvailability('loading');
  assert.equal(nodes['#staffClockControls'].hidden, true);
  assert.equal(nodes['#staffClockName'].disabled, true);
  assert.equal(nodes['#btnStaffClockAction'].disabled, true);
  assert.equal(nodes['#staffClockAvailabilityTitle'].textContent, 'Loading Staff Clock…');

  harness.setStaffClockAvailability('authorization-required');
  assert.equal(nodes['#staffClockControls'].hidden, true);
  assert.equal(nodes['#staffClockPairingCodeWrap'].hidden, true);
  assert.equal(nodes['#staffClockPairingInstructions'].hidden, true);
  assert.equal(nodes['#staffClockPairingCode'].textContent, '');
  assert.equal(nodes['#staffClockPairingExpiry'].textContent, '');
  assert.equal(nodes['#retryStaffClock'].hidden, true);
  assert.equal(nodes['#cancelStaffClockPairing'].hidden, true);
  assert.equal(nodes['#staffClockAvailabilityTitle'].textContent, 'This tablet needs authorization');

  harness.setStaffClockAvailability('unavailable');
  assert.equal(nodes['#staffClockControls'].hidden, true);
  assert.equal(nodes['#retryStaffClock'].hidden, false);
  assert.equal(nodes['#staffClockAvailabilityTitle'].textContent, 'Staff Clock is unavailable');

  harness.setPeople([{ staffId: 'mandy-test', staffName: 'Mandy Test' }]);
  harness.setStaffClockAvailability('ready');
  assert.equal(nodes['#staffClockAvailability'].hidden, true);
  assert.equal(nodes['#staffClockControls'].hidden, false);
  assert.equal(nodes['#staffClockName'].disabled, false);
});

test('tablet pairing accepts only the exact unbiased Crockford XXXXX-XXXXX code shape', () => {
  const validate = Function(`return (${namedFunctionSource(clientSource, 'validStaffClockPairingCode')});`)();
  for (const value of [
    'ABCDE-FGHJK',
    '01234-56789',
    'MNPQR-STVWX',
    'ZZZZZ-ZZZZZ'
  ]) assert.equal(validate(value), true, value);

  for (const value of [
    'ABCD-EFGHJ',
    'ABCDEF-GHJK',
    'abcde-fghjk',
    'ABCDI-FGHJK',
    'ABCDL-FGHJK',
    'ABCDO-FGHJK',
    'ABCDU-FGHJK',
    'ABCDE-FGHJ1-extra',
    'ABCDE FGHJK'
  ]) assert.equal(validate(value), false, value);
});

test('tablet pairing start and poll use separate same-origin endpoints with exact operation bodies', async () => {
  const calls = [];
  const fetch = async (endpoint, options) => {
    calls.push({ endpoint, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: 'authorized' })
    };
  };
  const fakeWindow = {
    setTimeout() { return 1; },
    clearTimeout() {}
  };
  const post = Function('fetch', 'window', `
    const STAFF_CLOCK_PAIRING_START_ENDPOINT = '/api/m1-tablet-pairing-start';
    const STAFF_CLOCK_PAIRING_POLL_ENDPOINT = '/api/m1-tablet-pairing-poll';
    const STAFF_CLOCK_PAIRING_CANCEL_ENDPOINT = '/api/m1-tablet-pairing-cancel';
    return (${namedFunctionSource(clientSource, 'postStaffClockPairing')});
  `)(fetch, fakeWindow);

  await post('start');
  await post('poll');
  await post('cancel');
  await assert.rejects(post('review'), /operation was invalid/u);
  assert.deepEqual(calls.map(({ endpoint, options }) => ({
    endpoint,
    method: options.method,
    credentials: options.credentials,
    mode: options.mode,
    redirect: options.redirect,
    cache: options.cache,
    headers: options.headers,
    body: JSON.parse(options.body)
  })), [
    {
      endpoint: '/api/m1-tablet-pairing-start',
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { operation: 'start' }
    },
    {
      endpoint: '/api/m1-tablet-pairing-poll',
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { operation: 'poll' }
    },
    {
      endpoint: '/api/m1-tablet-pairing-cancel',
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { operation: 'cancel' }
    }
  ]);
});

test('pending to approved to authorized pairing clears the code and refreshes the roster automatically', async () => {
  const now = Date.parse('2026-08-27T14:00:00-04:00');
  const expiresAt = new Date(now + 12 * 60 * 60_000).toISOString();
  const deliveryExpiresAt = new Date(Date.parse(expiresAt) + 120_000).toISOString();
  const harness = createPairingHarness([
    {
      ok: true,
      result: 'pending',
      pairingCode: 'ABCDE-FGHJK',
      expiresAt,
      gymName: 'Revolution BJJ',
      deviceLabel: 'Revolution BJJ front desk'
    },
    { ok: true, result: 'approved', expiresAt, deliveryExpiresAt },
    { ok: true, result: 'authorized' }
  ], { now });

  await harness.run('start');
  let state = harness.state();
  assert.equal(state.availability, 'authorization-required');
  assert.equal(state.title, 'This tablet needs authorization');
  assert.equal(state.code, 'ABCDE-FGHJK');
  assert.equal(state.displayedCode, 'ABCDE-FGHJK');
  assert.equal(state.codeHidden, false);
  assert.equal(state.instructionsHidden, false);
  assert.equal(state.controlsHidden, true);
  assert.deepEqual(state.activeTimerDelays, [30_000]);

  await harness.run('poll');
  state = harness.state();
  assert.equal(state.code, '');
  assert.equal(state.displayedCode, '');
  assert.equal(state.codeHidden, true);
  assert.equal(state.deliveryExpiresAt, deliveryExpiresAt);
  assert.match(state.detail, /Admin approved this tablet/u);
  assert.deepEqual(state.activeTimerDelays, [250]);

  await harness.run('poll');
  state = harness.state();
  assert.equal(state.availability, 'loading');
  assert.equal(state.code, '');
  assert.equal(state.expiresAt, '');
  assert.equal(state.deliveryExpiresAt, '');
  assert.deepEqual(state.calls, ['start', 'poll', 'poll']);
  assert.equal(state.refreshCount, 0);
  assert.deepEqual(state.activeTimerDelays, [0]);
  harness.flushZeroTimers();
  assert.equal(harness.state().refreshCount, 1);
});

test('tablet cancellation is explicit and an approval that wins the race still completes authorization', async () => {
  const now = Date.parse('2026-08-28T06:45:00-04:00');
  const pending = {
    ok: true,
    result: 'pending',
    pairingCode: 'ABCDE-FGHJK',
    expiresAt: new Date(now + 11 * 60 * 60_000).toISOString(),
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk'
  };

  const cancelled = createPairingHarness([
    pending,
    { ok: true, result: 'cancelled' }
  ], { now });
  await cancelled.run('start');
  await cancelled.cancel();
  assert.deepEqual(cancelled.state().calls, ['start', 'cancel']);
  assert.equal(cancelled.state().code, '');
  assert.equal(cancelled.state().cancelHidden, true);
  assert.equal(cancelled.state().retryLabel, 'Get a new code');
  assert.match(cancelled.state().detail, /No Admin can approve that code/u);

  const approvalWon = createPairingHarness([
    pending,
    {
      ok: true,
      result: 'approved',
      expiresAt: pending.expiresAt,
      deliveryExpiresAt: new Date(Date.parse(pending.expiresAt) + 120_000).toISOString()
    },
    { ok: true, result: 'authorized' }
  ], { now });
  await approvalWon.run('start');
  await approvalWon.cancel();
  assert.equal(approvalWon.state().code, '');
  assert.match(approvalWon.state().detail, /approval completed first/u);
  assert.deepEqual(approvalWon.state().activeTimerDelays, [250]);
  await approvalWon.run('poll');
  approvalWon.flushZeroTimers();
  assert.equal(approvalWon.state().refreshCount, 1);
  assert.deepEqual(approvalWon.state().calls, ['start', 'cancel', 'poll']);
});

test('an authorized pairing response locks queue sync before its deferred roster callback', async () => {
  const pairing = createPairingHarness([
    { ok: true, result: 'authorized' }
  ], { now: Date.parse('2026-08-27T14:00:00-04:00') });
  await pairing.run('start');
  assert.equal(pairing.state().recoveryInProgress, true);
  assert.deepEqual(pairing.state().activeTimerDelays, [0]);

  const lifecycle = Function(`
    let staffClockSyncPromise = null;
    let staffClockSyncRequested = false;
    let staffClockAvailability = 'loading';
    let staffClockAuthorizationRecoveryInProgress = true;
    let posts = 0;
    const navigator = { onLine: true };
    const postStaffClock = async () => { posts += 1; };
    ${namedFunctionSource(clientSource, 'syncStaffClockQueue')}
    return {
      run: syncStaffClockQueue,
      posts: () => posts
    };
  `)();
  assert.equal(await lifecycle.run(), null);
  assert.equal(lifecycle.posts(), 0);

  const authorizedBranch = namedFunctionSource(clientSource, 'runStaffClockPairing');
  assert.ok(
    authorizedBranch.indexOf('staffClockAuthorizationRecoveryInProgress = true;')
      < authorizedBranch.indexOf('window.setTimeout(() => {'),
    'the recovery guard must be set synchronously before the deferred callback'
  );
});

test('5:45 pairing survives reload and delayed post-approval reconnect, then repopulates the roster automatically', async () => {
  const staff = [
    { staffId: 'mandy', staffName: 'Mandy' },
    { staffId: 'marvin', staffName: 'Marvin' }
  ];
  const totals = staff.map(person => ({
    ...person,
    completedShifts: 0,
    totalSeconds: 0,
    needsAttention: false
  }));
  const productionSnapshot = {
    ok: true,
    target: 'production',
    staff,
    clockedInNow: [],
    periods: {
      current: {
        startDate: '2026-08-10',
        endDate: '2026-08-23',
        totals
      },
      previous: {
        startDate: '2026-07-27',
        endDate: '2026-08-09',
        totals
      }
    },
    view: snapshotView({
      recordCount: 0,
      recordTotal: 0,
      todayPunchCount: 0,
      todayPunchTotal: 0,
      adjustmentCount: 0,
      adjustmentTotal: 0,
      attentionCount: 0,
      attentionOccurrenceCount: 0
    })
  };
  const businessValues = Object.freeze({
    gib_m1_signins_v1: '[{"RowID":"existing-sign-in"}]',
    gib_m1_sync_queue_v1: '[{"RowID":"waiting-sign-in"}]',
    gib_m1_schedule_v1: '{"Monday":["existing-class"]}',
    gib_m1_duration_rules_v1: '{"defaultMinutes":60}'
  });
  const storage = new Map(Object.entries(businessValues));
  const preservedStaffClockState = {
    version: 2,
    baseline: null,
    overlay: [fullRecord],
    queue: [fullRecord]
  };
  const preservedStaffClockStateBytes = JSON.stringify(preservedStaffClockState);
  storage.set('gib_m1b_staff_clock_state_v1', preservedStaffClockStateBytes);
  const writes = [];
  const snapshotCalls = [];
  const snapshotHarness = Function(
    'snapshot',
    'storage',
    'writes',
    'snapshotCalls',
    'validStaffMember',
    'initialState',
    `
      const STAFF_CLOCK_STATE_KEY = 'gib_m1b_staff_clock_state_v1';
      const STAFF_CLOCK_STAFF_CACHE_KEY = 'gib_m1b_staff_clock_staff_v1';
      const STAFF_CLOCK_STATE_VERSION = 2;
      const STAFF_CLOCK_MAX_INCLUDED_RECORDS = 500;
      const STAFF_CLOCK_MAX_ATTENTION_GROUPS = 600;
      const STAFF_PUNCH_ID_PATTERN = ${/^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u};
      const IS_PRODUCTION_ORIGIN = true;
      const navigator = { onLine: true };
      const localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem(key, value) {
          writes.push(key);
          storage.set(key, value);
        },
        removeItem() { throw new Error('Pairing recovery must not remove tablet data.'); },
        clear() { throw new Error('Pairing recovery must not clear tablet data.'); }
      };
      const select = {
        value: '',
        disabled: true,
        children: [],
        replaceChildren(...children) { this.children = [...children]; },
        appendChild(child) { this.children.push(child); }
      };
      const nodes = {
        '#staffClockAvailability': { hidden: false },
        '#staffClockAvailabilityTitle': { textContent: '' },
        '#staffClockAvailabilityDetail': { textContent: '' },
        '#staffClockPairingCodeWrap': { hidden: true },
        '#staffClockPairingCode': { textContent: '' },
        '#staffClockPairingExpiry': { textContent: '' },
        '#staffClockPairingInstructions': { hidden: true },
        '#retryStaffClock': { hidden: true, textContent: '' },
        '#staffClockControls': { hidden: true },
        '#staffClockName': select,
        '#btnStaffClockAction': { disabled: true }
      };
      const document = {
        createElement(tag) {
          if (tag !== 'option') throw new Error('Unexpected element.');
          return { value: '', textContent: '' };
        }
      };
      const $ = selector => nodes[selector] || null;
      let staffClockPeople = [];
      let staffClockAvailability = 'loading';
      let staffClockConfirmationActive = false;
      let staffClockAuthorizationRecoveryInProgress = false;
      const state = initialState;
      let adminRendered = 0;
      const postStaffClock = async body => {
        snapshotCalls.push(body);
        if (body.operation !== 'snapshot') throw new Error('No page is needed for an empty history.');
        return snapshot;
      };
      const normalizeStaffClockRecordList = value => (
        Array.isArray(value) && value.length === 0 ? [] : null
      );
      const validatedStaffClockSnapshotPage = () => {
        throw new Error('No snapshot page should be requested.');
      };
      const loadStaffClockState = () => state;
      const renderStaffClock = () => {};
      const renderStaffTimeAdmin = () => { adminRendered += 1; };
      const clearStaffClockPairingMemory = () => {};
      const showStaffClockAuthorizationRequired = () => {
        throw new Error('The authorized snapshot must not return to recovery.');
      };
      ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
      ${namedFunctionSource(clientSource, 'cleanStaffClockText')}
      ${namedFunctionSource(clientSource, 'normalizeStaffClockPerson')}
      ${namedFunctionSource(clientSource, 'validStaffClockTimestamp')}
      ${namedFunctionSource(clientSource, 'dateKeyAsUtc')}
      ${namedFunctionSource(clientSource, 'utcAsDateKey')}
      ${namedFunctionSource(clientSource, 'normalizeStaffClockPeriod')}
      ${namedFunctionSource(clientSource, 'normalizeStaffClockPeriods')}
      ${namedFunctionSource(clientSource, 'normalizeStaffClockView')}
      ${namedFunctionSource(clientSource, 'normalizeStaffClockSummary')}
      ${namedFunctionSource(clientSource, 'validatedStaffClockSnapshotStart')}
      ${namedFunctionSource(clientSource, 'saveStaffClockPeople')}
      ${namedFunctionSource(clientSource, 'setStaffClockAvailability')}
      ${namedFunctionSource(clientSource, 'populateStaffClockPeople')}
      ${namedFunctionSource(clientSource, 'loadStaffClockSnapshot')}
      ${namedFunctionSource(clientSource, 'loadStaffClockSnapshotWithRetry')}
      ${namedFunctionSource(clientSource, 'refreshStaffClockRosterAfterAuthorization')}
      return {
        refreshStaffClockRosterAfterAuthorization,
        result() {
          return {
            state,
            staffClockPeople,
            availability: staffClockAvailability,
            options: select.children.map(option => ({
              value: option.value,
              textContent: option.textContent
            })),
            controlsHidden: nodes['#staffClockControls'].hidden,
            cache: JSON.parse(storage.get(STAFF_CLOCK_STAFF_CACHE_KEY)),
            adminRendered
          };
        }
      };
    `
  )(
    productionSnapshot,
    storage,
    writes,
    snapshotCalls,
    validStaffMember,
    preservedStaffClockState
  );

  const generatedAt = Date.parse('2026-08-28T05:45:00-04:00');
  const approvedAt = Date.parse('2026-08-28T06:45:00-04:00');
  const reconnectedAt = Date.parse('2026-08-28T07:15:00-04:00');
  assert.ok(reconnectedAt - approvedAt > 2 * 60_000);
  const expiresAt = new Date(generatedAt + 12 * 60 * 60_000).toISOString();
  const pending = {
    ok: true,
    result: 'pending',
    pairingCode: 'ABCDE-FGHJK',
    expiresAt,
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk'
  };
  const beforeReload = createPairingHarness([
    pending,
    { throws: true, message: 'network interrupted' }
  ], { now: generatedAt });
  await beforeReload.run('start');
  await beforeReload.run('poll');
  assert.equal(beforeReload.state().code, pending.pairingCode);
  assert.match(beforeReload.state().detail, /without changing this code/u);
  assert.match(beforeReload.state().expiryLabel, /Aug 28, 2026/u);
  assert.match(beforeReload.state().expiryLabel, /5:45:00 PM/u);

  // A new browser runtime represents a tablet reload. The HttpOnly request
  // cookie is recovered by the server, which returns the same code and expiry.
  const pairingHarness = createPairingHarness([
    pending,
    {
      ok: true,
      result: 'approved',
      expiresAt,
      deliveryExpiresAt: new Date(Date.parse(expiresAt) + 120_000).toISOString()
    },
    { ok: true, result: 'authorized' }
  ], {
    now: reconnectedAt,
    onRefresh: snapshotHarness.refreshStaffClockRosterAfterAuthorization
  });
  await pairingHarness.run('start');
  assert.equal(pairingHarness.state().code, beforeReload.state().code);
  assert.equal(pairingHarness.state().expiresAt, beforeReload.state().expiresAt);
  await pairingHarness.run('poll');
  await pairingHarness.run('poll');
  pairingHarness.flushZeroTimers();
  await pairingHarness.settleRefreshes();

  assert.deepEqual(snapshotCalls, [{ operation: 'snapshot' }]);
  assert.deepEqual(snapshotHarness.result(), {
    state: preservedStaffClockState,
    staffClockPeople: staff,
    availability: 'loading',
    options: [
      { value: '', textContent: 'Select staff member' },
      { value: 'mandy', textContent: 'Mandy' },
      { value: 'marvin', textContent: 'Marvin' }
    ],
    controlsHidden: true,
    cache: { version: 1, staff },
    adminRendered: 1
  });
  assert.deepEqual(writes, ['gib_m1b_staff_clock_staff_v1']);
  assert.equal(storage.get('gib_m1b_staff_clock_state_v1'), preservedStaffClockStateBytes);
  for (const [key, value] of Object.entries(businessValues)) {
    assert.equal(storage.get(key), value, key);
  }
});

test('authorization recovery keeps a cached roster and durable queue locked and byte-identical when its snapshot fails', async t => {
  const cachedStaff = [
    { staffId: 'mandy', staffName: 'Mandy' },
    { staffId: 'marvin', staffName: 'Marvin' }
  ];
  const cachedRosterBytes = JSON.stringify({ version: 1, staff: cachedStaff });
  const queuedRecord = {
    ...fullRecord,
    staffId: 'mandy',
    staffName: 'Mandy'
  };
  const stateBytes = JSON.stringify({
    version: 2,
    baseline: null,
    overlay: [queuedRecord],
    queue: [queuedRecord]
  });

  for (const failureMode of ['http-500', 'invalid-response']) {
    await t.test(failureMode, async () => {
      const harness = Function(
        'failureMode',
        'cachedRosterBytes',
        'stateBytes',
        `
          const cachedRoster = JSON.parse(cachedRosterBytes);
          const state = JSON.parse(stateBytes);
          const storage = new Map([
            ['gib_m1b_staff_clock_staff_v1', cachedRosterBytes],
            ['gib_m1b_staff_clock_state_v1', stateBytes]
          ]);
          const localStorage = {
            getItem: key => storage.get(key) ?? null,
            setItem() { throw new Error('Failed authorization recovery must not write tablet data.'); },
            removeItem() { throw new Error('Failed authorization recovery must not remove tablet data.'); },
            clear() { throw new Error('Failed authorization recovery must not clear tablet data.'); }
          };
          const nodes = {
            '#staffClockAvailability': { hidden: true },
            '#staffClockAvailabilityTitle': { textContent: '' },
            '#staffClockAvailabilityDetail': { textContent: '' },
            '#staffClockPairingCodeWrap': { hidden: false },
            '#staffClockPairingCode': { textContent: 'ABCDE-FGHJK' },
            '#staffClockPairingExpiry': { textContent: '5:00' },
            '#staffClockPairingInstructions': { hidden: false },
            '#retryStaffClock': { hidden: true, textContent: '' },
            '#staffClockControls': { hidden: false },
            '#staffClockName': { disabled: false },
            '#btnStaffClockAction': { disabled: false }
          };
          const $ = selector => nodes[selector] || null;
          let staffClockPeople = cachedRoster.staff;
          let staffClockAvailability = 'loading';
          let staffClockConfirmationActive = false;
          let staffClockAuthorizationRecoveryInProgress = true;
          const IS_PRODUCTION_ORIGIN = true;
          let snapshotPosts = 0;
          let syncPosts = 0;
          let businessPosts = 0;
          const loadStaffClockState = () => state;
          const loadStaffClockSnapshotWithRetry = async () => {
            snapshotPosts += 1;
            if (failureMode === 'http-500') {
              const error = new Error('Synthetic snapshot failure.');
              error.staffClockStatus = 500;
              throw error;
            }
            return null;
          };
          const reconcileStaffClockSnapshotState = () => {
            throw new Error('An invalid snapshot must not reconcile local state.');
          };
          const saveStaffClockState = () => {
            throw new Error('A failed snapshot must not save local state.');
          };
          const saveStaffClockPeople = () => {
            throw new Error('A failed snapshot must not replace the roster cache.');
          };
          const clearStaffClockPairingMemory = () => {
            throw new Error('A failed snapshot must not complete recovery.');
          };
          const populateStaffClockPeople = () => {
            throw new Error('A failed snapshot must not expose cached names.');
          };
          const renderStaffTimeAdmin = () => {
            throw new Error('A failed snapshot must not render server state.');
          };
          const showStaffClockAuthorizationRequired = () => {
            throw new Error('A non-401 snapshot failure is unavailable, not authorization-required.');
          };
          const syncStaffClockQueue = async () => { syncPosts += 1; };
          const postStaffClock = async body => {
            if (body?.operation === 'snapshot' || body?.operation === 'snapshotPage') snapshotPosts += 1;
            else businessPosts += 1;
            throw new Error('Authorization recovery must use only its snapshot loader.');
          };
          ${namedFunctionSource(clientSource, 'setStaffClockAvailability')}
          ${namedFunctionSource(clientSource, 'refreshStaffClockRosterAfterAuthorization')}
          return {
            run: refreshStaffClockRosterAfterAuthorization,
            result() {
              return {
                stateBytes: JSON.stringify(state),
                storedStateBytes: storage.get('gib_m1b_staff_clock_state_v1'),
                cachedRosterBytes: storage.get('gib_m1b_staff_clock_staff_v1'),
                peopleBytes: JSON.stringify(staffClockPeople),
                availability: staffClockAvailability,
                availabilityHidden: nodes['#staffClockAvailability'].hidden,
                title: nodes['#staffClockAvailabilityTitle'].textContent,
                controlsHidden: nodes['#staffClockControls'].hidden,
                selectDisabled: nodes['#staffClockName'].disabled,
                actionDisabled: nodes['#btnStaffClockAction'].disabled,
                pairingCode: nodes['#staffClockPairingCode'].textContent,
                pairingInstructionsHidden: nodes['#staffClockPairingInstructions'].hidden,
                retryHidden: nodes['#retryStaffClock'].hidden,
                retryLabel: nodes['#retryStaffClock'].textContent,
                recoveryInProgress: staffClockAuthorizationRecoveryInProgress,
                snapshotPosts,
                syncPosts,
                businessPosts
              };
            }
          };
        `
      )(failureMode, cachedRosterBytes, stateBytes);

      assert.equal(await harness.run(), null);
      assert.deepEqual(harness.result(), {
        stateBytes,
        storedStateBytes: stateBytes,
        cachedRosterBytes,
        peopleBytes: JSON.stringify(cachedStaff),
        availability: 'unavailable',
        availabilityHidden: false,
        title: 'Staff Clock is unavailable',
        controlsHidden: true,
        selectDisabled: true,
        actionDisabled: true,
        pairingCode: '',
        pairingInstructionsHidden: true,
        retryHidden: false,
        retryLabel: 'Try again',
        recoveryInProgress: false,
        snapshotPosts: 1,
        syncPosts: 0,
        businessPosts: 0
      });
    });
  }
});

test('blank reset state saves an authoritative open Mandy shift and immediately renders Clock out with both roster names cached', async () => {
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-08-27T10:00:00-04:00']));
    }

    static now() {
      return Date.parse('2026-08-27T10:00:00-04:00');
    }
  }
  const staff = [
    { staffId: 'mandy', staffName: 'Mandy' },
    { staffId: 'marvin', staffName: 'Marvin' }
  ];
  const totals = staff.map(person => ({
    ...person,
    completedShifts: 0,
    totalSeconds: 0,
    needsAttention: false
  }));
  const baseline = {
    records: [],
    clockedInNow: [{
      punchId: fullRecord.punchId,
      staffId: 'mandy',
      staffName: 'Mandy',
      clockInAt: '2026-08-27T09:00:00-04:00'
    }],
    needsAttention: [],
    periods: {
      current: {
        startDate: '2026-08-24',
        endDate: '2026-09-06',
        totals
      },
      previous: {
        startDate: '2026-08-10',
        endDate: '2026-08-23',
        totals
      }
    },
    view: snapshotView({
      today: '2026-08-27',
      recordCount: 0,
      recordTotal: 1,
      todayPunchCount: 0,
      todayPunchTotal: 1,
      recordsTruncated: true
    })
  };
  const payload = { staff, baseline };
  const harness = Function(
    'payload',
    'validStaffMember',
    'mergeStaffRecords',
    'evaluateStaffState',
    'Date',
    `
      const STAFF_CLOCK_STATE_KEY = 'gib_m1b_staff_clock_state_v1';
      const STAFF_CLOCK_STAFF_CACHE_KEY = 'gib_m1b_staff_clock_staff_v1';
      const STAFF_CLOCK_STATE_VERSION = 2;
      const TZ = 'America/New_York';
      const storage = new Map();
      const writes = [];
      const snapshotCalls = [];
      const localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem(key, value) {
          writes.push(key);
          storage.set(key, value);
        }
      };
      const select = {
        value: 'mandy',
        disabled: true,
        children: [],
        replaceChildren(...children) { this.children = [...children]; },
        appendChild(child) { this.children.push(child); }
      };
      const status = {
        textContent: '',
        classList: { add() {}, remove() {} }
      };
      const action = {
        textContent: '',
        disabled: true,
        dataset: {}
      };
      const nodes = {
        '#staffClockAvailability': { hidden: false },
        '#staffClockAvailabilityTitle': { textContent: '' },
        '#staffClockAvailabilityDetail': { textContent: '' },
        '#staffClockPairingCodeWrap': { hidden: true },
        '#staffClockPairingCode': { textContent: '' },
        '#staffClockPairingExpiry': { textContent: '' },
        '#staffClockPairingInstructions': { hidden: true },
        '#retryStaffClock': { hidden: true, textContent: '' },
        '#staffClockControls': { hidden: true },
        '#staffClockName': select,
        '#staffClockStatus': status,
        '#btnStaffClockAction': action
      };
      const document = {
        createElement(tag) {
          if (tag !== 'option') throw new Error('Unexpected element.');
          return { value: '', textContent: '' };
        }
      };
      const $ = selector => nodes[selector] || null;
      let state = { version: 2, baseline: null, overlay: [], queue: [] };
      let staffClockPeople = [];
      let staffClockAvailability = 'loading';
      let staffClockConfirmationActive = false;
      let staffClockAuthorizationRecoveryInProgress = true;
      const normalizeStaffClockSummary = value => value;
      const loadStaffClockState = () => state;
      const saveStaffClockState = value => {
        state = value;
        localStorage.setItem(STAFF_CLOCK_STATE_KEY, JSON.stringify(value));
      };
      const loadStaffClockSnapshotWithRetry = async () => {
        snapshotCalls.push({ operation: 'snapshot' });
        return payload;
      };
      const clearStaffClockPairingMemory = () => {};
      const renderStaffTimeAdmin = () => {};
      const showStaffClockAuthorizationRequired = () => {
        throw new Error('Authorized refresh must not return to pairing.');
      };
      ${namedFunctionSource(clientSource, 'fmtDate')}
      ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
      ${namedFunctionSource(clientSource, 'cleanStaffClockText')}
      ${namedFunctionSource(clientSource, 'normalizeStaffClockPerson')}
      ${namedFunctionSource(clientSource, 'reconcileStaffClockSnapshotState')}
      ${namedFunctionSource(clientSource, 'saveStaffClockPeople')}
      ${namedFunctionSource(clientSource, 'setStaffClockAvailability')}
      ${namedFunctionSource(clientSource, 'combinedStaffClockRecords')}
      ${namedFunctionSource(clientSource, 'staffClockBaselineOpenRecord')}
      ${namedFunctionSource(clientSource, 'staffClockStatusFor')}
      ${namedFunctionSource(clientSource, 'selectedStaffClockPerson')}
      ${namedFunctionSource(clientSource, 'formatStaffClockTime')}
      ${namedFunctionSource(clientSource, 'renderStaffClock')}
      ${namedFunctionSource(clientSource, 'populateStaffClockPeople')}
      ${namedFunctionSource(clientSource, 'refreshStaffClockRosterAfterAuthorization')}
      return {
        run: refreshStaffClockRosterAfterAuthorization,
        result() {
          return {
            state,
            people: staffClockPeople,
            availability: staffClockAvailability,
            controlsHidden: nodes['#staffClockControls'].hidden,
            options: select.children.map(option => option.textContent),
            selected: select.value,
            status: status.textContent,
            action: {
              textContent: action.textContent,
              disabled: action.disabled,
              dataset: { ...action.dataset }
            },
            cache: JSON.parse(storage.get(STAFF_CLOCK_STAFF_CACHE_KEY)),
            writes,
            snapshotCalls,
            recoveryInProgress: staffClockAuthorizationRecoveryInProgress
          };
        }
      };
    `
  )(payload, validStaffMember, mergeStaffRecords, evaluateStaffState, FixedDate);

  assert.deepEqual(await harness.run(), payload);
  assert.deepEqual(harness.result(), {
    state: {
      version: 2,
      baseline,
      overlay: [],
      queue: []
    },
    people: staff,
    availability: 'ready',
    controlsHidden: false,
    options: ['Select staff member', 'Mandy', 'Marvin'],
    selected: 'mandy',
    status: 'Clocked in at 9:00 AM',
    action: {
      textContent: 'Clock out',
      disabled: false,
      dataset: { action: 'clockOut' }
    },
    cache: { version: 1, staff },
    writes: [
      'gib_m1b_staff_clock_state_v1',
      'gib_m1b_staff_clock_staff_v1'
    ],
    snapshotCalls: [{ operation: 'snapshot' }],
    recoveryInProgress: false
  });
});

test('reload recovery accepts approved or authorized directly from the start endpoint', async () => {
  const now = Date.parse('2026-08-27T14:00:00-04:00');
  const approved = createPairingHarness([
    {
      ok: true,
      result: 'approved',
      expiresAt: new Date(now + 12 * 60 * 60_000).toISOString(),
      deliveryExpiresAt: new Date(now + (12 * 60 * 60_000) + 120_000).toISOString()
    }
  ], { now });
  await approved.run('start');
  assert.deepEqual(approved.state().calls, ['start']);
  assert.equal(approved.state().codeHidden, true);
  assert.deepEqual(approved.state().activeTimerDelays, [250]);

  const authorized = createPairingHarness([
    { ok: true, result: 'authorized' }
  ], { now });
  await authorized.run('start');
  assert.deepEqual(authorized.state().calls, ['start']);
  assert.equal(authorized.state().availability, 'loading');
  authorized.flushZeroTimers();
  assert.equal(authorized.state().refreshCount, 1);
});

test('pairing expiry and network interruption remain visible, retryable, and bounded', async () => {
  const now = Date.parse('2026-08-27T14:00:00-04:00');
  const expiresAt = new Date(now + 12 * 60 * 60_000).toISOString();
  const pending = {
    ok: true,
    result: 'pending',
    pairingCode: 'ABCDE-FGHJK',
    expiresAt,
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk'
  };
  const expiredData = {
    ok: false,
    result: 'expired',
    message: 'Pairing code expired. Request a new code.'
  };
  const expired = createPairingHarness([
    pending,
    { throws: true, status: 410, data: expiredData }
  ], { now });
  await expired.run('start');
  await expired.run('poll');
  let state = expired.state();
  assert.equal(state.code, '');
  assert.equal(state.displayedCode, '');
  assert.equal(state.codeHidden, true);
  assert.equal(state.retryHidden, false);
  assert.equal(state.retryLabel, 'Get a new code');
  assert.equal(state.detail, expiredData.message);

  const interrupted = createPairingHarness([
    pending,
    { throws: true, message: 'network interrupted' },
    { throws: true, message: 'network interrupted' }
  ], { now });
  await interrupted.run('start');
  await interrupted.run('poll');
  state = interrupted.state();
  assert.equal(state.code, 'ABCDE-FGHJK');
  assert.match(state.detail, /retry automatically without changing this code/u);
  assert.equal(state.retryLabel, 'Retry now');
  assert.deepEqual(state.activeTimerDelays, [30_000]);

  interrupted.advanceTo(Date.parse(expiresAt) + 1);
  await interrupted.run('poll');
  state = interrupted.state();
  assert.equal(state.code, '', 'the display code is cleared at its 12-hour expiry');
  assert.equal(state.displayedCode, '');
  assert.match(state.detail, /after approval may have started/u);
  assert.deepEqual(state.activeTimerDelays, [30_000]);
});

test('terminal authorization, rejection, and cancellation clear stale codes and leave a fresh-code action', async () => {
  const now = Date.parse('2026-08-27T14:00:00-04:00');
  const pending = {
    ok: true,
    result: 'pending',
    pairingCode: 'ABCDE-FGHJK',
    expiresAt: new Date(now + 12 * 60 * 60_000).toISOString(),
    gymName: 'Revolution BJJ',
    deviceLabel: 'Revolution BJJ front desk'
  };
  const terminalResponses = [{
    status: 401,
    data: {
      ok: false,
      result: 'authorization_required',
      message: 'This tablet needs authorization.'
    }
  }, {
    status: 403,
    data: {
      ok: false,
      message: 'Tablet pairing request was not accepted.'
    }
  }, {
    status: 409,
    data: {
      ok: false,
      result: 'rejected',
      message: 'Pairing request was rejected by an Admin.'
    }
  }, {
    status: 409,
    data: {
      ok: false,
      result: 'cancelled',
      message: 'Pairing request was cancelled on this tablet.'
    }
  }];

  for (const terminal of terminalResponses) {
    const harness = createPairingHarness([
      pending,
      { throws: true, ...terminal }
    ], { now });
    await harness.run('start');
    assert.equal(harness.state().displayedCode, pending.pairingCode);
    assert.deepEqual(harness.state().activeTimerDelays, [30_000]);

    await harness.run('poll');
    const state = harness.state();
    assert.equal(state.availability, 'authorization-required');
    assert.equal(state.title, 'This tablet needs authorization');
    assert.equal(state.code, '');
    assert.equal(state.expiresAt, '');
    assert.equal(state.deliveryExpiresAt, '');
    assert.equal(state.displayedCode, '');
    assert.equal(state.codeHidden, true);
    assert.equal(state.instructionsHidden, true);
    assert.equal(state.controlsHidden, true);
    assert.equal(state.retryHidden, false);
    assert.equal(state.retryLabel, 'Get a new code');
    assert.equal(state.cancelHidden, true);
    assert.equal(state.detail, terminal.data.message);
    assert.deepEqual(state.activeTimerDelays, []);
  }
});

test('pairing secrets stay in memory and never enter a URL, browser storage, or Admin navigation', () => {
  const pairingStart = clientSource.indexOf('function validStaffClockPairingCode(');
  const pairingEnd = clientSource.indexOf('function validatedStaffClockSnapshotStart(', pairingStart);
  assert.ok(pairingStart >= 0 && pairingEnd > pairingStart);
  const pairingSource = clientSource.slice(pairingStart, pairingEnd);
  assert.doesNotMatch(pairingSource, /localStorage|sessionStorage|location\.(?:href|search|assign|replace)|URLSearchParams|history\.|authorizeTablet/iu);
  assert.match(pairingSource, /adminUrl\.textContent = new URL\('\/m1\/admin\/', STAFF_CLOCK_PAIRING_CONFIG\.origin\)\.href/u);
  assert.doesNotMatch(pairingSource, /adminUrl\.href\s*=|window\.open\(|location\s*=/u);
  assert.doesNotMatch(kioskHtml, /\?authorizeTablet=1|id="authorizeStaffClockTablet"/u);
  assert.match(kioskHtml, /On a <strong>separate phone or computer<\/strong>/u);
});

test('pairing is profile-gated and remains absent from both Richmond profiles', () => {
  assert.match(clientSource, /installationProfile\?\.featureFlags\?\.staffClockPairing === true/u);
  assert.match(clientSource, /installationProfile\?\.allowedOrigin === STAFF_CLOCK_PAIRING_CONFIG\.origin/u);
  assert.match(clientSource, /location\.origin === STAFF_CLOCK_PAIRING_CONFIG\.origin/u);
  assert.doesNotMatch(clientSource, /STAFF_CLOCK_PAIRING_AVAILABLE\s*=\s*[^;]*IS_RICHMOND/su);
  assert.match(kioskHtml, /const STAFF_CLOCK_PAIRING_ENABLED = INSTALLATION\.featureFlags\.staffClockPairing === true/u);
  assert.match(kioskHtml, /profile\.featureFlags\?\.staffClockPairing !== false/u);
  assert.match(kioskHtml, /\$\('#staffClock'\)\.hidden = !STAFF_CLOCK_ENABLED/u);
});

test('missing or false installation-profile validity causes zero Staff Clock initialization, API, or business activity', () => {
  const normalizedClientSource = clientSource.replace(/\r\n?/gu, '\n');
  const gateStart = normalizedClientSource.lastIndexOf('if (\n  globalThis.M1_INSTALLATION_PROFILE_VALID === true');
  assert.ok(gateStart > 0);
  const gateSource = normalizedClientSource.slice(gateStart);
  for (const profileValid of [undefined, false]) {
    const result = Function('profileValid', 'gateSource', `
      const globalThis = profileValid === undefined
        ? {}
        : { M1_INSTALLATION_PROFILE_VALID: profileValid };
      const installationProfile = {
        schema: 'gib-m1-installation-profile/v1',
        installationId: 'rev',
        siteCode: 'Rev',
        featureFlags: { staffClock: true },
        backend: { enabled: true, transportTarget: 'production' }
      };
      const activity = { initialization: 0, api: 0, business: 0 };
      const initializeStaffClockClient = () => {
        activity.initialization += 1;
        activity.api += 1;
        activity.business += 1;
      };
      eval(gateSource);
      return activity;
    `)(profileValid, gateSource);
    assert.deepEqual(result, {
      initialization: 0,
      api: 0,
      business: 0
    }, String(profileValid));
  }
});

test('production authorization loss during queued sync locks actions and preserves the exact queue', async () => {
  const queued = { punchId: fullRecord.punchId };
  const result = Function('queued', `
    let staffClockSyncPromise = null;
    let staffClockSyncRequested = false;
    let staffClockStateRevision = 0;
    let staffClockAvailability = 'ready';
    let staffClockAuthorizationRecoveryInProgress = false;
    let staffClockPeople = [{ staffId: 'front-desk-test-two', staffName: 'Front Desk Test Two' }];
    let authRequired = 0;
    let saveCount = 0;
    let postCount = 0;
    const navigator = { onLine: true };
    const IS_PRODUCTION_ORIGIN = true;
    const STAFF_SYNC_BATCH_SIZE = 20;
    const state = { queue: [queued] };
    const loadStaffClockState = () => state;
    const postStaffClock = async () => {
      postCount += 1;
      const error = new Error('authorization required');
      error.staffClockStatus = 401;
      throw error;
    };
    const staffClockSyncPunch = value => value;
    const acceptedStaffClockSyncIds = () => new Set();
    const sameStaffClockRecord = () => true;
    const saveStaffClockState = () => { saveCount += 1; };
    const markStaffClockConfirmationConfirmed = () => {};
    const renderStaffClock = () => {};
    const renderStaffTimeAdmin = () => {};
    const refreshStaffClockSnapshot = () => {};
    const showStaffClockAuthorizationRequired = () => {
      authRequired += 1;
      staffClockAvailability = 'authorization-required';
    };
    const setStaffClockAvailability = () => {};
    ${namedFunctionSource(clientSource, 'syncStaffClockQueue')}
    return (async () => {
      await syncStaffClockQueue();
      await syncStaffClockQueue();
      return {
        authRequired,
        saveCount,
        postCount,
        queue: state.queue
      };
    })();
  `)(queued);

  assert.deepEqual(await result, {
    authRequired: 1,
    saveCount: 0,
    postCount: 1,
    queue: [queued]
  });
  assert.doesNotMatch(clientSource, /localStorage\.clear\(|removeItem\(STAFF_CLOCK/u);
});

test('production snapshot 401 locks a stale cached roster behind authorization recovery', async () => {
  const result = Function(`
    let staffClockSnapshotPromise = null;
    let staffClockSnapshotRequested = false;
    let staffClockStateRevision = 0;
    let staffClockAuthorizationRecoveryInProgress = false;
    let staffClockPeople = [{ staffId: 'front-desk-test-two', staffName: 'Front Desk Test Two' }];
    let authRequired = 0;
    let availabilityChanges = 0;
    const navigator = { onLine: true };
    const IS_PRODUCTION_ORIGIN = true;
    const loadStaffClockState = () => ({ queue: [] });
    const loadStaffClockSnapshotWithRetry = async () => {
      const error = new Error('authorization required');
      error.staffClockStatus = 401;
      throw error;
    };
    const reconcileStaffClockSnapshotState = () => { throw new Error('must not reconcile'); };
    const saveStaffClockState = () => { throw new Error('must not save'); };
    const saveStaffClockPeople = () => { throw new Error('must not replace cache'); };
    const populateStaffClockPeople = () => { throw new Error('must not expose cache'); };
    const renderStaffTimeAdmin = () => {};
    const syncStaffClockQueue = () => {};
    const showStaffClockAuthorizationRequired = () => { authRequired += 1; };
    const setStaffClockAvailability = () => { availabilityChanges += 1; };
    ${namedFunctionSource(clientSource, 'refreshStaffClockSnapshot')}
    return refreshStaffClockSnapshot().then(value => ({
      value,
      authRequired,
      availabilityChanges,
      cachedPeople: staffClockPeople
    }));
  `)();

  assert.deepEqual(await result, {
    value: null,
    authRequired: 1,
    availabilityChanges: 0,
    cachedPeople: [{ staffId: 'front-desk-test-two', staffName: 'Front Desk Test Two' }]
  });
});

test('browser records accept complete adjustment evidence and reject partial or extra evidence', () => {
  const normalize = browserRecordNormalizer();
  const adjusted = {
    ...fullRecord,
    timestamp: '2026-08-18T09:45:00-04:00',
    originalTimestamp: '2026-08-18T09:30:00-04:00',
    originalDate: '2026-08-18',
    adjustmentRequestId: ADJUSTMENT_REQUEST_ID
  };

  assert.deepEqual(normalize(adjusted), adjusted);
  assert.deepEqual(normalize({
    ...fullRecord,
    originalTimestamp: undefined,
    originalDate: undefined,
    adjustmentRequestId: undefined
  }), fullRecord, 'missing optional evidence canonicalizes to explicit blanks');

  for (const invalid of [
    { ...fullRecord, originalTimestamp: adjusted.originalTimestamp },
    { ...fullRecord, originalDate: adjusted.originalDate },
    { ...fullRecord, adjustmentRequestId: adjusted.adjustmentRequestId },
    {
      ...adjusted,
      originalTimestamp: '2026-03-08T02:30:00-05:00',
      originalDate: '2026-03-08'
    },
    { ...adjusted, originalDate: '2026-08-17' },
    { ...adjusted, adjustmentRequestId: 'gib-m1-staff-request-not-a-uuid' },
    { ...adjusted, originalClockInAt: adjusted.originalTimestamp }
  ]) {
    assert.equal(normalize(invalid), null, JSON.stringify(invalid));
  }
});

test('browser record comparison includes original adjustment evidence', () => {
  const compare = Function('sameStaffRecord', `
    const STAFF_RECORD_KEYS = ${JSON.stringify([
      'punchId',
      'timestamp',
      'date',
      'staffId',
      'staffName',
      'punchAction',
      'site',
      'device',
      'build',
      'note',
      'status',
      'source',
      'adminName',
      'linkedPunchId',
      'originalTimestamp',
      'originalDate',
      'adjustmentRequestId'
    ])};
    return (${namedFunctionSource(clientSource, 'sameStaffClockRecord')});
  `)(sameStaffRecord);
  const adjusted = {
    ...fullRecord,
    originalTimestamp: fullRecord.timestamp,
    originalDate: fullRecord.date,
    adjustmentRequestId: ADJUSTMENT_REQUEST_ID
  };

  assert.equal(compare(adjusted, { ...adjusted }), true);
  assert.equal(compare(adjusted, fullRecord), false);
  assert.equal(compare(adjusted, {
    ...adjusted,
    adjustmentRequestId: 'gib-m1-staff-request-223e4567-e89b-42d3-a456-426614174000'
  }), false);
});

test('Staff Clock sync projects durable records to the exact ten-key wire shape', () => {
  const project = Function(`return (${namedFunctionSource(clientSource, 'staffClockSyncPunch')});`)();
  const wirePunch = project(fullRecord);
  assert.deepEqual(Object.keys(wirePunch), [
    'punchId',
    'timestamp',
    'date',
    'staffId',
    'staffName',
    'punchAction',
    'site',
    'device',
    'build',
    'note'
  ]);
  assert.deepEqual(wirePunch, {
    punchId: fullRecord.punchId,
    timestamp: fullRecord.timestamp,
    date: fullRecord.date,
    staffId: fullRecord.staffId,
    staffName: fullRecord.staffName,
    punchAction: fullRecord.punchAction,
    site: fullRecord.site,
    device: fullRecord.device,
    build: fullRecord.build,
    note: fullRecord.note
  });
  assert.match(clientSource, /punches: batch\.map\(staffClockSyncPunch\)/u);
});

test('needs attention is a valid non-acceptance and leaves the punch queued', () => {
  const evaluate = Function(`
    const IS_PRODUCTION_ORIGIN = false;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'acceptedStaffClockSyncIds')});
  `)();
  const accepted = evaluate({
    ok: true,
    target: 'test',
    results: [{
      punchId: fullRecord.punchId,
      result: 'needs attention',
      linkedPunchId: ''
    }]
  }, [fullRecord]);
  assert.equal(accepted.size, 0);

  for (const ambiguousResult of [
    {
      punchId: fullRecord.punchId,
      result: 'needs attention',
      linkedPunchId: fullRecord.punchId
    },
    {
      punchId: fullRecord.punchId,
      result: 'needs attention',
      linkedPunchId: '',
      extra: true
    }
  ]) {
    assert.throws(() => evaluate({
      ok: true,
      target: 'test',
      results: [ambiguousResult]
    }, [fullRecord]));
  }
});

test('snapshot and sync confirmations reject added envelope fields', () => {
  const validateSnapshot = Function(`
    const IS_PRODUCTION_ORIGIN = false;
    const STAFF_PUNCH_ID_PATTERN = ${/^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u};
    const normalizeStaffClockPerson = value => value;
    const normalizeStaffClockPeriods = value => value;
    const normalizeStaffClockView = value => value;
    const cleanStaffClockText = value => String(value || '');
    const validStaffClockTimestamp = value => Number.isFinite(Date.parse(value));
    const dateKeyAsUtc = value => Date.parse(value + 'T00:00:00Z');
    const utcAsDateKey = value => new Date(value).toISOString().slice(0, 10);
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'validatedStaffClockSnapshotStart')});
  `)();
  const snapshot = snapshotStart();
  assert.deepEqual(validateSnapshot(snapshot), {
    staff: snapshot.staff,
    clockedInNow: snapshot.clockedInNow,
    periods: snapshot.periods,
    view: snapshot.view
  });
  assert.equal(validateSnapshot({ ...snapshot, extra: true }), null);

  const evaluate = Function(`
    const IS_PRODUCTION_ORIGIN = false;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'acceptedStaffClockSyncIds')});
  `)();
  assert.throws(() => evaluate({
    ok: true,
    target: 'test',
    results: [{
      punchId: fullRecord.punchId,
      result: 'added',
      linkedPunchId: fullRecord.punchId
    }],
    extra: true
  }, [fullRecord]));
});

test('browser summary validation is exact and keeps inactive historical names', () => {
  const normalizeSummary = Function(`
    const STAFF_PUNCH_ID_PATTERN = ${/^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u};
    const STAFF_CLOCK_MAX_INCLUDED_RECORDS = 500;
    const STAFF_CLOCK_MAX_ATTENTION_GROUPS = 600;
    const normalizeStaffClockRecordList = (records, maximum) => Array.isArray(records) && records.length <= maximum ? records : null;
    const validStaffClockTimestamp = value => Number.isFinite(Date.parse(value));
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    ${namedFunctionSource(clientSource, 'cleanStaffClockText')}
    ${namedFunctionSource(clientSource, 'dateKeyAsUtc')}
    ${namedFunctionSource(clientSource, 'utcAsDateKey')}
    ${namedFunctionSource(clientSource, 'normalizeStaffClockPeriod')}
    ${namedFunctionSource(clientSource, 'normalizeStaffClockPeriods')}
    ${namedFunctionSource(clientSource, 'normalizeStaffClockView')}
    return (${namedFunctionSource(clientSource, 'normalizeStaffClockSummary')});
  `)();
  const inactive = { staffId: 'former-staff-test', staffName: 'Former Staff Test' };
  const value = snapshotSummary();
  value.periods.current.totals.push({
    ...inactive,
    completedShifts: 2_001,
    totalSeconds: 15 * 24 * 60 * 60,
    needsAttention: false
  });
  assert.deepEqual(normalizeSummary(value, [fullRecord]), value);
  const adjusted = {
    ...fullRecord,
    timestamp: '2026-08-18T09:45:00-04:00',
    originalTimestamp: fullRecord.timestamp,
    originalDate: fullRecord.date,
    adjustmentRequestId: ADJUSTMENT_REQUEST_ID
  };
  const adjustedValue = snapshotSummary([adjusted], undefined, {
    view: { adjustmentCount: 1, adjustmentTotal: 1 }
  });
  assert.deepEqual(normalizeSummary(adjustedValue, [adjusted]), adjustedValue);
  assert.equal(normalizeSummary({ ...value, extra: true }, [fullRecord]), null);
  assert.equal(normalizeSummary({
    ...value,
    clockedInNow: [{ ...value.clockedInNow[0], punchId: 'wrong-id' }]
  }, [fullRecord]), null);
  assert.equal(normalizeSummary({
    ...value,
    needsAttention: [{
      staffId: fullRecord.staffId,
      staffName: fullRecord.staffName,
      code: 'missing_clock_out',
      message: 'Missing Clock Out.',
      linkedPunchIds: ['gib-m1-staff-923e4567-e89b-42d3-a456-426614174000'],
      occurrenceCount: 1
    }]
  }, [fullRecord]), null);
  assert.equal(normalizeSummary({
    ...value,
    periods: {
      ...value.periods,
      current: {
        ...value.periods.current,
        totals: value.periods.current.totals.map(total => (
          total.staffId === inactive.staffId
            ? { ...total, totalSeconds: 15 * 24 * 60 * 60 + 1 }
            : total
        ))
      }
    }
  }, [fullRecord]), null);
});

test('production origin accepts only production-target snapshot and sync envelopes', () => {
  const validateSnapshot = Function(`
    const IS_PRODUCTION_ORIGIN = true;
    const STAFF_PUNCH_ID_PATTERN = ${/^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u};
    const normalizeStaffClockPerson = value => value;
    const normalizeStaffClockPeriods = value => value;
    const normalizeStaffClockView = value => value;
    const cleanStaffClockText = value => String(value || '');
    const validStaffClockTimestamp = value => Number.isFinite(Date.parse(value));
    const dateKeyAsUtc = value => Date.parse(value + 'T00:00:00Z');
    const utcAsDateKey = value => new Date(value).toISOString().slice(0, 10);
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'validatedStaffClockSnapshotStart')});
  `)();
  const productionStaff = { staffId: 'mandy', staffName: 'Mandy' };
  const productionSummary = snapshotSummary([], productionStaff);
  const productionSnapshot = snapshotStart('production', {
    staff: [productionStaff],
    clockedInNow: [],
    periods: productionSummary.periods,
    view: snapshotView({
      recordCount: 0,
      recordTotal: 0,
      todayPunchCount: 0,
      todayPunchTotal: 0,
      attentionCount: 0,
      attentionOccurrenceCount: 0
    })
  });
  assert.deepEqual(validateSnapshot(productionSnapshot), {
    staff: productionSnapshot.staff,
    clockedInNow: [],
    periods: productionSummary.periods,
    view: productionSnapshot.view
  });
  assert.equal(validateSnapshot({ ...productionSnapshot, target: 'test' }), null);

  const evaluate = Function(`
    const IS_PRODUCTION_ORIGIN = true;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'acceptedStaffClockSyncIds')});
  `)();
  const productionConfirmation = {
    ok: true,
    target: 'production',
    results: [{
      punchId: fullRecord.punchId,
      result: 'added',
      linkedPunchId: fullRecord.punchId
    }]
  };
  assert.deepEqual([...evaluate(productionConfirmation, [fullRecord])], [fullRecord.punchId]);
  assert.throws(() => evaluate({ ...productionConfirmation, target: 'test' }, [fullRecord]));
});

test('authoritative snapshot atomically replaces the bounded baseline and accepted overlay', () => {
  const reconcile = Function(`
    const STAFF_CLOCK_STATE_VERSION = 2;
    const normalizeStaffClockSummary = value => value;
    return (${namedFunctionSource(clientSource, 'reconcileStaffClockSnapshotState')});
  `)();
  const acceptedOverlay = {
    ...fullRecord,
    punchId: 'gib-m1-staff-523e4567-e89b-42d3-a456-426614174000'
  };
  const baseline = snapshotSummary();
  const nextState = reconcile({
    version: 2,
    baseline: null,
    overlay: [acceptedOverlay],
    queue: []
  }, baseline);
  assert.deepEqual(nextState, {
    version: 2,
    baseline,
    overlay: [],
    queue: []
  });
});

test('snapshot reconciliation refuses to replace an exact pending queue', () => {
  const reconcile = Function(`
    const STAFF_CLOCK_STATE_VERSION = 2;
    const normalizeStaffClockSummary = value => value;
    return (${namedFunctionSource(clientSource, 'reconcileStaffClockSnapshotState')});
  `)();
  const queued = {
    ...fullRecord,
    punchId: 'gib-m1-staff-623e4567-e89b-42d3-a456-426614174000'
  };
  assert.equal(reconcile({
    version: 2,
    baseline: null,
    overlay: [queued],
    queue: [queued]
  }, snapshotSummary()), null);
});

test('snapshot refresh replaces history, caches only active roster names, and rerenders Admin', async () => {
  const acceptedOverlay = {
    ...fullRecord,
    punchId: 'gib-m1-staff-6a3e4567-e89b-42d3-a456-426614174000',
    timestamp: '2026-08-18T10:00:00-04:00'
  };
  const active = { staffId: fullRecord.staffId, staffName: fullRecord.staffName };
  const inactive = { staffId: 'former-staff-test', staffName: 'Former Staff Test' };
  const issue = {
    ...active,
    code: 'missing_clock_out',
    message: 'Clock In has no matching Clock Out.',
    linkedPunchIds: [fullRecord.punchId],
    occurrenceCount: 1
  };
  const summary = snapshotSummary([fullRecord], active, { needsAttention: [issue] });
  summary.periods.current.totals.push({
    ...inactive,
    completedShifts: 1,
    totalSeconds: 3_600,
    needsAttention: false
  });
  const payload = { staff: [active], baseline: summary };
  const initialPayload = snapshotStart('test', {
    staff: [active],
    periods: summary.periods,
    view: summary.view
  });
  const recordPage = {
    ok: true,
    target: 'test',
    viewToken: VIEW_TOKEN,
    stream: 'records',
    offset: 0,
    items: [fullRecord],
    nextOffset: null
  };
  const attentionPage = {
    ok: true,
    target: 'test',
    viewToken: VIEW_TOKEN,
    stream: 'attention',
    offset: 0,
    items: summary.needsAttention,
    nextOffset: null
  };
  const calls = [];
  const harness = Function('initialPayload', 'recordPage', 'attentionPage', 'initialState', 'calls', `
    let staffClockSnapshotPromise = null;
    let staffClockSnapshotRequested = false;
    let staffClockStateRevision = 0;
    let staffClockAuthorizationRecoveryInProgress = false;
    let staffClockPeople = [];
    let savedState = null;
    let savedPeople = null;
    let populated = 0;
    let adminRendered = 0;
    const STAFF_CLOCK_STATE_VERSION = 2;
    const IS_PRODUCTION_ORIGIN = false;
    const navigator = { onLine: true };
    const console = { warn() {} };
    const postStaffClock = async body => {
      calls.push(body);
      if (body.operation === 'snapshot') return initialPayload;
      if (body.operation === 'snapshotPage' && body.stream === 'records') return recordPage;
      if (body.operation === 'snapshotPage' && body.stream === 'attention') return attentionPage;
      throw new Error('Unexpected page request');
    };
    const validatedStaffClockSnapshotStart = value => value;
    const validatedStaffClockSnapshotPage = value => ({
      items: value.items,
      nextOffset: value.nextOffset
    });
    const normalizeStaffClockSummary = value => value;
    const loadStaffClockState = () => initialState;
    const syncStaffClockQueue = () => {};
    const saveStaffClockState = value => { savedState = value; };
    const saveStaffClockPeople = value => { savedPeople = value; };
    const populateStaffClockPeople = () => { populated += 1; };
    const renderStaffTimeAdmin = () => { adminRendered += 1; };
    const clearStaffClockPairingMemory = () => {};
    const setStaffClockAvailability = () => {};
    const showStaffClockAuthorizationRequired = () => {};
    ${namedFunctionSource(clientSource, 'reconcileStaffClockSnapshotState')}
    ${namedFunctionSource(clientSource, 'loadStaffClockSnapshot')}
    ${namedFunctionSource(clientSource, 'loadStaffClockSnapshotWithRetry')}
    ${namedFunctionSource(clientSource, 'refreshStaffClockSnapshot')}
    return {
      refreshStaffClockSnapshot,
      result: () => ({ savedState, savedPeople, populated, adminRendered })
    };
  `)(initialPayload, recordPage, attentionPage, {
    version: 2,
    baseline: null,
    overlay: [acceptedOverlay],
    queue: []
  }, calls);

  assert.deepEqual(await harness.refreshStaffClockSnapshot(), payload);
  assert.deepEqual(calls, [{ operation: 'snapshot' }, {
    operation: 'snapshotPage',
    viewToken: VIEW_TOKEN,
    stream: 'records',
    offset: 0
  }, {
    operation: 'snapshotPage',
    viewToken: VIEW_TOKEN,
    stream: 'attention',
    offset: 0
  }]);
  assert.deepEqual(harness.result(), {
    savedState: {
      version: 2,
      baseline: summary,
      overlay: [],
      queue: []
    },
    savedPeople: [active],
    populated: 1,
    adminRendered: 1
  });
  assert.ok(!harness.result().savedPeople.some(person => person.staffId === inactive.staffId));
});

test('server summaries survive local-state reload with their exact record baseline', () => {
  const stored = new Map();
  const localStorage = {
    getItem: key => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value)
  };
  const makeFunctions = Function('localStorage', `
    const STAFF_CLOCK_STATE_KEY = 'state';
    const STAFF_CLOCK_STATE_VERSION = 2;
    const STAFF_PUNCH_ID_PATTERN = ${/^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u};
    const sameStaffClockRecord = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const normalizeStaffClockRecordList = value => Array.isArray(value) ? value : null;
    const normalizeStaffClockSummary = value => value && value.periods ? value : null;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    ${namedFunctionSource(clientSource, 'blankStaffClockState')}
    ${namedFunctionSource(clientSource, 'saveStaffClockState')}
    ${namedFunctionSource(clientSource, 'loadStaffClockState')}
    return { saveStaffClockState, loadStaffClockState };
  `)(localStorage);
  const baseline = snapshotSummary();
  const state = {
    version: 2,
    baseline,
    overlay: [],
    queue: []
  };
  makeFunctions.saveStaffClockState(state);
  assert.deepEqual(makeFunctions.loadStaffClockState(), state);
});

test('50,000 declared records persist a bounded canonical baseline and exact queue under quota', () => {
  const stored = new Map();
  const localStorage = {
    getItem: key => stored.get(key) || null,
    setItem(key, value) {
      if (value.length > 1_500_000) throw new Error('QuotaExceededError');
      stored.set(key, value);
    }
  };
  const save = Function('localStorage', `
    const STAFF_CLOCK_STATE_KEY = 'state';
    const STAFF_CLOCK_STATE_VERSION = 2;
    const normalizeStaffClockRecordList = value => Array.isArray(value) ? value : null;
    const normalizeStaffClockSummary = value => value?.records?.length <= 500 ? value : null;
    const sameStaffClockRecord = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'saveStaffClockState')});
  `)(localStorage);
  const records = Array.from({ length: 500 }, (_, index) => ({
    ...fullRecord,
    punchId: `gib-m1-staff-${index.toString(16).padStart(8, '0')}-e89b-42d3-a456-426614174000`
  }));
  const queued = {
    ...fullRecord,
    punchId: 'gib-m1-staff-c23e4567-e89b-42d3-a456-426614174000',
    timestamp: '2026-08-18T11:00:00-04:00',
    punchAction: 'clockOut'
  };
  const baseline = snapshotSummary(records, undefined, {
    view: {
      recordTotal: 50_000,
      todayPunchTotal: 10_000,
      recordsTruncated: true
    }
  });
  save({
    version: 2,
    baseline,
    overlay: [queued],
    queue: [queued]
  });
  const serialized = stored.get('state');
  const persisted = JSON.parse(serialized);
  assert.ok(serialized.length < 1_500_000);
  assert.equal(persisted.baseline.records.length, 500);
  assert.equal(persisted.baseline.view.recordTotal, 50_000);
  assert.deepEqual(persisted.overlay, [queued]);
  assert.deepEqual(persisted.queue, [queued]);
  assert.equal(Object.hasOwn(persisted, 'baselinePunchIds'), false);
  assert.equal(Object.hasOwn(persisted.baseline, 'todayPunches'), false);
});

test('authoritative open state plus offline and accepted overlays produce one exact shift', () => {
  const statusFor = Function('mergeStaffRecords', 'evaluateStaffState', 'fmtDate', `
    ${namedFunctionSource(clientSource, 'combinedStaffClockRecords')}
    ${namedFunctionSource(clientSource, 'staffClockBaselineOpenRecord')}
    return (${namedFunctionSource(clientSource, 'staffClockStatusFor')});
  `)(mergeStaffRecords, evaluateStaffState, value => new Date(value).toISOString().slice(0, 10));
  const localOut = {
    ...fullRecord,
    punchId: 'gib-m1-staff-d23e4567-e89b-42d3-a456-426614174000',
    timestamp: '2026-08-18T10:30:00-04:00',
    punchAction: 'clockOut'
  };
  for (const queue of [[localOut], []]) {
    const state = {
      version: 2,
      baseline: {
        ...snapshotSummary([], undefined, {
          view: {
            recordTotal: 50_000,
            todayPunchTotal: 10_000,
            recordsTruncated: true
          }
        }),
        clockedInNow: [{
          punchId: fullRecord.punchId,
          staffId: fullRecord.staffId,
          staffName: fullRecord.staffName,
          clockInAt: fullRecord.timestamp
        }]
      },
      overlay: [localOut],
      queue
    };
    const status = statusFor(fullRecord.staffId, state, new Date('2026-08-18T15:00:00Z'));
    assert.equal(status.clockedIn, false);
    assert.equal(status.completedShifts.length, 1);
    assert.equal(status.completedShifts[0].elapsedMilliseconds, 3_600_000);
  }
});

test('empty retry sync performs no snapshot; one accepted queue triggers exactly one', async () => {
  const makeHarness = initialState => Function('initialState', `
    const STAFF_SYNC_BATCH_SIZE = 20;
    let staffClockSyncPromise = null;
    let staffClockSyncRequested = false;
    let staffClockStateRevision = 0;
    let staffClockAvailability = 'ready';
    let staffClockAuthorizationRecoveryInProgress = false;
    let state = initialState;
    let posts = 0;
    let refreshes = 0;
    const navigator = { onLine: true };
    const loadStaffClockState = () => state;
    const saveStaffClockState = next => { state = next; };
    const postStaffClock = async () => { posts += 1; return {}; };
    const acceptedStaffClockSyncIds = (_response, batch) => new Set(batch.map(item => item.punchId));
    const staffClockSyncPunch = value => value;
    const sameStaffClockRecord = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const markStaffClockConfirmationConfirmed = () => {};
    const renderStaffClock = () => {};
    const renderStaffTimeAdmin = () => {};
    const refreshStaffClockSnapshot = () => { refreshes += 1; };
    ${namedFunctionSource(clientSource, 'syncStaffClockQueue')}
    return { syncStaffClockQueue, result: () => ({ state, posts, refreshes }) };
  `)(initialState);

  const empty = makeHarness({ version: 2, baseline: null, overlay: [], queue: [] });
  await empty.syncStaffClockQueue();
  assert.deepEqual(empty.result(), {
    state: { version: 2, baseline: null, overlay: [], queue: [] },
    posts: 0,
    refreshes: 0
  });

  const queued = {
    ...fullRecord,
    punchId: 'gib-m1-staff-e23e4567-e89b-42d3-a456-426614174000'
  };
  const accepted = makeHarness({
    version: 2,
    baseline: snapshotSummary(),
    overlay: [queued],
    queue: [queued]
  });
  await accepted.syncStaffClockQueue();
  assert.equal(accepted.result().posts, 1);
  assert.equal(accepted.result().refreshes, 1);
  assert.deepEqual(accepted.result().state.overlay, [queued]);
  assert.deepEqual(accepted.result().state.queue, []);
});

test('kiosk Admin keeps grouped baseline attention authoritative and adds local-only issues once', () => {
  const person = { staffId: fullRecord.staffId, staffName: fullRecord.staffName };
  const serverIssue = {
    ...person,
    code: 'missing_clock_out',
    message: 'Server baseline issue',
    linkedPunchIds: [fullRecord.punchId],
    occurrenceCount: 7
  };
  const baseline = snapshotSummary([fullRecord], person, { needsAttention: [serverIssue] });
  const makeView = Function(`
    const fmtDate = () => '${fullRecord.date}';
    const staffClockStatusFor = (staffId, state) => ({
      staffId,
      staffName: '${fullRecord.staffName}',
      clockedIn: false,
      clockInRecord: null,
      attention: state.overlay.length ? [{
        code: 'REPEATED_CLOCK_IN',
        punchId: state.overlay[0].punchId,
        message: 'repeated clock in'
      }] : [],
      needsAttention: Boolean(state.overlay.length || state.baseline?.needsAttention.length)
    });
    return (${namedFunctionSource(clientSource, 'staffClockAdminView')});
  `)();
  const baselineState = {
    version: 2,
    baseline,
    overlay: [],
    queue: []
  };
  assert.deepEqual(
    makeView(baselineState, [person], new Date('2026-08-18T16:00:00Z')).needsAttention,
    [serverIssue]
  );

  const overlay = {
    ...fullRecord,
    punchId: 'gib-m1-staff-8b3e4567-e89b-42d3-a456-426614174000',
    timestamp: '2026-08-18T10:00:00-04:00'
  };
  const overlayState = {
    ...baselineState,
    baseline: snapshotSummary(),
    overlay: [overlay]
  };
  assert.deepEqual(
    makeView(overlayState, [person], new Date('2026-08-18T16:00:00Z')).needsAttention,
    [{
      ...person,
      code: 'repeated_clock_in',
      message: 'repeated clock in',
      linkedPunchIds: [overlay.punchId],
      occurrenceCount: 1
    }]
  );
});

test('10,000 declared same-day records load as one bounded 500-record projection', async () => {
  const records = Array.from({ length: 500 }, (_, index) => ({
    ...fullRecord,
    punchId: `gib-m1-staff-${index.toString(16).padStart(8, '0')}-e89b-42d3-a456-426614174000`
  }));
  const start = snapshotStart('test', {
    clockedInNow: [{
      punchId: records[0].punchId,
      staffId: records[0].staffId,
      staffName: records[0].staffName,
      clockInAt: records[0].timestamp
    }],
    view: snapshotView({
      recordCount: records.length,
      recordTotal: 10_000,
      todayPunchCount: records.length,
      todayPunchTotal: 10_000,
      recordsTruncated: true
    })
  });
  const calls = [];
  const postStaffClock = async body => {
    calls.push(body);
    if (body.operation === 'snapshot') return start;
    const items = records.slice(body.offset, body.offset + 500);
    const end = body.offset + items.length;
    return {
      ok: true,
      target: 'test',
      viewToken: VIEW_TOKEN,
      stream: 'records',
      offset: body.offset,
      items,
      nextOffset: end === records.length ? null : end
    };
  };
  const makeLoad = post => Function('postStaffClock', `
    const IS_PRODUCTION_ORIGIN = false;
    const normalizeStaffClockRecord = value => value;
    const normalizeStaffClockPageAttention = value => value;
    const normalizeStaffClockSummary = value => value;
    const validatedStaffClockSnapshotStart = value => value;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    ${namedFunctionSource(clientSource, 'validatedStaffClockSnapshotPage')}
    return (${namedFunctionSource(clientSource, 'loadStaffClockSnapshot')});
  `)(post);
  const load = makeLoad(postStaffClock);
  const assembled = await load();
  assert.equal(assembled.baseline.records.length, 500);
  assert.equal(assembled.baseline.view.recordTotal, 10_000);
  assert.equal(Object.hasOwn(assembled.baseline, 'todayPunches'), false);
  assert.deepEqual(calls.map(call => [call.operation, call.offset]), [
    ['snapshot', undefined],
    ['snapshotPage', 0]
  ]);
  assert.ok(calls.slice(1).every(call => call.stream === 'records'));

  const duplicateRecords = records.slice();
  duplicateRecords[499] = { ...duplicateRecords[499], punchId: duplicateRecords[0].punchId };
  const duplicateStart = {
    ...start,
    view: {
      ...start.view,
      recordCount: duplicateRecords.length,
      todayPunchCount: duplicateRecords.length
    }
  };
  const duplicateLoad = makeLoad(async body => {
    if (body.operation === 'snapshot') return duplicateStart;
    const items = duplicateRecords.slice(body.offset, body.offset + 500);
    const end = body.offset + items.length;
    return {
      ok: true,
      target: 'test',
      viewToken: VIEW_TOKEN,
      stream: 'records',
      offset: body.offset,
      items,
      nextOffset: end === duplicateRecords.length ? null : end
    };
  });
  assert.equal(await duplicateLoad(), null);
});

test('cross-page duplicate attention identities fail closed even when display text differs', async () => {
  const attention = Array.from({ length: 501 }, (_, index) => ({
    staffId: fullRecord.staffId,
    staffName: fullRecord.staffName,
    code: `issue_${index}`,
    message: `issue ${index}`,
    linkedPunchIds: [],
    occurrenceCount: 1
  }));
  attention[500] = { ...attention[0], message: 'changed display text' };
  const start = snapshotStart('test', {
    view: snapshotView({
      recordCount: 0,
      recordTotal: 0,
      todayPunchCount: 0,
      todayPunchTotal: 0,
      attentionCount: attention.length,
      attentionOccurrenceCount: attention.length
    })
  });
  const load = Function('postStaffClock', `
    const IS_PRODUCTION_ORIGIN = false;
    const normalizeStaffClockRecord = value => value;
    const normalizeStaffClockPageAttention = value => value;
    const normalizeStaffClockSummary = value => value;
    const validatedStaffClockSnapshotStart = value => value;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    ${namedFunctionSource(clientSource, 'validatedStaffClockSnapshotPage')}
    return (${namedFunctionSource(clientSource, 'loadStaffClockSnapshot')});
  `)(async body => {
    if (body.operation === 'snapshot') return start;
    const items = attention.slice(body.offset, body.offset + 500);
    const end = body.offset + items.length;
    return {
      ok: true,
      target: 'test',
      viewToken: VIEW_TOKEN,
      stream: 'attention',
      offset: body.offset,
      items,
      nextOffset: end === attention.length ? null : end
    };
  });
  assert.equal(await load(), null);
});

test('byte-limited pages may advance by any positive item count up to 500', () => {
  const validatePage = Function(`
    const IS_PRODUCTION_ORIGIN = false;
    const normalizeStaffClockRecord = value => value;
    const normalizeStaffClockPageAttention = value => value;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'validatedStaffClockSnapshotPage')});
  `)();
  const start = snapshotStart('test', {
    view: snapshotView({
      recordCount: 3,
      recordTotal: 3,
      todayPunchCount: 3,
      todayPunchTotal: 3
    })
  });
  const secondRecord = {
    ...fullRecord,
    punchId: 'gib-m1-staff-a23e4567-e89b-42d3-a456-426614174000'
  };
  const thirdRecord = {
    ...fullRecord,
    punchId: 'gib-m1-staff-b23e4567-e89b-42d3-a456-426614174000'
  };
  assert.deepEqual(validatePage({
    ok: true,
    target: 'test',
    viewToken: VIEW_TOKEN,
    stream: 'records',
    offset: 0,
    items: [fullRecord, secondRecord],
    nextOffset: 2
  }, start, 'records', 0), {
    items: [fullRecord, secondRecord],
    nextOffset: 2
  });
  assert.deepEqual(validatePage({
    ok: true,
    target: 'test',
    viewToken: VIEW_TOKEN,
    stream: 'records',
    offset: 2,
    items: [thirdRecord],
    nextOffset: null
  }, start, 'records', 2), {
    items: [thirdRecord],
    nextOffset: null
  });
});

test('2,001 recent punches use compact server totals instead of recomputing omitted history', () => {
  const rowsFromSummary = Function(`
    const staffClockTotals = () => { throw new Error('compact baseline must not recompute history'); };
    return (${namedFunctionSource(clientSource, 'staffClockPeriodRowsFromSummary')});
  `)();
  const person = { staffId: fullRecord.staffId, staffName: fullRecord.staffName };
  const period = {
    ...snapshotSummary().periods.current,
    totals: [{
      ...person,
      completedShifts: 1_000,
      totalSeconds: 10_000,
      needsAttention: false
    }]
  };
  const rows = rowsFromSummary(period, {
    version: 2,
    baseline: snapshotSummary(),
    overlay: [],
    queue: []
  }, [person]);
  assert.deepEqual(rows, [{
    person,
    completedShifts: 1_000,
    elapsedMs: 10_000_000,
    needsAttention: false
  }]);
});

test('offline clock-out and confirmed-before-refresh add one delta to server totals', () => {
  const localClockOut = {
    ...fullRecord,
    punchId: 'gib-m1-staff-723e4567-e89b-42d3-a456-426614174000',
    timestamp: '2026-08-18T10:30:00-04:00',
    punchAction: 'clockOut'
  };
  const rowsFromSummary = Function(`
    const STAFF_CLOCK_STATE_VERSION = 2;
    const dateKeyAsUtc = value => Date.parse(value + 'T00:00:00Z');
    const utcAsDateKey = value => new Date(value).toISOString().slice(0, 10);
    const staffClockTotals = (people, state) => people.map(person => ({
      person,
      completedShifts: state.overlay.some(record => record.punchId === '${localClockOut.punchId}') ? 1 : 0,
      elapsedMs: state.overlay.some(record => record.punchId === '${localClockOut.punchId}') ? 3_600_000 : 0,
      needsAttention: false
    }));
    return (${namedFunctionSource(clientSource, 'staffClockPeriodRowsFromSummary')});
  `)();
  const person = { staffId: fullRecord.staffId, staffName: fullRecord.staffName };
  const period = {
    ...snapshotSummary().periods.current,
    totals: [{
      ...person,
      completedShifts: 12,
      totalSeconds: 43_200,
      needsAttention: false
    }]
  };
  for (const queue of [[localClockOut], []]) {
    const rows = rowsFromSummary(period, {
      version: 2,
      baseline: snapshotSummary(),
      overlay: [localClockOut],
      queue
    }, [person]);
    assert.equal(rows[0].completedShifts, 13);
    assert.equal(rows[0].elapsedMs, 46_800_000);
  }
});

test('offline one-period rollover labels local current and maps saved current to previous', () => {
  const displayedPeriods = Function(`
    const staffPayPeriodRange = (today, offset = 0) => offset === -1
      ? { start: '2026-08-10', end: '2026-08-23', endExclusive: '2026-08-24' }
      : { start: '2026-08-24', end: '2026-09-06', endExclusive: '2026-09-07' };
    const staffClockOverlayPeriodRows = () => ['local overlay current'];
    const staffClockPeriodRowsFromSummary = period => [period.startDate];
    const staffClockTotals = () => { throw new Error('stale server current must not be relabeled'); };
    return (${namedFunctionSource(clientSource, 'staffClockDisplayedPeriods')});
  `)();
  const state = {
    version: 2,
    baseline: snapshotSummary([], {
      staffId: fullRecord.staffId,
      staffName: fullRecord.staffName
    }),
    overlay: [],
    queue: [],
  };
  for (const today of ['2026-08-24', '2026-08-30']) {
    const displayed = displayedPeriods(state, [], today);
    assert.deepEqual(displayed.current, {
      range: { start: '2026-08-24', end: '2026-09-06', endExclusive: '2026-09-07' },
      rows: ['local overlay current']
    });
    assert.deepEqual(displayed.previous, {
      range: { start: '2026-08-10', end: '2026-08-23', endExclusive: '2026-08-24' },
      rows: ['2026-08-10']
    });
  }
});

test('a snapshot started before sync confirmation is discarded and immediately retried', () => {
  const refreshSource = namedFunctionSource(clientSource, 'refreshStaffClockSnapshot');
  const syncSource = namedFunctionSource(clientSource, 'syncStaffClockQueue');
  assert.match(clientSource, /let staffClockSnapshotRequested = false;/u);
  assert.match(clientSource, /let staffClockStateRevision = 0;/u);
  assert.match(
    refreshSource,
    /if \(staffClockSnapshotPromise\) \{\s*staffClockSnapshotRequested = true;\s*return staffClockSnapshotPromise;/u
  );
  assert.match(
    refreshSource,
    /if \(staffClockStateRevision !== requestedAtRevision\) \{\s*staffClockSnapshotRequested = true;\s*return null;/u
  );
  assert.match(
    refreshSource,
    /staffClockSnapshotPromise = null;\s*if \(staffClockSnapshotRequested\) \{\s*staffClockSnapshotRequested = false;\s*void refreshStaffClockSnapshot\(\);/u
  );
  assert.match(syncSource, /staffClockStateRevision \+= 1;/u);
});

test('one stale paged view retries once and repeated staleness stops safely', async () => {
  const makeRetry = loadStaffClockSnapshot => Function('loadStaffClockSnapshot', `
    return (${namedFunctionSource(clientSource, 'loadStaffClockSnapshotWithRetry')});
  `)(loadStaffClockSnapshot);
  let calls = 0;
  const recovered = await makeRetry(async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('stale');
      error.staffClockStatus = 409;
      throw error;
    }
    return { ok: true };
  })();
  assert.deepEqual(recovered, { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(makeRetry(async () => {
    calls += 1;
    const error = new Error('stale');
    error.staffClockStatus = 409;
    throw error;
  })(), /stale/u);
  assert.equal(calls, 2);
});

test('the offline shell precaches and serves both Staff Clock modules', () => {
  assert.match(serviceWorkerSource, /staff-clock-core\.mjs\?v=/u);
  assert.match(serviceWorkerSource, /staff-clock-client\.mjs\?v=/u);
  assert.match(serviceWorkerSource, /STAFF_CLOCK_CLIENT_URL/u);
});

test('a punch queued during startup sync triggers an immediate coalesced second pass', () => {
  const syncSource = namedFunctionSource(clientSource, 'syncStaffClockQueue');
  assert.match(clientSource, /let staffClockSyncRequested = false;/u);
  assert.match(syncSource, /if \(staffClockSyncPromise\) \{\s*staffClockSyncRequested = true;\s*return staffClockSyncPromise;/u);
  assert.match(syncSource, /staffClockSyncPromise = \(async \(\) => \{\s*\/\/[^\n]+\n\s*\/\/[^\n]+\n\s*await Promise\.resolve\(\);/u);
  assert.match(syncSource, /staffClockSyncPromise = null;\s*if \(staffClockSyncRequested\) \{\s*staffClockSyncRequested = false;\s*void syncStaffClockQueue\(\);/u);
});
