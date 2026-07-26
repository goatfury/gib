import {
  clearAdminCookieHeader,
  jsonResponse
} from './_lib/m1-common.mjs';

export async function handleAdminLogout(request) {
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, message: 'Method not allowed.' });
  }
  return jsonResponse(200, { ok: true }, {
    'Set-Cookie': clearAdminCookieHeader()
  });
}

export default request => handleAdminLogout(request);
