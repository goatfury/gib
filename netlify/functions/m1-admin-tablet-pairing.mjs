import {
  cookieValue,
  jsonResponse,
  readJson,
  requireAdmin,
  runtimeConfig
} from './_lib/m1-common.mjs';
import { staffClockPairingProfile } from './_lib/m1-installation.mjs';
import {
  createProductionDeviceCredential,
  productionAdminInstallerConfig
} from './_lib/m1-production-runtime.mjs';
import {
  TABLET_PAIRING_DELIVERY_GRACE_SECONDS,
  TABLET_PAIRING_PENDING_COOKIE,
  TABLET_PAIRING_REVIEW_MAX_SECONDS,
  TABLET_PAIRING_REVIEW_COOKIE,
  clearPairingReviewCookieHeader,
  createPairingReviewToken,
  defaultPairingStore,
  isoTimestamp,
  normalizePairingCode,
  pairingApproverHash,
  pairingCodeIndexKey,
  pairingCredentialHash,
  pairingRandomId,
  pairingRequestKey,
  pairingReviewCookieHeader,
  readPairingBlob,
  readPairingPendingToken,
  readPairingReviewToken,
  updatePairingBlob,
  validExactPairingRequest,
  validPairingCodeIndex,
  validPairingRequestKeyForRecord,
  validPairingRequestRecord
} from './_lib/m1-tablet-pairing.mjs';

export const ADMIN_TABLET_PAIRING_PATH = '/api/m1-admin-tablet-pairing';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-admin-tablet-pairing',
  rateLimit: {
    windowLimit: 10,
    windowSize: 300,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_ADMIN_PAIRING_REQUEST_BYTES = 1_024;

function notFoundResponse() {
  return jsonResponse(404, { ok: false, message: 'Not found.' });
}

function invalidResponse() {
  return jsonResponse(400, {
    ok: false,
    message: 'Tablet pairing request was invalid.'
  });
}

function unavailableResponse() {
  return jsonResponse(503, {
    ok: false,
    message: 'Tablet pairing is temporarily unavailable.'
  });
}

function rejectedCodeResponse(status = 404) {
  return jsonResponse(status, {
    ok: false,
    message: 'Pairing code was not accepted.'
  });
}

function expiredCodeResponse() {
  return jsonResponse(410, {
    ok: false,
    result: 'expired',
    message: 'Pairing code expired. Request a new code.'
  });
}

function withReviewCleared(response) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', clearPairingReviewCookieHeader());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readPendingByCode(store, runtime, profile, pairingCode, now) {
  const codeKey = pairingCodeIndexKey(runtime.installSecret, profile, pairingCode);
  const index = await readPairingBlob(store, codeKey);
  if (!index || !validPairingCodeIndex(index.value, profile)) return null;
  const expectedCodeHash = codeKey.split('/').at(-1);
  if (index.value.codeHash !== expectedCodeHash) return null;
  const request = await readPairingBlob(store, index.value.requestKey);
  if (
    !request
    || !validPairingRequestRecord(request.value, profile)
    || !validPairingRequestKeyForRecord(index.value.requestKey, request.value)
    || request.value.requestIdHash !== index.value.requestKey.split('/').at(-1)
    || request.value.codeHash !== expectedCodeHash
    || request.value.approvalExpiresAt !== index.value.approvalExpiresAt
    || request.value.purgeAfter !== index.value.purgeAfter
  ) return null;
  const currentSeconds = Math.floor(now / 1_000);
  if (
    request.value.status === 'pending'
    && request.value.approvalExpiresAt <= currentSeconds
  ) {
    return Object.freeze({ kind: 'expired' });
  }
  if (
    request.value.status !== 'pending'
    && request.value.deliveryExpiresAt <= currentSeconds
  ) {
    return Object.freeze({ kind: 'expired' });
  }
  return Object.freeze({
    kind: request.value.status,
    codeKey,
    codeHash: expectedCodeHash,
    requestKey: index.value.requestKey,
    record: request.value,
    etag: request.etag
  });
}

function approvedEnvelope(record) {
  return {
    ok: true,
    result: 'approved',
    installationId: record.installationId,
    gymName: record.gymName,
    deviceLabel: record.deviceLabel,
    approvedAt: isoTimestamp(record.approvedAt)
  };
}

function requestOwnsPendingTablet(request, runtime, profile, pending, now) {
  const token = readPairingPendingToken(
    cookieValue(request, TABLET_PAIRING_PENDING_COOKIE),
    runtime.installSecret,
    profile,
    now
  );
  return Boolean(
    token
    && !token.expired
    && pairingRequestKey(profile, token.requestId, token.issuedAt) === pending.requestKey
  );
}

async function reviewPairing(request, value, runtime, profile, session, store, now) {
  const pairingCode = normalizePairingCode(value.pairingCode);
  if (!pairingCode) return withReviewCleared(rejectedCodeResponse());
  const pending = await readPendingByCode(store, runtime, profile, pairingCode, now);
  if (pending?.kind === 'expired') {
    return withReviewCleared(expiredCodeResponse());
  }
  if (!pending || pending.kind !== 'pending') {
    return withReviewCleared(rejectedCodeResponse());
  }
  if (requestOwnsPendingTablet(request, runtime, profile, pending, now)) {
    return withReviewCleared(rejectedCodeResponse(403));
  }
  const currentSeconds = Math.floor(now / 1_000);
  const expiresInSeconds = Math.min(
    TABLET_PAIRING_REVIEW_MAX_SECONDS,
    pending.record.approvalExpiresAt - currentSeconds,
    session.expiresAt - currentSeconds
  );
  if (expiresInSeconds < 1) return withReviewCleared(rejectedCodeResponse());

  let reviewToken;
  try {
    reviewToken = createPairingReviewToken({
      secret: runtime.installSecret,
      profile,
      requestKey: pending.requestKey,
      codeHash: pending.codeHash,
      session,
      issuedAt: currentSeconds,
      expiresAt: currentSeconds + expiresInSeconds
    });
  } catch {
    return withReviewCleared(unavailableResponse());
  }
  return jsonResponse(200, {
    ok: true,
    result: 'pending',
    installationId: pending.record.installationId,
    gymName: pending.record.gymName,
    origin: pending.record.origin,
    deviceLabel: pending.record.deviceLabel,
    requestedAt: isoTimestamp(pending.record.requestedAt),
    expiresAt: isoTimestamp(pending.record.approvalExpiresAt)
  }, {
    'Set-Cookie': pairingReviewCookieHeader(reviewToken, expiresInSeconds)
  });
}

async function approvePairing(request, value, runtime, profile, session, store, now, randomBytesImpl) {
  const pairingCode = normalizePairingCode(value.pairingCode);
  if (!pairingCode) return withReviewCleared(rejectedCodeResponse());
  const pending = await readPendingByCode(store, runtime, profile, pairingCode, now);
  if (pending?.kind === 'expired') {
    return withReviewCleared(expiredCodeResponse());
  }
  const review = readPairingReviewToken(
    cookieValue(request, TABLET_PAIRING_REVIEW_COOKIE),
    runtime.installSecret,
    profile,
    session,
    now
  );
  if (
    !pending
    || !review
    || !['pending', 'approved', 'consumed'].includes(pending.kind)
    || review.requestKey !== pending.requestKey
    || review.codeHash !== pending.codeHash
  ) return withReviewCleared(rejectedCodeResponse(403));
  if (requestOwnsPendingTablet(request, runtime, profile, pending, now)) {
    return withReviewCleared(rejectedCodeResponse(403));
  }

  const approverHash = pairingApproverHash(runtime.installSecret, session);
  if (['approved', 'consumed'].includes(pending.kind)) {
    if (pending.record.approvedByHash !== approverHash) {
      return withReviewCleared(rejectedCodeResponse(409));
    }
    return jsonResponse(200, approvedEnvelope(pending.record));
  }

  const currentSeconds = Math.floor(now / 1_000);
  let approved;
  try {
    const deliveryNonce = pairingRandomId(randomBytesImpl);
    const credential = createProductionDeviceCredential(
      runtime.deviceToken,
      () => Buffer.from(deliveryNonce, 'base64url'),
      currentSeconds * 1_000
    );
    approved = {
      ...pending.record,
      status: 'approved',
      approvedAt: currentSeconds,
      approvedByHash: approverHash,
      credentialIssuedAt: currentSeconds,
      deliveryNonce,
      credentialHash: pairingCredentialHash(credential),
      deliveryExpiresAt: currentSeconds + TABLET_PAIRING_DELIVERY_GRACE_SECONDS
    };
  } catch {
    return withReviewCleared(unavailableResponse());
  }
  if (!validPairingRequestRecord(approved, profile)) {
    return withReviewCleared(unavailableResponse());
  }
  const updated = await updatePairingBlob(
    store,
    pending.requestKey,
    approved,
    pending.etag
  );
  if (!updated) {
    const latest = await readPendingByCode(store, runtime, profile, pairingCode, now);
    if (
      ['approved', 'consumed'].includes(latest?.kind)
      && latest.record.approvedByHash === approverHash
      && review.requestKey === latest.requestKey
      && review.codeHash === latest.codeHash
    ) return jsonResponse(200, approvedEnvelope(latest.record));
    return withReviewCleared(rejectedCodeResponse(409));
  }
  return jsonResponse(200, approvedEnvelope(approved));
}

export async function handleAdminTabletPairing(request, dependencies = {}) {
  const profile = staffClockPairingProfile(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  );
  if (!profile || !validExactPairingRequest(request, ADMIN_TABLET_PAIRING_PATH, profile)) {
    return notFoundResponse();
  }
  const parsed = await readJson(request, MAX_ADMIN_PAIRING_REQUEST_BYTES);
  if (
    parsed.response
    || !parsed.value
    || typeof parsed.value !== 'object'
    || Array.isArray(parsed.value)
    || !['review', 'approve'].includes(parsed.value.operation)
    || Object.keys(parsed.value).length !== 2
    || typeof parsed.value.pairingCode !== 'string'
  ) return withReviewCleared(invalidResponse());

  const env = dependencies.env || process.env;
  const adminRuntime = runtimeConfig(env, {
    admin: true,
    requestUrl: request.url,
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  });
  const runtime = productionAdminInstallerConfig(env, {
    staffClockPairing: true,
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  });
  if (!adminRuntime || !runtime || runtime.origin !== profile.origin) {
    return withReviewCleared(unavailableResponse());
  }
  const now = dependencies.now ?? Date.now();
  const auth = requireAdmin(request, adminRuntime, now);
  if (auth.response) return withReviewCleared(auth.response);

  let store;
  try {
    store = dependencies.store || await defaultPairingStore();
    if (parsed.value.operation === 'review') {
      return await reviewPairing(
        request,
        parsed.value,
        runtime,
        profile,
        auth.session,
        store,
        now
      );
    }
    return await approvePairing(
      request,
      parsed.value,
      runtime,
      profile,
      auth.session,
      store,
      now,
      dependencies.randomBytes
    );
  } catch {
    return withReviewCleared(unavailableResponse());
  }
}

export default request => handleAdminTabletPairing(request);
