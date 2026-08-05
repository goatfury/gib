import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
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

// Allow exactly one capability issue and one proof verification per minute.
export const config = {
  path: CAPABILITY_PATH,
  rateLimit: {
    windowLimit: 2,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const CAPABILITY_AAD = Buffer.from('gib-m1-tablet-diagnostic:capability:v1', 'utf8');
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

function validIssueBody(value) {
  return Object.keys(value).length === 2
    && value.action === 'issue'
    && validRunId(value.runId);
}

function validVerifyBody(value) {
  return Object.keys(value).length === 4
    && value.action === 'verify'
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

function misconfiguredResponse() {
  return jsonResponse(503, {
    ok: false,
    message: 'Admin service is not configured for this environment.'
  });
}

function invalidRequestResponse() {
  return jsonResponse(400, { ok: false, message: 'Diagnostic request was invalid.' });
}

async function issueCapability(request, value, config, dependencies, now) {
  if (!validIssueBody(value)) {
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
  let proofKey;
  let capability;
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
      k: proofKey
    }, config.sessionSecret, randomBytesImpl);
  } catch {
    return withCapabilityCleared(jsonResponse(503, {
      ok: false,
      message: 'Diagnostic authorization could not be created.'
    }));
  }

  return jsonResponse(200, {
    ok: true,
    runId: value.runId,
    proofKey,
    expiresInSeconds
  }, {
    'Set-Cookie': capabilityCookieHeader(capability, expiresInSeconds)
  });
}

function verifyProofs(request, value, config, now) {
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
    config.webhookToken
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

  const config = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url
  });
  if (!config) return withCapabilityCleared(misconfiguredResponse());

  const now = dependencies.now || Date.now();
  if (parsed.value.action === 'issue') {
    return issueCapability(request, parsed.value, config, dependencies, now);
  }
  if (parsed.value.action === 'verify') {
    return verifyProofs(request, parsed.value, config, now);
  }
  return withCapabilityCleared(invalidRequestResponse());
}

export default request => handleAdminTabletDiagnostic(request);
