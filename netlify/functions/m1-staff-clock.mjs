import {
  jsonResponse,
  postGoogle,
  readJson,
  runtimeConfig,
  safeText
} from './_lib/m1-common.mjs';
import {
  MAX_STAFF_CLOCK_PUNCHES,
  STAFF_PUNCH_ID_PATTERN,
  exactObjectKeys,
  isStaffViewStale,
  rejectedPunchResult,
  sanitizeStaffClockPunch,
  sanitizeStaffClockSnapshot,
  sanitizeStaffClockSyncResults,
  sanitizeStaffRecoveryRequest,
  sanitizeStaffRecoveryResponse,
  sanitizeStaffViewPage,
  sanitizeStaffViewPageRequest
} from './_lib/m1-staff-clock-contracts.mjs';
import {
  productionDeviceAuthorization,
  productionDeviceCookieHeader,
  productionRuntimeConfig,
  validExactProductionRequest
} from './_lib/m1-production-runtime.mjs';
import { staffClockEnabled } from './_lib/m1-installation.mjs';
import { managerReviewScope } from './_lib/m1-manager-scope.mjs';

export const STAFF_CLOCK_PATH = '/api/m1-staff-clock';

export const config = {
  // Netlify extracts this custom route statically during the build.
  path: '/api/m1-staff-clock',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_REQUEST_BYTES = 128_000;
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
    || url.pathname !== STAFF_CLOCK_PATH
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

function previewRuntimeConfig(env, requestUrl) {
  const runtime = runtimeConfig(env, { requestUrl });
  return runtime && runtime.preview === true
    ? Object.freeze({ ...runtime, adminActionToken: '' })
    : null;
}

function successBody(target, body) {
  return { ok: true, target, ...body };
}

function upstreamFailure(target, google, operation) {
  const label = target === 'test' ? 'TEST' : 'Production';
  const timedOut = google?.status === 0;
  return jsonResponse(timedOut ? 504 : 502, {
    ok: false,
    message: timedOut
      ? `${label} Staff Clock ${operation} timed out or could not be reached.`
      : `${label} Staff Clock ${operation} did not return a complete readable confirmation.`
  });
}

function duplicatePunchIds(punches) {
  const seen = new Set();
  for (const punch of punches) {
    const id = typeof punch?.punchId === 'string' && STAFF_PUNCH_ID_PATTERN.test(punch.punchId)
      ? punch.punchId
      : '';
    if (!id) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

export async function handleStaffClock(request, dependencies = {}) {
  const profileOptions = {
    staffClock: true,
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  };
  if (!staffClockEnabled(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  )) {
    return jsonResponse(404, { ok: false, message: 'Staff Clock is disabled for this installation.' });
  }
  const target = validPreviewSameOriginRequest(request)
    ? 'test'
    : validExactProductionRequest(request, STAFF_CLOCK_PATH, profileOptions)
      ? 'production'
      : '';
  if (!target) {
    return jsonResponse(403, { ok: false, message: 'Same-origin Staff Clock request required.' });
  }

  const env = dependencies.env || process.env;
  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.response) return parsed.response;
  const operation = parsed.value.operation;
  const recoveryOperation = operation === 'recoveryRead' || operation === 'recover';
  if (recoveryOperation) {
    const scope = managerReviewScope(request, dependencies);
    if (target !== 'test' || scope?.target !== 'test' || scope.profile.installationId !== 'rev'
      || new URL(request.url).origin !== 'https://deploy-preview-89--gib-live.netlify.app') {
      return jsonResponse(404, { ok: false, message: 'Staff recovery is disabled for this installation.' });
    }
  }
  let runtime = null;
  let productionDeviceCredential = '';
  if (target === 'production') {
    runtime = productionRuntimeConfig(env, profileOptions);
    if (!runtime) {
      return jsonResponse(403, { ok: false, message: 'Production Staff Clock is not configured.' });
    }
    const device = productionDeviceAuthorization(
      request,
      runtime,
      dependencies.now ?? Date.now()
    );
    if (!device.authorized) {
      return jsonResponse(401, {
        ok: false,
        message: 'Production device authorization required.'
      });
    }
    productionDeviceCredential = device.credential;
  }

  if (operation !== 'snapshot' && operation !== 'snapshotPage' && operation !== 'sync' && !recoveryOperation) {
    return jsonResponse(400, { ok: false, message: 'Staff Clock request was rejected.' });
  }
  if (target === 'test') runtime = previewRuntimeConfig(env, request.url);
  if (!runtime) {
    return jsonResponse(503, {
      ok: false,
      message: target === 'test'
        ? 'TEST Staff Clock is not configured.'
        : 'Production Staff Clock is not configured.'
    });
  }

  if (recoveryOperation) {
    const options = { requireTestName: true, now: dependencies.dateNow || new Date() };
    const value = operation === 'recover' ? sanitizeStaffRecoveryRequest(parsed.value, options) : null;
    if (operation === 'recover' ? !value : !exactObjectKeys(parsed.value, ['operation'])) {
      return jsonResponse(400, { ok: false, message: 'Staff recovery request was rejected.' });
    }
    const data = value ? { recovery: { requestId: value.requestId, previousClockInPunchId: value.previousClockInPunchId,
      punch: value.punch, proposedFinishAt: value.proposedFinishAt } } : {};
    const google = await postGoogle(runtime, value ? 'staffRecoveryStart' : 'staffRecoveryRead', data, dependencies.fetch || fetch);
    if (value && google.readable && exactObjectKeys(google.value, ['ok', 'result', 'message'])
      && google.value.ok === false && ['conflict', 'rejected'].includes(google.value.result)
      && safeText(google.value.message, 240) && safeText(google.value.message, 240) === google.value.message) {
      return jsonResponse(google.value.result === 'conflict' ? 409 : 400, { ...google.value });
    }
    // The receiver may save after the request-time clock. Validate its receipt
    // against delivery time, while leaving incoming punch validation unchanged.
    const result = google.readable
      ? sanitizeStaffRecoveryResponse(google.value, target, {
        ...options, now: new Date((dependencies.clock || Date.now)()), expected: value
      }) : null;
    if (!result) return upstreamFailure(target, google, operation);
    return jsonResponse(200, successBody(target, result));
  }

  if (operation === 'snapshot') {
    if (!exactObjectKeys(parsed.value, ['operation'])) {
      return jsonResponse(400, { ok: false, message: 'Staff Clock snapshot request was rejected.' });
    }
    const google = await postGoogle(
      runtime,
      'staffClockSnapshotV2',
      {},
      dependencies.fetch || fetch
    );
    const snapshot = google.readable
      ? sanitizeStaffClockSnapshot(google.value, target, {
        now: dependencies.dateNow || new Date()
      })
      : null;
    if (!snapshot) return upstreamFailure(target, google, 'snapshot');
    return jsonResponse(200, successBody(target, {
      staff: snapshot.staff,
      clockedInNow: snapshot.clockedInNow,
      periods: snapshot.periods,
      view: snapshot.view
    }), target === 'production'
      ? { 'Set-Cookie': productionDeviceCookieHeader(productionDeviceCredential) }
      : {});
  }

  if (operation === 'snapshotPage') {
    const pageRequest = sanitizeStaffViewPageRequest(parsed.value, 'snapshotPage');
    if (!pageRequest) {
      return jsonResponse(400, { ok: false, message: 'Staff Clock page request was rejected.' });
    }
    const google = await postGoogle(
      runtime,
      'staffClockSnapshotPageV2',
      {
        viewToken: pageRequest.viewToken,
        stream: pageRequest.stream,
        offset: pageRequest.offset
      },
      dependencies.fetch || fetch
    );
    if (google.readable && isStaffViewStale(google.value, target)) {
      return jsonResponse(409, {
        ok: false,
        result: 'stale',
        code: 'STAFF_CLOCK_VIEW_STALE'
      });
    }
    const page = google.readable
      ? sanitizeStaffViewPage(google.value, target, pageRequest, {
        now: dependencies.dateNow || new Date()
      })
      : null;
    if (!page) return upstreamFailure(target, google, 'snapshot page');
    return jsonResponse(200, successBody(target, {
      viewToken: page.viewToken,
      stream: page.stream,
      offset: page.offset,
      items: page.items,
      nextOffset: page.nextOffset
    }), target === 'production'
      ? { 'Set-Cookie': productionDeviceCookieHeader(productionDeviceCredential) }
      : {});
  }

  if (
    !exactObjectKeys(parsed.value, ['operation', 'punches'])
    || !Array.isArray(parsed.value.punches)
    || parsed.value.punches.length < 1
    || parsed.value.punches.length > MAX_STAFF_CLOCK_PUNCHES
  ) {
    return jsonResponse(400, { ok: false, message: 'Staff Clock punches were rejected.' });
  }
  if (duplicatePunchIds(parsed.value.punches)) {
    return jsonResponse(400, { ok: false, message: 'Duplicate Staff Clock punch IDs were rejected.' });
  }

  const now = dependencies.dateNow || new Date();
  const validated = parsed.value.punches.map(punch => sanitizeStaffClockPunch(punch, {
    requireTestName: target === 'test',
    now
  }));
  const forwarded = validated.filter(Boolean);
  const localResults = validated.map((punch, index) => (
    punch ? null : rejectedPunchResult(parsed.value.punches[index])
  ));
  if (!forwarded.length) {
    return jsonResponse(200, successBody(target, { results: localResults }), target === 'production'
      ? { 'Set-Cookie': productionDeviceCookieHeader(productionDeviceCredential) }
      : {});
  }

  const google = await postGoogle(
    runtime,
    'staffClockPunch',
    { punches: forwarded },
    dependencies.fetch || fetch
  );
  const results = google.readable
    ? sanitizeStaffClockSyncResults(google.value, forwarded, target)
    : null;
  if (!results) return upstreamFailure(target, google, 'sync');
  const byPunchId = new Map(results.map(result => [result.punchId, result]));
  return jsonResponse(200, successBody(target, {
    results: validated.map((punch, index) => (
      punch ? byPunchId.get(punch.punchId) : localResults[index]
    ))
  }), target === 'production'
    ? { 'Set-Cookie': productionDeviceCookieHeader(productionDeviceCredential) }
    : {});
}

export default (request, context) => handleStaffClock(request, { context });
