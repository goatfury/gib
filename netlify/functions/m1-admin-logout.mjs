import {
  clearAdminCookieHeader,
  jsonResponse,
  requireAdmin,
  runtimeConfig
} from './_lib/m1-common.mjs';

export async function handleAdminLogout(request, dependencies = {}) {
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, message: 'Method not allowed.' });
  }
  const config = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url,
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  });
  const auth = requireAdmin(request, config, dependencies.now || Date.now());
  if (auth.response) return auth.response;
  return jsonResponse(200, { ok: true }, {
    'Set-Cookie': clearAdminCookieHeader()
  });
}

export default request => handleAdminLogout(request);
