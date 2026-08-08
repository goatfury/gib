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
var GIB_M1_PROVISION_ACTION_ = 'provisionProductionReceiver';
var GIB_M1_PROVISIONING_CLOSED_PROPERTY_ = 'GIB_M1_PROVISIONING_CLOSED';
var GIB_M1_PROVISIONING_CLOSED_VALUE_ = 'closed-v1';

var GIB_M1_PRODUCTION_PROPERTIES_ = PropertiesService.getScriptProperties();
var GIB_M1_PROVISIONING_IS_CLOSED_ = GIB_M1_PRODUCTION_PROPERTIES_
  .getProperty(GIB_M1_PROVISIONING_CLOSED_PROPERTY_) === GIB_M1_PROVISIONING_CLOSED_VALUE_;
var SPREADSHEET_ID = GIB_M1_PROVISIONING_IS_CLOSED_
  ? GIB_M1_PRODUCTION_PROPERTIES_.getProperty(GIB_M1_PRODUCTION_SPREADSHEET_PROPERTY_) || ''
  : '';
var EXPECTED_SPREADSHEET_NAME = GIB_M1_PRODUCTION_SPREADSHEET_TITLE_;
var SHEET_NAME = GIB_M1_PRODUCTION_SIGNINS_SHEET_;

function doPost(e) {
  var provisioningResult = gibM1HandleProductionProvisioningPost_(e);
  if (provisioningResult) return provisioningResult;
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

function gibM1DerivedProvisioningSecret_() {
  var material = 'gib-m1-production-provisioning:' + ScriptApp.getScriptId();
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    material,
    Utilities.Charset.UTF_8
  )).replace(/=+$/, '');
}

function gibM1IsProvisioningRequest_(body) {
  return Boolean(body) && (
    body.action === GIB_M1_PROVISION_ACTION_
    || Object.prototype.hasOwnProperty.call(body, 'provisioningSecret')
  );
}

function gibM1HandleProductionProvisioningPost_(e) {
  var body = parseRequestBody_(e);
  if (!gibM1IsProvisioningRequest_(body)) return null;
  try {
    var keys = Object.keys(body).sort();
    var expectedKeys = ['action', 'provisioningSecret', 'target'];
    if (
      JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || body.action !== GIB_M1_PROVISION_ACTION_
      || body.target !== GIB_M1_ALLOWED_TARGET
      || typeof body.provisioningSecret !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(body.provisioningSecret)
    ) throw new Error('Production provisioning request rejected.');

    var provisioningSecret = gibM1DerivedProvisioningSecret_();
    var receiverSecret = configuredReceiverSecret_();
    if (
      !provisioningSecret
      || !receiverSecret
      || constantTimeTextEqual_(provisioningSecret, receiverSecret)
      || !constantTimeTextEqual_(body.provisioningSecret, provisioningSecret)
      || constantTimeTextEqual_(
        scriptProperty_(GIB_M1_PROVISIONING_CLOSED_PROPERTY_),
        GIB_M1_PROVISIONING_CLOSED_VALUE_
      )
    ) throw new Error('Production provisioning request rejected.');

    return jsonResult_(gibM1ProvisionSpreadsheet_({
      target: GIB_M1_ALLOWED_TARGET,
      title: GIB_M1_PRODUCTION_SPREADSHEET_TITLE_,
      sheetName: GIB_M1_PRODUCTION_SIGNINS_SHEET_,
      headers: GIB_M1_SIGNINS_HEADERS_,
      spreadsheetProperty: GIB_M1_PRODUCTION_SPREADSHEET_PROPERTY_,
      forbiddenSpreadsheetProperty: 'GIB_M1_TEST_SPREADSHEET_ID',
      createIfMissing: true,
      requireEmptyDataRows: true,
      initializeSchemaOnlyWhenCreated: true,
      provisioningClosedProperty: GIB_M1_PROVISIONING_CLOSED_PROPERTY_,
      provisioningClosedValue: GIB_M1_PROVISIONING_CLOSED_VALUE_
    }));
  } catch (error) {
    return jsonResult_({ ok: false, rejected: true });
  }
}
