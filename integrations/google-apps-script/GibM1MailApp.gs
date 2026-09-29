/* Revolution TEST only. No call is repeated after a durable gym/day claim. */
var GIB_M1_MAILAPP_SENDER_ = 'revbjjops@gmail.com';
var GIB_M1_MAILAPP_SCHEMA_ = 'm1-mailapp-request/v1';
var GIB_M1_MAILAPP_TAB_ = 'MailApp Attempts';
var GIB_M1_MAILAPP_READY_ = 'GIB_M1_MAILAPP_TEST_LEDGER_READY';
var GIB_M1_MAILAPP_HEADERS_ = ['Message ID', 'Event', 'Payload Hash', 'Gym', 'Opportunity Date', 'Request ID', 'Attempted At', 'Completed At', 'Code', 'Sender'];

function gibM1MailAppExact_(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}
function gibM1MailAppScope_() {
  return typeof configuredDeploymentTarget_ === 'function' && configuredDeploymentTarget_() === 'test'
    && deploymentTargetAllowed_('test') && typeof EXPECTED_SPREADSHEET_NAME !== 'undefined' && EXPECTED_SPREADSHEET_NAME === 'RBJJ M1 — TEST';
}
function gibM1MailAppActor_() {
  try { return Session.getEffectiveUser().getEmail() === GIB_M1_MAILAPP_SENDER_; } catch (_) { return false; }
}
function gibM1MailAppDate_(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
function gibM1MailAppAddresses_(value, minimum) {
  return Array.isArray(value) && value.length >= minimum && value.length <= 4 && value.every(function(address) {
    return typeof address === 'string' && address.length <= 254 && /^[\x21-\x7e]+$/.test(address)
      && /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(address);
  });
}
function gibM1MailAppCanonical_(message) {
  var value = { messageId: message.messageId, from: message.from, to: message.to, cc: message.cc, subject: message.subject,
    html: message.html, text: message.text, synthetic: message.synthetic, target: message.target };
  // Absent BCC is the original v1 payload. Never change retained hashes by
  // inserting an empty list into messages created before BCC was configured.
  if (Object.prototype.hasOwnProperty.call(message, 'bcc')) value.bcc = message.bcc;
  return value;
}
function gibM1MailAppHash_(message) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(gibM1MailAppCanonical_(message)), Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
}
function gibM1MailAppMessage_(message) {
  var hasBcc = message && Object.prototype.hasOwnProperty.call(message, 'bcc'), bcc = hasBcc ? message.bcc : [];
  if (!gibM1MailAppExact_(message, ['messageId', 'hash', 'from', 'to', 'cc', 'subject', 'html', 'text', 'synthetic', 'target'].concat(hasBcc ? ['bcc'] : []))
    || typeof message.messageId !== 'string' || !/^m1-test-scheduled-rev-\d{4}-\d{2}-\d{2}$/.test(message.messageId)
    || !gibM1MailAppDate_(message.messageId.slice(-10)) || message.from !== GIB_M1_MAILAPP_SENDER_ || message.target !== 'test'
    || typeof message.synthetic !== 'boolean' || !gibM1MailAppAddresses_(message.to, 1) || !gibM1MailAppAddresses_(message.cc, 0)
    || !gibM1MailAppAddresses_(bcc, 0) || bcc.length > 1
    || new Set(message.to.concat(message.cc, bcc).map(function(address) { return address.toLowerCase(); })).size !== message.to.length + message.cc.length + bcc.length
    || typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > 998 || /[\r\n]/.test(message.subject)
    || ['html', 'text'].some(function(key) { return typeof message[key] !== 'string' || !message[key].trim() || message[key].length > 200000; })
    || typeof message.hash !== 'string' || !/^[0-9a-f]{64}$/.test(message.hash) || message.hash !== gibM1MailAppHash_(message)) throw new Error('MAILAPP_MESSAGE_INVALID');
}
function gibM1MailAppBinding_(binding, now) {
  if (!gibM1MailAppExact_(binding, ['schema', 'requestId', 'createdAt', 'expiresAt']) || binding.schema !== GIB_M1_MAILAPP_SCHEMA_
    || typeof binding.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding.requestId)
    || !Number.isSafeInteger(binding.createdAt) || binding.createdAt > now || binding.expiresAt !== binding.createdAt + 60000 || now >= binding.expiresAt) {
    throw new Error('MAILAPP_BINDING_INVALID');
  }
}
function gibM1MailAppResult_(message, state, code, attempt, completed) {
  return { ok: code === 'MAILAPP_READY' || code === 'MAILAPP_SUBMITTED', target: 'test', gym: 'rev',
    messageId: message ? message.messageId : null, hash: message ? message.hash : null, state: state, code: code,
    attemptedAt: attempt || null, completedAt: completed || null, retrySafe: state === 'not-attempted' };
}
function gibM1MailAppHeaders_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() !== GIB_M1_MAILAPP_HEADERS_.length
    || JSON.stringify(sheet.getRange(1, 1, 1, GIB_M1_MAILAPP_HEADERS_.length).getValues()[0]) !== JSON.stringify(GIB_M1_MAILAPP_HEADERS_)) {
    throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
  }
  return sheet;
}
function gibM1MailAppSheet_(body) {
  if (PropertiesService.getScriptProperties().getProperty(GIB_M1_MAILAPP_READY_) !== 'v1') throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
  // Never recreate a missing ledger. Its permanent claims are the anti-replay boundary.
  return gibM1MailAppHeaders_(openExpectedSpreadsheet_(body).getSheetByName(GIB_M1_MAILAPP_TAB_));
}
function gibM1MailAppRead_(sheet, message) {
  var last = sheet.getLastRow();
  if (last === 1) return null;
  var finder = sheet.getRange(2, 1, last - 1, 1).createTextFinder(message.messageId).matchEntireCell(true).matchCase(true).useRegularExpression(false);
  var rows = [], seen = {};
  // At most one claim plus one immutable result. Never load the complete history.
  for (var index = 0; index < 3; index++) {
    var found = finder.findNext();
    if (!found || seen[found.getRow()]) break;
    seen[found.getRow()] = true;
    rows.push(sheet.getRange(found.getRow(), 1, 1, GIB_M1_MAILAPP_HEADERS_.length).getValues()[0]);
  }
  if (!rows.length) return null;
  if (rows.length > 2) throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
  var attempt = null, receipt = null;
  rows.forEach(function(row) {
    if (row.length !== 10 || row.some(function(value) { return typeof value !== 'string'; }) || row[0] !== message.messageId
      || row[2] !== message.hash || row[3] !== 'rev' || row[4] !== message.messageId.slice(-10) || row[9] !== GIB_M1_MAILAPP_SENDER_
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row[5])
      || !Number.isFinite(Date.parse(row[6])) || new Date(row[6]).toISOString() !== row[6]) throw new Error('MAILAPP_ORIGINAL_CONFLICT');
    if (row[1] === 'attempt' && !attempt && row[7] === '' && row[8] === 'MAILAPP_CALL_PENDING') attempt = row;
    else if (['submitted', 'exception'].indexOf(row[1]) >= 0 && !receipt && Number.isFinite(Date.parse(row[7])) && new Date(row[7]).toISOString() === row[7]
      && Date.parse(row[7]) >= Date.parse(row[6]) && row[8] === (row[1] === 'submitted' ? 'MAILAPP_SUBMITTED' : 'MAILAPP_CALL_UNCERTAIN')) receipt = row;
    else throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
  });
  if (!attempt || receipt && (receipt[5] !== attempt[5] || receipt[6] !== attempt[6])) throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
  return gibM1MailAppResult_(message, receipt?.[1] === 'submitted' ? 'submitted' : 'unknown',
    receipt?.[1] === 'submitted' ? 'MAILAPP_SUBMITTED' : 'MAILAPP_CALL_UNCERTAIN', attempt[6], receipt ? receipt[7] : null);
}
function gibM1MailAppAppend_(sheet, row) {
  var destination = sheet.getRange(sheet.getLastRow() + 1, 1, 1, GIB_M1_MAILAPP_HEADERS_.length);
  destination.setNumberFormat('@'); destination.setValues([row]); SpreadsheetApp.flush();
  if (JSON.stringify(destination.getValues()[0]) !== JSON.stringify(row)) throw new Error('MAILAPP_STORAGE_UNCONFIRMED');
}
function gibM1MailAppConfiguration_(message) {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('GIB_M1_MAILAPP_TEST_SEND_ENABLED') !== 'true') return 'MAILAPP_DISABLED';
  try {
    var recipients = JSON.parse(properties.getProperty('GIB_M1_MAILAPP_TEST_RECIPIENTS_JSON') || 'null');
    var hasBcc = recipients && Object.prototype.hasOwnProperty.call(recipients, 'bcc'), bcc = hasBcc ? recipients.bcc : [];
    if (!gibM1MailAppExact_(recipients, ['to', 'cc'].concat(hasBcc ? ['bcc'] : [])) || !gibM1MailAppAddresses_(recipients.to, 1) || !gibM1MailAppAddresses_(recipients.cc, 0)
      || !gibM1MailAppAddresses_(bcc, 0) || bcc.length > 1
      || JSON.stringify(recipients.to) !== JSON.stringify(message.to) || JSON.stringify(recipients.cc) !== JSON.stringify(message.cc)
      || JSON.stringify(bcc) !== JSON.stringify(message.bcc || [])) return 'MAILAPP_RECIPIENTS_UNAPPROVED';
  } catch (_) { return 'MAILAPP_RECIPIENTS_UNAPPROVED'; }
  return null;
}
function gibM1MailAppAction_(body) {
  if (!gibM1MailAppScope_() || !adminActionAuthorized_(body) || body?.target !== 'test' || body?.gym !== 'rev') {
    return jsonResult_(gibM1MailAppResult_(null, 'unknown', 'MAILAPP_AUTHENTICATION_REQUIRED'));
  }
  var message = null, lock = null, held = false, sheet = null, row = null;
  try {
    if (!gibM1MailAppExact_(body, ['action', 'target', 'gym', 'token', 'adminActionToken', 'binding', 'message'])
      || ['attendanceMailSend', 'attendanceMailStatus'].indexOf(body.action) < 0) throw new Error('MAILAPP_REQUEST_INVALID');
    gibM1MailAppMessage_(body.message); message = body.message; gibM1MailAppBinding_(body.binding, Date.now());
    if (!gibM1MailAppActor_()) return jsonResult_(gibM1MailAppResult_(message, 'unknown', 'MAILAPP_SENDER_UNVERIFIED'));
    // Quota is a remote service read. Do not hold the shared attendance lock for
    // it, and do not let a current readiness failure hide an existing claim.
    var readiness = gibM1MailAppConfiguration_(message), quota;
    if (!readiness) {
      try { quota = MailApp.getRemainingDailyQuota(); } catch (_) { readiness = 'MAILAPP_AUTHORIZATION_UNAVAILABLE'; }
      if (!readiness && (!Number.isSafeInteger(quota) || quota < message.to.length + message.cc.length + (message.bcc || []).length)) readiness = 'MAILAPP_QUOTA_UNAVAILABLE';
    }
    lock = LockService.getScriptLock(); held = lock.tryLock(10000);
    if (!held) throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
    sheet = gibM1MailAppSheet_(body);
    var original = gibM1MailAppRead_(sheet, message);
    if (original) return jsonResult_(original);
    var configuration = gibM1MailAppConfiguration_(message);
    if (configuration) return jsonResult_(gibM1MailAppResult_(message, 'not-attempted', configuration));
    if (readiness) return jsonResult_(gibM1MailAppResult_(message, 'not-attempted', readiness));
    gibM1MailAppBinding_(body.binding, Date.now());
    if (body.action === 'attendanceMailStatus') return jsonResult_(gibM1MailAppResult_(message, 'not-attempted', 'MAILAPP_READY'));
    row = [message.messageId, 'attempt', message.hash, 'rev', message.messageId.slice(-10), body.binding.requestId, new Date().toISOString(), '', 'MAILAPP_CALL_PENDING', GIB_M1_MAILAPP_SENDER_];
    gibM1MailAppAppend_(sheet, row);
    var claimed = gibM1MailAppRead_(sheet, message);
    if (!claimed || claimed.attemptedAt !== row[6] || claimed.state !== 'unknown') throw new Error('MAILAPP_STORAGE_UNCONFIRMED');
  } catch (error) {
    var allowed = ['MAILAPP_MESSAGE_INVALID', 'MAILAPP_BINDING_INVALID', 'MAILAPP_REQUEST_INVALID', 'MAILAPP_ORIGINAL_CONFLICT', 'MAILAPP_STORAGE_UNCONFIRMED'];
    return jsonResult_(gibM1MailAppResult_(message, 'unknown', allowed.indexOf(error?.message) >= 0 ? error.message : 'MAILAPP_LEDGER_UNAVAILABLE', row?.[6]));
  } finally { if (held) lock.releaseLock(); }
  // The durable claim is permanent even if this execution stops here. Do not use
  // a lease expiry, retry counter or exception to authorize another MailApp call.
  try { gibM1MailAppBinding_(body.binding, Date.now()); }
  catch (_) { return jsonResult_(gibM1MailAppResult_(message, 'unknown', 'MAILAPP_BINDING_INVALID', row[6])); }
  var returned = false;
  try {
    var options = { to: message.to.join(','), subject: message.subject, body: message.text, htmlBody: message.html };
    if (message.cc.length) options.cc = message.cc.join(',');
    if (message.bcc && message.bcc.length) options.bcc = message.bcc.join(',');
    MailApp.sendEmail(options); returned = true;
  } catch (_) { /* May have sent. Preserve uncertainty; never retry this gym/day. */ }
  var completed = row.slice(); completed[1] = returned ? 'submitted' : 'exception'; completed[7] = new Date().toISOString();
  completed[8] = returned ? 'MAILAPP_SUBMITTED' : 'MAILAPP_CALL_UNCERTAIN'; held = false;
  try {
    held = lock.tryLock(10000); if (!held) throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
    sheet = gibM1MailAppSheet_(body);
    var retained = gibM1MailAppRead_(sheet, message);
    if (!retained || retained.attemptedAt !== row[6] || retained.completedAt) throw new Error('MAILAPP_ORIGINAL_CONFLICT');
    gibM1MailAppAppend_(sheet, completed);
    var confirmed = gibM1MailAppRead_(sheet, message);
    if (!confirmed || confirmed.completedAt !== completed[7]) throw new Error('MAILAPP_STORAGE_UNCONFIRMED');
    return jsonResult_(confirmed);
  } catch (_) { return jsonResult_(gibM1MailAppResult_(message, 'unknown', 'MAILAPP_RESULT_UNCONFIRMED', row[6])); }
  finally { if (held) lock.releaseLock(); }
}

// Editor-only consent handoff. Uses no send method and changes no records.
function authorizeRevolutionTestMailApp() {
  if (!gibM1MailAppScope_() || !gibM1MailAppActor_()) throw new Error('MAILAPP_SENDER_UNVERIFIED');
  var quota = MailApp.getRemainingDailyQuota();
  if (!Number.isSafeInteger(quota) || quota < 0) throw new Error('MAILAPP_QUOTA_UNAVAILABLE');
  var evidence = { ok: true, target: 'test', senderVerified: true, quotaAvailable: quota > 0 };
  console.log('M1_TEST_MAILAPP_AUTHORIZATION ' + JSON.stringify(evidence));
  return evidence;
}
// One explicit TEST setup; ordinary requests never create or replace this tab.
function prepareRevolutionTestMailAppLedger() {
  if (!gibM1MailAppScope_() || !gibM1MailAppActor_()) throw new Error('MAILAPP_SENDER_UNVERIFIED');
  var lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
  try {
    var properties = PropertiesService.getScriptProperties(), book = openExpectedSpreadsheet_({ target: 'test' }), sheet = book.getSheetByName(GIB_M1_MAILAPP_TAB_);
    if (properties.getProperty(GIB_M1_MAILAPP_READY_) === 'v1') { gibM1MailAppHeaders_(sheet); return { ok: true, target: 'test', initialized: true }; }
    if (sheet && sheet.getLastRow() > 1) throw new Error('MAILAPP_LEDGER_UNAVAILABLE');
    if (!sheet) sheet = book.insertSheet(GIB_M1_MAILAPP_TAB_);
    if (sheet.getLastRow() === 0) gibM1MailAppAppend_(sheet, GIB_M1_MAILAPP_HEADERS_.slice());
    gibM1MailAppHeaders_(sheet);
    properties.setProperty(GIB_M1_MAILAPP_READY_, 'v1');
    if (properties.getProperty(GIB_M1_MAILAPP_READY_) !== 'v1') throw new Error('MAILAPP_STORAGE_UNCONFIRMED');
    return { ok: true, target: 'test', initialized: true };
  } finally { lock.releaseLock(); }
}
