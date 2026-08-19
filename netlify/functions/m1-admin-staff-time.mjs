import {
  googleFailureClass,
  jsonResponse,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig
} from './_lib/m1-common.mjs';
import {
  exactObjectKeys,
  sanitizeStaffTimeCorrectionRequest,
  sanitizeStaffTimeCorrectionResult,
  sanitizeStaffTimeReview,
  sanitizeStaffTimeVoidRequest,
  sanitizeStaffTimeVoidResult
} from './_lib/m1-staff-clock-contracts.mjs';
import { validExactProductionRequest } from './_lib/m1-production-runtime.mjs';

export const ADMIN_STAFF_TIME_PATH = '/.netlify/functions/m1-admin-staff-time';
export const ADMIN_STAFF_TIME_SITE = 'Rev';
export const ADMIN_STAFF_TIME_DEVICE = 'Admin Staff Time';
export const ADMIN_STAFF_TIME_BUILD = 'm1b-staff-clock';

export const config = {
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_REQUEST_BYTES = 16_384;
const DEPLOY_PREVIEW_HOST = /^(?:deploy-preview-\d+|[0-9a-f]{24})--gib-live\.netlify\.app$/u;

function validPreviewSameOriginRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.pathname !== ADMIN_STAFF_TIME_PATH
    || url.search
    || url.hash
    || !DEPLOY_PREVIEW_HOST.test(url.hostname)
  ) return false;
  const host = request.headers.get('host');
  if (host && host.toLocaleLowerCase('en-US') !== url.host.toLocaleLowerCase('en-US')) return false;
  if (request.headers.get('origin') !== url.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin';
}

function adminFailureResponse(google, operation) {
  const failureClass = googleFailureClass(google);
  const unreachable = failureClass === 'UNREACHABLE';
  const label = operation === 'review'
    ? 'Staff time review'
    : operation === 'correct'
      ? 'Staff time correction'
      : 'Staff time void';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    code: `STAFF_TIME_${operation.toLocaleUpperCase('en-US')}_${failureClass}`,
    message: unreachable
      ? `${label} could not reach Google. Nothing changed.`
      : `${label} did not return a complete readable confirmation. Success is not being reported.`
  });
}

export async function handleAdminStaffTime(request, dependencies = {}) {
  const target = validPreviewSameOriginRequest(request)
    ? 'test'
    : validExactProductionRequest(request, ADMIN_STAFF_TIME_PATH)
      ? 'production'
      : '';
  if (!target) {
    return jsonResponse(403, { ok: false, message: 'Same-origin Staff time request required.' });
  }
  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.response) return parsed.response;

  const runtime = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url
  });
  if (!runtime || runtime.target !== target) {
    return jsonResponse(503, { ok: false, message: 'Staff time Admin is not configured.' });
  }
  const auth = requireAdmin(request, runtime, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;

  const operation = parsed.value.operation;
  if (operation !== 'review' && operation !== 'correct' && operation !== 'void') {
    return jsonResponse(400, { ok: false, message: 'Staff time request was rejected.' });
  }
  const fetchImpl = dependencies.fetch || fetch;
  const dateNow = dependencies.dateNow || new Date();

  if (operation === 'review') {
    if (!exactObjectKeys(parsed.value, ['operation'])) {
      return jsonResponse(400, { ok: false, message: 'Staff time review request was rejected.' });
    }
    const google = await postGoogle(runtime, 'staffTimeReview', {}, fetchImpl);
    const review = google.readable
      ? sanitizeStaffTimeReview(google.value, target, { now: dateNow })
      : null;
    if (!review) return adminFailureResponse(google, operation);
    return jsonResponse(200, {
      ok: true,
      test: runtime.preview,
      adminName: auth.session.adminName,
      staff: review.staff,
      records: review.records,
      audit: review.audit,
      clockedInNow: review.clockedInNow,
      todayPunches: review.todayPunches,
      needsAttention: review.needsAttention,
      periods: review.periods
    });
  }

  if (operation === 'correct') {
    const value = sanitizeStaffTimeCorrectionRequest(parsed.value, {
      requireTestName: target === 'test',
      now: dateNow
    });
    if (!value) {
      return jsonResponse(400, {
        ok: false,
        result: 'rejected',
        message: target === 'test'
          ? 'Use a valid fake TEST staff correction and required reason.'
          : 'The Staff time correction was rejected.'
      });
    }
    const expected = Object.freeze({
      ...value,
      adminName: auth.session.adminName,
      site: ADMIN_STAFF_TIME_SITE,
      device: ADMIN_STAFF_TIME_DEVICE,
      build: ADMIN_STAFF_TIME_BUILD
    });
    const google = await postGoogle(runtime, 'staffTimeCorrect', {
      requestId: expected.requestId,
      punchId: expected.punchId,
      staffId: expected.staffId,
      staffName: expected.staffName,
      punchAction: expected.punchAction,
      timestamp: expected.timestamp,
      date: expected.date,
      reason: expected.reason,
      adminName: expected.adminName,
      site: expected.site,
      device: expected.device,
      build: expected.build
    }, fetchImpl);
    const result = google.readable
      ? sanitizeStaffTimeCorrectionResult(google.value, expected, target)
      : null;
    if (!result) return adminFailureResponse(google, operation);
    return jsonResponse(200, {
      ok: true,
      test: runtime.preview,
      adminName: auth.session.adminName,
      operation,
      requestId: result.requestId,
      result: result.result,
      linkedPunchId: result.linkedPunchId,
      auditActionNumber: result.auditActionNumber,
      confirmation: result.confirmation
    });
  }

  const value = sanitizeStaffTimeVoidRequest(parsed.value);
  if (!value) {
    return jsonResponse(400, {
      ok: false,
      result: 'rejected',
      message: 'Choose one valid Staff time punch and enter a required reason.'
    });
  }
  const expected = Object.freeze({
    ...value,
    adminName: auth.session.adminName
  });
  const google = await postGoogle(runtime, 'staffTimeVoid', {
    requestId: expected.requestId,
    punchId: expected.punchId,
    reason: expected.reason,
    adminName: expected.adminName
  }, fetchImpl);
  const result = google.readable
    ? sanitizeStaffTimeVoidResult(google.value, expected, target, { now: dateNow })
    : null;
  if (!result) return adminFailureResponse(google, operation);
  return jsonResponse(200, {
    ok: true,
    test: runtime.preview,
    adminName: auth.session.adminName,
    operation,
    requestId: result.requestId,
    result: result.result,
    linkedPunchId: result.linkedPunchId,
    auditActionNumber: result.auditActionNumber,
    confirmation: result.confirmation
  });
}

export default request => handleAdminStaffTime(request);
