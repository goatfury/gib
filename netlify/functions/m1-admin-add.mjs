import {
  clean,
  googleFailureClass,
  jsonResponse,
  obviousTestValue,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig,
  safeText,
  validNonFutureDate
} from './_lib/m1-common.mjs';
import { sanitizeAdminAdditionPayload } from './_lib/m1-admin-contracts.mjs';

function additionFailureResponse(google) {
  const failureClass = googleFailureClass(google);
  const unreachable = failureClass === 'UNREACHABLE';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    result: 'failed',
    code: `ADMIN_ADD_${failureClass}`,
    message: unreachable
      ? 'The forgotten-instructor correction could not reach Google. Success is not being reported.'
      : failureClass === 'REJECTED'
        ? 'Google rejected the forgotten-instructor correction. Success is not being reported.'
        : failureClass === 'FAILED'
          ? 'Google could not complete the forgotten-instructor correction. Success is not being reported.'
          : 'Google returned an incomplete correction confirmation. Success is not being reported.'
  });
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function validateAddition(input, config, now) {
  if (
    !exactKeys(input, [
      'requestId', 'date', 'classLabel', 'duration', 'instructor', 'site', 'notes', 'reason'
    ])
    || typeof input.requestId !== 'string'
    || typeof input.date !== 'string'
    || typeof input.classLabel !== 'string'
    || typeof input.duration !== 'number'
    || typeof input.instructor !== 'string'
    || typeof input.site !== 'string'
    || typeof input.notes !== 'string'
    || typeof input.reason !== 'string'
  ) return null;
  const notes = clean(input.notes);
  const value = {
    requestId: safeText(input.requestId, 160),
    date: String(input.date || ''),
    classLabel: safeText(input.classLabel, 200),
    duration: Number(input.duration),
    instructor: safeText(input.instructor, 100),
    site: safeText(input.site, 80),
    notes,
    reason: safeText(input.reason, 240)
  };
  if (
    !value.requestId
    || value.date !== clean(input.date)
    || !validNonFutureDate(value.date, now)
    || !value.classLabel
    || !Number.isFinite(value.duration)
    || value.duration <= 0
    || value.duration > 8
    || !value.instructor
    || !value.site
    || value.reason.length < 3
    || value.notes.length > 400
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

  const config = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url
  });
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
  const confirmation = google.readable && google.value && google.value.ok === true
    ? sanitizeAdminAdditionPayload(google.value, {
      requestId: value.requestId,
      adminName: auth.session.adminName,
      date: value.date,
      classLabel: value.classLabel,
      duration: value.duration,
      instructor: value.instructor,
      site: value.site,
      reason: value.reason,
      notes: value.notes
    })
    : null;
  if (!confirmation) return additionFailureResponse(google);

  return jsonResponse(200, {
    ok: true,
    test: config.preview,
    result: confirmation.result,
    requestId: confirmation.requestId,
    linkedRecordId: confirmation.linkedRecordId,
    linkedDisplayId: confirmation.linkedDisplayId,
    auditActionNumber: confirmation.auditActionNumber,
    confirmation: confirmation.confirmation,
    message: confirmation.result === 'added'
      ? 'Instructor added.'
      : 'The same class already has this instructor. No second payroll row was created.'
  });
}

export default request => handleAdminAdd(request);
