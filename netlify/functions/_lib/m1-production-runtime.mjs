import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { remoteBackendEnabled } from './m1-installation.mjs';

export const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';
export const PRODUCTION_HOST = 'gib-live.netlify.app';
export const PRODUCTION_DEVICE_COOKIE = '__Host-gib_m1_production_device';
export const PRODUCTION_INSTALL_PURPOSE = 'production-tablet-install';
export const PRODUCTION_INSTALL_SIGNATURE_DOMAIN = 'gib-m1-production-install:v1\0';
export const PRODUCTION_INSTALL_MAX_SECONDS = 36_000;
export const PRODUCTION_INSTALL_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;
export const PRODUCTION_INSTALL_STORE = 'gib-m1-production-installer';

const DEVICE_COOKIE_SIGNATURE_DOMAIN = 'gib-m1-production-device:v1\0';
const DEVICE_COOKIE_PATTERN = /^v1\.[A-Za-z0-9_-]{43}\.[1-9][0-9]{8,11}\.[A-Za-z0-9_-]{43}$/u;
const GOOGLE_WEBHOOK_PATH_PATTERN = /^\/macros\/s\/[A-Za-z0-9_-]{12,512}\/exec$/u;
const INSTALL_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function exactString(value) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value !== value.normalize('NFKC')
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) return '';
  return value;
}

function validSecret(value) {
  const secret = exactString(value);
  return secret.length >= 32 && secret.length <= 512 ? secret : '';
}

function validGoogleWebhook(value) {
  const source = exactString(value);
  let url;
  try {
    url = new URL(source);
  } catch {
    return '';
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'script.google.com'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !GOOGLE_WEBHOOK_PATH_PATTERN.test(url.pathname)
  ) return '';
  return url.toString();
}

function equalSecret(left, right) {
  const leftHash = createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const rightHash = createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function allDistinct(values) {
  const configured = values.filter(value => typeof value === 'string' && value.length > 0);
  for (let left = 0; left < configured.length; left += 1) {
    for (let right = left + 1; right < configured.length; right += 1) {
      if (equalSecret(configured[left], configured[right])) return false;
    }
  }
  return true;
}

function scopedCredentialValues(env) {
  return [
    env.GIB_TEST_WEBHOOK_TOKEN,
    env.GIB_TEST_ADMIN_ACTION_TOKEN,
    env.GIB_TEST_LEGACY_KIOSK_TOKEN,
    env.GIB_M1_WEBHOOK_TOKEN,
    env.GIB_M1_ADMIN_ACTION_TOKEN,
    env.GIB_M1_ADMIN_PASSPHRASE,
    env.GIB_M1_LEGACY_KIOSK_TOKEN,
    env.GIB_M1_RECOVERY_TOKEN
  ].map(value => String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' '))
    .filter(Boolean);
}

function validBase64Url32(value) {
  if (!BASE64URL_32_PATTERN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
  } catch {
    return false;
  }
}

export function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

export function validExactProductionRequest(request, path) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }

  if (
    url.origin !== PRODUCTION_ORIGIN
    || url.protocol !== 'https:'
    || url.hostname !== PRODUCTION_HOST
    || url.host !== PRODUCTION_HOST
    || url.port
    || url.username
    || url.password
    || url.pathname !== path
    || url.search
    || url.hash
  ) return false;

  const host = request.headers.get('host');
  return typeof host === 'string'
    && host.toLocaleLowerCase('en-US') === PRODUCTION_HOST
    && request.headers.get('origin') === PRODUCTION_ORIGIN
    && request.headers.get('sec-fetch-site') === 'same-origin';
}

export function productionRuntimeConfig(env = process.env) {
  if (!remoteBackendEnabled(env)) return null;
  const origin = exactString(env.GIB_M1_PRODUCTION_ORIGIN);
  const webhookUrl = validGoogleWebhook(env.GIB_M1_PRODUCTION_WEBHOOK_URL);
  const webhookToken = validSecret(env.GIB_M1_PRODUCTION_WEBHOOK_TOKEN);
  const deviceToken = validSecret(env.GIB_M1_PRODUCTION_DEVICE_TOKEN);
  const testWebhookUrl = validGoogleWebhook(env.GIB_TEST_WEBHOOK_URL);
  const legacyWebhookUrl = validGoogleWebhook(env.GIB_M1_WEBHOOK_URL);
  const scopedValues = scopedCredentialValues(env);

  if (
    env.GIB_M1_PRODUCTION_SYNC_ENABLED !== 'true'
    || origin !== PRODUCTION_ORIGIN
    || !webhookUrl
    || !webhookToken
    || !deviceToken
    || (testWebhookUrl && webhookUrl === testWebhookUrl)
    || (legacyWebhookUrl && webhookUrl === legacyWebhookUrl)
    || !allDistinct([webhookToken, deviceToken, ...scopedValues])
  ) return null;

  return Object.freeze({
    origin,
    webhookUrl,
    webhookToken,
    deviceToken,
    target: 'production',
    preview: false,
    adminActionToken: ''
  });
}

export function productionInstallerConfig(env = process.env) {
  const runtime = productionRuntimeConfig(env);
  const installSecret = validSecret(env.GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET);
  const runId = exactString(env.GIB_M1_PRODUCTION_INSTALL_RUN_ID);
  if (
    !runtime
    || !installSecret
    || !INSTALL_RUN_ID_PATTERN.test(runId)
    || !allDistinct([
      runtime.webhookToken,
      runtime.deviceToken,
      installSecret,
      ...scopedCredentialValues(env)
    ])
  ) return null;
  return Object.freeze({ ...runtime, installSecret, runId });
}

function signBase64Url(secret, domain, value) {
  return createHmac('sha256', secret)
    .update(domain, 'utf8')
    .update(value, 'utf8')
    .digest('base64url');
}

function integerSeconds(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return Math.floor(numeric >= 100_000_000_000 ? numeric / 1_000 : numeric);
}

export function createProductionInstallCapability({
  secret,
  runId,
  issuedAt,
  expiresAt,
  nonce
}) {
  const installSecret = validSecret(secret);
  const normalizedRunId = exactString(runId);
  const issuedAtSeconds = integerSeconds(issuedAt);
  const expiresAtSeconds = integerSeconds(expiresAt);
  const normalizedNonce = exactString(nonce);
  if (
    !installSecret
    || !INSTALL_RUN_ID_PATTERN.test(normalizedRunId)
    || !Number.isInteger(issuedAtSeconds)
    || !Number.isInteger(expiresAtSeconds)
    || issuedAtSeconds < 1
    || expiresAtSeconds <= issuedAtSeconds
    || expiresAtSeconds - issuedAtSeconds > PRODUCTION_INSTALL_MAX_SECONDS
    || !validBase64Url32(normalizedNonce)
  ) throw new Error('Invalid production install capability input.');

  const encodedPayload = Buffer.from(JSON.stringify({
    v: 1,
    purpose: PRODUCTION_INSTALL_PURPOSE,
    origin: PRODUCTION_ORIGIN,
    runId: normalizedRunId,
    issuedAt: issuedAtSeconds,
    expiresAt: expiresAtSeconds,
    nonce: normalizedNonce
  }), 'utf8').toString('base64url');
  const signature = signBase64Url(
    installSecret,
    PRODUCTION_INSTALL_SIGNATURE_DOMAIN,
    encodedPayload
  );
  return `${encodedPayload}.${signature}`;
}

export function readProductionInstallCapability(token, config, now = Date.now()) {
  if (
    typeof token !== 'string'
    || token.length > 2_048
    || !PRODUCTION_INSTALL_TOKEN_PATTERN.test(token)
    || !config
    || !validSecret(config.installSecret)
  ) return null;

  const separator = token.indexOf('.');
  const encodedPayload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = signBase64Url(
    config.installSecret,
    PRODUCTION_INSTALL_SIGNATURE_DOMAIN,
    encodedPayload
  );
  if (!equalSecret(suppliedSignature, expectedSignature)) return null;

  let payload;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url');
    if (decoded.toString('base64url') !== encodedPayload) return null;
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }

  const nowSeconds = integerSeconds(now);
  if (
    !exactObjectKeys(payload, [
      'v',
      'purpose',
      'origin',
      'runId',
      'issuedAt',
      'expiresAt',
      'nonce'
    ])
    || payload.v !== 1
    || payload.purpose !== PRODUCTION_INSTALL_PURPOSE
    || payload.origin !== PRODUCTION_ORIGIN
    || payload.runId !== config.runId
    || !INSTALL_RUN_ID_PATTERN.test(payload.runId)
    || !Number.isInteger(payload.issuedAt)
    || !Number.isInteger(payload.expiresAt)
    || payload.issuedAt < 1
    || payload.issuedAt > nowSeconds
    || payload.expiresAt <= nowSeconds
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > PRODUCTION_INSTALL_MAX_SECONDS
    || !validBase64Url32(payload.nonce)
  ) return null;
  return Object.freeze({ ...payload });
}

export function productionInstallConsumptionKey(token) {
  return `production/install/v1/${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

export function createProductionDeviceCredential(
  deviceToken,
  randomBytesImpl = randomBytes,
  now = Date.now()
) {
  const secret = validSecret(deviceToken);
  if (!secret) throw new Error('Invalid production device configuration.');
  const nonceBytes = Buffer.from(randomBytesImpl(32));
  if (nonceBytes.length !== 32) throw new Error('Invalid production device randomness.');
  const nonce = nonceBytes.toString('base64url');
  const issuedAt = integerSeconds(now);
  const unsigned = `v1.${nonce}.${issuedAt}`;
  return `${unsigned}.${signBase64Url(secret, DEVICE_COOKIE_SIGNATURE_DOMAIN, unsigned)}`;
}

export function validProductionDeviceCredential(value, deviceToken, now = Date.now()) {
  const credential = String(value ?? '');
  const secret = validSecret(deviceToken);
  if (!secret || !DEVICE_COOKIE_PATTERN.test(credential)) return false;
  const parts = credential.split('.');
  const issuedAt = Number(parts[2]);
  const nowSeconds = integerSeconds(now);
  if (!Number.isInteger(issuedAt) || issuedAt < 1 || issuedAt > nowSeconds + 300) return false;
  const unsigned = parts.slice(0, 3).join('.');
  return equalSecret(
    parts[3],
    signBase64Url(secret, DEVICE_COOKIE_SIGNATURE_DOMAIN, unsigned)
  );
}

function requestCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

export function productionDeviceAuthorization(request, config, now = Date.now()) {
  if (!config) return Object.freeze({ authorized: false, credential: '' });
  const credential = requestCookie(request, PRODUCTION_DEVICE_COOKIE);
  const authorized = validProductionDeviceCredential(credential, config.deviceToken, now);
  return Object.freeze({ authorized, credential: authorized ? credential : '' });
}

export function productionDeviceCookieHeader(credential) {
  return [
    `${PRODUCTION_DEVICE_COOKIE}=${encodeURIComponent(credential)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

export function clearProductionDeviceCookieHeader() {
  return [
    `${PRODUCTION_DEVICE_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}
