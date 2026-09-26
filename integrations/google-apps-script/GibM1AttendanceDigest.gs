/* Separate Revolution TEST project only. Capture delivery; never sends email. */
var GIB_M1_DIGEST_SCHEMA_ = 'm1-attendance-digest-job/v1';
var GIB_M1_DIGEST_URL_ = 'https://deploy-preview-89--gib-live.netlify.app/api/m1-attendance-digest-job';
var GIB_M1_DIGEST_PENDING_ = 'M1_TEST_DIGEST_PENDING_';
var GIB_M1_DIGEST_RECEIPT_ = 'M1_TEST_DIGEST_RECEIPT_';
// Temporary editor-only public metadata. Restore null after the bounded rehearsal.
var GIB_M1_DIGEST_REHEARSAL_PUBLIC_LEASE_ = null;
var GIB_M1_DIGEST_REHEARSAL_LEASE_ = 'M1_TEST_DIGEST_REHEARSAL_LEASE';

// Pure public vectors for the TEST editor: no configuration, records or requests.
function testRevolutionAttendanceDigestHmacVectors() {
  var key = 'public-m1-digest-vector-v1';
  var vectors = [
    { id: 'ascii', value: { label: 'QA TEST digest', note: 'plain ASCII' }, expected: 'febfdbc751940f24f70242f8e9395fbf42cffa3313f5e301077be16720b9b1b5' },
    { id: 'unicode', value: { label: 'QA TEST \u2014 digest', note: 'caf\u00e9 \u4e2d\u6587 \ud83e\udd4b' }, expected: 'ab284bcea9996f8272b1a21cdae95af8d11b946de6d4374f6f05f52e57d3556c' }
  ];
  function hex(bytes) {
    return bytes.map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
  }
  var result = { schema: 'm1-digest-public-hmac-vectors/v1', cases: vectors.map(function(vector) {
    var value = 'm1-attendance-digest-job/v1\n' + JSON.stringify(vector.value);
    var ordinary = hex(Utilities.computeHmacSha256Signature(value, key));
    var utf8 = hex(Utilities.computeHmacSha256Signature(value, key, Utilities.Charset.UTF_8));
    return { id: vector.id, defaultMatchesUtf8: ordinary === utf8,
      defaultMatchesExpected: ordinary === vector.expected, utf8MatchesExpected: utf8 === vector.expected };
  }) };
  console.log('M1_TEST_DIGEST_HMAC_VECTORS ' + JSON.stringify(result));
  return result;
}

function gibM1DigestEnabled_() {
  return typeof gibM1TestReadCallbackEnabled_ === 'function' && gibM1TestReadCallbackEnabled_()
    && EXPECTED_SPREADSHEET_NAME === 'RBJJ M1 — TEST';
}
function gibM1DigestBinding_(binding, mode, now) {
  var keys = ['createdAt', 'expiresAt', 'jobDate', 'mode', 'requestId', 'schema', 'target'];
  if (!binding || Object.keys(binding).sort().join('|') !== keys.join('|')
    || binding.schema !== GIB_M1_DIGEST_SCHEMA_ || binding.target !== 'test' || binding.mode !== mode
    || ['manual', 'scheduled'].indexOf(binding.mode) < 0
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding.requestId || '')
    || !Number.isSafeInteger(binding.createdAt) || binding.createdAt > now || binding.expiresAt !== binding.createdAt + 60000
    || now >= binding.expiresAt || binding.jobDate !== Utilities.formatDate(new Date(binding.createdAt), 'America/New_York', 'yyyy-MM-dd')) {
    throw new Error('DIGEST_BINDING_INVALID');
  }
  return binding;
}
function gibM1DigestCleanup_(properties, now) {
  // Independent receipt keys retain failures; bounded cleanup never touches Sheets.
  try {
    var keys = properties.getKeys().filter(function(key) { return /^(M1_TEST_DIGEST_PENDING_|M1_TEST_DIGEST_RECEIPT_)\d{13}_[0-9a-f-]{36}$/.test(key); });
    keys.filter(function(key) { return Number(key.match(/(\d{13})_/)[1]) <= now; }).slice(0, 32).forEach(function(key) { properties.deleteProperty(key); });
    return keys.length;
  } catch (_) { return 200; }
}
function gibM1DigestResponseCode_(code) {
  // Only fixed categories from the TEST callback contract may enter diagnostics.
  // Never persist its response message, body, URL or any unrecognized error text.
  var allowed = ['DIGEST_SCOPE_REQUIRED', 'DIGEST_RUNTIME_UNAVAILABLE', 'DIGEST_AUTHENTICATION_FAILED',
    'DIGEST_INVALID_JSON', 'DIGEST_INVALID_ENVELOPE', 'DIGEST_BINDING_MISMATCH', 'DIGEST_REQUEST_EXPIRED',
    'DIGEST_GYM_MISMATCH', 'DIGEST_MANUAL_REQUEST_MISSING', 'DIGEST_RESULT_CONFLICT', 'DIGEST_REQUEST_MISSING',
    'DIGEST_STORAGE_INCOMPLETE', 'DIGEST_STORAGE_UNCONFIRMED', 'DIGEST_CONFIGURATION_UNAVAILABLE',
    'DIGEST_OUTBOX_INCOMPLETE', 'DIGEST_OUTBOX_UNCONFIRMED', 'DIGEST_CAPTURE_CONFLICT',
    'DIGEST_CAPTURE_UNCONFIRMED', 'DIGEST_CAPTURE_STATUS_UNCONFIRMED', 'DIGEST_JOB_UNAVAILABLE',
    'DIGEST_REHEARSAL_EXPIRED', 'DIGEST_REHEARSAL_MISSING', 'DIGEST_REHEARSAL_INVALID', 'DIGEST_REHEARSAL_UNAVAILABLE',
    'RESPONSE_NOT_JSON', 'RESPONSE_CODE_UNAVAILABLE'];
  return allowed.indexOf(code) >= 0 ? code : 'RESPONSE_CODE_UNAVAILABLE';
}
function gibM1DigestReceipt_(properties, binding, started, code, status, acknowledged, state, responseCode) {
  try {
    var now = Date.now();
    if (gibM1DigestCleanup_(properties, now) >= 160) return;
    properties.setProperty(GIB_M1_DIGEST_RECEIPT_ + String(now + 86400000) + '_' + Utilities.getUuid(),
      JSON.stringify({ requestId: binding.requestId, mode: binding.mode, code: code, status: status,
        acknowledged: acknowledged, state: state, elapsedMs: Math.max(0, now - started),
        responseCode: responseCode == null ? null : gibM1DigestResponseCode_(responseCode) }));
  } catch (_) { console.log('M1_TEST_DIGEST_RECEIPT_UNAVAILABLE'); }
}
function gibM1DigestStaffRead_(body) {
  var lock = LockService.getScriptLock(), held = false;
  try {
    held = lock.tryLock(10000);
    if (!held) return { ok: false, code: 'STAFF_LOCK_UNAVAILABLE' };
    return staffRecoveryOutstanding_(openExpectedSpreadsheet_(body));
  } catch (_) { return { ok: false, code: 'STAFF_READ_UNAVAILABLE' }; }
  finally { if (held) lock.releaseLock(); }
}
function gibM1DigestDispatch_(binding) {
  if (!gibM1DigestEnabled_()) throw new Error('Revolution TEST project required.');
  var started = Date.now(), properties = PropertiesService.getScriptProperties();
  gibM1DigestBinding_(binding, binding.mode, started);
  if (gibM1DigestCleanup_(properties, started) >= 160) throw new Error('DIGEST_RECEIPT_CAPACITY');
  var pendingKey = GIB_M1_DIGEST_PENDING_ + String(binding.expiresAt + 3600000) + '_' + binding.requestId;
  var pending = JSON.stringify(binding), previous = properties.getProperty(pendingKey);
  if (previous && previous !== pending) throw new Error('DIGEST_REQUEST_CONFLICT');
  // A durable exact request exists before either read or the external dispatch.
  properties.setProperty(pendingKey, pending);
  if (properties.getProperty(pendingKey) !== pending) throw new Error('DIGEST_PENDING_UNCONFIRMED');
  var body = { action: 'managerReviewRead', target: 'test', token: configuredReceiverSecret_(),
    adminActionToken: configuredAdminActionSecret_(), gym: 'rev', from: '2026-09-07', to: binding.jobDate, check: null };
  var attendance;
  try {
    var ledger = JSON.parse(managerReviewAction_(body).getContent());
    attendance = ledger && ledger.ok === true ? { ok: true, ledger: ledger } : { ok: false, code: 'ATTENDANCE_READ_REJECTED' };
  } catch (_) { attendance = { ok: false, code: 'ATTENDANCE_READ_UNAVAILABLE' }; }
  var staff = gibM1DigestStaffRead_(body);
  var payload = {};
  Object.keys(binding).forEach(function(key) { payload[key] = binding[key]; });
  payload.gyms = [{ gym: 'rev', attendance: attendance, staff: staff }];
  var raw = JSON.stringify(payload), status = null, acknowledged = false, state = null, code = 'DELIVERY_UNAVAILABLE', responseCode = null;
  try {
    if (Date.now() >= binding.expiresAt) throw new Error('DIGEST_EXPIRED');
    if (Utilities.newBlob(raw).getBytes().length > 400000) { code = 'PAYLOAD_TOO_LARGE'; throw new Error(code); }
    var signature = Utilities.computeHmacSha256Signature(GIB_M1_DIGEST_SCHEMA_ + '\n' + raw, configuredAdminActionSecret_(), Utilities.Charset.UTF_8)
      .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
    // Both authoritative read locks have been released. Await this bounded single
    // delivery in the trigger/web invocation; never launch detached work.
    var response = UrlFetchApp.fetch(GIB_M1_DIGEST_URL_, { method: 'post', contentType: 'application/json',
      payload: raw, headers: { 'X-GIB-M1-Digest-Signature': signature }, followRedirects: false, muteHttpExceptions: true });
    status = response.getResponseCode();
    responseCode = 'RESPONSE_NOT_JSON';
    var result = JSON.parse(response.getContentText());
    responseCode = gibM1DigestResponseCode_(result && result.code);
    var messageId = binding.mode === 'scheduled' ? 'm1-test-daily-' + binding.jobDate : 'm1-test-manual-' + binding.requestId;
    acknowledged = status >= 200 && status < 300 && result && result.ok === true && result.accepted === true
      && result.requestId === binding.requestId && ['not-due', 'awaiting-configuration', 'captured', 'suppressed', 'failed'].indexOf(result.state) >= 0
      && (['not-due', 'awaiting-configuration'].indexOf(result.state) >= 0 ? result.messageId === null : result.messageId === messageId);
    if (acknowledged) { state = result.state; code = state === 'failed' ? 'CAPTURE_FAILED' : 'ACKNOWLEDGED'; responseCode = null; }
    else code = status >= 200 && status < 300 ? 'ACKNOWLEDGMENT_INVALID' : 'DELIVERY_HTTP_FAILURE';
  } catch (_) { code = code === 'PAYLOAD_TOO_LARGE' ? code : Date.now() >= binding.expiresAt ? 'REQUEST_EXPIRED' : 'DELIVERY_UNAVAILABLE'; }
  gibM1DigestReceipt_(properties, binding, started, code, status, acknowledged, state, responseCode);
  return { ok: acknowledged, requestId: binding.requestId, state: state, code: code };
}
function gibM1AttendanceDigestCapture_(body) {
  if (!gibM1DigestEnabled_() || !adminActionAuthorized_(body) || GIB_M1_ADMIN_NAMES_.indexOf(body.adminName) < 0) {
    return jsonResult_({ ok: false, code: 'DIGEST_AUTHENTICATION_REQUIRED' });
  }
  try {
    gibM1DigestBinding_(body.binding, 'manual', Date.now());
    return jsonResult_(gibM1DigestDispatch_(body.binding));
  } catch (_) { return jsonResult_({ ok: false, code: 'DIGEST_CAPTURE_UNAVAILABLE' }); }
}
// Install a 15-minute time-driven trigger through this TEST project's editor.
// No ScriptApp trigger API, mail API, new permission or browser is needed to run.
function testRevolutionAttendanceDigestTick() {
  if (!gibM1DigestEnabled_()) { console.log('M1_TEST_DIGEST_DISABLED'); return; }
  var now = Date.now();
  var binding = { schema: GIB_M1_DIGEST_SCHEMA_, target: 'test', requestId: Utilities.getUuid(), mode: 'scheduled',
    jobDate: Utilities.formatDate(new Date(now), 'America/New_York', 'yyyy-MM-dd'), createdAt: now, expiresAt: now + 60000 };
  var result;
  try { result = gibM1DigestDispatch_(binding); }
  catch (_) {
    // Expected unavailable jobs must not trigger Google's separate failure emails.
    // The next timer can recover; this receipt never asserts a successful capture.
    result = { ok: false, requestId: binding.requestId, state: null, code: 'DIGEST_JOB_UNAVAILABLE' };
    try { gibM1DigestReceipt_(PropertiesService.getScriptProperties(), binding, now, result.code, null, false, null); } catch (_) {}
  }
  console.log('M1_TEST_DIGEST ' + JSON.stringify(result));
}
function testRevolutionAttendanceDigestReceipts() {
  if (!gibM1DigestEnabled_()) throw new Error('Revolution TEST project required.');
  var properties = PropertiesService.getScriptProperties();
  gibM1DigestCleanup_(properties, Date.now());
  properties.getKeys().filter(function(key) { return key.indexOf(GIB_M1_DIGEST_RECEIPT_) === 0; }).sort()
    .forEach(function(key) { console.log('M1_TEST_DIGEST_RECEIPT ' + properties.getProperty(key)); });
}

function gibM1DigestRehearsalLease_(lease, now) {
  if (!lease || Object.keys(lease).sort().join('|') !== 'createdAt|cutoffAt|expiresAt|jobDate|rehearsalId|state|synthetic'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lease.rehearsalId || '')
    || lease.synthetic !== true || lease.state !== 'armed' || !Number.isSafeInteger(lease.createdAt) || lease.createdAt > now
    || !Number.isSafeInteger(lease.cutoffAt) || lease.cutoffAt % 60000 !== 0
    || lease.cutoffAt < lease.createdAt + 120000 || lease.cutoffAt >= lease.createdAt + 180000
    || lease.expiresAt !== lease.createdAt + 1800000
    || lease.jobDate !== Utilities.formatDate(new Date(lease.createdAt), 'America/New_York', 'yyyy-MM-dd')
    || lease.jobDate !== Utilities.formatDate(new Date(lease.cutoffAt), 'America/New_York', 'yyyy-MM-dd')) throw new Error('DIGEST_REHEARSAL_INVALID');
  return lease;
}
// Paste only the public lease returned by authenticated TEST Admin into the null
// constant above, run this editor helper, then restore that constant to null.
function testRevolutionAttendanceDigestRehearsalArm() {
  if (!gibM1DigestEnabled_()) throw new Error('Revolution TEST project required.');
  var now = Date.now(), lease = gibM1DigestRehearsalLease_(GIB_M1_DIGEST_REHEARSAL_PUBLIC_LEASE_, now);
  if (now + 60000 >= lease.expiresAt) throw new Error('DIGEST_REHEARSAL_EXPIRED');
  var properties = PropertiesService.getScriptProperties(), raw = JSON.stringify(lease), prior = properties.getProperty(GIB_M1_DIGEST_REHEARSAL_LEASE_);
  if (prior && prior !== raw) {
    var existing = gibM1DigestRehearsalLease_(JSON.parse(prior), now);
    if (existing.expiresAt > now) throw new Error('DIGEST_REHEARSAL_CONFLICT');
  }
  properties.setProperty(GIB_M1_DIGEST_REHEARSAL_LEASE_, raw);
  if (properties.getProperty(GIB_M1_DIGEST_REHEARSAL_LEASE_) !== raw) throw new Error('DIGEST_REHEARSAL_UNAVAILABLE');
  console.log('M1_TEST_DIGEST_REHEARSAL_ARMED ' + JSON.stringify({ rehearsalId: lease.rehearsalId, expiresAt: lease.expiresAt }));
}
function gibM1DigestRehearsalDispatch_(lease, binding, properties) {
  if (!gibM1DigestEnabled_()) throw new Error('Revolution TEST project required.');
  var started = Date.now();
  gibM1DigestRehearsalLease_(lease, started);
  if (!binding || Object.keys(binding).sort().join('|') !== 'createdAt|expiresAt|jobDate|mode|rehearsalId|requestId|schema|target'
    || binding.schema !== GIB_M1_DIGEST_SCHEMA_ || binding.target !== 'test' || binding.mode !== 'rehearsal'
    || binding.rehearsalId !== lease.rehearsalId || binding.jobDate !== lease.jobDate
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding.requestId || '')
    || !Number.isSafeInteger(binding.createdAt) || binding.createdAt > started || binding.expiresAt !== binding.createdAt + 60000
    || binding.jobDate !== Utilities.formatDate(new Date(binding.createdAt), 'America/New_York', 'yyyy-MM-dd')) throw new Error('DIGEST_BINDING_INVALID');
  if (started >= binding.expiresAt || binding.createdAt < lease.createdAt || binding.expiresAt > lease.expiresAt) throw new Error('DIGEST_REHEARSAL_EXPIRED');
  if (gibM1DigestCleanup_(properties, started) >= 160) throw new Error('DIGEST_RECEIPT_CAPACITY');
  var pendingKey = GIB_M1_DIGEST_PENDING_ + String(binding.expiresAt + 3600000) + '_' + binding.requestId;
  var pending = JSON.stringify(binding), previous = properties.getProperty(pendingKey);
  if (previous && previous !== pending) throw new Error('DIGEST_REQUEST_CONFLICT');
  properties.setProperty(pendingKey, pending);
  if (properties.getProperty(pendingKey) !== pending) throw new Error('DIGEST_PENDING_UNCONFIRMED');
  // No Sheet reads, locks or authoritative records are involved. Netlify builds
  // isolated synthetic inputs from its existing authenticated, expiring lease.
  var payload = {};
  Object.keys(binding).forEach(function(key) { payload[key] = binding[key]; });
  payload.gyms = [];
  var raw = JSON.stringify(payload), status = null, acknowledged = false, state = null, code = 'DELIVERY_UNAVAILABLE', responseCode = null;
  try {
    if (Date.now() >= binding.expiresAt) throw new Error('DIGEST_EXPIRED');
    var signature = Utilities.computeHmacSha256Signature(GIB_M1_DIGEST_SCHEMA_ + '\n' + raw, configuredAdminActionSecret_(), Utilities.Charset.UTF_8)
      .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
    var response = UrlFetchApp.fetch(GIB_M1_DIGEST_URL_, { method: 'post', contentType: 'application/json', payload: raw,
      headers: { 'X-GIB-M1-Digest-Signature': signature }, followRedirects: false, muteHttpExceptions: true });
    status = response.getResponseCode(); responseCode = 'RESPONSE_NOT_JSON';
    var result = JSON.parse(response.getContentText()); responseCode = gibM1DigestResponseCode_(result && result.code);
    var messageId = 'm1-test-rehearsal-' + lease.rehearsalId + '-' + lease.jobDate;
    acknowledged = status >= 200 && status < 300 && result && result.ok === true && result.accepted === true && result.requestId === binding.requestId
      && ['not-due', 'captured', 'suppressed', 'failed'].indexOf(result.state) >= 0
      && (result.state === 'not-due' ? result.messageId === null : result.messageId === messageId);
    if (acknowledged) { state = result.state; code = state === 'failed' ? 'CAPTURE_FAILED' : 'ACKNOWLEDGED'; responseCode = null; }
    else code = status >= 200 && status < 300 ? 'ACKNOWLEDGMENT_INVALID' : 'DELIVERY_HTTP_FAILURE';
  } catch (_) { code = Date.now() >= binding.expiresAt ? 'REQUEST_EXPIRED' : 'DELIVERY_UNAVAILABLE'; }
  gibM1DigestReceipt_(properties, binding, started, code, status, acknowledged, state, responseCode);
  return { ok: acknowledged, requestId: binding.requestId, state: state, code: code };
}
// Temporary editor-created timer only. Never installs a trigger or sends mail.
function testRevolutionAttendanceDigestRehearsalTick() {
  if (!gibM1DigestEnabled_()) { console.log('M1_TEST_DIGEST_REHEARSAL_DISABLED'); return; }
  var now = Date.now(), binding = null, properties = null, result;
  try {
    properties = PropertiesService.getScriptProperties();
    var raw = properties.getProperty(GIB_M1_DIGEST_REHEARSAL_LEASE_);
    if (!raw) { console.log('M1_TEST_DIGEST_REHEARSAL_INACTIVE'); return; }
    var lease = gibM1DigestRehearsalLease_(JSON.parse(raw), now);
    if (now + 60000 >= lease.expiresAt || lease.jobDate !== Utilities.formatDate(new Date(now), 'America/New_York', 'yyyy-MM-dd')) {
      properties.deleteProperty(GIB_M1_DIGEST_REHEARSAL_LEASE_);
      console.log('M1_TEST_DIGEST_REHEARSAL_FINISHED'); return;
    }
    binding = { schema: GIB_M1_DIGEST_SCHEMA_, target: 'test', requestId: Utilities.getUuid(), mode: 'rehearsal', rehearsalId: lease.rehearsalId,
      jobDate: lease.jobDate, createdAt: now, expiresAt: now + 60000 };
    result = gibM1DigestRehearsalDispatch_(lease, binding, properties);
  } catch (_) {
    result = { ok: false, requestId: binding ? binding.requestId : null, state: null, code: 'DIGEST_REHEARSAL_UNAVAILABLE' };
    if (binding && properties) gibM1DigestReceipt_(properties, binding, now, result.code, null, false, null);
  }
  console.log('M1_TEST_DIGEST_REHEARSAL ' + JSON.stringify(result));
}
function testRevolutionAttendanceDigestRehearsalStop() {
  if (!gibM1DigestEnabled_()) throw new Error('Revolution TEST project required.');
  PropertiesService.getScriptProperties().deleteProperty(GIB_M1_DIGEST_REHEARSAL_LEASE_);
  console.log('M1_TEST_DIGEST_REHEARSAL_STOPPED');
}
