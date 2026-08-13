import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export const ADMIN_NAMES = Object.freeze(['Andrew Smith', 'Stuart Turner']);
export const ADMIN_COOKIE = 'gib_m1_admin_session';
export const ADMIN_REQUEST_HEADER = 'X-GIB-M1-Admin-Request-Token';
export const ADMIN_SESSION_SECONDS = 30 * 60;
export const TIME_ZONE = 'America/New_York';
export const M1_PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';

const M1_DEPLOY_PREVIEW_HOST = /^deploy-preview-\d+--gib-live\.netlify\.app$/i;
const M1_IMMUTABLE_DEPLOY_HOST = /^[0-9a-f]{24}--gib-live\.netlify\.app$/i;

export function clean(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

export function runtimeTarget(requestUrl = '') {
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== 'https:'
      || url.port
      || url.username
      || url.password
    ) return '';
    if (url.origin === M1_PRODUCTION_ORIGIN) return 'production';
    if (
      M1_DEPLOY_PREVIEW_HOST.test(url.hostname)
      || M1_IMMUTABLE_DEPLOY_HOST.test(url.hostname)
    ) return 'test';
    return '';
  } catch {
    return '';
  }
}

export function isDeployPreview(_env = process.env, requestUrl = '') {
  return runtimeTarget(requestUrl) === 'test';
}

export function validAdminPassphrase(value) {
  const raw = String(value == null ? '' : value);
  if (
    raw.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(raw)
  ) {
    return false;
  }
  const text = raw.normalize('NFKC').trim();
  if (text.length < 20 || text.length > 256) return false;
  const words = text.split(/[ -]+/u).filter(Boolean);
  return new Set(words.map(word => word.toLocaleLowerCase('en-US'))).size >= 4;
}

function validGoogleWebhook(value) {
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    return '';
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'script.google.com'
    || !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return '';
  }
  return url.toString();
}

function equalsAnySecret(value, candidates) {
  return Boolean(value) && candidates.some(candidate => (
    Boolean(candidate) && constantTimeSecretEqual(value, candidate)
  ));
}

function configuredSecretsArePairwiseDistinct(values) {
  const configured = values.map(clean).filter(Boolean);
  for (let left = 0; left < configured.length; left += 1) {
    for (let right = left + 1; right < configured.length; right += 1) {
      if (constantTimeSecretEqual(configured[left], configured[right])) return false;
    }
  }
  return true;
}

function derivedPreviewSessionSecret(adminActionToken) {
  return createHmac('sha256', adminActionToken)
    .update('gib-m1-admin-session:test:v1', 'utf8')
    .digest('base64url');
}

export function runtimeConfig(env = process.env, options = {}) {
  const target = runtimeTarget(options.requestUrl);
  if (!target) return null;
  const preview = target === 'test';
  const webhookUrl = validGoogleWebhook(
    preview ? env.GIB_TEST_WEBHOOK_URL : env.GIB_M1_PRODUCTION_WEBHOOK_URL
  );
  const webhookToken = clean(
    preview ? env.GIB_TEST_WEBHOOK_TOKEN : env.GIB_M1_PRODUCTION_WEBHOOK_TOKEN
  );
  const adminActionToken = clean(
    preview ? env.GIB_TEST_ADMIN_ACTION_TOKEN : env.GIB_M1_ADMIN_ACTION_TOKEN
  );
  const adminPassphrase = clean(env.GIB_M1_ADMIN_PASSPHRASE);
  const testWebhookUrl = validGoogleWebhook(env.GIB_TEST_WEBHOOK_URL);
  const productionWebhookUrl = validGoogleWebhook(env.GIB_M1_PRODUCTION_WEBHOOK_URL);
  const legacyWebhookUrl = validGoogleWebhook(env.GIB_M1_WEBHOOK_URL);
  const sensitiveSecrets = [
    env.GIB_TEST_WEBHOOK_TOKEN,
    env.GIB_TEST_ADMIN_ACTION_TOKEN,
    env.GIB_TEST_LEGACY_KIOSK_TOKEN,
    env.GIB_M1_PRODUCTION_WEBHOOK_TOKEN,
    env.GIB_M1_ADMIN_ACTION_TOKEN,
    env.GIB_M1_ADMIN_PASSPHRASE,
    env.GIB_M1_LEGACY_KIOSK_TOKEN,
    env.GIB_M1_WEBHOOK_TOKEN,
    env.GIB_M1_RECOVERY_TOKEN,
    env.GIB_M1_PRODUCTION_DEVICE_TOKEN,
    env.GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET
  ];
  const crossScopeSecrets = (preview
    ? [
      env.GIB_M1_PRODUCTION_WEBHOOK_TOKEN,
      env.GIB_M1_ADMIN_ACTION_TOKEN,
      env.GIB_TEST_LEGACY_KIOSK_TOKEN,
      env.GIB_M1_LEGACY_KIOSK_TOKEN,
      env.GIB_M1_WEBHOOK_TOKEN,
      env.GIB_M1_RECOVERY_TOKEN,
      env.GIB_M1_PRODUCTION_DEVICE_TOKEN,
      env.GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET,
      env.GIB_M1_ADMIN_PASSPHRASE
    ]
    : [
      env.GIB_TEST_WEBHOOK_TOKEN,
      env.GIB_TEST_ADMIN_ACTION_TOKEN,
      env.GIB_TEST_LEGACY_KIOSK_TOKEN,
      env.GIB_M1_LEGACY_KIOSK_TOKEN,
      env.GIB_M1_WEBHOOK_TOKEN,
      env.GIB_M1_RECOVERY_TOKEN,
      env.GIB_M1_PRODUCTION_DEVICE_TOKEN,
      env.GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET
    ]).map(clean).filter(Boolean);

  // Both TEST and the canonical production receiver use scoped server-only
  // transport credentials. Legacy GIB_M1_WEBHOOK_* settings are deliberately
  // not an Admin fallback.
  if (
    !webhookUrl
    || !webhookToken
    || webhookToken.length > 512
    || (preview ? webhookToken.length < 12 : webhookToken.length < 32)
    || (preview && productionWebhookUrl && webhookUrl === productionWebhookUrl)
    || (!preview && testWebhookUrl && webhookUrl === testWebhookUrl)
    || (legacyWebhookUrl && webhookUrl === legacyWebhookUrl)
    || !configuredSecretsArePairwiseDistinct(sensitiveSecrets)
    || equalsAnySecret(webhookToken, crossScopeSecrets)
  ) {
    return null;
  }
  if (!preview && options.admin === true && !validAdminPassphrase(env.GIB_M1_ADMIN_PASSPHRASE)) {
    return null;
  }
  if (
    options.admin === true
    && (
      adminActionToken.length < 32
      || adminActionToken.length > 512
      || constantTimeSecretEqual(webhookToken, adminActionToken)
      || equalsAnySecret(adminActionToken, crossScopeSecrets)
      || (!preview && constantTimeSecretEqual(webhookToken, adminPassphrase))
      || (!preview && constantTimeSecretEqual(adminActionToken, adminPassphrase))
      || (!preview && equalsAnySecret(adminPassphrase, crossScopeSecrets))
    )
  ) {
    return null;
  }
  return Object.freeze({
    target,
    preview,
    webhookUrl,
    webhookToken,
    adminActionToken,
    adminPassphrase: preview ? '' : adminPassphrase,
    sessionSecret: options.admin === true
      ? (preview ? derivedPreviewSessionSecret(adminActionToken) : adminPassphrase)
      : ''
  });
}

export function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders
    }
  });
}

export async function readJson(request, maxBytes = 32_768) {
  if (request.method !== 'POST') {
    return { response: jsonResponse(405, { ok: false, message: 'Method not allowed.' }) };
  }
  const contentType = clean(request.headers.get('content-type'));
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    return { response: jsonResponse(415, { ok: false, message: 'Use JSON for this request.' }) };
  }
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength != null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    return { response: jsonResponse(400, { ok: false, message: 'The submitted data was empty or too large.' }) };
  }
  // Fetch exposes the full body through text(); reject a trustworthy declared
  // oversize before buffering, then retain the byte-length check for chunked or
  // missing-length requests.
  const text = await request.text();
  if (!text || Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { response: jsonResponse(400, { ok: false, message: 'The submitted data was empty or too large.' }) };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('object required');
    }
    return { value };
  } catch {
    return { response: jsonResponse(400, { ok: false, message: 'The submitted data was not valid JSON.' }) };
  }
}

export function nyDate(now = new Date()) {
  const values = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now).forEach(part => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return `${values.year}-${values.month}-${values.day}`;
}

export function validNonFutureDate(value, now = new Date()) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && text <= nyDate(now);
}

export async function postGoogle(config, action, data, fetchImpl = fetch) {
  let response;
  try {
    const body = {
      ...data,
      token: config.webhookToken,
      action,
      target: config.target || (config.preview ? 'test' : 'production')
    };
    // Preserve the proven TEST wire contract (including its empty Admin field)
    // and production Admin actions, while the production kiosk forwards only
    // rows plus its pinned kiosk authentication, action, and target.
    if (config.preview || config.adminActionToken) {
      body.adminActionToken = config.adminActionToken;
    }
    response = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        Accept: 'application/json'
      },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000)
    });
  } catch {
    return { readable: false, status: 0, failureClass: 'UNREACHABLE' };
  }

  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength != null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > 256_000)
  ) {
    return { readable: false, status: response.status, failureClass: 'OVERSIZE' };
  }
  // Apps Script may omit Content-Length. Keep the post-read byte cap as the
  // fail-closed fallback for chunked/missing-length responses.
  let text;
  try {
    text = (await response.text()).trim();
  } catch {
    return { readable: false, status: response.status, failureClass: 'READ_FAILED' };
  }
  if (!response.ok) {
    return { readable: false, status: response.status, failureClass: 'HTTP_FAILURE' };
  }
  if (!text) {
    return { readable: false, status: response.status, failureClass: 'EMPTY' };
  }
  if (Buffer.byteLength(text, 'utf8') > 256_000) {
    return { readable: false, status: response.status, failureClass: 'OVERSIZE' };
  }
  if (/<(?:!doctype|html|body)\b/i.test(text)) {
    return { readable: false, status: response.status, failureClass: 'HTML' };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { readable: false, status: response.status, failureClass: 'UNSUPPORTED_JSON' };
    }
    return { readable: true, status: response.status, value };
  } catch {
    return { readable: false, status: response.status, failureClass: 'MALFORMED_JSON' };
  }
}

export function googleFailureClass(google) {
  if (!google || google.readable !== true) {
    return typeof google?.failureClass === 'string' && google.failureClass
      ? google.failureClass
      : 'UNREADABLE';
  }
  if (!google.value || typeof google.value !== 'object' || Array.isArray(google.value)) {
    return 'UNSUPPORTED_JSON';
  }
  if (google.value.ok !== true) {
    return clean(google.value.result).toLowerCase() === 'rejected'
      ? 'REJECTED'
      : 'FAILED';
  }
  return 'CONTRACT_MISMATCH';
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sessionKey(secret) {
  return createHash('sha256').update(`gib-m1-admin:${secret}`, 'utf8').digest();
}

function signPayload(encodedPayload, secret) {
  return createHmac('sha256', sessionKey(secret))
    .update(encodedPayload, 'utf8')
    .digest('base64url');
}

export function createAdminRequestToken(randomBytesImpl = randomBytes) {
  return Buffer.from(randomBytesImpl(32)).toString('base64url');
}

function validRequestToken(value) {
  const token = String(value == null ? '' : value);
  return token.length >= 32
    && token.length <= 256
    && /^[A-Za-z0-9_-]+$/u.test(token);
}

export function createAdminSession(adminName, secret, now = Date.now(), requestToken = '') {
  if (
    !ADMIN_NAMES.includes(adminName)
    || !clean(secret)
    || !validRequestToken(requestToken)
  ) {
    throw new Error('Invalid admin session input.');
  }
  const payload = base64UrlJson({
    v: 2,
    n: adminName,
    r: requestToken,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ADMIN_SESSION_SECONDS
  });
  return `${payload}.${signPayload(payload, secret)}`;
}

export function readAdminSession(value, secret, now = Date.now()) {
  const parts = clean(value).split('.');
  if (parts.length !== 2 || !clean(secret)) return null;
  const expected = Buffer.from(signPayload(parts[0], secret), 'utf8');
  const actual = Buffer.from(parts[1], 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload
    || payload.v !== 2
    || !ADMIN_NAMES.includes(payload.n)
    || !validRequestToken(payload.r)
    || !Number.isInteger(payload.exp)
    || payload.exp <= Math.floor(now / 1000)
  ) {
    return null;
  }
  return Object.freeze({
    adminName: payload.n,
    expiresAt: payload.exp,
    requestToken: payload.r
  });
}

export function cookieValue(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

export function adminCookieHeader(value) {
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${ADMIN_SESSION_SECONDS}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

export function clearAdminCookieHeader() {
  return [
    `${ADMIN_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

export function requireAdmin(request, config, now = Date.now()) {
  if (!config || !config.sessionSecret) {
    return { response: jsonResponse(503, { ok: false, message: 'Admin service is not configured.' }) };
  }
  const session = readAdminSession(
    cookieValue(request, ADMIN_COOKIE),
    config.sessionSecret,
    now
  );
  if (!session) {
    return { response: jsonResponse(401, { ok: false, message: 'Admin login required.' }) };
  }
  const suppliedRequestToken = request.headers.get(ADMIN_REQUEST_HEADER) || '';
  if (!constantTimeSecretEqual(suppliedRequestToken, session.requestToken)) {
    return {
      response: jsonResponse(403, {
        ok: false,
        message: 'Admin login must be renewed for this page.'
      })
    };
  }
  return { session };
}

export function constantTimeEqual(left, right) {
  const leftHash = createHash('sha256').update(clean(left), 'utf8').digest();
  const rightHash = createHash('sha256').update(clean(right), 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function constantTimeSecretEqual(left, right) {
  const leftHash = createHash('sha256').update(String(left == null ? '' : left), 'utf8').digest();
  const rightHash = createHash('sha256').update(String(right == null ? '' : right), 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function obviousTestValue(value) {
  return /\b(test|fake|demo|qa)\b|do not pay/i.test(clean(value));
}

export function safeText(value, maxLength) {
  const text = clean(value);
  if (!text || text.length > maxLength || /^[=+\-@]/.test(text)) return '';
  return text;
}
