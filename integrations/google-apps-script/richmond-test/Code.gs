/* Richmond BJJ M1 isolated TEST receiver entrypoint. */
var GIB_M1_ALLOWED_TARGET = 'test';
var GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK = true;
var GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE = false;
var GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA = true;
var GIB_M1_STAFF_CLOCK_ENABLED = false;
var GIB_M1_RICHMOND_INSTALLATION_ = 'richmond';
var GIB_M1_RICHMOND_ENVIRONMENT_ = 'test';
var GIB_M1_RICHMOND_SPREADSHEET_TITLE_ = 'Richmond BJJ M1 — TEST';
var GIB_M1_RICHMOND_SPREADSHEET_PROPERTY_ = 'GIB_M1_RICHMOND_TEST_SPREADSHEET_ID';
var GIB_M1_RICHMOND_INSTALLATION_LOCK_ = 'GIB_M1_INSTALLATION_LOCK';
var GIB_M1_RICHMOND_ENVIRONMENT_LOCK_ = 'GIB_M1_ENVIRONMENT_LOCK';
var GIB_M1_RICHMOND_PROVISIONING_CLOSED_ = 'GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED';
var GIB_M1_RICHMOND_PROVISIONING_CLOSED_VALUE_ = 'richmond-test-v1';
var GIB_M1_RICHMOND_DEVICE_ = 'Richmond TEST Browser';
var GIB_M1_RICHMOND_SITE_ = 'Richmond';
var GIB_M1_RICHMOND_AUDIT_HEADERS_ = [
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

var TEST_SPREADSHEET_ID = PropertiesService
  .getScriptProperties()
  .getProperty(GIB_M1_RICHMOND_SPREADSHEET_PROPERTY_) || '';
var EXPECTED_SPREADSHEET_NAME = GIB_M1_RICHMOND_SPREADSHEET_TITLE_;
var SHEET_NAME = 'Signins';

function gibM1RichmondDerivedSecret_(prefix) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    prefix + ':' + ScriptApp.getScriptId(),
    Utilities.Charset.UTF_8
  )).replace(/=+$/, '');
}

function gibM1DerivedReceiverSecret_() {
  return gibM1RichmondDerivedSecret_('gib-m1-richmond-test');
}

function gibM1DerivedAdminActionSecret_() {
  return gibM1RichmondDerivedSecret_('gib-m1-richmond-test-admin');
}

function gibM1RichmondProvisioningSecret_() {
  return gibM1RichmondDerivedSecret_('gib-m1-richmond-test-provisioning');
}

function gibM1RichmondExactKeys_(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var actual = Object.keys(value).sort();
  var expected = keys.slice().sort();
  return actual.length === expected.length && actual.every(function(key, index) {
    return key === expected[index];
  });
}

function gibM1RichmondLocksValid_() {
  var properties = PropertiesService.getScriptProperties();
  return constantTimeTextEqual_(properties.getProperty(GIB_M1_TARGET_LOCK_PROPERTY_), 'test')
    && constantTimeTextEqual_(properties.getProperty(GIB_M1_RICHMOND_INSTALLATION_LOCK_), GIB_M1_RICHMOND_INSTALLATION_)
    && constantTimeTextEqual_(properties.getProperty(GIB_M1_RICHMOND_ENVIRONMENT_LOCK_), GIB_M1_RICHMOND_ENVIRONMENT_)
    && constantTimeTextEqual_(properties.getProperty(GIB_M1_RICHMOND_PROVISIONING_CLOSED_), GIB_M1_RICHMOND_PROVISIONING_CLOSED_VALUE_);
}

function gibM1RichmondEnvelopeValid_(body) {
  return gibM1RichmondLocksValid_()
    && constantTimeTextEqual_(body && body.target, 'test')
    && constantTimeTextEqual_(body && body.installation, GIB_M1_RICHMOND_INSTALLATION_)
    && constantTimeTextEqual_(body && body.environment, GIB_M1_RICHMOND_ENVIRONMENT_);
}

function gibM1RichmondObviousTestValue_(value) {
  return /\b(?:qa|test|fake|demo)\b/i.test(cleanText_(value));
}

function gibM1RichmondActionValid_(body) {
  var action = cleanText_(body && body.action);
  if (['kioskSignIn', 'dailyReview', 'instructorSearch', 'addMissedInstructor'].indexOf(action) === -1) {
    return false;
  }
  if (action === 'kioskSignIn') {
    return Array.isArray(body.rows) && body.rows.every(function(row) {
      return cleanText_(row && row.Site) === GIB_M1_RICHMOND_SITE_
        && cleanText_(row && row.Device) === GIB_M1_RICHMOND_DEVICE_
        && gibM1RichmondObviousTestValue_(row && row.Instructor);
    });
  }
  if (action === 'addMissedInstructor') {
    return cleanText_(body.site) === GIB_M1_RICHMOND_SITE_
      && gibM1RichmondObviousTestValue_(body.instructor);
  }
  if (action === 'instructorSearch') return gibM1RichmondObviousTestValue_(body.instructor);
  return true;
}

function doPost(e) {
  var body = parseRequestBody_(e);
  if (!body) return rejectedAuthResult_();
  if (cleanText_(body.action) === 'provisionRichmondTest') {
    return gibM1ProvisionRichmondTest_(body);
  }
  if (!gibM1RichmondEnvelopeValid_(body) || !gibM1RichmondActionValid_(body)) {
    return rejectedAuthResult_();
  }
  return adReceiverV2_(e);
}

function gibM1RichmondSheetFiles_() {
  var matches = [];
  var files = DriveApp.getFilesByName(GIB_M1_RICHMOND_SPREADSHEET_TITLE_);
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) matches.push(file);
  }
  return matches;
}

function gibM1RichmondVerifySheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet || sheet.getLastColumn() > headers.length || Math.max(0, sheet.getLastRow() - 1) !== 0) {
    throw new Error('Richmond TEST Sheet schema or row count is invalid.');
  }
  var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(function(value) {
    return exactText_(value);
  });
  if (actual.length !== headers.length || actual.some(function(value, index) { return value !== headers[index]; })) {
    throw new Error('Richmond TEST Sheet headings are invalid.');
  }
  sheet.setFrozenRows(1);
  return sheet;
}

function gibM1ProvisionRichmondTest_(body) {
  if (!gibM1RichmondExactKeys_(body, [
    'action', 'provisioningSecret', 'target', 'installation', 'environment'
  ])
    || !constantTimeTextEqual_(body.provisioningSecret, gibM1RichmondProvisioningSecret_())
    || !constantTimeTextEqual_(body.target, 'test')
    || !constantTimeTextEqual_(body.installation, GIB_M1_RICHMOND_INSTALLATION_)
    || !constantTimeTextEqual_(body.environment, GIB_M1_RICHMOND_ENVIRONMENT_)
  ) return rejectedAuthResult_();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return rejectedAuthResult_();
  try {
    var properties = PropertiesService.getScriptProperties();
    var forbidden = [
      'GIB_M1_TEST_SPREADSHEET_ID',
      'GIB_M1_PRODUCTION_SPREADSHEET_ID',
      'GIB_M1_PRODUCTION_PROVISIONING_CLOSED',
      GIB_M1_RECEIVER_PROPERTY_,
      GIB_M1_ADMIN_ACTION_PROPERTY_,
      GIB_M1_LEGACY_KIOSK_PROPERTY_,
      GIB_M1_RECOVERY_PROPERTY_
    ];
    if (forbidden.some(function(name) { return Boolean(exactText_(properties.getProperty(name))); })) {
      throw new Error('This project contains forbidden receiver state.');
    }
    if (exactText_(properties.getProperty(GIB_M1_RICHMOND_PROVISIONING_CLOSED_))) {
      throw new Error('Richmond TEST provisioning is permanently closed.');
    }
    var matches = gibM1RichmondSheetFiles_();
    if (matches.length !== 1) throw new Error('Expected exactly one Richmond TEST Sheet.');
    var spreadsheet = SpreadsheetApp.openById(matches[0].getId());
    if (spreadsheet.getName() !== GIB_M1_RICHMOND_SPREADSHEET_TITLE_) {
      throw new Error('Richmond TEST Sheet identity is invalid.');
    }
    var sheetNames = spreadsheet.getSheets().map(function(sheet) { return sheet.getName(); }).sort();
    if (sheetNames.join('|') !== 'Admin Audit|Signins') {
      throw new Error('Richmond TEST Sheet must contain only Signins and Admin Audit.');
    }
    var signins = gibM1RichmondVerifySheet_(spreadsheet, 'Signins', GIB_M1_SIGNINS_HEADERS_);
    var audit = gibM1RichmondVerifySheet_(spreadsheet, 'Admin Audit', GIB_M1_RICHMOND_AUDIT_HEADERS_);
    var persisted = {};
    persisted[GIB_M1_RICHMOND_SPREADSHEET_PROPERTY_] = spreadsheet.getId();
    persisted[GIB_M1_TARGET_LOCK_PROPERTY_] = 'test';
    persisted[GIB_M1_RICHMOND_INSTALLATION_LOCK_] = GIB_M1_RICHMOND_INSTALLATION_;
    persisted[GIB_M1_RICHMOND_ENVIRONMENT_LOCK_] = GIB_M1_RICHMOND_ENVIRONMENT_;
    persisted[GIB_M1_RICHMOND_PROVISIONING_CLOSED_] = GIB_M1_RICHMOND_PROVISIONING_CLOSED_VALUE_;
    properties.setProperties(persisted, false);
    TEST_SPREADSHEET_ID = spreadsheet.getId();
    if (!gibM1RichmondLocksValid_()) throw new Error('Richmond TEST locks could not be verified.');
    return jsonResult_({
      ok: true,
      target: 'test',
      installation: GIB_M1_RICHMOND_INSTALLATION_,
      environment: GIB_M1_RICHMOND_ENVIRONMENT_,
      spreadsheetTitle: GIB_M1_RICHMOND_SPREADSHEET_TITLE_,
      signinsRows: Math.max(0, signins.getLastRow() - 1),
      auditRows: Math.max(0, audit.getLastRow() - 1),
      provisioningClosed: true
    });
  } catch (error) {
    return rejectedAuthResult_();
  } finally {
    lock.releaseLock();
  }
}
