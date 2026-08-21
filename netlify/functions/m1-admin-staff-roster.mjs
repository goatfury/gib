import {
  clean,
  googleFailureClass,
  jsonResponse,
  postGoogle,
  readJson,
  requireAdmin,
  runtimeConfig
} from './_lib/m1-common.mjs';
import {
  sanitizeStaffRosterConflict,
  sanitizeStaffRosterList,
  sanitizeStaffRosterMutation,
  sanitizeStaffRosterRequest
} from './_lib/m1-staff-roster-contracts.mjs';
import { validExactProductionRequest } from './_lib/m1-production-runtime.mjs';

export const ADMIN_STAFF_ROSTER_PATH = '/.netlify/functions/m1-admin-staff-roster';

export const config = {
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_REQUEST_BYTES = 4_096;
const DEPLOY_PREVIEW_HOST = /^(?:deploy-preview-\d+|[0-9a-f]{24})--gib-live\.netlify\.app$/u;
const PRIVATE_ENV_KEYS = Object.freeze([
  'GIB_TEST_WEBHOOK_URL',
  'GIB_TEST_WEBHOOK_TOKEN',
  'GIB_TEST_ADMIN_ACTION_TOKEN',
  'GIB_TEST_LEGACY_KIOSK_TOKEN',
  'GIB_M1_PRODUCTION_WEBHOOK_URL',
  'GIB_M1_PRODUCTION_WEBHOOK_TOKEN',
  'GIB_M1_ADMIN_ACTION_TOKEN',
  'GIB_M1_ADMIN_PASSPHRASE',
  'GIB_M1_LEGACY_KIOSK_TOKEN',
  'GIB_M1_WEBHOOK_URL',
  'GIB_M1_WEBHOOK_TOKEN',
  'GIB_M1_RECOVERY_TOKEN',
  'GIB_M1_PRODUCTION_DEVICE_TOKEN',
  'GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET'
]);

const CONFLICT_MESSAGES = Object.freeze({
  duplicate_active: 'That staff member is already active.',
  reactivate_required: 'That staff member already exists but is inactive. Use Reactivate on the existing record.',
  already_active: 'That staff member is already active. Refresh the roster before trying again.',
  already_inactive: 'That staff member is already inactive. Refresh the roster before trying again.',
  not_found: 'That staff member is no longer in the roster. Refresh and try again.',
  last_active: 'The only active staff member cannot be deactivated.',
  clocked_in: 'This staff member is clocked in and cannot be deactivated.',
  request_conflict: 'This roster request conflicts with an earlier action. Refresh and try again.',
  capacity: 'The Staff Roster has reached its safe staff limit.'
});

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
    || url.pathname !== ADMIN_STAFF_ROSTER_PATH
    || url.search
    || url.hash
    || !DEPLOY_PREVIEW_HOST.test(url.hostname)
  ) return false;
  const host = request.headers.get('host');
  if (
    typeof host !== 'string'
    || host.toLocaleLowerCase('en-US') !== url.host.toLocaleLowerCase('en-US')
  ) return false;
  if (request.headers.get('origin') !== url.origin) return false;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

function configuredPrivateValues(env) {
  const values = new Set();
  for (const key of PRIVATE_ENV_KEYS) {
    const raw = typeof env?.[key] === 'string' ? env[key] : '';
    if (raw) values.add(raw);
    const normalized = clean(raw);
    if (normalized) values.add(normalized);
  }
  return values;
}

function containsConfiguredPrivateValue(body, env) {
  const browserText = JSON.stringify(body);
  if (typeof browserText !== 'string') return true;
  for (const value of configuredPrivateValues(env)) {
    if (browserText.includes(value)) return true;
  }
  return false;
}

function browserJsonResponse(status, body, env) {
  if (!containsConfiguredPrivateValue(body, env)) return jsonResponse(status, body);
  const rejected = {
    ok: false,
    code: 'STAFF_ROSTER_PRIVATE_VALUE',
    message: 'Staff Roster did not return a safe readable confirmation. Success is not being reported.'
  };
  return containsConfiguredPrivateValue(rejected, env)
    ? new Response(null, {
      status: 502,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      }
    })
    : jsonResponse(502, rejected);
}

function failureResponse(google, operation) {
  const failureClass = googleFailureClass(google);
  const unreachable = failureClass === 'UNREACHABLE';
  const label = operation === 'list' ? 'Staff Roster' : 'Staff Roster change';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    code: `STAFF_ROSTER_${operation.toLocaleUpperCase('en-US')}_${failureClass}`,
    message: unreachable
      ? operation === 'list'
        ? 'Staff Roster could not reach Google. Nothing changed.'
        : 'Staff Roster change outcome is unconfirmed. Retry this exact action with the same request ID.'
      : `${label} did not return a complete readable confirmation. Success is not being reported.`
  });
}

function conflictResponse(conflict, runtime, env) {
  return browserJsonResponse(409, {
    ok: false,
    test: runtime.preview,
    result: 'conflict',
    code: conflict.code,
    message: CONFLICT_MESSAGES[conflict.code]
  }, env);
}

export async function handleAdminStaffRoster(request, dependencies = {}) {
  const target = validPreviewSameOriginRequest(request)
    ? 'test'
    : validExactProductionRequest(request, ADMIN_STAFF_ROSTER_PATH)
      ? 'production'
      : '';
  if (!target) {
    return jsonResponse(403, {
      ok: false,
      message: 'Same-origin Staff Roster request required.'
    });
  }

  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.response) return parsed.response;

  const env = dependencies.env || process.env;
  const runtime = runtimeConfig(env, {
    admin: true,
    requestUrl: request.url
  });
  if (!runtime || runtime.target !== target || runtime.preview !== (target === 'test')) {
    return jsonResponse(503, {
      ok: false,
      message: 'Staff Roster Admin is not configured.'
    });
  }
  const auth = requireAdmin(request, runtime, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;

  const value = sanitizeStaffRosterRequest(parsed.value, { target });
  if (!value) {
    return jsonResponse(400, {
      ok: false,
      result: 'rejected',
      message: 'The Staff Roster request was rejected.'
    });
  }

  const fetchImpl = dependencies.fetch || fetch;
  if (value.operation === 'list') {
    const google = await postGoogle(runtime, 'staffRosterList', {}, fetchImpl);
    const roster = google.readable
      ? sanitizeStaffRosterList(google.value, target)
      : null;
    if (!roster) return failureResponse(google, value.operation);
    return browserJsonResponse(200, {
      ok: true,
      test: runtime.preview,
      adminName: auth.session.adminName,
      staff: roster.staff
    }, env);
  }

  const expected = Object.freeze({
    ...value,
    adminName: auth.session.adminName
  });
  const google = await postGoogle(runtime, 'staffRosterMutate', {
    operation: expected.operation,
    requestId: expected.requestId,
    adminName: expected.adminName,
    ...(expected.operation === 'add'
      ? { staffName: expected.staffName }
      : { staffId: expected.staffId })
  }, fetchImpl);
  const conflict = google.readable
    ? sanitizeStaffRosterConflict(google.value, target)
    : null;
  if (conflict) return conflictResponse(conflict, runtime, env);

  const result = google.readable
    ? sanitizeStaffRosterMutation(google.value, expected, target)
    : null;
  if (!result) return failureResponse(google, value.operation);
  return browserJsonResponse(200, {
    ok: true,
    test: runtime.preview,
    adminName: auth.session.adminName,
    operation: result.operation,
    requestId: result.requestId,
    result: result.result,
    confirmation: result.confirmation
  }, env);
}

export default request => handleAdminStaffRoster(request);
