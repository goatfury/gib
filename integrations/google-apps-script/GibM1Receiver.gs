/*
 * Gym in a Box M1 receiver.
 *
 * The Apps Script project supplies these existing configuration constants:
 *   TEST_SPREADSHEET_ID (TEST) or SPREADSHEET_ID (production)
 *   EXPECTED_SPREADSHEET_NAME
 *   SHEET_NAME
 * Private Script Properties keep each capability separate:
 *   GIB_M1_RECEIVER_TRANSPORT_TOKEN
 *   GIB_M1_LEGACY_KIOSK_TOKEN
 *   GIB_M1_ADMIN_ACTION_TOKEN
 *   GIB_M1_RECOVERY_TOKEN
 *   GIB_M1_RECOVERY_WRITE_INCIDENT (present only during a bounded recovery)
 *
 * TEST keeps doPost(e) -> adReceiverV2_(e). The production wrapper may handle
 * its private one-time provisioning POST before preserving this receiver path.
 */

var GIB_M1_AUDIT_SHEET_ = 'Admin Audit';
var GIB_M1_AUDIT_HEADERS_ = [
  'Action Number',
  'Admin Name',
  'Action Time',
  'Instructor',
  'Class Date',
  'Class',
  'Site',
  'Duration',
  'Required Reason',
  'Final Result',
  'Linked Sign-in Record ID'
];
var GIB_M1_ADMIN_NAMES_ = ['Andrew Smith', 'Stuart Turner'];
var GIB_M1_MAX_KIOSK_ROWS_ = 50;
var GIB_M1_MAX_RECOVERY_ROWS_ = 250;
var GIB_M1_RECORD_ID_MAX_ = 240;
var GIB_M1_CLASS_LABEL_MAX_ = 200;
var GIB_M1_INSTRUCTOR_MAX_ = 100;
var GIB_M1_SITE_MAX_ = 80;
var GIB_M1_REVIEW_NOTES_MAX_ = 800;
var GIB_M1_AUDIT_REASON_MAX_ = 240;
var GIB_M1_MAX_SAFE_INTEGER_ = 9007199254740991;
var GIB_M1_RECEIVER_PROPERTY_ = 'GIB_M1_RECEIVER_TRANSPORT_TOKEN';
var GIB_M1_LEGACY_KIOSK_PROPERTY_ = 'GIB_M1_LEGACY_KIOSK_TOKEN';
var GIB_M1_ADMIN_ACTION_PROPERTY_ = 'GIB_M1_ADMIN_ACTION_TOKEN';
var GIB_M1_RECOVERY_PROPERTY_ = 'GIB_M1_RECOVERY_TOKEN';
var GIB_M1_RECOVERY_WRITE_PROPERTY_ = 'GIB_M1_RECOVERY_WRITE_INCIDENT';
var GIB_M1_RECOVERY_INCIDENT_ = 'M1-2026-08-03_04';
var GIB_M1_COLLISION_DEVICE_ = 'Kiosk collision review';
var GIB_M1_COLLISION_STATUS_ = 'REVIEW';
var GIB_M1_TARGET_LOCK_PROPERTY_ = 'GIB_M1_DEPLOYMENT_TARGET_LOCK';
var GIB_M1_PRODUCTION_ROW_ID_PATTERN_ = /^gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var GIB_M1_SIGNINS_HEADERS_ = [
  'RowID',
  'Timestamp',
  'Date',
  'Class Label',
  'Duration (hr)',
  'Instructor',
  'Site',
  'Device',
  'Build',
  'Notes',
  'Status'
];
var GIB_M1_STAFF_TIME_ZONE_ = 'America/New_York';
var GIB_M1_STAFF_PUNCH_ID_PATTERN_ = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var GIB_M1_STAFF_REQUEST_ID_PATTERN_ = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var GIB_M1_STAFF_ID_PATTERN_ = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var GIB_M1_STAFF_PAY_ANCHOR_ = '2026-08-10';
var GIB_M1_STAFF_MAX_SHIFT_MS_ = 18 * 60 * 60 * 1000;
var GIB_M1_STAFF_MAX_STAFF_ = 100;
var GIB_M1_STAFF_RECORD_LIMIT_ = 500;
var GIB_M1_STAFF_AUDIT_LIMIT_ = 500;
var GIB_M1_STAFF_ATTENTION_LIMIT_ = 600;
var GIB_M1_STAFF_PAGE_SIZE_ = 500;
var GIB_M1_STAFF_HISTORY_PAGE_SIZE_ = 50;
var GIB_M1_STAFF_PAGE_MAX_BYTES_ = 80000;
var GIB_M1_STAFF_HISTORY_PAGE_MAX_BYTES_ = 79000;
var GIB_M1_STAFF_CACHE_MAX_BYTES_ = 90000;
var GIB_M1_STAFF_CACHE_TTL_SECONDS_ = 600;
var GIB_M1_STAFF_VIEW_TOKEN_PATTERN_ = /^[0-9a-f]{64}$/;
var GIB_M1_PRODUCTION_STAFF_SHEET_ = 'Staff Clock Staff';
var GIB_M1_PRODUCTION_STAFF_HEADERS_ = ['Staff ID', 'Staff Name', 'Active'];
var GIB_M1_PRODUCTION_STAFF_TIME_SHEET_ = 'Staff Time';
var GIB_M1_PRODUCTION_STAFF_TIME_HEADERS_ = [
  'Punch ID',
  'Timestamp',
  'Date',
  'Staff ID',
  'Staff Name',
  'Action',
  'Site',
  'Device',
  'Build',
  'Note',
  'Status',
  'Source',
  'Admin Name',
  'Linked Punch ID'
];
var GIB_M1_PRODUCTION_STAFF_AUDIT_SHEET_ = 'Staff Time Audit';
var GIB_M1_PRODUCTION_STAFF_AUDIT_HEADERS_ = [
  'Request ID',
  'Action Time',
  'Admin Name',
  'Staff ID',
  'Staff Name',
  'Punch Timestamp',
  'Action',
  'Required Reason',
  'Result',
  'Linked Punch ID'
];
var GIB_M1_PRODUCTION_STAFF_ADJUSTMENT_SHEET_ = 'Staff Time Adjustments';
var GIB_M1_PRODUCTION_STAFF_ADJUSTMENT_HEADERS_ = [
  'Request ID',
  'Action Time',
  'Admin Name',
  'Staff ID',
  'Staff Name',
  'Clock In Punch ID',
  'Clock Out Punch ID',
  'Original Clock In',
  'Original Clock Out',
  'Corrected Clock In',
  'Corrected Clock Out',
  'Changed',
  'Required Reason',
  'Result'
];

function adReceiverV2_(e) {
  try {
    var body = parseRequestBody_(e);
    if (!body) {
      return jsonResult_({
        ok: false,
        result: 'rejected',
        message: 'Request rejected.'
      });
    }

    var action = cleanText_(body.action);
    var legacyKioskRequest = !action && Array.isArray(body.rows);
    if (!action && Array.isArray(body.rows)) action = 'kioskSignIn';

    if (
      action === 'staffClockSnapshot'
      || action === 'staffClockSnapshotV2'
      || action === 'staffClockSnapshotPageV2'
      || action === 'staffClockPunch'
      || action === 'staffTimeReview'
      || action === 'staffTimeReviewV2'
      || action === 'staffTimeReviewPageV2'
      || action === 'staffTimeHistoryPageV2'
      || action === 'staffTimeCorrect'
      || action === 'staffTimeAdjust'
      || action === 'staffTimeVoid'
    ) {
      var staffClockTarget = configuredDeploymentTarget_();
      if (staffClockTarget !== 'test' && staffClockTarget !== 'production') {
        return rejectedAuthResult_();
      }
      if (
        action === 'staffClockSnapshot'
        || action === 'staffClockSnapshotV2'
        || action === 'staffClockSnapshotPageV2'
        || action === 'staffClockPunch'
      ) {
        if (!receiverKioskAuthorized_(body)) return rejectedAuthResult_();
      } else if (!adminActionAuthorized_(body)) {
        return rejectedAuthResult_();
      }
      if (action === 'staffClockSnapshot') return staffClockSnapshotAction_(body);
      if (action === 'staffClockSnapshotV2') return staffClockSnapshotV2Action_(body);
      if (action === 'staffClockSnapshotPageV2') return staffClockSnapshotPageV2Action_(body);
      if (action === 'staffClockPunch') return staffClockPunchAction_(body);
      if (action === 'staffTimeReview') return staffTimeReviewAction_(body);
      if (action === 'staffTimeReviewV2') return staffTimeReviewV2Action_(body);
      if (action === 'staffTimeReviewPageV2') return staffTimeReviewPageV2Action_(body);
      if (action === 'staffTimeHistoryPageV2') return staffTimeHistoryPageV2Action_(body);
      if (action === 'staffTimeCorrect') return staffTimeCorrectAction_(body);
      if (action === 'staffTimeAdjust') return staffTimeAdjustAction_(body);
      return staffTimeVoidAction_(body);
    }

    if (action === 'kioskSignIn') {
      if (legacyKioskRequest) {
        if (!legacyKioskAuthorized_(body)) return rejectedAuthResult_();
        // The compatibility contract exists only for the permanently TEST-
        // locked project. Never infer a target from whichever ID is present.
        if (configuredDeploymentTarget_() === 'test') body.target = 'test';
      } else if (!receiverKioskAuthorized_(body)) {
        return rejectedAuthResult_();
      }
      return kioskSignInAction_(body);
    }
    if (
      action === 'dailyReview'
      || action === 'instructorSearch'
      || action === 'addMissedInstructor'
      || action === 'voidInstructorSignin'
    ) {
      if (!adminActionAuthorized_(body)) return rejectedAuthResult_();
    }
    if (action === 'dailyReview') return dailyReviewAction_(body);
    if (action === 'instructorSearch') return instructorSearchAction_(body);
    if (action === 'addMissedInstructor') return addMissedInstructorAction_(body);
    if (action === 'voidInstructorSignin') return voidInstructorSigninAction_(body);
    if (
      action === 'recoveryList'
      || action === 'recoverSignins'
      || action === 'rollbackRecoveredSignins'
    ) {
      if (!recoveryAuthorized_(body)) return rejectedAuthResult_();
    }
    if (action === 'recoveryList') return recoveryListAction_(body);
    if (action === 'recoverSignins') return recoverSigninsAction_(body);
    if (action === 'rollbackRecoveredSignins') return rollbackRecoveredSigninsAction_(body);

    return jsonResult_({
      ok: false,
      result: 'rejected',
      message: 'Unsupported action.'
    });
  } catch (error) {
    return jsonResult_({
      ok: false,
      result: 'failed',
      message: 'The receiver could not complete the request.'
    });
  }
}

function rejectedAuthResult_() {
  return jsonResult_({
    ok: false,
    result: 'rejected',
    message: 'Request rejected.'
  });
}

function parseRequestBody_(e) {
  var source = e && e.postData && e.postData.contents;
  if (!source || String(source).length > 500000) return null;
  try {
    var value = JSON.parse(String(source));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    return null;
  }
}

function jsonResult_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function cleanText_(value) {
  var text = String(value == null ? '' : value);
  try {
    text = text.normalize('NFKC');
  } catch (error) {}
  return text.trim().replace(/\s+/g, ' ');
}

function exactText_(value) {
  var text = String(value == null ? '' : value);
  try {
    text = text.normalize('NFKC');
  } catch (error) {}
  return text.trim();
}

function normalizeEventText_(value) {
  return cleanText_(value)
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—―−]/g, '-');
}

function safeText_(value, maxLength, allowBlank) {
  var text = cleanText_(value);
  if ((!allowBlank && !text) || text.length > maxLength || /^[=+\-@]/.test(text)) return '';
  return text;
}

function safeExactText_(value, maxLength, allowBlank) {
  var text = exactText_(value);
  if ((!allowBlank && !text) || text.length > maxLength || /^[=+\-@]/.test(text)) return '';
  return text;
}

function constantTimeTextEqual_(left, right) {
  var a = String(left == null ? '' : left);
  var b = String(right == null ? '' : right);
  var mismatch = a.length ^ b.length;
  var maxLength = Math.max(a.length, b.length);
  for (var i = 0; i < maxLength; i += 1) {
    mismatch |= (a.charCodeAt(i % Math.max(1, a.length)) || 0)
      ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  }
  return mismatch === 0;
}

function scriptProperty_(name) {
  try {
    return exactText_(PropertiesService
      .getScriptProperties()
      .getProperty(name));
  } catch (error) {
    return '';
  }
}

function configuredReceiverSecret_() {
  var stored = scriptProperty_(GIB_M1_RECEIVER_PROPERTY_);
  var allowStoredOverride = typeof GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE === 'undefined'
    || GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE === true;
  if (allowStoredOverride && stored) return stored;
  if (typeof gibM1DerivedReceiverSecret_ === 'function') {
    return exactText_(gibM1DerivedReceiverSecret_());
  }
  return '';
}

function configuredAdminActionSecret_() {
  if (typeof gibM1DerivedAdminActionSecret_ === 'function') {
    return exactText_(gibM1DerivedAdminActionSecret_());
  }
  return scriptProperty_(GIB_M1_ADMIN_ACTION_PROPERTY_);
}

function configuredSecretsArePairwiseDistinct_(values) {
  var nonempty = values.filter(Boolean);
  for (var i = 0; i < nonempty.length; i += 1) {
    for (var j = i + 1; j < nonempty.length; j += 1) {
      if (constantTimeTextEqual_(nonempty[i], nonempty[j])) return false;
    }
  }
  return true;
}

function legacyKioskAuthorized_(body) {
  var configured = configuredDeploymentTarget_();
  if (configured && configured !== 'test') return false;
  var legacy = scriptProperty_(GIB_M1_LEGACY_KIOSK_PROPERTY_);
  var receiver = configuredReceiverSecret_();
  var admin = configuredAdminActionSecret_();
  var recovery = scriptProperty_(GIB_M1_RECOVERY_PROPERTY_);
  return Boolean(legacy)
    && configuredSecretsArePairwiseDistinct_([legacy, receiver, admin, recovery])
    && constantTimeTextEqual_(body && body.token, legacy);
}

function configuredDeploymentTarget_() {
  var target = typeof GIB_M1_ALLOWED_TARGET === 'undefined'
    ? ''
    : cleanText_(GIB_M1_ALLOWED_TARGET).toLowerCase();
  return target;
}

function deploymentTargetAllowed_(target) {
  var configured = configuredDeploymentTarget_();
  var requiresPersistedLock = typeof GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK !== 'undefined'
    && GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK === true;
  if (!configured) return !requiresPersistedLock;
  if (
    (configured !== 'test' && configured !== 'production')
    || cleanText_(target).toLowerCase() !== configured
  ) return false;
  return !requiresPersistedLock
    || constantTimeTextEqual_(scriptProperty_(GIB_M1_TARGET_LOCK_PROPERTY_), configured);
}

function receiverKioskAuthorized_(body) {
  var target = cleanText_(body && body.target).toLowerCase();
  if (
    (target !== 'test' && target !== 'production')
    || !deploymentTargetAllowed_(target)
  ) return false;
  var receiver = configuredReceiverSecret_();
  var legacy = scriptProperty_(GIB_M1_LEGACY_KIOSK_PROPERTY_);
  var admin = configuredAdminActionSecret_();
  var recovery = scriptProperty_(GIB_M1_RECOVERY_PROPERTY_);
  return Boolean(receiver)
    && configuredSecretsArePairwiseDistinct_([receiver, legacy, admin, recovery])
    && constantTimeTextEqual_(body && body.token, receiver);
}

function adminActionAuthorized_(body) {
  var target = cleanText_(body && body.target).toLowerCase();
  if (
    (target !== 'test' && target !== 'production')
    || !deploymentTargetAllowed_(target)
  ) return false;
  var receiver = configuredReceiverSecret_();
  var admin = configuredAdminActionSecret_();
  var legacy = scriptProperty_(GIB_M1_LEGACY_KIOSK_PROPERTY_);
  var recovery = scriptProperty_(GIB_M1_RECOVERY_PROPERTY_);
  return Boolean(receiver) && Boolean(admin)
    && configuredSecretsArePairwiseDistinct_([receiver, admin, legacy, recovery])
    && constantTimeTextEqual_(body && body.token, receiver)
    && constantTimeTextEqual_(body && body.adminActionToken, admin);
}

function recoveryAuthorized_(body) {
  var target = cleanText_(body && body.target).toLowerCase();
  if (
    (target !== 'test' && target !== 'production')
    || !deploymentTargetAllowed_(target)
  ) return false;
  var receiver = configuredReceiverSecret_();
  var recovery = scriptProperty_(GIB_M1_RECOVERY_PROPERTY_);
  var legacy = scriptProperty_(GIB_M1_LEGACY_KIOSK_PROPERTY_);
  var admin = configuredAdminActionSecret_();
  return Boolean(receiver) && Boolean(recovery)
    && configuredSecretsArePairwiseDistinct_([receiver, recovery, legacy, admin])
    && constantTimeTextEqual_(body && body.token, receiver)
    && constantTimeTextEqual_(body && body.recoveryToken, recovery);
}

function recoveryWritesEnabled_(body) {
  return constantTimeTextEqual_(body && body.incidentId, GIB_M1_RECOVERY_INCIDENT_)
    && constantTimeTextEqual_(scriptProperty_(GIB_M1_RECOVERY_WRITE_PROPERTY_), GIB_M1_RECOVERY_INCIDENT_);
}

function requestTarget_(body) {
  var target = cleanText_(body && body.target).toLowerCase();
  if (target && target !== 'test' && target !== 'production') {
    throw new Error('Spreadsheet target is not configured.');
  }
  if (!deploymentTargetAllowed_(target)) {
    throw new Error('Spreadsheet target is not allowed by this deployment.');
  }
  if (!target && configuredDeploymentTarget_()) {
    throw new Error('Spreadsheet target is not configured.');
  }
  return target;
}

function configuredSpreadsheetId_(body) {
  var target = requestTarget_(body);
  var testId = typeof TEST_SPREADSHEET_ID === 'undefined'
    ? ''
    : cleanText_(TEST_SPREADSHEET_ID);
  if (!testId && typeof gibM1ResolveTestSpreadsheetId_ === 'function') {
    testId = cleanText_(gibM1ResolveTestSpreadsheetId_());
  }
  var productionId = typeof SPREADSHEET_ID === 'undefined'
    ? ''
    : cleanText_(SPREADSHEET_ID);

  if (target === 'test') {
    if (!testId) {
      throw new Error('TEST spreadsheet is not configured.');
    }
    return testId;
  }
  if (target === 'production') {
    if (!productionId) {
      throw new Error('Production spreadsheet is not configured.');
    }
    return productionId;
  }

  // Preserve the direct legacy {token, rows} contract only when the Apps
  // Script project is unambiguous. Never guess between TEST and production.
  if (Boolean(testId) === Boolean(productionId)) {
    throw new Error('Legacy spreadsheet target is ambiguous.');
  }
  return testId || productionId;
}

function openExpectedSpreadsheet_(body) {
  if (
    typeof EXPECTED_SPREADSHEET_NAME === 'undefined'
    || !cleanText_(EXPECTED_SPREADSHEET_NAME)
  ) {
    throw new Error('Expected spreadsheet identity is not configured.');
  }
  var spreadsheet = SpreadsheetApp.openById(configuredSpreadsheetId_(body));
  if (spreadsheet.getName() !== cleanText_(EXPECTED_SPREADSHEET_NAME)) {
    throw new Error('Spreadsheet identity check failed.');
  }
  return spreadsheet;
}

function signinsSheet_(spreadsheet) {
  var name = typeof SHEET_NAME !== 'undefined' && cleanText_(SHEET_NAME)
    ? cleanText_(SHEET_NAME)
    : 'Signins';
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('Signins tab is missing.');
  return sheet;
}

function displayDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'America/New_York', 'yyyy-MM-dd');
  }
  var text = cleanText_(value);
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[1] + '-' + match[2] + '-' + match[3] : text.slice(0, 10);
}

function canonicalTimestamp_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'America/New_York', 'yyyy-MM-dd HH:mm:ss');
  }
  var text = exactText_(value);
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!match) return '';
  var date = match[1] + '-' + match[2] + '-' + match[3];
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  if (!validCalendarDate_(date) || hour > 23 || minute > 59 || second > 59) return '';
  return date + ' '
    + ('0' + hour).slice(-2) + ':'
    + ('0' + minute).slice(-2) + ':'
    + ('0' + second).slice(-2);
}

function canonicalDuration_(value) {
  var duration = Number(value);
  return isFinite(duration) ? String(duration) : '';
}

function canonicalSigninFields_(record) {
  return [
    canonicalTimestamp_(record && record.timestamp),
    displayDate_(record && record.date),
    exactText_(record && record.classLabel),
    canonicalDuration_(record && record.duration),
    exactText_(record && record.instructor),
    exactText_(record && record.site),
    exactText_(record && record.notes)
  ];
}

function canonicalSigninKey_(record) {
  var fields = canonicalSigninFields_(record);
  if (!fields[0] || !validCalendarDate_(fields[1]) || !fields[2] || !fields[3] || !fields[4] || !fields[5]) {
    return '';
  }
  return JSON.stringify(fields);
}

function sameExactSignin_(record, candidate) {
  var left = canonicalSigninKey_(record);
  var right = canonicalSigninKey_(candidate);
  return activeRecord_(record) && Boolean(left) && left === right;
}

function findExactSignin_(records, candidate) {
  var id = exactText_(candidate && candidate.rowId);
  var idMatches = [];
  for (var i = 0; i < records.length; i += 1) {
    if (id && exactText_(records[i].rowId) === id) idMatches.push(records[i]);
  }
  if (idMatches.length) {
    if (idMatches.length !== 1 || !activeRecord_(idMatches[0])) return { conflict: true };
    return sameExactSignin_(idMatches[0], candidate) ? idMatches[0] : { conflict: true };
  }
  for (var j = 0; j < records.length; j += 1) {
    if (sameExactSignin_(records[j], candidate)) return records[j];
  }
  return null;
}

function validCalendarDate_(value) {
  var text = cleanText_(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  var parts = text.split('-').map(Number);
  var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return date.getUTCFullYear() === parts[0]
    && date.getUTCMonth() === parts[1] - 1
    && date.getUTCDate() === parts[2];
}

function todayNewYork_() {
  return Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
}

function timestampNewYork_() {
  return Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HH:mm:ss');
}

function headerMap_(headers) {
  var map = {};
  headers.forEach(function(header, index) {
    var key = cleanText_(header);
    if (key && typeof map[key] === 'undefined') map[key] = index;
  });
  return map;
}

function firstHeaderIndex_(map, names, fallback) {
  for (var i = 0; i < names.length; i += 1) {
    if (typeof map[names[i]] !== 'undefined') return map[names[i]];
  }
  return typeof fallback === 'number' ? fallback : -1;
}

function readSignins_(sheet, options) {
  options = options || {};
  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error('Signins headings are missing.');
  var headers = values[0].map(cleanText_);
  var requiresExactSchema = typeof GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA !== 'undefined'
    && GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA === true;
  if (requiresExactSchema) {
    var tolerantReview = options.tolerantReview === true;
    if (
      headers.length < GIB_M1_SIGNINS_HEADERS_.length
      || (!tolerantReview && headers.length !== GIB_M1_SIGNINS_HEADERS_.length)
    ) {
      throw new Error('Signins headings do not match the production schema.');
    }
    for (var headerIndex = 0; headerIndex < GIB_M1_SIGNINS_HEADERS_.length; headerIndex += 1) {
      if (headers[headerIndex] !== GIB_M1_SIGNINS_HEADERS_[headerIndex]) {
        throw new Error('Signins headings do not match the production schema.');
      }
    }
    // A human-entered value in a trailing, otherwise-unheaded cell must not
    // collapse read-only Daily Review. Named extra columns remain a schema
    // conflict, and every write path continues to require exactly 11 columns.
    if (tolerantReview) {
      for (var extraHeader = GIB_M1_SIGNINS_HEADERS_.length; extraHeader < headers.length; extraHeader += 1) {
        if (headers[extraHeader]) {
          throw new Error('Signins headings do not match the production schema.');
        }
      }
    }
  }
  var map = headerMap_(headers);
  var indexes = {
    rowId: firstHeaderIndex_(map, ['RowID', 'f']),
    timestamp: firstHeaderIndex_(map, ['Timestamp']),
    date: firstHeaderIndex_(map, ['Date']),
    classLabel: firstHeaderIndex_(map, ['Class Label']),
    duration: firstHeaderIndex_(map, ['Duration (hr)', 'Duration']),
    instructor: firstHeaderIndex_(map, ['Instructor']),
    site: firstHeaderIndex_(map, ['Site']),
    device: firstHeaderIndex_(map, ['Device']),
    build: firstHeaderIndex_(map, ['Build']),
    notes: firstHeaderIndex_(map, ['Notes']),
    status: firstHeaderIndex_(map, ['Status'])
  };
  ['rowId', 'timestamp', 'date', 'classLabel', 'duration', 'instructor', 'site', 'notes'].forEach(function(key) {
    if (indexes[key] < 0) throw new Error('Required Signins heading is missing.');
  });

  var records = values.slice(1).map(function(row, offset) {
    return {
      sheetRow: offset + 2,
      rowId: exactText_(row[indexes.rowId]),
      timestamp: canonicalTimestamp_(row[indexes.timestamp]),
      date: displayDate_(row[indexes.date]),
      classLabel: exactText_(row[indexes.classLabel]),
      duration: Number(row[indexes.duration]),
      instructor: exactText_(row[indexes.instructor]),
      site: exactText_(row[indexes.site]),
      device: indexes.device >= 0 ? cleanText_(row[indexes.device]) : '',
      build: indexes.build >= 0 ? cleanText_(row[indexes.build]) : '',
      notes: indexes.notes >= 0 ? exactText_(row[indexes.notes]) : '',
      status: indexes.status >= 0 ? cleanText_(row[indexes.status]) : ''
    };
  }).filter(function(record) {
    return record.rowId
      || record.timestamp
      || record.date
      || record.classLabel
      || record.instructor;
  });
  return { headers: headers, map: map, indexes: indexes, records: records };
}

function activeRecord_(record) {
  var status = cleanText_(record && record.status).toUpperCase();
  return status !== 'VOID' && status !== 'VOIDED';
}

function sameEvent_(record, candidate) {
  return activeRecord_(record)
    && displayDate_(record.date) === displayDate_(candidate.date)
    && normalizeEventText_(record.instructor) === normalizeEventText_(candidate.instructor)
    && normalizeEventText_(record.classLabel) === normalizeEventText_(candidate.classLabel)
    && normalizeEventText_(record.site) === normalizeEventText_(candidate.site);
}

function findExistingEvent_(records, candidate) {
  var id = cleanText_(candidate.rowId);
  for (var i = 0; i < records.length; i += 1) {
    if (activeRecord_(records[i]) && id && cleanText_(records[i].rowId) === id) return records[i];
  }
  for (var j = 0; j < records.length; j += 1) {
    if (sameEvent_(records[j], candidate)) return records[j];
  }
  return null;
}

function sameAdminRequest_(record, candidate) {
  return activeRecord_(record)
    && exactText_(record.rowId) === exactText_(candidate.rowId)
    && displayDate_(record.date) === displayDate_(candidate.date)
    && exactText_(record.classLabel) === exactText_(candidate.classLabel)
    && canonicalDuration_(record.duration) === canonicalDuration_(candidate.duration)
    && exactText_(record.instructor) === exactText_(candidate.instructor)
    && exactText_(record.site) === exactText_(candidate.site)
    && exactText_(record.device) === exactText_(candidate.device)
    && exactText_(record.build) === exactText_(candidate.build)
    && exactText_(record.notes) === exactText_(candidate.notes);
}

function findPermanentAdminRequest_(records, candidate) {
  var id = exactText_(candidate && candidate.rowId);
  var matches = records.filter(function(record) {
    return id && exactText_(record.rowId) === id;
  });
  if (!matches.length) return null;
  if (matches.length !== 1 || !sameAdminRequest_(matches[0], candidate)) {
    return { conflict: true };
  }
  return matches[0];
}

function adminAddedRecord_(record) {
  return /^admin/i.test(cleanText_(record && record.device))
    || /admin-added/i.test(exactText_(record && record.notes));
}

function collisionReviewRecord_(record) {
  return cleanText_(record && record.device) === GIB_M1_COLLISION_DEVICE_
    || cleanText_(record && record.status).toUpperCase() === GIB_M1_COLLISION_STATUS_;
}

function findAdminCollision_(records, candidate) {
  for (var i = 0; i < records.length; i += 1) {
    if (
      activeRecord_(records[i])
      && adminAddedRecord_(records[i])
      && sameEvent_(records[i], candidate)
      && !sameExactSignin_(records[i], candidate)
    ) return records[i];
  }
  return null;
}

function writeValue_(row, indexes, key, value) {
  if (indexes[key] >= 0) row[indexes[key]] = value;
}

function appendSignin_(sheet, state, record) {
  var row = new Array(state.headers.length);
  for (var i = 0; i < row.length; i += 1) row[i] = '';
  writeValue_(row, state.indexes, 'rowId', record.rowId);
  writeValue_(row, state.indexes, 'timestamp', record.timestamp);
  writeValue_(row, state.indexes, 'date', record.date);
  writeValue_(row, state.indexes, 'classLabel', record.classLabel);
  writeValue_(row, state.indexes, 'duration', record.duration);
  writeValue_(row, state.indexes, 'instructor', record.instructor);
  writeValue_(row, state.indexes, 'site', record.site);
  writeValue_(row, state.indexes, 'device', record.device);
  writeValue_(row, state.indexes, 'build', record.build);
  writeValue_(row, state.indexes, 'notes', record.notes);
  writeValue_(row, state.indexes, 'status', record.status || 'OK');
  var nextRow = sheet.getLastRow() + 1;
  if (nextRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), nextRow - sheet.getMaxRows());
  }
  // Sheets otherwise auto-coerces these canonical strings into serial dates.
  // Plain-text cells preserve the exact retry identity across reads.
  sheet.getRange(nextRow, state.indexes.timestamp + 1, 1, 1).setNumberFormat('@');
  sheet.getRange(nextRow, state.indexes.date + 1, 1, 1).setNumberFormat('@');
  sheet.getRange(nextRow, 1, 1, row.length).setValues([row]);
  record.sheetRow = nextRow;
  state.records.push(record);
}

function validateKioskRow_(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  var value = {
    rowId: safeExactText_(row.RowID || row.rowId, 240, false),
    timestamp: canonicalTimestamp_(row.Timestamp || row.timestamp),
    date: displayDate_(row.Date || row.date),
    classLabel: safeExactText_(row['Class Label'] || row.classLabel, 200, false),
    duration: Number(row['Duration (hr)'] != null ? row['Duration (hr)'] : row.duration),
    instructor: safeExactText_(row.Instructor || row.instructor, 100, false),
    site: safeExactText_(row.Site || row.site, 80, false),
    device: safeText_(row.Device || row.device, 120, true),
    build: safeText_(row.Build || row.build, 120, true),
    notes: safeExactText_(row.Notes || row.notes, 400, true),
    status: 'OK'
  };
  if (
    !value.rowId
    || !value.timestamp
    || !validCalendarDate_(value.date)
    || value.date > todayNewYork_()
    || !value.classLabel
    || !isFinite(value.duration)
    || value.duration <= 0
    || value.duration > 8
    || !value.instructor
    || !value.site
  ) {
    return null;
  }
  return value;
}

function requestedKioskRowId_(row) {
  return safeExactText_(row && (row.RowID || row.rowId), 240, true);
}

function kioskRowResult_(row, result, linkedRecordId) {
  return {
    rowId: requestedKioskRowId_(row),
    result: result,
    linkedRecordId: linkedRecordId || ''
  };
}

function duplicateKioskRowIds_(rows) {
  var seen = {};
  for (var i = 0; i < rows.length; i += 1) {
    var id = requestedKioskRowId_(rows[i]);
    if (!id) continue;
    if (seen[id]) return true;
    seen[id] = true;
  }
  return false;
}

function kioskSignInAction_(body) {
  var target = requestTarget_(body);
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > GIB_M1_MAX_KIOSK_ROWS_) {
    return jsonResult_({
      ok: false,
      target: target,
      result: 'rejected',
      message: 'Rows were rejected.'
    });
  }
  if (duplicateKioskRowIds_(body.rows)) {
    return jsonResult_({
      ok: false,
      target: target,
      result: 'rejected',
      message: 'Duplicate RowIDs were rejected.',
      results: body.rows.map(function(row) {
        return kioskRowResult_(row, 'rejected', '');
      })
    });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResult_({
      ok: false,
      target: target,
      result: 'failed',
      message: 'The receiver was busy. Rows were not changed.',
      results: body.rows.map(function(row) {
        return kioskRowResult_(row, 'failed', '');
      })
    });
  }

  try {
    var spreadsheet = openExpectedSpreadsheet_(body);
    var sheet = signinsSheet_(spreadsheet);
    var state = readSignins_(sheet);
    var results = body.rows.map(function(row) {
      var requestedId = requestedKioskRowId_(row);
      var candidate = validateKioskRow_(row);
      if (candidate && target === 'test' && !obviousTestValue_(candidate.instructor)) {
        candidate = null;
      }
      if (
        candidate
        && target === 'production'
        && !GIB_M1_PRODUCTION_ROW_ID_PATTERN_.test(candidate.rowId)
      ) {
        candidate = null;
      }
      if (!candidate) {
        return { rowId: requestedId, result: 'rejected', linkedRecordId: '' };
      }
      var existing = findExactSignin_(state.records, candidate);
      if (existing && existing.conflict) {
        return { rowId: candidate.rowId, result: 'rejected', linkedRecordId: '' };
      }
      if (existing) {
        return {
          rowId: candidate.rowId,
          result: 'already exists',
          linkedRecordId: existing.rowId
        };
      }
      var adminCollision = findAdminCollision_(state.records, candidate);
      if (adminCollision) {
        candidate.device = GIB_M1_COLLISION_DEVICE_;
        candidate.status = GIB_M1_COLLISION_STATUS_;
      }
      try {
        appendSignin_(sheet, state, candidate);
        return {
          rowId: candidate.rowId,
          result: adminCollision ? 'review required' : 'added',
          linkedRecordId: adminCollision ? adminCollision.rowId : candidate.rowId
        };
      } catch (error) {
        return { rowId: candidate.rowId, result: 'failed', linkedRecordId: '' };
      }
    });
    SpreadsheetApp.flush();
    return jsonResult_({ ok: true, target: target, results: results });
  } finally {
    lock.releaseLock();
  }
}

function bytesToHex_(bytes) {
  return bytes.map(function(value) {
    var byte = value < 0 ? value + 256 : value;
    return ('0' + byte.toString(16)).slice(-2);
  }).join('');
}

function recoverySecret_() {
  return scriptProperty_(GIB_M1_RECOVERY_PROPERTY_);
}

function privateRecoveryFingerprint_(record) {
  var secret = recoverySecret_();
  var key = canonicalSigninKey_(record);
  if (!secret || !key) return '';
  return bytesToHex_(Utilities.computeHmacSha256Signature(
    key,
    secret,
    Utilities.Charset.UTF_8
  ));
}

function targetProof_(spreadsheet) {
  var secret = recoverySecret_();
  if (!secret || !spreadsheet || typeof spreadsheet.getId !== 'function') return '';
  var material = 'gib-m1-target\u001f' + spreadsheet.getId() + '\u001f' + spreadsheet.getName();
  return bytesToHex_(Utilities.computeHmacSha256Signature(
    material,
    secret,
    Utilities.Charset.UTF_8
  ));
}

function validRecoveryId_(value) {
  return /^REC-\d{3,6}$/.test(exactText_(value));
}

function validateRecoveryRow_(row) {
  var recoveryId = exactText_(row && (row.RecoveryID || row.recoveryId));
  if (!validRecoveryId_(recoveryId)) return null;
  var source = row || {};
  var candidate = validateKioskRow_({
    RowID: 'gib-recovery-' + recoveryId,
    Timestamp: source.Timestamp != null ? source.Timestamp : source.timestamp,
    Date: source.Date != null ? source.Date : source.date,
    'Class Label': source['Class Label'] != null ? source['Class Label'] : source.classLabel,
    'Duration (hr)': source['Duration (hr)'] != null ? source['Duration (hr)'] : source.duration,
    Instructor: source.Instructor != null ? source.Instructor : source.instructor,
    Site: source.Site != null ? source.Site : source.site,
    Device: 'M1 incident recovery',
    Build: 'm1-kiosk-sync-incident-repair',
    Notes: source.Notes != null ? source.Notes : source.notes
  });
  if (!candidate) return null;
  candidate.recoveryId = recoveryId;
  return candidate;
}

function findSemanticRecoveryConflict_(records, candidate) {
  var candidateKey = canonicalSigninKey_(candidate);
  for (var i = 0; i < records.length; i += 1) {
    var record = records[i];
    if (!activeRecord_(record)) continue;
    var sameId = exactText_(record.rowId) === exactText_(candidate.rowId);
    var sameEventIdentity = canonicalTimestamp_(record.timestamp) === canonicalTimestamp_(candidate.timestamp)
      && displayDate_(record.date) === displayDate_(candidate.date)
      && exactText_(record.instructor) === exactText_(candidate.instructor)
      && exactText_(record.classLabel) === exactText_(candidate.classLabel)
      && exactText_(record.site) === exactText_(candidate.site);
    if ((sameId || sameEventIdentity) && canonicalSigninKey_(record) !== candidateKey) return record;
  }
  return null;
}

function recoveryRecord_(record) {
  return {
    rowId: record.rowId,
    timestamp: record.timestamp,
    date: record.date,
    classLabel: record.classLabel,
    duration: record.duration,
    instructor: record.instructor,
    site: record.site,
    notes: record.notes,
    fingerprint: privateRecoveryFingerprint_(record)
  };
}

function candidateSetDigest_(candidates) {
  var secret = recoverySecret_();
  if (!secret) return '';
  var material = candidates.map(function(candidate) {
    return candidate.recoveryId + '\u001f' + privateRecoveryFingerprint_(candidate);
  }).sort().join('\n');
  return bytesToHex_(Utilities.computeHmacSha256Signature(
    material,
    secret,
    Utilities.Charset.UTF_8
  ));
}

function recoveryListAction_(body) {
  var fromDate = displayDate_(body && body.fromDate);
  if (!validCalendarDate_(fromDate)) {
    return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery date was rejected.' });
  }
  var spreadsheet = openExpectedSpreadsheet_(body);
  var proof = targetProof_(spreadsheet);
  if (!proof) return rejectedAuthResult_();
  var state = readSignins_(signinsSheet_(spreadsheet));
  var records = state.records.filter(function(record) {
    return activeRecord_(record) && displayDate_(record.date) >= fromDate;
  }).map(recoveryRecord_);
  return jsonResult_({
    ok: true,
    target: requestTarget_(body),
    targetProof: proof,
    records: records
  });
}

function recoverSigninsAction_(body) {
  if (!recoveryWritesEnabled_(body)) {
    return jsonResult_({ ok: false, result: 'disabled', message: 'Recovery writes are disabled.' });
  }
  if (
    !Array.isArray(body.rows)
    || body.rows.length < 1
    || body.rows.length > GIB_M1_MAX_RECOVERY_ROWS_
    || Number(body.expectedCandidateCount) !== body.rows.length
  ) {
    return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery rows were rejected.' });
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResult_({ ok: false, result: 'failed', message: 'The receiver was busy. Rows were not changed.' });
  }
  try {
    var spreadsheet = openExpectedSpreadsheet_(body);
    var proof = targetProof_(spreadsheet);
    if (!proof || !constantTimeTextEqual_(body.expectedTargetProof, proof)) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery target verification failed.' });
    }
    var candidates = body.rows.map(validateRecoveryRow_);
    if (candidates.some(function(candidate) { return !candidate; })) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery rows were malformed.' });
    }
    var candidateIds = {};
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidateIds[candidates[i].recoveryId]) {
        return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery candidate IDs were duplicated.' });
      }
      candidateIds[candidates[i].recoveryId] = true;
    }
    var digest = candidateSetDigest_(candidates);
    if (!digest || !constantTimeTextEqual_(body.expectedCandidateSetDigest, digest)) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery candidate verification failed.' });
    }
    var sheet = signinsSheet_(spreadsheet);
    var state = readSignins_(sheet);
    for (var j = 0; j < candidates.length; j += 1) {
      if (findSemanticRecoveryConflict_(state.records, candidates[j])) {
        return jsonResult_({ ok: false, result: 'conflict', message: 'Recovery conflict detected. Rows were not changed.' });
      }
    }
    var results = [];
    var failed = false;
    candidates.forEach(function(candidate) {
      if (failed) return;
      var existing = findExactSignin_(state.records, candidate);
      if (existing && !existing.conflict) {
        results.push({
          candidateId: candidate.recoveryId,
          rowId: existing.rowId,
          result: 'already exists',
          fingerprint: privateRecoveryFingerprint_(existing)
        });
        return;
      }
      if (existing && existing.conflict) {
        failed = true;
        return;
      }
      try {
        appendSignin_(sheet, state, candidate);
        results.push({
          candidateId: candidate.recoveryId,
          rowId: candidate.rowId,
          result: 'added',
          fingerprint: privateRecoveryFingerprint_(candidate)
        });
      } catch (error) {
        failed = true;
      }
    });
    SpreadsheetApp.flush();
    return jsonResult_({
      ok: !failed,
      result: failed ? 'partial' : 'complete',
      targetProof: proof,
      results: results
    });
  } finally {
    lock.releaseLock();
  }
}

function rollbackRecoveredSigninsAction_(body) {
  if (!recoveryWritesEnabled_(body)) {
    return jsonResult_({ ok: false, result: 'disabled', message: 'Recovery writes are disabled.' });
  }
  if (!Array.isArray(body.receipt) || body.receipt.length < 1 || body.receipt.length > GIB_M1_MAX_RECOVERY_ROWS_) {
    return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery receipt was rejected.' });
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResult_({ ok: false, result: 'failed', message: 'The receiver was busy. Rows were not changed.' });
  }
  try {
    var spreadsheet = openExpectedSpreadsheet_(body);
    var proof = targetProof_(spreadsheet);
    if (!proof || !constantTimeTextEqual_(body.expectedTargetProof, proof)) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery target verification failed.' });
    }
    var sheet = signinsSheet_(spreadsheet);
    var state = readSignins_(sheet);
    var removals = [];
    var seenRowIds = {};
    for (var i = 0; i < body.receipt.length; i += 1) {
      var item = body.receipt[i] || {};
      var candidateId = exactText_(item.candidateId);
      var rowId = exactText_(item.rowId);
      var fingerprint = exactText_(item.fingerprint);
      if (
        !validRecoveryId_(candidateId)
        || rowId !== 'gib-recovery-' + candidateId
        || !/^[a-f0-9]{64}$/.test(fingerprint)
        || seenRowIds[rowId]
      ) {
        return jsonResult_({ ok: false, result: 'rejected', message: 'Recovery receipt verification failed.' });
      }
      seenRowIds[rowId] = true;
      var matches = state.records.filter(function(record) {
        return activeRecord_(record) && exactText_(record.rowId) === rowId;
      });
      if (
        matches.length !== 1
        || !constantTimeTextEqual_(privateRecoveryFingerprint_(matches[0]), fingerprint)
      ) {
        return jsonResult_({ ok: false, result: 'conflict', message: 'Recovery rollback verification failed. Rows were not changed.' });
      }
      removals.push(matches[0]);
    }
    removals.sort(function(left, right) { return right.sheetRow - left.sheetRow; });
    removals.forEach(function(record) { sheet.deleteRow(record.sheetRow); });
    SpreadsheetApp.flush();
    return jsonResult_({ ok: true, result: 'rolled back', removed: removals.length, targetProof: proof });
  } finally {
    lock.releaseLock();
  }
}

function reviewDisplayId_(record) {
  var sheetRow = Number(record && record.sheetRow);
  if (!isFinite(sheetRow) || sheetRow < 2 || Math.floor(sheetRow) !== sheetRow) {
    throw new Error('Review row identity is unavailable.');
  }
  return 'sheet-row-' + sheetRow;
}

function manualRecord_(record) {
  return !exactText_(record && record.rowId)
    || !canonicalTimestamp_(record && record.timestamp)
    || !cleanText_(record && record.device)
    || !cleanText_(record && record.build)
    || !cleanText_(record && record.status);
}

function reviewRecordIssue_(record) {
  if (!validCalendarDate_(displayDate_(record && record.date))) return 'date';
  var classLabel = exactText_(record && record.classLabel);
  if (!classLabel || classLabel.length > GIB_M1_CLASS_LABEL_MAX_) return 'class';
  var duration = Number(record && record.duration);
  if (!isFinite(duration) || duration <= 0 || duration > 8) return 'duration';
  var instructor = exactText_(record && record.instructor);
  if (!instructor || instructor.length > GIB_M1_INSTRUCTOR_MAX_) return 'instructor';
  var site = exactText_(record && record.site);
  if (!site || site.length > GIB_M1_SITE_MAX_) return 'site';
  return '';
}

function unreadableWarning_(record) {
  return {
    displayId: reviewDisplayId_(record),
    code: 'UNREADABLE_SIGNIN',
    message: 'One Sheet row for this date is incomplete and was not included.'
  };
}

function unreadableDateWarning_(record) {
  return {
    displayId: reviewDisplayId_(record),
    code: 'UNREADABLE_SIGNIN_DATE',
    message: 'One Sheet row has an unreadable date and was not included.'
  };
}

function publicRecord_(record, options) {
  var reviewRequired = collisionReviewRecord_(record);
  var value = {
    displayId: reviewDisplayId_(record),
    recordId: exactText_(record.rowId).slice(0, GIB_M1_RECORD_ID_MAX_),
    timestamp: record.timestamp,
    date: record.date,
    classLabel: record.classLabel,
    duration: record.duration,
    instructor: record.instructor,
    site: record.site,
    notes: exactText_(record.notes).slice(0, GIB_M1_REVIEW_NOTES_MAX_),
    source: reviewRequired
      ? 'Collision review'
      : (adminAddedRecord_(record) ? 'Admin-added' : (manualRecord_(record) ? 'Manual' : 'Kiosk')),
    reviewRequired: reviewRequired,
    reviewMessage: reviewRequired ? 'Possible Admin/kiosk duplicate — review before payroll.' : ''
  };
  if (options && options.includeRichmondVoidEligibility === true) {
    value.voidEligible = options.richmondWritesEnabled === true
      && richmondInstructorSigninVoidEligible_(
        record,
        exactText_(record.rowId),
        options.allRecords
      );
  }
  return value;
}

function dailyReviewAction_(body) {
  var date = displayDate_(body.date);
  if (!validCalendarDate_(date) || date > todayNewYork_()) {
    return jsonResult_({ ok: false, result: 'rejected', message: 'Choose a non-future date.' });
  }
  var spreadsheet = openExpectedSpreadsheet_(body);
  var state = readSignins_(signinsSheet_(spreadsheet), { tolerantReview: true });
  var includeRichmondVoidEligibility = richmondProductionDailyReviewVoidEligibilityContext_(
    body,
    spreadsheet
  );
  var richmondWritesEnabled = includeRichmondVoidEligibility
    && gibM1RichmondProductionWritesEnabled_();
  var records = [];
  var warnings = [];
  state.records.forEach(function(record) {
    if (!activeRecord_(record)) return;
    if (!validCalendarDate_(record.date)) {
      warnings.push(unreadableDateWarning_(record));
      return;
    }
    if (record.date !== date) return;
    if (reviewRecordIssue_(record)) {
      warnings.push(unreadableWarning_(record));
      return;
    }
    records.push(publicRecord_(record, {
      includeRichmondVoidEligibility: includeRichmondVoidEligibility,
      richmondWritesEnabled: richmondWritesEnabled,
      allRecords: state.records
    }));
  });
  var audit = readAdminAuditHistory_(spreadsheet, date);
  warnings = warnings.concat(audit.warnings);
  return jsonResult_({
    ok: true,
    date: date,
    records: records,
    warnings: warnings,
    auditHistory: audit.history
  });
}

function instructorSearchAction_(body) {
  var date = displayDate_(body.date);
  var instructor = safeText_(body.instructor, 100, false);
  if (!instructor || !validCalendarDate_(date) || date > todayNewYork_()) {
    return jsonResult_({ ok: false, result: 'rejected', message: 'Enter an instructor and non-future date.' });
  }
  if (requestTarget_(body) === 'test' && !obviousTestValue_(instructor)) {
    return jsonResult_({ ok: false, result: 'rejected', message: 'Use fake TEST instructor information.' });
  }
  var spreadsheet = openExpectedSpreadsheet_(body);
  var state = readSignins_(signinsSheet_(spreadsheet), { tolerantReview: true });
  var key = normalizeEventText_(instructor);
  var matches = state.records.filter(function(record) {
    return activeRecord_(record)
      && !reviewRecordIssue_(record)
      && record.date <= todayNewYork_()
      && normalizeEventText_(record.instructor) === key;
  });
  var selectedDateRecords = matches
    .filter(function(record) { return record.date === date; })
    .map(publicRecord_);
  var recentRecords = matches.slice().sort(function(a, b) {
    return cleanText_(b.timestamp).localeCompare(cleanText_(a.timestamp));
  }).slice(0, 5).map(publicRecord_);
  return jsonResult_({
    ok: true,
    instructor: instructor,
    date: date,
    selectedDateRecords: selectedDateRecords,
    recentRecords: recentRecords
  });
}

function obviousTestValue_(value) {
  return /\b(test|fake|demo|qa)\b|do not pay/i.test(cleanText_(value));
}

function richmondInstructorVoidAuditContractEnabled_() {
  return typeof GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ !== 'undefined'
    && typeof GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_ !== 'undefined'
    && typeof GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_ !== 'undefined'
    && typeof GIB_M1_STAFF_CLOCK_ENABLED !== 'undefined'
    && configuredDeploymentTarget_() === 'production'
    && GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ === 'richmond'
    && GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_ === 'production'
    && GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_ === 'Richmond BJJ M1 — PRODUCTION'
    && GIB_M1_STAFF_CLOCK_ENABLED === false;
}

function adminAuditValues_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error('Admin Audit headings are missing.');
  var headings = values[0].map(cleanText_);
  if (headings.length < GIB_M1_AUDIT_HEADERS_.length) {
    throw new Error('Admin Audit headings do not match.');
  }
  for (var headingIndex = 0; headingIndex < GIB_M1_AUDIT_HEADERS_.length; headingIndex += 1) {
    if (headings[headingIndex] !== GIB_M1_AUDIT_HEADERS_[headingIndex]) {
      throw new Error('Admin Audit headings do not match.');
    }
  }
  for (var extraHeading = GIB_M1_AUDIT_HEADERS_.length; extraHeading < headings.length; extraHeading += 1) {
    if (headings[extraHeading]) throw new Error('Admin Audit headings do not match.');
  }
  return values;
}

function readAdminAuditHistory_(spreadsheet, date) {
  var sheet = spreadsheet.getSheetByName(GIB_M1_AUDIT_SHEET_);
  if (!sheet) return { history: [], warnings: [] };
  try {
    var values = adminAuditValues_(sheet);

    var history = [];
    var warnings = [];
    values.slice(1).forEach(function(row, offset) {
      var classDate = displayDate_(row[4]);
      if (classDate !== date) return;
      var actionNumber = Number(row[0]);
      var actionTime = canonicalTimestamp_(row[2]);
      var duration = Number(row[7]);
      var result = cleanText_(row[9]).toLowerCase();
      var auditId = 'audit-row-' + (offset + 2);
      if (
        !isFinite(actionNumber)
        || actionNumber < 1
        || Math.floor(actionNumber) !== actionNumber
        || actionNumber > GIB_M1_MAX_SAFE_INTEGER_
        || GIB_M1_ADMIN_NAMES_.indexOf(cleanText_(row[1])) === -1
        || !actionTime
        || !exactText_(row[3])
        || exactText_(row[3]).length > GIB_M1_INSTRUCTOR_MAX_
        || !exactText_(row[5])
        || exactText_(row[5]).length > GIB_M1_CLASS_LABEL_MAX_
        || !exactText_(row[6])
        || exactText_(row[6]).length > GIB_M1_SITE_MAX_
        || !isFinite(duration)
        || duration <= 0
        || duration > 8
        || !exactText_(row[8])
        || exactText_(row[8]).length > GIB_M1_AUDIT_REASON_MAX_
        || (
          result !== 'added'
          && result !== 'already exists'
          && !(result === 'voided' && richmondInstructorVoidAuditContractEnabled_())
        )
        || exactText_(row[10]).length > GIB_M1_RECORD_ID_MAX_
        || (result === 'added' && exactText_(row[10]).indexOf('gib-admin-') !== 0)
        || (result === 'voided' && !GIB_M1_PRODUCTION_ROW_ID_PATTERN_.test(exactText_(row[10])))
      ) {
        warnings.push({
          displayId: auditId,
          code: 'UNREADABLE_AUDIT',
          message: 'One Daily Review audit row for this date is incomplete and was not included.'
        });
        return;
      }
      history.push({
        auditId: auditId,
        actionNumber: actionNumber,
        adminName: cleanText_(row[1]),
        actionTime: actionTime,
        instructor: exactText_(row[3]),
        classDate: classDate,
        classLabel: exactText_(row[5]),
        site: exactText_(row[6]),
        duration: duration,
        reason: exactText_(row[8]),
        result: result,
        linkedRecordId: exactText_(row[10])
      });
    });
    history.sort(function(left, right) { return right.actionNumber - left.actionNumber; });
    return { history: history, warnings: warnings };
  } catch (error) {
    return {
      history: [],
      warnings: [{
        displayId: 'audit-history',
        code: 'AUDIT_UNAVAILABLE',
        message: 'Daily Review audit history could not be read.'
      }]
    };
  }
}

function adminAuditSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(GIB_M1_AUDIT_SHEET_);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(GIB_M1_AUDIT_SHEET_);
    sheet.getRange(1, 1, 1, GIB_M1_AUDIT_HEADERS_.length).setValues([GIB_M1_AUDIT_HEADERS_]);
    sheet.setFrozenRows(1);
  } else {
    adminAuditValues_(sheet);
  }
  return sheet;
}

function nextAuditActionNumber_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var highest = 0;
  values.forEach(function(row) {
    var value = Number(row[0]);
    if (
      !isFinite(value)
      || value < 1
      || Math.floor(value) !== value
      || value > GIB_M1_MAX_SAFE_INTEGER_
    ) throw new Error('Admin Audit action number is invalid.');
    if (value > highest) highest = value;
  });
  if (highest >= GIB_M1_MAX_SAFE_INTEGER_) throw new Error('Admin Audit action number is exhausted.');
  return highest + 1;
}

function appendAdminAudit_(sheet, value, result, linkedRecordId) {
  var linkedId = boundedAdminLinkedRecordId_(linkedRecordId);
  if (
    (
      result !== 'added'
      && result !== 'already exists'
      && !(result === 'voided' && richmondInstructorVoidAuditContractEnabled_())
    )
    || linkedId !== exactText_(linkedRecordId)
  ) {
    throw new Error('Admin Audit result is invalid.');
  }
  var actionNumber = nextAuditActionNumber_(sheet);
  sheet.appendRow([
    actionNumber,
    value.adminName,
    timestampNewYork_(),
    value.instructor,
    value.date,
    value.classLabel,
    value.site,
    value.duration,
    value.reason,
    result,
    linkedId
  ]);
  return actionNumber;
}

function boundedAdminLinkedRecordId_(value) {
  return safeExactText_(value, GIB_M1_RECORD_ID_MAX_, true);
}

function sameExactAdminAudit_(row, value, result, linkedRecordId) {
  return Boolean(canonicalTimestamp_(row[2]))
    && exactText_(row[1]) === value.adminName
    && exactText_(row[3]) === value.instructor
    && displayDate_(row[4]) === value.date
    && exactText_(row[5]) === value.classLabel
    && exactText_(row[6]) === value.site
    && canonicalDuration_(row[7]) === canonicalDuration_(value.duration)
    && exactText_(row[8]) === value.reason
    && cleanText_(row[9]).toLowerCase() === result
    && exactText_(row[10]) === linkedRecordId;
}

function existingExactAdminAuditNumber_(sheet, value, result, linkedRecordId) {
  var values = adminAuditValues_(sheet);
  var matches = [];
  values.slice(1).forEach(function(row) {
    if (sameExactAdminAudit_(row, value, result, linkedRecordId)) {
      matches.push(Number(row[0]));
    }
  });
  if (
    matches.length > 1
    || (
      matches.length === 1
      && (
        !isFinite(matches[0])
        || matches[0] < 1
        || Math.floor(matches[0]) !== matches[0]
        || matches[0] > GIB_M1_MAX_SAFE_INTEGER_
      )
    )
  ) {
    throw new Error('Admin Audit replay state is ambiguous.');
  }
  return matches.length ? matches[0] : 0;
}

function ensureAdminAudit_(sheet, value, result, linkedRecordId) {
  var linkedId = boundedAdminLinkedRecordId_(linkedRecordId);
  if (linkedId !== exactText_(linkedRecordId)) {
    throw new Error('Admin Audit linked record is invalid.');
  }
  return existingExactAdminAuditNumber_(sheet, value, result, linkedId)
    || appendAdminAudit_(sheet, value, result, linkedId);
}

function adminAdditionConfirmation_(value) {
  return {
    adminName: value.adminName,
    date: value.date,
    classLabel: value.classLabel,
    duration: value.duration,
    instructor: value.instructor,
    site: value.site,
    reason: value.reason,
    notes: value.notes
  };
}

function adminAttributedNotes_(value) {
  var notes = 'Admin-added | Admin: ' + value.adminName
    + ' | Reason: ' + value.reason
    + (value.notes ? ' | Notes: ' + value.notes : '');
  if (notes.length > GIB_M1_REVIEW_NOTES_MAX_) {
    throw new Error('Admin note attribution exceeds the review limit.');
  }
  return notes;
}

function completedAdminAddition_(result, value, record, linkedRecordId, auditActionNumber) {
  var linkedId = boundedAdminLinkedRecordId_(linkedRecordId);
  if (linkedId !== exactText_(linkedRecordId)) {
    throw new Error('Admin addition linked record is invalid.');
  }
  return jsonResult_({
    ok: true,
    result: result,
    requestId: value.requestId,
    linkedRecordId: linkedId,
    linkedDisplayId: reviewDisplayId_(record),
    auditActionNumber: auditActionNumber,
    confirmation: adminAdditionConfirmation_(value)
  });
}

function validateAdminAddition_(body, spreadsheet) {
  if (
    typeof body.requestId !== 'string'
    || typeof body.adminName !== 'string'
    || typeof body.date !== 'string'
    || typeof body.classLabel !== 'string'
    || typeof body.duration !== 'number'
    || typeof body.instructor !== 'string'
    || typeof body.site !== 'string'
    || typeof body.notes !== 'string'
    || typeof body.reason !== 'string'
  ) return null;
  var value = {
    requestId: safeText_(body.requestId, 160, false),
    adminName: safeText_(body.adminName, 80, false),
    date: displayDate_(body.date),
    classLabel: safeText_(body.classLabel, 200, false),
    duration: Number(body.duration),
    instructor: safeText_(body.instructor, 100, false),
    site: safeText_(body.site, 80, false),
    notes: safeText_(body.notes, 400, true),
    reason: safeText_(body.reason, 240, false)
  };
  if (
    !value.requestId
    || GIB_M1_ADMIN_NAMES_.indexOf(value.adminName) === -1
    || !validCalendarDate_(value.date)
    || value.date > todayNewYork_()
    || !value.classLabel
    || !isFinite(value.duration)
    || value.duration <= 0
    || value.duration > 8
    || !value.instructor
    || !value.site
    || value.reason.length < 3
  ) {
    return null;
  }
  if (/^TEST ONLY\b/i.test(spreadsheet.getName()) && !obviousTestValue_(value.instructor)) {
    return null;
  }
  return value;
}

function addMissedInstructorAction_(body) {
  if (requestTarget_(body) === 'test' && !obviousTestValue_(body.instructor)) {
    return jsonResult_({
      ok: false,
      result: 'rejected',
      message: 'Use fake TEST instructor information.'
    });
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResult_({
      ok: false,
      result: 'failed',
      message: 'The receiver was busy. Nothing changed.'
    });
  }

  try {
    var spreadsheet = openExpectedSpreadsheet_(body);
    var value = validateAdminAddition_(body, spreadsheet);
    if (!value) {
      return jsonResult_({
        ok: false,
        result: 'rejected',
        message: 'The Admin addition was rejected.'
      });
    }

    var sheet = signinsSheet_(spreadsheet);
    var state = readSignins_(sheet);
    var candidate = {
      rowId: 'gib-admin-' + value.requestId,
      timestamp: timestampNewYork_(),
      date: value.date,
      classLabel: value.classLabel,
      duration: value.duration,
      instructor: value.instructor,
      site: value.site,
      device: 'Admin Daily Review',
      build: 'm1-unified-august-rollout-2026',
      notes: adminAttributedNotes_(value),
      status: 'OK'
    };
    var permanentRequest = findPermanentAdminRequest_(state.records, candidate);
    if (permanentRequest && permanentRequest.conflict) {
      return jsonResult_({
        ok: false,
        result: 'rejected',
        message: 'The Admin request ID conflicts with an existing record.'
      });
    }
    var duplicateEligibleRecords = state.records.filter(function(record) {
      return !reviewRecordIssue_(record);
    });
    var existing = permanentRequest || findExistingEvent_(duplicateEligibleRecords, candidate);
    var auditSheet = adminAuditSheet_(spreadsheet);

    if (permanentRequest) {
      var permanentLinkedId = boundedAdminLinkedRecordId_(permanentRequest.rowId);
      var permanentAuditNumber = ensureAdminAudit_(auditSheet, value, 'added', permanentLinkedId);
      SpreadsheetApp.flush();
      return completedAdminAddition_('added', value, permanentRequest, permanentLinkedId, permanentAuditNumber);
    }

    if (existing) {
      var existingLinkedId = boundedAdminLinkedRecordId_(existing.rowId);
      var existingAuditNumber = ensureAdminAudit_(
        auditSheet,
        value,
        'already exists',
        existingLinkedId
      );
      SpreadsheetApp.flush();
      return completedAdminAddition_(
        'already exists',
        value,
        existing,
        existingLinkedId,
        existingAuditNumber
      );
    }

    appendSignin_(sheet, state, candidate);
    var candidateLinkedId = boundedAdminLinkedRecordId_(candidate.rowId);
    var actionNumber = ensureAdminAudit_(auditSheet, value, 'added', candidateLinkedId);
    SpreadsheetApp.flush();
    return completedAdminAddition_('added', value, candidate, candidateLinkedId, actionNumber);
  } catch (error) {
    return jsonResult_({
      ok: false,
      result: 'failed',
      message: 'The Admin addition failed.'
    });
  } finally {
    lock.releaseLock();
  }
}

function richmondProductionInstructorVoidProfileValid_(body) {
  if (
    typeof GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ === 'undefined'
    || typeof GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_ === 'undefined'
    || typeof GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_ === 'undefined'
    || typeof GIB_M1_RICHMOND_PRODUCTION_DEVICE_ === 'undefined'
    || typeof GIB_M1_RICHMOND_PRODUCTION_SITE_ === 'undefined'
    || typeof GIB_M1_RICHMOND_PRODUCTION_AUDIT_HEADERS_ === 'undefined'
    || typeof GIB_M1_RICHMOND_PRODUCTION_VOID_ELIGIBILITY_VERSION_ === 'undefined'
    || typeof GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA === 'undefined'
    || typeof GIB_M1_STAFF_CLOCK_ENABLED === 'undefined'
    || typeof gibM1RichmondProductionWritesEnabled_ !== 'function'
  ) return false;
  return configuredDeploymentTarget_() === 'production'
    && constantTimeTextEqual_(body && body.target, 'production')
    && constantTimeTextEqual_(body && body.installation, GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_)
    && constantTimeTextEqual_(body && body.environment, GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_)
    && GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ === 'richmond'
    && GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_ === 'production'
    && GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_ === 'Richmond BJJ M1 — PRODUCTION'
    && GIB_M1_RICHMOND_PRODUCTION_SITE_ === 'Richmond'
    && GIB_M1_RICHMOND_PRODUCTION_DEVICE_ === 'Richmond Front Desk Tablet'
    && GIB_M1_RICHMOND_PRODUCTION_VOID_ELIGIBILITY_VERSION_ === 'richmond-instructor-void-v1'
    && GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA === true
    && GIB_M1_STAFF_CLOCK_ENABLED === false
    && GIB_M1_RICHMOND_PRODUCTION_AUDIT_HEADERS_.length === GIB_M1_AUDIT_HEADERS_.length
    && GIB_M1_RICHMOND_PRODUCTION_AUDIT_HEADERS_.every(function(header, index) {
      return header === GIB_M1_AUDIT_HEADERS_[index];
    });
}

function richmondProductionInstructorVoidEnabled_(body) {
  return cleanText_(body && body.action) === 'voidInstructorSignin'
    && richmondProductionInstructorVoidProfileValid_(body)
    && gibM1RichmondProductionWritesEnabled_();
}

function richmondProductionDailyReviewVoidEligibilityContext_(body, spreadsheet) {
  return cleanText_(body && body.action) === 'dailyReview'
    && richmondProductionInstructorVoidProfileValid_(body)
    && constantTimeTextEqual_(
      body && body.voidEligibilityVersion,
      GIB_M1_RICHMOND_PRODUCTION_VOID_ELIGIBILITY_VERSION_
    )
    && spreadsheet
    && typeof spreadsheet.getName === 'function'
    && spreadsheet.getName() === GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_;
}

function validateRichmondInstructorVoid_(body, spreadsheet) {
  if (
    typeof body.requestId !== 'string'
    || typeof body.rowId !== 'string'
    || typeof body.adminName !== 'string'
    || typeof body.reason !== 'string'
  ) return null;
  var value = {
    requestId: safeExactText_(body.requestId, 320, false),
    rowId: safeExactText_(body.rowId, GIB_M1_RECORD_ID_MAX_, false),
    adminName: safeText_(body.adminName, 80, false),
    reason: safeText_(body.reason, GIB_M1_AUDIT_REASON_MAX_, false)
  };
  if (
    value.requestId !== body.requestId
    || value.rowId !== body.rowId
    || value.adminName !== body.adminName
    || value.reason !== body.reason
    || !GIB_M1_PRODUCTION_ROW_ID_PATTERN_.test(value.rowId)
    || value.requestId !== 'gib-m1-admin-void-' + value.rowId
    || GIB_M1_ADMIN_NAMES_.indexOf(value.adminName) === -1
    || value.reason.length < 3
    || spreadsheet.getName() !== GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_
  ) return null;
  return value;
}

function validRichmondInstructorSigninForVoidBase_(record, rowId) {
  var timestamp = canonicalTimestamp_(record && record.timestamp);
  var date = displayDate_(record && record.date);
  var notes = safeText_(record && record.notes, 400, true);
  return exactText_(record && record.rowId) === rowId
    && GIB_M1_PRODUCTION_ROW_ID_PATTERN_.test(rowId)
    && Boolean(timestamp)
    && validCalendarDate_(date)
    && timestamp.slice(0, 10) === date
    && date <= todayNewYork_()
    && !reviewRecordIssue_(record)
    && safeText_(record && record.classLabel, GIB_M1_CLASS_LABEL_MAX_, false) === record.classLabel
    && safeText_(record && record.instructor, GIB_M1_INSTRUCTOR_MAX_, false) === record.instructor
    && !gibM1RichmondProductionObviousTestValue_(record && record.instructor)
    && exactText_(record && record.site) === GIB_M1_RICHMOND_PRODUCTION_SITE_
    && cleanText_(record && record.device) === GIB_M1_RICHMOND_PRODUCTION_DEVICE_
    && safeText_(record && record.build, 120, false) === record.build
    && notes === exactText_(record && record.notes)
    && !adminAddedRecord_(record)
    && !collisionReviewRecord_(record)
    && !manualRecord_(record);
}

function validRichmondInstructorSigninForVoid_(record, rowId) {
  var status = cleanText_(record && record.status);
  return validRichmondInstructorSigninForVoidBase_(record, rowId)
    && (status === 'OK' || status === 'VOID');
}

function uniqueRichmondInstructorSigninForVoid_(records, rowId) {
  if (!Array.isArray(records) || !rowId) return null;
  var matches = records.filter(function(candidate) {
    return exactText_(candidate && candidate.rowId) === rowId;
  });
  return matches.length === 1 ? matches[0] : null;
}

function richmondInstructorSigninVoidEligible_(record, rowId, records) {
  return validRichmondInstructorSigninForVoidBase_(record, rowId)
    && cleanText_(record && record.status) === 'OK'
    && uniqueRichmondInstructorSigninForVoid_(records, rowId) === record;
}

function richmondInstructorVoidAuditValue_(value, record) {
  return {
    adminName: value.adminName,
    instructor: record.instructor,
    date: record.date,
    classLabel: record.classLabel,
    site: record.site,
    duration: record.duration,
    reason: value.reason
  };
}

function existingRichmondInstructorVoidAudit_(sheet, value, rowId) {
  var values = adminAuditValues_(sheet);
  var matches = [];
  var actionNumbers = {};
  values.slice(1).forEach(function(row) {
    var actionNumber = Number(row[0]);
    if (
      !isFinite(actionNumber)
      || actionNumber < 1
      || Math.floor(actionNumber) !== actionNumber
      || actionNumber > GIB_M1_MAX_SAFE_INTEGER_
      || actionNumbers[String(actionNumber)]
    ) throw new Error('Admin Audit action number is invalid or duplicated.');
    actionNumbers[String(actionNumber)] = true;
    var result = cleanText_(row[9]).toLowerCase();
    if (
      exactText_(row[10]) === rowId
      && (result === 'voided' || result === 'already voided')
    ) matches.push(row);
  });
  if (matches.length > 1) throw new Error('Instructor void audit replay state is ambiguous.');
  if (!matches.length) return { actionNumber: 0, conflict: false };
  var row = matches[0];
  var actionNumber = Number(row[0]);
  if (
    cleanText_(row[9]).toLowerCase() !== 'voided'
    || !sameExactAdminAudit_(row, value, 'voided', rowId)
  ) return { actionNumber: 0, conflict: true };
  return { actionNumber: actionNumber, conflict: false };
}

function completedRichmondInstructorVoid_(result, value, record, auditActionNumber) {
  if (
    (result !== 'voided' && result !== 'already voided')
    || !Number.isSafeInteger(auditActionNumber)
    || auditActionNumber < 1
  ) throw new Error('Instructor void confirmation is invalid.');
  return jsonResult_({
    ok: true,
    result: result,
    requestId: value.requestId,
    linkedRecordId: value.rowId,
    auditActionNumber: auditActionNumber,
    confirmation: {
      adminName: value.adminName,
      rowId: record.rowId,
      timestamp: record.timestamp,
      date: record.date,
      classLabel: record.classLabel,
      duration: record.duration,
      instructor: record.instructor,
      site: record.site,
      device: record.device,
      build: record.build,
      notes: record.notes,
      status: 'VOID',
      reason: value.reason
    }
  });
}

function voidInstructorSigninAction_(body) {
  if (!richmondProductionInstructorVoidEnabled_(body)) return rejectedAuthResult_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResult_({
      ok: false,
      result: 'failed',
      message: 'The receiver was busy. Nothing changed.'
    });
  }

  try {
    if (!richmondProductionInstructorVoidEnabled_(body)) return rejectedAuthResult_();
    var spreadsheet = openExpectedSpreadsheet_(body);
    var value = validateRichmondInstructorVoid_(body, spreadsheet);
    if (!value) {
      return jsonResult_({
        ok: false,
        result: 'rejected',
        message: 'The instructor sign-in void was rejected.'
      });
    }

    var sheetNames = spreadsheet.getSheets().map(function(candidateSheet) {
      return candidateSheet.getName();
    }).sort();
    if (sheetNames.join('|') !== 'Admin Audit|Signins') {
      throw new Error('Richmond production Sheet tabs are invalid.');
    }

    var sheet = signinsSheet_(spreadsheet);
    var state = readSignins_(sheet);
    var record = uniqueRichmondInstructorSigninForVoid_(state.records, value.rowId);
    if (!record || !validRichmondInstructorSigninForVoid_(record, value.rowId)) {
      return jsonResult_({
        ok: false,
        result: 'rejected',
        message: 'The instructor sign-in row was not eligible for void.'
      });
    }

    var auditSheet = spreadsheet.getSheetByName(GIB_M1_AUDIT_SHEET_);
    if (!auditSheet) throw new Error('Admin Audit tab is missing.');
    if (auditSheet.getLastColumn() !== GIB_M1_AUDIT_HEADERS_.length) {
      throw new Error('Admin Audit columns do not match.');
    }
    var auditValue = richmondInstructorVoidAuditValue_(value, record);
    var existingAudit = existingRichmondInstructorVoidAudit_(auditSheet, auditValue, value.rowId);
    if (existingAudit.conflict) {
      return jsonResult_({
        ok: false,
        result: 'rejected',
        message: 'The instructor sign-in void conflicts with its audit history.'
      });
    }

    var status = cleanText_(record.status);
    if (status === 'VOID') {
      if (!existingAudit.actionNumber) {
        return jsonResult_({
          ok: false,
          result: 'rejected',
          message: 'The instructor sign-in void is missing its audit history.'
        });
      }
      return completedRichmondInstructorVoid_(
        'already voided',
        value,
        record,
        existingAudit.actionNumber
      );
    }
    if (status !== 'OK') {
      return jsonResult_({
        ok: false,
        result: 'rejected',
        message: 'The instructor sign-in row was not eligible for void.'
      });
    }

    var actionNumber = existingAudit.actionNumber;
    if (!actionNumber) {
      if (!gibM1RichmondProductionWritesEnabled_()) return rejectedAuthResult_();
      actionNumber = appendAdminAudit_(auditSheet, auditValue, 'voided', value.rowId);
      SpreadsheetApp.flush();
    }
    if (!gibM1RichmondProductionWritesEnabled_()) return rejectedAuthResult_();
    sheet.getRange(record.sheetRow, state.indexes.status + 1, 1, 1).setValue('VOID');
    SpreadsheetApp.flush();
    record.status = 'VOID';
    return completedRichmondInstructorVoid_('voided', value, record, actionNumber);
  } catch (error) {
    return jsonResult_({
      ok: false,
      result: 'failed',
      message: 'The instructor sign-in void failed.'
    });
  } finally {
    lock.releaseLock();
  }
}

function staffClockDeploymentConfiguration_() {
  var target = configuredDeploymentTarget_();
  if (
    target === 'test'
    && typeof GIB_M1_TEST_STAFF_SHEET_ !== 'undefined'
    && typeof GIB_M1_TEST_STAFF_HEADERS_ !== 'undefined'
    && typeof GIB_M1_TEST_STAFF_TIME_SHEET_ !== 'undefined'
    && typeof GIB_M1_TEST_STAFF_TIME_HEADERS_ !== 'undefined'
    && typeof GIB_M1_TEST_STAFF_AUDIT_SHEET_ !== 'undefined'
    && typeof GIB_M1_TEST_STAFF_AUDIT_HEADERS_ !== 'undefined'
    && typeof GIB_M1_TEST_STAFF_ADJUSTMENT_SHEET_ !== 'undefined'
    && typeof GIB_M1_TEST_STAFF_ADJUSTMENT_HEADERS_ !== 'undefined'
  ) {
    return {
      target: target,
      staffSheet: GIB_M1_TEST_STAFF_SHEET_,
      staffHeaders: GIB_M1_TEST_STAFF_HEADERS_,
      timeSheet: GIB_M1_TEST_STAFF_TIME_SHEET_,
      timeHeaders: GIB_M1_TEST_STAFF_TIME_HEADERS_,
      auditSheet: GIB_M1_TEST_STAFF_AUDIT_SHEET_,
      auditHeaders: GIB_M1_TEST_STAFF_AUDIT_HEADERS_,
      adjustmentSheet: GIB_M1_TEST_STAFF_ADJUSTMENT_SHEET_,
      adjustmentHeaders: GIB_M1_TEST_STAFF_ADJUSTMENT_HEADERS_
    };
  }
  if (
    target === 'production'
    && typeof GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK !== 'undefined'
    && GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK === true
    && typeof GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE !== 'undefined'
    && GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE === false
  ) {
    return {
      target: target,
      staffSheet: GIB_M1_PRODUCTION_STAFF_SHEET_,
      staffHeaders: GIB_M1_PRODUCTION_STAFF_HEADERS_,
      timeSheet: GIB_M1_PRODUCTION_STAFF_TIME_SHEET_,
      timeHeaders: GIB_M1_PRODUCTION_STAFF_TIME_HEADERS_,
      auditSheet: GIB_M1_PRODUCTION_STAFF_AUDIT_SHEET_,
      auditHeaders: GIB_M1_PRODUCTION_STAFF_AUDIT_HEADERS_,
      adjustmentSheet: GIB_M1_PRODUCTION_STAFF_ADJUSTMENT_SHEET_,
      adjustmentHeaders: GIB_M1_PRODUCTION_STAFF_ADJUSTMENT_HEADERS_
    };
  }
  return null;
}

function staffClockExactKeys_(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var actual = Object.keys(value).sort();
  var wanted = expected.slice().sort();
  return actual.length === wanted.length && actual.every(function(key, index) {
    return key === wanted[index];
  });
}

function staffClockSheetValues_(spreadsheet, name, expectedHeaders) {
  if (!staffClockDeploymentConfiguration_()) {
    throw new Error('Staff Clock is not configured for this deployment.');
  }
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error(name + ' tab is missing.');
  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error(name + ' headings are missing.');
  var headings = values[0].map(function(value) { return exactText_(value); });
  if (headings.length !== expectedHeaders.length) {
    throw new Error(name + ' headings do not match.');
  }
  for (var i = 0; i < expectedHeaders.length; i += 1) {
    if (headings[i] !== expectedHeaders[i]) {
      throw new Error(name + ' headings do not match.');
    }
  }
  return { sheet: sheet, values: values };
}

function staffClockPopulatedRow_(row) {
  return row.some(function(value) { return exactText_(value) !== ''; });
}

function staffClockStaffState_(spreadsheet) {
  var configuration = staffClockDeploymentConfiguration_();
  if (!configuration) {
    throw new Error('Staff Clock is not configured for this deployment.');
  }
  var source = staffClockSheetValues_(
    spreadsheet,
    configuration.staffSheet,
    configuration.staffHeaders
  );
  var all = [];
  var active = [];
  var byId = {};
  var names = {};
  source.values.slice(1).forEach(function(row) {
    if (!staffClockPopulatedRow_(row)) return;
    var staffId = safeExactText_(row[0], 80, false);
    var staffName = safeExactText_(row[1], 100, false);
    var enabled = row[2];
    var obviousTestRosterValue = obviousTestValue_(staffId) || obviousTestValue_(staffName);
    if (
      !staffId
      || !GIB_M1_STAFF_ID_PATTERN_.test(staffId)
      || !staffName
      || (configuration.target === 'test' && !obviousTestValue_(staffName))
      || (configuration.target === 'production' && obviousTestRosterValue)
      || (enabled !== true && enabled !== false)
      || byId[staffId]
      || names[normalizeEventText_(staffName)]
    ) {
      throw new Error('Staff Clock Staff contains an invalid or duplicate row.');
    }
    var item = { staffId: staffId, staffName: staffName, active: enabled };
    all.push(item);
    byId[staffId] = item;
    names[normalizeEventText_(staffName)] = true;
    if (enabled) active.push({ staffId: staffId, staffName: staffName });
  });
  if (all.length > GIB_M1_STAFF_MAX_STAFF_) {
    throw new Error('Staff Clock Staff contains too many staff rows.');
  }
  if (!active.length) {
    throw new Error(configuration.target === 'test'
      ? 'Staff Clock Staff has no active TEST staff.'
      : 'Staff Clock Staff has no active production staff.');
  }
  return { all: all, active: active, byId: byId };
}

function staffClockTimestamp_(value) {
  if (typeof value !== 'string') return '';
  var text = safeExactText_(value, 40, false);
  var match = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(-04:00|-05:00)$/);
  if (!match) {
    return '';
  }
  var instant = new Date(text);
  if (isNaN(instant.getTime())) return '';
  var local = Utilities.formatDate(
    instant,
    GIB_M1_STAFF_TIME_ZONE_,
    "yyyy-MM-dd'T'HH:mm:ss"
  );
  var offset = Utilities.formatDate(instant, GIB_M1_STAFF_TIME_ZONE_, 'Z');
  if (!/^[+-]\d{4}$/.test(offset)) return '';
  var expectedOffset = offset.slice(0, 3) + ':' + offset.slice(3);
  return local === match[1] && expectedOffset === match[2] ? text : '';
}

function staffClockNowTimestamp_() {
  var instant = new Date();
  var local = Utilities.formatDate(
    instant,
    GIB_M1_STAFF_TIME_ZONE_,
    "yyyy-MM-dd'T'HH:mm:ss"
  );
  var offset = Utilities.formatDate(instant, GIB_M1_STAFF_TIME_ZONE_, 'Z');
  if (!/^[+-]\d{4}$/.test(offset)) return '';
  return local + offset.slice(0, 3) + ':' + offset.slice(3);
}

function staffClockStoredAction_(value) {
  if (exactText_(value) === 'clockIn') return 'clockIn';
  if (exactText_(value) === 'clockOut') return 'clockOut';
  return '';
}

function staffClockSheetAction_(value) {
  return value === 'clockIn' || value === 'clockOut' ? value : '';
}

function staffClockPublicRecord_(record) {
  var value = {
    punchId: record.punchId,
    timestamp: record.timestamp,
    date: record.date,
    staffId: record.staffId,
    staffName: record.staffName,
    punchAction: record.action,
    site: record.site,
    device: record.device,
    build: record.build,
    note: record.note,
    status: record.status,
    source: record.source,
    adminName: record.adminName,
    linkedPunchId: record.linkedPunchId
  };
  if (record.adjustmentRequestId) {
    value.originalTimestamp = record.originalTimestamp;
    value.originalDate = record.originalDate;
    value.adjustmentRequestId = record.adjustmentRequestId;
  }
  return value;
}

function staffClockReadTime_(spreadsheet, staffState) {
  var configuration = staffClockDeploymentConfiguration_();
  if (!configuration) {
    throw new Error('Staff Clock is not configured for this deployment.');
  }
  var source = staffClockSheetValues_(
    spreadsheet,
    configuration.timeSheet,
    configuration.timeHeaders
  );
  var records = [];
  var byId = {};
  source.values.slice(1).forEach(function(row, offset) {
    if (!staffClockPopulatedRow_(row)) return;
    var punchId = safeExactText_(row[0], 160, false);
    var timestamp = staffClockTimestamp_(row[1]);
    var date = exactText_(row[2]);
    var staffId = safeExactText_(row[3], 80, false);
    var staffName = safeExactText_(row[4], 100, false);
    var action = staffClockStoredAction_(row[5]);
    var site = safeExactText_(row[6], 80, false);
    var device = safeText_(row[7], 120, false);
    var build = safeText_(row[8], 120, false);
    var note = safeExactText_(row[9], 400, true);
    var status = exactText_(row[10]);
    var recordSource = exactText_(row[11]);
    var adminName = safeText_(row[12], 80, true);
    var linkedPunchId = safeExactText_(row[13], 160, true);
    var roster = staffState.byId[staffId];
    if (
      !punchId
      || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(punchId)
      || byId[punchId]
      || !timestamp
      || !validCalendarDate_(date)
      || date !== timestamp.slice(0, 10)
      || !roster
      || staffName !== roster.staffName
      || !action
      || !site
      || !device
      || !build
      || (status !== 'ACTIVE' && status !== 'VOID')
      || (recordSource !== 'Tablet' && recordSource !== 'Admin-added')
      || (recordSource === 'Tablet' && adminName)
      || (recordSource === 'Admin-added' && GIB_M1_ADMIN_NAMES_.indexOf(adminName) === -1)
      || (linkedPunchId && !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(linkedPunchId))
    ) {
      throw new Error('Staff Time contains an invalid or duplicate row.');
    }
    var record = {
      sheetRow: offset + 2,
      punchId: punchId,
      timestamp: timestamp,
      timestampMs: Date.parse(timestamp),
      date: date,
      staffId: staffId,
      staffName: staffName,
      action: action,
      site: site,
      device: device,
      build: build,
      note: note,
      status: status,
      source: recordSource,
      adminName: adminName,
      linkedPunchId: linkedPunchId
    };
    records.push(record);
    byId[punchId] = record;
  });
  return { sheet: source.sheet, records: records, byId: byId };
}

function staffClockAuditAction_(value) {
  if (exactText_(value) === 'clockIn') return 'clockIn';
  if (exactText_(value) === 'clockOut') return 'clockOut';
  if (exactText_(value) === 'void') return 'void';
  return '';
}

function staffClockPublicAudit_(record) {
  return {
    requestId: record.requestId,
    actionTime: record.actionTime,
    adminName: record.adminName,
    staffId: record.staffId,
    staffName: record.staffName,
    punchTimestamp: record.punchTimestamp,
    operation: record.action === 'void' ? 'void' : 'correct',
    punchAction: record.punchAction,
    reason: record.reason,
    result: record.result,
    linkedPunchId: record.linkedPunchId
  };
}

function staffClockReadAudit_(spreadsheet, staffState, timeState) {
  var configuration = staffClockDeploymentConfiguration_();
  if (!configuration) {
    throw new Error('Staff Clock is not configured for this deployment.');
  }
  var source = staffClockSheetValues_(
    spreadsheet,
    configuration.auditSheet,
    configuration.auditHeaders
  );
  var records = [];
  var byRequestId = {};
  source.values.slice(1).forEach(function(row, offset) {
    if (!staffClockPopulatedRow_(row)) return;
    var requestId = safeExactText_(row[0], 180, false);
    var actionTime = staffClockTimestamp_(row[1]);
    var adminName = safeText_(row[2], 80, false);
    var staffId = safeExactText_(row[3], 80, false);
    var staffName = safeExactText_(row[4], 100, false);
    var punchTimestamp = staffClockTimestamp_(row[5]);
    var action = staffClockAuditAction_(row[6]);
    var reason = safeExactText_(row[7], GIB_M1_AUDIT_REASON_MAX_, false);
    var result = exactText_(row[8]);
    var linkedPunchId = safeExactText_(row[9], 160, false);
    var roster = staffState.byId[staffId];
    var linked = timeState.byId[linkedPunchId];
    if (
      !requestId
      || !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(requestId)
      || byRequestId[requestId]
      || !actionTime
      || GIB_M1_ADMIN_NAMES_.indexOf(adminName) === -1
      || !roster
      || staffName !== roster.staffName
      || !punchTimestamp
      || !action
      || reason.length < 3
      || (result !== 'added' && result !== 'already exists' && result !== 'voided' && result !== 'already voided')
      || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(linkedPunchId)
      || !linked
      || linked.staffId !== staffId
      || linked.staffName !== staffName
      || linked.timestamp !== punchTimestamp
    ) {
      throw new Error('Staff Time Audit contains an invalid or duplicate row.');
    }
    var record = {
      sheetRow: offset + 2,
      requestId: requestId,
      actionTime: actionTime,
      adminName: adminName,
      staffId: staffId,
      staffName: staffName,
      punchTimestamp: punchTimestamp,
      action: action,
      punchAction: linked.action,
      reason: reason,
      result: result,
      linkedPunchId: linkedPunchId
    };
    records.push(record);
    byRequestId[requestId] = record;
  });
  return { sheet: source.sheet, records: records, byRequestId: byRequestId };
}

function staffClockSamePunch_(record, candidate) {
  return Boolean(record)
    && record.punchId === candidate.punchId
    && record.timestamp === candidate.timestamp
    && record.date === candidate.date
    && record.staffId === candidate.staffId
    && record.staffName === candidate.staffName
    && record.action === candidate.action
    && record.site === candidate.site
    && record.device === candidate.device
    && record.build === candidate.build
    && record.note === candidate.note
    && record.source === candidate.source
    && record.adminName === candidate.adminName
    && record.linkedPunchId === candidate.linkedPunchId;
}

function staffClockSameEvent_(record, candidate) {
  return record.timestamp === candidate.timestamp
    && record.staffId === candidate.staffId
    && record.action === candidate.action;
}

function staffClockAppendTime_(state, record) {
  var row = [
    record.punchId,
    record.timestamp,
    record.date,
    record.staffId,
    record.staffName,
    staffClockSheetAction_(record.action),
    record.site,
    record.device,
    record.build,
    record.note,
    record.status,
    record.source,
    record.adminName,
    record.linkedPunchId
  ];
  var nextRow = state.sheet.getLastRow() + 1;
  if (nextRow > state.sheet.getMaxRows()) {
    state.sheet.insertRowsAfter(state.sheet.getMaxRows(), nextRow - state.sheet.getMaxRows());
  }
  state.sheet.getRange(nextRow, 2, 1, 2).setNumberFormat('@');
  state.sheet.getRange(nextRow, 1, 1, row.length).setValues([row]);
  record.sheetRow = nextRow;
  state.records.push(record);
  state.byId[record.punchId] = record;
}

function staffClockSetVoided_(state, record) {
  state.sheet.getRange(record.sheetRow, 11, 1, 1).setValue('VOID');
  record.status = 'VOID';
}

function staffClockAppendAudit_(state, value) {
  if (state.byRequestId[value.requestId]) {
    throw new Error('Staff Time Audit request ID already exists.');
  }
  var sheetAction = value.action === 'void'
    ? 'void'
    : staffClockSheetAction_(value.action);
  var row = [
    value.requestId,
    value.actionTime,
    value.adminName,
    value.staffId,
    value.staffName,
    value.punchTimestamp,
    sheetAction,
    value.reason,
    value.result,
    value.linkedPunchId
  ];
  var nextRow = state.sheet.getLastRow() + 1;
  if (nextRow > state.sheet.getMaxRows()) {
    state.sheet.insertRowsAfter(state.sheet.getMaxRows(), nextRow - state.sheet.getMaxRows());
  }
  state.sheet.getRange(nextRow, 2, 1, 1).setNumberFormat('@');
  state.sheet.getRange(nextRow, 6, 1, 1).setNumberFormat('@');
  state.sheet.getRange(nextRow, 1, 1, row.length).setValues([row]);
  value.sheetRow = nextRow;
  state.records.push(value);
  state.byRequestId[value.requestId] = value;
  return value;
}

function staffClockAdjustmentChange_(value) {
  var changedIn = value.correctedClockInAt !== value.originalClockInAt;
  var changedOut = value.correctedClockOutAt !== value.originalClockOutAt;
  return changedIn && changedOut ? 'both' : changedIn ? 'clockIn' : changedOut ? 'clockOut' : '';
}

function staffClockAdjustmentSheetState_(spreadsheet, staffState, timeState, createIfMissing) {
  var configuration = staffClockDeploymentConfiguration_();
  if (!configuration) throw new Error('Staff Clock is not configured for this deployment.');
  var sheet = spreadsheet.getSheetByName(configuration.adjustmentSheet);
  if (!sheet && createIfMissing) {
    sheet = spreadsheet.insertSheet(configuration.adjustmentSheet);
    sheet.getRange(1, 1, 1, configuration.adjustmentHeaders.length)
      .setValues([configuration.adjustmentHeaders]);
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
  }
  if (!sheet) return { sheet: null, records: [], byRequestId: {} };
  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error('Staff Time Adjustments headings are missing.');
  var headings = values[0].map(function(value) { return exactText_(value); });
  if (headings.length !== configuration.adjustmentHeaders.length) {
    throw new Error('Staff Time Adjustments headings do not match.');
  }
  for (var headingIndex = 0; headingIndex < configuration.adjustmentHeaders.length; headingIndex += 1) {
    if (headings[headingIndex] !== configuration.adjustmentHeaders[headingIndex]) {
      throw new Error('Staff Time Adjustments headings do not match.');
    }
  }
  var records = [];
  var byRequestId = {};
  values.slice(1).forEach(function(row, offset) {
    if (!staffClockPopulatedRow_(row)) return;
    var requestId = safeExactText_(row[0], 180, false);
    var actionTime = staffClockTimestamp_(row[1]);
    var adminName = safeText_(row[2], 80, false);
    var staffId = safeExactText_(row[3], 80, false);
    var staffName = safeExactText_(row[4], 100, false);
    var clockInPunchId = safeExactText_(row[5], 160, false);
    var clockOutPunchId = safeExactText_(row[6], 160, false);
    var originalClockInAt = staffClockTimestamp_(row[7]);
    var originalClockOutAt = staffClockTimestamp_(row[8]);
    var correctedClockInAt = staffClockTimestamp_(row[9]);
    var correctedClockOutAt = staffClockTimestamp_(row[10]);
    var changed = exactText_(row[11]);
    var reason = safeExactText_(row[12], GIB_M1_AUDIT_REASON_MAX_, false);
    var result = exactText_(row[13]);
    var roster = staffState.byId[staffId];
    var clockIn = timeState.byId[clockInPunchId];
    var clockOut = timeState.byId[clockOutPunchId];
    var value = {
      requestId: requestId,
      actionTime: actionTime,
      adminName: adminName,
      staffId: staffId,
      staffName: staffName,
      clockInPunchId: clockInPunchId,
      clockOutPunchId: clockOutPunchId,
      originalClockInAt: originalClockInAt,
      originalClockOutAt: originalClockOutAt,
      correctedClockInAt: correctedClockInAt,
      correctedClockOutAt: correctedClockOutAt,
      changed: changed,
      reason: reason,
      result: result
    };
    var elapsed = Date.parse(correctedClockOutAt) - Date.parse(correctedClockInAt);
    if (
      !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(requestId)
      || byRequestId[requestId]
      || !actionTime
      || GIB_M1_ADMIN_NAMES_.indexOf(adminName) === -1
      || !roster
      || staffName !== roster.staffName
      || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(clockInPunchId)
      || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(clockOutPunchId)
      || clockInPunchId === clockOutPunchId
      || !clockIn
      || !clockOut
      || clockIn.staffId !== staffId
      || clockOut.staffId !== staffId
      || clockIn.action !== 'clockIn'
      || clockOut.action !== 'clockOut'
      || !originalClockInAt
      || !originalClockOutAt
      || !correctedClockInAt
      || !correctedClockOutAt
      || Date.parse(originalClockOutAt) <= Date.parse(originalClockInAt)
      || elapsed <= 0
      || elapsed > GIB_M1_STAFF_MAX_SHIFT_MS_
      || (changed !== 'clockIn' && changed !== 'clockOut' && changed !== 'both')
      || staffClockAdjustmentChange_(value) !== changed
      || reason.length < 3
      || result !== 'adjusted'
    ) {
      throw new Error('Staff Time Adjustments contains an invalid or duplicate row.');
    }
    value.sheetRow = offset + 2;
    records.push(value);
    byRequestId[requestId] = value;
  });
  return { sheet: sheet, records: records, byRequestId: byRequestId };
}

function staffClockAppendAdjustment_(state, value) {
  if (!state.sheet || state.byRequestId[value.requestId]) {
    throw new Error('Staff Time adjustment request ID already exists.');
  }
  var row = [
    value.requestId,
    value.actionTime,
    value.adminName,
    value.staffId,
    value.staffName,
    value.clockInPunchId,
    value.clockOutPunchId,
    value.originalClockInAt,
    value.originalClockOutAt,
    value.correctedClockInAt,
    value.correctedClockOutAt,
    value.changed,
    value.reason,
    value.result
  ];
  var nextRow = state.sheet.getLastRow() + 1;
  if (nextRow > state.sheet.getMaxRows()) {
    state.sheet.insertRowsAfter(state.sheet.getMaxRows(), nextRow - state.sheet.getMaxRows());
  }
  state.sheet.getRange(nextRow, 2, 1, 1).setNumberFormat('@');
  state.sheet.getRange(nextRow, 8, 1, 4).setNumberFormat('@');
  state.sheet.getRange(nextRow, 1, 1, row.length).setValues([row]);
  value.sheetRow = nextRow;
  state.records.push(value);
  state.byRequestId[value.requestId] = value;
  return value;
}

function staffClockApplyAdjustments_(timeState, adjustmentState) {
  var records = timeState.records.map(function(record) {
    var clone = {};
    Object.keys(record).forEach(function(key) { clone[key] = record[key]; });
    return clone;
  });
  var byId = {};
  records.forEach(function(record) { byId[record.punchId] = record; });
  adjustmentState.records.forEach(function(adjustment) {
    var clockIn = byId[adjustment.clockInPunchId];
    var clockOut = byId[adjustment.clockOutPunchId];
    if (
      !clockIn
      || !clockOut
      || clockIn.staffId !== adjustment.staffId
      || clockOut.staffId !== adjustment.staffId
      || clockIn.action !== 'clockIn'
      || clockOut.action !== 'clockOut'
      || clockIn.timestamp !== adjustment.originalClockInAt
      || clockOut.timestamp !== adjustment.originalClockOutAt
    ) {
      throw new Error('Staff Time Adjustments does not match the permanent punch history.');
    }
    [clockIn, clockOut].forEach(function(record) {
      if (!record.originalTimestamp) {
        record.originalTimestamp = record.timestamp;
        record.originalDate = record.date;
      }
      record.adjustmentRequestId = adjustment.requestId;
    });
    clockIn.timestamp = adjustment.correctedClockInAt;
    clockIn.timestampMs = Date.parse(clockIn.timestamp);
    clockIn.date = clockIn.timestamp.slice(0, 10);
    clockOut.timestamp = adjustment.correctedClockOutAt;
    clockOut.timestampMs = Date.parse(clockOut.timestamp);
    clockOut.date = clockOut.timestamp.slice(0, 10);
  });
  return { sheet: timeState.sheet, records: records, byId: byId };
}

function staffClockPublicAdjustment_(record) {
  return {
    requestId: record.requestId,
    actionTime: record.actionTime,
    adminName: record.adminName,
    operation: 'adjust',
    staffId: record.staffId,
    staffName: record.staffName,
    clockInPunchId: record.clockInPunchId,
    clockOutPunchId: record.clockOutPunchId,
    originalClockInAt: record.originalClockInAt,
    originalClockOutAt: record.originalClockOutAt,
    correctedClockInAt: record.correctedClockInAt,
    correctedClockOutAt: record.correctedClockOutAt,
    changed: record.changed,
    reason: record.reason,
    result: record.result
  };
}

function staffClockIssue_(staff, code, message, records) {
  var first = records && records.length ? records[0] : null;
  return {
    staffId: staff.staffId,
    staffName: staff.staffName,
    code: code,
    message: message,
    date: first ? first.date : todayNewYork_(),
    linkedPunchIds: (records || []).map(function(record) { return record.punchId; })
  };
}

function staffClockAnalyze_(staffState, timeState) {
  var issues = [];
  var clockedInNow = [];
  var completedShifts = [];
  var byStaff = {};
  staffState.all.forEach(function(staff) {
    var records = timeState.records.filter(function(record) {
      return record.staffId === staff.staffId && record.status === 'ACTIVE';
    }).sort(function(left, right) {
      return left.timestampMs - right.timestampMs || left.sheetRow - right.sheetRow;
    });
    var staffIssues = [];
    var shifts = [];
    var open = null;
    var structuralContradiction = false;
    for (var recordIndex = 0; recordIndex < records.length && !structuralContradiction; recordIndex += 1) {
      var record = records[recordIndex];
      if (record.action === 'clockIn') {
        if (open) {
          staffIssues.push(staffClockIssue_(
            staff,
            'repeated_clock_in',
            staff.staffName + ' has two Clock In punches in a row.',
            [open, record]
          ));
          open = null;
          structuralContradiction = true;
        } else {
          open = record;
        }
        continue;
      }
      if (!open) {
        staffIssues.push(staffClockIssue_(
          staff,
          'clock_out_without_clock_in',
          staff.staffName + ' has a Clock Out without an earlier Clock In.',
          [record]
        ));
        open = null;
        structuralContradiction = true;
        continue;
      }
      var elapsed = record.timestampMs - open.timestampMs;
      if (elapsed <= 0) {
        staffIssues.push(staffClockIssue_(
          staff,
          'non_positive_shift',
          staff.staffName + ' has a shift whose times do not make sense.',
          [open, record]
        ));
        structuralContradiction = true;
      } else {
        shifts.push({ clockIn: open, clockOut: record, elapsedMs: elapsed });
        if (elapsed > GIB_M1_STAFF_MAX_SHIFT_MS_) {
          staffIssues.push(staffClockIssue_(
            staff,
            'shift_too_long',
            staff.staffName + ' has an unreasonably long shift.',
            [open, record]
          ));
        }
      }
      open = null;
    }
    if (open && !structuralContradiction) {
      if (open.timestampMs > Date.now()) {
        staffIssues.push(staffClockIssue_(
          staff,
          'future_punch',
          staff.staffName + ' has a punch later than the current time.',
          [open]
        ));
        structuralContradiction = true;
      } else if (
        todayNewYork_() !== open.date
        || Date.now() - open.timestampMs > GIB_M1_STAFF_MAX_SHIFT_MS_
      ) {
        staffIssues.push(staffClockIssue_(
          staff,
          'missing_clock_out',
          staff.staffName + ' may be missing a Clock Out.',
          [open]
        ));
      }
      if (!structuralContradiction) {
        clockedInNow.push({
          punchId: open.punchId,
          staffId: staff.staffId,
          staffName: staff.staffName,
          clockInAt: open.timestamp
        });
      }
    }
    issues = issues.concat(staffIssues);
    completedShifts = completedShifts.concat(shifts);
    byStaff[staff.staffId] = {
      records: records,
      issues: staffIssues,
      shifts: shifts,
      open: open,
      structuralContradiction: structuralContradiction,
      last: records.length ? records[records.length - 1] : null
    };
  });
  return {
    issues: issues,
    clockedInNow: clockedInNow,
    completedShifts: completedShifts,
    byStaff: byStaff
  };
}

function staffClockPublicIssue_(issue) {
  return {
    staffId: issue.staffId,
    staffName: issue.staffName,
    code: issue.code,
    message: issue.message,
    linkedPunchIds: issue.linkedPunchIds.slice()
  };
}

function staffClockDateMs_(date) {
  var parts = date.split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function staffClockDateFromMs_(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function staffClockPayPeriod_(today, offset) {
  var dayMs = 24 * 60 * 60 * 1000;
  var anchorMs = staffClockDateMs_(GIB_M1_STAFF_PAY_ANCHOR_);
  var todayMs = staffClockDateMs_(today);
  var periodIndex = Math.floor(((todayMs - anchorMs) / dayMs) / 14) + offset;
  var startMs = anchorMs + periodIndex * 14 * dayMs;
  return {
    startDate: staffClockDateFromMs_(startMs),
    endDate: staffClockDateFromMs_(startMs + 13 * dayMs)
  };
}

function staffClockPeriodSummary_(period, staffState, analysis) {
  var totals = [];
  staffState.all.forEach(function(staff) {
    var state = analysis.byStaff[staff.staffId] || { records: [], shifts: [], issues: [] };
    var periodRecords = state.records.filter(function(record) {
      return record.date >= period.startDate && record.date <= period.endDate;
    });
    var shifts = state.shifts.filter(function(shift) {
      return shift.clockIn.date >= period.startDate && shift.clockIn.date <= period.endDate;
    });
    var attention = state.issues.some(function(issue) {
      return issue.date >= period.startDate && issue.date <= period.endDate;
    });
    if (!staff.active && !periodRecords.length && !attention) return;
    var totalSeconds = shifts.reduce(function(total, shift) {
      return total + Math.floor(shift.elapsedMs / 1000);
    }, 0);
    totals.push({
      staffId: staff.staffId,
      staffName: staff.staffName,
      completedShifts: shifts.length,
      totalSeconds: totalSeconds,
      needsAttention: attention
    });
  });
  return {
    startDate: period.startDate,
    endDate: period.endDate,
    totals: totals
  };
}

function staffClockSortRecords_(records) {
  return records.slice().sort(function(left, right) {
    return left.timestampMs - right.timestampMs || left.sheetRow - right.sheetRow;
  });
}

function staffClockRelevantRecords_(
  timeState,
  adjustmentState,
  analysis,
  today,
  previousPeriod,
  currentPeriod
) {
  var firstDate = previousPeriod.startDate;
  var lastDate = currentPeriod.endDate;
  var requiredIds = {};
  var shiftPartnerById = {};
  var adjustmentPartnersById = {};
  var staffRecordPositionById = {};
  var allRecordsByStaff = {};

  function requireRecord(record) {
    if (record) requiredIds[record.punchId] = true;
  }

  timeState.records.forEach(function(record) {
    if (!allRecordsByStaff[record.staffId]) allRecordsByStaff[record.staffId] = [];
    allRecordsByStaff[record.staffId].push(record);
    var periodAdjustment = record.date >= firstDate
      && record.date <= lastDate
      && (
        record.source === 'Admin-added'
        || record.status === 'VOID'
        || Boolean(record.adjustmentRequestId)
      );
    if (record.date === today || periodAdjustment) requireRecord(record);
  });
  Object.keys(allRecordsByStaff).forEach(function(staffId) {
    allRecordsByStaff[staffId] = staffClockSortRecords_(allRecordsByStaff[staffId]);
    allRecordsByStaff[staffId].forEach(function(record, index) {
      staffRecordPositionById[record.punchId] = index;
    });
  });
  analysis.clockedInNow.forEach(function(open) {
    requireRecord(timeState.byId[open.punchId]);
  });
  analysis.issues.forEach(function(issue) {
    issue.linkedPunchIds.forEach(function(punchId) {
      var record = timeState.byId[punchId];
      requireRecord(record);
      if (!record) return;
      var staffRecords = allRecordsByStaff[record.staffId] || [];
      var position = staffRecordPositionById[record.punchId];
      [staffRecords[position - 1], staffRecords[position + 1]].forEach(function(adjacent) {
        if (adjacent && (adjacent.status === 'VOID' || adjacent.source === 'Admin-added')) {
          requireRecord(adjacent);
        }
      });
    });
  });
  analysis.completedShifts.forEach(function(shift) {
    shiftPartnerById[shift.clockIn.punchId] = shift.clockOut;
    shiftPartnerById[shift.clockOut.punchId] = shift.clockIn;
  });
  adjustmentState.records.forEach(function(adjustment) {
    if (!adjustmentPartnersById[adjustment.clockInPunchId]) {
      adjustmentPartnersById[adjustment.clockInPunchId] = [];
    }
    if (!adjustmentPartnersById[adjustment.clockOutPunchId]) {
      adjustmentPartnersById[adjustment.clockOutPunchId] = [];
    }
    adjustmentPartnersById[adjustment.clockInPunchId].push(adjustment.clockOutPunchId);
    adjustmentPartnersById[adjustment.clockOutPunchId].push(adjustment.clockInPunchId);
  });

  var addedDependency = true;
  while (addedDependency) {
    addedDependency = false;
    Object.keys(requiredIds).forEach(function(punchId) {
      var record = timeState.byId[punchId];
      if (
        record
        && record.linkedPunchId
        && !requiredIds[record.linkedPunchId]
        && timeState.byId[record.linkedPunchId]
      ) {
        requiredIds[record.linkedPunchId] = true;
        addedDependency = true;
      }
      var shiftPartner = shiftPartnerById[punchId];
      if (shiftPartner && !requiredIds[shiftPartner.punchId]) {
        requiredIds[shiftPartner.punchId] = true;
        addedDependency = true;
      }
      (adjustmentPartnersById[punchId] || []).forEach(function(partnerId) {
        if (!requiredIds[partnerId] && timeState.byId[partnerId]) {
          requiredIds[partnerId] = true;
          addedDependency = true;
        }
      });
    });
  }

  var records = staffClockSortRecords_(timeState.records.filter(function(record) {
    return requiredIds[record.punchId];
  }));
  return records;
}

function staffClockRelevantAudit_(auditState, records) {
  var recordIds = {};
  records.forEach(function(record) {
    recordIds[record.punchId] = true;
  });
  var audit = auditState.records.filter(function(record) {
    return record.clockInPunchId
      ? recordIds[record.clockInPunchId] && recordIds[record.clockOutPunchId]
      : recordIds[record.linkedPunchId];
  });
  return audit;
}

function staffClockGroupIssues_(analysis, timeState) {
  var grouped = {};
  analysis.issues.forEach(function(issue, issueIndex) {
    var key = issue.staffId + '\u0000' + issue.code;
    var evidence = issue.linkedPunchIds.map(function(punchId) {
      return timeState.byId[punchId];
    }).filter(Boolean).sort(function(left, right) {
      return right.timestampMs - left.timestampMs
        || right.sheetRow - left.sheetRow
        || right.punchId.localeCompare(left.punchId);
    });
    var latest = evidence.length ? evidence[0] : null;
    var timestampMs = latest ? latest.timestampMs : staffClockDateMs_(issue.date);
    var sheetRow = latest ? latest.sheetRow : 0;
    if (!grouped[key]) {
      grouped[key] = {
        issue: issue,
        occurrenceCount: 0,
        timestampMs: timestampMs,
        sheetRow: sheetRow,
        issueIndex: issueIndex
      };
    }
    var group = grouped[key];
    group.occurrenceCount += 1;
    if (
      timestampMs > group.timestampMs
      || (timestampMs === group.timestampMs && sheetRow > group.sheetRow)
      || (
        timestampMs === group.timestampMs
        && sheetRow === group.sheetRow
        && issueIndex > group.issueIndex
      )
    ) {
      group.issue = issue;
      group.timestampMs = timestampMs;
      group.sheetRow = sheetRow;
      group.issueIndex = issueIndex;
    }
  });
  var groups = Object.keys(grouped).map(function(key) {
    return grouped[key];
  }).sort(function(left, right) {
    return right.timestampMs - left.timestampMs
      || right.sheetRow - left.sheetRow
      || left.issue.staffId.localeCompare(right.issue.staffId)
      || left.issue.code.localeCompare(right.issue.code);
  });
  if (groups.length > GIB_M1_STAFF_ATTENTION_LIMIT_) {
    throw new Error('Staff Clock attention groups exceed the bounded contract.');
  }
  return groups;
}

function staffClockPublicIssueGroup_(group) {
  var issue = group.issue;
  return {
    staffId: issue.staffId,
    staffName: issue.staffName,
    code: issue.code,
    message: issue.message,
    linkedPunchIds: issue.linkedPunchIds.slice(),
    occurrenceCount: group.occurrenceCount
  };
}

function staffClockPeriodAdjustment_(record, previousPeriod, currentPeriod) {
  return record.date >= previousPeriod.startDate
    && record.date <= currentPeriod.endDate
    && (
      record.source === 'Admin-added'
      || record.status === 'VOID'
      || Boolean(record.adjustmentRequestId)
    );
}

function staffClockSelectRecords_(
  records,
  adjustmentState,
  analysis,
  issueGroups,
  today,
  previousPeriod,
  currentPeriod
) {
  var openIds = {};
  var issueEvidenceIds = {};
  var adjustmentEvidenceIds = {};
  var adjustmentPartnersById = {};
  var adjustmentUnitByPunchId = {};
  var byId = {};
  records.forEach(function(record) {
    byId[record.punchId] = record;
    if (staffClockPeriodAdjustment_(record, previousPeriod, currentPeriod)) {
      adjustmentEvidenceIds[record.punchId] = true;
    }
  });
  adjustmentState.records.forEach(function(adjustment) {
    if (!byId[adjustment.clockInPunchId] || !byId[adjustment.clockOutPunchId]) return;
    if (!adjustmentPartnersById[adjustment.clockInPunchId]) {
      adjustmentPartnersById[adjustment.clockInPunchId] = [];
    }
    if (!adjustmentPartnersById[adjustment.clockOutPunchId]) {
      adjustmentPartnersById[adjustment.clockOutPunchId] = [];
    }
    adjustmentPartnersById[adjustment.clockInPunchId].push(adjustment.clockOutPunchId);
    adjustmentPartnersById[adjustment.clockOutPunchId].push(adjustment.clockInPunchId);
  });
  Object.keys(adjustmentPartnersById).forEach(function(punchId) {
    if (adjustmentUnitByPunchId[punchId]) return;
    var unit = [];
    var pending = [punchId];
    var included = {};
    while (pending.length) {
      var memberId = pending.pop();
      if (included[memberId]) continue;
      included[memberId] = true;
      unit.push(byId[memberId]);
      (adjustmentPartnersById[memberId] || []).forEach(function(partnerId) {
        if (!included[partnerId]) pending.push(partnerId);
      });
    }
    unit.forEach(function(record) {
      adjustmentUnitByPunchId[record.punchId] = unit;
    });
  });
  analysis.completedShifts.forEach(function(shift) {
    if (
      adjustmentEvidenceIds[shift.clockIn.punchId]
      || adjustmentEvidenceIds[shift.clockOut.punchId]
    ) {
      adjustmentEvidenceIds[shift.clockIn.punchId] = true;
      adjustmentEvidenceIds[shift.clockOut.punchId] = true;
    }
  });
  var addedAdjustmentDependency = true;
  while (addedAdjustmentDependency) {
    addedAdjustmentDependency = false;
    records.forEach(function(record) {
      if (
        adjustmentEvidenceIds[record.punchId]
        && record.linkedPunchId
        && byId[record.linkedPunchId]
        && !adjustmentEvidenceIds[record.linkedPunchId]
      ) {
        adjustmentEvidenceIds[record.linkedPunchId] = true;
        addedAdjustmentDependency = true;
      }
      if (
        record.linkedPunchId
        && adjustmentEvidenceIds[record.linkedPunchId]
        && !adjustmentEvidenceIds[record.punchId]
      ) {
        adjustmentEvidenceIds[record.punchId] = true;
        addedAdjustmentDependency = true;
      }
    });
  }
  analysis.clockedInNow.forEach(function(item) {
    openIds[item.punchId] = true;
  });
  issueGroups.forEach(function(group) {
    group.issue.linkedPunchIds.forEach(function(punchId) {
      issueEvidenceIds[punchId] = true;
    });
  });
  function priority(record) {
    if (openIds[record.punchId] || issueEvidenceIds[record.punchId]) return 0;
    if (adjustmentEvidenceIds[record.punchId]) return 1;
    if (record.date === today) return 2;
    return 3;
  }
  var ranked = records.slice().sort(function(left, right) {
    return priority(left) - priority(right)
      || right.timestampMs - left.timestampMs
      || right.sheetRow - left.sheetRow
      || right.punchId.localeCompare(left.punchId);
  });
  var selectedIds = {};
  var selectedCount = 0;
  ranked.forEach(function(record) {
    if (selectedIds[record.punchId]) return;
    var unit = adjustmentUnitByPunchId[record.punchId] || [record];
    if (selectedCount + unit.length > GIB_M1_STAFF_RECORD_LIMIT_) return;
    unit.forEach(function(member) {
      selectedIds[member.punchId] = true;
    });
    selectedCount += unit.length;
  });
  return ranked.filter(function(record) {
    return selectedIds[record.punchId];
  });
}

function staffClockSelectAudit_(records) {
  return records.slice().sort(function(left, right) {
    return Date.parse(right.actionTime) - Date.parse(left.actionTime)
      || right.sheetRow - left.sheetRow
      || right.requestId.localeCompare(left.requestId);
  }).slice(0, GIB_M1_STAFF_AUDIT_LIMIT_);
}

function staffClockSha256Hex_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset['UTF_8']
  ).map(function(byte) {
    return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function staffClockSheetLastRow_(spreadsheet, name, expectedHeaders) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error(name + ' tab is missing.');
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() !== expectedHeaders.length) {
    throw new Error(name + ' headings do not match.');
  }
  var headings = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0].map(function(value) {
    return exactText_(value);
  });
  for (var i = 0; i < expectedHeaders.length; i += 1) {
    if (headings[i] !== expectedHeaders[i]) {
      throw new Error(name + ' headings do not match.');
    }
  }
  return sheet.getLastRow();
}

function staffClockOptionalSheetLastRow_(spreadsheet, name, expectedHeaders) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) return 0;
  return staffClockSheetLastRow_(spreadsheet, name, expectedHeaders);
}

function staffClockViewState_(body, includeAdmin) {
  var spreadsheet = openExpectedSpreadsheet_(body);
  var configuration = staffClockDeploymentConfiguration_();
  if (!configuration) throw new Error('Staff Clock is not configured for this deployment.');
  var staffState = staffClockStaffState_(spreadsheet);
  var today = todayNewYork_();
  var target = requestTarget_(body);
  var mode = includeAdmin ? 'admin' : 'kiosk';
  var rosterHash = staffClockSha256Hex_(JSON.stringify(staffState.all.map(function(staff) {
    return {
      staffId: staff.staffId,
      staffName: staff.staffName,
      active: staff.active
    };
  })));
  var timeLastRow = staffClockSheetLastRow_(
    spreadsheet,
    configuration.timeSheet,
    configuration.timeHeaders
  );
  var auditLastRow = staffClockSheetLastRow_(
    spreadsheet,
    configuration.auditSheet,
    configuration.auditHeaders
  );
  var adjustmentLastRow = staffClockOptionalSheetLastRow_(
    spreadsheet,
    configuration.adjustmentSheet,
    configuration.adjustmentHeaders
  );
  var signature = staffClockSha256Hex_(JSON.stringify([
    'gib-m1-staff-state-v2',
    target,
    mode,
    today,
    rosterHash,
    timeLastRow,
    auditLastRow,
    adjustmentLastRow
  ]));
  return {
    spreadsheet: spreadsheet,
    staffState: staffState,
    target: target,
    mode: mode,
    today: today,
    signature: signature
  };
}

function staffClockCache_() {
  return CacheService.getScriptCache();
}

function staffClockCacheSummaryKey_(signature) {
  return 'gib-m1-staff-v2-summary-' + signature;
}

function staffClockCacheManifestKey_(token) {
  return 'gib-m1-staff-v2-manifest-' + token;
}

function staffClockCachePageKey_(token, stream, offset) {
  return 'gib-m1-staff-v2-page-' + token + '-' + stream + '-' + offset;
}

function staffClockCacheHistoryPageKey_(token, offset) {
  return 'gib-m1-staff-v2-history-' + token + '-' + offset;
}

function staffClockCacheReadJson_(cache, key) {
  try {
    var text = cache.get(key);
    return text ? JSON.parse(text) : null;
  } catch (error) {
    return null;
  }
}

function staffClockCachePutJson_(cache, key, value) {
  var text = JSON.stringify(value);
  if (Utilities.newBlob(text).getBytes().length > GIB_M1_STAFF_CACHE_MAX_BYTES_) {
    throw new Error('Staff Clock cached value exceeds the safe byte bound.');
  }
  cache.put(key, text, GIB_M1_STAFF_CACHE_TTL_SECONDS_);
}

function staffClockManifestMatches_(manifest, state, token) {
  return Boolean(manifest)
    && staffClockExactKeys_(manifest, [
      'signature', 'target', 'mode', 'token', 'summaryKey', 'streams', 'history'
    ])
    && manifest.signature === state.signature
    && manifest.target === state.target
    && manifest.mode === state.mode
    && manifest.token === token
    && manifest.summaryKey === staffClockCacheSummaryKey_(state.signature)
    && staffClockExactKeys_(manifest.streams, ['records', 'attention', 'audit'])
    && staffClockExactKeys_(manifest.history, ['total', 'digest'])
    && typeof manifest.history.total === 'number'
    && isFinite(manifest.history.total)
    && Math.floor(manifest.history.total) === manifest.history.total
    && manifest.history.total >= 0
    && GIB_M1_STAFF_VIEW_TOKEN_PATTERN_.test(manifest.history.digest);
}

function staffClockInvalidateCachedView_(cache, manifest) {
  try {
    if (manifest && manifest.summaryKey) cache.remove(manifest.summaryKey);
    if (manifest && manifest.token) cache.remove(staffClockCacheManifestKey_(manifest.token));
  } catch (error) {
    // A cache miss is already fail-closed as a stale immutable view.
  }
}

function staffClockReadLegacySnapshot_(body, includeAdmin) {
  var spreadsheet = openExpectedSpreadsheet_(body);
  var staffState = staffClockStaffState_(spreadsheet);
  var rawTimeState = staffClockReadTime_(spreadsheet, staffState);
  var adjustmentState = staffClockAdjustmentSheetState_(
    spreadsheet,
    staffState,
    rawTimeState,
    false
  );
  var timeState = staffClockApplyAdjustments_(rawTimeState, adjustmentState);
  var analysis = staffClockAnalyze_(staffState, timeState);
  var records = staffClockSortRecords_(timeState.records);
  var value = {
    ok: true,
    target: requestTarget_(body),
    staff: staffState.active,
    records: records.map(staffClockPublicRecord_)
  };
  if (includeAdmin) {
    var auditState = staffClockReadAudit_(spreadsheet, staffState, rawTimeState);
    var today = todayNewYork_();
    value.audit = auditState.records.map(staffClockPublicAudit_)
      .concat(adjustmentState.records.map(staffClockPublicAdjustment_));
    value.clockedInNow = analysis.clockedInNow;
    value.todayPunches = records.filter(function(record) {
      return record.date === today;
    }).map(function(record) {
      return {
        punchId: record.punchId,
        staffId: record.staffId,
        staffName: record.staffName,
        punchAction: record.action,
        timestamp: record.timestamp,
        source: record.source,
        status: record.status
      };
    });
    value.needsAttention = analysis.issues.map(staffClockPublicIssue_);
    value.periods = {
      current: staffClockPeriodSummary_(staffClockPayPeriod_(today, 0), staffState, analysis),
      previous: staffClockPeriodSummary_(staffClockPayPeriod_(today, -1), staffState, analysis)
    };
  }
  return value;
}

function staffClockBuildView_(state, includeAdmin) {
  var spreadsheet = state.spreadsheet;
  var staffState = state.staffState;
  var rawTimeState = staffClockReadTime_(spreadsheet, staffState);
  var adjustmentState = staffClockAdjustmentSheetState_(
    spreadsheet,
    staffState,
    rawTimeState,
    false
  );
  var timeState = staffClockApplyAdjustments_(rawTimeState, adjustmentState);
  var analysis = staffClockAnalyze_(staffState, timeState);
  var today = state.today;
  var currentPeriod = staffClockPayPeriod_(today, 0);
  var previousPeriod = staffClockPayPeriod_(today, -1);
  var relevantRecords = staffClockRelevantRecords_(
    timeState,
    adjustmentState,
    analysis,
    today,
    previousPeriod,
    currentPeriod
  );
  var issueGroups = staffClockGroupIssues_(analysis, timeState);
  var records = staffClockSelectRecords_(
    relevantRecords,
    adjustmentState,
    analysis,
    issueGroups,
    today,
    previousPeriod,
    currentPeriod
  );
  var target = state.target;
  var publicRecords = records.map(staffClockPublicRecord_);
  var publicIssues = issueGroups.map(staffClockPublicIssueGroup_);
  var periods = {
    current: staffClockPeriodSummary_(currentPeriod, staffState, analysis),
    previous: staffClockPeriodSummary_(previousPeriod, staffState, analysis)
  };
  var relevantAudit = [];
  var publicAudit = [];
  var publicHistory = [];
  if (includeAdmin) {
    var auditState = staffClockReadAudit_(spreadsheet, staffState, rawTimeState);
    relevantAudit = staffClockRelevantAudit_(auditState, relevantRecords)
      .concat(staffClockRelevantAudit_(adjustmentState, relevantRecords));
    publicAudit = staffClockSelectAudit_(
      staffClockRelevantAudit_(auditState, records)
        .concat(staffClockRelevantAudit_(adjustmentState, records))
    ).map(function(record) {
      return record.clockInPunchId
        ? staffClockPublicAdjustment_(record)
        : staffClockPublicAudit_(record);
    });
    publicHistory = staffClockSortedCompletedShifts_(analysis).map(function(shift) {
      return staffClockPublicCompletedShift_(shift, adjustmentState);
    });
  }
  var historyDigest = staffClockSha256Hex_(JSON.stringify(publicHistory));
  var todayPunchTotal = relevantRecords.filter(function(record) {
    return record.date === today;
  }).length;
  var todayPunchCount = records.filter(function(record) {
    return record.date === today;
  }).length;
  var adjustmentTotal = relevantRecords.filter(function(record) {
    return staffClockPeriodAdjustment_(record, previousPeriod, currentPeriod);
  }).length;
  var adjustmentCount = records.filter(function(record) {
    return staffClockPeriodAdjustment_(record, previousPeriod, currentPeriod);
  }).length;
  var view = {
    token: '',
    today: today,
    recordCount: publicRecords.length,
    recordTotal: relevantRecords.length,
    todayPunchCount: todayPunchCount,
    todayPunchTotal: todayPunchTotal,
    adjustmentCount: adjustmentCount,
    adjustmentTotal: adjustmentTotal,
    attentionCount: publicIssues.length,
    attentionOccurrenceCount: analysis.issues.length,
    auditCount: includeAdmin ? publicAudit.length : 0,
    auditTotal: includeAdmin ? relevantAudit.length : 0,
    recordsTruncated: publicRecords.length < relevantRecords.length,
    auditTruncated: includeAdmin && publicAudit.length < relevantAudit.length
  };
  var canonical = [
    'gib-m1-staff-view-v2',
    state.signature,
    target,
    today,
    staffState.all.map(function(staff) {
      return {
        staffId: staff.staffId,
        staffName: staff.staffName,
        active: staff.active
      };
    }),
    publicRecords,
    publicIssues,
    periods,
    view
  ];
  if (includeAdmin) canonical.push(publicAudit, {
    total: publicHistory.length,
    digest: historyDigest
  });
  var token = staffClockSha256Hex_(JSON.stringify(canonical));
  if (!GIB_M1_STAFF_VIEW_TOKEN_PATTERN_.test(token)) {
    throw new Error('Staff Clock view token could not be created.');
  }
  view.token = token;
  return {
    target: target,
    signature: state.signature,
    summary: {
      ok: true,
      target: target,
      staff: staffState.active,
      clockedInNow: analysis.clockedInNow,
      periods: periods,
      view: view
    },
    streams: {
      records: publicRecords,
      attention: publicIssues,
      audit: publicAudit
    },
    history: {
      items: publicHistory,
      digest: historyDigest
    }
  };
}

function staffClockReadPagedSummary_(body, includeAdmin) {
  var state = staffClockViewState_(body, includeAdmin);
  var cache = staffClockCache_();
  var summaryKey = staffClockCacheSummaryKey_(state.signature);
  var cached = staffClockCacheReadJson_(cache, summaryKey);
  if (
    cached
    && staffClockExactKeys_(cached, ['signature', 'summary'])
    && cached.signature === state.signature
    && cached.summary
    && cached.summary.view
    && GIB_M1_STAFF_VIEW_TOKEN_PATTERN_.test(cached.summary.view.token)
  ) {
    var cachedManifest = staffClockCacheReadJson_(
      cache,
      staffClockCacheManifestKey_(cached.summary.view.token)
    );
    if (staffClockManifestMatches_(cachedManifest, state, cached.summary.view.token)) {
      return cached.summary;
    }
    staffClockInvalidateCachedView_(cache, cachedManifest || {
      summaryKey: summaryKey,
      token: cached.summary.view.token
    });
  }
  var built = staffClockBuildView_(state, includeAdmin);
  staffClockCacheBuiltView_(cache, state, built);
  return built.summary;
}

function staffClockPageRequest_(body, includeAdmin) {
  var viewToken = body && typeof body.viewToken === 'string' ? body.viewToken : '';
  var stream = body && typeof body.stream === 'string' ? body.stream : '';
  var offset = body && body.offset;
  var streamAllowed = stream === 'records'
    || stream === 'attention'
    || (includeAdmin && stream === 'audit');
  if (
    !GIB_M1_STAFF_VIEW_TOKEN_PATTERN_.test(viewToken)
    || !streamAllowed
    || typeof offset !== 'number'
    || !isFinite(offset)
    || Math.floor(offset) !== offset
    || offset < 0
    || offset > GIB_M1_MAX_SAFE_INTEGER_
  ) return null;
  return { viewToken: viewToken, stream: stream, offset: offset };
}

function staffClockPageEnvelope_(target, request, streamItems, itemCount) {
  var items = streamItems.slice(request.offset, request.offset + itemCount);
  var nextOffset = request.offset + items.length;
  return {
    ok: true,
    target: target,
    viewToken: request.viewToken,
    stream: request.stream,
    offset: request.offset,
    items: items,
    nextOffset: nextOffset < streamItems.length ? nextOffset : null
  };
}

function staffClockPageByteLength_(value) {
  return Utilities.newBlob(JSON.stringify(value)).getBytes().length;
}

function staffClockBoundedPage_(target, request, streamItems) {
  var maximum = Math.min(
    GIB_M1_STAFF_PAGE_SIZE_,
    streamItems.length - request.offset
  );
  var low = 1;
  var high = maximum;
  var accepted = null;
  while (low <= high) {
    var count = Math.floor((low + high) / 2);
    var candidate = staffClockPageEnvelope_(target, request, streamItems, count);
    if (staffClockPageByteLength_(candidate) <= GIB_M1_STAFF_PAGE_MAX_BYTES_) {
      accepted = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return accepted;
}

function staffClockHistoryPageRequest_(body) {
  var viewToken = body && typeof body.viewToken === 'string' ? body.viewToken : '';
  var offset = body && body.offset;
  if (
    !GIB_M1_STAFF_VIEW_TOKEN_PATTERN_.test(viewToken)
    || typeof offset !== 'number'
    || !isFinite(offset)
    || Math.floor(offset) !== offset
    || offset < 0
    || offset > GIB_M1_MAX_SAFE_INTEGER_
  ) return null;
  return { viewToken: viewToken, offset: offset };
}

function staffClockPublicCompletedShift_(shift, adjustmentState) {
  var clockInRequestId = shift.clockIn.adjustmentRequestId || '';
  var clockOutRequestId = shift.clockOut.adjustmentRequestId || '';
  var sharedRequestId = clockInRequestId === clockOutRequestId
    ? clockInRequestId
    : '';
  var candidateAdjustment = sharedRequestId
    ? adjustmentState.byRequestId[clockInRequestId]
    : null;
  var latestAdjustment = candidateAdjustment
    && candidateAdjustment.clockInPunchId === shift.clockIn.punchId
    && candidateAdjustment.clockOutPunchId === shift.clockOut.punchId
    && candidateAdjustment.correctedClockInAt === shift.clockIn.timestamp
    && candidateAdjustment.correctedClockOutAt === shift.clockOut.timestamp
    ? candidateAdjustment
    : null;
  if (sharedRequestId && !latestAdjustment) {
    throw new Error('Staff Clock completed-shift adjustment evidence is incomplete.');
  }
  return {
    clockIn: staffClockPublicRecord_(shift.clockIn),
    clockOut: staffClockPublicRecord_(shift.clockOut),
    latestAdjustment: latestAdjustment
      ? staffClockPublicAdjustment_(latestAdjustment)
      : null
  };
}

function staffClockSortedCompletedShifts_(analysis) {
  return analysis.completedShifts.slice().sort(function(left, right) {
    return right.clockIn.timestampMs - left.clockIn.timestampMs
      || right.clockOut.timestampMs - left.clockOut.timestampMs
      || right.clockIn.sheetRow - left.clockIn.sheetRow
      || right.clockOut.sheetRow - left.clockOut.sheetRow
      || right.clockIn.punchId.localeCompare(left.clockIn.punchId)
      || right.clockOut.punchId.localeCompare(left.clockOut.punchId);
  });
}

function staffClockHistoryPageEnvelope_(target, request, shifts, itemCount) {
  var items = shifts.slice(request.offset, request.offset + itemCount);
  var nextOffset = request.offset + items.length;
  return {
    ok: true,
    target: target,
    viewToken: request.viewToken,
    offset: request.offset,
    total: shifts.length,
    items: items,
    nextOffset: nextOffset < shifts.length ? nextOffset : null
  };
}

function staffClockBoundedHistoryPage_(target, request, shifts) {
  if (request.offset > shifts.length) return null;
  var maximum = Math.min(
    GIB_M1_STAFF_HISTORY_PAGE_SIZE_,
    shifts.length - request.offset
  );
  if (maximum === 0) {
    return staffClockHistoryPageEnvelope_(target, request, shifts, 0);
  }
  var low = 1;
  var high = maximum;
  var accepted = null;
  while (low <= high) {
    var count = Math.floor((low + high) / 2);
    var candidate = staffClockHistoryPageEnvelope_(
      target,
      request,
      shifts,
      count
    );
    if (staffClockPageByteLength_(candidate) <= GIB_M1_STAFF_HISTORY_PAGE_MAX_BYTES_) {
      accepted = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return accepted;
}

function staffClockCacheBuiltView_(cache, state, built) {
  var token = built.summary.view.token;
  var summaryKey = staffClockCacheSummaryKey_(state.signature);
  var manifest = {
    signature: state.signature,
    target: state.target,
    mode: state.mode,
    token: token,
    summaryKey: summaryKey,
    streams: { records: [], attention: [], audit: [] },
    history: {
      total: built.history.items.length,
      digest: built.history.digest
    }
  };
  ['records', 'attention', 'audit'].forEach(function(stream) {
    var items = built.streams[stream];
    var offset = 0;
    while (offset < items.length) {
      var request = { viewToken: token, stream: stream, offset: offset };
      var page = staffClockBoundedPage_(state.target, request, items);
      if (!page) throw new Error('Staff Clock page exceeds the safe byte bound.');
      var pageKey = staffClockCachePageKey_(token, stream, offset);
      staffClockCachePutJson_(cache, pageKey, page);
      manifest.streams[stream].push({ offset: offset, key: pageKey });
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
  });
  if (state.mode === 'admin') {
    var historyOffset = 0;
    do {
      var historyRequest = { viewToken: token, offset: historyOffset };
      var historyPage = staffClockBoundedHistoryPage_(
        state.target,
        historyRequest,
        built.history.items
      );
      if (!historyPage) {
        throw new Error('Staff Clock history page exceeds the safe byte bound.');
      }
      staffClockCachePutJson_(
        cache,
        staffClockCacheHistoryPageKey_(token, historyOffset),
        historyPage
      );
      if (historyPage.nextOffset === null) break;
      historyOffset = historyPage.nextOffset;
    } while (historyOffset < built.history.items.length);
  }
  staffClockCachePutJson_(cache, summaryKey, {
    signature: state.signature,
    summary: built.summary
  });
  staffClockCachePutJson_(cache, staffClockCacheManifestKey_(token), manifest);
}

function staffClockManifestPageKey_(manifest, stream, offset) {
  var entries = manifest.streams[stream];
  if (!Array.isArray(entries)) return '';
  for (var index = 0; index < entries.length; index += 1) {
    var entry = entries[index];
    if (
      staffClockExactKeys_(entry, ['offset', 'key'])
      && entry.offset === offset
      && entry.key === staffClockCachePageKey_(manifest.token, stream, offset)
    ) return entry.key;
  }
  return '';
}

function staffClockReadPage_(body, includeAdmin) {
  var target = requestTarget_(body);
  var request = staffClockPageRequest_(body, includeAdmin);
  if (!request) return { ok: false, target: target, result: 'rejected' };
  var state = staffClockViewState_(body, includeAdmin);
  var cache = staffClockCache_();
  var manifest = staffClockCacheReadJson_(
    cache,
    staffClockCacheManifestKey_(request.viewToken)
  );
  if (!staffClockManifestMatches_(manifest, state, request.viewToken)) {
    return { ok: false, target: target, result: 'stale' };
  }
  var pageKey = staffClockManifestPageKey_(manifest, request.stream, request.offset);
  if (!pageKey) {
    return { ok: false, target: target, result: 'rejected' };
  }
  var page = staffClockCacheReadJson_(cache, pageKey);
  if (
    !page
    || !staffClockExactKeys_(page, [
      'ok', 'target', 'viewToken', 'stream', 'offset', 'items', 'nextOffset'
    ])
    || page.ok !== true
    || page.target !== target
    || page.viewToken !== request.viewToken
    || page.stream !== request.stream
    || page.offset !== request.offset
    || !Array.isArray(page.items)
    || page.items.length < 1
    || page.items.length > GIB_M1_STAFF_PAGE_SIZE_
    || staffClockPageByteLength_(page) > GIB_M1_STAFF_PAGE_MAX_BYTES_
  ) {
    staffClockInvalidateCachedView_(cache, manifest);
    return { ok: false, target: target, result: 'stale' };
  }
  return page;
}

function staffClockReadHistoryPage_(body) {
  var target = requestTarget_(body);
  var request = staffClockHistoryPageRequest_(body);
  if (!request) return { ok: false, target: target, result: 'rejected' };
  var state = staffClockViewState_(body, true);
  var cache = staffClockCache_();
  var manifest = staffClockCacheReadJson_(
    cache,
    staffClockCacheManifestKey_(request.viewToken)
  );
  if (!staffClockManifestMatches_(manifest, state, request.viewToken)) {
    return { ok: false, target: target, result: 'stale' };
  }
  if (manifest.mode !== 'admin' || request.offset > manifest.history.total) {
    return { ok: false, target: target, result: 'rejected' };
  }
  var page = staffClockCacheReadJson_(
    cache,
    staffClockCacheHistoryPageKey_(request.viewToken, request.offset)
  );
  if (
    !page
    || !staffClockExactKeys_(page, [
      'ok', 'target', 'viewToken', 'offset', 'total', 'items', 'nextOffset'
    ])
    || page.ok !== true
    || page.target !== target
    || page.viewToken !== request.viewToken
    || page.offset !== request.offset
    || page.total !== manifest.history.total
    || !Array.isArray(page.items)
    || page.items.length > GIB_M1_STAFF_HISTORY_PAGE_SIZE_
    || (page.items.length === 0 && page.total !== 0)
    || staffClockPageByteLength_(page) > GIB_M1_STAFF_HISTORY_PAGE_MAX_BYTES_
  ) {
    staffClockInvalidateCachedView_(cache, manifest);
    return { ok: false, target: target, result: 'stale' };
  }
  var endOffset = page.offset + page.items.length;
  if (
    endOffset > page.total
    || page.nextOffset !== (endOffset < page.total ? endOffset : null)
  ) {
    staffClockInvalidateCachedView_(cache, manifest);
    return { ok: false, target: target, result: 'stale' };
  }
  return page;
}

function staffClockWithLock_(busyMessage, callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResult_({ ok: false, result: 'failed', message: busyMessage });
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function staffClockSnapshotAction_(body) {
  return staffClockWithLock_('Staff Clock was busy. Nothing changed.', function() {
    return jsonResult_(staffClockReadLegacySnapshot_(body, false));
  });
}

function staffClockSnapshotV2Action_(body) {
  return staffClockWithLock_('Staff Clock was busy. Nothing changed.', function() {
    return jsonResult_(staffClockReadPagedSummary_(body, false));
  });
}

function staffClockSnapshotPageV2Action_(body) {
  return staffClockWithLock_('Staff Clock was busy. Nothing changed.', function() {
    return jsonResult_(staffClockReadPage_(body, false));
  });
}

function validateStaffClockPunch_(punch, staffState) {
  if (!staffClockExactKeys_(punch, [
    'punchId', 'timestamp', 'date', 'staffId', 'staffName', 'punchAction',
    'site', 'device', 'build', 'note'
  ])) return null;
  var punchId = safeExactText_(punch.punchId, 160, false);
  var timestamp = staffClockTimestamp_(punch.timestamp);
  var date = exactText_(punch.date);
  var staffId = safeExactText_(punch.staffId, 80, false);
  var staffName = safeExactText_(punch.staffName, 100, false);
  var action = punch.punchAction === 'clockIn' || punch.punchAction === 'clockOut'
    ? punch.punchAction
    : '';
  var site = safeExactText_(punch.site, 80, false);
  var device = safeText_(punch.device, 120, false);
  var build = safeText_(punch.build, 120, false);
  var note = safeExactText_(punch.note, 400, true);
  var staff = staffState.byId[staffId];
  if (
    !punchId
    || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(punchId)
    || !timestamp
    || !validCalendarDate_(date)
    || date !== timestamp.slice(0, 10)
    || Date.parse(timestamp) > Date.now() + 5 * 60 * 1000
    || !staff
    || !staff.active
    || staffName !== staff.staffName
    || !action
    || !site
    || !device
    || !build
  ) return null;
  return {
    punchId: punchId,
    timestamp: timestamp,
    timestampMs: Date.parse(timestamp),
    date: date,
    staffId: staffId,
    staffName: staff.staffName,
    action: action,
    site: site,
    device: device,
    build: build,
    note: note,
    status: 'ACTIVE',
    source: 'Tablet',
    adminName: '',
    linkedPunchId: ''
  };
}

function staffClockPunchAction_(body) {
  return staffClockWithLock_('Staff Clock was busy. The punch was not changed.', function() {
    if (!Array.isArray(body.punches) || body.punches.length < 1 || body.punches.length > 50) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'Staff Clock punches were rejected.' });
    }
    var spreadsheet = openExpectedSpreadsheet_(body);
    var staffState = staffClockStaffState_(spreadsheet);
    var timeState = staffClockReadTime_(spreadsheet, staffState);
    var adjustmentState = staffClockAdjustmentSheetState_(
      spreadsheet,
      staffState,
      timeState,
      false
    );
    var seen = {};
    var results = body.punches.map(function(punch) {
      var requestedId = safeExactText_(punch && punch.punchId, 160, true);
      var candidate = validateStaffClockPunch_(punch, staffState);
      if (!candidate || seen[requestedId]) {
        return { punchId: requestedId, result: 'rejected', linkedPunchId: '' };
      }
      seen[requestedId] = true;
      var existing = timeState.byId[candidate.punchId];
      if (existing) {
        return staffClockSamePunch_(existing, candidate)
          ? { punchId: candidate.punchId, result: 'already exists', linkedPunchId: existing.punchId }
          : { punchId: candidate.punchId, result: 'rejected', linkedPunchId: '' };
      }
      var effectiveTimeState = staffClockApplyAdjustments_(timeState, adjustmentState);
      var analysis = staffClockAnalyze_(staffState, effectiveTimeState);
      var current = analysis.byStaff[candidate.staffId];
      if (current.issues.length) {
        return { punchId: candidate.punchId, result: 'needs attention', linkedPunchId: '' };
      }
      var expectedAction = current.open ? 'clockOut' : 'clockIn';
      if (
        candidate.action !== expectedAction
        || (current.last && candidate.timestampMs <= current.last.timestampMs)
      ) {
        return { punchId: candidate.punchId, result: 'rejected', linkedPunchId: '' };
      }
      var shiftMilliseconds = candidate.action === 'clockOut'
        ? candidate.timestampMs - current.open.timestampMs
        : 0;
      if (candidate.action === 'clockOut' && shiftMilliseconds > GIB_M1_STAFF_MAX_SHIFT_MS_) {
        return { punchId: candidate.punchId, result: 'needs attention', linkedPunchId: '' };
      }
      try {
        staffClockAppendTime_(timeState, candidate);
        return { punchId: candidate.punchId, result: 'added', linkedPunchId: candidate.punchId };
      } catch (error) {
        return { punchId: candidate.punchId, result: 'failed', linkedPunchId: '' };
      }
    });
    SpreadsheetApp.flush();
    return jsonResult_({
      ok: true,
      target: requestTarget_(body),
      results: results
    });
  });
}

function staffTimeReviewAction_(body) {
  return staffClockWithLock_('Staff time was busy. Nothing changed.', function() {
    return jsonResult_(staffClockReadLegacySnapshot_(body, true));
  });
}

function staffTimeReviewV2Action_(body) {
  return staffClockWithLock_('Staff time was busy. Nothing changed.', function() {
    return jsonResult_(staffClockReadPagedSummary_(body, true));
  });
}

function staffTimeReviewPageV2Action_(body) {
  return staffClockWithLock_('Staff time was busy. Nothing changed.', function() {
    return jsonResult_(staffClockReadPage_(body, true));
  });
}

function staffTimeHistoryPageV2Action_(body) {
  return staffClockWithLock_('Staff time was busy. Nothing changed.', function() {
    return jsonResult_(staffClockReadHistoryPage_(body));
  });
}

function validateStaffTimeCorrection_(body, staffState) {
  var requestId = safeExactText_(body && body.requestId, 180, false);
  var punchId = safeExactText_(body && body.punchId, 160, false);
  var timestamp = staffClockTimestamp_(body && body.timestamp);
  var date = exactText_(body && body.date);
  var staffId = safeExactText_(body && body.staffId, 80, false);
  var staffName = safeExactText_(body && body.staffName, 100, false);
  var action = body && (body.punchAction === 'clockIn' || body.punchAction === 'clockOut')
    ? body.punchAction
    : '';
  var site = safeExactText_(body && body.site, 80, false);
  var device = safeText_(body && body.device, 120, false);
  var build = safeText_(body && body.build, 120, false);
  var reason = safeExactText_(body && body.reason, GIB_M1_AUDIT_REASON_MAX_, false);
  var adminName = safeText_(body && body.adminName, 80, false);
  var staff = staffState.byId[staffId];
  var adminNote = 'Admin correction | Request: ' + requestId + ' | Reason: ' + reason;
  if (
    !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(requestId)
    || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(punchId)
    || !timestamp
    || !validCalendarDate_(date)
    || date !== timestamp.slice(0, 10)
    || Date.parse(timestamp) > Date.now() + 5 * 60 * 1000
    || !staff
    || !staff.active
    || staffName !== staff.staffName
    || !action
    || !site
    || !device
    || !build
    || adminNote.length > 400
    || reason.length < 3
    || GIB_M1_ADMIN_NAMES_.indexOf(adminName) === -1
  ) return null;
  return {
    requestId: requestId,
    reason: reason,
    record: {
      punchId: punchId,
      timestamp: timestamp,
      timestampMs: Date.parse(timestamp),
      date: date,
      staffId: staffId,
      staffName: staff.staffName,
      action: action,
      site: site,
      device: device,
      build: build,
      note: adminNote,
      status: 'ACTIVE',
      source: 'Admin-added',
      adminName: adminName,
      linkedPunchId: ''
    }
  };
}

function staffClockAuditMatchesCorrection_(audit, value, linked) {
  return audit.adminName === value.record.adminName
    && audit.staffId === value.record.staffId
    && audit.staffName === value.record.staffName
    && audit.punchTimestamp === value.record.timestamp
    && audit.action === value.record.action
    && audit.reason === value.reason
    && linked
    && linked.staffId === value.record.staffId
    && linked.timestamp === value.record.timestamp
    && linked.action === value.record.action;
}

function staffClockCorrectionResult_(target, result, requestId, record, audit) {
  return jsonResult_({
    ok: true,
    target: target,
    result: result,
    requestId: requestId,
    linkedPunchId: record.punchId,
    auditActionNumber: audit.sheetRow - 1,
    confirmation: {
      adminName: record.adminName,
      punchId: record.punchId,
      staffId: record.staffId,
      staffName: record.staffName,
      timestamp: record.timestamp,
      date: record.date,
      punchAction: record.action,
      reason: audit.reason,
      site: record.site,
      device: record.device,
      build: record.build
    }
  });
}

function staffClockCorrectionRecordForRequest_(timeState, requestId) {
  var requestPrefix = 'Admin correction | Request: ' + requestId + ' |';
  return timeState.records.find(function(record) {
    return record.source === 'Admin-added' && record.note.indexOf(requestPrefix) === 0;
  });
}

function staffTimeCorrectAction_(body) {
  return staffClockWithLock_('Staff time was busy. Nothing changed.', function() {
    var spreadsheet = openExpectedSpreadsheet_(body);
    var staffState = staffClockStaffState_(spreadsheet);
    var value = validateStaffTimeCorrection_(body, staffState);
    if (!value) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'The Staff time correction was rejected.' });
    }
    var timeState = staffClockReadTime_(spreadsheet, staffState);
    var auditState = staffClockReadAudit_(spreadsheet, staffState, timeState);
    var adjustmentState = staffClockAdjustmentSheetState_(
      spreadsheet,
      staffState,
      timeState,
      false
    );
    if (adjustmentState.byRequestId[value.requestId]) {
      return jsonResult_({ ok: false, result: 'conflict', message: 'The correction request ID conflicts with an existing action.' });
    }
    var replayAudit = auditState.byRequestId[value.requestId];
    if (replayAudit) {
      var replayLinked = timeState.byId[replayAudit.linkedPunchId];
      if (!staffClockAuditMatchesCorrection_(replayAudit, value, replayLinked)) {
        return jsonResult_({ ok: false, result: 'conflict', message: 'The correction request ID conflicts with an existing action.' });
      }
      return staffClockCorrectionResult_(
        requestTarget_(body),
        'already exists',
        value.requestId,
        replayLinked,
        replayAudit
      );
    }
    var existingId = timeState.byId[value.record.punchId];
    if (existingId && !staffClockSamePunch_(existingId, value.record)) {
      return jsonResult_({ ok: false, result: 'conflict', message: 'The correction punch ID conflicts with an existing punch.' });
    }
    var permanentRequestRecord = staffClockCorrectionRecordForRequest_(timeState, value.requestId);
    if (permanentRequestRecord && permanentRequestRecord.punchId !== value.record.punchId) {
      return jsonResult_({ ok: false, result: 'conflict', message: 'The correction request ID conflicts with an existing punch.' });
    }
    if (permanentRequestRecord && !staffClockSamePunch_(permanentRequestRecord, value.record)) {
      return jsonResult_({ ok: false, result: 'conflict', message: 'The correction request ID conflicts with an existing action.' });
    }
    if (!existingId && permanentRequestRecord) existingId = permanentRequestRecord;
    var linked = existingId || value.record;
    if (!existingId) {
      staffClockAppendTime_(timeState, value.record);
      // Flush the permanent punch first. A retry can then heal a missing audit.
      SpreadsheetApp.flush();
    }
    var audit = staffClockAppendAudit_(auditState, {
      requestId: value.requestId,
      actionTime: staffClockNowTimestamp_(),
      adminName: value.record.adminName,
      staffId: linked.staffId,
      staffName: linked.staffName,
      punchTimestamp: linked.timestamp,
      action: linked.action,
      punchAction: linked.action,
      reason: value.reason,
      result: existingId ? 'already exists' : 'added',
      linkedPunchId: linked.punchId
    });
    SpreadsheetApp.flush();
    return staffClockCorrectionResult_(
      requestTarget_(body),
      existingId ? 'already exists' : 'added',
      value.requestId,
      linked,
      audit
    );
  });
}

function validateStaffTimeAdjustment_(body) {
  var requestId = safeExactText_(body && body.requestId, 180, false);
  var clockInPunchId = safeExactText_(body && body.clockInPunchId, 160, false);
  var clockOutPunchId = safeExactText_(body && body.clockOutPunchId, 160, false);
  var originalClockInAt = staffClockTimestamp_(body && body.originalClockInAt);
  var originalClockOutAt = staffClockTimestamp_(body && body.originalClockOutAt);
  var correctedClockInAt = staffClockTimestamp_(body && body.correctedClockInAt);
  var correctedClockOutAt = staffClockTimestamp_(body && body.correctedClockOutAt);
  var reason = safeExactText_(body && body.reason, GIB_M1_AUDIT_REASON_MAX_, false);
  var adminName = safeText_(body && body.adminName, 80, false);
  var value = {
    requestId: requestId,
    clockInPunchId: clockInPunchId,
    clockOutPunchId: clockOutPunchId,
    originalClockInAt: originalClockInAt,
    originalClockOutAt: originalClockOutAt,
    correctedClockInAt: correctedClockInAt,
    correctedClockOutAt: correctedClockOutAt,
    reason: reason,
    adminName: adminName
  };
  value.changed = staffClockAdjustmentChange_(value);
  var correctedElapsed = Date.parse(correctedClockOutAt) - Date.parse(correctedClockInAt);
  if (
    !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(requestId)
    || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(clockInPunchId)
    || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(clockOutPunchId)
    || clockInPunchId === clockOutPunchId
    || !originalClockInAt
    || !originalClockOutAt
    || !correctedClockInAt
    || !correctedClockOutAt
    || Date.parse(originalClockOutAt) <= Date.parse(originalClockInAt)
    || correctedElapsed <= 0
    || correctedElapsed > GIB_M1_STAFF_MAX_SHIFT_MS_
    || Date.parse(correctedClockInAt) > Date.now() + 5 * 60 * 1000
    || Date.parse(correctedClockOutAt) > Date.now() + 5 * 60 * 1000
    || !value.changed
    || reason.length < 3
    || GIB_M1_ADMIN_NAMES_.indexOf(adminName) === -1
  ) return null;
  return value;
}

function staffClockAdjustmentMatches_(record, value) {
  return record.adminName === value.adminName
    && record.clockInPunchId === value.clockInPunchId
    && record.clockOutPunchId === value.clockOutPunchId
    && record.originalClockInAt === value.originalClockInAt
    && record.originalClockOutAt === value.originalClockOutAt
    && record.correctedClockInAt === value.correctedClockInAt
    && record.correctedClockOutAt === value.correctedClockOutAt
    && record.changed === value.changed
    && record.reason === value.reason;
}

function staffClockAdjustmentPair_(timeState, value) {
  var clockIn = timeState.byId[value.clockInPunchId];
  var clockOut = timeState.byId[value.clockOutPunchId];
  if (
    !clockIn
    || !clockOut
    || clockIn.status !== 'ACTIVE'
    || clockOut.status !== 'ACTIVE'
    || clockIn.staffId !== clockOut.staffId
    || clockIn.staffName !== clockOut.staffName
    || clockIn.action !== 'clockIn'
    || clockOut.action !== 'clockOut'
    || clockIn.timestamp !== value.originalClockInAt
    || clockOut.timestamp !== value.originalClockOutAt
  ) return null;
  var active = timeState.records.filter(function(record) {
    return record.staffId === clockIn.staffId && record.status === 'ACTIVE';
  }).sort(function(left, right) {
    return left.timestampMs - right.timestampMs || left.sheetRow - right.sheetRow;
  });
  var clockInIndex = active.findIndex(function(record) {
    return record.punchId === clockIn.punchId;
  });
  var clockOutIndex = active.findIndex(function(record) {
    return record.punchId === clockOut.punchId;
  });
  if (clockInIndex < 0 || clockOutIndex !== clockInIndex + 1) return null;
  var previous = active[clockInIndex - 1] || null;
  var next = active[clockOutIndex + 1] || null;
  var correctedInMs = Date.parse(value.correctedClockInAt);
  var correctedOutMs = Date.parse(value.correctedClockOutAt);
  if (
    (previous && (previous.action !== 'clockOut' || previous.timestampMs >= correctedInMs))
    || (next && (next.action !== 'clockIn' || next.timestampMs <= correctedOutMs))
  ) return null;
  return { clockIn: clockIn, clockOut: clockOut };
}

function staffClockAdjustmentResult_(target, result, record) {
  return jsonResult_({
    ok: true,
    target: target,
    requestId: record.requestId,
    result: result,
    linkedPunchIds: [record.clockInPunchId, record.clockOutPunchId],
    auditActionNumber: record.sheetRow - 1,
    confirmation: {
      actionTime: record.actionTime,
      adminName: record.adminName,
      staffId: record.staffId,
      staffName: record.staffName,
      changed: record.changed,
      clockInPunchId: record.clockInPunchId,
      clockOutPunchId: record.clockOutPunchId,
      originalClockInAt: record.originalClockInAt,
      originalClockOutAt: record.originalClockOutAt,
      correctedClockInAt: record.correctedClockInAt,
      correctedClockOutAt: record.correctedClockOutAt,
      reason: record.reason
    }
  });
}

function staffTimeAdjustAction_(body) {
  return staffClockWithLock_('Staff time was busy. Nothing changed.', function() {
    var value = validateStaffTimeAdjustment_(body);
    if (!value) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'The Staff time adjustment was rejected.' });
    }
    var spreadsheet = openExpectedSpreadsheet_(body);
    var staffState = staffClockStaffState_(spreadsheet);
    var rawTimeState = staffClockReadTime_(spreadsheet, staffState);
    var adjustmentState = staffClockAdjustmentSheetState_(
      spreadsheet,
      staffState,
      rawTimeState,
      false
    );
    var auditState = staffClockReadAudit_(spreadsheet, staffState, rawTimeState);
    if (
      auditState.byRequestId[value.requestId]
      || staffClockCorrectionRecordForRequest_(rawTimeState, value.requestId)
    ) {
      return jsonResult_({ ok: false, result: 'conflict', message: 'The adjustment request ID conflicts with an existing action.' });
    }
    var replay = adjustmentState.byRequestId[value.requestId];
    if (replay) {
      if (!staffClockAdjustmentMatches_(replay, value)) {
        return jsonResult_({ ok: false, result: 'conflict', message: 'The adjustment request ID conflicts with an existing action.' });
      }
      return staffClockAdjustmentResult_(requestTarget_(body), 'already adjusted', replay);
    }
    var effectiveTimeState = staffClockApplyAdjustments_(rawTimeState, adjustmentState);
    var pair = staffClockAdjustmentPair_(effectiveTimeState, value);
    if (!pair) {
      return jsonResult_({ ok: false, result: 'conflict', message: 'The shift changed or the corrected times conflict with nearby punches.' });
    }
    if (!adjustmentState.sheet) {
      adjustmentState = staffClockAdjustmentSheetState_(
        spreadsheet,
        staffState,
        rawTimeState,
        true
      );
    }
    var record = staffClockAppendAdjustment_(adjustmentState, {
      requestId: value.requestId,
      actionTime: staffClockNowTimestamp_(),
      adminName: value.adminName,
      staffId: pair.clockIn.staffId,
      staffName: pair.clockIn.staffName,
      clockInPunchId: value.clockInPunchId,
      clockOutPunchId: value.clockOutPunchId,
      originalClockInAt: value.originalClockInAt,
      originalClockOutAt: value.originalClockOutAt,
      correctedClockInAt: value.correctedClockInAt,
      correctedClockOutAt: value.correctedClockOutAt,
      changed: value.changed,
      reason: value.reason,
      result: 'adjusted'
    });
    SpreadsheetApp.flush();
    return staffClockAdjustmentResult_(requestTarget_(body), 'adjusted', record);
  });
}

function validateStaffTimeVoid_(body) {
  var requestId = safeExactText_(body && body.requestId, 180, false);
  var punchId = safeExactText_(body && body.punchId, 160, false);
  var reason = safeExactText_(body && body.reason, GIB_M1_AUDIT_REASON_MAX_, false);
  var adminName = safeText_(body && body.adminName, 80, false);
  if (
    !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(requestId)
    || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(punchId)
    || reason.length < 3
    || GIB_M1_ADMIN_NAMES_.indexOf(adminName) === -1
  ) return null;
  return { requestId: requestId, punchId: punchId, reason: reason, adminName: adminName };
}

function staffClockAuditMatchesVoid_(audit, value, target) {
  return audit.adminName === value.adminName
    && audit.action === 'void'
    && audit.reason === value.reason
    && audit.linkedPunchId === value.punchId
    && target
    && audit.staffId === target.staffId
    && audit.staffName === target.staffName
    && audit.punchTimestamp === target.timestamp;
}

function staffClockVoidResult_(targetName, result, value, record, audit) {
  return jsonResult_({
    ok: true,
    target: targetName,
    requestId: value.requestId,
    result: result,
    linkedPunchId: record.punchId,
    auditActionNumber: audit.sheetRow - 1,
    confirmation: {
      adminName: value.adminName,
      punchId: record.punchId,
      staffId: record.staffId,
      staffName: record.staffName,
      timestamp: record.timestamp,
      date: record.date,
      punchAction: record.action,
      reason: value.reason,
      status: 'VOID'
    }
  });
}

function staffTimeVoidAction_(body) {
  return staffClockWithLock_('Staff time was busy. Nothing changed.', function() {
    var value = validateStaffTimeVoid_(body);
    if (!value) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'The Staff time void was rejected.' });
    }
    var spreadsheet = openExpectedSpreadsheet_(body);
    var staffState = staffClockStaffState_(spreadsheet);
    var timeState = staffClockReadTime_(spreadsheet, staffState);
    var target = timeState.byId[value.punchId];
    if (!target) {
      return jsonResult_({ ok: false, result: 'rejected', message: 'The punch to void was not found.' });
    }
    var auditState = staffClockReadAudit_(spreadsheet, staffState, timeState);
    var adjustmentState = staffClockAdjustmentSheetState_(
      spreadsheet,
      staffState,
      timeState,
      false
    );
    if (
      adjustmentState.byRequestId[value.requestId]
      || staffClockCorrectionRecordForRequest_(timeState, value.requestId)
    ) {
      return jsonResult_({ ok: false, result: 'conflict', message: 'The void request ID conflicts with an existing action.' });
    }
    var replayAudit = auditState.byRequestId[value.requestId];
    if (replayAudit) {
      if (!staffClockAuditMatchesVoid_(replayAudit, value, target)) {
        return jsonResult_({ ok: false, result: 'conflict', message: 'The void request ID conflicts with an existing action.' });
      }
      if (target.status === 'ACTIVE') {
        staffClockSetVoided_(timeState, target);
        SpreadsheetApp.flush();
      } else if (target.status !== 'VOID') {
        return jsonResult_({ ok: false, result: 'conflict', message: 'The void request conflicts with the punch status.' });
      }
      return staffClockVoidResult_(requestTarget_(body), 'already voided', value, target, replayAudit);
    }
    var priorVoid = auditState.records.find(function(audit) {
      return audit.action === 'void' && audit.linkedPunchId === target.punchId;
    });
    if (priorVoid) {
      if (target.status === 'ACTIVE') {
        staffClockSetVoided_(timeState, target);
        SpreadsheetApp.flush();
      }
      var repeatedAudit = staffClockAppendAudit_(auditState, {
        requestId: value.requestId,
        actionTime: staffClockNowTimestamp_(),
        adminName: value.adminName,
        staffId: target.staffId,
        staffName: target.staffName,
        punchTimestamp: target.timestamp,
        action: 'void',
        punchAction: target.action,
        reason: value.reason,
        result: 'already voided',
        linkedPunchId: target.punchId
      });
      SpreadsheetApp.flush();
      return staffClockVoidResult_(requestTarget_(body), 'already voided', value, target, repeatedAudit);
    }
    var wasAlreadyVoid = target.status === 'VOID';
    var audit = staffClockAppendAudit_(auditState, {
      requestId: value.requestId,
      actionTime: staffClockNowTimestamp_(),
      adminName: value.adminName,
      staffId: target.staffId,
      staffName: target.staffName,
      punchTimestamp: target.timestamp,
      action: 'void',
      punchAction: target.action,
      reason: value.reason,
      result: wasAlreadyVoid ? 'already voided' : 'voided',
      linkedPunchId: target.punchId
    });
    // Persist the permanent request before the status update. If the second
    // write is interrupted, the same request can verify and heal it exactly.
    SpreadsheetApp.flush();
    if (!wasAlreadyVoid) {
      staffClockSetVoided_(timeState, target);
      SpreadsheetApp.flush();
    }
    return staffClockVoidResult_(
      requestTarget_(body),
      wasAlreadyVoid ? 'already voided' : 'voided',
      value,
      target,
      audit
    );
  });
}

function gibM1ExactSpreadsheetFiles_(title) {
  var expectedTitle = exactText_(title);
  if (!expectedTitle) throw new Error('Spreadsheet title is not configured.');
  var matches = [];
  var files = DriveApp.getFilesByName(expectedTitle);
  while (files.hasNext()) {
    var file = files.next();
    var active = typeof file.isTrashed !== 'function' || !file.isTrashed();
    if (active && file.getMimeType() === MimeType.GOOGLE_SHEETS) matches.push(file);
  }
  return matches;
}

function gibM1ResolveCreatedSpreadsheet_(title, createdId) {
  for (var attempt = 0; attempt < 5; attempt += 1) {
    var matches = gibM1ExactSpreadsheetFiles_(title);
    if (matches.length > 1) {
      throw new Error('The created Google Sheet could not be uniquely resolved.');
    }
    if (matches.length === 1) {
      if (matches[0].getId() !== createdId) {
        throw new Error('The created Google Sheet could not be uniquely resolved.');
      }
      return matches;
    }
    if (attempt < 4) Utilities.sleep(250);
  }
  throw new Error('The created Google Sheet could not be uniquely resolved.');
}

function gibM1VerifyPermanentRowIds_(sheet, headerCount) {
  var values = sheet.getDataRange().getValues();
  var seen = {};
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i] || [];
    var populated = false;
    for (var j = 0; j < headerCount; j += 1) {
      if (exactText_(row[j])) {
        populated = true;
        break;
      }
    }
    if (!populated) continue;
    var rowId = exactText_(row[0]);
    if (!rowId || seen[rowId]) {
      throw new Error('The Signins RowID state is not replay-safe.');
    }
    seen[rowId] = true;
  }
}

function gibM1EnsureSigninsSchema_(spreadsheet, sheetName, headers, initializeIfMissing) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    if (initializeIfMissing === false) {
      throw new Error('The Signins headings do not match the tracked schema.');
    }
    sheet = spreadsheet.insertSheet(sheetName);
  }
  if (sheet.getLastColumn() > headers.length) {
    throw new Error('The Signins headings do not match the tracked schema.');
  }
  var headings = sheet
    .getRange(1, 1, 1, headers.length)
    .getValues()[0]
    .map(function(value) { return exactText_(value); });
  var hasHeadings = headings.some(function(value) { return Boolean(value); });
  if (hasHeadings) {
    for (var i = 0; i < headers.length; i += 1) {
      if (headings[i] !== headers[i]) {
        throw new Error('The Signins headings do not match the tracked schema.');
      }
    }
  } else {
    if (initializeIfMissing === false || sheet.getLastRow() > 1) {
      throw new Error('The Signins headings do not match the tracked schema.');
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  if (initializeIfMissing !== false) sheet.setFrozenRows(1);
  gibM1VerifyPermanentRowIds_(sheet, headers.length);
  return sheet;
}

function gibM1ProvisionSpreadsheet_(options) {
  var target = cleanText_(options && options.target).toLowerCase();
  var title = exactText_(options && options.title);
  var sheetName = exactText_(options && options.sheetName);
  var propertyName = exactText_(options && options.spreadsheetProperty);
  var forbiddenPropertyName = exactText_(options && options.forbiddenSpreadsheetProperty);
  var provisioningClosedProperty = exactText_(options && options.provisioningClosedProperty);
  var provisioningClosedValue = exactText_(options && options.provisioningClosedValue);
  var closesProvisioning = Boolean(provisioningClosedProperty || provisioningClosedValue);
  var headers = options && options.headers;
  if (
    target !== configuredDeploymentTarget_()
    || (target !== 'test' && target !== 'production')
    || !title
    || !sheetName
    || !propertyName
    || !Array.isArray(headers)
    || headers.length !== GIB_M1_SIGNINS_HEADERS_.length
    || (closesProvisioning && (!provisioningClosedProperty || !provisioningClosedValue))
    || provisioningClosedProperty === propertyName
    || provisioningClosedProperty === GIB_M1_TARGET_LOCK_PROPERTY_
    || (forbiddenPropertyName && provisioningClosedProperty === forbiddenPropertyName)
  ) {
    throw new Error('Spreadsheet provisioning configuration is invalid.');
  }
  for (var h = 0; h < headers.length; h += 1) {
    if (headers[h] !== GIB_M1_SIGNINS_HEADERS_[h]) {
      throw new Error('Spreadsheet provisioning configuration is invalid.');
    }
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Spreadsheet provisioning is busy.');
  try {
    var properties = PropertiesService.getScriptProperties();
    var storedId = exactText_(properties.getProperty(propertyName));
    var storedTarget = cleanText_(properties.getProperty(GIB_M1_TARGET_LOCK_PROPERTY_)).toLowerCase();
    var storedProvisioningClosed = provisioningClosedProperty
      ? exactText_(properties.getProperty(provisioningClosedProperty))
      : '';
    if (
      (storedTarget && storedTarget !== target)
      || (forbiddenPropertyName && exactText_(properties.getProperty(forbiddenPropertyName)))
      || (storedProvisioningClosed && storedProvisioningClosed !== provisioningClosedValue)
      || (closesProvisioning && (storedId || storedTarget || storedProvisioningClosed))
    ) {
      throw new Error('Private production target state conflicts with this project.');
    }
    if (
      provisioningClosedProperty
      && constantTimeTextEqual_(storedProvisioningClosed, provisioningClosedValue)
    ) throw new Error('Production provisioning is permanently closed.');
    var matches = gibM1ExactSpreadsheetFiles_(title);
    if (matches.length > 1) {
      throw new Error('Expected at most one Google Sheet with the configured title.');
    }
    var created = false;
    if (!matches.length) {
      if (!options.createIfMissing) {
        throw new Error('Expected exactly one Google Sheet with the configured title.');
      }
      var createdSpreadsheet = SpreadsheetApp.create(title);
      created = true;
      matches = gibM1ResolveCreatedSpreadsheet_(title, createdSpreadsheet.getId());
    }
    if (matches.length !== 1) {
      throw new Error('Expected exactly one Google Sheet with the configured title.');
    }
    if (storedId && storedId !== matches[0].getId()) {
      throw new Error('Private production target state conflicts with the resolved Sheet.');
    }

    var spreadsheet = SpreadsheetApp.openById(matches[0].getId());
    if (spreadsheet.getName() !== title) {
      throw new Error('Spreadsheet identity check failed.');
    }
    var existingSheet = spreadsheet.getSheetByName(sheetName);
    if (
      options.requireEmptyDataRows === true
      && existingSheet
      && Math.max(0, existingSheet.getLastRow() - 1) !== 0
    ) throw new Error('The first production provisioning Sheet must contain zero data rows.');
    var initializeSchema = options.initializeSchemaOnlyWhenCreated === true
      ? created
      : true;
    var sheet = gibM1EnsureSigninsSchema_(spreadsheet, sheetName, headers, initializeSchema);
    var dataRowCount = Math.max(0, sheet.getLastRow() - 1);
    if (options.requireEmptyDataRows === true && dataRowCount !== 0) {
      throw new Error('The first production provisioning Sheet must contain zero data rows.');
    }
    if (closesProvisioning) {
      var persisted = {};
      persisted[propertyName] = spreadsheet.getId();
      persisted[GIB_M1_TARGET_LOCK_PROPERTY_] = target;
      persisted[provisioningClosedProperty] = provisioningClosedValue;
      properties.setProperties(persisted, false);
    } else {
      properties.setProperty(propertyName, spreadsheet.getId());
      properties.setProperty(GIB_M1_TARGET_LOCK_PROPERTY_, target);
    }
    if (
      exactText_(properties.getProperty(propertyName)) !== spreadsheet.getId()
      || cleanText_(properties.getProperty(GIB_M1_TARGET_LOCK_PROPERTY_)).toLowerCase() !== target
      || (
        closesProvisioning
        && exactText_(properties.getProperty(provisioningClosedProperty)) !== provisioningClosedValue
      )
    ) throw new Error('Private production target state could not be verified.');

    if (closesProvisioning) {
      return {
        ok: true,
        created: created,
        spreadsheetMatches: 1,
        headerCount: headers.length,
        dataRowCount: dataRowCount,
        sheetStored: true,
        targetLocked: true,
        provisioningClosed: true
      };
    }

    return {
      ok: true,
      target: target,
      spreadsheetTitle: title,
      spreadsheetMatches: 1,
      created: created,
      signinsSheet: sheetName,
      headerCount: headers.length,
      dataRowCount: dataRowCount
    };
  } finally {
    lock.releaseLock();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cleanText_: cleanText_,
    exactText_: exactText_,
    normalizeEventText_: normalizeEventText_,
    canonicalTimestamp_: canonicalTimestamp_,
    canonicalSigninKey_: canonicalSigninKey_,
    sameExactSignin_: sameExactSignin_,
    findExactSignin_: findExactSignin_,
    validCalendarDate_: validCalendarDate_,
    activeRecord_: activeRecord_,
    sameEvent_: sameEvent_,
    findExistingEvent_: findExistingEvent_,
    findPermanentAdminRequest_: findPermanentAdminRequest_,
    findAdminCollision_: findAdminCollision_,
    collisionReviewRecord_: collisionReviewRecord_,
    requestTarget_: requestTarget_,
    configuredSpreadsheetId_: configuredSpreadsheetId_,
    legacyKioskAuthorized_: legacyKioskAuthorized_,
    receiverKioskAuthorized_: receiverKioskAuthorized_,
    adminActionAuthorized_: adminActionAuthorized_,
    recoveryAuthorized_: recoveryAuthorized_,
    recoveryWritesEnabled_: recoveryWritesEnabled_,
    validateKioskRow_: validateKioskRow_,
    duplicateKioskRowIds_: duplicateKioskRowIds_,
    validateRecoveryRow_: validateRecoveryRow_,
    gibM1ProvisionSpreadsheet_: gibM1ProvisionSpreadsheet_
  };
}
