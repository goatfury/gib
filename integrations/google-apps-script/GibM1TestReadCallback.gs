/* Revolution TEST only. No callback support for writes or other installations. */
var GIB_M1_TEST_READ_CALLBACK_URL_ = 'https://deploy-preview-89--gib-live.netlify.app/api/m1-test-read-result';
var GIB_M1_TEST_READ_CALLBACK_SCHEMA_ = 'm1-test-read-callback/v1';

// Editor-armed diagnostic only; no HTTP action exposes these receipts.
var GIB_M1_READ_TRACE_WINDOW_ = 'M1_TEST_READ_TRACE_UNTIL';
var GIB_M1_READ_TRACE_PREFIX_ = 'M1_TEST_READ_TRACE_V1_';
var GIB_M1_READ_TRACE_STAGES_ = ['google.request', 'google.envelope', 'google.binding', 'google.fault', 'google.lock', 'google.read', 'google.decode', 'google.result', 'google.payload', 'google.signature', 'google.expiry', 'google.callback', 'google.ack'];
var GIB_M1_READ_TRACE_STATES_ = ['accepted', 'validated', 'rejected', 'armed', 'skipped', 'waiting', 'acquired', 'unavailable', 'released', 'start', 'response', 'failed'];
var GIB_M1_READ_TRACE_ERRORS_ = ['none', 'validation_rejected', 'read_rejected', 'payload_limit', 'expired', 'thrown_exception', 'callback_http', 'ack_invalid_json', 'ack_mismatch', 'ack_read_exception'];
function gibM1ReadTraceKeys_(properties, now) {
  var keys = properties.getKeys().filter(function(key) { return /^M1_TEST_READ_TRACE_V1_\d{13}_[0-9a-f-]{36}$/.test(key); });
  var expired = keys.filter(function(key) { return Number(key.slice(GIB_M1_READ_TRACE_PREFIX_.length, GIB_M1_READ_TRACE_PREFIX_.length + 13)) <= now; });
  expired.slice(0, 32).forEach(function(key) { properties.deleteProperty(key); });
  // Count retained expired keys too: failed/partial cleanup must not grow storage.
  return keys.filter(function(key) { return expired.slice(0, 32).indexOf(key) < 0; });
}
function testRevolutionStartReadTrace() {
  if (!gibM1TestReadCallbackEnabled_()) throw new Error('Revolution TEST project required.');
  var properties = PropertiesService.getScriptProperties();
  gibM1ReadTraceKeys_(properties, Date.now());
  properties.setProperty(GIB_M1_READ_TRACE_WINDOW_, String(Date.now() + 20 * 60000));
  console.log('Revolution TEST read tracing armed for 20 minutes. Existing receipts retained.');
}
function testRevolutionStopReadTrace() {
  if (!gibM1TestReadCallbackEnabled_()) throw new Error('Revolution TEST project required.');
  PropertiesService.getScriptProperties().deleteProperty(GIB_M1_READ_TRACE_WINDOW_);
  console.log('Revolution TEST read tracing stopped. Existing receipts retained.');
}
function gibM1SanitizeReadReceipt_(value) {
  if (!value || !Array.isArray(value.events)) throw new Error('Invalid trace.');
  var elapsed = function(ms) { return Number.isSafeInteger(ms) && ms >= 0 && ms <= 360000 ? ms : null; };
  var status = function(code) { return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null; };
  return {
    requestId: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId) ? value.requestId : null,
    stage: GIB_M1_READ_TRACE_STAGES_.indexOf(value.stage) >= 0 ? value.stage : 'google.request',
    error: GIB_M1_READ_TRACE_ERRORS_.indexOf(value.error) >= 0 ? value.error : 'thrown_exception',
    elapsedMs: elapsed(value.elapsedMs), status: status(value.status),
    acknowledged: typeof value.acknowledged === 'boolean' ? value.acknowledged : null,
    events: value.events.slice(0, 16).map(function(event) { return {
      stage: GIB_M1_READ_TRACE_STAGES_.indexOf(event.stage) >= 0 ? event.stage : 'google.request',
      state: GIB_M1_READ_TRACE_STATES_.indexOf(event.state) >= 0 ? event.state : 'failed',
      elapsedMs: elapsed(event.elapsedMs), status: status(event.status)
    }; })
  };
}
function testRevolutionReadTraceReceipts() {
  if (!gibM1TestReadCallbackEnabled_()) throw new Error('Revolution TEST project required.');
  var properties = PropertiesService.getScriptProperties(), now = Date.now();
  gibM1ReadTraceKeys_(properties, now).sort().forEach(function(key) {
    if (Number(key.slice(GIB_M1_READ_TRACE_PREFIX_.length, GIB_M1_READ_TRACE_PREFIX_.length + 13)) <= now) return;
    try { console.log('M1_TEST_READ_RECEIPT ' + JSON.stringify(gibM1SanitizeReadReceipt_(JSON.parse(properties.getProperty(key))))); }
    catch (_) { console.log('M1_TEST_READ_TRACE_UNAVAILABLE'); }
  });
}
function gibM1ReadTraceReceipt_(requestId, started) {
  var events = [], active = false;
  try {
    var until = Number(PropertiesService.getScriptProperties().getProperty(GIB_M1_READ_TRACE_WINDOW_));
    active = until > started && until <= started + 20 * 60000;
  } catch (_) {} // Diagnostics never gate the authoritative read or callback.
  return {
    event: function(stage, state, status) {
      try { if (active && events.length < 16) events.push({ stage: stage, state: state, elapsedMs: Math.max(0, Date.now() - started), status: status }); } catch (_) {}
    },
    finish: function(stage, error, status, acknowledged) {
      if (!active) return;
      try {
        var properties = PropertiesService.getScriptProperties(), now = Date.now();
        // No lock. Separate UUID keys never let a later success overwrite a failure.
        // Admission stops at 96 receipts; the owner-run deployment's 30-execution
        // limit bounds an admission race to 125 receipts, each <=2500 ASCII bytes.
        // https://developers.google.com/apps-script/guides/services/quotas
        if (gibM1ReadTraceKeys_(properties, now).length >= 96) throw new Error('Trace capacity.');
        var raw = JSON.stringify(gibM1SanitizeReadReceipt_({ requestId: requestId, stage: stage, error: error,
          elapsedMs: Math.max(0, now - started), status: status, acknowledged: acknowledged, events: events }));
        if (raw.length > 2500) throw new Error('Trace capacity.');
        // Expiry lives only in storage metadata; receipts retain no business data.
        var key = GIB_M1_READ_TRACE_PREFIX_ + String(now + 60 * 60000) + '_' + Utilities.getUuid();
        properties.setProperty(key, raw);
      } catch (_) { try { console.log('M1_TEST_READ_TRACE_UNAVAILABLE'); } catch (_) {} }
    }
  };
}

function gibM1TestReadCallbackEnabled_() {
  return typeof GIB_M1_ALLOWED_TARGET !== 'undefined' && GIB_M1_ALLOWED_TARGET === 'test'
    && typeof GIB_M1_RICHMOND_INSTALLATION_ === 'undefined'
    && EXPECTED_SPREADSHEET_NAME === 'RBJJ M1 — TEST' && managerReviewEnabled_();
}

// Run this only from the separate TEST project's editor for the owner's consent.
// getRequest requires external_request, but sends nothing and touches no records.
function authorizeRevolutionTestReadCallback() {
  if (!gibM1TestReadCallbackEnabled_()) throw new Error('Revolution TEST project required.');
  UrlFetchApp.getRequest(GIB_M1_TEST_READ_CALLBACK_URL_, { method: 'post' });
  console.log('Revolution TEST callback permission is available. No request sent.');
}

// Editor-only, one-shot fault for hosted TEST QA. No HTTP action can arm it.
// It delays one badge callback past its original expiry without changing data.
function testRevolutionLateBadgeCallback() {
  if (!gibM1TestReadCallbackEnabled_()) throw new Error('Revolution TEST project required.');
  PropertiesService.getScriptProperties().setProperty('M1_TEST_LATE_BADGE', String(Date.now() + 120000));
  console.log('One late TEST badge callback armed for two minutes.');
}
function testRevolutionCallbackFaultReceipt() {
  if (!gibM1TestReadCallbackEnabled_()) throw new Error('Revolution TEST project required.');
  console.log(PropertiesService.getScriptProperties().getProperty('M1_TEST_CALLBACK_FAULT_RECEIPT') || 'No fault receipt.');
}
function gibM1ConsumeLateBadge_(binding) {
  if (binding.action !== 'managerReviewBadgeRead') return false;
  var lock, acquired = false;
  try {
    var properties = PropertiesService.getScriptProperties();
    var expiry = Number(properties.getProperty('M1_TEST_LATE_BADGE'));
    // Normal badges must not contend with the authoritative attendance lock.
    if (!(expiry > Date.now() && expiry <= Date.now() + 120000)) return false;
    lock = LockService.getScriptLock();
    acquired = lock.tryLock(0);
    if (!acquired) return false;
    // Recheck under the lock so at most one overlapping badge consumes a fault.
    expiry = Number(properties.getProperty('M1_TEST_LATE_BADGE'));
    properties.deleteProperty('M1_TEST_LATE_BADGE');
    return expiry > Date.now() && expiry <= Date.now() + 120000;
  } catch (_) { return false; }
  finally { if (acquired) { try { lock.releaseLock(); } catch (_) {} } }
}

function gibM1TestReadCallback_(body) {
  var trace = function() {};
  var receipt = { event: function() {}, finish: function() {} };
  var stage = 'google.request', error = 'thrown_exception', status = null, acknowledged = null;
  var now = Date.now();
  try {
    if (!gibM1TestReadCallbackEnabled_() || !adminActionAuthorized_(body)) return rejectedAuthResult_();
    var b = body.binding;
    receipt = gibM1ReadTraceReceipt_(b && b.requestId, now);
    trace = function(stage, state, status) {
      // Allow-listed diagnostic data only; never raw errors, response bodies or secrets.
      try {
        receipt.event(stage, state, status);
        var event = gibM1SanitizeReadReceipt_({ requestId: b && b.requestId, events: [{ stage: stage, state: state, status: status, elapsedMs: Math.max(0, Date.now() - now) }] });
        console.log('M1_TEST_READ_STAGE ' + JSON.stringify({ requestId: event.requestId, stage: event.events[0].stage,
          state: event.events[0].state, elapsedMs: event.events[0].elapsedMs, status: event.events[0].status }));
      } catch (_) {}
    };
    trace('google.request', 'accepted');
    stage = 'google.envelope';
    if (body.action !== 'managerReviewReadCallbackProof' || requestTarget_(body) !== 'test'
      || body.gym !== 'rev' || body.from !== '2026-09-07' || body.to !== todayNewYork_()) {
      error = 'validation_rejected'; trace(stage, 'rejected'); return rejectedAuthResult_();
    }
    trace(stage, 'validated');
    stage = 'google.binding';
    var fields = ['schema', 'requestId', 'target', 'gym', 'action', 'from', 'to', 'createdAt', 'expiresAt'];
    if (!b || JSON.stringify(Object.keys(b).sort()) !== JSON.stringify(fields.sort())
      || b.schema !== GIB_M1_TEST_READ_CALLBACK_SCHEMA_ || b.target !== 'test' || b.gym !== 'rev'
      || ['managerReviewRead', 'managerReviewBadgeRead'].indexOf(b.action) < 0 || b.from !== body.from || b.to !== body.to
      || (b.action === 'managerReviewRead' ? GIB_M1_ADMIN_NAMES_.indexOf(body.adminName) < 0 : body.adminName !== undefined)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.requestId)
      || !Number.isSafeInteger(b.createdAt) || b.createdAt > now || b.expiresAt !== b.createdAt + 60000
      || now >= b.expiresAt) { error = 'validation_rejected'; trace(stage, 'rejected'); return rejectedAuthResult_(); }
    trace(stage, 'validated');
    var lateTest = gibM1ConsumeLateBadge_(b);
    trace('google.fault', lateTest ? 'armed' : 'skipped');
    // This existing read owns and releases its lock in finally before returning.
    stage = 'google.read';
    var read = managerReviewAction_({ action: 'managerReviewRead', target: 'test', token: body.token,
      adminActionToken: body.adminActionToken, gym: 'rev', from: body.from, to: body.to, adminName: body.adminName, check: null }, trace);
    stage = 'google.decode';
    var result = JSON.parse(read.getContent());
    var readAt = Date.now();
    stage = 'google.result';
    if (result.ok !== true || result.complete !== true || result.schema !== 'm1-manager-review/v1'
      || result.gym !== 'rev' || result.from !== b.from || result.to !== b.to || readAt >= b.expiresAt) {
      error = 'read_rejected'; throw new Error('Read unavailable.');
    }
    stage = 'google.payload';
    var raw = JSON.stringify({ binding: b, readAt: readAt, result: result });
    if (Utilities.newBlob(raw).getBytes().length > 256000) { error = 'payload_limit'; throw new Error('Callback too large.'); }
    stage = 'google.signature';
    var signature = Utilities.computeHmacSha256Signature(GIB_M1_TEST_READ_CALLBACK_SCHEMA_ + '\n' + raw, body.adminActionToken, Utilities.Charset.UTF_8)
      .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
    if (lateTest) Utilities.sleep(Math.max(0, b.expiresAt + 1000 - Date.now()));
    stage = 'google.expiry';
    var sentAt = Date.now();
    var remaining = Math.floor((b.expiresAt - sentAt) / 1000);
    if (remaining < 1 && !lateTest) { error = 'expired'; throw new Error('Read expired.'); }
    stage = 'google.callback';
    trace('google.callback', 'start');
    var response = UrlFetchApp.fetch(GIB_M1_TEST_READ_CALLBACK_URL_, {
      method: 'post', contentType: 'application/json', payload: raw,
      headers: { 'X-GIB-M1-Read-Signature': signature },
      followRedirects: false, validateHttpsCertificates: true, muteHttpExceptions: true,
      timeoutSeconds: lateTest ? 10 : Math.min(10, remaining)
    });
    status = response.getResponseCode();
    trace('google.callback', 'response', status);
    acknowledged = false;
    error = 'callback_http';
    if (status === 200) {
      stage = 'google.ack';
      try {
        var ackText = response.getContentText();
        error = 'ack_invalid_json';
        var ack, parsed = false;
        try { if (ackText.length <= 2048) { ack = JSON.parse(ackText); parsed = true; } } catch (_) {}
        if (parsed) {
          acknowledged = Boolean(ack && ack.ok === true && ack.accepted === true && ack.requestId === b.requestId
            && JSON.stringify(Object.keys(ack).sort()) === JSON.stringify(['accepted', 'ok', 'requestId']));
          error = acknowledged ? 'none' : 'ack_mismatch';
        }
      } catch (_) { error = 'ack_read_exception'; }
      trace(stage, acknowledged ? 'validated' : 'rejected', status);
    }
    // Timing/status only. Never retain the body, signature or other credentials.
    try {
      console.log('M1_TEST_CALLBACK_DELIVERY ' + JSON.stringify({ requestId: b.requestId, status: status, elapsedMs: Date.now() - sentAt }));
      if (lateTest) PropertiesService.getScriptProperties().setProperty('M1_TEST_CALLBACK_FAULT_RECEIPT', JSON.stringify({ requestId: b.requestId, expired: Date.now() >= b.expiresAt, status: status, elapsedMs: Date.now() - sentAt }));
    } catch (_) {}
  } catch (_) { trace(stage, 'failed'); trace('google.request', 'failed'); try { console.warn('M1_TEST_CALLBACK_UNAVAILABLE'); } catch (_) {} }
  finally { try { receipt.finish(stage, error, status, acknowledged); } catch (_) {} }
  // Deliberately unusable ContentService result for this proof action only.
  return jsonResult_({ ok: false, code: 'CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE' });
}
