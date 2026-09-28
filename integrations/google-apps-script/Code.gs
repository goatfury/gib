/*
 * Standalone TEST Apps Script entrypoint.
 *
 * The Apps Script project ID, deployment ID, OAuth material, spreadsheet ID,
 * and receiver token are intentionally not source-controlled. The TEST project
 * resolves exactly one spreadsheet by title and derives its server-only token
 * from the private Apps Script project ID. Script Properties remain an optional
 * override for incident recovery without changing source.
 */
var GIB_M1_ALLOWED_TARGET = 'test';
var GIB_M1_MANAGER_REVIEW_TEST_ENABLED = true;
var GIB_M1_REVOLUTION_REMOVAL_ENABLED = true;
var GIB_M1_TEST_SPREADSHEET_PROPERTY_ = 'GIB_M1_TEST_SPREADSHEET_ID';
var GIB_M1_TEST_SPREADSHEET_TITLE_ = 'RBJJ M1 — TEST';
var GIB_M1_TEST_SIGNINS_SHEET_ = 'Signins';
var GIB_M1_TEST_SIGNINS_HEADERS_ = [
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
var GIB_M1_TEST_STAFF_SHEET_ = 'Staff Clock Staff';
var GIB_M1_TEST_STAFF_HEADERS_ = ['Staff ID', 'Staff Name', 'Active'];
var GIB_M1_TEST_STAFF_SEED_ = [
  ['mandy-test', 'Mandy Test', true],
  ['front-desk-test-two', 'Front Desk Test Two', true],
  ['front-desk-test-three', 'Front Desk Test Three', true]
];
var GIB_M1_TEST_STAFF_TIME_SHEET_ = 'Staff Time';
var GIB_M1_TEST_STAFF_TIME_HEADERS_ = [
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
var GIB_M1_TEST_STAFF_AUDIT_SHEET_ = 'Staff Time Audit';
var GIB_M1_TEST_STAFF_AUDIT_HEADERS_ = [
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
var GIB_M1_TEST_STAFF_ADJUSTMENT_SHEET_ = 'Staff Time Adjustments';
var GIB_M1_TEST_STAFF_ADJUSTMENT_HEADERS_ = [
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

var TEST_SPREADSHEET_ID = PropertiesService
  .getScriptProperties()
  .getProperty(GIB_M1_TEST_SPREADSHEET_PROPERTY_) || '';
var EXPECTED_SPREADSHEET_NAME = GIB_M1_TEST_SPREADSHEET_TITLE_;
var SHEET_NAME = GIB_M1_TEST_SIGNINS_SHEET_;

function doPost(e) {
  // Invocation-local, editor-armed diagnostics. Never add fields to a Staff reply.
  var trace = gibM1BeginStaffReadTrace_(e), response;
  GIB_M1_ACTIVE_STAFF_READ_TRACE_ = trace;
  try {
    response = adReceiverV2_(e);
    return response;
  } finally {
    GIB_M1_ACTIVE_STAFF_READ_TRACE_ = null;
    try { if (trace) trace.finish(response); } catch (_) {}
  }
}

var GIB_M1_ACTIVE_STAFF_READ_TRACE_ = null;
function gibM1BeginStaffReadTrace_(e) {
  try {
    var started = Date.now(), body = parseRequestBody_(e);
    if (!body || typeof body.staffReadTraceId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.staffReadTraceId)
      || ['staffTimeReviewV2', 'staffTimeReviewPageV2', 'staffTimeHistoryPageV2', 'staffTimeShiftLookupV3', 'staffRecoveryReview'].indexOf(body.action) < 0
      || GIB_M1_ALLOWED_TARGET !== 'test' || body.target !== 'test'
      || GIB_M1_TEST_SPREADSHEET_TITLE_ !== 'RBJJ M1 — TEST' || EXPECTED_SPREADSHEET_NAME !== 'RBJJ M1 — TEST'
      || typeof GIB_M1_RICHMOND_INSTALLATION_ !== 'undefined' || typeof GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ !== 'undefined'
      || typeof gibM1ReadTraceReceipt_ !== 'function' || typeof gibM1TestReadCallbackEnabled_ !== 'function'
      || !gibM1TestReadCallbackEnabled_()) return null;
    // Unarmed requests never create a collector or inspect the final reply.
    var until = Number(PropertiesService.getScriptProperties().getProperty(GIB_M1_READ_TRACE_WINDOW_));
    if (!(until > started && until <= started + 20 * 60000) || !adminActionAuthorized_(body)) return null;
    var receipt = gibM1ReadTraceReceipt_(body.staffReadTraceId, started);
    var stage = 'google.request', failedStage = null, thrown = false, lockUnavailable = false;
    receipt.event('google.request', 'accepted');
    return {
      event: function(nextStage, state, exception) {
        try {
          if (exception) { thrown = true; failedStage = failedStage || (nextStage === 'google.result' ? stage : nextStage); }
          if (nextStage === 'google.lock' && state === 'unavailable') lockUnavailable = true;
          stage = nextStage;
          receipt.event(nextStage, state);
        } catch (_) {}
      },
      finish: function(output) {
        try {
          // Inspect only the result flags in memory; retain no response content.
          var value = output && JSON.parse(output.getContent());
          var successful = Boolean(value && value.ok === true);
          receipt.event('google.result', successful ? 'validated' : 'rejected');
          receipt.finish(thrown ? failedStage : (lockUnavailable ? 'google.lock' : 'google.result'),
            thrown ? 'thrown_exception' : (successful ? 'none' : 'read_rejected'), null, null);
        } catch (_) {
          try { receipt.finish('google.decode', 'ack_read_exception', null, null); } catch (_) {}
        }
      }
    };
  } catch (_) { return null; }
}
function gibM1StaffReadTraceEvent_(stage, state, exception) {
  try {
    if (GIB_M1_ACTIVE_STAFF_READ_TRACE_) GIB_M1_ACTIVE_STAFF_READ_TRACE_.event(stage, state, exception);
  } catch (_) {}
}

function gibM1ExactTestSpreadsheetFiles_() {
  var matches = [];
  var files = DriveApp.getFilesByName(GIB_M1_TEST_SPREADSHEET_TITLE_);
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) matches.push(file);
  }
  return matches;
}

function gibM1ResolveTestSpreadsheetId_() {
  var matches = gibM1ExactTestSpreadsheetFiles_();
  if (matches.length !== 1) {
    throw new Error('Expected exactly one Google Sheet with the configured TEST title.');
  }
  return matches[0].getId();
}

function gibM1DerivedReceiverSecret_() {
  var material = 'gib-m1-test:' + ScriptApp.getScriptId();
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    material,
    Utilities.Charset.UTF_8
  )).replace(/=+$/, '');
}

function gibM1EnsureTestSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  if (sheet.getLastColumn() > headers.length) {
    throw new Error('The TEST ' + name + ' headings do not match the tracked schema.');
  }
  var headings = sheet
    .getRange(1, 1, 1, headers.length)
    .getValues()[0]
    .map(function(value) { return String(value == null ? '' : value).trim(); });
  var hasHeadings = headings.some(function(value) { return Boolean(value); });
  if (hasHeadings) {
    for (var i = 0; i < headers.length; i += 1) {
      if (headings[i] !== headers[i]) {
        throw new Error('The TEST ' + name + ' headings do not match the tracked schema.');
      }
    }
  } else {
    if (sheet.getLastRow() > 1) {
      throw new Error('The TEST ' + name + ' headings do not match the tracked schema.');
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.setFrozenRows(1);
  return sheet;
}

function gibM1SeedTestStaff_(sheet) {
  if (sheet.getLastRow() <= 1) {
    sheet
      .getRange(2, 1, GIB_M1_TEST_STAFF_SEED_.length, GIB_M1_TEST_STAFF_HEADERS_.length)
      .setValues(GIB_M1_TEST_STAFF_SEED_);
  }
  var values = sheet.getDataRange().getValues();
  if (values.length !== GIB_M1_TEST_STAFF_SEED_.length + 1) {
    throw new Error('Staff Clock Staff must contain only the approved TEST staff.');
  }
  for (var rowIndex = 0; rowIndex < GIB_M1_TEST_STAFF_SEED_.length; rowIndex += 1) {
    var actual = values[rowIndex + 1] || [];
    var expected = GIB_M1_TEST_STAFF_SEED_[rowIndex];
    if (
      actual[0] !== expected[0]
      || actual[1] !== expected[1]
      || actual[2] !== true
    ) {
      throw new Error('Staff Clock Staff must contain only the approved active TEST staff.');
    }
  }
}

function provisionGibM1TestReceiver() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('TEST receiver provisioning is busy.');
  try {
    var matches = gibM1ExactTestSpreadsheetFiles_();
    if (matches.length !== 1) {
      throw new Error('Expected exactly one Google Sheet with the configured TEST title.');
    }

    var spreadsheet = SpreadsheetApp.openById(matches[0].getId());
    if (spreadsheet.getName() !== GIB_M1_TEST_SPREADSHEET_TITLE_) {
      throw new Error('TEST spreadsheet identity check failed.');
    }

    var signins = gibM1EnsureTestSheet_(
      spreadsheet,
      GIB_M1_TEST_SIGNINS_SHEET_,
      GIB_M1_TEST_SIGNINS_HEADERS_
    );
    var staff = gibM1EnsureTestSheet_(
      spreadsheet,
      GIB_M1_TEST_STAFF_SHEET_,
      GIB_M1_TEST_STAFF_HEADERS_
    );
    var staffTime = gibM1EnsureTestSheet_(
      spreadsheet,
      GIB_M1_TEST_STAFF_TIME_SHEET_,
      GIB_M1_TEST_STAFF_TIME_HEADERS_
    );
    var staffAudit = gibM1EnsureTestSheet_(
      spreadsheet,
      GIB_M1_TEST_STAFF_AUDIT_SHEET_,
      GIB_M1_TEST_STAFF_AUDIT_HEADERS_
    );
    var staffAdjustments = gibM1EnsureTestSheet_(
      spreadsheet,
      GIB_M1_TEST_STAFF_ADJUSTMENT_SHEET_,
      GIB_M1_TEST_STAFF_ADJUSTMENT_HEADERS_
    );
    gibM1SeedTestStaff_(staff);
    SpreadsheetApp.flush();

    PropertiesService
      .getScriptProperties()
      .setProperty(GIB_M1_TEST_SPREADSHEET_PROPERTY_, spreadsheet.getId());

    return {
      ok: true,
      target: GIB_M1_ALLOWED_TARGET,
      spreadsheetTitle: GIB_M1_TEST_SPREADSHEET_TITLE_,
      spreadsheetMatches: matches.length,
      signinsSheet: GIB_M1_TEST_SIGNINS_SHEET_,
      headerCount: GIB_M1_TEST_SIGNINS_HEADERS_.length,
      dataRowCount: Math.max(0, signins.getLastRow() - 1),
      staffSheet: GIB_M1_TEST_STAFF_SHEET_,
      staffCount: Math.max(0, staff.getLastRow() - 1),
      staffTimeSheet: GIB_M1_TEST_STAFF_TIME_SHEET_,
      staffTimeCount: Math.max(0, staffTime.getLastRow() - 1),
      staffAuditSheet: GIB_M1_TEST_STAFF_AUDIT_SHEET_,
      staffAuditCount: Math.max(0, staffAudit.getLastRow() - 1),
      staffAdjustmentSheet: GIB_M1_TEST_STAFF_ADJUSTMENT_SHEET_,
      staffAdjustmentCount: Math.max(0, staffAdjustments.getLastRow() - 1)
    };
  } finally {
    lock.releaseLock();
  }
}
