import {
  jsonResponse,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig,
  validNonFutureDate
} from './_lib/m1-common.mjs';

export async function handleAdminReview(request, dependencies = {}) {
  const parsed = await readJson(request, 4_096);
  if (parsed.response) return parsed.response;

  const config = runtimeConfig(dependencies.env || process.env, { admin: true });
  const auth = requireAdmin(request, config, dependencies.now || Date.now());
  if (auth.response) return auth.response;

  const date = String(parsed.value.date || '');
  if (!validNonFutureDate(date, dependencies.dateNow || new Date())) {
    return jsonResponse(400, { ok: false, message: 'Choose today or an earlier valid date.' });
  }

  const google = await postGoogle(
    config,
    'dailyReview',
    { date },
    dependencies.fetch || fetch
  );
  if (!google.readable || !google.value || google.value.ok !== true || !Array.isArray(google.value.records)) {
    return jsonResponse(502, { ok: false, message: 'Google did not return a readable daily review.' });
  }

  return jsonResponse(200, {
    ok: true,
    test: config.preview,
    adminName: auth.session.adminName,
    date,
    records: google.value.records
  });
}

export default request => handleAdminReview(request);
