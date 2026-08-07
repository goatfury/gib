/*
 * Standalone PRODUCTION Apps Script entrypoint.
 *
 * This tracked wrapper contains no Google identifier or credential. The
 * production project is separate from TEST, accepts only target=production,
 * and remains disabled until provisioning stores its private Sheet ID and
 * persisted production target lock in Script Properties.
 */
var GIB_M1_ALLOWED_TARGET = 'production';
var GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK = true;
var GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE = false;
var GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA = true;
var GIB_M1_PRODUCTION_SPREADSHEET_PROPERTY_ = 'GIB_M1_PRODUCTION_SPREADSHEET_ID';
var GIB_M1_PRODUCTION_SPREADSHEET_TITLE_ = 'RBJJ M1 — PRODUCTION';
var GIB_M1_PRODUCTION_SIGNINS_SHEET_ = 'Signins';

var SPREADSHEET_ID = PropertiesService
  .getScriptProperties()
  .getProperty(GIB_M1_PRODUCTION_SPREADSHEET_PROPERTY_) || '';
var EXPECTED_SPREADSHEET_NAME = GIB_M1_PRODUCTION_SPREADSHEET_TITLE_;
var SHEET_NAME = GIB_M1_PRODUCTION_SIGNINS_SHEET_;

function doPost(e) {
  return adReceiverV2_(e);
}

function gibM1DerivedReceiverSecret_() {
  var material = 'gib-m1-production:' + ScriptApp.getScriptId();
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    material,
    Utilities.Charset.UTF_8
  )).replace(/=+$/, '');
}

function provisionGibM1ProductionReceiver() {
  return gibM1ProvisionSpreadsheet_({
    target: GIB_M1_ALLOWED_TARGET,
    title: GIB_M1_PRODUCTION_SPREADSHEET_TITLE_,
    sheetName: GIB_M1_PRODUCTION_SIGNINS_SHEET_,
    headers: GIB_M1_SIGNINS_HEADERS_,
    spreadsheetProperty: GIB_M1_PRODUCTION_SPREADSHEET_PROPERTY_,
    forbiddenSpreadsheetProperty: 'GIB_M1_TEST_SPREADSHEET_ID',
    createIfMissing: true
  });
}
