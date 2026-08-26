import {
  googleFailureClass,
  jsonResponse,
  obviousRichmondProductionTestValue,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig
} from './_lib/m1-common.mjs';
import {
  sanitizeInstructorSigninVoidRequest,
  sanitizeInstructorSigninVoidResult
} from './_lib/m1-admin-contracts.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import { validExactRichmondProductionRequest } from './_lib/m1-richmond-production-runtime.mjs';

export const ADMIN_VOID_PATH = '/.netlify/functions/m1-admin-void';

export const config = {
  path: '/.netlify/functions/m1-admin-void',
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_REQUEST_BYTES = 4_096;

function exactActiveRichmondProfile(profile) {
  return profile?.schema === 'gib-m1-installation-profile/v1'
    && profile.installationId === 'richmond'
    && profile.environment === 'production'
    && profile.allowedOrigin === 'https://gib-richmond-live.netlify.app'
    && profile.activation === 'active'
    && profile.writesEnabled === true
    && profile.featureFlags?.staffClock === false
    && profile.backend?.enabled === true
    && profile.backend.transportTarget === 'richmond-production';
}

function exactActiveRichmondRuntime(runtime) {
  return runtime?.installationId === 'richmond'
    && runtime.environment === 'production'
    && runtime.target === 'production'
    && runtime.preview === false
    && runtime.writesEnabled === true;
}

function voidFailureResponse(google) {
  const failureClass = googleFailureClass(google);
  const unreachable = failureClass === 'UNREACHABLE';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    result: 'failed',
    code: `ADMIN_VOID_${failureClass}`,
    message: unreachable
      ? 'The instructor sign-in void could not reach Google. Success is not being reported.'
      : failureClass === 'REJECTED'
        ? 'Google rejected the instructor sign-in void. Success is not being reported.'
        : failureClass === 'FAILED'
          ? 'Google could not complete the instructor sign-in void. Success is not being reported.'
          : 'Google returned an incomplete void confirmation. Success is not being reported.'
  });
}

export async function handleAdminVoid(request, dependencies = {}) {
  const profile = deploymentInstallationProfile(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  );
  if (!exactActiveRichmondProfile(profile)) {
    return jsonResponse(404, {
      ok: false,
      result: 'rejected',
      message: 'Instructor sign-in void is unavailable for this installation.'
    });
  }
  if (!validExactRichmondProductionRequest(request, ADMIN_VOID_PATH)) {
    return jsonResponse(403, {
      ok: false,
      result: 'rejected',
      message: 'Exact same-origin Richmond production Admin request required.'
    });
  }

  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.response) return parsed.response;

  const runtime = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url,
    installationId: profile.installationId,
    environment: profile.environment,
    activation: profile.activation
  });
  if (!exactActiveRichmondRuntime(runtime)) {
    return jsonResponse(503, {
      ok: false,
      result: 'rejected',
      message: 'Richmond production writes are not fully active.'
    });
  }

  const auth = requireAdmin(request, runtime, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;

  const value = sanitizeInstructorSigninVoidRequest(
    parsed.value,
    auth.session.adminName
  );
  if (!value) {
    return jsonResponse(400, {
      ok: false,
      result: 'rejected',
      message: 'Choose one valid Richmond instructor sign-in and enter the required reason.'
    });
  }

  const google = await postGoogle(
    runtime,
    'voidInstructorSignin',
    {
      requestId: value.requestId,
      rowId: value.rowId,
      adminName: auth.session.adminName,
      reason: value.reason
    },
    dependencies.fetch || fetch
  );
  const result = google.readable
    ? sanitizeInstructorSigninVoidResult(google.value, value)
    : null;
  if (
    !result
    || obviousRichmondProductionTestValue(result.confirmation.instructor)
  ) return voidFailureResponse(google);

  return jsonResponse(200, {
    ok: true,
    test: false,
    adminName: auth.session.adminName,
    operation: 'void',
    requestId: result.requestId,
    result: result.result,
    linkedRecordId: result.linkedRecordId,
    auditActionNumber: result.auditActionNumber,
    confirmation: result.confirmation,
    message: result.result === 'voided'
      ? 'Instructor sign-in voided.'
      : 'This instructor sign-in was already voided. No second audit action was created.'
  });
}

export default request => handleAdminVoid(request);
