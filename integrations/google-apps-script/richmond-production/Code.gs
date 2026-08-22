/* Richmond BJJ M1 isolated PRODUCTION receiver entrypoint. */
var GIB_M1_ALLOWED_TARGET = 'production';
var GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK = true;
var GIB_M1_ALLOW_RECEIVER_TOKEN_OVERRIDE = false;
var GIB_M1_REQUIRE_EXACT_SIGNINS_SCHEMA = true;
var GIB_M1_STAFF_CLOCK_ENABLED = false;
var GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ = 'richmond';
var GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_ = 'production';
var GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_ = 'Richmond BJJ M1 — PRODUCTION';
var GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_PROPERTY_ = 'GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_ID';
var GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_LOCK_ = 'GIB_M1_INSTALLATION_LOCK';
var GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_LOCK_ = 'GIB_M1_ENVIRONMENT_LOCK';
var GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED_ = 'GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED';
var GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED_VALUE_ = 'richmond-production-v1';
var GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED_ = 'GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED';
var GIB_M1_RICHMOND_PRODUCTION_DEVICE_ = 'Richmond Front Desk Tablet';
var GIB_M1_RICHMOND_PRODUCTION_SITE_ = 'Richmond';
var GIB_M1_RICHMOND_PRODUCTION_PROVISION_ACTION_ = 'provisionRichmondProduction';
var GIB_M1_RICHMOND_PRODUCTION_AUDIT_HEADERS_ = [
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

var GIB_M1_RICHMOND_PRODUCTION_PROPERTIES_ = PropertiesService.getScriptProperties();
var SPREADSHEET_ID = GIB_M1_RICHMOND_PRODUCTION_PROPERTIES_
  .getProperty(GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_PROPERTY_) || '';
var EXPECTED_SPREADSHEET_NAME = GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_;
var SHEET_NAME = 'Signins';

function gibM1RichmondProductionDerivedSecret_(prefix) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    prefix + ':' + ScriptApp.getScriptId(),
    Utilities.Charset.UTF_8
  )).replace(/=+$/, '');
}

function gibM1DerivedReceiverSecret_() {
  return gibM1RichmondProductionDerivedSecret_('gib-m1-richmond-production');
}

function gibM1DerivedAdminActionSecret_() {
  return gibM1RichmondProductionDerivedSecret_('gib-m1-richmond-production-admin');
}

function gibM1RichmondProductionProvisioningSecret_() {
  return gibM1RichmondProductionDerivedSecret_('gib-m1-richmond-production-provisioning');
}

function gibM1RichmondProductionExactKeys_(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var actual = Object.keys(value).sort();
  var expected = keys.slice().sort();
  return actual.length === expected.length && actual.every(function(key, index) {
    return key === expected[index];
  });
}

function gibM1RichmondProductionLocksValid_() {
  var properties = PropertiesService.getScriptProperties();
  var writes = cleanText_(properties.getProperty(GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED_)).toLowerCase();
  return constantTimeTextEqual_(properties.getProperty(GIB_M1_TARGET_LOCK_PROPERTY_), 'production')
    && constantTimeTextEqual_(
      properties.getProperty(GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_LOCK_),
      GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_
    )
    && constantTimeTextEqual_(
      properties.getProperty(GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_LOCK_),
      GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_
    )
    && constantTimeTextEqual_(
      properties.getProperty(GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED_),
      GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED_VALUE_
    )
    && Boolean(exactText_(properties.getProperty(GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_PROPERTY_)))
    && (writes === 'false' || writes === 'true');
}

function gibM1RichmondProductionWritesEnabled_() {
  return gibM1RichmondProductionLocksValid_()
    && constantTimeTextEqual_(
      PropertiesService.getScriptProperties().getProperty(GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED_),
      'true'
    );
}

function gibM1RichmondProductionEnvelopeValid_(body) {
  return gibM1RichmondProductionLocksValid_()
    && constantTimeTextEqual_(body && body.target, 'production')
    && constantTimeTextEqual_(body && body.installation, GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_)
    && constantTimeTextEqual_(body && body.environment, GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_);
}

function gibM1RichmondProductionObviousTestValue_(value) {
  return /\b(?:qa|test|fake|demo)\b|do not pay/i.test(cleanText_(value));
}

function gibM1RichmondProductionActionValid_(body) {
  var action = cleanText_(body && body.action);
  if (['kioskSignIn', 'dailyReview', 'instructorSearch', 'addMissedInstructor', 'ledgerStatus'].indexOf(action) === -1) {
    return false;
  }
  if (action === 'ledgerStatus') {
    return gibM1RichmondProductionExactKeys_(body, [
      'token', 'adminActionToken', 'action', 'target', 'installation', 'environment'
    ])
      && constantTimeTextEqual_(body.token, gibM1DerivedReceiverSecret_())
      && constantTimeTextEqual_(body.adminActionToken, gibM1DerivedAdminActionSecret_());
  }
  if (action === 'kioskSignIn') {
    return Array.isArray(body.rows) && body.rows.every(function(row) {
      return cleanText_(row && row.Site) === GIB_M1_RICHMOND_PRODUCTION_SITE_
        && cleanText_(row && row.Device) === GIB_M1_RICHMOND_PRODUCTION_DEVICE_
        && !gibM1RichmondProductionObviousTestValue_(row && row.Instructor);
    });
  }
  if (action === 'addMissedInstructor') {
    return cleanText_(body.site) === GIB_M1_RICHMOND_PRODUCTION_SITE_
      && !gibM1RichmondProductionObviousTestValue_(body.instructor);
  }
  if (action === 'instructorSearch') {
    return !gibM1RichmondProductionObviousTestValue_(body.instructor);
  }
  return true;
}

function gibM1RichmondProductionMutation_(action) {
  return action === 'kioskSignIn' || action === 'addMissedInstructor';
}

function doPost(e) {
  var body = parseRequestBody_(e);
  if (!body) return rejectedAuthResult_();
  if (cleanText_(body.action) === GIB_M1_RICHMOND_PRODUCTION_PROVISION_ACTION_) {
    return gibM1ProvisionRichmondProduction_(body);
  }
  if (!gibM1RichmondProductionEnvelopeValid_(body) || !gibM1RichmondProductionActionValid_(body)) {
    return rejectedAuthResult_();
  }
  if (cleanText_(body.action) === 'ledgerStatus') {
    return gibM1RichmondProductionLedgerStatus_();
  }
  if (
    gibM1RichmondProductionMutation_(cleanText_(body.action))
    && !gibM1RichmondProductionWritesEnabled_()
  ) return rejectedAuthResult_();
  return adReceiverV2_(e);
}

function gibM1RichmondProductionLedgerSheetRows_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() !== headers.length) {
    throw new Error('Richmond production Sheet schema is invalid.');
  }
  var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(function(value) {
    return exactText_(value);
  });
  if (actual.some(function(value, index) { return value !== headers[index]; })) {
    throw new Error('Richmond production Sheet headings are invalid.');
  }
  return Math.max(0, sheet.getLastRow() - 1);
}

function gibM1RichmondProductionLedgerStatus_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return rejectedAuthResult_();
  try {
    var properties = PropertiesService.getScriptProperties();
    var spreadsheetId = exactText_(
      properties.getProperty(GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_PROPERTY_)
    );
    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    if (spreadsheet.getName() !== GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_) {
      throw new Error('Richmond production Sheet identity is invalid.');
    }
    var sheetNames = spreadsheet.getSheets().map(function(sheet) {
      return sheet.getName();
    }).sort();
    if (sheetNames.join('|') !== 'Admin Audit|Signins') {
      throw new Error('Richmond production Sheet tabs are invalid.');
    }
    var signinsRows = gibM1RichmondProductionLedgerSheetRows_(
      spreadsheet,
      'Signins',
      GIB_M1_SIGNINS_HEADERS_
    );
    var auditRows = gibM1RichmondProductionLedgerSheetRows_(
      spreadsheet,
      'Admin Audit',
      GIB_M1_RICHMOND_PRODUCTION_AUDIT_HEADERS_
    );
    return jsonResult_({
      ok: true,
      target: 'production',
      installation: GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_,
      environment: GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_,
      empty: signinsRows === 0 && auditRows === 0,
      signinsRows: signinsRows,
      auditRows: auditRows,
      writesEnabled: gibM1RichmondProductionWritesEnabled_()
    });
  } catch (error) {
    return rejectedAuthResult_();
  } finally {
    lock.releaseLock();
  }
}

function gibM1RichmondProductionSheetFiles_() {
  var matches = [];
  var files = DriveApp.getFilesByName(GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_);
  while (files.hasNext()) {
    var file = files.next();
    var active = typeof file.isTrashed !== 'function' || !file.isTrashed();
    if (active && file.getMimeType() === MimeType.GOOGLE_SHEETS) matches.push(file);
  }
  return matches;
}

function gibM1RichmondProductionVerifySheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  if (
    !sheet
    || sheet.getLastColumn() > headers.length
    || Math.max(0, sheet.getLastRow() - 1) !== 0
  ) throw new Error('Richmond production Sheet schema or row count is invalid.');
  var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(function(value) {
    return exactText_(value);
  });
  if (
    actual.length !== headers.length
    || actual.some(function(value, index) { return value !== headers[index]; })
  ) throw new Error('Richmond production Sheet headings are invalid.');
  sheet.setFrozenRows(1);
  return sheet;
}

function gibM1ProvisionRichmondProduction_(body) {
  if (!gibM1RichmondProductionExactKeys_(body, [
    'action', 'provisioningSecret', 'target', 'installation', 'environment'
  ])
    || !constantTimeTextEqual_(
      body.provisioningSecret,
      gibM1RichmondProductionProvisioningSecret_()
    )
    || !constantTimeTextEqual_(body.target, 'production')
    || !constantTimeTextEqual_(body.installation, GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_)
    || !constantTimeTextEqual_(body.environment, GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_)
  ) return rejectedAuthResult_();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return rejectedAuthResult_();
  try {
    var properties = PropertiesService.getScriptProperties();
    var forbidden = [
      'GIB_M1_TEST_SPREADSHEET_ID',
      'GIB_M1_PRODUCTION_SPREADSHEET_ID',
      'GIB_M1_RICHMOND_TEST_SPREADSHEET_ID',
      'GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED',
      GIB_M1_RECEIVER_PROPERTY_,
      GIB_M1_ADMIN_ACTION_PROPERTY_,
      GIB_M1_LEGACY_KIOSK_PROPERTY_,
      GIB_M1_RECOVERY_PROPERTY_
    ];
    if (forbidden.some(function(name) { return Boolean(exactText_(properties.getProperty(name))); })) {
      throw new Error('This project contains forbidden receiver state.');
    }
    if (exactText_(properties.getProperty(GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED_))) {
      throw new Error('Richmond production provisioning is permanently closed.');
    }
    var matches = gibM1RichmondProductionSheetFiles_();
    if (matches.length !== 1) throw new Error('Expected exactly one Richmond production Sheet.');
    var spreadsheet = SpreadsheetApp.openById(matches[0].getId());
    if (spreadsheet.getName() !== GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_) {
      throw new Error('Richmond production Sheet identity is invalid.');
    }
    var sheetNames = spreadsheet.getSheets().map(function(sheet) {
      return sheet.getName();
    }).sort();
    if (sheetNames.join('|') !== 'Admin Audit|Signins') {
      throw new Error('Richmond production Sheet must contain only Signins and Admin Audit.');
    }
    var signins = gibM1RichmondProductionVerifySheet_(
      spreadsheet,
      'Signins',
      GIB_M1_SIGNINS_HEADERS_
    );
    var audit = gibM1RichmondProductionVerifySheet_(
      spreadsheet,
      'Admin Audit',
      GIB_M1_RICHMOND_PRODUCTION_AUDIT_HEADERS_
    );
    var persisted = {};
    persisted[GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_PROPERTY_] = spreadsheet.getId();
    persisted[GIB_M1_TARGET_LOCK_PROPERTY_] = 'production';
    persisted[GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_LOCK_] = GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_;
    persisted[GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_LOCK_] = GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_;
    persisted[GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED_] = GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED_VALUE_;
    persisted[GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED_] = 'false';
    properties.setProperties(persisted, false);
    SPREADSHEET_ID = spreadsheet.getId();
    if (!gibM1RichmondProductionLocksValid_() || gibM1RichmondProductionWritesEnabled_()) {
      throw new Error('Richmond production locks could not be verified.');
    }
    return jsonResult_({
      ok: true,
      target: 'production',
      installation: GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_,
      environment: GIB_M1_RICHMOND_PRODUCTION_ENVIRONMENT_,
      spreadsheetTitle: GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_TITLE_,
      signinsRows: Math.max(0, signins.getLastRow() - 1),
      auditRows: Math.max(0, audit.getLastRow() - 1),
      provisioningClosed: true,
      writesEnabled: false
    });
  } catch (error) {
    return rejectedAuthResult_();
  } finally {
    lock.releaseLock();
  }
}
