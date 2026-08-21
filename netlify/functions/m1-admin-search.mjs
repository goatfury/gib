import {
  clean,
  googleFailureClass,
  jsonResponse,
  nyDate,
  obviousTestValue,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig,
  safeText,
  validNonFutureDate
} from './_lib/m1-common.mjs';
import { sanitizeInstructorSearchPayload } from './_lib/m1-admin-contracts.mjs';

function searchFailureResponse(google) {
  const failureClass = googleFailureClass(google);
  const unreachable = failureClass === 'UNREACHABLE';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    code: `INSTRUCTOR_SEARCH_${failureClass}`,
    message: unreachable
      ? 'Instructor search could not reach Google. Nothing changed.'
      : failureClass === 'REJECTED'
        ? 'The instructor-search connection was rejected. Nothing changed.'
        : failureClass === 'FAILED'
          ? 'Google could not complete the instructor search. Nothing changed.'
          : 'Google returned an incomplete instructor-search response. Nothing changed.'
  });
}

function exactSearchRequest(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 2
    && Object.hasOwn(value, 'instructor')
    && Object.hasOwn(value, 'date')
    && typeof value.instructor === 'string'
    && typeof value.date === 'string';
}

export async function handleAdminSearch(request, dependencies = {}) {
  const parsed = await readJson(request, 4_096);
  if (parsed.response) return parsed.response;

  const config = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url,
    installationId: dependencies.installationId
  });
  const auth = requireAdmin(request, config, dependencies.now || Date.now());
  if (auth.response) return auth.response;

  if (!exactSearchRequest(parsed.value)) {
    return jsonResponse(400, { ok: false, message: 'Enter an instructor and choose a non-future date.' });
  }
  const instructor = safeText(parsed.value.instructor, 100);
  const date = parsed.value.date;
  if (
    !instructor
    || instructor !== parsed.value.instructor
    || date !== clean(date)
    || !validNonFutureDate(date, dependencies.dateNow || new Date())
  ) {
    return jsonResponse(400, { ok: false, message: 'Enter an instructor and choose a non-future date.' });
  }
  if (config.preview && !obviousTestValue(instructor)) {
    return jsonResponse(400, { ok: false, message: 'Use clearly fake TEST instructor information.' });
  }

  const google = await postGoogle(
    config,
    'instructorSearch',
    { instructor, date },
    dependencies.fetch || fetch
  );
  const search = google.readable && google.value && google.value.ok === true
    ? sanitizeInstructorSearchPayload(
      google.value,
      instructor,
      date,
      nyDate(dependencies.dateNow || new Date())
    )
    : null;
  if (!search) return searchFailureResponse(google);

  return jsonResponse(200, {
    ok: true,
    test: config.preview,
    adminName: auth.session.adminName,
    instructor,
    date,
    selectedDateRecords: search.selectedDateRecords,
    recentRecords: search.recentRecords
  });
}

export default request => handleAdminSearch(request);
