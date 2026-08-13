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
    ) {
      if (!adminActionAuthorized_(body)) return rejectedAuthResult_();
    }
    if (action === 'dailyReview') return dailyReviewAction_(body);
    if (action === 'instructorSearch') return instructorSearchAction_(body);
    if (action === 'addMissedInstructor') return addMissedInstructorAction_(body);
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
  var admin = scriptProperty_(GIB_M1_ADMIN_ACTION_PROPERTY_);
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
  var admin = scriptProperty_(GIB_M1_ADMIN_ACTION_PROPERTY_);
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
  var admin = scriptProperty_(GIB_M1_ADMIN_ACTION_PROPERTY_);
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
  var admin = scriptProperty_(GIB_M1_ADMIN_ACTION_PROPERTY_);
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

function publicRecord_(record) {
  var reviewRequired = collisionReviewRecord_(record);
  return {
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
}

function dailyReviewAction_(body) {
  var date = displayDate_(body.date);
  if (!validCalendarDate_(date) || date > todayNewYork_()) {
    return jsonResult_({ ok: false, result: 'rejected', message: 'Choose a non-future date.' });
  }
  var spreadsheet = openExpectedSpreadsheet_(body);
  var state = readSignins_(signinsSheet_(spreadsheet), { tolerantReview: true });
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
    records.push(publicRecord_(record));
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
        || (result !== 'added' && result !== 'already exists')
        || exactText_(row[10]).length > GIB_M1_RECORD_ID_MAX_
        || (result === 'added' && exactText_(row[10]).indexOf('gib-admin-') !== 0)
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
    (result !== 'added' && result !== 'already exists')
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
