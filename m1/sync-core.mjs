const ACCEPTED_RESULTS = Object.freeze(new Set([
  'added',
  'already exists',
  'review required'
]));

const KNOWN_RESULTS = Object.freeze(new Set([
  ...ACCEPTED_RESULTS,
  'rejected',
  'failed'
]));

const TRANSPORT_FIELDS = Object.freeze([
  'RowID',
  'Timestamp',
  'Date',
  'Class Label',
  'Duration (hr)',
  'Instructor',
  'Site',
  'Device',
  'Build',
  'Notes'
]);

const ROW_ID_PATTERN = /^gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const NEW_YORK_TIME_ZONE = 'America/New_York';
export const DAY_ROLLOVER_CHECK_INTERVAL_MS = 60_000;

function padTwoDigits(value) {
  return String(value).padStart(2, '0');
}

export function formatDateInTimeZone(date, timeZone = NEW_YORK_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function formatTimestampInTimeZone(date, timeZone = NEW_YORK_TIME_ZONE) {
  const day = formatDateInTimeZone(date, timeZone);
  const hour = padTwoDigits(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false
  }).format(date));
  const minute = padTwoDigits(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    minute: '2-digit'
  }).format(date));
  const second = padTwoDigits(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    second: '2-digit'
  }).format(date));
  return `${day} ${hour}:${minute}:${second}`;
}

export function createDayRolloverController(options = {}) {
  const {
    getDateKey,
    isFormInProgress,
    updateDisplayedDay,
    replaceClasses,
    schedule = globalThis.setInterval,
    cancelSchedule = globalThis.clearInterval,
    documentTarget = globalThis.document,
    windowTarget = globalThis.window
  } = options;

  if (
    typeof getDateKey !== 'function'
    || typeof isFormInProgress !== 'function'
    || typeof updateDisplayedDay !== 'function'
    || typeof replaceClasses !== 'function'
    || typeof schedule !== 'function'
    || typeof cancelSchedule !== 'function'
    || !documentTarget
    || !windowTarget
  ) {
    throw new Error('Day rollover dependencies were not available.');
  }

  let renderedDate = getDateKey();
  let displayedDate = renderedDate;
  let pendingDate = '';
  let intervalId = null;
  let started = false;

  function refresh(currentDate, requested = false) {
    const changed = currentDate !== renderedDate;
    if (!currentDate || (!requested && !changed && !pendingDate)) {
      return Object.freeze({ changed: false, deferred: false });
    }

    if (currentDate !== displayedDate) {
      updateDisplayedDay(currentDate);
      displayedDate = currentDate;
    }
    if (isFormInProgress()) {
      pendingDate = currentDate;
      return Object.freeze({ changed, deferred: true });
    }

    replaceClasses(currentDate);
    renderedDate = currentDate;
    pendingDate = '';
    return Object.freeze({ changed, deferred: false });
  }

  function checkNow() {
    return refresh(getDateKey());
  }

  function requestRefresh() {
    return refresh(getDateKey(), true);
  }

  function flushPending() {
    if (!pendingDate) return Object.freeze({ changed: false, deferred: false });
    return checkNow();
  }

  function onVisibilityChange() {
    if (documentTarget.visibilityState === 'visible') checkNow();
  }

  function start() {
    if (started) return;
    started = true;
    intervalId = schedule(checkNow, DAY_ROLLOVER_CHECK_INTERVAL_MS);
    documentTarget.addEventListener('visibilitychange', onVisibilityChange);
    documentTarget.addEventListener('resume', checkNow);
    windowTarget.addEventListener('focus', checkNow);
    windowTarget.addEventListener('pageshow', checkNow);
  }

  function stop() {
    if (!started) return;
    started = false;
    if (intervalId != null) cancelSchedule(intervalId);
    intervalId = null;
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
    documentTarget.removeEventListener('resume', checkNow);
    windowTarget.removeEventListener('focus', checkNow);
    windowTarget.removeEventListener('pageshow', checkNow);
  }

  function snapshot() {
    return Object.freeze({ renderedDate, pendingDate, started });
  }

  return Object.freeze({ checkNow, flushPending, requestRefresh, snapshot, start, stop });
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

export function validPermanentRowId(value) {
  return typeof value === 'string' && ROW_ID_PATTERN.test(value);
}

export function createPermanentRowId(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
    throw new Error('Secure row identity is unavailable.');
  }
  const uuid = cryptoApi.randomUUID().toLowerCase();
  const rowId = `gib-m1-${uuid}`;
  if (!validPermanentRowId(rowId)) {
    throw new Error('Secure row identity could not be created.');
  }
  return rowId;
}

export function transportRow(value) {
  const row = {};
  for (const key of TRANSPORT_FIELDS) row[key] = value && value[key];
  return row;
}

export async function requestAcknowledgements(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length < 1) {
    throw new Error('There are no rows to submit.');
  }
  if (options.online === false) throw new Error('The device is offline.');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Sync transport is unavailable.');
  const productionOrigin = options.productionOrigin === true;
  let response;
  try { response = await fetchImpl(SYNC_ENDPOINT, {
    method: 'POST',
    credentials: productionOrigin ? 'same-origin' : 'omit',
    ...(productionOrigin ? { mode: 'same-origin', redirect: 'error' } : {}),
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.richmondDiagnostics === true ? { 'X-GIB-M1-Sync-Diagnostic': 'v1' } : {})
    },
    body: JSON.stringify({ rows: rows.map(transportRow) }),
    signal: options.signal
  }); } catch (error) {
    throw syncError(options.signal?.aborted ? 'TABLET_REQUEST_TIMEOUT' : 'TABLET_SERVICE_UNREACHABLE');
  }
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    const reported = options.richmondDiagnostics === true && [502, 504].includes(response?.status)
      ? response?.headers?.get('X-GIB-M1-Sync-Code') : '';
    const code = typeof reported === 'string' && reported.startsWith('SHEET_')
      && Object.hasOwn(SYNC_EVENT_MESSAGES, reported) ? reported
      : ({ 401: 'TABLET_NOT_AUTHORIZED', 403: 'SERVICE_REFUSED', 429: 'RATE_LIMITED' })[response?.status]
        || 'SERVICE_UNAVAILABLE';
    throw syncError(code);
  }
  try { return await response.json(); }
  catch { throw syncError(options.signal?.aborted ? 'TABLET_REQUEST_TIMEOUT' : 'INVALID_ACK'); }
}

export const RICHMOND_SYNC_HISTORY_KEY = 'gib_m1_richmond_production_sync_history_v1';
export const SYNC_EVENT_MESSAGES = Object.freeze({
  UPLOAD_CONFIRMED: 'Sheet confirmed the upload',
  ACTIVATION_CONFIRMED: 'Sending authorization confirmed',
  ACTIVATION_UNCONFIRMED: 'Sending authorization check did not pass',
  OFFLINE: 'Tablet reported no internet connection',
  TABLET_SERVICE_UNREACHABLE: 'Tablet could not get a response from the sign-in service',
  TABLET_REQUEST_TIMEOUT: 'Tablet request timed out',
  TABLET_NOT_AUTHORIZED: 'Service did not accept tablet authorization',
  SERVICE_REFUSED: 'Service refused the upload',
  SERVICE_UNAVAILABLE: 'Service returned an unsuccessful response',
  RATE_LIMITED: 'Service asked the tablet to wait',
  INVALID_ACK: 'Upload reply was incomplete or invalid',
  ROWS_UNCONFIRMED: 'Sheet did not accept every submitted sign-in',
  LOCAL_SAVE_FAILED: 'Tablet could not finish saving the upload result',
  SHEET_TIMEOUT_OR_NETWORK: 'Service could not reach Google or Google timed out',
  SHEET_HTML_RESPONSE: 'Google returned a web page instead of an upload reply',
  SHEET_HTTP_FAILURE: 'Google returned an HTTP error to the service',
  SHEET_EMPTY_RESPONSE: 'Google returned an empty upload reply',
  SHEET_INCOMPLETE_RESPONSE: 'Google upload reply did not finish',
  SHEET_INVALID_RESPONSE: 'Google upload reply was invalid',
  SHEET_RECEIVER_REJECTED: 'Google receiver rejected the upload',
  SHEET_CONTRACT_MISMATCH: 'Google reply did not match the required confirmation',
  SHEET_WRITES_DISABLED: 'Google receiver reports sending is disabled',
  SERVER_WRITES_DISABLED: 'Sign-in service reports sending is disabled'
});

function syncError(code) {
  const error = new Error('The sync service did not confirm the request.');
  error.syncCode = code;
  return error;
}

export function syncFailureCode(error, fallback = 'INVALID_ACK') {
  return Object.hasOwn(SYNC_EVENT_MESSAGES, error?.syncCode) ? error.syncCode : fallback;
}

export function activationFailureCode(response, payload) {
  if (payload?.authorized === false) return 'TABLET_NOT_AUTHORIZED';
  const code = payload?.authorized === true ? response?.headers?.get('X-GIB-M1-Check-Code') : '';
  if (code === 'SERVER_WRITES_DISABLED') return code;
  const mapped = `SHEET_${code}`;
  return code && Object.hasOwn(SYNC_EVENT_MESSAGES, mapped) ? mapped : 'ACTIVATION_UNCONFIRMED';
}

export function readRichmondSyncHistory(storage) {
  try {
    const raw = storage.getItem(RICHMOND_SYNC_HISTORY_KEY);
    if (!raw || raw.length > 20_000) return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.slice(-20).filter(entry => entry && Object.hasOwn(SYNC_EVENT_MESSAGES, entry.code)
      && ['upload', 'activation'].includes(entry.stage)
      && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at))
      && typeof entry.firstAt === 'string' && Number.isFinite(Date.parse(entry.firstAt))
      && Number.isSafeInteger(entry.waiting) && entry.waiting >= 0
      && Number.isSafeInteger(entry.attempts) && entry.attempts > 0)
      .map(entry => ({ at: new Date(entry.at).toISOString(), firstAt: new Date(entry.firstAt).toISOString(),
        code: entry.code, stage: entry.stage, waiting: entry.waiting, attempts: entry.attempts }));
  } catch { return []; }
}

export function recordRichmondSyncEvent(storage, event, at = new Date().toISOString()) {
  // Best-effort, bounded, counts-only history. Never interfere with payroll
  // persistence or store raw responses, names, RowIDs, URLs, or credentials.
  if (!Object.hasOwn(SYNC_EVENT_MESSAGES, event?.code)
    || !['upload', 'activation'].includes(event?.stage)
    || !Number.isSafeInteger(event?.waiting) || event.waiting < 0
    || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return false;
  try {
    const entries = readRichmondSyncHistory(storage);
    const last = entries[entries.length - 1];
    const same = last?.code === event.code && last.stage === event.stage && last.waiting === event.waiting;
    const entry = { at: new Date(at).toISOString(), firstAt: same ? last.firstAt : new Date(at).toISOString(),
      stage: event.stage, code: event.code, waiting: event.waiting,
      attempts: same ? Math.min(last.attempts + 1, 1_000_000) : 1 };
    if (same) entries.pop();
    storage.setItem(RICHMOND_SYNC_HISTORY_KEY, JSON.stringify([...entries, entry].slice(-20)));
    return true;
  } catch { return false; }
}

export function kioskDeliveryText({ waiting, last, automatic, error = '', sending = false }) {
  if (!Number.isSafeInteger(waiting) || waiting < 0) return 'Sending status unavailable';
  if (waiting > 0) {
    const saved = `${waiting} sign-in${waiting === 1 ? '' : 's'} saved on this tablet`;
    if (!automatic) return `${saved} · automatic sending is off`;
    if (sending) return `${saved} · sending…`;
    if (error) return `${saved} · waiting to send; will retry automatically`;
    return `${saved} · waiting to send`;
  }
  if (!automatic) return 'Automatic sending is off';
  return last && Number.isFinite(Date.parse(last))
    ? 'All saved sign-ins sent to the sheet'
    : 'Sign-ins save on this tablet and send automatically';
}

export function blankLocalState() {
  return { version: 2, ledger: [], queue: [] };
}

export function validLocalState(value) {
  return Boolean(value)
    && value.version === 2
    && Array.isArray(value.ledger)
    && Array.isArray(value.queue);
}

export function appendBatchToState(state, ledgerRows, queueRows) {
  if (
    !validLocalState(state)
    || !Array.isArray(ledgerRows)
    || !Array.isArray(queueRows)
    || ledgerRows.length < 1
    || ledgerRows.length !== queueRows.length
  ) {
    throw new Error('The sign-in batch was not valid.');
  }

  const existingIds = new Set([
    ...state.ledger.map(row => row && row.RowID),
    ...state.queue.map(row => row && row.RowID)
  ].filter(Boolean));
  const batchIds = new Set();

  for (let index = 0; index < ledgerRows.length; index += 1) {
    const ledgerId = ledgerRows[index] && ledgerRows[index].RowID;
    const queueId = queueRows[index] && queueRows[index].RowID;
    if (
      !validPermanentRowId(ledgerId)
      || ledgerId !== queueId
      || existingIds.has(ledgerId)
      || batchIds.has(ledgerId)
    ) {
      throw new Error('The sign-in batch did not have unique permanent row identities.');
    }
    batchIds.add(ledgerId);
  }

  return {
    version: 2,
    ledger: [...state.ledger, ...ledgerRows],
    queue: [...state.queue, ...queueRows]
  };
}

export function removeBatchFromState(state, batchId) {
  if (!validLocalState(state) || !batchId) return state;
  const removedIds = new Set(
    state.ledger
      .filter(row => row && row.__batchId === batchId)
      .map(row => row.RowID)
      .filter(Boolean)
  );
  return {
    version: 2,
    ledger: state.ledger.filter(row => row && row.__batchId !== batchId),
    queue: state.queue.filter(row => {
      return row && row.__batchId !== batchId && !removedIds.has(row.RowID);
    })
  };
}

function validResult(value) {
  return exactKeys(value, ['rowId', 'result', 'linkedRecordId'])
    && validPermanentRowId(value.rowId)
    && KNOWN_RESULTS.has(value.result)
    && typeof value.linkedRecordId === 'string'
    && value.linkedRecordId.length <= 240;
}

export function evaluateAcknowledgements(submittedRows, payload, options = {}) {
  const submitted = Array.isArray(submittedRows) ? submittedRows : [];
  const submittedIds = submitted.map(row => row && row.RowID);
  const uniqueSubmittedIds = new Set(submittedIds);
  const productionOrigin = options.productionOrigin === true;
  const envelopeKeys = productionOrigin
    ? ['ok', 'production', 'results']
    : ['ok', 'test', 'results'];
  const unreadable = {
    readable: false,
    confirmedRowIds: [],
    results: []
  };

  if (
    submittedIds.length < 1
    || uniqueSubmittedIds.size !== submittedIds.length
    || submittedIds.some(rowId => !validPermanentRowId(rowId))
    || !exactKeys(payload, envelopeKeys)
    || payload.ok !== true
    || (productionOrigin ? payload.production !== true : payload.test !== true)
    || !Array.isArray(payload.results)
    || payload.results.length !== submittedIds.length
    || payload.results.some(result => !validResult(result))
  ) {
    return unreadable;
  }

  const resultIds = payload.results.map(result => result.rowId);
  if (
    new Set(resultIds).size !== resultIds.length
    || resultIds.some(rowId => !uniqueSubmittedIds.has(rowId))
    || submittedIds.some(rowId => !resultIds.includes(rowId))
  ) {
    return unreadable;
  }

  const confirmedRowIds = payload.results
    .filter(result => {
      if (!ACCEPTED_RESULTS.has(result.result) || !result.linkedRecordId) return false;
      return result.result !== 'added' || result.linkedRecordId === result.rowId;
    })
    .map(result => result.rowId);

  return {
    readable: true,
    confirmedRowIds,
    results: payload.results.map(result => ({ ...result }))
  };
}

export function applyAcknowledgements(state, submittedRows, payload, acknowledgedAt, options = {}) {
  if (!validLocalState(state)) throw new Error('The local sign-in state was not valid.');
  const evaluation = evaluateAcknowledgements(submittedRows, payload, options);
  if (!evaluation.readable || evaluation.confirmedRowIds.length === 0) {
    return { state, ...evaluation };
  }

  const confirmed = new Set(evaluation.confirmedRowIds);
  const resultById = new Map(evaluation.results.map(result => [result.rowId, result.result]));
  const nextState = {
    version: 2,
    ledger: state.ledger.map(row => {
      if (!row || !confirmed.has(row.RowID)) return row;
      const syncResult = resultById.get(row.RowID);
      return {
        ...row,
        ...(syncResult === 'review required' ? { Status: 'REVIEW' } : {}),
        __syncResult: syncResult,
        __syncedAt: acknowledgedAt
      };
    }),
    queue: state.queue.filter(row => row && !confirmed.has(row.RowID))
  };
  return { state: nextState, ...evaluation };
}

export const SYNC_ENDPOINT = '/api/m1-kiosk-sync';
