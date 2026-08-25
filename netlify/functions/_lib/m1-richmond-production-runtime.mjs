import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import { runtimeConfig } from './m1-common.mjs';
import { deploymentInstallationProfile } from './m1-installation.mjs';

export const RICHMOND_PRODUCTION_ORIGIN = 'https://gib-richmond-live.netlify.app';
export const RICHMOND_PRODUCTION_HOST = 'gib-richmond-live.netlify.app';
export const RICHMOND_PRODUCTION_DEVICE_COOKIE = '__Host-' + 'gib_m1_richmond_production_device';
export const RICHMOND_PRODUCTION_INSTALL_PURPOSE = 'richmond-production-tablet-install';
export const RICHMOND_PRODUCTION_INSTALL_STORE = 'gib-m1-richmond-production-installer';
export const RICHMOND_PRODUCTION_INSTALL_MAX_SECONDS = 36_000;

const DEVICE_SIGNATURE_DOMAIN = 'gib-m1-richmond-production-device:v1\0';
const INSTALL_SIGNATURE_DOMAIN = 'gib-m1-richmond-production-install:v1\0';
const DEVICE_PATTERN = /^v1\.[A-Za-z0-9_-]{43}\.[1-9][0-9]{8,11}\.[A-Za-z0-9_-]{43}$/u;
const INSTALL_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;
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

function equalSecret(left, right) {
  const leftHash = createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const rightHash = createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
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

function integerSeconds(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return Math.floor(numeric >= 100_000_000_000 ? numeric / 1_000 : numeric);
}

function signature(secret, domain, value) {
  return createHmac('sha256', secret)
    .update(domain, 'utf8')
    .update(value, 'utf8')
    .digest('base64url');
}

export function validExactRichmondProductionRequest(request, path) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (
    url.origin !== RICHMOND_PRODUCTION_ORIGIN
    || url.protocol !== 'https:'
    || url.hostname !== RICHMOND_PRODUCTION_HOST
    || url.host !== RICHMOND_PRODUCTION_HOST
    || url.port || url.username || url.password
    || url.pathname !== path || url.search || url.hash
  ) return false;
  const host = request.headers.get('host');
  return typeof host === 'string'
    && host.toLocaleLowerCase('en-US') === RICHMOND_PRODUCTION_HOST
    && request.headers.get('origin') === RICHMOND_PRODUCTION_ORIGIN
    && request.headers.get('sec-fetch-site') === 'same-origin';
}

export function richmondProductionRuntimeConfig(env, requestUrl, options = {}) {
  const config = runtimeConfig(env, {
    ...options,
    requestUrl,
    installationId: options.installationId,
    environment: options.environment,
    activation: options.activation
  });
  return config?.installationId === 'richmond'
    && config.environment === 'production'
    && config.target === 'production'
    ? config
    : null;
}

export function richmondProductionInstallerConfig(env, requestUrl, options = {}) {
  const runtime = richmondProductionRuntimeConfig(env, requestUrl, options);
  const profile = deploymentInstallationProfile(
    options.installationId,
    options.environment,
    options.activation
  );
  const installSecret = validSecret(env.GIB_RICHMOND_PRODUCTION_INSTALL_CAPABILITY_SECRET);
  const runId = exactString(env.GIB_RICHMOND_PRODUCTION_INSTALL_RUN_ID);
  const pendingInstall = profile?.installationId === 'richmond'
    && profile.environment === 'production'
    && profile.activation === 'pending'
    && profile.writesEnabled === false
    && runtime?.writesEnabled === false
    && env.GIB_RICHMOND_PRODUCTION_ACTIVATION === 'pending'
    && env.GIB_RICHMOND_PRODUCTION_WRITE_ENABLED === 'false';
  if (
    !runtime
    || !pendingInstall
    || !installSecret
    || !INSTALL_RUN_ID_PATTERN.test(runId)
    || equalSecret(installSecret, runtime.webhookToken)
    || equalSecret(installSecret, runtime.adminActionToken)
    || equalSecret(installSecret, runtime.deviceToken)
  ) return null;
  return Object.freeze({ ...runtime, installSecret, runId });
}

export function createRichmondProductionInstallCapability({
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
    || expiresAtSeconds - issuedAtSeconds > RICHMOND_PRODUCTION_INSTALL_MAX_SECONDS
    || !validBase64Url32(normalizedNonce)
  ) throw new Error('Invalid Richmond production install capability input.');
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    purpose: RICHMOND_PRODUCTION_INSTALL_PURPOSE,
    origin: RICHMOND_PRODUCTION_ORIGIN,
    runId: normalizedRunId,
    issuedAt: issuedAtSeconds,
    expiresAt: expiresAtSeconds,
    nonce: normalizedNonce
  }), 'utf8').toString('base64url');
  return `${payload}.${signature(installSecret, INSTALL_SIGNATURE_DOMAIN, payload)}`;
}

export function readRichmondProductionInstallCapability(token, config, now = Date.now()) {
  if (
    typeof token !== 'string'
    || token.length > 2_048
    || !INSTALL_TOKEN_PATTERN.test(token)
    || !config
    || !validSecret(config.installSecret)
  ) return null;
  const separator = token.indexOf('.');
  const encoded = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  if (!equalSecret(supplied, signature(config.installSecret, INSTALL_SIGNATURE_DOMAIN, encoded))) {
    return null;
  }
  let payload;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return null;
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
  const nowSeconds = integerSeconds(now);
  const keys = Object.keys(payload || {}).sort().join('|');
  if (
    keys !== 'expiresAt|issuedAt|nonce|origin|purpose|runId|v'
    || payload.v !== 1
    || payload.purpose !== RICHMOND_PRODUCTION_INSTALL_PURPOSE
    || payload.origin !== RICHMOND_PRODUCTION_ORIGIN
    || payload.runId !== config.runId
    || !INSTALL_RUN_ID_PATTERN.test(payload.runId)
    || !Number.isInteger(payload.issuedAt)
    || !Number.isInteger(payload.expiresAt)
    || payload.issuedAt < 1 || payload.issuedAt > nowSeconds
    || payload.expiresAt <= nowSeconds || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > RICHMOND_PRODUCTION_INSTALL_MAX_SECONDS
    || !validBase64Url32(payload.nonce)
  ) return null;
  return Object.freeze({ ...payload });
}

export function richmondProductionInstallConsumptionKey(token) {
  return `richmond-production/install/v1/${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

export function createRichmondProductionDeviceCredential(
  deviceToken,
  randomBytesImpl = randomBytes,
  now = Date.now()
) {
  const secret = validSecret(deviceToken);
  if (!secret) throw new Error('Invalid Richmond production device configuration.');
  const nonceBytes = Buffer.from(randomBytesImpl(32));
  if (nonceBytes.length !== 32) throw new Error('Invalid Richmond production device randomness.');
  const unsigned = `v1.${nonceBytes.toString('base64url')}.${integerSeconds(now)}`;
  return `${unsigned}.${signature(secret, DEVICE_SIGNATURE_DOMAIN, unsigned)}`;
}

export function validRichmondProductionDeviceCredential(value, deviceToken, now = Date.now()) {
  const credential = String(value ?? '');
  const secret = validSecret(deviceToken);
  if (!secret || !DEVICE_PATTERN.test(credential)) return false;
  const parts = credential.split('.');
  const issuedAt = Number(parts[2]);
  const nowSeconds = integerSeconds(now);
  if (!Number.isInteger(issuedAt) || issuedAt < 1 || issuedAt > nowSeconds + 300) return false;
  const unsigned = parts.slice(0, 3).join('.');
  return equalSecret(parts[3], signature(secret, DEVICE_SIGNATURE_DOMAIN, unsigned));
}

function cookieValue(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

export function richmondProductionDeviceAuthorization(request, config, now = Date.now()) {
  if (!config) return Object.freeze({ authorized: false, credential: '' });
  const credential = cookieValue(request, RICHMOND_PRODUCTION_DEVICE_COOKIE);
  const authorized = validRichmondProductionDeviceCredential(
    credential,
    config.deviceToken,
    now
  );
  return Object.freeze({ authorized, credential: authorized ? credential : '' });
}

export function richmondProductionDeviceCookieHeader(credential) {
  return [
    `${RICHMOND_PRODUCTION_DEVICE_COOKIE}=${encodeURIComponent(credential)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}
