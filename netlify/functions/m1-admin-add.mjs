import {
  jsonResponse,
  obviousTestValue,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig,
  safeText,
  validNonFutureDate
} from './_lib/m1-common.mjs';

function validateAddition(input, config, now) {
  const value = {
    requestId: safeText(input.requestId, 160),
    date: String(input.date || ''),
    classLabel: safeText(input.classLabel, 200),
    duration: Number(input.duration),
    instructor: safeText(input.instructor, 100),
    site: safeText(input.site, 80),
    notes: String(input.notes == null ? '' : input.notes).normalize('NFKC').trim().slice(0, 400),
    reason: safeText(input.reason, 240)
  };
  if (
    !value.requestId
    || !validNonFutureDate(value.date, now)
    || !value.classLabel
    || !Number.isFinite(value.duration)
    || value.duration <= 0
    || value.duration > 8
    || !value.instructor
    || !value.site
    || value.reason.length < 3
    || /^[=+\-@]/.test(value.notes)
  ) {
    return null;
  }
  if (config.preview && !obviousTestValue(value.instructor)) return null;
  return value;
}

export async function handleAdminAdd(request, dependencies = {}) {
  const parsed = await readJson(request, 8_192);
  if (parsed.response) return parsed.response;

  const config = runtimeConfig(dependencies.env || process.env, { admin: true });
  const auth = requireAdmin(request, config, dependencies.now || Date.now());
  if (auth.response) return auth.response;

  const value = validateAddition(
    parsed.value,
    config,
    dependencies.dateNow || new Date()
  );
  if (!value) {
    return jsonResponse(400, {
      ok: false,
      result: 'rejected',
      message: config.preview
        ? 'Use safe fake TEST information, a required reason, and a non-future date.'
        : 'The missed-instructor addition was rejected.'
    });
  }

  const google = await postGoogle(
    config,
    'addMissedInstructor',
    {
      adminName: auth.session.adminName,
      ...value
    },
    dependencies.fetch || fetch
  );
  if (!google.readable || !google.value || google.value.ok !== true) {
    return jsonResponse(502, {
      ok: false,
      result: 'failed',
      message: 'Google did not return a clear successful result.'
    });
  }

  const result = String(google.value.result || '');
  if (!['added', 'already exists'].includes(result)) {
    return jsonResponse(result === 'rejected' ? 400 : 502, {
      ok: false,
      result: result || 'failed',
      message: google.value.message || 'The missed-instructor addition did not succeed.'
    });
  }

  return jsonResponse(200, {
    ok: true,
    test: config.preview,
    result,
    linkedRecordId: String(google.value.linkedRecordId || ''),
    auditActionNumber: Number(google.value.auditActionNumber || 0),
    message: result === 'added'
      ? 'Instructor added.'
      : 'The same class already has this instructor. No second payroll row was created.'
  });
}

export default request => handleAdminAdd(request);
