import {
  createHash,
  createHmac,
  timingSafeEqual
} from 'node:crypto';

export const ADMIN_NAMES = Object.freeze(['Andrew Smith', 'Stuart Turner']);
export const ADMIN_COOKIE = 'gib_m1_admin_session';
export const ADMIN_SESSION_SECONDS = 30 * 60;
export const TIME_ZONE = 'America/New_York';

export function clean(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalize(value) {
  return clean(value)
    .toLocaleLowerCase('en-US')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—―−]/g, '-');
}

export function isDeployPreview(env = process.env, requestUrl = '') {
  if (clean(env.CONTEXT) === 'deploy-preview') return true;
  try {
    const url = new URL(requestUrl);
    return url.protocol === 'https:'
      && /^deploy-preview-\d+--gib-live\.netlify\.app$/i.test(url.hostname);
  } catch {
    return false;
  }
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

export function runtimeConfig(env = process.env, options = {}) {
  const preview = isDeployPreview(env, options.requestUrl);
  const webhookUrl = validGoogleWebhook(
    preview ? env.GIB_TEST_WEBHOOK_URL : env.GIB_M1_WEBHOOK_URL
  );
  const webhookToken = clean(
    preview ? env.GIB_TEST_WEBHOOK_TOKEN : env.GIB_M1_WEBHOOK_TOKEN
  );
  const adminPassphrase = clean(env.GIB_M1_ADMIN_PASSPHRASE);

  if (!webhookUrl || webhookToken.length < 12 || webhookToken.length > 512) {
    return null;
  }
  if (!preview && options.admin === true && !adminPassphrase) {
    return null;
  }

  return Object.freeze({
    preview,
    webhookUrl,
    webhookToken,
    adminPassphrase,
    sessionSecret: preview ? webhookToken : adminPassphrase
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
    response = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        token: config.webhookToken,
        action,
        ...data
      }),
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    return { readable: false, status: 0 };
  }

  let text;
  try {
    text = (await response.text()).trim();
  } catch {
    return { readable: false, status: response.status };
  }
  if (!response.ok || !text || text.length > 256_000 || /<(?:!doctype|html|body)\b/i.test(text)) {
    return { readable: false, status: response.status };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { readable: false, status: response.status };
    }
    return { readable: true, status: response.status, value };
  } catch {
    return { readable: false, status: response.status };
  }
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

export function createAdminSession(adminName, secret, now = Date.now()) {
  if (!ADMIN_NAMES.includes(adminName) || !clean(secret)) {
    throw new Error('Invalid admin session input.');
  }
  const payload = base64UrlJson({
    v: 1,
    n: adminName,
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
    || payload.v !== 1
    || !ADMIN_NAMES.includes(payload.n)
    || !Number.isInteger(payload.exp)
    || payload.exp <= Math.floor(now / 1000)
  ) {
    return null;
  }
  return Object.freeze({ adminName: payload.n, expiresAt: payload.exp });
}

export function cookieValue(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
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
  return { session };
}

export function constantTimeEqual(left, right) {
  const leftHash = createHash('sha256').update(clean(left), 'utf8').digest();
  const rightHash = createHash('sha256').update(clean(right), 'utf8').digest();
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

export function sanitizeKioskRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50) return null;
  const cleaned = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const value = {
      RowID: safeText(row.RowID || row.rowId, 240),
      Timestamp: safeText(row.Timestamp || row.timestamp, 80),
      Date: clean(row.Date || row.date).slice(0, 10),
      'Class Label': safeText(row['Class Label'] || row.classLabel, 200),
      'Duration (hr)': Number(row['Duration (hr)'] ?? row.duration),
      Instructor: safeText(row.Instructor || row.instructor, 100),
      Site: safeText(row.Site || row.site, 80),
      Device: clean(row.Device || row.device).slice(0, 120),
      Build: clean(row.Build || row.build).slice(0, 120),
      Notes: clean(row.Notes || row.notes).slice(0, 400)
    };
    if (
      !value.RowID
      || !validNonFutureDate(value.Date)
      || !value['Class Label']
      || !Number.isFinite(value['Duration (hr)'])
      || value['Duration (hr)'] <= 0
      || value['Duration (hr)'] > 8
      || !value.Instructor
      || !value.Site
      || /^[=+\-@]/.test(value.Notes)
    ) {
      return null;
    }
    cleaned.push(value);
  }
  return cleaned;
}
