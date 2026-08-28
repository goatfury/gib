import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import { exactObjectKeys } from './m1-production-runtime.mjs';

export const TABLET_PAIRING_STORE = 'gib-m1-tablet-pairing';
export const TABLET_PAIRING_PENDING_COOKIE = '__Host-gib_m1_tablet_pairing';
export const TABLET_PAIRING_REVIEW_COOKIE = '__Host-gib_m1_tablet_pairing_review';
export const TABLET_PAIRING_PURPOSE = 'tablet-device-pairing';
export const TABLET_PAIRING_REVIEW_PURPOSE = 'tablet-device-pairing-review';
export const TABLET_PAIRING_MAX_SECONDS = 12 * 60 * 60;
export const TABLET_PAIRING_DELIVERY_GRACE_SECONDS = 120;
export const TABLET_PAIRING_REVIEW_MAX_SECONDS = 15 * 60;
export const TABLET_PAIRING_PENDING_MAX_SECONDS = TABLET_PAIRING_MAX_SECONDS
  + TABLET_PAIRING_DELIVERY_GRACE_SECONDS;
export const TABLET_PAIRING_PURGE_SECONDS = 24 * 60 * 60;
export const TABLET_PAIRING_GENESIS_SECONDS = 1_787_788_800;
export const TABLET_PAIRING_ADMISSION_KEY = 'pairing/admission/v1/current';
export const TABLET_PAIRING_ADMISSION_WINDOW_SECONDS = 60 * 60;
export const TABLET_PAIRING_ADMISSION_LIMIT = 120;
export const TABLET_PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/u;

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SIGNED_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const REQUEST_KEY_PATTERN = /^pairing\/request\/v1\/[0-9]{12}\/[0-9a-f]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const PENDING_SIGNATURE_DOMAIN = 'gib-m1-tablet-pairing:pending:v1\0';
const REVIEW_SIGNATURE_DOMAIN = 'gib-m1-tablet-pairing:review:v1\0';
const CODE_DOMAIN = 'gib-m1-tablet-pairing:code:v1\0';
const CODE_INDEX_DOMAIN = 'gib-m1-tablet-pairing:code-index:v1\0';
const ADMIN_BINDING_DOMAIN = 'gib-m1-tablet-pairing:admin:v1\0';
const APPROVER_DOMAIN = 'gib-m1-tablet-pairing:approver:v1\0';
const ADMISSION_CAS_ATTEMPTS = 12;

function exactString(value, maximum = 512) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maximum
    || value !== value.trim()
    || value !== value.normalize('NFKC')
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) return '';
  return value;
}

function validSecret(value) {
  const secret = exactString(value);
  return secret.length >= 32 ? secret : '';
}

function equalSecret(left, right) {
  const leftHash = createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const rightHash = createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sign(secret, domain, value) {
  return createHmac('sha256', secret)
    .update(domain, 'utf8')
    .update(value, 'utf8')
    .digest('base64url');
}

function seconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return Math.floor(numeric >= 100_000_000_000 ? numeric / 1_000 : numeric);
}

function validRandomId(value) {
  if (!BASE64URL_32_PATTERN.test(String(value ?? ''))) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
  } catch {
    return false;
  }
}

function validProfile(profile) {
  if (
    !profile
    || typeof profile !== 'object'
    || !exactString(profile.installationId, 64)
    || !exactString(profile.gymName, 128)
    || !exactString(profile.deviceLabel, 128)
    || !exactString(profile.origin, 256)
    || !Number.isInteger(profile.expiresInSeconds)
    || profile.expiresInSeconds < 60
    || profile.expiresInSeconds > TABLET_PAIRING_MAX_SECONDS
  ) return false;
  try {
    const origin = new URL(profile.origin);
    return origin.protocol === 'https:'
      && origin.origin === profile.origin
      && !origin.port
      && !origin.username
      && !origin.password
      && origin.pathname === '/'
      && !origin.search
      && !origin.hash;
  } catch {
    return false;
  }
}

function scope(profile) {
  if (!validProfile(profile)) throw new Error('Invalid tablet pairing profile.');
  return `${profile.installationId}\0${profile.origin}`;
}

export function validExactPairingRequest(request, path, profile) {
  if (!validProfile(profile) || typeof path !== 'string' || !path.startsWith('/api/')) {
    return false;
  }
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  const expected = new URL(profile.origin);
  if (
    request.method !== 'POST'
    || url.origin !== profile.origin
    || url.protocol !== 'https:'
    || url.host !== expected.host
    || url.hostname !== expected.hostname
    || url.port
    || url.username
    || url.password
    || url.pathname !== path
    || url.search
    || url.hash
  ) return false;
  const host = request.headers.get('host');
  return typeof host === 'string'
    && host.toLocaleLowerCase('en-US') === expected.host.toLocaleLowerCase('en-US')
    && request.headers.get('origin') === profile.origin
    && request.headers.get('sec-fetch-site') === 'same-origin';
}

function encodedSignedToken(payload, secret, domain) {
  const signingSecret = validSecret(secret);
  if (!signingSecret) throw new Error('Invalid tablet pairing secret.');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(signingSecret, domain, encoded)}`;
}

function decodedSignedToken(token, secret, domain) {
  const signingSecret = validSecret(secret);
  if (
    !signingSecret
    || typeof token !== 'string'
    || token.length > 2_048
    || !SIGNED_TOKEN_PATTERN.test(token)
  ) return null;
  const separator = token.indexOf('.');
  const encoded = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  if (!equalSecret(supplied, sign(signingSecret, domain, encoded))) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

export function pairingCodeFromRequest(secret, profile, requestId) {
  if (!validSecret(secret) || !validProfile(profile) || !validRandomId(requestId)) {
    throw new Error('Invalid tablet pairing code input.');
  }
  const digest = createHmac('sha256', secret)
    .update(CODE_DOMAIN, 'utf8')
    .update(scope(profile), 'utf8')
    .update('\0', 'utf8')
    .update(requestId, 'utf8')
    .digest();
  let bits = 0n;
  for (const byte of digest.subarray(0, 7)) bits = (bits << 8n) | BigInt(byte);
  bits >>= 6n;
  let code = '';
  for (let shift = 45n; shift >= 0n; shift -= 5n) {
    code += CROCKFORD_ALPHABET[Number((bits >> shift) & 31n)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function normalizePairingCode(value) {
  const source = String(value ?? '').normalize('NFKC').trim().toLocaleUpperCase('en-US');
  const compact = source.replace('-', '');
  if (
    compact.length !== 10
    || !/^[0-9A-HJKMNP-TV-Z]{10}$/u.test(compact)
    || (source !== compact && source !== `${compact.slice(0, 5)}-${compact.slice(5)}`)
  ) return '';
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}

export function pairingRequestKey(profile, requestId, requestedAt) {
  const requested = seconds(requestedAt);
  if (
    !validRandomId(requestId)
    || !Number.isInteger(requested)
    || requested < 1
  ) throw new Error('Invalid tablet pairing request ID.');
  const purgeAfter = requested + TABLET_PAIRING_PURGE_SECONDS;
  const purgeBucket = Math.floor(purgeAfter / 3_600) * 3_600;
  return `pairing/request/v1/${String(purgeBucket).padStart(12, '0')}/${hash(`${scope(profile)}\0${requestId}`)}`;
}

function pairingCodeHash(secret, profile, pairingCode) {
  const code = normalizePairingCode(pairingCode);
  const indexSecret = validSecret(secret);
  if (!indexSecret || !code) throw new Error('Invalid tablet pairing code.');
  return createHmac('sha256', indexSecret)
    .update(CODE_INDEX_DOMAIN, 'utf8')
    .update(scope(profile), 'utf8')
    .update('\0', 'utf8')
    .update(code, 'utf8')
    .digest('hex');
}

export function pairingCodeIndexKey(secret, profile, pairingCode) {
  return pairingCodeIndexKeyFromHash(pairingCodeHash(secret, profile, pairingCode));
}

export function pairingCodeIndexKeyFromHash(codeHash) {
  if (!HASH_PATTERN.test(String(codeHash ?? ''))) {
    throw new Error('Invalid tablet pairing code hash.');
  }
  return `pairing/code/v1/${codeHash}`;
}

export function validPairingRequestKeyForRecord(key, record) {
  if (!REQUEST_KEY_PATTERN.test(String(key ?? ''))) return false;
  const parts = key.split('/');
  return Number(parts.at(-2)) === Math.floor(record?.purgeAfter / 3_600) * 3_600
    && parts.at(-1) === record?.requestIdHash;
}

function storedPairingRecordProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const expiresInSeconds = Number(value.approvalExpiresAt)
    - Number(value.requestedAt);
  const profile = {
    installationId: value.installationId,
    gymName: value.gymName,
    deviceLabel: value.deviceLabel,
    origin: value.origin,
    expiresInSeconds
  };
  return validProfile(profile) ? profile : null;
}

export function createPairingPendingToken({
  secret,
  profile,
  requestId,
  issuedAt,
  approvalExpiresAt,
  expiresAt
}) {
  const issued = seconds(issuedAt);
  const approvalExpires = seconds(approvalExpiresAt);
  const expires = seconds(expiresAt);
  if (
    !validProfile(profile)
    || !validRandomId(requestId)
    || !Number.isInteger(issued)
    || !Number.isInteger(approvalExpires)
    || !Number.isInteger(expires)
    || issued < 1
    || approvalExpires !== issued + profile.expiresInSeconds
    || expires !== approvalExpires + TABLET_PAIRING_DELIVERY_GRACE_SECONDS
  ) throw new Error('Invalid tablet pairing pending token input.');
  return encodedSignedToken({
    v: 1,
    purpose: TABLET_PAIRING_PURPOSE,
    installationId: profile.installationId,
    origin: profile.origin,
    requestId,
    issuedAt: issued,
    approvalExpiresAt: approvalExpires,
    expiresAt: expires
  }, secret, PENDING_SIGNATURE_DOMAIN);
}

export function readPairingPendingToken(token, secret, profile, now = Date.now()) {
  const payload = decodedSignedToken(token, secret, PENDING_SIGNATURE_DOMAIN);
  const current = seconds(now);
  if (
    !validProfile(profile)
    || !payload
    || !exactObjectKeys(payload, [
      'v',
      'purpose',
      'installationId',
      'origin',
      'requestId',
      'issuedAt',
      'approvalExpiresAt',
      'expiresAt'
    ])
    || payload.v !== 1
    || payload.purpose !== TABLET_PAIRING_PURPOSE
    || payload.installationId !== profile.installationId
    || payload.origin !== profile.origin
    || !validRandomId(payload.requestId)
    || !Number.isInteger(payload.issuedAt)
    || !Number.isInteger(payload.approvalExpiresAt)
    || !Number.isInteger(payload.expiresAt)
    || payload.issuedAt < 1
    || payload.issuedAt > current
    || payload.approvalExpiresAt !== payload.issuedAt + profile.expiresInSeconds
    || payload.expiresAt !== payload.approvalExpiresAt + TABLET_PAIRING_DELIVERY_GRACE_SECONDS
  ) return null;
  return Object.freeze({ ...payload, expired: payload.expiresAt <= current });
}

function adminSessionBinding(secret, session) {
  if (
    !session
    || !exactString(session.adminName, 128)
    || !/^[A-Za-z0-9_-]{32,256}$/u.test(String(session.requestToken ?? ''))
  ) return '';
  return sign(
    secret,
    ADMIN_BINDING_DOMAIN,
    `${session.adminName}\0${session.requestToken}\0${session.expiresAt}`
  );
}

export function createPairingReviewToken({
  secret,
  profile,
  requestKey,
  codeHash,
  session,
  issuedAt,
  expiresAt
}) {
  const issued = seconds(issuedAt);
  const expires = seconds(expiresAt);
  const binding = adminSessionBinding(secret, session);
  if (
    !validProfile(profile)
    || !REQUEST_KEY_PATTERN.test(String(requestKey ?? ''))
    || !HASH_PATTERN.test(String(codeHash ?? ''))
    || !binding
    || !Number.isInteger(issued)
    || !Number.isInteger(expires)
    || issued < 1
    || expires <= issued
    || expires - issued > TABLET_PAIRING_REVIEW_MAX_SECONDS
    || expires > session.expiresAt
  ) throw new Error('Invalid tablet pairing review token input.');
  return encodedSignedToken({
    v: 1,
    purpose: TABLET_PAIRING_REVIEW_PURPOSE,
    installationId: profile.installationId,
    origin: profile.origin,
    requestKey,
    codeHash,
    adminBinding: binding,
    issuedAt: issued,
    expiresAt: expires
  }, secret, REVIEW_SIGNATURE_DOMAIN);
}

export function readPairingReviewToken(token, secret, profile, session, now = Date.now()) {
  const payload = decodedSignedToken(token, secret, REVIEW_SIGNATURE_DOMAIN);
  const current = seconds(now);
  const binding = adminSessionBinding(secret, session);
  if (
    !validProfile(profile)
    || !payload
    || !binding
    || !exactObjectKeys(payload, [
      'v',
      'purpose',
      'installationId',
      'origin',
      'requestKey',
      'codeHash',
      'adminBinding',
      'issuedAt',
      'expiresAt'
    ])
    || payload.v !== 1
    || payload.purpose !== TABLET_PAIRING_REVIEW_PURPOSE
    || payload.installationId !== profile.installationId
    || payload.origin !== profile.origin
    || !REQUEST_KEY_PATTERN.test(payload.requestKey)
    || !HASH_PATTERN.test(payload.codeHash)
    || !equalSecret(payload.adminBinding, binding)
    || !Number.isInteger(payload.issuedAt)
    || !Number.isInteger(payload.expiresAt)
    || payload.issuedAt < 1
    || payload.issuedAt > current
    || payload.expiresAt <= current
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > TABLET_PAIRING_REVIEW_MAX_SECONDS
    || payload.expiresAt > session.expiresAt
  ) return null;
  return Object.freeze({ ...payload });
}

function cookieHeader(name, value, maxAge, maximum) {
  if (
    typeof value !== 'string'
    || !value
    || !Number.isInteger(maxAge)
    || maxAge < 1
    || maxAge > maximum
  ) throw new Error('Invalid tablet pairing cookie.');
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

function clearCookieHeader(name) {
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

export function pairingPendingCookieHeader(value, maxAge) {
  return cookieHeader(
    TABLET_PAIRING_PENDING_COOKIE,
    value,
    maxAge,
    TABLET_PAIRING_PENDING_MAX_SECONDS
  );
}

export function pairingReviewCookieHeader(value, maxAge) {
  return cookieHeader(
    TABLET_PAIRING_REVIEW_COOKIE,
    value,
    maxAge,
    TABLET_PAIRING_REVIEW_MAX_SECONDS
  );
}

export function clearPairingPendingCookieHeader() {
  return clearCookieHeader(TABLET_PAIRING_PENDING_COOKIE);
}

export function clearPairingReviewCookieHeader() {
  return clearCookieHeader(TABLET_PAIRING_REVIEW_COOKIE);
}

export function emptyPairingRequestRecord(secret, profile, requestId, pairingCode, now) {
  const requestedAt = seconds(now);
  const approvalExpiresAt = requestedAt + profile.expiresInSeconds;
  return Object.freeze({
    v: 1,
    installationId: profile.installationId,
    origin: profile.origin,
    gymName: profile.gymName,
    deviceLabel: profile.deviceLabel,
    requestIdHash: hash(`${scope(profile)}\0${requestId}`),
    codeHash: pairingCodeHash(secret, profile, pairingCode),
    requestedAt,
    approvalExpiresAt,
    deliveryExpiresAt: 0,
    purgeAfter: requestedAt + TABLET_PAIRING_PURGE_SECONDS,
    status: 'pending',
    approvedAt: 0,
    approvedByHash: '',
    credentialIssuedAt: 0,
    deliveryNonce: '',
    credentialHash: '',
    consumedAt: 0
  });
}

export function validPairingRequestRecord(value, profile) {
  if (
    !validProfile(profile)
    || !exactObjectKeys(value, [
      'v',
      'installationId',
      'origin',
      'gymName',
      'deviceLabel',
      'requestIdHash',
      'codeHash',
      'requestedAt',
      'approvalExpiresAt',
      'deliveryExpiresAt',
      'purgeAfter',
      'status',
      'approvedAt',
      'approvedByHash',
      'credentialIssuedAt',
      'deliveryNonce',
      'credentialHash',
      'consumedAt'
    ])
    || value.v !== 1
    || value.installationId !== profile.installationId
    || value.origin !== profile.origin
    || value.gymName !== profile.gymName
    || value.deviceLabel !== profile.deviceLabel
    || !HASH_PATTERN.test(value.requestIdHash)
    || !HASH_PATTERN.test(value.codeHash)
    || !Number.isInteger(value.requestedAt)
    || !Number.isInteger(value.approvalExpiresAt)
    || !Number.isInteger(value.deliveryExpiresAt)
    || !Number.isInteger(value.purgeAfter)
    || value.requestedAt < 1
    || value.approvalExpiresAt !== value.requestedAt + profile.expiresInSeconds
    || value.purgeAfter !== value.requestedAt + TABLET_PAIRING_PURGE_SECONDS
    || !['pending', 'approved', 'consumed', 'rejected', 'cancelled'].includes(value.status)
    || !Number.isInteger(value.approvedAt)
    || !Number.isInteger(value.credentialIssuedAt)
    || !Number.isInteger(value.consumedAt)
  ) return false;
  if (['pending', 'rejected', 'cancelled'].includes(value.status)) {
    return value.approvedAt === 0
      && value.approvedByHash === ''
      && value.credentialIssuedAt === 0
      && value.deliveryNonce === ''
      && value.credentialHash === ''
      && value.deliveryExpiresAt === 0
      && value.consumedAt === 0;
  }
  if (
    value.approvedAt < value.requestedAt
    || value.approvedAt >= value.approvalExpiresAt
    || !HASH_PATTERN.test(value.approvedByHash)
    || value.deliveryExpiresAt !== value.approvalExpiresAt + TABLET_PAIRING_DELIVERY_GRACE_SECONDS
  ) return false;
  if (
    value.credentialIssuedAt < value.approvedAt
    || value.credentialIssuedAt !== value.approvedAt
    || !validRandomId(value.deliveryNonce)
    || !HASH_PATTERN.test(value.credentialHash)
  ) return false;
  if (value.status === 'approved') return value.consumedAt === 0;
  return value.consumedAt >= value.credentialIssuedAt;
}

export function validPairingRequestRecordForCleanup(value) {
  const historicalProfile = storedPairingRecordProfile(value);
  return Boolean(
    historicalProfile
    && validPairingRequestRecord(value, historicalProfile)
  );
}

export function pairingCodeIndexRecord(
  profile,
  requestKey,
  codeHash,
  approvalExpiresAt,
  purgeAfter
) {
  return Object.freeze({
    v: 1,
    installationId: profile.installationId,
    origin: profile.origin,
    requestKey,
    codeHash,
    approvalExpiresAt,
    purgeAfter
  });
}

export function validPairingCodeIndex(value, profile) {
  return exactObjectKeys(value, [
    'v',
    'installationId',
    'origin',
    'requestKey',
    'codeHash',
    'approvalExpiresAt',
    'purgeAfter'
  ])
    && value.v === 1
    && value.installationId === profile.installationId
    && value.origin === profile.origin
    && REQUEST_KEY_PATTERN.test(value.requestKey)
    && HASH_PATTERN.test(value.codeHash)
    && Number.isInteger(value.approvalExpiresAt)
    && Number.isInteger(value.purgeAfter)
    && value.approvalExpiresAt > 0
    && value.purgeAfter > value.approvalExpiresAt;
}

export function validPairingCodeIndexForRequest(value, requestKey, record) {
  const historicalProfile = storedPairingRecordProfile(record);
  return Boolean(
    historicalProfile
    && validPairingRequestRecord(record, historicalProfile)
    && validPairingCodeIndex(value, historicalProfile)
    && value.requestKey === requestKey
    && value.codeHash === record.codeHash
    && value.approvalExpiresAt === record.approvalExpiresAt
    && value.purgeAfter === record.purgeAfter
  );
}

export function pairingApproverHash(secret, session) {
  const binding = adminSessionBinding(secret, session);
  if (!binding) throw new Error('Invalid tablet pairing approver.');
  return hash(`${APPROVER_DOMAIN}${binding}`);
}

export function pairingCredentialHash(credential) {
  return hash(`gib-m1-tablet-pairing:credential:v1\0${credential}`);
}

export function pairingRandomId(randomBytesImpl = randomBytes) {
  const value = Buffer.from(randomBytesImpl(32));
  if (value.length !== 32) throw new Error('Invalid tablet pairing randomness.');
  return value.toString('base64url');
}

export async function defaultPairingStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({
    name: TABLET_PAIRING_STORE,
    consistency: 'strong'
  });
}

export async function readPairingBlob(store, key) {
  if (!store || typeof store.getWithMetadata !== 'function') {
    throw new Error('Tablet pairing store is unavailable.');
  }
  const result = await store.getWithMetadata(key, {
    type: 'json',
    consistency: 'strong'
  });
  if (!result) return null;
  let value = result.data;
  if (typeof value === 'string') value = JSON.parse(value);
  if (!result.etag || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tablet pairing store returned unreadable state.');
  }
  return Object.freeze({ value, etag: result.etag });
}

export async function createPairingBlob(store, key, value) {
  if (!store || typeof store.set !== 'function') {
    throw new Error('Tablet pairing store is unavailable.');
  }
  const result = await store.set(key, JSON.stringify(value), { onlyIfNew: true });
  return Boolean(result?.modified === true);
}

export async function updatePairingBlob(store, key, value, etag) {
  if (!store || typeof store.set !== 'function' || !exactString(etag, 256)) {
    throw new Error('Tablet pairing store is unavailable.');
  }
  const result = await store.set(key, JSON.stringify(value), { onlyIfMatch: etag });
  return Boolean(result?.modified === true);
}

function validPairingAdmissionRecord(value) {
  return exactObjectKeys(value, ['v', 'windowStart', 'windowExpiresAt', 'count'])
    && value.v === 1
    && Number.isInteger(value.windowStart)
    && Number.isInteger(value.windowExpiresAt)
    && Number.isInteger(value.count)
    && value.windowStart >= TABLET_PAIRING_GENESIS_SECONDS
    && value.windowStart % TABLET_PAIRING_ADMISSION_WINDOW_SECONDS === 0
    && value.windowExpiresAt === value.windowStart + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS
    && value.count >= 1
    && value.count <= TABLET_PAIRING_ADMISSION_LIMIT;
}

function pairingAdmissionRecord(windowStart, count) {
  return Object.freeze({
    v: 1,
    windowStart,
    windowExpiresAt: windowStart + TABLET_PAIRING_ADMISSION_WINDOW_SECONDS,
    count
  });
}

export async function reservePairingAdmission(store, now = Date.now()) {
  const current = seconds(now);
  if (!Number.isInteger(current) || current < TABLET_PAIRING_GENESIS_SECONDS) {
    throw new Error('Invalid tablet pairing admission time.');
  }
  const windowStart = Math.floor(current / TABLET_PAIRING_ADMISSION_WINDOW_SECONDS)
    * TABLET_PAIRING_ADMISSION_WINDOW_SECONDS;
  for (let attempt = 0; attempt < ADMISSION_CAS_ATTEMPTS; attempt += 1) {
    const existing = await readPairingBlob(store, TABLET_PAIRING_ADMISSION_KEY);
    if (!existing) {
      if (await createPairingBlob(
        store,
        TABLET_PAIRING_ADMISSION_KEY,
        pairingAdmissionRecord(windowStart, 1)
      )) return true;
      continue;
    }
    if (!validPairingAdmissionRecord(existing.value)) {
      throw new Error('Tablet pairing admission state is invalid.');
    }
    if (existing.value.windowStart > windowStart) {
      throw new Error('Tablet pairing admission time moved backwards.');
    }
    if (
      existing.value.windowStart === windowStart
      && existing.value.count >= TABLET_PAIRING_ADMISSION_LIMIT
    ) return false;
    const nextCount = existing.value.windowStart === windowStart
      ? existing.value.count + 1
      : 1;
    if (await updatePairingBlob(
      store,
      TABLET_PAIRING_ADMISSION_KEY,
      pairingAdmissionRecord(windowStart, nextCount),
      existing.etag
    )) return true;
  }
  throw new Error('Tablet pairing admission is temporarily unavailable.');
}

export async function deletePairingBlob(store, key) {
  if (!store || typeof store.delete !== 'function') {
    throw new Error('Tablet pairing store is unavailable.');
  }
  await store.delete(key);
}

export function isoTimestamp(secondsValue) {
  const value = Number(secondsValue);
  if (!Number.isInteger(value) || value < 1) throw new Error('Invalid tablet pairing time.');
  return new Date(value * 1_000).toISOString();
}
