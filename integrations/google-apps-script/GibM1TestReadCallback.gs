/* Revolution TEST only. No callback support for writes or other installations. */
var GIB_M1_TEST_READ_CALLBACK_URL_ = 'https://deploy-preview-89--gib-live.netlify.app/api/m1-test-read-result';
var GIB_M1_TEST_READ_CALLBACK_SCHEMA_ = 'm1-test-read-callback/v1';

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

function gibM1TestReadCallback_(body) {
  try {
    if (!gibM1TestReadCallbackEnabled_() || body.action !== 'managerReviewReadCallbackProof'
      || requestTarget_(body) !== 'test' || !adminActionAuthorized_(body)
      || body.gym !== 'rev' || body.from !== '2026-09-07' || body.to !== todayNewYork_()
      || GIB_M1_ADMIN_NAMES_.indexOf(body.adminName) < 0) return rejectedAuthResult_();
    var b = body.binding;
    var fields = ['schema', 'requestId', 'target', 'gym', 'action', 'from', 'to', 'createdAt', 'expiresAt'];
    var now = Date.now();
    if (!b || JSON.stringify(Object.keys(b).sort()) !== JSON.stringify(fields.sort())
      || b.schema !== GIB_M1_TEST_READ_CALLBACK_SCHEMA_ || b.target !== 'test' || b.gym !== 'rev'
      || b.action !== 'managerReviewRead' || b.from !== body.from || b.to !== body.to
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.requestId)
      || !Number.isSafeInteger(b.createdAt) || b.createdAt > now || b.expiresAt !== b.createdAt + 60000
      || now >= b.expiresAt) return rejectedAuthResult_();
    // This existing read owns and releases its lock in finally before returning.
    var read = managerReviewAction_({ action: 'managerReviewRead', target: 'test', token: body.token,
      adminActionToken: body.adminActionToken, gym: 'rev', from: body.from, to: body.to, adminName: body.adminName, check: null });
    var result = JSON.parse(read.getContent());
    var readAt = Date.now();
    if (result.ok !== true || result.complete !== true || result.schema !== 'm1-manager-review/v1'
      || result.gym !== 'rev' || result.from !== b.from || result.to !== b.to || readAt >= b.expiresAt) throw new Error('Read unavailable.');
    var raw = JSON.stringify({ binding: b, readAt: readAt, result: result });
    if (Utilities.newBlob(raw).getBytes().length > 256000) throw new Error('Callback too large.');
    var signature = Utilities.computeHmacSha256Signature(GIB_M1_TEST_READ_CALLBACK_SCHEMA_ + '\n' + raw, body.adminActionToken, Utilities.Charset.UTF_8)
      .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
    var sentAt = Date.now();
    var remaining = Math.floor((b.expiresAt - sentAt) / 1000);
    if (remaining < 1) throw new Error('Read expired.');
    var response = UrlFetchApp.fetch(GIB_M1_TEST_READ_CALLBACK_URL_, {
      method: 'post', contentType: 'application/json', payload: raw,
      headers: { 'X-GIB-M1-Read-Signature': signature },
      followRedirects: false, validateHttpsCertificates: true, muteHttpExceptions: true,
      timeoutSeconds: Math.min(10, remaining)
    });
    // Timing/status only. Never log the body, signature or other credentials.
    console.log('M1_TEST_CALLBACK_DELIVERY ' + JSON.stringify({ requestId: b.requestId,
      status: response.getResponseCode(), elapsedMs: Date.now() - sentAt }));
  } catch (_) { console.warn('M1_TEST_CALLBACK_UNAVAILABLE'); }
  // Deliberately unusable ContentService result for this proof action only.
  return jsonResult_({ ok: false, code: 'CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE' });
}
