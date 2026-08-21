import {
  STAFF_REQUEST_ID_PATTERN,
  exactObjectKeys
} from './m1-staff-clock-contracts.mjs';

export const STAFF_ROSTER_OPERATIONS = Object.freeze([
  'list',
  'add',
  'deactivate',
  'reactivate'
]);

export const STAFF_ROSTER_CONFLICT_CODES = Object.freeze([
  'duplicate_active',
  'reactivate_required',
  'already_active',
  'already_inactive',
  'not_found',
  'last_active',
  'clocked_in',
  'request_conflict',
  'capacity'
]);

const ADMIN_NAMES = new Set(['Andrew Smith', 'Stuart Turner']);
const MUTATION_OPERATIONS = new Set(['add', 'deactivate', 'reactivate']);
const CONFLICT_CODES = new Set(STAFF_ROSTER_CONFLICT_CODES);
const TARGETS = new Set(['test', 'production']);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UNPAIRED_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/u;
const STAFF_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STAFF_NAME_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'\u2019-]*$/u;
const RESULT_BY_OPERATION = Object.freeze({
  add: 'added',
  deactivate: 'deactivated',
  reactivate: 'reactivated'
});

function obviousTestName(value) {
  return /\b(test|fake|demo|qa)\b|do(?:[\s\u2010-\u2015-]+)not(?:[\s\u2010-\u2015-]+)pay/iu.test(value);
}

function allowedTestName(value) {
  return /\b(test|fake|demo|qa)\b|do not pay/iu.test(value);
}

function targetNamePolicy(options = {}) {
  if (Object.hasOwn(options, 'target')) {
    if (!TARGETS.has(options.target)) return 'invalid';
    if (options.requireTestName === true && options.target !== 'test') return 'invalid';
    if (options.rejectTestName === true && options.target !== 'production') return 'invalid';
    return options.target;
  }
  if (options.requireTestName === true && options.rejectTestName === true) return 'invalid';
  if (options.requireTestName === true) return 'test';
  if (options.rejectTestName === true) return 'production';
  return '';
}

function exactRequestId(value) {
  return typeof value === 'string' && STAFF_REQUEST_ID_PATTERN.test(value)
    ? value
    : '';
}

export function sanitizeStaffRosterId(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 80
    || CONTROL_CHARACTER_PATTERN.test(value)
    || UNPAIRED_SURROGATE_PATTERN.test(value)
  ) return '';
  let normalized;
  try {
    normalized = value.normalize('NFKC');
  } catch {
    return '';
  }
  return normalized === value && STAFF_ID_PATTERN.test(value) ? value : '';
}

export function normalizeStaffRosterName(value, options = {}) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 400
    || CONTROL_CHARACTER_PATTERN.test(value)
    || UNPAIRED_SURROGATE_PATTERN.test(value)
  ) return '';
  let name;
  try {
    name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  } catch {
    return '';
  }
  const namePolicy = targetNamePolicy(options);
  if (
    !name
    || name.length > 100
    || FORMULA_PREFIX_PATTERN.test(name)
    || !STAFF_NAME_PATTERN.test(name)
    || !/\p{L}/u.test(name)
    || namePolicy === 'invalid'
    || (namePolicy === 'test' && !allowedTestName(name))
    || (namePolicy === 'production' && obviousTestName(name))
  ) return '';
  return name;
}

export function normalizedStaffRosterNameKey(value) {
  const name = normalizeStaffRosterName(value);
  return name
    ? name
      .toLocaleLowerCase('en-US')
      .replace(/[\u2018\u2019`\u00b4]/gu, "'")
      .replace(/[\u2010-\u2015\u2212]/gu, '-')
    : '';
}

function sanitizeRosterPerson(input, target) {
  if (!exactObjectKeys(input, ['staffId', 'staffName', 'active'])) return null;
  const staffId = sanitizeStaffRosterId(input.staffId);
  const staffName = normalizeStaffRosterName(input.staffName, { target });
  if (
    !staffId
    || !staffName
    || staffName !== input.staffName
    || typeof input.active !== 'boolean'
  ) return null;
  return Object.freeze({ staffId, staffName, active: input.active });
}

export function sanitizeStaffRosterRequest(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.hasOwn(options, 'target') && !TARGETS.has(options.target)) return null;
  const operation = input.operation;
  if (operation === 'list') {
    return exactObjectKeys(input, ['operation'])
      ? Object.freeze({ operation })
      : null;
  }
  if (!MUTATION_OPERATIONS.has(operation)) return null;
  const requestId = exactRequestId(input.requestId);
  if (!requestId) return null;

  if (operation === 'add') {
    if (!exactObjectKeys(input, ['operation', 'requestId', 'staffName'])) return null;
    const staffName = normalizeStaffRosterName(input.staffName, options);
    return staffName
      ? Object.freeze({ operation, requestId, staffName })
      : null;
  }

  if (!exactObjectKeys(input, ['operation', 'requestId', 'staffId'])) return null;
  const staffId = sanitizeStaffRosterId(input.staffId);
  return staffId
    ? Object.freeze({ operation, requestId, staffId })
    : null;
}

export function sanitizeStaffRosterList(input, expectedTarget = 'test') {
  if (
    !TARGETS.has(expectedTarget)
    || !exactObjectKeys(input, ['ok', 'target', 'staff'])
    || input.ok !== true
    || input.target !== expectedTarget
    || !Array.isArray(input.staff)
    || input.staff.length < 1
    || input.staff.length > 100
  ) return null;

  const staff = [];
  const ids = new Set();
  const names = new Set();
  let activeCount = 0;
  for (const item of input.staff) {
    const person = sanitizeRosterPerson(item, expectedTarget);
    if (!person) return null;
    const nameKey = normalizedStaffRosterNameKey(person.staffName);
    if (!nameKey || ids.has(person.staffId) || names.has(nameKey)) return null;
    ids.add(person.staffId);
    names.add(nameKey);
    if (person.active) activeCount += 1;
    staff.push(person);
  }
  if (activeCount < 1) return null;
  return Object.freeze({ staff: Object.freeze(staff) });
}

export function sanitizeStaffRosterMutation(input, expected, expectedTarget = 'test') {
  if (
    !TARGETS.has(expectedTarget)
    || !expected
    || !MUTATION_OPERATIONS.has(expected.operation)
    || !ADMIN_NAMES.has(expected.adminName)
    || !exactObjectKeys(input, [
      'ok',
      'target',
      'operation',
      'requestId',
      'result',
      'confirmation'
    ])
    || input.ok !== true
    || input.target !== expectedTarget
    || input.operation !== expected.operation
    || input.requestId !== expected.requestId
    || input.result !== RESULT_BY_OPERATION[expected.operation]
    || !exactObjectKeys(input.confirmation, [
      'adminName',
      'staffId',
      'staffName',
      'action',
      'previousActive',
      'newActive'
    ])
  ) return null;

  const confirmation = input.confirmation;
  const staffId = sanitizeStaffRosterId(confirmation.staffId);
  const staffName = normalizeStaffRosterName(confirmation.staffName, {
    target: expectedTarget
  });
  const expectedPrevious = expected.operation === 'add'
    ? null
    : expected.operation === 'deactivate';
  const expectedNew = expected.operation !== 'deactivate';
  if (
    confirmation.adminName !== expected.adminName
    || !staffId
    || !staffName
    || staffName !== confirmation.staffName
    || confirmation.action !== expected.operation
    || confirmation.previousActive !== expectedPrevious
    || confirmation.newActive !== expectedNew
    || (expected.operation === 'add' && staffName !== expected.staffName)
    || (expected.operation !== 'add' && staffId !== expected.staffId)
  ) return null;

  return Object.freeze({
    operation: input.operation,
    requestId: input.requestId,
    result: input.result,
    confirmation: Object.freeze({
      adminName: confirmation.adminName,
      staffId,
      staffName,
      action: confirmation.action,
      previousActive: confirmation.previousActive,
      newActive: confirmation.newActive
    })
  });
}

export function sanitizeStaffRosterConflict(input, expectedTarget = 'test') {
  if (
    !TARGETS.has(expectedTarget)
    || !exactObjectKeys(input, ['ok', 'target', 'result', 'code'])
    || input.ok !== false
    || input.target !== expectedTarget
    || input.result !== 'conflict'
    || typeof input.code !== 'string'
    || !CONFLICT_CODES.has(input.code)
  ) return null;
  return Object.freeze({ code: input.code });
}
