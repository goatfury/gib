import {
  clean,
  googleFailureClass,
  jsonResponse,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig,
  validNonFutureDate
} from './_lib/m1-common.mjs';
import { sanitizeDailyReviewPayload } from './_lib/m1-admin-contracts.mjs';

function reviewFailureResponse(google) {
  const failureClass = googleFailureClass(google);
  const unreachable = failureClass === 'UNREACHABLE';
  const message = unreachable
    ? 'Daily Review could not reach Google. Nothing changed.'
    : failureClass === 'REJECTED'
      ? 'The Daily Review connection was rejected. Nothing changed.'
      : failureClass === 'FAILED'
        ? 'Google could not complete Daily Review. Nothing changed.'
        : 'Google returned an incomplete Daily Review response. Nothing changed.';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    code: `DAILY_REVIEW_${failureClass}`,
    message
  });
}

function exactDateRequest(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, 'date')
    && typeof value.date === 'string';
}

export async function handleAdminReview(request, dependencies = {}) {
  const parsed = await readJson(request, 4_096);
  if (parsed.response) return parsed.response;

  const config = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url,
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  });
  const auth = requireAdmin(request, config, dependencies.now || Date.now());
  if (auth.response) return auth.response;

  if (!exactDateRequest(parsed.value)) {
    return jsonResponse(400, { ok: false, message: 'Choose today or an earlier valid date.' });
  }
  const date = parsed.value.date;
  if (date !== clean(date) || !validNonFutureDate(date, dependencies.dateNow || new Date())) {
    return jsonResponse(400, { ok: false, message: 'Choose today or an earlier valid date.' });
  }

  const google = await postGoogle(
    config,
    'dailyReview',
    { date },
    dependencies.fetch || fetch
  );
  const review = google.readable && google.value && google.value.ok === true
    ? sanitizeDailyReviewPayload(google.value, date, {
      allowInstructorSigninVoid: config.installationId === 'richmond'
        && config.environment === 'production'
    })
    : null;
  if (!review) return reviewFailureResponse(google);

  return jsonResponse(200, {
    ok: true,
    test: config.preview,
    adminName: auth.session.adminName,
    date,
    records: review.records,
    warnings: review.warnings,
    auditHistory: review.auditHistory
  });
}

export default request => handleAdminReview(request);
