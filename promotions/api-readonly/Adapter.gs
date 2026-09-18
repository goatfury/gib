// Isolated TEST API executable. No ContentService, web app, or business writes.
function readPromotions(envelope) {
  let bridge;
  try { bridge = verifiedReadOnlyBridge_(envelope); }
  catch (_) { return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authorized tablet access is required.', retryable: false } }; }
  return { bridge: bridge.mode, target: 'test', installation: 'rev', requestNonce: bridge.nonce, result: readOnlyPromotionRequest_(bridge) };
}

function verifiedReadOnlyBridge_(envelope) {
  authenticatedPromotionOwner_();
  if (JSON.stringify(envelope).length > 65536) failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  exactPromotionFields_(envelope, ['payload', 'signature']);
  const payload = envelope.payload;
  exactPromotionFields_(payload, ['version', 'mode', 'target', 'installation', 'origin', 'issuedAt', 'nonce', 'deviceIdentity', 'request']);
  const properties = PropertiesService.getScriptProperties();
  const secret = String(properties.getProperty('TEST_BRIDGE_SECRET') || '');
  const origin = String(properties.getProperty('TEST_BRIDGE_ORIGIN') || '');
  const mode = 'm1-authorized-tablet-test-v1';
  if (properties.getProperty('TEST_BRIDGE_MODE') !== mode || properties.getProperty('TEST_BRIDGE_INSTALLATION') !== 'rev'
    || !/^https:\/\/(?:deploy-preview-[0-9]+|[0-9a-f]{24})--gib-live\.netlify\.app$/.test(origin)
    || secret.length < 32 || secret.length > 512 || secret !== secret.trim()) failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  const now = Math.floor(Date.now() / 1000);
  if (payload.version !== 1 || payload.mode !== mode || payload.target !== 'test' || payload.installation !== 'rev'
    || payload.origin !== origin || !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt > now + 30 || payload.issuedAt < now - 120
    || !/^[0-9a-f]{32}$/.test(payload.nonce || '') || !/^m1-test-device-[0-9a-f]{24}$/.test(payload.deviceIdentity || '')
    || !/^[0-9a-f]{64}$/.test(envelope.signature || '')) failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  const signature = Utilities.computeHmacSha256Signature('gib-promotions-test-bridge:v1\n' + canonicalPromotionJson_(payload), secret, Utilities.Charset.UTF_8)
    .map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
  let difference = 0;
  for (let index = 0; index < signature.length; index += 1) difference |= signature.charCodeAt(index) ^ envelope.signature.charCodeAt(index);
  if (difference) failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  return payload;
}

function readOnlyPromotionRequest_(bridge) {
  let lock;
  let locked = false;
  try {
    const request = bridge.request;
    if (!plainPromotionObject_(request) || !['bootstrap', 'readStudent'].includes(request.operation)) failPromotion_('VALIDATION', 'This read-only TEST API supports only bootstrap and readStudent.');
    exactPromotionFields_(request, request.operation === 'bootstrap' ? ['operation'] : ['operation', 'studentId']);
    if (request.operation === 'readStudent') promotionId_(request.studentId);
    lock = LockService.getScriptLock();
    locked = lock.tryLock(10000);
    if (!locked) failPromotion_('BUSY', 'Another save is finishing. Please retry this same request.', true);
    const cache = CacheService.getScriptCache();
    const key = 'promotions-bridge:' + bridge.nonce;
    if (cache.get(key)) failPromotion_('UNAUTHORIZED', 'This tablet request has already been used.');
    cache.put(key, 'used', 180);
    const workbook = verifiedReadOnlyWorkbook_();
    const state = readPromotionHistory_(workbook);
    if (request.operation === 'bootstrap') return promotionSuccess_({
      todayNY: promotionToday_(), recorderLabel: 'Authorized TEST tablet', testOnly: true,
      approvers: PROMOTION_APPROVERS_.map(item => ({ ...item })), students: Array.from(state.students.values())
    });
    const student = requirePromotionStudent_(state, request.studentId);
    return promotionSuccess_({ student, history: state.events.filter(event => event.studentId === student.studentId) });
  } catch (error) {
    return { ok: false, error: { code: error && error.promotionCode || 'UNAVAILABLE',
      message: error && error.promotionCode ? error.message : 'The connection could not confirm this request. Keep the input and check or retry the same request.',
      retryable: error && error.promotionCode ? error.promotionRetryable === true : true } };
  } finally { if (locked) lock.releaseLock(); }
}

function verifiedReadOnlyWorkbook_() {
  const id = PropertiesService.getScriptProperties().getProperty('TEST_WORKBOOK_ID');
  if (!id || typeof id !== 'string' || id !== id.trim()) failPromotion_('TEST_DESTINATION_INVALID', 'The promotion destination is not configured.');
  const workbook = SpreadsheetApp.openById(id);
  if (workbook.getId() !== id || workbook.getName() !== PROMOTION_TEST_TITLE_ || workbook.getSpreadsheetTimeZone() !== PROMOTION_TIME_ZONE_) failPromotion_('TEST_DESTINATION_INVALID', 'The configured destination could not be verified.');
  for (const title of ['Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student']) {
    if (!workbook.getSheetByName(title)) failPromotion_('TEST_DESTINATION_INVALID', 'The promotion legacy views are incomplete.');
  }
  requirePromotionSheet_(workbook, 'Students', STUDENT_HEADERS_);
  requirePromotionSheet_(workbook, 'Promotion History', PROMOTION_HISTORY_HEADERS_);
  return workbook;
}

// Configuration-only setup, explicitly separate from business operations.
// Owner/workbook/origin must already be pinned privately in the new script.
function configureTestReader(config) {
  authenticatedPromotionOwner_();
  exactPromotionFields_(config, ['TEST_OWNER_EMAIL', 'TEST_WORKBOOK_ID', 'TEST_BRIDGE_ORIGIN', 'TEST_BRIDGE_SECRET', 'TEST_BRIDGE_MODE', 'TEST_BRIDGE_INSTALLATION']);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) failPromotion_('BUSY', 'TEST reader configuration is busy.', true);
  try {
    const properties = PropertiesService.getScriptProperties();
    for (const name of ['TEST_OWNER_EMAIL', 'TEST_WORKBOOK_ID', 'TEST_BRIDGE_ORIGIN']) {
      if (!properties.getProperty(name) || config[name] !== properties.getProperty(name)) failPromotion_('UNAUTHORIZED', 'TEST reader configuration does not match its approved pins.');
    }
    if (config.TEST_BRIDGE_ORIGIN !== 'https://deploy-preview-86--gib-live.netlify.app'
      || config.TEST_BRIDGE_MODE !== 'm1-authorized-tablet-test-v1' || config.TEST_BRIDGE_INSTALLATION !== 'rev'
      || typeof config.TEST_BRIDGE_SECRET !== 'string' || config.TEST_BRIDGE_SECRET.length < 32 || config.TEST_BRIDGE_SECRET.length > 512
      || config.TEST_BRIDGE_SECRET !== config.TEST_BRIDGE_SECRET.trim()) failPromotion_('VALIDATION', 'Invalid TEST reader configuration.');
    const values = { TEST_BRIDGE_SECRET: config.TEST_BRIDGE_SECRET, TEST_BRIDGE_MODE: config.TEST_BRIDGE_MODE, TEST_BRIDGE_INSTALLATION: config.TEST_BRIDGE_INSTALLATION };
    let complete = true;
    for (const name of Object.keys(values)) {
      const current = properties.getProperty(name);
      if (current && current !== values[name]) failPromotion_('UNAUTHORIZED', 'An existing TEST reader configuration cannot be replaced.');
      if (!current) complete = false;
    }
    verifiedReadOnlyWorkbook_();
    if (!complete) properties.setProperties(values);
    return { ok: true, status: complete ? 'already_configured' : 'configured' };
  } finally { lock.releaseLock(); }
}
