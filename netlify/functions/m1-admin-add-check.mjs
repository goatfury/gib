import { jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { managerReviewScope } from './_lib/m1-manager-scope.mjs';
import { safeAdditionTraceId } from './_lib/m1-google-trace.mjs';
import { additionCheckHash, validateAdditionCheckCallback } from './_lib/m1-admin-add-check-proof.mjs';
import { readCallbackTicket, validId, createReadTrace, READ_ID_HEADER } from './_lib/m1-test-read-callback.mjs';
import { localNow } from './_lib/m1-manager-review.mjs';
import { validateAddition } from './m1-admin-add.mjs';
import { assembleManagerRead } from './m1-manager-review.mjs';

export const config = { path: '/api/m1-admin-add-check', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
const ORIGINS = Object.freeze({ test: 'https://deploy-preview-89--gib-live.netlify.app', production: 'https://gib-live.netlify.app' });
const unconfirmed = (status = 409, code = 'ADMIN_ADD_CHECK_UNCONFIRMED') => jsonResponse(status, { ok: false, result: 'unconfirmed', code,
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
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return unconfirmed(400);
  const { readRequest, ...additionInput } = parsed.value;
  if (!readRequest || typeof readRequest !== 'object' || Array.isArray(readRequest)
    || Object.keys(readRequest).sort().join('|') !== 'operation|requestId'
    || !['start', 'status'].includes(readRequest.operation) || !validId(readRequest.requestId)) return unconfirmed(400);
  const trace = createReadTrace(readRequest.requestId, dependencies, request.headers.get(READ_ID_HEADER));
  const readDependencies = { ...dependencies, readTrace: trace };
  const notConfirmed = (status = 409, code) => { trace('addition.response', 'unconfirmed', status); return unconfirmed(status, code); };
  const original = validateAddition(additionInput, runtime, dependencies.dateNow || new Date());
  if (!original || !safeAdditionTraceId(original.requestId) || original.site !== 'Rev'
    || (target === 'production' && !original.requestId.startsWith('m1-'))
    || Object.keys(original).some(key => original[key] !== additionInput[key])
    || (original.requestId.startsWith('m1-') && original.requestId.slice(3, 13) !== original.date)) {
    trace('addition.validation', 'failed', 400);
    trace('addition.response', 'rejected', 400);
    return jsonResponse(400, { ok: false, message: 'Use the exact original Revolution addition request.' });
  }
  try {
    additionCheckHash(original, auth.session.adminName, target);
    trace('addition.validation', 'ok');
    const ticket = await readCallbackTicket(request, runtime, auth.session.adminName,
      { ...readRequest, action: 'adminAdditionCheckRead', original }, readDependencies);
    if (ticket.state !== 'received') { trace('addition.response', 'pending', 202); return jsonResponse(202, { ok: true, ...ticket }); }
    trace('addition.proof', 'start');
    const { receipt, ledger } = validateAdditionCheckCallback(ticket.result, original, auth.session.adminName, target);
    if (!receipt) return notConfirmed();
    trace('addition.proof', 'ok');
    const review = await assembleManagerRead(ledger, request, scope, readDependencies);
    const deliveredAt = (dependencies.clock || Date.now)();
    if (deliveredAt >= Math.min(ticket.deadlineAt, ticket.expiresAt) || localNow(new Date(deliveredAt)).date !== ledger.to) return notConfirmed(410);
    trace('addition.response', 'ready', 200);
    return jsonResponse(200, { ok: true, test: target === 'test', ...receipt, message: 'Instructor added.', review });
  } catch (error) {
    return notConfirmed(Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 503,
      error?.status === 404 && error.code === 'READ_TICKET_MISSING' ? 'READ_TICKET_MISSING' : 'ADMIN_ADD_CHECK_UNCONFIRMED');
  }
}

export default (request, context) => handleAdminAddCheck(request, { context, env: process.env });
