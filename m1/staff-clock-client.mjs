import {
  createStaffPunchId,
  evaluateStaffState,
  formatStaffElapsed,
  mergeStaffRecords,
  payPeriodOptions,
  sameStaffRecord,
  validStaffMember,
  validStaffRecord
} from './staff-clock-core.mjs?v=2026-08-28-tablet-pairing-r2';

const installationProfile = globalThis.M1_INSTALLATION_PROFILE;
const STAFF_CLOCK_PAIRING_ENABLED = installationProfile?.featureFlags?.staffClockPairing === true;
const STAFF_CLOCK_PAIRING_CONFIG = installationProfile?.staffClockPairing || null;
const STAFF_CLOCK_PAIRING_CONFIG_VALID = STAFF_CLOCK_PAIRING_ENABLED
  && Number.isInteger(STAFF_CLOCK_PAIRING_CONFIG?.expiresInSeconds)
  && STAFF_CLOCK_PAIRING_CONFIG.expiresInSeconds >= 60
  && STAFF_CLOCK_PAIRING_CONFIG.expiresInSeconds <= 12 * 60 * 60
  && installationProfile?.allowedOrigin === STAFF_CLOCK_PAIRING_CONFIG.origin;
const STAFF_CLOCK_PAIRING_AVAILABLE = STAFF_CLOCK_PAIRING_CONFIG_VALID
  && location.origin === STAFF_CLOCK_PAIRING_CONFIG.origin;
const PRODUCTION_ORIGIN = typeof installationProfile?.allowedOrigin === 'string'
  ? installationProfile.allowedOrigin
  : '';
const IS_PRODUCTION_ORIGIN = Boolean(
  PRODUCTION_ORIGIN
  && location.origin === PRODUCTION_ORIGIN
);
const TZ = 'America/New_York';
const BUILD = document.getElementById('buildId')?.textContent?.trim() || '';
const STAFF_CLOCK_STATE_KEY = 'gib_m1b_staff_clock_state_v1';
const STAFF_CLOCK_STAFF_CACHE_KEY = 'gib_m1b_staff_clock_staff_v1';
const STAFF_CLOCK_ENDPOINT = '/api/m1-staff-clock';
const STAFF_CLOCK_PAIRING_START_ENDPOINT = '/api/m1-tablet-pairing-start';
const STAFF_CLOCK_PAIRING_POLL_ENDPOINT = '/api/m1-tablet-pairing-poll';
const STAFF_CLOCK_PAIRING_CANCEL_ENDPOINT = '/api/m1-tablet-pairing-cancel';
const STAFF_CLOCK_RETRY_INTERVAL_MS = 30_000;
const STAFF_CLOCK_PAIRING_POLL_INTERVAL_MS = 30_000;
const STAFF_CLOCK_PAIRING_APPROVED_POLL_MS = 250;
const STAFF_CLOCK_PAIRING_MAX_LIFETIME_MS = STAFF_CLOCK_PAIRING_CONFIG_VALID
  ? STAFF_CLOCK_PAIRING_CONFIG.expiresInSeconds * 1_000
  : 12 * 60 * 60_000;
const STAFF_CLOCK_PAIRING_MAX_DELIVERY_WINDOW_MS = 2 * 60_000;
const STAFF_CLOCK_STATE_VERSION = 2;
const STAFF_CLOCK_MAX_INCLUDED_RECORDS = 500;
const STAFF_CLOCK_MAX_ATTENTION_GROUPS = 600;
const $ = selector => document.querySelector(selector);

function fmtDate(value) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value).forEach(part => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

  // M1B operational state is intentionally isolated from every Instructor Sign-In key.
  const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const STAFF_RECORD_KEYS = Object.freeze([
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
  ]);
  const STAFF_SYNC_BATCH_SIZE = 20;
  let staffClockPeople = [];
  let staffClockActionLocked = false;
  let staffClockConfirmationActive = false;
  let staffClockConfirmationContext = null;
  let staffClockDoneTimer = null;
  let staffClockSyncPromise = null;
  let staffClockSyncRequested = false;
  let staffClockSnapshotPromise = null;
  let staffClockSnapshotRequested = false;
  let staffClockStateRevision = 0;
  let staffClockTotalsSelection = 'current';
  let staffClockAvailability = 'loading';
  let staffClockPairingPromise = null;
  let staffClockPairingPollTimer = null;
  let staffClockPairingCode = '';
  let staffClockPairingExpiresAt = '';
  let staffClockPairingDeliveryExpiresAt = '';
  let staffClockAuthorizationRecoveryInProgress = false;

  function exactStaffClockKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actualKeys = Object.keys(value);
    return actualKeys.length === expectedKeys.length
      && expectedKeys.every(key => actualKeys.includes(key));
  }

  function cleanStaffClockText(value, maxLength, allowBlank = false) {
    const text = String(value == null ? '' : value)
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ');
    if (
      (!allowBlank && !text)
      || text.length > maxLength
      || /^[=+\-@]/u.test(text)
      || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
    ) {
      return '';
    }
    return text;
  }

  function blankStaffClockState() {
    return {
      version: STAFF_CLOCK_STATE_VERSION,
      baseline: null,
      overlay: [],
      queue: []
    };
  }

  function normalizeStaffClockPerson(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const staffId = cleanStaffClockText(value.staffId, 80);
    const staffName = cleanStaffClockText(value.staffName, 100);
    const person = { staffId, staffName };
    return validStaffMember(person) ? person : null;
  }

  function validStaffClockTimestamp(value) {
    return typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?[+-](?:0\d|1[0-4]):[0-5]\d$/u.test(value)
      && Number.isFinite(Date.parse(value));
  }

  function normalizeStaffClockRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const requiredKeys = [
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
      'source'
    ];
    const allowedKeys = new Set([
      ...requiredKeys,
      'adminName',
      'linkedPunchId',
      'originalTimestamp',
      'originalDate',
      'adjustmentRequestId'
    ]);
    if (
      !requiredKeys.every(key => Object.hasOwn(value, key))
      || Object.keys(value).some(key => !allowedKeys.has(key))
    ) return null;
    const record = {
      punchId: String(value.punchId || ''),
      timestamp: String(value.timestamp || ''),
      date: String(value.date || ''),
      staffId: cleanStaffClockText(value.staffId, 80),
      staffName: cleanStaffClockText(value.staffName, 100),
      punchAction: String(value.punchAction || ''),
      site: cleanStaffClockText(value.site, 80),
      device: cleanStaffClockText(value.device, 120),
      build: cleanStaffClockText(value.build, 160),
      note: cleanStaffClockText(value.note, 400, true),
      status: String(value.status || ''),
      source: String(value.source || ''),
      adminName: cleanStaffClockText(value.adminName, 80, true),
      linkedPunchId: String(value.linkedPunchId || ''),
      originalTimestamp: String(value.originalTimestamp || ''),
      originalDate: String(value.originalDate || ''),
      adjustmentRequestId: String(value.adjustmentRequestId || '')
    };
    if (
      !STAFF_PUNCH_ID_PATTERN.test(record.punchId)
      || !validStaffClockTimestamp(record.timestamp)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(record.date)
      || fmtDate(new Date(record.timestamp)) !== record.date
      || !record.staffId
      || !record.staffName
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.staffId)
      || (record.punchAction !== 'clockIn' && record.punchAction !== 'clockOut')
      || !record.site
      || !record.device
      || !record.build
      || (record.status !== 'ACTIVE' && record.status !== 'VOID')
      || (record.source !== 'Tablet' && record.source !== 'Admin-added')
      || (record.linkedPunchId && !STAFF_PUNCH_ID_PATTERN.test(record.linkedPunchId))
      || !validStaffRecord(record)
    ) {
      return null;
    }
    return record;
  }

  function sameStaffClockRecord(left, right) {
    return sameStaffRecord(left, right)
      || STAFF_RECORD_KEYS.every(key => left?.[key] === right?.[key]);
  }

  function normalizeStaffClockRecordList(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Array.isArray(value) || value.length > maximum) return null;
    const records = value.map(normalizeStaffClockRecord);
    if (records.some(record => !record)) return null;
    const byId = new Map();
    for (const record of records) {
      const existing = byId.get(record.punchId);
      if (existing && !sameStaffClockRecord(existing, record)) return null;
      if (existing) return null;
      byId.set(record.punchId, record);
    }
    return records;
  }

  function normalizeStaffClockPeriod(period) {
    if (
      !exactStaffClockKeys(period, ['startDate', 'endDate', 'totals'])
      || !/^\d{4}-\d{2}-\d{2}$/u.test(period.startDate)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(period.endDate)
      || dateKeyAsUtc(period.endDate) - dateKeyAsUtc(period.startDate) !== 13 * 86_400_000
      || !Array.isArray(period.totals)
      || period.totals.length > 100
    ) return null;
    const totals = [];
    const seen = new Set();
    for (const item of period.totals) {
      if (!exactStaffClockKeys(item, [
        'staffId',
        'staffName',
        'completedShifts',
        'totalSeconds',
        'needsAttention'
      ])) return null;
      const staffId = cleanStaffClockText(item.staffId, 80);
      const staffName = cleanStaffClockText(item.staffName, 100);
      if (
        !staffId
        || !staffName
        || seen.has(staffId)
        || !Number.isSafeInteger(item.completedShifts)
        || item.completedShifts < 0
        || !Number.isSafeInteger(item.totalSeconds)
        || item.totalSeconds < 0
        || item.totalSeconds > 15 * 24 * 60 * 60
        || typeof item.needsAttention !== 'boolean'
      ) return null;
      seen.add(staffId);
      totals.push({
        staffId,
        staffName,
        completedShifts: item.completedShifts,
        totalSeconds: item.totalSeconds,
        needsAttention: item.needsAttention
      });
    }
    return { startDate: period.startDate, endDate: period.endDate, totals };
  }

  function normalizeStaffClockPeriods(value) {
    if (!exactStaffClockKeys(value, ['current', 'previous'])) return null;
    const current = normalizeStaffClockPeriod(value.current);
    const previous = normalizeStaffClockPeriod(value.previous);
    return current
      && previous
      && dateKeyAsUtc(current.startDate) - dateKeyAsUtc(previous.endDate) === 86_400_000
      ? { current, previous }
      : null;
  }

  function normalizeStaffClockView(value) {
    const countKeys = [
      'recordCount',
      'recordTotal',
      'todayPunchCount',
      'todayPunchTotal',
      'adjustmentCount',
      'adjustmentTotal',
      'attentionCount',
      'attentionOccurrenceCount',
      'auditCount',
      'auditTotal'
    ];
    if (
      !exactStaffClockKeys(value, [
        'token',
        'today',
        ...countKeys,
        'recordsTruncated',
        'auditTruncated'
      ])
      || !/^[0-9a-f]{64}$/u.test(value.token)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(value.today)
      || utcAsDateKey(dateKeyAsUtc(value.today)) !== value.today
      || countKeys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
      || value.recordCount > STAFF_CLOCK_MAX_INCLUDED_RECORDS
      || value.attentionCount > STAFF_CLOCK_MAX_ATTENTION_GROUPS
      || value.recordCount > value.recordTotal
      || value.todayPunchCount > value.recordCount
      || value.todayPunchCount > value.todayPunchTotal
      || value.todayPunchTotal > value.recordTotal
      || value.adjustmentCount > value.recordCount
      || value.adjustmentCount > value.adjustmentTotal
      || value.adjustmentTotal > value.recordTotal
      || value.attentionCount > value.attentionOccurrenceCount
      || value.auditCount !== 0
      || value.auditTotal !== 0
      || value.recordsTruncated !== (value.recordCount < value.recordTotal)
      || value.auditTruncated !== false
    ) return null;
    return Object.fromEntries([
      ['token', value.token],
      ['today', value.today],
      ...countKeys.map(key => [key, value[key]]),
      ['recordsTruncated', value.recordsTruncated],
      ['auditTruncated', false]
    ]);
  }

  function normalizeStaffClockSummary(value, records) {
    if (
      !value
      || !exactStaffClockKeys(value, [
        'records',
        'clockedInNow',
        'needsAttention',
        'periods',
        'view'
      ])
      || !Array.isArray(records)
      || !Array.isArray(value.clockedInNow)
      || value.clockedInNow.length > 100
      || !Array.isArray(value.needsAttention)
      || value.needsAttention.length > STAFF_CLOCK_MAX_ATTENTION_GROUPS
    ) return null;

    const normalizedRecords = normalizeStaffClockRecordList(
      value.records,
      STAFF_CLOCK_MAX_INCLUDED_RECORDS
    );
    const periods = normalizeStaffClockPeriods(value.periods);
    const view = normalizeStaffClockView(value.view);
    if (!normalizedRecords || !periods || !view || normalizedRecords.length !== view.recordCount) {
      return null;
    }
    const clockedInNow = [];
    const clockedStaff = new Set();
    for (const item of value.clockedInNow) {
      if (!exactStaffClockKeys(item, ['punchId', 'staffId', 'staffName', 'clockInAt'])) return null;
      const staffId = cleanStaffClockText(item.staffId, 80);
      const staffName = cleanStaffClockText(item.staffName, 100);
      if (
        !STAFF_PUNCH_ID_PATTERN.test(item.punchId)
        || !staffId
        || !staffName
        || !validStaffClockTimestamp(item.clockInAt)
        || clockedStaff.has(staffId)
      ) return null;
      clockedStaff.add(staffId);
      clockedInNow.push({
        punchId: item.punchId,
        staffId,
        staffName,
        clockInAt: item.clockInAt
      });
    }

    const needsAttention = [];
    const attentionIdentities = new Set();
    let attentionOccurrences = 0;
    for (const item of value.needsAttention) {
      if (!exactStaffClockKeys(item, [
        'staffId',
        'staffName',
        'code',
        'message',
        'linkedPunchIds',
        'occurrenceCount'
      ])) return null;
      const staffId = cleanStaffClockText(item.staffId, 80);
      const staffName = cleanStaffClockText(item.staffName, 100);
      const code = cleanStaffClockText(item.code, 64);
      const message = cleanStaffClockText(item.message, 240);
      const identity = `${staffId}\u0000${code}`;
      if (
        !staffId
        || !staffName
        || !/^[a-z][a-z0-9_]*$/u.test(code)
        || !message
        || attentionIdentities.has(identity)
        || !Array.isArray(item.linkedPunchIds)
        || item.linkedPunchIds.length > 20
        || !Number.isSafeInteger(item.occurrenceCount)
        || item.occurrenceCount < 1
      ) return null;
      const linkedPunchIds = [];
      const linked = new Set();
      for (const punchId of item.linkedPunchIds) {
        if (
          typeof punchId !== 'string'
          || !STAFF_PUNCH_ID_PATTERN.test(punchId)
          || linked.has(punchId)
        ) return null;
        linked.add(punchId);
        linkedPunchIds.push(punchId);
      }
      attentionIdentities.add(identity);
      attentionOccurrences += item.occurrenceCount;
      if (!Number.isSafeInteger(attentionOccurrences)) return null;
      needsAttention.push({
        staffId,
        staffName,
        code,
        message,
        linkedPunchIds,
        occurrenceCount: item.occurrenceCount
      });
    }
    if (
      clockedInNow.length > view.recordTotal
      || needsAttention.length !== view.attentionCount
      || attentionOccurrences !== view.attentionOccurrenceCount
      || view.today < periods.current.startDate
      || view.today > periods.current.endDate
    ) return null;
    const todayCount = normalizedRecords.filter(record => record.date === view.today).length;
    const adjustmentCount = normalizedRecords.filter(record => (
      record.date >= periods.previous.startDate
      && record.date <= periods.current.endDate
      && (
        record.source === 'Admin-added'
        || record.status === 'VOID'
        || Boolean(record.adjustmentRequestId)
      )
    )).length;
    if (todayCount !== view.todayPunchCount || adjustmentCount !== view.adjustmentCount) return null;
    return {
      records: normalizedRecords,
      clockedInNow,
      needsAttention,
      periods,
      view
    };
  }

  function loadStaffClockState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STAFF_CLOCK_STATE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return blankStaffClockState();
      }
      if (parsed.version === 1) {
        const ledger = normalizeStaffClockRecordList(parsed.ledger);
        const queue = normalizeStaffClockRecordList(parsed.queue);
        if (!ledger || !queue) return blankStaffClockState();
        const ledgerById = new Map(ledger.map(record => [record.punchId, record]));
        if (queue.some(record => !sameStaffClockRecord(ledgerById.get(record.punchId), record))) {
          return blankStaffClockState();
        }
        const baselineIds = new Set(Array.isArray(parsed.baselinePunchIds)
          ? parsed.baselinePunchIds
          : []);
        const overlay = ledger.filter(record => !baselineIds.has(record.punchId));
        const overlayById = new Map(overlay.map(record => [record.punchId, record]));
        queue.forEach(record => {
          if (!overlayById.has(record.punchId)) {
            overlay.push(record);
            overlayById.set(record.punchId, record);
          }
        });
        return {
          version: STAFF_CLOCK_STATE_VERSION,
          baseline: null,
          overlay,
          queue
        };
      }
      if (
        parsed.version !== STAFF_CLOCK_STATE_VERSION
        || !exactStaffClockKeys(parsed, ['version', 'baseline', 'overlay', 'queue'])
      ) return blankStaffClockState();
      const overlay = normalizeStaffClockRecordList(parsed.overlay);
      const queue = normalizeStaffClockRecordList(parsed.queue);
      if (!overlay || !queue) return blankStaffClockState();
      const overlayById = new Map(overlay.map(record => [record.punchId, record]));
      if (queue.some(record => !sameStaffClockRecord(overlayById.get(record.punchId), record))) {
        return blankStaffClockState();
      }
      const baseline = parsed.baseline == null
        ? null
        : normalizeStaffClockSummary(parsed.baseline, parsed.baseline.records);
      if (parsed.baseline != null && !baseline) return blankStaffClockState();
      return { version: STAFF_CLOCK_STATE_VERSION, baseline, overlay, queue };
    } catch {
      return blankStaffClockState();
    }
  }

  function saveStaffClockState(state) {
    if (
      !state
      || state.version !== STAFF_CLOCK_STATE_VERSION
      || !exactStaffClockKeys(state, ['version', 'baseline', 'overlay', 'queue'])
    ) throw new Error('Staff Clock state is invalid.');
    const overlay = normalizeStaffClockRecordList(state.overlay);
    const queue = normalizeStaffClockRecordList(state.queue);
    if (!overlay || !queue) throw new Error('Staff Clock state is invalid.');
    const overlayById = new Map(overlay.map(record => [record.punchId, record]));
    if (queue.some(record => !sameStaffClockRecord(overlayById.get(record.punchId), record))) {
      throw new Error('Staff Clock waiting state is invalid.');
    }
    const baseline = state.baseline == null
      ? null
      : normalizeStaffClockSummary(state.baseline, state.baseline.records);
    if (state.baseline != null && !baseline) {
      throw new Error('Staff Clock server baseline is invalid.');
    }
    localStorage.setItem(STAFF_CLOCK_STATE_KEY, JSON.stringify({
      version: STAFF_CLOCK_STATE_VERSION,
      baseline,
      overlay,
      queue
    }));
  }

  function reconcileStaffClockSnapshotState(state, baseline) {
    if (
      !state
      || state.version !== STAFF_CLOCK_STATE_VERSION
      || !Array.isArray(state.queue)
      || state.queue.length
      || !baseline
    ) return null;
    const normalized = normalizeStaffClockSummary(baseline, baseline.records);
    if (!normalized) return null;
    return {
      version: STAFF_CLOCK_STATE_VERSION,
      baseline: normalized,
      overlay: [],
      queue: []
    };
  }

  function loadStaffClockPeople() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STAFF_CLOCK_STAFF_CACHE_KEY) || 'null');
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.staff)) return [];
      const staff = parsed.staff.map(normalizeStaffClockPerson);
      if (!staff.length || staff.some(person => !person)) return [];
      const ids = new Set(staff.map(person => person.staffId));
      const names = new Set(staff.map(person => person.staffName.toLocaleLowerCase('en-US')));
      if (ids.size !== staff.length || names.size !== staff.length) return [];
      return staff;
    } catch {
      return [];
    }
  }

  function saveStaffClockPeople(staff) {
    const normalized = Array.isArray(staff) ? staff.map(normalizeStaffClockPerson) : [];
    if (!normalized.length || normalized.some(person => !person)) {
      throw new Error('Staff Clock staff list is invalid.');
    }
    const ids = new Set(normalized.map(person => person.staffId));
    const names = new Set(normalized.map(person => person.staffName.toLocaleLowerCase('en-US')));
    if (ids.size !== normalized.length || names.size !== normalized.length) {
      throw new Error('Staff Clock staff list is ambiguous.');
    }
    localStorage.setItem(STAFF_CLOCK_STAFF_CACHE_KEY, JSON.stringify({
      version: 1,
      staff: normalized
    }));
    staffClockPeople = normalized;
  }

  function setStaffClockAvailability(state) {
    const allowed = new Set(['loading', 'ready', 'authorization-required', 'unavailable']);
    staffClockAvailability = allowed.has(state) ? state : 'unavailable';
    if (staffClockAvailability === 'ready' && !staffClockPeople.length) {
      staffClockAvailability = 'unavailable';
    }

    const availability = $('#staffClockAvailability');
    const title = $('#staffClockAvailabilityTitle');
    const detail = $('#staffClockAvailabilityDetail');
    const pairingCodeWrap = $('#staffClockPairingCodeWrap');
    const pairingCode = $('#staffClockPairingCode');
    const pairingExpiry = $('#staffClockPairingExpiry');
    const pairingInstructions = $('#staffClockPairingInstructions');
    const retry = $('#retryStaffClock');
    const cancel = $('#cancelStaffClockPairing');
    const controls = $('#staffClockControls');
    const select = $('#staffClockName');
    const action = $('#btnStaffClockAction');
    if (
      !availability
      || !title
      || !detail
      || !pairingCodeWrap
      || !pairingCode
      || !pairingExpiry
      || !pairingInstructions
      || !retry
      || !controls
    ) return;

    const ready = staffClockAvailability === 'ready';
    availability.hidden = ready;
    controls.hidden = !ready || staffClockConfirmationActive;
    if (select) select.disabled = !ready;
    if (action && !ready) action.disabled = true;
    pairingCodeWrap.hidden = true;
    pairingCode.textContent = '';
    pairingExpiry.textContent = '';
    pairingInstructions.hidden = true;
    retry.hidden = true;
    if (cancel) cancel.hidden = true;

    if (ready) return;
    if (staffClockAvailability === 'authorization-required') {
      title.textContent = 'This tablet needs authorization';
      detail.textContent = 'Preparing a short-lived pairing code for an Admin.';
      return;
    }
    if (staffClockAvailability === 'loading') {
      title.textContent = 'Loading Staff Clock…';
      detail.textContent = 'Checking this tablet and loading the active staff roster.';
      return;
    }
    title.textContent = 'Staff Clock is unavailable';
    detail.textContent = 'Staff names could not be loaded. Try again when this tablet is online.';
    retry.textContent = 'Try again';
    retry.hidden = false;
  }

  function showStaffClockAuthorizationRequired() {
    setStaffClockAvailability('authorization-required');
    if (STAFF_CLOCK_PAIRING_AVAILABLE) {
      void ensureStaffClockPairing();
      return;
    }
    const detail = $('#staffClockAvailabilityDetail');
    if (detail) detail.textContent = 'Tablet pairing is unavailable. Ask an owner or manager for help.';
  }

  function populateStaffClockPeople() {
    const select = $('#staffClockName');
    if (!select) return;
    const selected = select.value;
    select.replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'Select staff member';
    select.appendChild(prompt);
    staffClockPeople.forEach(person => {
      const option = document.createElement('option');
      option.value = person.staffId;
      option.textContent = person.staffName;
      select.appendChild(option);
    });
    if (staffClockPeople.some(person => person.staffId === selected)) {
      select.value = selected;
    }
    renderStaffClock();
  }

  function selectedStaffClockPerson() {
    const selectedId = $('#staffClockName')?.value || '';
    return staffClockPeople.find(person => person.staffId === selectedId) || null;
  }

  function combinedStaffClockRecords(state = loadStaffClockState()) {
    return mergeStaffRecords(state.overlay, state.queue);
  }

  function staffClockBaselineOpenRecord(item) {
    return {
      punchId: item.punchId,
      timestamp: item.clockInAt,
      date: fmtDate(new Date(item.clockInAt)),
      staffId: item.staffId,
      staffName: item.staffName,
      punchAction: 'clockIn',
      site: 'Server baseline',
      device: 'Staff Clock server baseline',
      build: 'Staff Clock server baseline',
      note: '',
      status: 'ACTIVE',
      source: 'Tablet',
      adminName: '',
      linkedPunchId: ''
    };
  }

  function staffClockStatusFor(staffId, state = loadStaffClockState(), now = new Date()) {
    const merged = combinedStaffClockRecords(state);
    const open = state.baseline?.clockedInNow.find(item => item.staffId === staffId) || null;
    const evaluated = evaluateStaffState(
      staffId,
      open ? [staffClockBaselineOpenRecord(open), ...merged.records] : merged.records,
      {
      now,
      attention: merged.attention
      }
    );
    const baselineAttention = state.baseline?.needsAttention
      .filter(item => item.staffId === staffId) || [];
    return baselineAttention.length
      ? {
          ...evaluated,
          needsAttention: true,
          attention: baselineAttention.map(item => ({
            code: item.code,
            punchId: item.linkedPunchIds[0] || '',
            message: item.message
          }))
        }
      : evaluated;
  }

  function formatStaffClockTime(timestamp) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return 'Unknown time';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }

  function formatStaffClockShift(startTimestamp, endTimestamp) {
    const elapsed = Date.parse(endTimestamp) - Date.parse(startTimestamp);
    return formatStaffElapsed(Math.max(0, elapsed));
  }

  function newYorkStaffTimestamp(date = new Date()) {
    const values = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).forEach(part => {
      if (part.type !== 'literal') values[part.type] = part.value;
    });
    const localUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );
    const offsetMinutes = Math.round((localUtc - Math.floor(date.getTime() / 1_000) * 1_000) / 60_000);
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(offsetMinutes);
    const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
    return {
      timestamp: `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`,
      date: `${values.year}-${values.month}-${values.day}`
    };
  }

  function createStaffClockPunchId() {
    return createStaffPunchId();
  }

  function showStaffClockConfirmation(person, punch, options = {}) {
    const waiting = options.waiting === true;
    staffClockConfirmationActive = true;
    staffClockConfirmationContext = {
      person,
      punch,
      clockInTimestamp: options.clockInTimestamp || null
    };
    $('#staffClockControls').hidden = true;
    const confirmation = $('#staffClockConfirmation');
    confirmation.hidden = false;
    confirmation.classList.toggle('waiting', waiting);
    const title = $('#staffClockConfirmationTitle');
    const detail = $('#staffClockConfirmationDetail');
    if (waiting) {
      title.textContent = 'Saved on this tablet — waiting to sync';
    } else {
      title.textContent = punch.punchAction === 'clockIn' ? 'Clocked in' : 'Clocked out';
    }
    const lines = [`${person.staffName} · ${formatStaffClockTime(punch.timestamp)}`];
    if (punch.punchAction === 'clockOut' && options.clockInTimestamp) {
      lines.push(`Shift: ${formatStaffClockShift(options.clockInTimestamp, punch.timestamp)}`);
    }
    detail.textContent = lines.join('\n');
    const done = $('#btnStaffClockDone');
    done.disabled = true;
    if (staffClockDoneTimer) window.clearTimeout(staffClockDoneTimer);
    staffClockDoneTimer = window.setTimeout(() => {
      staffClockDoneTimer = null;
      done.disabled = false;
      done.focus();
    }, 800);
  }

  function markStaffClockConfirmationConfirmed(punchId) {
    if (
      !staffClockConfirmationActive
      || staffClockConfirmationContext?.punch?.punchId !== punchId
    ) return;
    const { person, punch, clockInTimestamp } = staffClockConfirmationContext;
    showStaffClockConfirmation(person, punch, {
      waiting: false,
      clockInTimestamp
    });
  }

  function renderStaffClock() {
    if (staffClockConfirmationActive) return;
    if (staffClockAvailability !== 'ready') {
      $('#btnStaffClockAction').disabled = true;
      return;
    }
    const person = selectedStaffClockPerson();
    const statusElement = $('#staffClockStatus');
    const action = $('#btnStaffClockAction');
    statusElement.classList.remove('warn');
    if (!person) {
      statusElement.textContent = 'Select your name to see your status.';
      action.textContent = 'Clock in';
      action.dataset.action = 'clockIn';
      action.disabled = true;
      return;
    }

    const current = staffClockStatusFor(person.staffId);
    if (current.needsAttention) {
      statusElement.textContent = 'Needs attention';
      statusElement.classList.add('warn');
      action.textContent = 'Admin review needed';
      action.dataset.action = '';
      action.disabled = true;
      return;
    }
    if (current.clockedIn) {
      statusElement.textContent = `Clocked in at ${formatStaffClockTime(current.clockInRecord.timestamp)}`;
      action.textContent = 'Clock out';
      action.dataset.action = 'clockOut';
    } else {
      statusElement.textContent = 'Not clocked in';
      action.textContent = 'Clock in';
      action.dataset.action = 'clockIn';
    }
    action.disabled = false;
  }

  function performStaffClockAction() {
    if (
      staffClockActionLocked
      || staffClockConfirmationActive
      || staffClockAvailability !== 'ready'
    ) return;
    const person = selectedStaffClockPerson();
    if (!person) return;
    const action = $('#btnStaffClockAction');
    const state = loadStaffClockState();
    const current = staffClockStatusFor(person.staffId, state);
    const expectedAction = current.clockedIn ? 'clockOut' : 'clockIn';
    const statusElement = $('#staffClockStatus');

    if (current.needsAttention) {
      statusElement.textContent = 'Needs attention';
      statusElement.classList.add('warn');
      action.disabled = true;
      return;
    }
    if (action.dataset.action !== expectedAction) {
      renderStaffClock();
      return;
    }

    staffClockActionLocked = true;
    action.disabled = true;
    let punch;
    try {
      const when = newYorkStaffTimestamp(new Date());
      punch = normalizeStaffClockRecord({
        punchId: createStaffClockPunchId(),
        timestamp: when.timestamp,
        date: when.date,
        staffId: person.staffId,
        staffName: person.staffName,
        punchAction: expectedAction,
        site: IS_PRODUCTION_ORIGIN
          ? installationProfile.siteCode
          : `${installationProfile.siteCode} TEST`,
        device: 'Staff Clock tablet',
        build: BUILD,
        note: '',
        status: 'ACTIVE',
        source: 'Tablet',
        adminName: '',
        linkedPunchId: ''
      });
      if (!punch) throw new Error('The Staff Clock punch was invalid.');
      saveStaffClockState({
        ...state,
        overlay: [...state.overlay, punch],
        queue: [...state.queue, punch]
      });
    } catch {
      staffClockActionLocked = false;
      action.disabled = false;
      statusElement.textContent = 'This punch could not be saved on the tablet. Please try again.';
      statusElement.classList.add('warn');
      return;
    }

    showStaffClockConfirmation(person, punch, {
      waiting: true,
      clockInTimestamp: current.clockInRecord?.timestamp || null
    });
    renderStaffTimeAdmin();
    void syncStaffClockQueue();
  }

  function resetStaffClockCard() {
    const done = $('#btnStaffClockDone');
    if (done.disabled) return;
    if (staffClockDoneTimer) window.clearTimeout(staffClockDoneTimer);
    staffClockDoneTimer = null;
    staffClockConfirmationActive = false;
    staffClockConfirmationContext = null;
    staffClockActionLocked = false;
    $('#staffClockConfirmation').hidden = true;
    $('#staffClockConfirmation').classList.remove('waiting');
    $('#staffClockControls').hidden = staffClockAvailability !== 'ready';
    $('#staffClockName').value = '';
    done.disabled = false;
    renderStaffClock();
    $('#staffClockName').focus();
  }

  async function postStaffClock(body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller
      ? window.setTimeout(() => controller.abort(), 25_000)
      : null;
    try {
      const response = await fetch(STAFF_CLOCK_ENDPOINT, {
        method: 'POST',
        credentials: IS_PRODUCTION_ORIGIN ? 'same-origin' : 'omit',
        ...(IS_PRODUCTION_ORIGIN ? { mode: 'same-origin', redirect: 'error' } : {}),
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response || response.ok !== true || typeof response.json !== 'function') {
        const error = new Error('Staff Clock was not confirmed.');
        error.staffClockStatus = Number.isSafeInteger(response?.status) ? response.status : 0;
        throw error;
      }
      return await response.json();
    } finally {
      if (timeout != null) window.clearTimeout(timeout);
    }
  }

  function validStaffClockPairingCode(value) {
    return typeof value === 'string'
      && /^[0-9A-HJ-KM-NP-TV-Z]{5}-[0-9A-HJ-KM-NP-TV-Z]{5}$/u.test(value);
  }

  function validStaffClockPairingTimestamp(value) {
    return typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
      && Number.isFinite(Date.parse(value));
  }

  function validStaffClockPairingPending(value, now = Date.now()) {
    if (
      !exactStaffClockKeys(value, [
        'ok',
        'result',
        'pairingCode',
        'expiresAt',
        'gymName',
        'deviceLabel'
      ])
      || value.ok !== true
      || value.result !== 'pending'
      || !validStaffClockPairingCode(value.pairingCode)
      || value.gymName !== installationProfile.gymName
      || value.deviceLabel !== installationProfile.deviceLabel
    ) return false;
    if (!validStaffClockPairingTimestamp(value.expiresAt)) return false;
    const expiresAt = Date.parse(value.expiresAt);
    return Number.isFinite(expiresAt)
      && expiresAt > now
      && expiresAt <= now + STAFF_CLOCK_PAIRING_MAX_LIFETIME_MS;
  }

  function validStaffClockPairingResult(value, result) {
    return exactStaffClockKeys(value, ['ok', 'result'])
      && value.ok === true
      && value.result === result;
  }

  function validStaffClockPairingApproved(value, now = Date.now()) {
    if (
      !exactStaffClockKeys(value, ['ok', 'result', 'expiresAt', 'deliveryExpiresAt'])
      || value.ok !== true
      || value.result !== 'approved'
    ) return false;
    if (
      !validStaffClockPairingTimestamp(value.expiresAt)
      || !validStaffClockPairingTimestamp(value.deliveryExpiresAt)
    ) return false;
    const expiresAt = Date.parse(value.expiresAt);
    const deliveryExpiresAt = Date.parse(value.deliveryExpiresAt);
    return Number.isFinite(expiresAt)
      && Number.isFinite(deliveryExpiresAt)
      && deliveryExpiresAt > now
      && expiresAt <= now + STAFF_CLOCK_PAIRING_MAX_LIFETIME_MS
      && deliveryExpiresAt === expiresAt + STAFF_CLOCK_PAIRING_MAX_DELIVERY_WINDOW_MS;
  }

  function validStaffClockPairingExpired(value) {
    return exactStaffClockKeys(value, ['ok', 'result', 'message'])
      && value.ok === false
      && value.result === 'expired'
      && value.message === 'Pairing code expired. Request a new code.';
  }

  function validStaffClockPairingAuthorizationRequired(value) {
    return exactStaffClockKeys(value, ['ok', 'result', 'message'])
      && value.ok === false
      && value.result === 'authorization_required'
      && value.message === 'This tablet needs authorization.';
  }

  function validStaffClockPairingRejected(value) {
    return exactStaffClockKeys(value, ['ok', 'message'])
      && value.ok === false
      && value.message === 'Tablet pairing request was not accepted.';
  }

  function validStaffClockPairingTerminal(value, result) {
    const messages = {
      rejected: 'Pairing request was rejected by an Admin.',
      cancelled: 'Pairing request was cancelled on this tablet.'
    };
    return Object.hasOwn(messages, result)
      && exactStaffClockKeys(value, ['ok', 'result', 'message'])
      && value.ok === false
      && value.result === result
      && value.message === messages[result];
  }

  async function postStaffClockPairing(operation) {
    const endpoint = operation === 'start'
      ? STAFF_CLOCK_PAIRING_START_ENDPOINT
      : operation === 'poll'
        ? STAFF_CLOCK_PAIRING_POLL_ENDPOINT
        : operation === 'cancel'
          ? STAFF_CLOCK_PAIRING_CANCEL_ENDPOINT
          : '';
    if (!endpoint) throw new Error('Tablet pairing operation was invalid.');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller
      ? window.setTimeout(() => controller.abort(), 15_000)
      : null;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ operation }),
        ...(controller ? { signal: controller.signal } : {})
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!response.ok || !data) {
        const error = new Error(data?.message || 'Tablet pairing is temporarily unavailable.');
        error.staffClockPairingStatus = Number.isSafeInteger(response?.status) ? response.status : 0;
        error.staffClockPairingData = data;
        throw error;
      }
      return data;
    } finally {
      if (timeout != null) window.clearTimeout(timeout);
    }
  }

  function clearStaffClockPairingTimer() {
    if (staffClockPairingPollTimer != null) window.clearTimeout(staffClockPairingPollTimer);
    staffClockPairingPollTimer = null;
  }

  function clearStaffClockPairingMemory() {
    clearStaffClockPairingTimer();
    staffClockPairingCode = '';
    staffClockPairingExpiresAt = '';
    staffClockPairingDeliveryExpiresAt = '';
  }

  function staffClockPairingExpiresLabel(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `Expires at ${new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    }).format(date)} America/New_York time.`;
  }

  function renderStaffClockPairingPending(message, options = {}) {
    setStaffClockAvailability('authorization-required');
    const detail = $('#staffClockAvailabilityDetail');
    const codeWrap = $('#staffClockPairingCodeWrap');
    const code = $('#staffClockPairingCode');
    const expiry = $('#staffClockPairingExpiry');
    const instructions = $('#staffClockPairingInstructions');
    const adminUrl = $('#staffClockPairingAdminUrl');
    const retry = $('#retryStaffClock');
    const cancel = $('#cancelStaffClockPairing');
    if (detail) detail.textContent = message;
    if (staffClockPairingCode && codeWrap && code && expiry && instructions && adminUrl) {
      code.textContent = staffClockPairingCode;
      expiry.textContent = staffClockPairingExpiresLabel(staffClockPairingExpiresAt);
      adminUrl.textContent = new URL('/m1/admin/', STAFF_CLOCK_PAIRING_CONFIG.origin).href;
      codeWrap.hidden = false;
      instructions.hidden = false;
      if (cancel) cancel.hidden = false;
    }
    if (retry && options.showRetry === true) {
      retry.textContent = options.retryLabel || 'Retry pairing';
      retry.hidden = false;
    }
  }

  function renderStaffClockPairingExpired(message = 'Pairing code expired. Request a new code.') {
    clearStaffClockPairingMemory();
    renderStaffClockPairingPending(message, {
      showRetry: true,
      retryLabel: 'Get a new code'
    });
  }

  async function cancelStaffClockPairing() {
    if (!STAFF_CLOCK_PAIRING_AVAILABLE || staffClockPairingPromise) return null;
    clearStaffClockPairingTimer();
    const cancel = $('#cancelStaffClockPairing');
    if (navigator.onLine === false) {
      renderStaffClockPairingPending(
        'This tablet is offline. Reconnect before cancelling this pairing request.',
        { showRetry: true, retryLabel: 'Retry now' }
      );
      return null;
    }
    if (cancel) cancel.disabled = true;
    renderStaffClockPairingPending('Cancelling this pairing request…');
    staffClockPairingPromise = (async () => {
      try {
        const data = await postStaffClockPairing('cancel');
        if (validStaffClockPairingApproved(data)) {
          if (
            staffClockPairingExpiresAt
            && data.expiresAt !== staffClockPairingExpiresAt
          ) throw new Error('Tablet pairing changed unexpectedly.');
          staffClockPairingCode = '';
          staffClockPairingExpiresAt = data.expiresAt;
          staffClockPairingDeliveryExpiresAt = data.deliveryExpiresAt;
          renderStaffClockPairingPending('Admin approval completed first. Finishing secure authorization…');
          scheduleStaffClockPairingPoll(STAFF_CLOCK_PAIRING_APPROVED_POLL_MS);
          return data;
        }
        if (validStaffClockPairingResult(data, 'authorized')) {
          clearStaffClockPairingMemory();
          setStaffClockAvailability('loading');
          staffClockAuthorizationRecoveryInProgress = true;
          window.setTimeout(() => {
            void refreshStaffClockRosterAfterAuthorization();
          }, 0);
          return data;
        }
        if (!validStaffClockPairingResult(data, 'cancelled')) {
          throw new Error('Tablet pairing cancellation returned an incomplete response.');
        }
        clearStaffClockPairingMemory();
        renderStaffClockPairingPending('Pairing request cancelled. No Admin can approve that code.', {
          showRetry: true,
          retryLabel: 'Get a new code'
        });
        return data;
      } catch (error) {
        if (
          error?.staffClockPairingStatus === 410
          && validStaffClockPairingExpired(error.staffClockPairingData)
        ) {
          renderStaffClockPairingExpired(error.staffClockPairingData.message);
          return null;
        }
        if (staffClockPairingStillCurrent()) {
          renderStaffClockPairingPending(
            'Cancellation did not complete. This code remains pending and will keep checking automatically.',
            { showRetry: true, retryLabel: 'Retry now' }
          );
          scheduleStaffClockPairingPoll();
        } else {
          renderStaffClockPairingExpired(error?.message || 'Pairing request could not be cancelled.');
        }
        return null;
      } finally {
        if (cancel) cancel.disabled = false;
        staffClockPairingPromise = null;
      }
    })();
    return staffClockPairingPromise;
  }

  function scheduleStaffClockPairingPoll(delay = STAFF_CLOCK_PAIRING_POLL_INTERVAL_MS) {
    clearStaffClockPairingTimer();
    staffClockPairingPollTimer = window.setTimeout(() => {
      staffClockPairingPollTimer = null;
      void runStaffClockPairing('poll');
    }, delay);
  }

  function staffClockPairingStillCurrent(now = Date.now()) {
    const deliveredUntil = Date.parse(staffClockPairingDeliveryExpiresAt);
    if (Number.isFinite(deliveredUntil)) return deliveredUntil > now;
    const pairingExpiresAt = Date.parse(staffClockPairingExpiresAt);
    const expiresAt = Number.isFinite(pairingExpiresAt)
      ? pairingExpiresAt + STAFF_CLOCK_PAIRING_MAX_DELIVERY_WINDOW_MS
      : NaN;
    return Number.isFinite(expiresAt) && expiresAt > now;
  }

  async function runStaffClockPairing(operation) {
    if (!STAFF_CLOCK_PAIRING_AVAILABLE) return null;
    if (staffClockPairingPromise) return staffClockPairingPromise;
    if (navigator.onLine === false) {
      renderStaffClockPairingPending(
        'This tablet is offline. Pairing will retry automatically when the connection returns.',
        { showRetry: true, retryLabel: staffClockPairingCode ? 'Retry now' : 'Get a new code' }
      );
      return null;
    }

    staffClockPairingPromise = (async () => {
      try {
        const data = await postStaffClockPairing(operation);
        if (validStaffClockPairingPending(data)) {
          if (
            operation === 'poll'
            && staffClockPairingCode
            && (
              data.pairingCode !== staffClockPairingCode
              || data.expiresAt !== staffClockPairingExpiresAt
            )
          ) throw new Error('Tablet pairing changed unexpectedly.');
          staffClockPairingCode = data.pairingCode;
          staffClockPairingExpiresAt = data.expiresAt;
          renderStaffClockPairingPending(
            `${data.gymName} · ${data.deviceLabel} · Waiting for Admin approval.`
          );
          scheduleStaffClockPairingPoll();
          return data;
        }
        if (validStaffClockPairingApproved(data)) {
          if (
            staffClockPairingExpiresAt
            && data.expiresAt !== staffClockPairingExpiresAt
          ) throw new Error('Tablet pairing changed unexpectedly.');
          staffClockPairingCode = '';
          staffClockPairingExpiresAt = data.expiresAt;
          staffClockPairingDeliveryExpiresAt = data.deliveryExpiresAt;
          renderStaffClockPairingPending('Admin approved this tablet. Finishing secure authorization…');
          scheduleStaffClockPairingPoll(STAFF_CLOCK_PAIRING_APPROVED_POLL_MS);
          return data;
        }
        if (validStaffClockPairingResult(data, 'authorized')) {
          clearStaffClockPairingMemory();
          setStaffClockAvailability('loading');
          // Lock queue delivery before yielding. A lifecycle event can fire between
          // the authorization response and the authoritative roster refresh.
          staffClockAuthorizationRecoveryInProgress = true;
          window.setTimeout(() => {
            void refreshStaffClockRosterAfterAuthorization();
          }, 0);
          return data;
        }
        throw new Error('Tablet pairing returned an incomplete response.');
      } catch (error) {
        if (
          error?.staffClockPairingStatus === 401
          && validStaffClockPairingAuthorizationRequired(error.staffClockPairingData)
        ) {
          renderStaffClockPairingExpired(error.staffClockPairingData.message);
          return null;
        }
        if (
          error?.staffClockPairingStatus === 403
          && validStaffClockPairingRejected(error.staffClockPairingData)
        ) {
          renderStaffClockPairingExpired(error.staffClockPairingData.message);
          return null;
        }
        if (
          error?.staffClockPairingStatus === 409
          && validStaffClockPairingTerminal(
            error.staffClockPairingData,
            error.staffClockPairingData?.result
          )
        ) {
          renderStaffClockPairingExpired(error.staffClockPairingData.message);
          return null;
        }
        if (
          error?.staffClockPairingStatus === 410
          && validStaffClockPairingExpired(error.staffClockPairingData)
        ) {
          renderStaffClockPairingExpired(error.staffClockPairingData.message);
          return null;
        }
        if (staffClockPairingStillCurrent()) {
          if (Date.parse(staffClockPairingExpiresAt) <= Date.now()) staffClockPairingCode = '';
          renderStaffClockPairingPending(
            staffClockPairingCode
              ? 'Connection interrupted. Pairing will retry automatically without changing this code.'
              : 'Connection interrupted after approval may have started. Retrying secure delivery automatically.',
            { showRetry: true, retryLabel: 'Retry now' }
          );
          scheduleStaffClockPairingPoll();
        } else {
          clearStaffClockPairingMemory();
          renderStaffClockPairingPending(
            error?.message || 'Tablet pairing is temporarily unavailable.',
            { showRetry: true, retryLabel: 'Get a new code' }
          );
        }
        return null;
      } finally {
        staffClockPairingPromise = null;
      }
    })();
    return staffClockPairingPromise;
  }

  function ensureStaffClockPairing() {
    if (!STAFF_CLOCK_PAIRING_AVAILABLE) return;
    if (staffClockPairingStillCurrent()) {
      if (Date.parse(staffClockPairingExpiresAt) <= Date.now()) staffClockPairingCode = '';
      renderStaffClockPairingPending(
        staffClockPairingCode
          ? 'Waiting for Admin approval.'
          : 'Finishing secure tablet authorization…'
      );
      if (!staffClockPairingPromise && staffClockPairingPollTimer == null) {
        scheduleStaffClockPairingPoll(0);
      }
      return;
    }
    if (!staffClockPairingPromise && staffClockPairingPollTimer == null) {
      void runStaffClockPairing('start');
    }
  }

  function resumeStaffClockPairing() {
    if (!STAFF_CLOCK_PAIRING_AVAILABLE || staffClockPairingPromise) return;
    clearStaffClockPairingTimer();
    void runStaffClockPairing(staffClockPairingStillCurrent() ? 'poll' : 'start');
  }

  function restartStaffClockPairing() {
    clearStaffClockPairingMemory();
    renderStaffClockPairingPending('Requesting a new pairing code…');
    void runStaffClockPairing('start');
  }

  function validatedStaffClockSnapshotStart(value) {
    const expectedTarget = IS_PRODUCTION_ORIGIN ? 'production' : 'test';
    if (
      !value
      || typeof value !== 'object'
      || !exactStaffClockKeys(value, [
        'ok',
        'target',
        'staff',
        'clockedInNow',
        'periods',
        'view'
      ])
      || value.ok !== true
      || value.target !== expectedTarget
      || !Array.isArray(value.staff)
      || !Array.isArray(value.clockedInNow)
      || value.clockedInNow.length > 100
    ) return null;
    const staff = value.staff.map(normalizeStaffClockPerson);
    if (!staff.length || staff.some(person => !person)) {
      return null;
    }
    const ids = new Set(staff.map(person => person.staffId));
    const names = new Set(staff.map(person => person.staffName.toLocaleLowerCase('en-US')));
    if (ids.size !== staff.length || names.size !== staff.length) return null;

    const clockedInNow = [];
    const clockedIds = new Set();
    const clockedStaff = new Set();
    for (const item of value.clockedInNow) {
      if (!exactStaffClockKeys(item, ['punchId', 'staffId', 'staffName', 'clockInAt'])) return null;
      const staffId = cleanStaffClockText(item.staffId, 80);
      const staffName = cleanStaffClockText(item.staffName, 100);
      if (
        !STAFF_PUNCH_ID_PATTERN.test(item.punchId)
        || !staffId
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(staffId)
        || !staffName
        || !validStaffClockTimestamp(item.clockInAt)
        || clockedIds.has(item.punchId)
        || clockedStaff.has(staffId)
      ) return null;
      clockedIds.add(item.punchId);
      clockedStaff.add(staffId);
      clockedInNow.push({
        punchId: item.punchId,
        staffId,
        staffName,
        clockInAt: item.clockInAt
      });
    }

    const periods = normalizeStaffClockPeriods(value.periods);
    const view = normalizeStaffClockView(value.view);
    if (
      !periods
      || !view
      || clockedInNow.length > view.recordTotal
      || view.today < periods.current.startDate
      || view.today > periods.current.endDate
    ) return null;
    return {
      staff,
      clockedInNow,
      periods,
      view
    };
  }

  function normalizeStaffClockPageAttention(value) {
    if (!exactStaffClockKeys(value, [
      'staffId',
      'staffName',
      'code',
      'message',
      'linkedPunchIds',
      'occurrenceCount'
    ])) return null;
    const staffId = cleanStaffClockText(value.staffId, 80);
    const staffName = cleanStaffClockText(value.staffName, 100);
    const code = cleanStaffClockText(value.code, 64);
    const message = cleanStaffClockText(value.message, 240);
    if (
      !staffId
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(staffId)
      || !staffName
      || !/^[a-z][a-z0-9_]*$/u.test(code)
      || !message
      || !Array.isArray(value.linkedPunchIds)
      || value.linkedPunchIds.length > 20
      || !Number.isSafeInteger(value.occurrenceCount)
      || value.occurrenceCount < 1
    ) return null;
    const linkedPunchIds = [];
    const seen = new Set();
    for (const punchId of value.linkedPunchIds) {
      if (
        typeof punchId !== 'string'
        || !STAFF_PUNCH_ID_PATTERN.test(punchId)
        || seen.has(punchId)
      ) return null;
      seen.add(punchId);
      linkedPunchIds.push(punchId);
    }
    return {
      staffId,
      staffName,
      code,
      message,
      linkedPunchIds,
      occurrenceCount: value.occurrenceCount
    };
  }

  function validatedStaffClockSnapshotPage(value, start, stream, offset) {
    const expectedTarget = IS_PRODUCTION_ORIGIN ? 'production' : 'test';
    const expectedCount = stream === 'records'
      ? start.view.recordCount
      : start.view.attentionCount;
    if (
      !value
      || !exactStaffClockKeys(value, [
        'ok',
        'target',
        'viewToken',
        'stream',
        'offset',
        'items',
        'nextOffset'
      ])
      || value.ok !== true
      || value.target !== expectedTarget
      || value.viewToken !== start.view.token
      || value.stream !== stream
      || value.offset !== offset
      || !Array.isArray(value.items)
      || value.items.length > 500
      || offset < 0
      || offset >= expectedCount
      || value.items.length < 1
      || offset + value.items.length > expectedCount
    ) return null;
    const endOffset = offset + value.items.length;
    if (
      (endOffset === expectedCount && value.nextOffset !== null)
      || (endOffset < expectedCount && value.nextOffset !== endOffset)
    ) return null;
    const items = value.items.map(item => (
      stream === 'records'
        ? normalizeStaffClockRecord(item)
        : normalizeStaffClockPageAttention(item)
    ));
    return items.some(item => !item)
      ? null
      : { items, nextOffset: value.nextOffset };
  }

  async function loadStaffClockSnapshot() {
    const start = validatedStaffClockSnapshotStart(
      await postStaffClock({ operation: 'snapshot' })
    );
    if (!start) return null;
    const streams = { records: [], attention: [] };
    const seen = { records: new Set(), attention: new Set() };
    for (const stream of ['records', 'attention']) {
      const expectedCount = stream === 'records'
        ? start.view.recordCount
        : start.view.attentionCount;
      let offset = 0;
      while (offset < expectedCount) {
        const page = validatedStaffClockSnapshotPage(
          await postStaffClock({
            operation: 'snapshotPage',
            viewToken: start.view.token,
            stream,
            offset
          }),
          start,
          stream,
          offset
        );
        if (!page) return null;
        for (const item of page.items) {
          const key = stream === 'records'
            ? item.punchId
            : `${item.staffId}\u0000${item.code}`;
          if (seen[stream].has(key)) return null;
          seen[stream].add(key);
          streams[stream].push(item);
        }
        offset = page.nextOffset == null ? expectedCount : page.nextOffset;
      }
      if (streams[stream].length !== expectedCount) return null;
    }

    const baseline = normalizeStaffClockSummary({
      records: streams.records,
      clockedInNow: start.clockedInNow,
      needsAttention: streams.attention,
      periods: start.periods,
      view: start.view
    }, streams.records);
    return baseline ? {
      staff: start.staff,
      baseline
    } : null;
  }

  async function loadStaffClockSnapshotWithRetry() {
    try {
      return await loadStaffClockSnapshot();
    } catch (error) {
      if (error?.staffClockStatus !== 409) throw error;
      return loadStaffClockSnapshot();
    }
  }

  async function refreshStaffClockSnapshot() {
    if (staffClockSnapshotPromise) {
      staffClockSnapshotRequested = true;
      return staffClockSnapshotPromise;
    }
    if (navigator.onLine === false) {
      setStaffClockAvailability(staffClockPeople.length ? 'ready' : 'unavailable');
      return null;
    }
    if (staffClockAuthorizationRecoveryInProgress) return null;
    if (loadStaffClockState().queue.length) {
      void syncStaffClockQueue();
      return null;
    }
    const requestedAtRevision = staffClockStateRevision;
    staffClockSnapshotPromise = (async () => {
      try {
        const payload = await loadStaffClockSnapshotWithRetry();
        if (!payload) {
          setStaffClockAvailability(staffClockPeople.length ? 'ready' : 'unavailable');
          return null;
        }
        if (staffClockStateRevision !== requestedAtRevision) {
          staffClockSnapshotRequested = true;
          return null;
        }

        const nextState = reconcileStaffClockSnapshotState(
          loadStaffClockState(),
          payload.baseline
        );
        if (!nextState) {
          setStaffClockAvailability(staffClockPeople.length ? 'ready' : 'unavailable');
          return null;
        }
        saveStaffClockState(nextState);
        saveStaffClockPeople(payload.staff);
        clearStaffClockPairingMemory();
        setStaffClockAvailability('ready');
        populateStaffClockPeople();
        renderStaffTimeAdmin();
        return payload;
      } catch (error) {
        if (IS_PRODUCTION_ORIGIN && error?.staffClockStatus === 401) {
          showStaffClockAuthorizationRequired();
        } else {
          setStaffClockAvailability(staffClockPeople.length ? 'ready' : 'unavailable');
        }
        return null;
      } finally {
        staffClockSnapshotPromise = null;
        if (staffClockSnapshotRequested) {
          staffClockSnapshotRequested = false;
          void refreshStaffClockSnapshot();
        }
      }
    })();
    return staffClockSnapshotPromise;
  }

  async function refreshStaffClockRosterAfterAuthorization() {
    try {
      const payload = await loadStaffClockSnapshotWithRetry();
      if (!payload) {
        setStaffClockAvailability('unavailable');
        return null;
      }
      const state = loadStaffClockState();
      if (!state.queue.length) {
        const nextState = reconcileStaffClockSnapshotState(state, payload.baseline);
        if (!nextState) {
          setStaffClockAvailability('unavailable');
          return null;
        }
        saveStaffClockState(nextState);
      }
      saveStaffClockPeople(payload.staff);
      clearStaffClockPairingMemory();
      // A pre-existing durable queue is preserved exactly. Keep actions locked
      // until the ordinary queue worker has delivered it and reconciled a later
      // server snapshot; authorization itself never posts business data.
      setStaffClockAvailability(state.queue.length ? 'loading' : 'ready');
      populateStaffClockPeople();
      renderStaffTimeAdmin();
      return payload;
    } catch (error) {
      if (IS_PRODUCTION_ORIGIN && error?.staffClockStatus === 401) {
        showStaffClockAuthorizationRequired();
      } else {
        // Authorization recovery is not complete until authoritative server
        // state is reconciled. A cached roster alone must never unlock punches.
        setStaffClockAvailability('unavailable');
      }
      return null;
    } finally {
      staffClockAuthorizationRecoveryInProgress = false;
    }
  }

  function acceptedStaffClockSyncIds(value, batch) {
    const expectedTarget = IS_PRODUCTION_ORIGIN ? 'production' : 'test';
    if (
      !value
      || typeof value !== 'object'
      || !exactStaffClockKeys(value, ['ok', 'target', 'results'])
      || value.ok !== true
      || value.target !== expectedTarget
      || !Array.isArray(value.results)
      || value.results.length !== batch.length
    ) {
      throw new Error('Staff Clock returned an incomplete confirmation.');
    }
    const batchIds = new Set(batch.map(record => record.punchId));
    const seen = new Set();
    const accepted = new Set();
    for (const result of value.results) {
      if (
        !result
        || typeof result !== 'object'
        || !exactStaffClockKeys(result, ['punchId', 'result', 'linkedPunchId'])
        || !batchIds.has(result.punchId)
        || seen.has(result.punchId)
        || !['added', 'already exists', 'needs attention', 'rejected', 'failed'].includes(result.result)
      ) {
        throw new Error('Staff Clock returned an ambiguous confirmation.');
      }
      seen.add(result.punchId);
      if (result.result === 'added' || result.result === 'already exists') {
        if (result.linkedPunchId !== result.punchId) {
          throw new Error('Staff Clock linked the wrong punch.');
        }
        accepted.add(result.punchId);
      } else if (result.linkedPunchId !== '') {
        throw new Error('Staff Clock linked an unaccepted punch.');
      }
    }
    if (seen.size !== batchIds.size) {
      throw new Error('Staff Clock did not confirm every submitted punch.');
    }
    return accepted;
  }

  function staffClockSyncPunch(record) {
    return {
      punchId: record.punchId,
      timestamp: record.timestamp,
      date: record.date,
      staffId: record.staffId,
      staffName: record.staffName,
      punchAction: record.punchAction,
      site: record.site,
      device: record.device,
      build: record.build,
      note: record.note
    };
  }

  async function syncStaffClockQueue() {
    if (staffClockSyncPromise) {
      staffClockSyncRequested = true;
      return staffClockSyncPromise;
    }
    if (
      staffClockAvailability === 'authorization-required'
      || staffClockAuthorizationRecoveryInProgress
    ) return null;
    if (navigator.onLine === false) return null;
    staffClockSyncPromise = (async () => {
      // Yield once so the promise lock is assigned before an empty startup run
      // can reach `finally` and clear it.
      await Promise.resolve();
      let acceptedAny = false;
      try {
        while (navigator.onLine !== false) {
          const before = loadStaffClockState();
          const batch = before.queue.slice(0, STAFF_SYNC_BATCH_SIZE);
          if (!batch.length) break;
          const response = await postStaffClock({
            operation: 'sync',
            punches: batch.map(staffClockSyncPunch)
          });
          const accepted = acceptedStaffClockSyncIds(response, batch);
          if (!accepted.size) break;
          acceptedAny = true;

          const latest = loadStaffClockState();
          const submitted = new Map(batch.map(record => [record.punchId, record]));
          const nextQueue = latest.queue.filter(record => {
            if (!accepted.has(record.punchId)) return true;
            const exactSubmitted = submitted.get(record.punchId);
            return !exactSubmitted || !sameStaffClockRecord(record, exactSubmitted);
          });
          saveStaffClockState({
            ...latest,
            queue: nextQueue
          });
          if (nextQueue.length !== latest.queue.length) staffClockStateRevision += 1;
          accepted.forEach(markStaffClockConfirmationConfirmed);
          renderStaffClock();
          renderStaffTimeAdmin();
        }
        if (acceptedAny && !loadStaffClockState().queue.length) {
          void refreshStaffClockSnapshot();
        }
      } catch (error) {
        // The exact queue remains durable. Lifecycle and timer retries are automatic.
        if (IS_PRODUCTION_ORIGIN && error?.staffClockStatus === 401) {
          showStaffClockAuthorizationRequired();
        } else {
          setStaffClockAvailability(staffClockPeople.length ? 'ready' : 'unavailable');
        }
      } finally {
        staffClockSyncPromise = null;
        if (staffClockSyncRequested) {
          staffClockSyncRequested = false;
          void syncStaffClockQueue();
        }
      }
      return null;
    })();
    return staffClockSyncPromise;
  }

  function dateKeyAsUtc(dateKey) {
    const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (!match) return NaN;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function utcAsDateKey(value) {
    const date = new Date(value);
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0')
    ].join('-');
  }

  function staffPayPeriodRange(referenceDate, offsetPeriods = 0) {
    const options = payPeriodOptions(referenceDate);
    const selected = offsetPeriods === -1 ? options.previous : options.current;
    const endExclusiveValue = dateKeyAsUtc(selected.endDate) + 86_400_000;
    return {
      start: selected.startDate,
      end: selected.endDate,
      endExclusive: utcAsDateKey(endExclusiveValue)
    };
  }

  function staffPeriodLabel(range) {
    const options = { timeZone: 'UTC', month: 'short', day: 'numeric' };
    const start = new Intl.DateTimeFormat('en-US', options)
      .format(new Date(dateKeyAsUtc(range.start)));
    const end = new Intl.DateTimeFormat('en-US', {
      ...options,
      year: 'numeric'
    }).format(new Date(dateKeyAsUtc(range.end)));
    return `${start}–${end}`;
  }

  function allKnownStaffClockPeople(state) {
    const byId = new Map(staffClockPeople.map(person => [person.staffId, person]));
    [...(state.baseline?.records || []), ...state.overlay].forEach(record => {
      if (!byId.has(record.staffId)) {
        byId.set(record.staffId, {
          staffId: record.staffId,
          staffName: record.staffName
        });
      }
    });
    const summary = state.baseline;
    if (summary) {
      const summarized = [
        ...summary.clockedInNow,
        ...summary.needsAttention,
        ...summary.periods.current.totals,
        ...summary.periods.previous.totals
      ];
      summarized.forEach(item => {
        if (!byId.has(item.staffId)) {
          byId.set(item.staffId, {
            staffId: item.staffId,
            staffName: item.staffName
          });
        }
      });
    }
    return [...byId.values()].sort((left, right) => (
      left.staffName.localeCompare(right.staffName)
    ));
  }

  function staffClockTotals(people, state, range) {
    return people.map(person => {
      const status = staffClockStatusFor(person.staffId, state);
      const shifts = status.completedShifts.filter(shift => (
        shift.date >= range.start
        && shift.date < range.endExclusive
      ));
      return {
        person,
        completedShifts: shifts.length,
        elapsedMs: shifts.reduce((sum, shift) => sum + shift.elapsedMilliseconds, 0),
        needsAttention: status.needsAttention
      };
    });
  }

  function staffClockPeriodRowsFromSummary(period, state, people) {
    const serverById = new Map(period.totals.map(total => [total.staffId, total]));
    if (!state.overlay.length) {
      return people
        .filter(person => serverById.has(person.staffId))
        .map(person => {
          const total = serverById.get(person.staffId);
          return {
            person,
            completedShifts: total.completedShifts,
            elapsedMs: total.totalSeconds * 1_000,
            needsAttention: total.needsAttention
          };
        });
    }

    const range = {
      start: period.startDate,
      end: period.endDate,
      endExclusive: utcAsDateKey(dateKeyAsUtc(period.endDate) + 86_400_000)
    };
    const baselineState = {
      version: STAFF_CLOCK_STATE_VERSION,
      baseline: state.baseline,
      overlay: [],
      queue: []
    };
    const baselineById = new Map(
      staffClockTotals(people, baselineState, range).map(total => [total.person.staffId, total])
    );
    const withOverlayById = new Map(
      staffClockTotals(people, state, range).map(total => [total.person.staffId, total])
    );
    return people.flatMap(person => {
      const server = serverById.get(person.staffId);
      const baseline = baselineById.get(person.staffId);
      const withOverlay = withOverlayById.get(person.staffId);
      const completedDelta = (withOverlay?.completedShifts || 0) - (baseline?.completedShifts || 0);
      const elapsedDelta = (withOverlay?.elapsedMs || 0) - (baseline?.elapsedMs || 0);
      const overlayAttention = Boolean(withOverlay?.needsAttention && !baseline?.needsAttention);
      if (!server && completedDelta === 0 && elapsedDelta === 0 && !overlayAttention) return [];
      return [{
        person,
        completedShifts: Math.max(0, (server?.completedShifts || 0) + completedDelta),
        elapsedMs: Math.max(0, ((server?.totalSeconds || 0) * 1_000) + elapsedDelta),
        needsAttention: Boolean(server?.needsAttention || overlayAttention)
      }];
    });
  }

  function staffClockOverlayPeriodRows(range, state, people) {
    return staffClockTotals(people, {
      version: STAFF_CLOCK_STATE_VERSION,
      baseline: null,
      overlay: state.overlay,
      queue: state.queue
    }, range);
  }

  function staffClockDisplayedPeriods(state, people, today) {
    const local = {
      current: staffPayPeriodRange(today),
      previous: staffPayPeriodRange(today, -1)
    };
    if (!state.baseline) {
      return {
        current: {
          range: local.current,
          rows: staffClockTotals(people, state, local.current)
        },
        previous: {
          range: local.previous,
          rows: staffClockTotals(people, state, local.previous)
        }
      };
    }

    const server = state.baseline.periods;
    const serverCurrentIsLocalCurrent = server.current.startDate === local.current.start
      && server.current.endDate === local.current.end;
    if (serverCurrentIsLocalCurrent) {
      return {
        current: {
          range: local.current,
          rows: staffClockPeriodRowsFromSummary(server.current, state, people)
        },
        previous: {
          range: local.previous,
          rows: staffClockPeriodRowsFromSummary(server.previous, state, people)
        }
      };
    }

    const serverCurrentIsLocalPrevious = server.current.startDate === local.previous.start
      && server.current.endDate === local.previous.end;
    if (serverCurrentIsLocalPrevious) {
      return {
        current: {
          range: local.current,
          rows: staffClockOverlayPeriodRows(local.current, state, people)
        },
        previous: {
          range: local.previous,
          rows: staffClockPeriodRowsFromSummary(server.current, state, people)
        }
      };
    }

    return {
      current: {
        range: local.current,
        rows: staffClockOverlayPeriodRows(local.current, state, people)
      },
      previous: {
        range: local.previous,
        rows: staffClockOverlayPeriodRows(local.previous, state, people)
      }
    };
  }

  function staffClockAdminView(state, people, now = new Date()) {
    const today = fmtDate(now);
    const statuses = people.map(person => staffClockStatusFor(person.staffId, state, now));
    const clockedInNow = statuses
      .filter(status => status.clockedIn)
      .map(status => ({
        staffId: status.staffId,
        staffName: status.staffName,
        clockInAt: status.clockInRecord.timestamp
      }));

    const todayById = new Map((state.baseline?.records || [])
      .filter(record => record.date === today)
      .map(record => [record.punchId, record]));
    state.overlay.forEach(record => {
      if (record.date === today) todayById.set(record.punchId, record);
    });
    const todayPunches = [...todayById.values()]
      .filter(record => record.status === 'ACTIVE')
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

    const needsAttention = (state.baseline?.needsAttention || []).map(item => ({ ...item }));
    const identities = new Set(needsAttention.map(item => `${item.staffId}\u0000${item.code}`));
    statuses.forEach(status => {
      if ((state.baseline?.needsAttention || []).some(item => item.staffId === status.staffId)) return;
      status.attention.forEach(item => {
        const code = String(item.code || '').toLowerCase();
        const identity = `${status.staffId}\u0000${code}`;
        if (identities.has(identity)) return;
        identities.add(identity);
        needsAttention.push({
          staffId: status.staffId,
          staffName: status.staffName,
          code,
          message: item.message || code.replaceAll('_', ' '),
          linkedPunchIds: item.punchId ? [item.punchId] : [],
          occurrenceCount: 1
        });
      });
    });
    return {
      today,
      clockedInNow,
      todayPunches,
      needsAttention,
      truncation: state.baseline?.view.recordsTruncated
        ? state.baseline.view
        : null
    };
  }

  function makeStaffTimeTextRow(text, className = '') {
    const row = document.createElement('div');
    if (className) row.className = className;
    row.textContent = text;
    return row;
  }

  function renderStaffTimeAdmin() {
    const slot = $('#staffTimeSlot');
    if (!slot) return;
    const state = loadStaffClockState();
    const people = allKnownStaffClockPeople(state);
    const today = fmtDate(new Date());
    const adminView = staffClockAdminView(state, people);
    const peopleById = new Map(people.map(person => [person.staffId, person]));
    const active = adminView.clockedInNow.map(item => ({
      person: peopleById.get(item.staffId) || {
        staffId: item.staffId,
        staffName: item.staffName
      },
      clockInAt: item.clockInAt
    }));
    const attention = adminView.needsAttention.map(item => ({
        person: peopleById.get(item.staffId) || {
          staffId: item.staffId,
          staffName: item.staffName
        },
        message: item.occurrenceCount > 1
          ? `${item.message} · ${item.occurrenceCount} items`
          : item.message
      }));
    const todayPunches = adminView.todayPunches;

    slot.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'staff-time-admin-grid';

    const activeBlock = document.createElement('section');
    activeBlock.className = 'staff-time-block';
    const activeHeading = document.createElement('h3');
    activeHeading.textContent = 'Clocked in now';
    const activeList = document.createElement('div');
    activeList.className = 'staff-time-list';
    if (!active.length) {
      activeList.appendChild(makeStaffTimeTextRow('No one is clocked in.'));
    } else {
      active.forEach(item => {
        activeList.appendChild(makeStaffTimeTextRow(
          `${item.person.staffName} · since ${formatStaffClockTime(item.clockInAt)}`
        ));
      });
    }
    activeBlock.append(activeHeading, activeList);

    const punchesBlock = document.createElement('section');
    punchesBlock.className = 'staff-time-block';
    const punchesHeading = document.createElement('h3');
    punchesHeading.textContent = 'Today’s punches';
    const punchesList = document.createElement('div');
    punchesList.className = 'staff-time-list staff-time-punches';
    if (!todayPunches.length) {
      punchesList.appendChild(makeStaffTimeTextRow('No staff punches yet today.'));
    } else {
      todayPunches.forEach(punch => {
        punchesList.appendChild(makeStaffTimeTextRow(
          `${punch.staffName} · ${punch.punchAction === 'clockIn' ? 'Clock In' : 'Clock Out'} · ${formatStaffClockTime(punch.timestamp)}${state.queue.some(waiting => waiting.punchId === punch.punchId) ? ' · waiting to sync' : ''}`
        ));
      });
    }
    if (adminView.truncation) {
      punchesList.appendChild(makeStaffTimeTextRow(
        `Showing ${adminView.truncation.recordCount} of ${adminView.truncation.recordTotal} relevant records (${adminView.truncation.todayPunchCount} of ${adminView.truncation.todayPunchTotal} today). Current status and pay-period totals are complete.`,
        'staff-time-empty'
      ));
    }
    punchesBlock.append(punchesHeading, punchesList);
    grid.append(activeBlock, punchesBlock);
    slot.appendChild(grid);

    if (attention.length) {
      const attentionBlock = document.createElement('section');
      attentionBlock.className = 'staff-time-attention';
      const heading = document.createElement('h3');
      heading.textContent = 'Needs attention';
      const list = document.createElement('div');
      list.className = 'staff-time-list';
      attention.forEach(item => {
        list.appendChild(makeStaffTimeTextRow(
          `${item.person.staffName} · ${item.message}`
        ));
      });
      attentionBlock.append(heading, list);
      slot.appendChild(attentionBlock);
    }

    const totals = document.createElement('details');
    totals.className = 'staff-time-totals';
    const totalsSummary = document.createElement('summary');
    totalsSummary.textContent = 'Pay-period totals';
    const controls = document.createElement('div');
    controls.className = 'staff-time-total-controls';
    const displayedPeriods = staffClockDisplayedPeriods(state, people, today);
    ['current', 'previous'].forEach(key => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn small';
      button.dataset.staffPeriod = key;
      button.setAttribute('aria-pressed', String(staffClockTotalsSelection === key));
      button.textContent = key === 'current' ? 'Current pay period' : 'Previous pay period';
      button.addEventListener('click', () => {
        staffClockTotalsSelection = key;
        renderStaffTimeAdmin();
        const nextTotals = $('#staffTimeSlot .staff-time-totals');
        if (nextTotals) nextTotals.open = true;
      });
      controls.appendChild(button);
    });
    const chosenPeriod = displayedPeriods[staffClockTotalsSelection]
      || displayedPeriods.current;
    const periodLabel = makeStaffTimeTextRow(
      staffPeriodLabel(chosenPeriod.range),
      'staff-time-empty'
    );
    const totalsList = document.createElement('div');
    totalsList.className = 'staff-time-list';
    const rows = chosenPeriod.rows;
    if (!rows.length) {
      totalsList.appendChild(makeStaffTimeTextRow('No staff hours in this pay period.'));
    } else {
      rows.forEach(item => {
        const row = document.createElement('div');
        row.className = 'staff-time-total-row';
        const name = document.createElement('span');
        name.textContent = item.person.staffName;
        const value = document.createElement('span');
        value.textContent = `${item.completedShifts} shift${item.completedShifts === 1 ? '' : 's'} · ${formatStaffElapsed(item.elapsedMs)}${item.needsAttention ? ' · Needs attention' : ''}`;
        row.append(name, value);
        totalsList.appendChild(row);
      });
    }
    totals.append(totalsSummary, controls, periodLabel, totalsList);
    slot.appendChild(totals);

    const correction = document.createElement('a');
    correction.className = 'btn small secondary staff-time-placeholder';
    correction.href = '/m1/admin/#staff-time';
    correction.textContent = 'Fix missed punch';
    slot.appendChild(correction);
  }

function refreshStaffAdminWhenVisible() {
  const admin = $('#admin');
  if (!admin || admin.style.display === 'none') return;
  renderStaffTimeAdmin();
  void refreshStaffClockSnapshot();
}

function initializeStaffClockClient() {
  $('#staffClockName')?.addEventListener('change', renderStaffClock);
  $('#btnStaffClockAction')?.addEventListener('click', performStaffClockAction);
  $('#btnStaffClockDone')?.addEventListener('click', resetStaffClockCard);
  $('#retryStaffClock')?.addEventListener('click', () => {
    if (
      staffClockAvailability === 'authorization-required'
      && STAFF_CLOCK_PAIRING_AVAILABLE
    ) {
      clearStaffClockPairingTimer();
      if (staffClockPairingStillCurrent()) {
        renderStaffClockPairingPending('Retrying tablet pairing…');
        void runStaffClockPairing('poll');
      } else {
        restartStaffClockPairing();
      }
      return;
    }
    setStaffClockAvailability('loading');
    void refreshStaffClockSnapshot();
  });
  $('#cancelStaffClockPairing')?.addEventListener('click', () => {
    void cancelStaffClockPairing();
  });

  const admin = $('#admin');
  if (admin && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(refreshStaffAdminWhenVisible);
    observer.observe(admin, {
      attributes: true,
      attributeFilter: ['style']
    });
  }

  staffClockPeople = loadStaffClockPeople();
  setStaffClockAvailability(
    staffClockPeople.length && (!IS_PRODUCTION_ORIGIN || navigator.onLine === false)
      ? 'ready'
      : 'loading'
  );
  populateStaffClockPeople();
  renderStaffTimeAdmin();
  void refreshStaffClockSnapshot();
  void syncStaffClockQueue();

  window.setInterval(() => {
    void syncStaffClockQueue();
  }, STAFF_CLOCK_RETRY_INTERVAL_MS);
  window.addEventListener('online', () => {
    if (staffClockAvailability === 'authorization-required') {
      resumeStaffClockPairing();
      return;
    }
    void refreshStaffClockSnapshot();
    void syncStaffClockQueue();
  });
  ['focus', 'pageshow'].forEach(eventName => {
    window.addEventListener(eventName, () => {
      if (staffClockAvailability === 'authorization-required') {
        resumeStaffClockPairing();
        return;
      }
      void refreshStaffClockSnapshot();
      void syncStaffClockQueue();
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (staffClockAvailability === 'authorization-required') {
        resumeStaffClockPairing();
        return;
      }
      void refreshStaffClockSnapshot();
      void syncStaffClockQueue();
    }
  });
  refreshStaffAdminWhenVisible();
}

if (
  globalThis.M1_INSTALLATION_PROFILE_VALID === true
  && installationProfile?.schema === 'gib-m1-installation-profile/v1'
  && typeof installationProfile.installationId === 'string'
  && installationProfile.installationId.length > 0
  && typeof installationProfile.siteCode === 'string'
  && installationProfile.siteCode.length > 0
  && installationProfile.featureFlags?.staffClock === true
  && installationProfile.backend?.enabled === true
  && typeof installationProfile.backend?.transportTarget === 'string'
  && installationProfile.backend.transportTarget.length > 0
) {
  initializeStaffClockClient();
}
