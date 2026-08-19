export const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const STAFF_ACTIONS = Object.freeze(['clockIn', 'clockOut']);
export const STAFF_RECORD_STATUSES = Object.freeze(['ACTIVE', 'VOID']);
export const STAFF_RECORD_SOURCES = Object.freeze(['Tablet', 'Admin-added']);
export const MAX_STAFF_CLOCK_PUNCHES = 50;
export const MAX_STAFF_CLOCK_RECORDS = 2_000;
export const MAX_STAFF_CLOCK_STAFF = 100;

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
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const NEW_YORK_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,3})?(-04:00|-05:00)$/u;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_SAFE_TOTAL_SECONDS = 14 * 24 * 60 * 60;

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
  const optionalKeys = ['adminName', 'linkedPunchId'];
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
    || !validNewYorkTimestamp(value.timestamp, date, options.now || new Date())
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
  return Object.freeze(output);
}

function sanitizeRecords(input, options = {}) {
  return sanitizeUniqueArray(
    input,
    MAX_STAFF_CLOCK_RECORDS,
    item => sanitizeRecord(item, options),
    item => item.punchId
  );
}

export function sanitizeStaffClockSnapshot(input, expectedTarget, options = {}) {
  if (
    !exactObjectKeys(input, ['ok', 'target', 'staff', 'records'])
    || input.ok !== true
    || input.target !== expectedTarget
  ) return null;
  const requireTestName = expectedTarget === 'test';
  const staff = sanitizeStaffList(input.staff, requireTestName);
  const records = sanitizeRecords(input.records, {
    requireTestName,
    now: options.now || new Date()
  });
  if (!staff || !records) return null;
  return Object.freeze({ staff: Object.freeze(staff), records: Object.freeze(records) });
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

function sanitizeAuditRecord(input, options = {}) {
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

function sanitizeClockedInNow(input, recordById, requireTestName) {
  if (!exactObjectKeys(input, ['punchId', 'staffId', 'staffName', 'clockInAt'])) return null;
  const staffId = sanitizeStaffId(input.staffId);
  const staffName = sanitizeStaffName(input.staffName, requireTestName);
  const record = typeof input.punchId === 'string' ? recordById.get(input.punchId) : null;
  if (
    !record
    || !staffId
    || !staffName
    || record.staffId !== staffId
    || record.staffName !== staffName
    || record.punchAction !== 'clockIn'
    || record.status !== 'ACTIVE'
    || input.clockInAt !== record.timestamp
  ) return null;
  return Object.freeze({ punchId: record.punchId, staffId, staffName, clockInAt: record.timestamp });
}

function sanitizeTodayPunch(input, recordById, requireTestName) {
  if (!exactObjectKeys(input, [
    'punchId',
    'staffId',
    'staffName',
    'punchAction',
    'timestamp',
    'source',
    'status'
  ])) return null;
  const staffId = sanitizeStaffId(input.staffId);
  const staffName = sanitizeStaffName(input.staffName, requireTestName);
  const record = typeof input.punchId === 'string' ? recordById.get(input.punchId) : null;
  if (
    !record
    || !staffId
    || !staffName
    || record.staffId !== staffId
    || record.staffName !== staffName
    || input.punchAction !== record.punchAction
    || input.timestamp !== record.timestamp
    || input.source !== record.source
    || input.status !== record.status
  ) return null;
  return Object.freeze({
    punchId: record.punchId,
    staffId,
    staffName,
    punchAction: record.punchAction,
    timestamp: record.timestamp,
    source: record.source,
    status: record.status
  });
}

function sanitizeAttention(input, requireTestName) {
  if (!exactObjectKeys(input, ['staffId', 'staffName', 'code', 'message', 'linkedPunchIds'])) return null;
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
  return Object.freeze({ staffId, staffName, code, message, linkedPunchIds: Object.freeze(linkedPunchIds) });
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
      || item.completedShifts > 1_000
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

export function sanitizeStaffTimeReview(input, expectedTarget, options = {}) {
  if (
    !exactObjectKeys(input, [
      'ok',
      'target',
      'staff',
      'records',
      'audit',
      'clockedInNow',
      'todayPunches',
      'needsAttention',
      'periods'
    ])
    || input.ok !== true
    || input.target !== expectedTarget
    || !exactObjectKeys(input.periods, ['current', 'previous'])
  ) return null;
  const requireTestName = expectedTarget === 'test';
  const validationOptions = { requireTestName, now: options.now || new Date() };
  const staff = sanitizeStaffList(input.staff, requireTestName);
  const records = sanitizeRecords(input.records, validationOptions);
  if (!staff || !records) return null;
  const recordById = new Map(records.map(record => [record.punchId, record]));
  const audit = sanitizeUniqueArray(
    input.audit,
    MAX_STAFF_CLOCK_RECORDS,
    item => sanitizeAuditRecord(item, validationOptions),
    item => item.requestId
  );
  const clockedInNow = sanitizeUniqueArray(
    input.clockedInNow,
    MAX_STAFF_CLOCK_STAFF,
    item => sanitizeClockedInNow(item, recordById, requireTestName),
    item => item.staffId
  );
  const todayPunches = sanitizeUniqueArray(
    input.todayPunches,
    MAX_STAFF_CLOCK_RECORDS,
    item => sanitizeTodayPunch(item, recordById, requireTestName),
    item => item.punchId
  );
  if (
    !audit
    || !clockedInNow
    || !todayPunches
    || !Array.isArray(input.needsAttention)
    || input.needsAttention.length > MAX_STAFF_CLOCK_RECORDS
  ) return null;
  const needsAttention = input.needsAttention.map(item => sanitizeAttention(item, requireTestName));
  if (needsAttention.some(item => !item)) return null;
  for (const item of needsAttention) {
    if (item.linkedPunchIds.some(punchId => !recordById.has(punchId))) return null;
  }
  const current = sanitizePeriod(input.periods.current, requireTestName);
  const previous = sanitizePeriod(input.periods.previous, requireTestName);
  if (
    !current
    || !previous
    || shiftDate(previous.endDate, 1) !== current.startDate
  ) return null;
  return Object.freeze({
    staff: Object.freeze(staff),
    records: Object.freeze(records),
    audit: Object.freeze(audit),
    clockedInNow: Object.freeze(clockedInNow),
    todayPunches: Object.freeze(todayPunches),
    needsAttention: Object.freeze(needsAttention),
    periods: Object.freeze({ current, previous })
  });
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
