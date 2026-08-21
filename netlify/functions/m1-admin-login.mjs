import {
  ADMIN_NAMES,
  adminCookieHeader,
  constantTimeEqual,
  createAdminRequestToken,
  createAdminSession,
  jsonResponse,
  readJson,
  runtimeConfig,
  safeText
} from './_lib/m1-common.mjs';

export async function handleAdminLogin(request, dependencies = {}) {
  const parsed = await readJson(request, 4_096);
  if (parsed.response) return parsed.response;

  const env = dependencies.env || process.env;
  const config = runtimeConfig(env, {
    admin: true,
    requestUrl: request.url,
    installationId: dependencies.installationId
  });
  if (!config) {
    return jsonResponse(503, { ok: false, message: 'Admin service is not configured for this environment.' });
  }

  const adminName = safeText(parsed.value.adminName, 80);
  if (!ADMIN_NAMES.includes(adminName)) {
    return jsonResponse(400, { ok: false, message: 'Choose an Admin name.' });
  }

  const testShortcut = parsed.value.testShortcut === true;
  const accepted = config.preview
    ? testShortcut
    : !testShortcut && constantTimeEqual(parsed.value.passphrase, config.adminPassphrase);
  if (!accepted) {
    return jsonResponse(401, { ok: false, message: 'Admin login was not accepted.' });
  }

  const requestToken = createAdminRequestToken(dependencies.randomBytes);
  const session = createAdminSession(
    adminName,
    config.sessionSecret,
    dependencies.now || Date.now(),
    requestToken
  );
  return jsonResponse(200, {
    ok: true,
    adminName,
    test: config.preview,
    requestToken,
    expiresInSeconds: 1_800
  }, {
    'Set-Cookie': adminCookieHeader(session)
  });
}

export default request => handleAdminLogin(request);
