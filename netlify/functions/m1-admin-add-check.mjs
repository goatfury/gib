import { jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { managerReviewScope } from './_lib/m1-manager-scope.mjs';
import { safeAdditionTraceId } from './_lib/m1-google-trace.mjs';
import { REMOVAL_VERSION } from './_lib/m1-revolution-removal.mjs';
import { additionReceiptFromDailyReview } from './_lib/m1-admin-add-check.mjs';
import { validateAddition } from './m1-admin-add.mjs';
import { handleAdminReview } from './m1-admin-review.mjs';

export const config = { path: '/api/m1-admin-add-check', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
const ORIGINS = Object.freeze({ test: 'https://deploy-preview-89--gib-live.netlify.app', production: 'https://gib-live.netlify.app' });
const unconfirmed = (status = 409) => jsonResponse(status, { ok: false, result: 'unconfirmed', code: 'ADMIN_ADD_CHECK_UNCONFIRMED',
  message: 'The original save is still unconfirmed. Keep this request; do not submit another addition.' });

export async function handleAdminAddCheck(request, dependencies = {}) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, message: 'Use the original saved request.' });
  if (url.pathname !== config.path || url.search || url.hash) return jsonResponse(403, { ok: false, message: 'This confirmation check is unavailable on this deployment.' });
  const scope = managerReviewScope(request, dependencies);
  if (!scope || scope.profile.installationId !== 'rev' || url.origin !== ORIGINS[scope.target]) return jsonResponse(403, { ok: false, message: 'This confirmation check is unavailable on this deployment.' });
  const target = scope.target;
  const profile = scope.profile;
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url,
    installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
  if (runtime?.target !== target) return unconfirmed(503);
  const auth = requireAdmin(request, runtime, dependencies.now ?? Date.now());
  if (auth.response) return auth.response;
  const parsed = await readJson(request, 8192);
  if (parsed.response) return parsed.response;
  const original = validateAddition(parsed.value, runtime, dependencies.dateNow || new Date());
  if (!original || !safeAdditionTraceId(original.requestId) || original.site !== 'Rev'
    || (target === 'production' && !original.requestId.startsWith('m1-'))
    || Object.keys(original).some(key => original[key] !== parsed.value[key])
    || (original.requestId.startsWith('m1-') && original.requestId.slice(3, 13) !== original.date)) {
    return jsonResponse(400, { ok: false, message: 'Use the exact original Revolution addition request.' });
  }
  try {
    const headers = new Headers(request.headers);
    headers.set('Content-Type', 'application/json');
    headers.delete('content-length');
    const dailyRequest = new Request(new URL('/.netlify/functions/m1-admin-review', request.url), {
      method: 'POST', headers, body: JSON.stringify({ date: original.date, ...(target === 'production' ? { removalVersion: REMOVAL_VERSION } : {}) })
    });
    const dailyResponse = await handleAdminReview(dailyRequest, { ...dependencies,
      installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
    if (!dailyResponse.ok) return unconfirmed(503);
    const receipt = additionReceiptFromDailyReview(await dailyResponse.json(), original, auth.session.adminName, target);
    if (!receipt) return unconfirmed();
    return jsonResponse(200, { ok: true, test: target === 'test', ...receipt, message: 'Instructor added.' });
  } catch { return unconfirmed(503); }
}

export default (request, context) => handleAdminAddCheck(request, { context, env: process.env });
