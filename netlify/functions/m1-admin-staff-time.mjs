import {
  googleFailureClass,
  jsonResponse,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig,
  safeText
} from './_lib/m1-common.mjs';
import {
  exactObjectKeys,
  isStaffViewStale,
  sanitizeStaffTimeAdjustmentRequest,
  sanitizeStaffTimeAdjustmentResult,
  sanitizeStaffTimeCorrectionRequest,
  sanitizeStaffTimeCorrectionResult,
  sanitizeStaffTimeHistoryPage,
  sanitizeStaffTimeHistoryPageRequest,
  sanitizeStaffTimeReview,
  sanitizeStaffViewPage,
  sanitizeStaffViewPageRequest,
  sanitizeStaffTimeVoidRequest,
  sanitizeStaffTimeVoidResult
} from './_lib/m1-staff-clock-contracts.mjs';
import { validExactProductionRequest } from './_lib/m1-production-runtime.mjs';
import { staffClockEnabled } from './_lib/m1-installation.mjs';

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
  const label = operation === 'review' || operation === 'reviewPage' || operation === 'historyPage'
    ? operation === 'reviewPage'
      ? 'Staff time review page'
      : operation === 'historyPage'
        ? 'Staff time history page'
        : 'Staff time review'
    : operation === 'correct'
      ? 'Staff time correction'
      : operation === 'adjust'
        ? 'Staff time adjustment'
      : 'Staff time void';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    code: `STAFF_TIME_${operation.toLocaleUpperCase('en-US')}_${failureClass}`,
    message: unreachable
      ? `${label} could not reach Google. Nothing changed.`
      : `${label} did not return a complete readable confirmation. Success is not being reported.`
  });
}

function adminMutationFailureResponse(google, operation) {
  if (
    google?.readable !== true
    || !exactObjectKeys(google.value, ['ok', 'result', 'message'])
    || google.value.ok !== false
    || (google.value.result !== 'rejected' && google.value.result !== 'conflict')
  ) return null;
  const message = safeText(google.value.message, 240);
  if (!message || message !== google.value.message) return null;
  const suffix = google.value.result.toLocaleUpperCase('en-US');
  return jsonResponse(google.value.result === 'conflict' ? 409 : 400, {
    ok: false,
    result: google.value.result,
    code: `STAFF_TIME_${operation.toLocaleUpperCase('en-US')}_${suffix}`,
    message
  });
}

export async function handleAdminStaffTime(request, dependencies = {}) {
  if (!staffClockEnabled(dependencies.installationId)) {
    return jsonResponse(404, { ok: false, message: 'Staff Clock is disabled for this installation.' });
  }
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
    requestUrl: request.url,
    installationId: dependencies.installationId
  });
  if (!runtime || runtime.target !== target) {
    return jsonResponse(503, { ok: false, message: 'Staff time Admin is not configured.' });
  }
  const auth = requireAdmin(request, runtime, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;

  const operation = parsed.value.operation;
  if (
    operation !== 'review'
    && operation !== 'reviewPage'
    && operation !== 'historyPage'
    && operation !== 'correct'
    && operation !== 'adjust'
    && operation !== 'void'
  ) {
    return jsonResponse(400, { ok: false, message: 'Staff time request was rejected.' });
  }
  const fetchImpl = dependencies.fetch || fetch;
  const dateNow = dependencies.dateNow || new Date();

  if (operation === 'review') {
    if (!exactObjectKeys(parsed.value, ['operation'])) {
      return jsonResponse(400, { ok: false, message: 'Staff time review request was rejected.' });
    }
    const google = await postGoogle(runtime, 'staffTimeReviewV2', {}, fetchImpl);
    const review = google.readable
      ? sanitizeStaffTimeReview(google.value, target, { now: dateNow })
      : null;
    if (!review) return adminFailureResponse(google, operation);
    return jsonResponse(200, {
      ok: true,
      test: runtime.preview,
      adminName: auth.session.adminName,
      staff: review.staff,
      clockedInNow: review.clockedInNow,
      periods: review.periods,
      view: review.view
    });
  }

  if (operation === 'reviewPage') {
    const pageRequest = sanitizeStaffViewPageRequest(parsed.value, 'reviewPage', {
      includeAudit: true
    });
    if (!pageRequest) {
      return jsonResponse(400, { ok: false, message: 'Staff time review page was rejected.' });
    }
    const google = await postGoogle(runtime, 'staffTimeReviewPageV2', {
      viewToken: pageRequest.viewToken,
      stream: pageRequest.stream,
      offset: pageRequest.offset
    }, fetchImpl);
    if (google.readable && isStaffViewStale(google.value, target)) {
      return jsonResponse(409, {
        ok: false,
        result: 'stale',
        code: 'STAFF_TIME_VIEW_STALE'
      });
    }
    const page = google.readable
      ? sanitizeStaffViewPage(google.value, target, pageRequest, { now: dateNow })
      : null;
    if (!page) return adminFailureResponse(google, operation);
    return jsonResponse(200, {
      ok: true,
      test: runtime.preview,
      adminName: auth.session.adminName,
      viewToken: page.viewToken,
      stream: page.stream,
      offset: page.offset,
      items: page.items,
      nextOffset: page.nextOffset
    });
  }

  if (operation === 'historyPage') {
    const pageRequest = sanitizeStaffTimeHistoryPageRequest(parsed.value);
    if (!pageRequest) {
      return jsonResponse(400, { ok: false, message: 'Staff time history page was rejected.' });
    }
    const google = await postGoogle(runtime, 'staffTimeHistoryPageV2', {
      viewToken: pageRequest.viewToken,
      offset: pageRequest.offset
    }, fetchImpl);
    if (google.readable && isStaffViewStale(google.value, target)) {
      return jsonResponse(409, {
        ok: false,
        result: 'stale',
        code: 'STAFF_TIME_VIEW_STALE'
      });
    }
    const page = google.readable
      ? sanitizeStaffTimeHistoryPage(google.value, target, pageRequest, { now: dateNow })
      : null;
    if (!page) return adminFailureResponse(google, operation);
    return jsonResponse(200, {
      ok: true,
      test: runtime.preview,
      adminName: auth.session.adminName,
      viewToken: page.viewToken,
      offset: page.offset,
      total: page.total,
      items: page.items,
      nextOffset: page.nextOffset
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
    const mutationFailure = adminMutationFailureResponse(google, operation);
    if (mutationFailure) return mutationFailure;
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

  if (operation === 'adjust') {
    const value = sanitizeStaffTimeAdjustmentRequest(parsed.value, { now: dateNow });
    if (!value) {
      return jsonResponse(400, {
        ok: false,
        result: 'rejected',
        message: 'Choose one valid completed shift, corrected times, and a required reason.'
      });
    }
    const expected = Object.freeze({
      ...value,
      adminName: auth.session.adminName
    });
    const google = await postGoogle(runtime, 'staffTimeAdjust', {
      requestId: expected.requestId,
      clockInPunchId: expected.clockInPunchId,
      clockOutPunchId: expected.clockOutPunchId,
      originalClockInAt: expected.originalClockInAt,
      originalClockOutAt: expected.originalClockOutAt,
      correctedClockInAt: expected.correctedClockInAt,
      correctedClockOutAt: expected.correctedClockOutAt,
      reason: expected.reason,
      adminName: expected.adminName
    }, fetchImpl);
    const mutationFailure = adminMutationFailureResponse(google, operation);
    if (mutationFailure) return mutationFailure;
    const result = google.readable
      ? sanitizeStaffTimeAdjustmentResult(google.value, expected, target, { now: dateNow })
      : null;
    if (!result) return adminFailureResponse(google, operation);
    return jsonResponse(200, {
      ok: true,
      test: runtime.preview,
      adminName: auth.session.adminName,
      operation,
      requestId: result.requestId,
      result: result.result,
      linkedPunchIds: result.linkedPunchIds,
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
  const mutationFailure = adminMutationFailureResponse(google, operation);
  if (mutationFailure) return mutationFailure;
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
