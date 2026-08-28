import {
  cookieValue,
  jsonResponse,
  readJson
} from './m1-common.mjs';
import { staffClockPairingProfile } from './m1-installation.mjs';
import {
  createProductionDeviceCredential,
  productionAdminInstallerConfig,
  productionDeviceAuthorization,
  productionDeviceCookieHeader
} from './m1-production-runtime.mjs';
import {
  TABLET_PAIRING_DELIVERY_GRACE_SECONDS,
  TABLET_PAIRING_PENDING_COOKIE,
  clearPairingPendingCookieHeader,
  createPairingBlob,
  createPairingPendingToken,
  defaultPairingStore,
  deletePairingBlob,
  emptyPairingRequestRecord,
  isoTimestamp,
  pairingCodeFromRequest,
  pairingCodeIndexKey,
  pairingCodeIndexRecord,
  pairingCredentialHash,
  pairingPendingCookieHeader,
  pairingRandomId,
  pairingRequestKey,
  readPairingBlob,
  readPairingPendingToken,
  reservePairingAdmission,
  updatePairingBlob,
  validExactPairingRequest,
  validPairingCodeIndex,
  validPairingRequestRecord
} from './m1-tablet-pairing.mjs';

const MAX_PAIRING_REQUEST_BYTES = 512;
const CREATE_ATTEMPTS = 4;

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

function unauthorizedResponse() {
  return jsonResponse(401, {
    ok: false,
    result: 'authorization_required',
    message: 'This tablet needs authorization.'
  });
}

function withCookie(response, cookieHeader) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookieHeader);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function pendingEnvelope(record, pairingCode) {
  return {
    ok: true,
    result: 'pending',
    pairingCode,
    expiresAt: isoTimestamp(record.approvalExpiresAt),
    gymName: record.gymName,
    deviceLabel: record.deviceLabel
  };
}

function expiredResponse() {
  return withCookie(jsonResponse(410, {
    ok: false,
    result: 'expired',
    message: 'Pairing code expired. Request a new code.'
  }), clearPairingPendingCookieHeader());
}

async function readPendingState(request, runtime, profile, store, now) {
  const rawToken = cookieValue(request, TABLET_PAIRING_PENDING_COOKIE);
  if (!rawToken) return Object.freeze({ kind: 'missing' });
  const pending = readPairingPendingToken(
    rawToken,
    runtime.installSecret,
    profile,
    now
  );
  if (!pending) return Object.freeze({ kind: 'invalid' });
  const requestKey = pairingRequestKey(profile, pending.requestId, pending.issuedAt);
  const stored = await readPairingBlob(store, requestKey);
  if (!stored) return Object.freeze({ kind: 'invalid' });
  const pairingCode = pairingCodeFromRequest(
    runtime.installSecret,
    profile,
    pending.requestId
  );
  const codeKey = pairingCodeIndexKey(
    runtime.installSecret,
    profile,
    pairingCode
  );
  const expectedCodeHash = codeKey.split('/').at(-1);
  const index = await readPairingBlob(store, codeKey);
  if (
    !index
    || !validPairingCodeIndex(index.value, profile)
    || !validPairingRequestRecord(stored.value, profile)
    || index.value.requestKey !== requestKey
    || index.value.codeHash !== expectedCodeHash
    || index.value.approvalExpiresAt !== stored.value.approvalExpiresAt
    || index.value.purgeAfter !== stored.value.purgeAfter
    || stored.value.requestIdHash !== requestKey.split('/').at(-1)
    || stored.value.codeHash !== expectedCodeHash
    || stored.value.requestedAt !== pending.issuedAt
    || stored.value.approvalExpiresAt !== pending.approvalExpiresAt
  ) return Object.freeze({ kind: 'invalid' });
  return Object.freeze({
    kind: 'found',
    rawToken,
    pending,
    requestKey,
    record: stored.value,
    etag: stored.etag,
    pairingCode
  });
}

async function createPendingState(runtime, profile, store, now, randomBytesImpl) {
  if (!await reservePairingAdmission(store, now)) return null;
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const requestId = pairingRandomId(randomBytesImpl);
    const pairingCode = pairingCodeFromRequest(runtime.installSecret, profile, requestId);
    const record = emptyPairingRequestRecord(
      runtime.installSecret,
      profile,
      requestId,
      pairingCode,
      now
    );
    const requestKey = pairingRequestKey(profile, requestId, record.requestedAt);
    const codeKey = pairingCodeIndexKey(runtime.installSecret, profile, pairingCode);
    const index = pairingCodeIndexRecord(
      profile,
      requestKey,
      record.codeHash,
      record.approvalExpiresAt,
      record.purgeAfter
    );
    if (!await createPairingBlob(store, requestKey, record)) continue;
    if (!await createPairingBlob(store, codeKey, index)) {
      await deletePairingBlob(store, requestKey);
      continue;
    }
    const pendingToken = createPairingPendingToken({
      secret: runtime.installSecret,
      profile,
      requestId,
      issuedAt: record.requestedAt,
      approvalExpiresAt: record.approvalExpiresAt,
      expiresAt: record.approvalExpiresAt + TABLET_PAIRING_DELIVERY_GRACE_SECONDS
    });
    return Object.freeze({ record, pairingCode, pendingToken });
  }
  throw new Error('Tablet pairing request collision.');
}

function deterministicCredential(runtime, record) {
  const nonce = Buffer.from(record.deliveryNonce, 'base64url');
  const credential = createProductionDeviceCredential(
    runtime.deviceToken,
    () => nonce,
    record.credentialIssuedAt * 1_000
  );
  return pairingCredentialHash(credential) === record.credentialHash
    ? credential
    : '';
}

function requestHasDeliveredCredential(request, runtime, record, now) {
  const authorization = productionDeviceAuthorization(request, runtime, now);
  return authorization.authorized
    && pairingCredentialHash(authorization.credential) === record.credentialHash;
}

async function authorizedResponseAfterConsume(request, pendingState, runtime, profile, store, now) {
  const currentSeconds = Math.floor(now / 1_000);
  if (!requestHasDeliveredCredential(request, runtime, pendingState.record, now)) return null;
  const credential = deterministicCredential(runtime, pendingState.record);
  if (!credential) return unavailableResponse();
  if (pendingState.record.status === 'approved') {
    const consumed = {
      ...pendingState.record,
      status: 'consumed',
      consumedAt: currentSeconds
    };
    const updated = await updatePairingBlob(
      store,
      pendingState.requestKey,
      consumed,
      pendingState.etag
    );
    if (!updated) {
      const latest = await readPairingBlob(store, pendingState.requestKey);
      if (
        !latest
        || !validPairingRequestRecord(latest.value, profile)
        || latest.value.status !== 'consumed'
        || latest.value.credentialHash !== pendingState.record.credentialHash
      ) return unavailableResponse();
    }
  } else if (pendingState.record.status !== 'consumed') {
    return unavailableResponse();
  }
  return withCookie(jsonResponse(200, {
    ok: true,
    result: 'authorized'
  }, {
    'Set-Cookie': productionDeviceCookieHeader(credential)
  }), clearPairingPendingCookieHeader());
}

async function pollPairing(request, pendingState, runtime, profile, store, now) {
  if (pendingState.kind === 'missing') return unauthorizedResponse();
  if (pendingState.kind !== 'found') {
    return withCookie(jsonResponse(403, {
      ok: false,
      message: 'Tablet pairing request was not accepted.'
    }), clearPairingPendingCookieHeader());
  }

  const currentSeconds = Math.floor(now / 1_000);
  const stateExpiresAt = pendingState.record.status === 'pending'
    ? pendingState.record.approvalExpiresAt
    : pendingState.record.deliveryExpiresAt;
  if (stateExpiresAt <= currentSeconds) {
    return expiredResponse();
  }

  if (['approved', 'consumed'].includes(pendingState.record.status)) {
    const authorized = await authorizedResponseAfterConsume(
      request,
      pendingState,
      runtime,
      profile,
      store,
      now
    );
    if (authorized) return authorized;
    if (pendingState.record.status === 'consumed') {
      return withCookie(jsonResponse(403, {
        ok: false,
        message: 'Tablet pairing request was not accepted.'
      }), clearPairingPendingCookieHeader());
    }
  }

  if (pendingState.record.status === 'pending') {
    return jsonResponse(200, pendingEnvelope(
      pendingState.record,
      pendingState.pairingCode
    ));
  }
  if (pendingState.record.status !== 'approved') return unavailableResponse();
  const credential = deterministicCredential(runtime, pendingState.record);
  if (!credential) return unavailableResponse();
  return jsonResponse(200, {
    ok: true,
    result: 'approved',
    deliveryExpiresAt: isoTimestamp(pendingState.record.deliveryExpiresAt)
  }, {
    'Set-Cookie': productionDeviceCookieHeader(credential)
  });
}

export async function handleTabletPairingOperation(
  request,
  expectedOperation,
  path,
  dependencies = {}
) {
  if (!['start', 'poll'].includes(expectedOperation)) return notFoundResponse();
  const profile = staffClockPairingProfile(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  );
  if (!profile || !validExactPairingRequest(request, path, profile)) {
    return notFoundResponse();
  }
  const parsed = await readJson(request, MAX_PAIRING_REQUEST_BYTES);
  if (
    parsed.response
    || !parsed.value
    || typeof parsed.value !== 'object'
    || Array.isArray(parsed.value)
    || Object.keys(parsed.value).length !== 1
    || parsed.value.operation !== expectedOperation
  ) return invalidResponse();

  const env = dependencies.env || process.env;
  const runtime = productionAdminInstallerConfig(env, {
    staffClockPairing: true,
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  });
  if (!runtime || runtime.origin !== profile.origin) return unavailableResponse();
  const now = dependencies.now ?? Date.now();
  const deviceAuthorized = productionDeviceAuthorization(request, runtime, now).authorized;
  const pendingCookie = cookieValue(request, TABLET_PAIRING_PENDING_COOKIE);
  if (
    deviceAuthorized
    && (expectedOperation === 'start' || !pendingCookie)
  ) {
    return withCookie(jsonResponse(200, {
      ok: true,
      result: 'authorized'
    }), clearPairingPendingCookieHeader());
  }
  let store;
  let pendingState;
  try {
    store = dependencies.store || await defaultPairingStore();
    pendingState = await readPendingState(request, runtime, profile, store, now);
  } catch {
    return unavailableResponse();
  }

  if (expectedOperation === 'poll') {
    try {
      return await pollPairing(request, pendingState, runtime, profile, store, now);
    } catch {
      return unavailableResponse();
    }
  }

  const currentSeconds = Math.floor(now / 1_000);
  const existingExpiresAt = pendingState.kind === 'found'
    ? pendingState.record.status === 'pending'
      ? pendingState.record.approvalExpiresAt
      : pendingState.record.deliveryExpiresAt
    : 0;
  if (pendingState.kind === 'found' && existingExpiresAt > currentSeconds) {
    try {
      return await pollPairing(request, pendingState, runtime, profile, store, now);
    } catch {
      return unavailableResponse();
    }
  }

  try {
    const created = await createPendingState(
      runtime,
      profile,
      store,
      now,
      dependencies.randomBytes
    );
    if (!created) {
      return jsonResponse(429, {
        ok: false,
        message: 'Too many tablet pairing requests. Try again shortly.'
      });
    }
    return jsonResponse(200, pendingEnvelope(created.record, created.pairingCode), {
      'Set-Cookie': pairingPendingCookieHeader(
        created.pendingToken,
        profile.expiresInSeconds + TABLET_PAIRING_DELIVERY_GRACE_SECONDS
      )
    });
  } catch {
    return unavailableResponse();
  }
}
