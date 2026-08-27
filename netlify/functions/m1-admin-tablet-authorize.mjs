import { randomBytes } from 'node:crypto';

import {
  jsonResponse,
  readJson,
  requireAdmin,
  runtimeConfig
} from './_lib/m1-common.mjs';
import {
  PRODUCTION_ADMIN_INSTALL_GRANT_MAX_SECONDS,
  createProductionAdminInstallGrant,
  clearProductionAdminInstallGrantCookieHeader,
  productionAdminInstallGrantCookieHeader,
  productionAdminInstallerConfig,
  validExactProductionRequest
} from './_lib/m1-production-runtime.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';

export const ADMIN_TABLET_AUTHORIZE_PATH = '/api/m1-admin-tablet-authorize';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-admin-tablet-authorize',
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_AUTHORIZE_REQUEST_BYTES = 1_024;

function withGrantCleared(response) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', clearProductionAdminInstallGrantCookieHeader());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function notFoundResponse() {
  return jsonResponse(404, {
    ok: false,
    message: 'Not found.'
  });
}

function invalidRequestResponse() {
  return jsonResponse(400, {
    ok: false,
    message: 'Tablet authorization request was invalid.'
  });
}

function unconfiguredResponse() {
  return jsonResponse(503, {
    ok: false,
    message: 'Tablet authorization is not configured.'
  });
}

export async function handleAdminTabletAuthorize(request, dependencies = {}) {
  const profile = deploymentInstallationProfile(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  );
  if (
    profile?.installationId !== 'rev'
    || request.method !== 'POST'
    || !validExactProductionRequest(request, ADMIN_TABLET_AUTHORIZE_PATH)
  ) return notFoundResponse();

  const parsed = await readJson(request, MAX_AUTHORIZE_REQUEST_BYTES);
  if (parsed.response) return withGrantCleared(invalidRequestResponse());
  if (
    !parsed.value
    || typeof parsed.value !== 'object'
    || Array.isArray(parsed.value)
    || Object.keys(parsed.value).length !== 1
    || parsed.value.operation !== 'issue'
  ) return withGrantCleared(invalidRequestResponse());

  const env = dependencies.env || process.env;
  const adminRuntime = runtimeConfig(env, {
    admin: true,
    requestUrl: request.url,
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  });
  const installerRuntime = productionAdminInstallerConfig(env);
  if (!adminRuntime || !installerRuntime) {
    return withGrantCleared(unconfiguredResponse());
  }

  const now = dependencies.now ?? Date.now();
  const auth = requireAdmin(request, adminRuntime, now);
  if (auth.response) return withGrantCleared(auth.response);

  const nowSeconds = Math.floor(now / 1_000);
  const expiresInSeconds = Math.min(
    PRODUCTION_ADMIN_INSTALL_GRANT_MAX_SECONDS,
    auth.session.expiresAt - nowSeconds
  );
  if (expiresInSeconds < 1) {
    return withGrantCleared(jsonResponse(401, {
      ok: false,
      message: 'Admin login required.'
    }));
  }

  let grant;
  try {
    const randomBytesImpl = dependencies.randomBytes || randomBytes;
    const nonceBytes = Buffer.from(randomBytesImpl(32));
    if (nonceBytes.length !== 32) throw new Error('Invalid grant randomness.');
    grant = createProductionAdminInstallGrant({
      secret: installerRuntime.installSecret,
      adminName: auth.session.adminName,
      requestToken: auth.session.requestToken,
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + expiresInSeconds,
      nonce: nonceBytes.toString('base64url')
    });
  } catch {
    return withGrantCleared(jsonResponse(503, {
      ok: false,
      message: 'Tablet authorization could not be created.'
    }));
  }

  return jsonResponse(200, {
    ok: true,
    issued: true,
    expiresInSeconds
  }, {
    'Set-Cookie': productionAdminInstallGrantCookieHeader(grant, expiresInSeconds)
  });
}

export default request => handleAdminTabletAuthorize(request);
