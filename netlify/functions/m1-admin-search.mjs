import {
  jsonResponse,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig,
  safeText,
  validNonFutureDate
} from './_lib/m1-common.mjs';

export async function handleAdminSearch(request, dependencies = {}) {
  const parsed = await readJson(request, 4_096);
  if (parsed.response) return parsed.response;

  const config = runtimeConfig(dependencies.env || process.env, { admin: true });
  const auth = requireAdmin(request, config, dependencies.now || Date.now());
  if (auth.response) return auth.response;

  const instructor = safeText(parsed.value.instructor, 100);
  const date = String(parsed.value.date || '');
  if (!instructor || !validNonFutureDate(date, dependencies.dateNow || new Date())) {
    return jsonResponse(400, { ok: false, message: 'Enter an instructor and choose a non-future date.' });
  }

  const google = await postGoogle(
    config,
    'instructorSearch',
    { instructor, date },
    dependencies.fetch || fetch
  );
  if (
    !google.readable
    || !google.value
    || google.value.ok !== true
    || !Array.isArray(google.value.selectedDateRecords)
    || !Array.isArray(google.value.recentRecords)
  ) {
    return jsonResponse(502, { ok: false, message: 'Google did not return a readable instructor search.' });
  }

  return jsonResponse(200, {
    ok: true,
    test: config.preview,
    adminName: auth.session.adminName,
    instructor,
    date,
    selectedDateRecords: google.value.selectedDateRecords,
    recentRecords: google.value.recentRecords.slice(0, 5)
  });
}

export default request => handleAdminSearch(request);
