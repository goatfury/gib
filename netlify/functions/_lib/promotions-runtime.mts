import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PRODUCTION_DEVICE_COOKIE, PRODUCTION_ORIGIN, createProductionDeviceCredential, validProductionDeviceCredential } from './m1-production-runtime.mjs';

export const PROMOTIONS_PATH = '/api/m1-promotions';
export const PROMOTIONS_INSTALL_PATH = '/api/m1-promotions-install';
export const PROMOTIONS_BRIDGE_MODE = 'm1-authorized-tablet-test-v1';
export const PROMOTIONS_LIVE_BRIDGE_MODE = 'm1-authorized-tablet-live-v1';
export const PROMOTIONS_BRIDGE_DOMAIN = 'gib-promotions-test-bridge:v1\n';
export const PROMOTIONS_LIVE_BRIDGE_DOMAIN = 'gib-promotions-live-bridge:v1\n';
export const PROMOTIONS_DEVICE_COOKIE = '__Host-gib_m1_promotions_test_device';
export const PROMOTIONS_PENDING_COOKIE = '__Host-gib_m1_promotions_test_pending';
export const PROMOTIONS_INSTALL_STORE = 'gib-m1-promotions-test-installer-v1';
export const PROMOTIONS_ENV_KEYS = [
  'GIB_PROMOTIONS_TEST_ENABLED', 'GIB_PROMOTIONS_TEST_INSTALLATION', 'GIB_PROMOTIONS_TEST_ORIGIN',
  'GIB_PROMOTIONS_TEST_SITE_ID', 'GIB_PROMOTIONS_TEST_WEBHOOK_URL', 'GIB_PROMOTIONS_TEST_BRIDGE_SECRET',
  'GIB_PROMOTIONS_TEST_DEVICE_SECRET', 'GIB_PROMOTIONS_TEST_INSTALL_SECRET', 'GIB_PROMOTIONS_TEST_INSTALL_RUN_ID',
  'GIB_PROMOTIONS_LIVE_ENABLED', 'GIB_PROMOTIONS_LIVE_INSTALLATION', 'GIB_PROMOTIONS_LIVE_SITE_ID',
  'GIB_PROMOTIONS_LIVE_WEBHOOK_URL', 'GIB_PROMOTIONS_LIVE_BRIDGE_SECRET', 'GIB_M1_PRODUCTION_DEVICE_TOKEN'
];
const TEST_ORIGIN = /^https:\/\/(?:deploy-preview-[0-9]+|[0-9a-f]{24})--gib-live\.netlify\.app$/u;
const APPROVAL_DOMAIN = 'gib-promotions-test-install:v1\n';
const PENDING_DOMAIN = 'gib-promotions-test-pending:v1\n';
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const CODE_PATTERN = /^[0-9A-F]{10}$/u;

export function canonicalPromotionsJson(value) {
  const ordered = input => input && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input).sort().reduce((result, key) => { result[key] = ordered(input[key]); return result; }, {}) : input;
  return JSON.stringify(ordered(value));
}
export const promotionsHash = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
const exact = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const secret = value => typeof value === 'string' && value.length >= 32 && value.length <= 512
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
const sign = (key, domain, value, encoding = 'base64url') => createHmac('sha256', key).update(domain, 'utf8').update(value, 'utf8').digest(encoding);
const equal = (left, right) => timingSafeEqual(Buffer.from(promotionsHash(left), 'hex'), Buffer.from(promotionsHash(right), 'hex'));

function promotionsWebhook(value) {
  let webhook;
  try { webhook = new URL(value); } catch { return ''; }
  return webhook.protocol === 'https:' && webhook.hostname === 'script.google.com' && !webhook.port && !webhook.username
    && !webhook.password && !webhook.search && !webhook.hash && /^\/macros\/s\/[A-Za-z0-9_-]{12,512}\/exec$/u.test(webhook.pathname)
    ? webhook.href : '';
}

function separateSecretScopes(primary, other = []) {
  return new Set(primary).size === primary.length && !primary.some(value => other.includes(value));
}

function promotionTarget(config, target) {
  return Boolean(config) && config.target === target && config.installation === 'rev'
    && (target === 'live'
      ? config.origin === PRODUCTION_ORIGIN && config.mode === PROMOTIONS_LIVE_BRIDGE_MODE && config.signatureDomain === PROMOTIONS_LIVE_BRIDGE_DOMAIN
      : target === 'test' && TEST_ORIGIN.test(config.origin) && config.mode === PROMOTIONS_BRIDGE_MODE && config.signatureDomain === PROMOTIONS_BRIDGE_DOMAIN);
}

export function promotionsRuntimeConfig(env, { siteId, installationId, requestOrigin } = {}) {
  if (requestOrigin === PRODUCTION_ORIGIN) {
    if (!env || env.GIB_PROMOTIONS_LIVE_ENABLED !== 'true' || env.GIB_PROMOTIONS_LIVE_INSTALLATION !== 'rev'
      || installationId !== 'rev' || typeof siteId !== 'string' || !siteId || env.GIB_PROMOTIONS_LIVE_SITE_ID !== siteId) return null;
    const webhookUrl = promotionsWebhook(env.GIB_PROMOTIONS_LIVE_WEBHOOK_URL);
    const bridgeSecret = secret(env.GIB_PROMOTIONS_LIVE_BRIDGE_SECRET);
    const deviceSecret = secret(env.GIB_M1_PRODUCTION_DEVICE_TOKEN);
    if (!webhookUrl || !bridgeSecret || !deviceSecret || !separateSecretScopes([
      bridgeSecret, deviceSecret
    ], [env.GIB_PROMOTIONS_TEST_BRIDGE_SECRET,
      env.GIB_PROMOTIONS_TEST_DEVICE_SECRET, env.GIB_PROMOTIONS_TEST_INSTALL_SECRET
    ])) return null;
    return Object.freeze({ target: 'live', mode: PROMOTIONS_LIVE_BRIDGE_MODE, signatureDomain: PROMOTIONS_LIVE_BRIDGE_DOMAIN,
      origin: PRODUCTION_ORIGIN, installation: 'rev', siteId, webhookUrl, bridgeSecret, deviceSecret });
  }
  // Existing TEST setup callers may omit the origin; live callers never can.
  if (requestOrigin !== undefined && requestOrigin !== env?.GIB_PROMOTIONS_TEST_ORIGIN) return null;
  if (!env || env.GIB_PROMOTIONS_TEST_ENABLED !== 'true' || env.GIB_PROMOTIONS_TEST_INSTALLATION !== 'rev'
    || installationId !== 'rev' || !siteId || env.GIB_PROMOTIONS_TEST_SITE_ID !== siteId
    || !TEST_ORIGIN.test(env.GIB_PROMOTIONS_TEST_ORIGIN || '')) return null;
  const webhookUrl = promotionsWebhook(env.GIB_PROMOTIONS_TEST_WEBHOOK_URL);
  const bridgeSecret = secret(env.GIB_PROMOTIONS_TEST_BRIDGE_SECRET);
  const deviceSecret = secret(env.GIB_PROMOTIONS_TEST_DEVICE_SECRET);
  const installSecret = secret(env.GIB_PROMOTIONS_TEST_INSTALL_SECRET);
  const runId = env.GIB_PROMOTIONS_TEST_INSTALL_RUN_ID;
  if (!webhookUrl || !bridgeSecret || !deviceSecret || !installSecret || !separateSecretScopes([
    bridgeSecret, deviceSecret, installSecret
  ], [env.GIB_PROMOTIONS_LIVE_BRIDGE_SECRET, env.GIB_M1_PRODUCTION_DEVICE_TOKEN
  ])
    || typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(runId)) return null;
  return Object.freeze({ target: 'test', mode: PROMOTIONS_BRIDGE_MODE, signatureDomain: PROMOTIONS_BRIDGE_DOMAIN,
    origin: env.GIB_PROMOTIONS_TEST_ORIGIN, installation: 'rev', siteId,
    webhookUrl, bridgeSecret, deviceSecret, installSecret, runId });
}

export function validPromotionsRequest(request, config) {
  let url;
  try { url = new URL(request.url); } catch { return false; }
  const allowedPath = promotionTarget(config, 'live') ? url.pathname === PROMOTIONS_PATH
    : promotionTarget(config, 'test') && [PROMOTIONS_PATH, PROMOTIONS_INSTALL_PATH].includes(url.pathname);
  return Boolean(allowedPath) && request.method === 'POST' && url.origin === config.origin && !url.search && !url.hash
    && !url.username && !url.password && !url.port && request.headers.get('host')?.toLowerCase() === url.host.toLowerCase()
    && request.headers.get('origin') === config.origin && request.headers.get('sec-fetch-site') === 'same-origin'
    && /^application\/json(?:;|$)/iu.test(request.headers.get('content-type') || '');
}

export function promotionsDeviceCredential(request, config, now = Date.now()) {
  const name = promotionTarget(config, 'live') ? PRODUCTION_DEVICE_COOKIE
    : promotionTarget(config, 'test') ? PROMOTIONS_DEVICE_COOKIE : '';
  if (!name) return '';
  const value = singleCookieValue(request, name);
  return validProductionDeviceCredential(value, config.deviceSecret, now) ? value : '';
}

function singleCookieValue(request, name) {
  const matches = (request.headers.get('cookie') || '').split(';').map(value => value.trim())
    .filter(value => value.slice(0, value.indexOf('=')) === name);
  if (matches.length !== 1) return '';
  try { return decodeURIComponent(matches[0].slice(name.length + 1)); } catch { return ''; }
}

function cookieHeader(name, value, seconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Strict`;
}
export function promotionsDeviceCookieHeader(credential) {
  return cookieHeader(PROMOTIONS_DEVICE_COOKIE, credential, 400 * 24 * 60 * 60);
}
export const clearPromotionsPendingCookieHeader = () => cookieHeader(PROMOTIONS_PENDING_COOKIE, '', 0);

export function createPromotionsEnvelope(config, credential, request, now = Date.now(), random = randomBytes) {
  if (!promotionTarget(config, 'test') && !promotionTarget(config, 'live')) throw new Error('Invalid promotions target.');
  const payload = {
    version: 1, mode: config.mode, target: config.target, installation: 'rev', origin: config.origin,
    issuedAt: Math.floor(now / 1000), nonce: Buffer.from(random(16)).toString('hex'),
    deviceIdentity: `m1-${config.target}-device-${promotionsHash(credential).slice(0, 24)}`, request
  };
  return { payload, signature: sign(config.bridgeSecret, config.signatureDomain, canonicalPromotionsJson(payload), 'hex') };
}

function signedToken(payload, key, domain) {
  const encoded = Buffer.from(canonicalPromotionsJson(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(key, domain, encoded)}`;
}
function readSignedToken(token, key, domain) {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  const [encoded, signature] = token.split('.');
  if (!equal(signature, sign(key, domain, encoded))) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch { return null; }
}

export function createPromotionsInstallCapability(config, options = {}) {
  if (!promotionTarget(config, 'test')) throw new Error('Tablet installation is available only for TEST.');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1, purpose: 'promotions-test-tablet-approval', origin: config.origin, installation: 'rev', runId: config.runId,
    issuedAt: options.issuedAt ?? now, expiresAt: options.expiresAt ?? now + 600,
    nonce: options.nonce || randomBytes(16).toString('hex'), pairingCode: options.pairingCode
  };
  if (!validCapabilityPayload(payload, config, payload.issuedAt)) throw new Error('Invalid TEST tablet approval capability.');
  return signedToken(payload, config.installSecret, APPROVAL_DOMAIN);
}
function validCapabilityPayload(payload, config, now) {
  return exact(payload, ['version', 'purpose', 'origin', 'installation', 'runId', 'issuedAt', 'expiresAt', 'nonce', 'pairingCode'])
    && payload.version === 1 && payload.purpose === 'promotions-test-tablet-approval' && payload.origin === config.origin
    && payload.installation === 'rev' && payload.runId === config.runId && NONCE_PATTERN.test(payload.nonce)
    && CODE_PATTERN.test(payload.pairingCode) && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
    && payload.expiresAt > payload.issuedAt && payload.expiresAt - payload.issuedAt <= 600
    && payload.issuedAt <= now + 30 && payload.expiresAt > now;
}
export function readPromotionsInstallCapability(token, config, now = Date.now()) {
  if (!promotionTarget(config, 'test')) return null;
  const payload = readSignedToken(token, config.installSecret, APPROVAL_DOMAIN);
  return payload && validCapabilityPayload(payload, config, Math.floor(now / 1000)) ? payload : null;
}

function pendingCookie(payload, config) { return signedToken(payload, config.installSecret, PENDING_DOMAIN); }
function readPendingCookie(request, config, now) {
  const token = singleCookieValue(request, PROMOTIONS_PENDING_COOKIE);
  const payload = readSignedToken(token, config.installSecret, PENDING_DOMAIN);
  return exact(payload, ['version', 'origin', 'pairingCode', 'nonce', 'expiresAt']) && payload.version === 1
    && payload.origin === config.origin && CODE_PATTERN.test(payload.pairingCode) && NONCE_PATTERN.test(payload.nonce)
    && Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > Math.floor(now / 1000)
    ? { ...payload, token } : null;
}
function pendingKey(code) { return `rev/test/pending/${code}`; }
async function getRecord(store, code, config) {
  const found = await store.getWithMetadata(pendingKey(code), { type: 'json', consistency: 'strong' });
  if (!found) return null;
  const value = typeof found.data === 'string' ? JSON.parse(found.data) : found.data;
  if (!found.etag || !exact(value, ['version', 'origin', 'pairingCode', 'requestHash', 'expiresAt', 'status', 'deliveryNonce', 'credentialIssuedAt'])
    || value.version !== 1 || value.origin !== config.origin || value.pairingCode !== code
    || !/^[0-9a-f]{64}$/u.test(value.requestHash) || !Number.isSafeInteger(value.expiresAt)
    || !['pending', 'approved', 'consumed'].includes(value.status)
    || (value.status === 'pending' ? value.deliveryNonce !== '' || value.credentialIssuedAt !== 0
      : !/^[A-Za-z0-9_-]{43}$/u.test(value.deliveryNonce) || !Number.isSafeInteger(value.credentialIssuedAt) || value.credentialIssuedAt <= 0)) {
    throw new Error('Invalid TEST authorization state.');
  }
  return { value, etag: found.etag };
}

export async function handlePromotionsInstall(request, input, config, dependencies = {}) {
  if (!promotionTarget(config, 'test')) return {
    status: 403, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Tablet installation is available only for TEST.', retryable: false } }, cookies: []
  };
  const now = dependencies.now ?? Date.now();
  const random = dependencies.randomBytes || randomBytes;
  const store = dependencies.store || await defaultPromotionsInstallStore();
  if (exact(input, ['operation']) && ['start', 'poll'].includes(input.operation)) {
    const existingCredential = promotionsDeviceCredential(request, config, now);
    if (existingCredential) return { status: 200, body: { ok: true, installed: true }, cookies: [] };
    let pending = readPendingCookie(request, config, now);
    if (input.operation === 'start' && !pending) {
      const payload = { version: 1, origin: config.origin, pairingCode: Buffer.from(random(5)).toString('hex').toUpperCase(),
        nonce: Buffer.from(random(16)).toString('hex'), expiresAt: Math.floor(now / 1000) + 600 };
      const token = pendingCookie(payload, config);
      const saved = await store.set(pendingKey(payload.pairingCode), JSON.stringify({
        version: 1, origin: config.origin, pairingCode: payload.pairingCode, requestHash: promotionsHash(token),
        expiresAt: payload.expiresAt, status: 'pending', deliveryNonce: '', credentialIssuedAt: 0
      }), { onlyIfNew: true });
      if (saved?.modified !== true) throw new Error('TEST pairing was not created.');
      return { status: 200, body: { ok: true, result: 'pending', pairingCode: payload.pairingCode, expiresAt: payload.expiresAt },
        cookies: [cookieHeader(PROMOTIONS_PENDING_COOKIE, token, 600)] };
    }
    if (!pending) return { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Start TEST tablet authorization again.', retryable: false } }, cookies: [] };
    const stored = await getRecord(store, pending.pairingCode, config);
    if (!stored || stored.value.requestHash !== promotionsHash(pending.token) || stored.value.expiresAt !== pending.expiresAt) {
      return { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'TEST tablet authorization was not found.', retryable: false } }, cookies: [] };
    }
    if (stored.value.status === 'pending') return { status: 200, body: { ok: true, result: 'pending', pairingCode: pending.pairingCode, expiresAt: pending.expiresAt }, cookies: [] };
    const credential = createProductionDeviceCredential(config.deviceSecret,
      () => Buffer.from(stored.value.deliveryNonce, 'base64url'), stored.value.credentialIssuedAt * 1000);
    if (stored.value.status === 'approved') {
      const saved = await store.set(pendingKey(pending.pairingCode), JSON.stringify({ ...stored.value, status: 'consumed' }), { onlyIfMatch: stored.etag });
      if (saved?.modified !== true) throw new Error('TEST authorization delivery is being reconciled.');
    }
    return { status: 200, body: { ok: true, installed: true }, cookies: [promotionsDeviceCookieHeader(credential), clearPromotionsPendingCookieHeader()] };
  }
  if (!exact(input, ['operation', 'capability']) || input.operation !== 'approve') {
    return { status: 400, body: { ok: false, error: { code: 'VALIDATION', message: 'Invalid TEST authorization request.', retryable: false } }, cookies: [] };
  }
  const capability = readPromotionsInstallCapability(input.capability, config, now);
  if (!capability) return { status: 403, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'TEST tablet approval was not accepted.', retryable: false } }, cookies: [] };
  const stored = await getRecord(store, capability.pairingCode, config);
  if (!stored || stored.value.status !== 'pending' || stored.value.expiresAt <= Math.floor(now / 1000)) {
    return { status: 409, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'TEST tablet request has expired or was already approved.', retryable: false } }, cookies: [] };
  }
  const consumed = await store.set(`rev/test/consumed/${promotionsHash(input.capability)}`, JSON.stringify({ consumedAt: Math.floor(now / 1000) }), { onlyIfNew: true });
  if (consumed?.modified !== true) return { status: 403, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'TEST tablet approval has already been used.', retryable: false } }, cookies: [] };
  const approved = { ...stored.value, status: 'approved', deliveryNonce: Buffer.from(random(32)).toString('base64url'), credentialIssuedAt: Math.floor(now / 1000) };
  const saved = await store.set(pendingKey(capability.pairingCode), JSON.stringify(approved), { onlyIfMatch: stored.etag });
  if (saved?.modified !== true) throw new Error('TEST approval was not confirmed.');
  return { status: 200, body: { ok: true, result: 'approved', pairingCode: capability.pairingCode }, cookies: [] };
}

async function defaultPromotionsInstallStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: PROMOTIONS_INSTALL_STORE, consistency: 'strong' });
}
