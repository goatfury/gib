import {
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

export const ADMIN_STAFF_ROSTER_PATH = '/.netlify/functions/m1-admin-staff-roster';

export const config = {
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_REQUEST_BYTES = 4_096;
const DEPLOY_PREVIEW_HOST = /^(?:deploy-preview-\d+|[0-9a-f]{24})--gib-live\.netlify\.app$/iu;

const CONFLICT_MESSAGES = Object.freeze({
  duplicate_active: 'That staff member is already active.',
  reactivate_required: 'That staff member already exists but is inactive. Use Reactivate on the existing record.',
  already_active: 'That staff member is already active. Refresh the roster before trying again.',
  already_inactive: 'That staff member is already inactive. Refresh the roster before trying again.',
  not_found: 'That staff member is no longer in the roster. Refresh and try again.',
  last_active: 'The only active staff member cannot be deactivated.',
  clocked_in: 'This staff member is clocked in and cannot be deactivated.',
  request_conflict: 'This roster request conflicts with an earlier action. Refresh and try again.',
  capacity: 'The TEST Staff Roster has reached its safe staff limit.'
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
  if (host && host.toLocaleLowerCase('en-US') !== url.host.toLocaleLowerCase('en-US')) {
    return false;
  }
  if (request.headers.get('origin') !== url.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin';
}

function failureResponse(google, operation) {
  const failureClass = googleFailureClass(google);
  const unreachable = failureClass === 'UNREACHABLE';
  const label = operation === 'list' ? 'Staff Roster' : 'Staff Roster change';
  return jsonResponse(unreachable ? 504 : 502, {
    ok: false,
    code: `STAFF_ROSTER_${operation.toLocaleUpperCase('en-US')}_${failureClass}`,
    message: unreachable
      ? `${label} could not reach Google. Nothing changed.`
      : `${label} did not return a complete readable confirmation. Success is not being reported.`
  });
}

function conflictResponse(conflict) {
  return jsonResponse(409, {
    ok: false,
    result: 'conflict',
    code: conflict.code,
    message: CONFLICT_MESSAGES[conflict.code]
  });
}

export async function handleAdminStaffRoster(request, dependencies = {}) {
  if (!validPreviewSameOriginRequest(request)) {
    return jsonResponse(403, {
      ok: false,
      message: 'Same-origin TEST Staff Roster request required.'
    });
  }

  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.response) return parsed.response;

  const runtime = runtimeConfig(dependencies.env || process.env, {
    admin: true,
    requestUrl: request.url
  });
  if (!runtime || runtime.preview !== true || runtime.target !== 'test') {
    return jsonResponse(503, {
      ok: false,
      message: 'TEST Staff Roster Admin is not configured.'
    });
  }
  const auth = requireAdmin(request, runtime, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;

  const value = sanitizeStaffRosterRequest(parsed.value, { requireTestName: true });
  if (!value) {
    return jsonResponse(400, {
      ok: false,
      result: 'rejected',
      message: 'The TEST Staff Roster request was rejected.'
    });
  }

  const fetchImpl = dependencies.fetch || fetch;
  if (value.operation === 'list') {
    const google = await postGoogle(runtime, 'staffRosterList', {}, fetchImpl);
    const roster = google.readable
      ? sanitizeStaffRosterList(google.value, 'test')
      : null;
    if (!roster) return failureResponse(google, value.operation);
    return jsonResponse(200, {
      ok: true,
      test: true,
      adminName: auth.session.adminName,
      staff: roster.staff
    });
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
    ? sanitizeStaffRosterConflict(google.value, 'test')
    : null;
  if (conflict) return conflictResponse(conflict);

  const result = google.readable
    ? sanitizeStaffRosterMutation(google.value, expected, 'test')
    : null;
  if (!result) return failureResponse(google, value.operation);
  return jsonResponse(200, {
    ok: true,
    test: true,
    adminName: auth.session.adminName,
    operation: result.operation,
    requestId: result.requestId,
    result: result.result,
    confirmation: result.confirmation
  });
}

export default request => handleAdminStaffRoster(request);
