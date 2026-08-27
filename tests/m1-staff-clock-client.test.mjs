import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  evaluateStaffState,
  mergeStaffRecords,
  sameStaffRecord,
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
  const brace = source.indexOf('{', start);
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

test('Staff Clock is isolated from the inherited inline kiosk client', () => {
  const inlineModule = kioskHtml.match(/<script type="module">([\s\S]*?)<\/script>/u)?.[1] || '';
  assert.match(
    kioskHtml,
    /<script type="module" src="\.\/staff-clock-client\.mjs\?v=2026-08-27-staff-adjustment-r1"><\/script>/u
  );
  assert.doesNotMatch(inlineModule, /staff-clock-core|staffClockSyncPunch|syncStaffClockQueue|renderStaffTimeAdmin/u);
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
    let savedState = null;
    let savedPeople = null;
    let populated = 0;
    let adminRendered = 0;
    const STAFF_CLOCK_STATE_VERSION = 2;
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
