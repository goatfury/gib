export const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const STAFF_ACTIONS = Object.freeze(['clockIn', 'clockOut']);
export const STAFF_RECORD_STATUSES = Object.freeze(['ACTIVE', 'VOID']);
export const STAFF_RECORD_SOURCES = Object.freeze(['Tablet', 'Admin-added']);
export const MAX_STAFF_CLOCK_PUNCHES = 50;
export const MAX_STAFF_CLOCK_PAGE_ITEMS = 500;
export const MAX_STAFF_CLOCK_HISTORY_SHIFTS = 50;
export const MAX_STAFF_CLOCK_STAFF = 100;
export const MAX_STAFF_CLOCK_RECORDS = 500;
export const MAX_STAFF_CLOCK_AUDIT = 500;
export const MAX_STAFF_CLOCK_ATTENTION_GROUPS = 600;

const ADMIN_NAMES = new Set(['Andrew Smith', 'Stuart Turner']);
const ACTIONS = new Set(STAFF_ACTIONS);
const RECORD_STATUSES = new Set(STAFF_RECORD_STATUSES);
const RECORD_SOURCES = new Set(STAFF_RECORD_SOURCES);
const SYNC_RESULTS = new Set([
  'added',
  'already exists',
  'needs attention',
  'rejected',
  'failed'
]);
const CORRECTION_RESULTS = new Set(['added', 'already exists']);
const VOID_RESULTS = new Set(['voided', 'already voided']);
const ADJUSTMENT_RESULTS = new Set(['adjusted', 'already adjusted']);
const ADJUSTMENT_CHANGES = new Set(['clockIn', 'clockOut', 'both']);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const NEW_YORK_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,3})?(-04:00|-05:00)$/u;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_SAFE_TOTAL_SECONDS = 15 * 24 * 60 * 60;
const MAX_STAFF_SHIFT_MS = 18 * 60 * 60 * 1_000;
const MAX_STAFF_PAGE_BYTES = 80_000;
const STAFF_VIEW_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const KIOSK_PAGE_STREAMS = new Set(['records', 'attention']);
const ADMIN_PAGE_STREAMS = new Set(['records', 'attention', 'audit']);

const newYorkFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

export function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function exactText(value, maxLength, allowBlank = false) {
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) return null;
  const text = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (
    text !== value
    || (!allowBlank && !text)
    || FORMULA_PREFIX_PATTERN.test(text)
  ) return null;
  return text;
}

function obviousTestName(value) {
  return /\b(test|fake|demo|qa)\b|do not pay/iu.test(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function newYorkWallTime(date) {
  const parts = {};
  newYorkFormatter.formatToParts(date).forEach(part => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function validNewYorkTimestamp(
  value,
  expectedDate = '',
  now = new Date(),
  maxFutureSkewMs = MAX_FUTURE_SKEW_MS
) {
  if (typeof value !== 'string' || value.length < 25 || value.length > 29) return false;
  const match = NEW_YORK_TIMESTAMP_PATTERN.exec(value);
  if (!match || !validDate(match[1]) || (expectedDate && match[1] !== expectedDate)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  if (newYorkWallTime(parsed) !== `${match[1]}T${match[2]}`) return false;
  if (
    now instanceof Date
    && Number.isFinite(now.getTime())
    && Number.isFinite(maxFutureSkewMs)
    && parsed.getTime() > now.getTime() + maxFutureSkewMs
  ) return false;
  return true;
}

function sanitizeStaffName(value, requireTestName) {
  const name = exactText(value, 100);
  if (!name || (requireTestName && !obviousTestName(name))) return null;
  return name;
}

function sanitizeStaffId(value) {
  const staffId = exactText(value, 80);
  return staffId && /^[a-z0-9][a-z0-9_-]*$/u.test(staffId) ? staffId : null;
}

export function sanitizeStaffClockPunch(input, options = {}) {
  if (!exactObjectKeys(input, [
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
  ])) return null;

  const now = options.now instanceof Date ? options.now : new Date();
  const value = {
    punchId: typeof input.punchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.punchId)
      ? input.punchId
      : '',
    timestamp: typeof input.timestamp === 'string' ? input.timestamp : '',
    date: typeof input.date === 'string' ? input.date : '',
    staffId: sanitizeStaffId(input.staffId),
    staffName: sanitizeStaffName(input.staffName, options.requireTestName === true),
    punchAction: typeof input.punchAction === 'string' && ACTIONS.has(input.punchAction)
      ? input.punchAction
      : '',
    site: exactText(input.site, 80),
    device: exactText(input.device, 120),
    build: exactText(input.build, 120),
    note: exactText(input.note, 400, true)
  };
  if (
    !value.punchId
    || !validDate(value.date)
    || !validNewYorkTimestamp(value.timestamp, value.date, now)
    || !value.staffId
    || !value.staffName
    || !value.punchAction
    || !value.site
    || !value.device
    || !value.build
    || value.note == null
  ) return null;
  return Object.freeze(value);
}

export function rejectedPunchResult(input) {
  return Object.freeze({
    punchId: typeof input?.punchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.punchId)
      ? input.punchId
      : '',
    result: 'rejected',
    linkedPunchId: ''
  });
}

function sanitizeStaff(input, requireTestName) {
  if (!exactObjectKeys(input, ['staffId', 'staffName'])) return null;
  const staffId = sanitizeStaffId(input.staffId);
  const staffName = sanitizeStaffName(input.staffName, requireTestName);
  return staffId && staffName ? Object.freeze({ staffId, staffName }) : null;
}

function sanitizeUniqueArray(input, maxLength, sanitizer, idForValue) {
  if (!Array.isArray(input) || input.length > maxLength) return null;
  const seen = new Set();
  const values = [];
  for (const item of input) {
    const value = sanitizer(item);
    if (!value) return null;
    const id = idForValue(value);
    if (seen.has(id)) return null;
    seen.add(id);
    values.push(value);
  }
  return values;
}

function sanitizeStaffList(input, requireTestName) {
  return sanitizeUniqueArray(
    input,
    MAX_STAFF_CLOCK_STAFF,
    item => sanitizeStaff(item, requireTestName),
    item => item.staffId
  );
}

function sanitizeRecord(input, options = {}) {
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
  const optionalKeys = [
    'adminName',
    'linkedPunchId',
    'originalTimestamp',
    'originalDate',
    'adjustmentRequestId'
  ];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const actualKeys = Object.keys(input);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (
    !requiredKeys.every(key => Object.hasOwn(input, key))
    || actualKeys.some(key => !allowedKeys.has(key))
  ) return null;
  const date = typeof input.date === 'string' ? input.date : '';
  const source = typeof input.source === 'string' && RECORD_SOURCES.has(input.source)
    ? input.source
    : '';
  const adminName = exactText(input.adminName ?? '', 80, true);
  const linkedPunchId = exactText(input.linkedPunchId ?? '', 80, true);
  const hasAdjustment = Object.hasOwn(input, 'originalTimestamp')
    || Object.hasOwn(input, 'originalDate')
    || Object.hasOwn(input, 'adjustmentRequestId');
  const originalTimestamp = hasAdjustment && typeof input.originalTimestamp === 'string'
    ? input.originalTimestamp
    : '';
  const originalDate = hasAdjustment && typeof input.originalDate === 'string'
    ? input.originalDate
    : '';
  const adjustmentRequestId = hasAdjustment && typeof input.adjustmentRequestId === 'string'
    ? input.adjustmentRequestId
    : '';
  const value = {
    punchId: typeof input.punchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.punchId)
      ? input.punchId
      : '',
    timestamp: typeof input.timestamp === 'string' ? input.timestamp : '',
    date,
    staffId: sanitizeStaffId(input.staffId),
    staffName: sanitizeStaffName(input.staffName, options.requireTestName === true),
    punchAction: typeof input.punchAction === 'string' && ACTIONS.has(input.punchAction)
      ? input.punchAction
      : '',
    site: exactText(input.site, 80),
    device: exactText(input.device, 120),
    build: exactText(input.build, 120),
    note: exactText(input.note, 400, true),
    status: typeof input.status === 'string' && RECORD_STATUSES.has(input.status) ? input.status : '',
    source,
    adminName,
    linkedPunchId
  };
  if (
    !value.punchId
    || !validDate(date)
    || !validNewYorkTimestamp(
      value.timestamp,
      date,
      options.now || new Date(),
      Number.POSITIVE_INFINITY
    )
    || !value.staffId
    || !value.staffName
    || !value.punchAction
    || !value.site
    || !value.device
    || !value.build
    || value.note == null
    || !value.status
    || !value.source
    || value.adminName == null
    || value.linkedPunchId == null
    || (value.linkedPunchId && !STAFF_PUNCH_ID_PATTERN.test(value.linkedPunchId))
    || (source === 'Tablet' && value.adminName)
    || (source === 'Admin-added' && !ADMIN_NAMES.has(value.adminName))
    || (hasAdjustment && (
      !validDate(originalDate)
      || !validNewYorkTimestamp(
        originalTimestamp,
        originalDate,
        options.now || new Date(),
        Number.POSITIVE_INFINITY
      )
      || !STAFF_REQUEST_ID_PATTERN.test(adjustmentRequestId)
    ))
  ) return null;
  const output = {
    punchId: value.punchId,
    timestamp: value.timestamp,
    date: value.date,
    staffId: value.staffId,
    staffName: value.staffName,
    punchAction: value.punchAction,
    site: value.site,
    device: value.device,
    build: value.build,
    note: value.note,
    status: value.status,
    source: value.source
  };
  if (value.adminName) output.adminName = value.adminName;
  if (value.linkedPunchId) output.linkedPunchId = value.linkedPunchId;
  if (hasAdjustment) {
    output.originalTimestamp = originalTimestamp;
    output.originalDate = originalDate;
    output.adjustmentRequestId = adjustmentRequestId;
  }
  return Object.freeze(output);
}

export function sanitizeStaffClockSnapshot(input, expectedTarget, options = {}) {
  return sanitizeStaffViewSummary(input, expectedTarget, options, false);
}

function validResultLink(value) {
  if (value.result === 'added' || value.result === 'already exists') {
    return value.linkedPunchId === value.punchId;
  }
  return value.linkedPunchId === '';
}

export function sanitizeStaffClockSyncResults(input, expectedPunches, expectedTarget) {
  if (
    !exactObjectKeys(input, ['ok', 'target', 'results'])
    || input.ok !== true
    || input.target !== expectedTarget
    || !Array.isArray(expectedPunches)
    || !Array.isArray(input.results)
    || input.results.length !== expectedPunches.length
  ) return null;

  const expected = new Set(expectedPunches.map(punch => punch.punchId));
  if (expected.size !== expectedPunches.length) return null;
  const observed = new Map();
  for (const item of input.results) {
    if (
      !exactObjectKeys(item, ['punchId', 'result', 'linkedPunchId'])
      || typeof item.punchId !== 'string'
      || !expected.has(item.punchId)
      || observed.has(item.punchId)
      || typeof item.result !== 'string'
      || !SYNC_RESULTS.has(item.result)
      || typeof item.linkedPunchId !== 'string'
      || (item.linkedPunchId && !STAFF_PUNCH_ID_PATTERN.test(item.linkedPunchId))
      || !validResultLink(item)
    ) return null;
    observed.set(item.punchId, Object.freeze({
      punchId: item.punchId,
      result: item.result,
      linkedPunchId: item.linkedPunchId
    }));
  }
  if (observed.size !== expected.size) return null;
  return Object.freeze(expectedPunches.map(punch => observed.get(punch.punchId)));
}

export function sanitizeStaffTimeCorrectionRequest(input, options = {}) {
  if (!exactObjectKeys(input, [
    'operation',
    'requestId',
    'punchId',
    'staffId',
    'staffName',
    'punchAction',
    'timestamp',
    'date',
    'reason'
  ]) || input.operation !== 'correct') return null;
  const date = typeof input.date === 'string' ? input.date : '';
  const value = {
    operation: 'correct',
    requestId: typeof input.requestId === 'string' && STAFF_REQUEST_ID_PATTERN.test(input.requestId)
      ? input.requestId
      : '',
    punchId: typeof input.punchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.punchId)
      ? input.punchId
      : '',
    staffId: sanitizeStaffId(input.staffId),
    staffName: sanitizeStaffName(input.staffName, options.requireTestName === true),
    punchAction: typeof input.punchAction === 'string' && ACTIONS.has(input.punchAction)
      ? input.punchAction
      : '',
    timestamp: typeof input.timestamp === 'string' ? input.timestamp : '',
    date,
    reason: exactText(input.reason, 240)
  };
  if (
    !value.requestId
    || !value.punchId
    || !value.staffId
    || !value.staffName
    || !value.punchAction
    || !validDate(date)
    || !validNewYorkTimestamp(value.timestamp, date, options.now || new Date(), 0)
    || !value.reason
    || value.reason.length < 3
  ) return null;
  return Object.freeze(value);
}

export function sanitizeStaffTimeVoidRequest(input) {
  if (!exactObjectKeys(input, ['operation', 'requestId', 'punchId', 'reason']) || input.operation !== 'void') {
    return null;
  }
  const value = {
    operation: 'void',
    requestId: typeof input.requestId === 'string' && STAFF_REQUEST_ID_PATTERN.test(input.requestId)
      ? input.requestId
      : '',
    punchId: typeof input.punchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.punchId)
      ? input.punchId
      : '',
    reason: exactText(input.reason, 240)
  };
  if (!value.requestId || !value.punchId || !value.reason || value.reason.length < 3) return null;
  return Object.freeze(value);
}

function adjustmentChange(value) {
  const changedIn = value.correctedClockInAt !== value.originalClockInAt;
  const changedOut = value.correctedClockOutAt !== value.originalClockOutAt;
  return changedIn && changedOut ? 'both' : changedIn ? 'clockIn' : changedOut ? 'clockOut' : '';
}

export function sanitizeStaffTimeAdjustmentRequest(input, options = {}) {
  if (!exactObjectKeys(input, [
    'operation',
    'requestId',
    'clockInPunchId',
    'clockOutPunchId',
    'originalClockInAt',
    'originalClockOutAt',
    'correctedClockInAt',
    'correctedClockOutAt',
    'reason'
  ]) || input.operation !== 'adjust') return null;
  const now = options.now instanceof Date ? options.now : new Date();
  const value = {
    operation: 'adjust',
    requestId: typeof input.requestId === 'string' && STAFF_REQUEST_ID_PATTERN.test(input.requestId)
      ? input.requestId
      : '',
    clockInPunchId: typeof input.clockInPunchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.clockInPunchId)
      ? input.clockInPunchId
      : '',
    clockOutPunchId: typeof input.clockOutPunchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.clockOutPunchId)
      ? input.clockOutPunchId
      : '',
    originalClockInAt: typeof input.originalClockInAt === 'string' ? input.originalClockInAt : '',
    originalClockOutAt: typeof input.originalClockOutAt === 'string' ? input.originalClockOutAt : '',
    correctedClockInAt: typeof input.correctedClockInAt === 'string' ? input.correctedClockInAt : '',
    correctedClockOutAt: typeof input.correctedClockOutAt === 'string' ? input.correctedClockOutAt : '',
    reason: exactText(input.reason, 240)
  };
  const originalElapsed = Date.parse(value.originalClockOutAt) - Date.parse(value.originalClockInAt);
  const correctedElapsed = Date.parse(value.correctedClockOutAt) - Date.parse(value.correctedClockInAt);
  const changed = adjustmentChange(value);
  if (
    !value.requestId
    || !value.clockInPunchId
    || !value.clockOutPunchId
    || value.clockInPunchId === value.clockOutPunchId
    || !validNewYorkTimestamp(value.originalClockInAt, '', now, Number.POSITIVE_INFINITY)
    || !validNewYorkTimestamp(value.originalClockOutAt, '', now, Number.POSITIVE_INFINITY)
    || !validNewYorkTimestamp(value.correctedClockInAt, '', now, 0)
    || !validNewYorkTimestamp(value.correctedClockOutAt, '', now, 0)
    || originalElapsed <= 0
    || correctedElapsed <= 0
    || correctedElapsed > MAX_STAFF_SHIFT_MS
    || !changed
    || !value.reason
    || value.reason.length < 3
  ) return null;
  return Object.freeze({ ...value, changed });
}

function sanitizeAuditRecord(input, options = {}) {
  if (input?.operation === 'adjust') {
    if (!exactObjectKeys(input, [
      'requestId',
      'actionTime',
      'adminName',
      'operation',
      'staffId',
      'staffName',
      'clockInPunchId',
      'clockOutPunchId',
      'originalClockInAt',
      'originalClockOutAt',
      'correctedClockInAt',
      'correctedClockOutAt',
      'changed',
      'reason',
      'result'
    ])) return null;
    const value = {
      requestId: typeof input.requestId === 'string' && STAFF_REQUEST_ID_PATTERN.test(input.requestId)
        ? input.requestId
        : '',
      actionTime: typeof input.actionTime === 'string' ? input.actionTime : '',
      adminName: exactText(input.adminName, 80),
      operation: 'adjust',
      staffId: sanitizeStaffId(input.staffId),
      staffName: sanitizeStaffName(input.staffName, options.requireTestName === true),
      clockInPunchId: typeof input.clockInPunchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.clockInPunchId)
        ? input.clockInPunchId
        : '',
      clockOutPunchId: typeof input.clockOutPunchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.clockOutPunchId)
        ? input.clockOutPunchId
        : '',
      originalClockInAt: typeof input.originalClockInAt === 'string' ? input.originalClockInAt : '',
      originalClockOutAt: typeof input.originalClockOutAt === 'string' ? input.originalClockOutAt : '',
      correctedClockInAt: typeof input.correctedClockInAt === 'string' ? input.correctedClockInAt : '',
      correctedClockOutAt: typeof input.correctedClockOutAt === 'string' ? input.correctedClockOutAt : '',
      changed: typeof input.changed === 'string' && ADJUSTMENT_CHANGES.has(input.changed) ? input.changed : '',
      reason: exactText(input.reason, 240),
      result: typeof input.result === 'string' && input.result === 'adjusted' ? input.result : ''
    };
    const correctedElapsed = Date.parse(value.correctedClockOutAt) - Date.parse(value.correctedClockInAt);
    if (
      !value.requestId
      || !validNewYorkTimestamp(value.actionTime, '', options.now || new Date())
      || !ADMIN_NAMES.has(value.adminName)
      || !value.staffId
      || !value.staffName
      || !value.clockInPunchId
      || !value.clockOutPunchId
      || value.clockInPunchId === value.clockOutPunchId
      || !validNewYorkTimestamp(value.originalClockInAt, '', options.now || new Date(), Number.POSITIVE_INFINITY)
      || !validNewYorkTimestamp(value.originalClockOutAt, '', options.now || new Date(), Number.POSITIVE_INFINITY)
      || !validNewYorkTimestamp(value.correctedClockInAt, '', options.now || new Date(), Number.POSITIVE_INFINITY)
      || !validNewYorkTimestamp(value.correctedClockOutAt, '', options.now || new Date(), Number.POSITIVE_INFINITY)
      || Date.parse(value.originalClockOutAt) <= Date.parse(value.originalClockInAt)
      || correctedElapsed <= 0
      || correctedElapsed > MAX_STAFF_SHIFT_MS
      || adjustmentChange(value) !== value.changed
      || !value.reason
      || !value.result
    ) return null;
    return Object.freeze(value);
  }
  if (!exactObjectKeys(input, [
    'requestId',
    'actionTime',
    'adminName',
    'operation',
    'staffId',
    'staffName',
    'punchTimestamp',
    'punchAction',
    'reason',
    'result',
    'linkedPunchId'
  ])) return null;
  const operation = input.operation === 'correct' || input.operation === 'void' ? input.operation : '';
  const resultSet = operation === 'correct' ? CORRECTION_RESULTS : operation === 'void' ? VOID_RESULTS : null;
  const adminName = exactText(input.adminName, 80);
  const staffId = sanitizeStaffId(input.staffId);
  const staffName = sanitizeStaffName(input.staffName, options.requireTestName === true);
  const value = {
    requestId: typeof input.requestId === 'string' && STAFF_REQUEST_ID_PATTERN.test(input.requestId)
      ? input.requestId
      : '',
    actionTime: typeof input.actionTime === 'string' ? input.actionTime : '',
    adminName,
    operation,
    staffId,
    staffName,
    punchTimestamp: typeof input.punchTimestamp === 'string' ? input.punchTimestamp : '',
    punchAction: typeof input.punchAction === 'string' && ACTIONS.has(input.punchAction)
      ? input.punchAction
      : '',
    reason: exactText(input.reason, 240),
    result: typeof input.result === 'string' && resultSet?.has(input.result) ? input.result : '',
    linkedPunchId: typeof input.linkedPunchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(input.linkedPunchId)
      ? input.linkedPunchId
      : ''
  };
  if (
    !value.requestId
    || !validNewYorkTimestamp(value.actionTime, '', options.now || new Date())
    || !ADMIN_NAMES.has(value.adminName)
    || !value.operation
    || !value.staffId
    || !value.staffName
    || !validNewYorkTimestamp(value.punchTimestamp, '', options.now || new Date())
    || !value.punchAction
    || !value.reason
    || !value.result
    || !value.linkedPunchId
  ) return null;
  return Object.freeze(value);
}

function sanitizeClockedInNow(input, requireTestName, now) {
  if (!exactObjectKeys(input, ['punchId', 'staffId', 'staffName', 'clockInAt'])) return null;
  const staffId = sanitizeStaffId(input.staffId);
  const staffName = sanitizeStaffName(input.staffName, requireTestName);
  if (
    typeof input.punchId !== 'string'
    || !STAFF_PUNCH_ID_PATTERN.test(input.punchId)
    || !staffId
    || !staffName
    || !validNewYorkTimestamp(input.clockInAt, '', now)
  ) return null;
  return Object.freeze({
    punchId: input.punchId,
    staffId,
    staffName,
    clockInAt: input.clockInAt
  });
}

function sanitizeAttention(input, requireTestName) {
  if (!exactObjectKeys(input, [
    'staffId', 'staffName', 'code', 'message', 'linkedPunchIds', 'occurrenceCount'
  ])) return null;
  const staffId = sanitizeStaffId(input.staffId);
  const staffName = sanitizeStaffName(input.staffName, requireTestName);
  const code = exactText(input.code, 64);
  const message = exactText(input.message, 240);
  if (
    !staffId
    || !staffName
    || !code
    || !/^[a-z][a-z0-9_]*$/u.test(code)
    || !message
    || !Array.isArray(input.linkedPunchIds)
    || input.linkedPunchIds.length > 20
    || !Number.isSafeInteger(input.occurrenceCount)
    || input.occurrenceCount < 1
  ) return null;
  const linkedPunchIds = [];
  const seen = new Set();
  for (const punchId of input.linkedPunchIds) {
    if (typeof punchId !== 'string' || !STAFF_PUNCH_ID_PATTERN.test(punchId) || seen.has(punchId)) {
      return null;
    }
    seen.add(punchId);
    linkedPunchIds.push(punchId);
  }
  return Object.freeze({
    staffId,
    staffName,
    code,
    message,
    linkedPunchIds: Object.freeze(linkedPunchIds),
    occurrenceCount: input.occurrenceCount
  });
}

function shiftDate(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function sanitizePeriod(input, requireTestName) {
  if (!exactObjectKeys(input, ['startDate', 'endDate', 'totals'])) return null;
  if (
    !validDate(input.startDate)
    || !validDate(input.endDate)
    || shiftDate(input.startDate, 13) !== input.endDate
    || !Array.isArray(input.totals)
    || input.totals.length > MAX_STAFF_CLOCK_STAFF
  ) return null;
  const totals = [];
  const seen = new Set();
  for (const item of input.totals) {
    if (!exactObjectKeys(item, [
      'staffId',
      'staffName',
      'completedShifts',
      'totalSeconds',
      'needsAttention'
    ])) {
      return null;
    }
    const staffId = sanitizeStaffId(item.staffId);
    const staffName = sanitizeStaffName(item.staffName, requireTestName);
    const key = staffId;
    if (
      !staffId
      || !staffName
      || seen.has(key)
      || !Number.isSafeInteger(item.completedShifts)
      || item.completedShifts < 0
      || !Number.isSafeInteger(item.totalSeconds)
      || item.totalSeconds < 0
      || item.totalSeconds > MAX_SAFE_TOTAL_SECONDS
      || typeof item.needsAttention !== 'boolean'
    ) return null;
    seen.add(key);
    totals.push(Object.freeze({
      staffId,
      staffName,
      completedShifts: item.completedShifts,
      totalSeconds: item.totalSeconds,
      needsAttention: item.needsAttention
    }));
  }
  return Object.freeze({
    startDate: input.startDate,
    endDate: input.endDate,
    totals: Object.freeze(totals)
  });
}

function sanitizeStaffViewMetadata(input, includeAdmin) {
  if (!exactObjectKeys(input, [
    'token',
    'today',
    'recordCount',
    'recordTotal',
    'todayPunchCount',
    'todayPunchTotal',
    'adjustmentCount',
    'adjustmentTotal',
    'attentionCount',
    'attentionOccurrenceCount',
    'auditCount',
    'auditTotal',
    'recordsTruncated',
    'auditTruncated'
  ])) return null;
  if (
    typeof input.token !== 'string'
    || !STAFF_VIEW_TOKEN_PATTERN.test(input.token)
    || !validDate(input.today)
    || !Number.isSafeInteger(input.recordCount)
    || input.recordCount < 0
    || input.recordCount > MAX_STAFF_CLOCK_RECORDS
    || !Number.isSafeInteger(input.recordTotal)
    || input.recordTotal < input.recordCount
    || !Number.isSafeInteger(input.todayPunchCount)
    || input.todayPunchCount < 0
    || input.todayPunchCount > input.recordCount
    || !Number.isSafeInteger(input.todayPunchTotal)
    || input.todayPunchTotal < input.todayPunchCount
    || input.todayPunchTotal > input.recordTotal
    || !Number.isSafeInteger(input.adjustmentCount)
    || input.adjustmentCount < 0
    || input.adjustmentCount > input.recordCount
    || !Number.isSafeInteger(input.adjustmentTotal)
    || input.adjustmentTotal < input.adjustmentCount
    || input.adjustmentTotal > input.recordTotal
    || !Number.isSafeInteger(input.attentionCount)
    || input.attentionCount < 0
    || input.attentionCount > MAX_STAFF_CLOCK_ATTENTION_GROUPS
    || !Number.isSafeInteger(input.attentionOccurrenceCount)
    || input.attentionOccurrenceCount < input.attentionCount
    || !Number.isSafeInteger(input.auditCount)
    || input.auditCount < 0
    || input.auditCount > MAX_STAFF_CLOCK_AUDIT
    || !Number.isSafeInteger(input.auditTotal)
    || input.auditTotal < input.auditCount
    || typeof input.recordsTruncated !== 'boolean'
    || input.recordsTruncated !== (input.recordCount < input.recordTotal)
    || typeof input.auditTruncated !== 'boolean'
    || input.auditTruncated !== (input.auditCount < input.auditTotal)
    || (!includeAdmin && (
      input.auditCount !== 0
      || input.auditTotal !== 0
      || input.auditTruncated !== false
    ))
  ) return null;
  return Object.freeze({
    token: input.token,
    today: input.today,
    recordCount: input.recordCount,
    recordTotal: input.recordTotal,
    todayPunchCount: input.todayPunchCount,
    todayPunchTotal: input.todayPunchTotal,
    adjustmentCount: input.adjustmentCount,
    adjustmentTotal: input.adjustmentTotal,
    attentionCount: input.attentionCount,
    attentionOccurrenceCount: input.attentionOccurrenceCount,
    auditCount: input.auditCount,
    auditTotal: input.auditTotal,
    recordsTruncated: input.recordsTruncated,
    auditTruncated: input.auditTruncated
  });
}

function sanitizeStaffViewSummary(input, expectedTarget, options, includeAdmin) {
  if (
    !exactObjectKeys(input, ['ok', 'target', 'staff', 'clockedInNow', 'periods', 'view'])
    || input.ok !== true
    || input.target !== expectedTarget
    || !exactObjectKeys(input.periods, ['current', 'previous'])
  ) return null;
  const requireTestName = expectedTarget === 'test';
  const now = options.now || new Date();
  const staff = sanitizeStaffList(input.staff, requireTestName);
  const clockedInNow = sanitizeUniqueArray(
    input.clockedInNow,
    MAX_STAFF_CLOCK_STAFF,
    item => sanitizeClockedInNow(item, requireTestName, now),
    item => item.staffId
  );
  const current = sanitizePeriod(input.periods.current, requireTestName);
  const previous = sanitizePeriod(input.periods.previous, requireTestName);
  const view = sanitizeStaffViewMetadata(input.view, includeAdmin);
  if (
    !staff
    || !clockedInNow
    || new Set(clockedInNow.map(item => item.punchId)).size !== clockedInNow.length
    || !current
    || !previous
    || !view
    || clockedInNow.length > view.recordCount
    || shiftDate(previous.endDate, 1) !== current.startDate
    || view.today < current.startDate
    || view.today > current.endDate
  ) return null;
  return Object.freeze({
    staff: Object.freeze(staff),
    clockedInNow: Object.freeze(clockedInNow),
    periods: Object.freeze({ current, previous }),
    view
  });
}

export function sanitizeStaffTimeReview(input, expectedTarget, options = {}) {
  return sanitizeStaffViewSummary(input, expectedTarget, options, true);
}

export function sanitizeStaffViewPageRequest(input, expectedOperation, options = {}) {
  if (
    !exactObjectKeys(input, ['operation', 'viewToken', 'stream', 'offset'])
    || input.operation !== expectedOperation
    || typeof input.viewToken !== 'string'
    || !STAFF_VIEW_TOKEN_PATTERN.test(input.viewToken)
    || typeof input.stream !== 'string'
    || !(options.includeAudit === true ? ADMIN_PAGE_STREAMS : KIOSK_PAGE_STREAMS).has(input.stream)
    || !Number.isSafeInteger(input.offset)
    || input.offset < 0
  ) return null;
  return Object.freeze({
    operation: expectedOperation,
    viewToken: input.viewToken,
    stream: input.stream,
    offset: input.offset
  });
}

function sanitizeStaffViewPageItems(input, stream, validationOptions) {
  if (!Array.isArray(input) || input.length > MAX_STAFF_CLOCK_PAGE_ITEMS) return null;
  if (stream === 'records') {
    return sanitizeUniqueArray(
      input,
      MAX_STAFF_CLOCK_PAGE_ITEMS,
      item => sanitizeRecord(item, validationOptions),
      item => item.punchId
    );
  }
  if (stream === 'audit') {
    return sanitizeUniqueArray(
      input,
      MAX_STAFF_CLOCK_PAGE_ITEMS,
      item => sanitizeAuditRecord(item, validationOptions),
      item => item.requestId
    );
  }
  return sanitizeUniqueArray(
    input,
    MAX_STAFF_CLOCK_PAGE_ITEMS,
    item => sanitizeAttention(item, validationOptions.requireTestName),
    item => `${item.staffId}\u0000${item.code}`
  );
}

export function sanitizeStaffViewPage(input, expectedTarget, expectedRequest, options = {}) {
  if (
    !expectedRequest
    || !exactObjectKeys(input, [
      'ok', 'target', 'viewToken', 'stream', 'offset', 'items', 'nextOffset'
    ])
    || input.ok !== true
    || input.target !== expectedTarget
    || input.viewToken !== expectedRequest.viewToken
    || input.stream !== expectedRequest.stream
    || input.offset !== expectedRequest.offset
  ) return null;
  const items = sanitizeStaffViewPageItems(input.items, input.stream, {
    requireTestName: expectedTarget === 'test',
    now: options.now || new Date()
  });
  if (!items || items.length < 1) return null;
  const terminal = input.nextOffset === null;
  if (
    !terminal
    && (
      !Number.isSafeInteger(input.nextOffset)
      || input.nextOffset !== input.offset + items.length
    )
  ) return null;
  return Object.freeze({
    viewToken: input.viewToken,
    stream: input.stream,
    offset: input.offset,
    items: Object.freeze(items),
    nextOffset: input.nextOffset
  });
}

export function sanitizeStaffTimeHistoryPageRequest(input, expectedOperation = 'historyPage') {
  if (
    !exactObjectKeys(input, ['operation', 'viewToken', 'offset'])
    || input.operation !== expectedOperation
    || typeof input.viewToken !== 'string'
    || !STAFF_VIEW_TOKEN_PATTERN.test(input.viewToken)
    || !Number.isSafeInteger(input.offset)
    || input.offset < 0
  ) return null;
  return Object.freeze({
    operation: expectedOperation,
    viewToken: input.viewToken,
    offset: input.offset
  });
}

function sanitizeStaffCompletedShift(input, validationOptions) {
  if (!exactObjectKeys(input, ['clockIn', 'clockOut', 'latestAdjustment'])) return null;
  const clockIn = sanitizeRecord(input.clockIn, validationOptions);
  const clockOut = sanitizeRecord(input.clockOut, validationOptions);
  if (
    !clockIn
    || !clockOut
    || clockIn.punchId === clockOut.punchId
    || clockIn.staffId !== clockOut.staffId
    || clockIn.staffName !== clockOut.staffName
    || clockIn.punchAction !== 'clockIn'
    || clockOut.punchAction !== 'clockOut'
    || clockIn.status !== 'ACTIVE'
    || clockOut.status !== 'ACTIVE'
    || Date.parse(clockOut.timestamp) <= Date.parse(clockIn.timestamp)
  ) return null;
  const clockInRequestId = Object.hasOwn(clockIn, 'adjustmentRequestId')
    ? clockIn.adjustmentRequestId
    : '';
  const clockOutRequestId = Object.hasOwn(clockOut, 'adjustmentRequestId')
    ? clockOut.adjustmentRequestId
    : '';
  const sharedRequestId = clockInRequestId === clockOutRequestId
    ? clockInRequestId
    : '';
  const latestAdjustment = input.latestAdjustment === null
    ? null
    : sanitizeAuditRecord(input.latestAdjustment, validationOptions);
  if (
    (sharedRequestId && !latestAdjustment)
    || (!sharedRequestId && latestAdjustment !== null)
    || (latestAdjustment && (
      latestAdjustment.operation !== 'adjust'
      || latestAdjustment.requestId !== sharedRequestId
      || latestAdjustment.staffId !== clockIn.staffId
      || latestAdjustment.staffName !== clockIn.staffName
      || latestAdjustment.clockInPunchId !== clockIn.punchId
      || latestAdjustment.clockOutPunchId !== clockOut.punchId
      || latestAdjustment.correctedClockInAt !== clockIn.timestamp
      || latestAdjustment.correctedClockOutAt !== clockOut.timestamp
    ))
  ) return null;
  return Object.freeze({ clockIn, clockOut, latestAdjustment });
}

function staffContractJsonByteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function sanitizeStaffTimeHistoryPage(
  input,
  expectedTarget,
  expectedRequest,
  options = {}
) {
  if (
    !expectedRequest
    || !exactObjectKeys(input, [
      'ok', 'target', 'viewToken', 'offset', 'total', 'items', 'nextOffset'
    ])
    || input.ok !== true
    || input.target !== expectedTarget
    || input.viewToken !== expectedRequest.viewToken
    || input.offset !== expectedRequest.offset
    || !Number.isSafeInteger(input.total)
    || input.total < 0
    || input.offset > input.total
    || !Array.isArray(input.items)
    || input.items.length > MAX_STAFF_CLOCK_HISTORY_SHIFTS
    || staffContractJsonByteLength(input) > MAX_STAFF_PAGE_BYTES
  ) return null;
  const validationOptions = {
    requireTestName: expectedTarget === 'test',
    now: options.now || new Date()
  };
  const items = [];
  const punchIds = new Set();
  for (const item of input.items) {
    const shift = sanitizeStaffCompletedShift(item, validationOptions);
    if (
      !shift
      || punchIds.has(shift.clockIn.punchId)
      || punchIds.has(shift.clockOut.punchId)
    ) return null;
    punchIds.add(shift.clockIn.punchId);
    punchIds.add(shift.clockOut.punchId);
    items.push(shift);
  }
  const endOffset = input.offset + items.length;
  if (
    endOffset > input.total
    || (items.length === 0 && input.offset < input.total)
    || input.nextOffset !== (endOffset < input.total ? endOffset : null)
  ) return null;
  return Object.freeze({
    viewToken: input.viewToken,
    offset: input.offset,
    total: input.total,
    items: Object.freeze(items),
    nextOffset: input.nextOffset
  });
}

export function isStaffViewStale(input, expectedTarget) {
  return exactObjectKeys(input, ['ok', 'target', 'result'])
    && input.ok === false
    && input.target === expectedTarget
    && input.result === 'stale';
}

function validAuditActionNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function sanitizeStaffTimeCorrectionResult(input, expected, expectedTarget) {
  if (
    !exactObjectKeys(input, [
      'ok',
      'target',
      'requestId',
      'result',
      'linkedPunchId',
      'auditActionNumber',
      'confirmation'
    ])
    || input.ok !== true
    || input.target !== expectedTarget
    || !expected
    || input.requestId !== expected.requestId
    || !CORRECTION_RESULTS.has(input.result)
    || input.linkedPunchId !== expected.punchId
    || !validAuditActionNumber(input.auditActionNumber)
    || !exactObjectKeys(input.confirmation, [
      'adminName',
      'punchId',
      'staffId',
      'staffName',
      'timestamp',
      'date',
      'punchAction',
      'reason',
      'site',
      'device',
      'build'
    ])
  ) return null;
  const confirmation = input.confirmation;
  if (
    confirmation.adminName !== expected.adminName
    || confirmation.punchId !== expected.punchId
    || confirmation.staffId !== expected.staffId
    || confirmation.staffName !== expected.staffName
    || confirmation.timestamp !== expected.timestamp
    || confirmation.date !== expected.date
    || confirmation.punchAction !== expected.punchAction
    || confirmation.reason !== expected.reason
    || confirmation.site !== expected.site
    || confirmation.device !== expected.device
    || confirmation.build !== expected.build
  ) return null;
  return Object.freeze({
    requestId: input.requestId,
    result: input.result,
    linkedPunchId: input.linkedPunchId,
    auditActionNumber: input.auditActionNumber,
    confirmation: Object.freeze({ ...confirmation })
  });
}

export function sanitizeStaffTimeVoidResult(input, expected, expectedTarget, options = {}) {
  if (
    !exactObjectKeys(input, [
      'ok',
      'target',
      'requestId',
      'result',
      'linkedPunchId',
      'auditActionNumber',
      'confirmation'
    ])
    || input.ok !== true
    || input.target !== expectedTarget
    || !expected
    || input.requestId !== expected.requestId
    || !VOID_RESULTS.has(input.result)
    || input.linkedPunchId !== expected.punchId
    || !validAuditActionNumber(input.auditActionNumber)
    || !exactObjectKeys(input.confirmation, [
      'adminName',
      'punchId',
      'staffId',
      'staffName',
      'timestamp',
      'date',
      'punchAction',
      'reason',
      'status'
    ])
  ) return null;
  const confirmation = input.confirmation;
  if (
    confirmation.adminName !== expected.adminName
    || confirmation.punchId !== expected.punchId
    || confirmation.reason !== expected.reason
    || !sanitizeStaffId(confirmation.staffId)
    || confirmation.status !== 'VOID'
    || !sanitizeStaffName(confirmation.staffName, expectedTarget === 'test')
    || !validDate(confirmation.date)
    || !validNewYorkTimestamp(
      confirmation.timestamp,
      confirmation.date,
      options.now || new Date()
    )
    || !ACTIONS.has(confirmation.punchAction)
  ) return null;
  return Object.freeze({
    requestId: input.requestId,
    result: input.result,
    linkedPunchId: input.linkedPunchId,
    auditActionNumber: input.auditActionNumber,
    confirmation: Object.freeze({ ...confirmation })
  });
}

export function sanitizeStaffTimeAdjustmentResult(input, expected, expectedTarget, options = {}) {
  if (
    !exactObjectKeys(input, [
      'ok',
      'target',
      'requestId',
      'result',
      'linkedPunchIds',
      'auditActionNumber',
      'confirmation'
    ])
    || input.ok !== true
    || input.target !== expectedTarget
    || !expected
    || input.requestId !== expected.requestId
    || !ADJUSTMENT_RESULTS.has(input.result)
    || !Array.isArray(input.linkedPunchIds)
    || input.linkedPunchIds.length !== 2
    || input.linkedPunchIds[0] !== expected.clockInPunchId
    || input.linkedPunchIds[1] !== expected.clockOutPunchId
    || !validAuditActionNumber(input.auditActionNumber)
    || !exactObjectKeys(input.confirmation, [
      'actionTime',
      'adminName',
      'staffId',
      'staffName',
      'changed',
      'clockInPunchId',
      'clockOutPunchId',
      'originalClockInAt',
      'originalClockOutAt',
      'correctedClockInAt',
      'correctedClockOutAt',
      'reason'
    ])
  ) return null;
  const confirmation = input.confirmation;
  if (
    confirmation.adminName !== expected.adminName
    || !ADMIN_NAMES.has(confirmation.adminName)
    || !sanitizeStaffId(confirmation.staffId)
    || !sanitizeStaffName(confirmation.staffName, expectedTarget === 'test')
    || confirmation.changed !== expected.changed
    || confirmation.clockInPunchId !== expected.clockInPunchId
    || confirmation.clockOutPunchId !== expected.clockOutPunchId
    || confirmation.originalClockInAt !== expected.originalClockInAt
    || confirmation.originalClockOutAt !== expected.originalClockOutAt
    || confirmation.correctedClockInAt !== expected.correctedClockInAt
    || confirmation.correctedClockOutAt !== expected.correctedClockOutAt
    || confirmation.reason !== expected.reason
    || !validNewYorkTimestamp(confirmation.actionTime, '', options.now || new Date())
  ) return null;
  return Object.freeze({
    requestId: input.requestId,
    result: input.result,
    linkedPunchIds: Object.freeze([...input.linkedPunchIds]),
    auditActionNumber: input.auditActionNumber,
    confirmation: Object.freeze({ ...confirmation })
  });
}
