const DISPLAY_ID_PATTERN = /^sheet-row-[1-9][0-9]*$/u;
const AUDIT_ID_PATTERN = /^audit-row-[1-9][0-9]*$/u;
const SIGNIN_ROW_ID_PATTERN = /^gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u;
const REVIEW_NOTES_MAX_LENGTH = 800;
const RECORD_SOURCES = new Set(['Kiosk', 'Admin-added', 'Manual', 'Collision review']);
const ADMIN_ADDITION_RESULTS = new Set(['added', 'already exists']);
const AUDIT_RESULTS = new Set(['added', 'already exists', 'voided']);
const INSTRUCTOR_SIGNIN_VOID_RESULTS = new Set(['voided', 'already voided']);
const ADMIN_NAMES = new Set(['Andrew Smith', 'Stuart Turner']);
const WARNING_CODES = Object.freeze({
  UNREADABLE_SIGNIN: 'One Sheet row for this date is incomplete and was not included.',
  UNREADABLE_SIGNIN_DATE: 'One Sheet row has an unreadable date and was not included.',
  UNREADABLE_AUDIT: 'One Daily Review audit row for this date is incomplete and was not included.',
  AUDIT_UNAVAILABLE: 'Daily Review audit history could not be read.'
});
export const RICHMOND_INSTRUCTOR_SIGNIN_VOID_ELIGIBILITY_VERSION =
  'richmond-instructor-void-v1';
const REVIEW_RECORD_KEYS = Object.freeze([
  'displayId',
  'recordId',
  'timestamp',
  'date',
  'classLabel',
  'duration',
  'instructor',
  'site',
  'notes',
  'source',
  'reviewRequired',
  'reviewMessage'
]);

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function text(value, maxLength, allowBlank = false) {
  if (typeof value !== 'string' || value.length > maxLength || value.includes('\u0000')) return null;
  if (!allowBlank && !value) return null;
  return value;
}

function exactCanonicalText(value, maxLength, allowBlank = false) {
  if (typeof value !== 'string') return null;
  const canonical = value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ');
  if (
    canonical !== value
    || canonical.length > maxLength
    || (!allowBlank && !canonical)
    || /[\u0000-\u001f\u007f-\u009f]/u.test(canonical)
    || /^[=+\-@]/u.test(canonical)
  ) return null;
  return canonical;
}

function positiveDuration(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= 8;
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function validTimestamp(value) {
  return typeof value === 'string'
    && TIMESTAMP_PATTERN.test(value)
    && validDate(value.slice(0, 10));
}

function normalizedEventText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US')
    .replace(/[’‘`´]/gu, "'")
    .replace(/[‐‑‒–—―−]/gu, '-');
}

export function sanitizeReviewRecord(input, expectedDate = '', options = {}) {
  const includeVoidEligibility = options.allowInstructorSigninVoid === true;
  if (!exactKeys(input, includeVoidEligibility
    ? [...REVIEW_RECORD_KEYS, 'voidEligible']
    : REVIEW_RECORD_KEYS)) return null;

  const value = {
    displayId: text(input.displayId, 80),
    recordId: text(input.recordId, 240, true),
    timestamp: text(input.timestamp, 19, true),
    date: text(input.date, 10),
    classLabel: text(input.classLabel, 200),
    duration: input.duration,
    instructor: text(input.instructor, 100),
    site: text(input.site, 80),
    notes: text(input.notes, REVIEW_NOTES_MAX_LENGTH, true),
    source: text(input.source, 40),
    reviewRequired: input.reviewRequired,
    reviewMessage: text(input.reviewMessage, 240, true),
    ...(includeVoidEligibility ? { voidEligible: input.voidEligible } : {})
  };
  if (
    !DISPLAY_ID_PATTERN.test(value.displayId || '')
    || !validDate(value.date)
    || (expectedDate && value.date !== expectedDate)
    || (value.timestamp && !validTimestamp(value.timestamp))
    || !positiveDuration(value.duration)
    || !RECORD_SOURCES.has(value.source)
    || typeof value.reviewRequired !== 'boolean'
    || (includeVoidEligibility && typeof value.voidEligible !== 'boolean')
    || (value.source === 'Collision review') !== value.reviewRequired
    || (value.reviewRequired && !value.reviewMessage)
    || (!value.reviewRequired && value.reviewMessage)
    || (includeVoidEligibility && value.voidEligible && (
      value.source !== 'Kiosk'
      || value.reviewRequired
      || value.site !== 'Richmond'
      || !SIGNIN_ROW_ID_PATTERN.test(value.recordId || '')
    ))
    || Object.values(value).some(item => item == null)
  ) return null;
  return Object.freeze(value);
}

export function sanitizeReviewWarning(input) {
  if (!exactKeys(input, ['displayId', 'code', 'message'])) return null;
  const displayId = text(input.displayId, 80);
  const code = text(input.code, 40);
  const message = text(input.message, 240);
  if (
    !displayId
    || (
      !DISPLAY_ID_PATTERN.test(displayId)
      && !AUDIT_ID_PATTERN.test(displayId)
      && displayId !== 'audit-history'
    )
    || !Object.hasOwn(WARNING_CODES, code)
    || message !== WARNING_CODES[code]
  ) return null;
  return Object.freeze({ displayId, code, message });
}

export function sanitizeAuditRecord(input, expectedDate = '', options = {}) {
  if (!exactKeys(input, [
    'auditId',
    'actionNumber',
    'adminName',
    'actionTime',
    'instructor',
    'classDate',
    'classLabel',
    'site',
    'duration',
    'reason',
    'result',
    'linkedRecordId'
  ])) return null;
  const value = {
    auditId: text(input.auditId, 80),
    actionNumber: input.actionNumber,
    adminName: text(input.adminName, 80),
    actionTime: text(input.actionTime, 19),
    instructor: text(input.instructor, 100),
    classDate: text(input.classDate, 10),
    classLabel: text(input.classLabel, 200),
    site: text(input.site, 80),
    duration: input.duration,
    reason: text(input.reason, 240),
    result: text(input.result, 40),
    linkedRecordId: text(input.linkedRecordId, 240, true)
  };
  if (
    !AUDIT_ID_PATTERN.test(value.auditId || '')
    || !Number.isSafeInteger(value.actionNumber)
    || value.actionNumber < 1
    || !ADMIN_NAMES.has(value.adminName)
    || !validTimestamp(value.actionTime)
    || !validDate(value.classDate)
    || (expectedDate && value.classDate !== expectedDate)
    || !positiveDuration(value.duration)
    || !AUDIT_RESULTS.has(value.result)
    || (
      value.result === 'added'
      && (
        typeof value.linkedRecordId !== 'string'
        || !value.linkedRecordId.startsWith('gib-admin-')
      )
    )
    || (
      value.result === 'voided'
      && (
        options.allowInstructorSigninVoid !== true
        || !SIGNIN_ROW_ID_PATTERN.test(value.linkedRecordId || '')
      )
    )
    || Object.values(value).some(item => item == null)
  ) return null;
  return Object.freeze(value);
}

function sanitizeUniqueArray(input, sanitizer, seenIds, idKey) {
  if (!Array.isArray(input) || input.length > 2_000) return null;
  const values = [];
  for (const item of input) {
    const value = sanitizer(item);
    if (!value || seenIds.has(value[idKey])) return null;
    seenIds.add(value[idKey]);
    values.push(value);
  }
  return values;
}

export function sanitizeDailyReviewPayload(input, expectedDate, options = {}) {
  if (!exactKeys(input, ['ok', 'date', 'records', 'warnings', 'auditHistory'])) return null;
  if (input.ok !== true || input.date !== expectedDate) return null;
  const displayIds = new Set();
  const records = sanitizeUniqueArray(
    input.records,
    value => sanitizeReviewRecord(value, expectedDate, options),
    displayIds,
    'displayId'
  );
  if (!records) return null;
  const warnings = sanitizeUniqueArray(
    input.warnings,
    sanitizeReviewWarning,
    displayIds,
    'displayId'
  );
  if (!warnings) return null;
  const auditHistory = sanitizeUniqueArray(
    input.auditHistory,
    value => sanitizeAuditRecord(value, expectedDate, options),
    new Set(),
    'auditId'
  );
  if (!auditHistory) return null;
  const auditActionNumbers = new Set();
  for (const audit of auditHistory) {
    if (auditActionNumbers.has(audit.actionNumber)) return null;
    auditActionNumbers.add(audit.actionNumber);
  }
  return Object.freeze({ records, warnings, auditHistory });
}

export function sanitizeInstructorSearchPayload(input, expectedInstructor, expectedDate, latestDate) {
  if (!exactKeys(input, [
    'ok',
    'instructor',
    'date',
    'selectedDateRecords',
    'recentRecords'
  ])) return null;
  if (input.ok !== true || input.instructor !== expectedInstructor || input.date !== expectedDate) return null;
  const selectedDateRecords = sanitizeUniqueArray(
    input.selectedDateRecords,
    value => sanitizeReviewRecord(value, expectedDate),
    new Set(),
    'displayId'
  );
  if (!selectedDateRecords) return null;
  const recentRecords = sanitizeUniqueArray(
    input.recentRecords,
    value => sanitizeReviewRecord(value),
    new Set(),
    'displayId'
  );
  if (!recentRecords) return null;
  if (recentRecords.length > 5) return null;
  const expectedInstructorKey = normalizedEventText(expectedInstructor);
  if (
    selectedDateRecords.some(record => normalizedEventText(record.instructor) !== expectedInstructorKey)
    || recentRecords.some(record => (
      normalizedEventText(record.instructor) !== expectedInstructorKey
      || (latestDate && record.date > latestDate)
    ))
  ) return null;
  return Object.freeze({ selectedDateRecords, recentRecords });
}

export function sanitizeAdminAdditionPayload(input, expected) {
  if (!exactKeys(input, [
    'ok',
    'result',
    'requestId',
    'linkedRecordId',
    'linkedDisplayId',
    'auditActionNumber',
    'confirmation'
  ])) return null;
  if (input.ok !== true || !ADMIN_ADDITION_RESULTS.has(input.result)) return null;
  const requestId = text(input.requestId, 160);
  const linkedRecordId = text(input.linkedRecordId, 240, true);
  const linkedDisplayId = text(input.linkedDisplayId, 80);
  if (
    !requestId
    || linkedRecordId == null
    || !DISPLAY_ID_PATTERN.test(linkedDisplayId || '')
    || (input.result === 'added' && linkedRecordId !== `gib-admin-${requestId}`)
    || !Number.isSafeInteger(input.auditActionNumber)
    || input.auditActionNumber < 1
    || !exactKeys(input.confirmation, [
      'adminName',
      'date',
      'classLabel',
      'duration',
      'instructor',
      'site',
      'reason',
      'notes'
    ])
  ) return null;

  const confirmation = {
    adminName: text(input.confirmation.adminName, 80),
    date: text(input.confirmation.date, 10),
    classLabel: text(input.confirmation.classLabel, 200),
    duration: input.confirmation.duration,
    instructor: text(input.confirmation.instructor, 100),
    site: text(input.confirmation.site, 80),
    reason: text(input.confirmation.reason, 240),
    notes: text(input.confirmation.notes, 400, true)
  };
  if (
    !validDate(confirmation.date)
    || !positiveDuration(confirmation.duration)
    || Object.values(confirmation).some(value => value == null)
    || !expected
    || requestId !== expected.requestId
    || Object.keys(confirmation).some(key => confirmation[key] !== expected[key])
  ) return null;
  return Object.freeze({
    result: input.result,
    requestId,
    linkedRecordId,
    linkedDisplayId,
    auditActionNumber: input.auditActionNumber,
    confirmation: Object.freeze(confirmation)
  });
}

export function sanitizeInstructorSigninVoidRequest(input, expectedAdminName) {
  if (!exactKeys(input, ['requestId', 'rowId', 'adminName', 'reason'])) return null;
  const rowId = typeof input.rowId === 'string' && SIGNIN_ROW_ID_PATTERN.test(input.rowId)
    ? input.rowId
    : '';
  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  const adminName = exactCanonicalText(input.adminName, 80);
  const reason = exactCanonicalText(input.reason, 240);
  if (
    !rowId
    || requestId !== `gib-m1-admin-void-${rowId}`
    || !ADMIN_NAMES.has(adminName)
    || adminName !== expectedAdminName
    || !reason
    || reason.length < 3
  ) return null;
  return Object.freeze({ requestId, rowId, adminName, reason });
}

export function sanitizeInstructorSigninVoidResult(input, expected) {
  if (
    !exactKeys(input, [
      'ok',
      'result',
      'requestId',
      'linkedRecordId',
      'auditActionNumber',
      'confirmation'
    ])
    || input.ok !== true
    || !INSTRUCTOR_SIGNIN_VOID_RESULTS.has(input.result)
    || !expected
    || input.requestId !== expected.requestId
    || input.linkedRecordId !== expected.rowId
    || !Number.isSafeInteger(input.auditActionNumber)
    || input.auditActionNumber < 1
    || !exactKeys(input.confirmation, [
      'adminName',
      'rowId',
      'timestamp',
      'date',
      'classLabel',
      'duration',
      'instructor',
      'site',
      'device',
      'build',
      'notes',
      'status',
      'reason'
    ])
  ) return null;

  const confirmation = {
    adminName: exactCanonicalText(input.confirmation.adminName, 80),
    rowId: typeof input.confirmation.rowId === 'string'
      && SIGNIN_ROW_ID_PATTERN.test(input.confirmation.rowId)
      ? input.confirmation.rowId
      : '',
    timestamp: text(input.confirmation.timestamp, 19),
    date: text(input.confirmation.date, 10),
    classLabel: exactCanonicalText(input.confirmation.classLabel, 200),
    duration: input.confirmation.duration,
    instructor: exactCanonicalText(input.confirmation.instructor, 100),
    site: exactCanonicalText(input.confirmation.site, 80),
    device: exactCanonicalText(input.confirmation.device, 120),
    build: exactCanonicalText(input.confirmation.build, 120),
    notes: exactCanonicalText(input.confirmation.notes, 400, true),
    status: input.confirmation.status,
    reason: exactCanonicalText(input.confirmation.reason, 240)
  };
  if (
    confirmation.adminName !== expected.adminName
    || confirmation.rowId !== expected.rowId
    || confirmation.reason !== expected.reason
    || !validTimestamp(confirmation.timestamp)
    || !validDate(confirmation.date)
    || confirmation.timestamp.slice(0, 10) !== confirmation.date
    || !positiveDuration(confirmation.duration)
    || confirmation.site !== 'Richmond'
    || confirmation.device !== 'Richmond Front Desk Tablet'
    || confirmation.status !== 'VOID'
    || Object.entries(confirmation).some(([key, value]) => (
      value == null || (key !== 'notes' && value === '')
    ))
  ) return null;

  return Object.freeze({
    result: input.result,
    requestId: input.requestId,
    linkedRecordId: input.linkedRecordId,
    auditActionNumber: input.auditActionNumber,
    confirmation: Object.freeze(confirmation)
  });
}

export const DAILY_REVIEW_WARNING_MESSAGES = WARNING_CODES;
