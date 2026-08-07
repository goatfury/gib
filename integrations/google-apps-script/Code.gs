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

function provisionGibM1TestReceiver() {
  var matches = gibM1ExactTestSpreadsheetFiles_();
  if (matches.length !== 1) {
    throw new Error('Expected exactly one Google Sheet with the configured TEST title.');
  }

  var spreadsheet = SpreadsheetApp.openById(matches[0].getId());
  if (spreadsheet.getName() !== GIB_M1_TEST_SPREADSHEET_TITLE_) {
    throw new Error('TEST spreadsheet identity check failed.');
  }

  var sheet = spreadsheet.getSheetByName(GIB_M1_TEST_SIGNINS_SHEET_);
  if (!sheet) sheet = spreadsheet.insertSheet(GIB_M1_TEST_SIGNINS_SHEET_);

  if (sheet.getLastColumn() > GIB_M1_TEST_SIGNINS_HEADERS_.length) {
    throw new Error('The TEST Signins headings do not match the tracked schema.');
  }
  var headings = sheet
    .getRange(1, 1, 1, GIB_M1_TEST_SIGNINS_HEADERS_.length)
    .getValues()[0]
    .map(function(value) { return String(value == null ? '' : value).trim(); });
  var hasHeadings = headings.some(function(value) { return Boolean(value); });
  if (hasHeadings) {
    for (var i = 0; i < GIB_M1_TEST_SIGNINS_HEADERS_.length; i += 1) {
      if (headings[i] !== GIB_M1_TEST_SIGNINS_HEADERS_[i]) {
        throw new Error('The TEST Signins headings do not match the tracked schema.');
      }
    }
  } else {
    sheet
      .getRange(1, 1, 1, GIB_M1_TEST_SIGNINS_HEADERS_.length)
      .setValues([GIB_M1_TEST_SIGNINS_HEADERS_]);
  }
  sheet.setFrozenRows(1);

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
    dataRowCount: Math.max(0, sheet.getLastRow() - 1)
  };
}
