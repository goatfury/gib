import { jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { managerReviewScope } from './_lib/m1-manager-scope.mjs';
import { safeAdditionTraceId } from './_lib/m1-google-trace.mjs';
import { additionReceiptFromDailyReview } from './_lib/m1-admin-add-check.mjs';
import { validateAddition } from './m1-admin-add.mjs';
import { handleAdminReview } from './m1-admin-review.mjs';

export const config = { path: '/api/m1-admin-add-check', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
const TEST_ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
const unconfirmed = (status = 409) => jsonResponse(status, { ok: false, result: 'unconfirmed', code: 'ADMIN_ADD_CHECK_UNCONFIRMED',
  message: 'The original save is still unconfirmed. Keep this request; do not submit another addition.' });

export async function handleAdminAddCheck(request, dependencies = {}) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, message: 'Use the original saved request.' });
  if (url.origin !== TEST_ORIGIN || url.pathname !== config.path || url.search || url.hash) return jsonResponse(403, { ok: false, message: 'This confirmation check is Revolution TEST-only.' });
  const scope = managerReviewScope(request, dependencies);
  if (scope?.target !== 'test' || scope.profile.installationId !== 'rev') return jsonResponse(403, { ok: false, message: 'This confirmation check is Revolution TEST-only.' });
  const profile = scope.profile;
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url,
    installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
  if (runtime?.target !== 'test') return unconfirmed(503);
  const auth = requireAdmin(request, runtime, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;
  const parsed = await readJson(request, 8192);
  if (parsed.response) return parsed.response;
  const original = validateAddition(parsed.value, runtime, dependencies.dateNow || new Date());
  if (!original || !safeAdditionTraceId(original.requestId) || original.site !== 'Rev'
    || Object.keys(original).some(key => original[key] !== parsed.value[key])
    || (original.requestId.startsWith('m1-') && original.requestId.slice(3, 13) !== original.date)) {
    return jsonResponse(400, { ok: false, message: 'Use the exact original Revolution TEST addition request.' });
  }
  try {
    const headers = new Headers(request.headers);
    headers.set('Content-Type', 'application/json');
    headers.delete('content-length');
    const dailyRequest = new Request(new URL('/.netlify/functions/m1-admin-review', request.url), {
      method: 'POST', headers, body: JSON.stringify({ date: original.date })
    });
    const dailyResponse = await handleAdminReview(dailyRequest, { ...dependencies,
      installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
    if (!dailyResponse.ok) return unconfirmed(503);
    const receipt = additionReceiptFromDailyReview(await dailyResponse.json(), original, auth.session.adminName);
    if (!receipt) return unconfirmed();
    return jsonResponse(200, { ok: true, test: true, ...receipt, message: 'Instructor added.' });
  } catch { return unconfirmed(503); }
}

export default (request, context) => handleAdminAddCheck(request, { context, env: process.env });
