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

var TEST_SPREADSHEET_ID = PropertiesService
  .getScriptProperties()
  .getProperty(GIB_M1_TEST_SPREADSHEET_PROPERTY_) || '';
var EXPECTED_SPREADSHEET_NAME = GIB_M1_TEST_SPREADSHEET_TITLE_;
var SHEET_NAME = GIB_M1_TEST_SIGNINS_SHEET_;

function doPost(e) {
  return adReceiverV2_(e);
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
      staffAuditCount: Math.max(0, staffAudit.getLastRow() - 1)
    };
  } finally {
    lock.releaseLock();
  }
}
