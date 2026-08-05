import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes
} from 'node:crypto';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  constantTimeSecretEqual,
  cookieValue,
  jsonResponse,
  readAdminSession,
  readJson,
  requireAdmin,
  runtimeConfig
} from './_lib/m1-common.mjs';

export const CAPABILITY_COOKIE = 'gib_m1_tablet_diag_cap';
export const CAPABILITY_PATH = '/api/m1-tablet-diagnostic-verifier';
export const CAPABILITY_SECONDS = 60;
export const ENDPOINT_PROOF_DOMAIN = 'gib-m1-tablet-diagnostic:endpoint:v2';
export const CREDENTIAL_PROOF_DOMAIN = 'gib-m1-tablet-diagnostic:credential:v2';
export const PRODUCTION_LEGACY_KIOSK_ENV = 'GIB_M1_LEGACY_KIOSK_TOKEN';
export const PREVIEW_LEGACY_KIOSK_ENV = 'GIB_TEST_LEGACY_KIOSK_TOKEN';
export const DIAGNOSTIC_PURPOSE = 'diagnostic';
export const INSTALL_PURPOSE = 'install';

// Allow exactly one capability issue and one proof verification per minute.
export const config = {
  path: '/api/m1-tablet-diagnostic-verifier',
  rateLimit: {
    windowLimit: 2,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const CAPABILITY_AAD = Buffer.from('gib-m1-tablet-diagnostic:capability:v1', 'utf8');
const INSTALL_ENVELOPE_KEY_DOMAIN = 'gib-m1-tablet-diagnostic:install-envelope:key:v1';
const INSTALL_ENVELOPE_AAD_DOMAIN = 'gib-m1-tablet-diagnostic:install-envelope:aad:v1';
const TABLET_DIAGNOSTIC_PATH = '/m1/tablet-diagnostic.html';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const JWK_COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PROOF_PATTERN = /^[0-9a-f]{64}$/u;
const PROOF_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

function validSameOriginRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }

  const host = url.hostname.toLocaleLowerCase('en-US');
  const allowedHost = host === 'gib-live.netlify.app'
    || /^deploy-preview-\d+--gib-live\.netlify\.app$/u.test(host);
  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.pathname !== CAPABILITY_PATH
    || !allowedHost
  ) {
    return false;
  }

  const hostHeader = request.headers.get('host');
  if (hostHeader && hostHeader.toLocaleLowerCase('en-US') !== url.host.toLocaleLowerCase('en-US')) {
    return false;
  }
  if (request.headers.get('origin') !== url.origin) {
    return false;
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin';
}

function validRunId(value) {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

function legacyKioskCredential(env, preview) {
  const name = preview ? PREVIEW_LEGACY_KIOSK_ENV : PRODUCTION_LEGACY_KIOSK_ENV;
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function validClientPublicJwk(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 6
    || value.kty !== 'EC'
    || value.crv !== 'P-256'
    || value.ext !== true
    || !Array.isArray(value.key_ops)
    || value.key_ops.length !== 0
    || typeof value.x !== 'string'
    || !JWK_COORDINATE_PATTERN.test(value.x)
    || typeof value.y !== 'string'
    || !JWK_COORDINATE_PATTERN.test(value.y)
  ) {
    return false;
  }

  try {
    return Buffer.from(value.x, 'base64url').toString('base64url') === value.x
      && Buffer.from(value.y, 'base64url').toString('base64url') === value.y;
  } catch {
    return false;
  }
}

function validIssueBody(value, action) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (action === 'issue-install') {
    return Object.keys(value).length === 3
      && value.action === action
      && validRunId(value.runId)
      && validClientPublicJwk(value.clientPublicKey);
  }
  return Object.keys(value).length === 2
    && value.action === action
    && validRunId(value.runId);
}

function validVerifyBody(value) {
  return Object.keys(value).length === 5
    && value.action === 'verify'
    && [DIAGNOSTIC_PURPOSE, INSTALL_PURPOSE].includes(value.purpose)
    && validRunId(value.runId)
    && typeof value.endpointProof === 'string'
    && PROOF_PATTERN.test(value.endpointProof)
    && typeof value.credentialProof === 'string'
    && PROOF_PATTERN.test(value.credentialProof);
}

function capabilityCookieHeader(value, maxAge) {
  return [
    `${CAPABILITY_COOKIE}=${encodeURIComponent(value)}`,
    `Path=${CAPABILITY_PATH}`,
    `Max-Age=${maxAge}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

function clearCapabilityCookieHeader() {
  return [
    `${CAPABILITY_COOKIE}=`,
    `Path=${CAPABILITY_PATH}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

function withCapabilityCleared(response) {
  const headers = new Headers(response.headers);
  headers.set('Set-Cookie', clearCapabilityCookieHeader());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function deriveKey(secret, purpose) {
  return createHash('sha256')
    .update(`gib-m1-tablet-diagnostic:${purpose}:v1\0`, 'utf8')
    .update(secret, 'utf8')
    .digest();
}

function sessionBinding(secret, session) {
  return createHmac('sha256', deriveKey(secret, 'session-binding'))
    .update(session.adminName, 'utf8')
    .update('\0', 'utf8')
    .update(String(session.expiresAt), 'utf8')
    .update('\0', 'utf8')
    .update(session.requestToken, 'utf8')
    .digest('base64url');
}

function createCapability(payload, secret, randomBytesImpl) {
  const initializationVector = Buffer.from(randomBytesImpl(12));
  if (initializationVector.length !== 12) {
    throw new Error('Invalid capability randomness.');
  }

  const cipher = createCipheriv(
    'aes-256-gcm',
    deriveKey(secret, 'capability-encryption'),
    initializationVector
  );
  cipher.setAAD(CAPABILITY_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const encoded = [
    initializationVector.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url')
  ].join('.');
  const signature = createHmac('sha256', deriveKey(secret, 'capability-signing'))
    .update(encoded, 'utf8')
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function readCapability(value, secret) {
  const parts = String(value == null ? '' : value).split('.');
  if (parts.length !== 4) return null;

  const encoded = parts.slice(0, 3).join('.');
  const expectedSignature = createHmac('sha256', deriveKey(secret, 'capability-signing'))
    .update(encoded, 'utf8')
    .digest('base64url');
  if (!constantTimeSecretEqual(parts[3], expectedSignature)) return null;

  let initializationVector;
  let ciphertext;
  let authenticationTag;
  try {
    initializationVector = Buffer.from(parts[0], 'base64url');
    ciphertext = Buffer.from(parts[1], 'base64url');
    authenticationTag = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (
    initializationVector.length !== 12
    || !ciphertext.length
    || ciphertext.length > 2_048
    || authenticationTag.length !== 16
  ) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(secret, 'capability-encryption'),
      initializationVector
    );
    decipher.setAAD(CAPABILITY_AAD);
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

function expectedProof(proofKey, domain, runId, expectedValue) {
  return createHmac('sha256', Buffer.from(proofKey, 'utf8'))
    .update(`${domain}\0${runId}\0${expectedValue}`, 'utf8')
    .digest('hex');
}

function validLegacyKioskCredential(value, config) {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && value.length <= 512
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && !constantTimeSecretEqual(value, config.webhookToken)
    && !constantTimeSecretEqual(value, config.adminActionToken)
    && !constantTimeSecretEqual(value, config.adminPassphrase)
    && !constantTimeSecretEqual(value, config.sessionSecret);
}

function createInstallEnvelope(
  request,
  runId,
  proofKey,
  clientPublicJwk,
  config,
  credential,
  randomBytesImpl,
  createECDHImpl
) {
  // Trust boundary: the authenticated same-origin tablet browser can ultimately
  // read its own localStorage. The child-held key prevents passive Admin/network
  // response capture from revealing the binding; it cannot attest hostile client code.
  const initializationVector = Buffer.from(randomBytesImpl(12));
  if (initializationVector.length !== 12) {
    throw new Error('Invalid install-envelope randomness.');
  }

  const additionalData = Buffer.from(
    `${INSTALL_ENVELOPE_AAD_DOMAIN}\0${new URL(request.url).origin}\0${TABLET_DIAGNOSTIC_PATH}\0${runId}`,
    'utf8'
  );
  const keyInformation = Buffer.from(`${INSTALL_ENVELOPE_KEY_DOMAIN}\0${proofKey}`, 'utf8');
  const plaintext = Buffer.from(JSON.stringify({
    v: 1,
    runId,
    endpoint: config.webhookUrl,
    credential,
    autoSync: false
  }), 'utf8');
  let sharedSecret;
  let key;

  try {
    const clientPublicPoint = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(clientPublicJwk.x, 'base64url'),
      Buffer.from(clientPublicJwk.y, 'base64url')
    ]);
    const serverEcdh = createECDHImpl('prime256v1');
    serverEcdh.generateKeys();
    const serverPublicPoint = serverEcdh.getPublicKey(null, 'uncompressed');
    if (
      clientPublicPoint.length !== 65
      || serverPublicPoint.length !== 65
      || clientPublicPoint[0] !== 0x04
      || serverPublicPoint[0] !== 0x04
    ) {
      throw new Error('Invalid install-envelope public key.');
    }

    sharedSecret = Buffer.from(serverEcdh.computeSecret(clientPublicPoint));
    if (sharedSecret.length !== 32) {
      throw new Error('Invalid install-envelope shared secret.');
    }
    key = Buffer.from(hkdfSync('sha256', sharedSecret, additionalData, keyInformation, 32));
    if (key.length !== 32) {
      throw new Error('Invalid install-envelope key.');
    }

    const cipher = createCipheriv('aes-256-gcm', key, initializationVector);
    cipher.setAAD(additionalData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [
      serverPublicPoint.subarray(1, 33).toString('base64url'),
      serverPublicPoint.subarray(33, 65).toString('base64url'),
      initializationVector.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url')
    ].join('.');
  } finally {
    if (sharedSecret) sharedSecret.fill(0);
    if (key) key.fill(0);
    additionalData.fill(0);
    keyInformation.fill(0);
    plaintext.fill(0);
  }
}

function misconfiguredResponse() {
  return jsonResponse(503, {
    ok: false,
    message: 'Admin service is not configured for this environment.'
  });
}

function invalidRequestResponse() {
  return jsonResponse(400, { ok: false, message: 'Diagnostic request was invalid.' });
}

async function issueCapability(
  request,
  value,
  config,
  expectedLegacyCredential,
  dependencies,
  now,
  purpose
) {
  const action = purpose === INSTALL_PURPOSE ? 'issue-install' : 'issue';
  if (!validIssueBody(value, action)) {
    return withCapabilityCleared(invalidRequestResponse());
  }

  const auth = requireAdmin(request, config, now);
  if (auth.response) return withCapabilityCleared(auth.response);

  const nowSeconds = Math.floor(now / 1_000);
  const expiresInSeconds = Math.min(
    CAPABILITY_SECONDS,
    auth.session.expiresAt - nowSeconds
  );
  if (expiresInSeconds < 1) {
    return withCapabilityCleared(jsonResponse(401, {
      ok: false,
      message: 'Admin login required.'
    }));
  }

  const randomBytesImpl = dependencies.randomBytes || randomBytes;
  const createECDHImpl = dependencies.createECDH || createECDH;
  let proofKey;
  let capability;
  let installEnvelope;
  try {
    const proofKeyBytes = Buffer.from(randomBytesImpl(32));
    if (proofKeyBytes.length !== 32) throw new Error('Invalid proof-key randomness.');
    proofKey = proofKeyBytes.toString('base64url');
    capability = createCapability({
      v: 1,
      r: value.runId,
      iat: nowSeconds,
      exp: nowSeconds + expiresInSeconds,
      s: sessionBinding(config.sessionSecret, auth.session),
      k: proofKey,
      p: purpose
    }, config.sessionSecret, randomBytesImpl);
    if (purpose === INSTALL_PURPOSE) {
      installEnvelope = createInstallEnvelope(
        request,
        value.runId,
        proofKey,
        value.clientPublicKey,
        config,
        expectedLegacyCredential,
        randomBytesImpl,
        createECDHImpl
      );
    }
  } catch {
    return withCapabilityCleared(jsonResponse(503, {
      ok: false,
      message: 'Diagnostic authorization could not be created.'
    }));
  }

  const body = purpose === INSTALL_PURPOSE
    ? {
        ok: true,
        runId: value.runId,
        proofKey,
        installEnvelope,
        expiresInSeconds
      }
    : {
        ok: true,
        runId: value.runId,
        proofKey,
        expiresInSeconds
      };

  return jsonResponse(200, body, {
    'Set-Cookie': capabilityCookieHeader(capability, expiresInSeconds)
  });
}

function verifyProofs(request, value, config, expectedLegacyCredential, now) {
  const respond = (status, body) => jsonResponse(status, body, {
    'Set-Cookie': clearCapabilityCookieHeader()
  });

  if (!validVerifyBody(value) || request.headers.has(ADMIN_REQUEST_HEADER)) {
    return respond(400, { ok: false, message: 'Diagnostic verification was invalid.' });
  }

  const session = readAdminSession(
    cookieValue(request, ADMIN_COOKIE),
    config.sessionSecret,
    now
  );
  if (!session) {
    return respond(401, { ok: false, message: 'Admin login required.' });
  }

  const capability = readCapability(
    cookieValue(request, CAPABILITY_COOKIE),
    config.sessionSecret
  );
  const nowSeconds = Math.floor(now / 1_000);
  if (
    !capability
    || capability.v !== 1
    || !validRunId(capability.r)
    || capability.r !== value.runId
    || !Number.isInteger(capability.iat)
    || !Number.isInteger(capability.exp)
    || capability.iat > nowSeconds
    || capability.exp <= nowSeconds
    || capability.exp - capability.iat < 1
    || capability.exp - capability.iat > CAPABILITY_SECONDS
    || !PROOF_KEY_PATTERN.test(capability.k)
    || capability.p !== value.purpose
    || !constantTimeSecretEqual(
      capability.s,
      sessionBinding(config.sessionSecret, session)
    )
  ) {
    return respond(403, { ok: false, message: 'Diagnostic authorization expired or was not accepted.' });
  }

  const endpointProof = expectedProof(
    capability.k,
    ENDPOINT_PROOF_DOMAIN,
    value.runId,
    config.webhookUrl
  );
  const credentialProof = expectedProof(
    capability.k,
    CREDENTIAL_PROOF_DOMAIN,
    value.runId,
    expectedLegacyCredential
  );

  return respond(200, {
    ok: true,
    endpointExpected: constantTimeSecretEqual(value.endpointProof, endpointProof),
    credentialMatch: constantTimeSecretEqual(value.credentialProof, credentialProof)
  });
}

export async function handleAdminTabletDiagnostic(request, dependencies = {}) {
  if (!validSameOriginRequest(request)) {
    return withCapabilityCleared(jsonResponse(403, {
      ok: false,
      message: 'Same-origin diagnostic request required.'
    }));
  }

  const parsed = await readJson(request, 2_048);
  if (parsed.response) return withCapabilityCleared(parsed.response);

  const env = dependencies.env || process.env;
  const config = runtimeConfig(env, {
    admin: true,
    requestUrl: request.url
  });
  if (!config) return withCapabilityCleared(misconfiguredResponse());

  // The tablet credential is distinct from the Netlify-to-receiver transport token.
  const expectedLegacyCredential = legacyKioskCredential(env, config.preview);
  if (!validLegacyKioskCredential(expectedLegacyCredential, config)) {
    return withCapabilityCleared(misconfiguredResponse());
  }

  const now = dependencies.now || Date.now();
  if (parsed.value.action === 'issue') {
    return issueCapability(
      request,
      parsed.value,
      config,
      expectedLegacyCredential,
      dependencies,
      now,
      DIAGNOSTIC_PURPOSE
    );
  }
  if (parsed.value.action === 'issue-install') {
    return issueCapability(
      request,
      parsed.value,
      config,
      expectedLegacyCredential,
      dependencies,
      now,
      INSTALL_PURPOSE
    );
  }
  if (parsed.value.action === 'verify') {
    return verifyProofs(request, parsed.value, config, expectedLegacyCredential, now);
  }
  return withCapabilityCleared(invalidRequestResponse());
}

export default request => handleAdminTabletDiagnostic(request);
