import {
  buildStaffReview,
  createStaffPunchId,
  evaluateStaffState,
  formatStaffElapsed,
  mergeStaffRecords,
  payPeriodOptions,
  sameStaffRecord,
  validStaffMember,
  validStaffRecord
} from './staff-clock-core.mjs?v=2026-08-19-m1b-staff-clock-production-r1';

const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';
const IS_PRODUCTION_ORIGIN = location.origin === PRODUCTION_ORIGIN;
const TZ = 'America/New_York';
const BUILD = document.getElementById('buildId')?.textContent?.trim() || '';
const STAFF_CLOCK_STATE_KEY = 'gib_m1b_staff_clock_state_v1';
const STAFF_CLOCK_STAFF_CACHE_KEY = 'gib_m1b_staff_clock_staff_v1';
const STAFF_CLOCK_ENDPOINT = '/api/m1-staff-clock';
const STAFF_CLOCK_RETRY_INTERVAL_MS = 30_000;
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
    'linkedPunchId'
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
  let staffClockTotalsSelection = 'current';

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
    return { version: 1, ledger: [], queue: [] };
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
      linkedPunchId: String(value.linkedPunchId || '')
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

  function loadStaffClockState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STAFF_CLOCK_STATE_KEY) || 'null');
      if (
        !parsed
        || parsed.version !== 1
        || !Array.isArray(parsed.ledger)
        || !Array.isArray(parsed.queue)
      ) {
        return blankStaffClockState();
      }
      const ledger = parsed.ledger.map(normalizeStaffClockRecord);
      const queue = parsed.queue.map(normalizeStaffClockRecord);
      if (ledger.some(record => !record) || queue.some(record => !record)) {
        return blankStaffClockState();
      }
      const ledgerById = new Map();
      for (const record of ledger) {
        const existing = ledgerById.get(record.punchId);
        if (existing && !sameStaffClockRecord(existing, record)) return blankStaffClockState();
        ledgerById.set(record.punchId, record);
      }
      for (const record of queue) {
        const ledgerRecord = ledgerById.get(record.punchId);
        if (!ledgerRecord || !sameStaffClockRecord(ledgerRecord, record)) {
          return blankStaffClockState();
        }
      }
      return { version: 1, ledger, queue };
    } catch {
      return blankStaffClockState();
    }
  }

  function saveStaffClockState(state) {
    if (
      !state
      || state.version !== 1
      || !Array.isArray(state.ledger)
      || !Array.isArray(state.queue)
      || state.ledger.some(record => !normalizeStaffClockRecord(record))
      || state.queue.some(record => !normalizeStaffClockRecord(record))
    ) {
      throw new Error('Staff Clock state is invalid.');
    }
    const ledgerById = new Map(state.ledger.map(record => [record.punchId, record]));
    if (state.queue.some(record => (
      !ledgerById.has(record.punchId)
      || !sameStaffClockRecord(ledgerById.get(record.punchId), record)
    ))) {
      throw new Error('Staff Clock waiting state is invalid.');
    }
    localStorage.setItem(STAFF_CLOCK_STATE_KEY, JSON.stringify({
      version: 1,
      ledger: state.ledger,
      queue: state.queue
    }));
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
    return mergeStaffRecords(state.ledger, state.queue);
  }

  function staffClockStatusFor(staffId, state = loadStaffClockState(), now = new Date()) {
    const merged = combinedStaffClockRecords(state);
    return evaluateStaffState(staffId, merged.records, {
      now,
      attention: merged.attention
    });
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
    if (staffClockActionLocked || staffClockConfirmationActive) return;
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
        site: IS_PRODUCTION_ORIGIN ? 'Rev' : 'Rev TEST',
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
        version: 1,
        ledger: [...state.ledger, punch],
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
    $('#staffClockControls').hidden = false;
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
        throw new Error('Staff Clock was not confirmed.');
      }
      return await response.json();
    } finally {
      if (timeout != null) window.clearTimeout(timeout);
    }
  }

  function validatedStaffClockSnapshot(value) {
    const expectedTarget = IS_PRODUCTION_ORIGIN ? 'production' : 'test';
    if (
      !value
      || typeof value !== 'object'
      || !exactStaffClockKeys(value, ['ok', 'target', 'staff', 'records'])
      || value.ok !== true
      || value.target !== expectedTarget
      || !Array.isArray(value.staff)
      || !Array.isArray(value.records)
    ) return null;
    const staff = value.staff.map(normalizeStaffClockPerson);
    const records = value.records.map(normalizeStaffClockRecord);
    if (!staff.length || staff.some(person => !person) || records.some(record => !record)) {
      return null;
    }
    const ids = new Set(staff.map(person => person.staffId));
    const names = new Set(staff.map(person => person.staffName.toLocaleLowerCase('en-US')));
    const recordIds = new Set(records.map(record => record.punchId));
    if (
      ids.size !== staff.length
      || names.size !== staff.length
      || recordIds.size !== records.length
    ) return null;
    return { staff, records };
  }

  async function refreshStaffClockSnapshot() {
    if (staffClockSnapshotPromise) return staffClockSnapshotPromise;
    if (navigator.onLine === false) return null;
    staffClockSnapshotPromise = (async () => {
      try {
        const payload = validatedStaffClockSnapshot(
          await postStaffClock({ operation: 'snapshot' })
        );
        if (!payload) return null;

        const state = loadStaffClockState();
        const queueIds = new Set(state.queue.map(record => record.punchId));
        const nextById = new Map(state.ledger.map(record => [record.punchId, record]));
        for (const record of payload.records) {
          const existing = nextById.get(record.punchId);
          if (
            existing
            && queueIds.has(record.punchId)
            && !sameStaffClockRecord(existing, record)
          ) {
            return null;
          }
          nextById.set(record.punchId, record);
        }
        saveStaffClockState({
          version: 1,
          ledger: [...nextById.values()],
          queue: state.queue
        });
        saveStaffClockPeople(payload.staff);
        populateStaffClockPeople();
        renderStaffTimeAdmin();
        return payload;
      } catch {
        return null;
      } finally {
        staffClockSnapshotPromise = null;
      }
    })();
    return staffClockSnapshotPromise;
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
    if (navigator.onLine === false) return null;
    staffClockSyncPromise = (async () => {
      // Yield once so the promise lock is assigned before an empty startup run
      // can reach `finally` and clear it.
      await Promise.resolve();
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

          const latest = loadStaffClockState();
          const submitted = new Map(batch.map(record => [record.punchId, record]));
          const nextQueue = latest.queue.filter(record => {
            if (!accepted.has(record.punchId)) return true;
            const exactSubmitted = submitted.get(record.punchId);
            return !exactSubmitted || !sameStaffClockRecord(record, exactSubmitted);
          });
          saveStaffClockState({
            version: 1,
            ledger: latest.ledger,
            queue: nextQueue
          });
          accepted.forEach(markStaffClockConfirmationConfirmed);
          renderStaffClock();
          renderStaffTimeAdmin();
        }
        void refreshStaffClockSnapshot();
      } catch {
        // The exact queue remains durable. Lifecycle and timer retries are automatic.
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
    state.ledger.forEach(record => {
      if (!byId.has(record.staffId)) {
        byId.set(record.staffId, {
          staffId: record.staffId,
          staffName: record.staffName
        });
      }
    });
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
    const review = buildStaffReview({
      confirmedRecords: state.ledger,
      pendingRecords: state.queue,
      staffMembers: people,
      now: new Date()
    });
    const peopleById = new Map(people.map(person => [person.staffId, person]));
    const active = review.clockedInNow.map(status => ({
      person: peopleById.get(status.staffId) || {
        staffId: status.staffId,
        staffName: status.staffName
      },
      status
    }));
    const attention = review.staffStates
      .filter(status => status.needsAttention)
      .map(status => ({
        person: peopleById.get(status.staffId) || {
          staffId: status.staffId,
          staffName: status.staffName
        },
        message: status.attention
          .map(item => item.code.replaceAll('_', ' ').toLowerCase())
          .join('; ')
      }));
    const todayPunches = review.todayPunches.filter(record => record.status === 'ACTIVE');

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
          `${item.person.staffName} · since ${formatStaffClockTime(item.status.clockInRecord.timestamp)}`
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
    const ranges = {
      current: staffPayPeriodRange(today),
      previous: staffPayPeriodRange(today, -1)
    };
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
    const chosenRange = ranges[staffClockTotalsSelection] || ranges.current;
    const periodLabel = makeStaffTimeTextRow(staffPeriodLabel(chosenRange), 'staff-time-empty');
    const totalsList = document.createElement('div');
    totalsList.className = 'staff-time-list';
    const rows = staffClockTotals(people, state, chosenRange);
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

  const admin = $('#admin');
  if (admin && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(refreshStaffAdminWhenVisible);
    observer.observe(admin, {
      attributes: true,
      attributeFilter: ['style']
    });
  }

  staffClockPeople = loadStaffClockPeople();
  populateStaffClockPeople();
  renderStaffTimeAdmin();
  void refreshStaffClockSnapshot();
  void syncStaffClockQueue();

  window.setInterval(() => {
    void syncStaffClockQueue();
  }, STAFF_CLOCK_RETRY_INTERVAL_MS);
  window.addEventListener('online', () => {
    void refreshStaffClockSnapshot();
    void syncStaffClockQueue();
  });
  ['focus', 'pageshow'].forEach(eventName => {
    window.addEventListener(eventName, () => {
      void refreshStaffClockSnapshot();
      void syncStaffClockQueue();
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void refreshStaffClockSnapshot();
      void syncStaffClockQueue();
    }
  });
  refreshStaffAdminWhenVisible();
}

initializeStaffClockClient();
