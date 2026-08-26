import {
  jsonResponse,
  nyDate,
  postGoogle,
  readJson
} from './_lib/m1-common.mjs';
import {
  RICHMOND_INSTRUCTOR_SIGNIN_VOID_ELIGIBILITY_VERSION,
  sanitizeDailyReviewPayload
} from './_lib/m1-admin-contracts.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import {
  richmondProductionRuntimeConfig,
  validExactRichmondProductionRequest
} from './_lib/m1-richmond-production-runtime.mjs';

export const PRODUCTION_STATUS_PATH = '/api/m1-production-status';

export const config = {
  // Netlify extracts function routing metadata statically during the build.
  path: '/api/m1-production-status'
};

export async function handleProductionStatus(request, dependencies = {}) {
  if (!validExactRichmondProductionRequest(request, PRODUCTION_STATUS_PATH)) {
    return jsonResponse(404, { ok: false, message: 'Not found.' });
  }

  const parsed = await readJson(request, 512);
  if (parsed.response) return parsed.response;
  if (Object.keys(parsed.value).length !== 0) {
    return jsonResponse(400, { ok: false, message: 'The status request was not accepted.' });
  }

  const activation = dependencies.activation;
  const profile = deploymentInstallationProfile('richmond', 'production', activation);
  if (
    !profile
    || profile.activation !== 'pending'
    || profile.writesEnabled !== false
  ) return jsonResponse(404, { ok: false, message: 'Not found.' });

  const runtime = richmondProductionRuntimeConfig(
    dependencies.env || process.env,
    request.url,
    {
      admin: true,
      installationId: 'richmond',
      environment: 'production',
      activation
    }
  );
  if (!runtime || runtime.writesEnabled !== false) {
    return jsonResponse(503, { ok: false, message: 'Production status is unavailable.' });
  }

  const date = nyDate(dependencies.dateNow || new Date());
  const google = await postGoogle(
    runtime,
    'dailyReview',
    {
      date,
      voidEligibilityVersion: RICHMOND_INSTRUCTOR_SIGNIN_VOID_ELIGIBILITY_VERSION
    },
    dependencies.fetch || fetch
  );
  const review = google.readable && google.value
    ? sanitizeDailyReviewPayload(google.value, date, {
      allowInstructorSigninVoid: true
    })
    : null;
  if (!review) {
    return jsonResponse(502, { ok: false, message: 'Production status is unavailable.' });
  }
  return jsonResponse(200, {
    ok: true,
    empty: review.records.length === 0
      && review.warnings.length === 0
      && review.auditHistory.length === 0,
    writesEnabled: false
  });
}

export default request => handleProductionStatus(request);
