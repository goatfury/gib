import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import {
  PROMOTIONS_BRIDGE_MODE, PROMOTIONS_ENV_KEYS, PROMOTIONS_INSTALL_PATH,
  createPromotionsEnvelope, handlePromotionsInstall, promotionsDeviceCredential,
  promotionsRuntimeConfig, validPromotionsRequest
} from './_lib/promotions-runtime.mts';

export const config = {
  path: ['/api/m1-promotions', '/api/m1-promotions-install'],
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};
const OPERATIONS = new Set(['bootstrap', 'readStudent', 'checkSave', 'recordPromotion', 'confirmRank', 'registerStudent', 'correctLatest']);
const WRITE_OPERATIONS = new Set(['recordPromotion', 'confirmRank', 'registerStudent', 'correctLatest']);
const REQUEST_KEYS = new Set(['operation', 'studentId', 'requestId', 'expectedRevision', 'correctsEventId', 'action', 'belt', 'rank', 'approverId', 'approverName', 'reason', 'displayName', 'distinguishingLabel', 'historyNote']);
const UPSTREAM_CAUSES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

function validAttribution(input) {
  const hasName = Object.hasOwn(input, 'approverName');
  const hasId = Object.hasOwn(input, 'approverId');
  return hasName && !hasId
    ? typeof input.approverName === 'string' && input.approverName.length <= 120
      && Boolean(input.approverName.trim()) && !/[\u0000-\u001f\u007f-\u009f]/u.test(input.approverName)
    : hasId && !hasName && ['TEST-COACH-A', 'TEST-COACH-B'].includes(input.approverId);
}

function respond(status, body, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  cookies.forEach(cookie => headers.append('Set-Cookie', cookie));
  return new Response(JSON.stringify(body), { status, headers });
}
const failure = (status, code, message, retryable = false) => respond(status, { ok: false, error: { code, message, retryable } });

export async function handlePromotions(request, dependencies = {}) {
  const env = dependencies.env || Object.fromEntries(PROMOTIONS_ENV_KEYS.map(key => [key, globalThis.Netlify?.env?.get(key)]));
  const installationId = dependencies.installationId || deploymentInstallationProfile()?.installationId;
  const runtime = promotionsRuntimeConfig(env, { siteId: dependencies.siteId, installationId });
  if (!runtime) return failure(503, 'UNAVAILABLE', 'This isolated TEST promotion service is not configured.');
  if (!validPromotionsRequest(request, runtime)) return failure(403, 'UNAUTHORIZED', 'A same-origin authorized Revolution TEST tablet is required.');
  const installer = new URL(request.url).pathname === PROMOTIONS_INSTALL_PATH;
  const now = dependencies.now ?? Date.now();
  const credential = promotionsDeviceCredential(request, runtime, now);
  if (!installer && !credential) return failure(401, 'UNAUTHORIZED', 'This TEST tablet needs authorization before looking up or recording promotions.');
  let input;
  try {
    const text = await request.text();
    if (!text || Buffer.byteLength(text, 'utf8') > 48000) return failure(400, 'VALIDATION', 'This request is too large.');
    input = JSON.parse(text);
  } catch { return failure(400, 'VALIDATION', 'This request is not valid JSON.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return failure(400, 'VALIDATION', 'A promotion request is required.');
  if (installer) {
    try {
      const result = await handlePromotionsInstall(request, input, runtime, dependencies);
      return respond(result.status, result.body, result.cookies);
    } catch { return failure(503, 'UNAVAILABLE', 'TEST tablet authorization could not be confirmed. Retry its status.', true); }
  }
  if (!OPERATIONS.has(input.operation) || Object.keys(input).some(key => !REQUEST_KEYS.has(key))) {
    return failure(400, 'VALIDATION', 'Unsupported promotion request fields.');
  }
  if (WRITE_OPERATIONS.has(input.operation) && !validAttribution(input)) {
    return failure(400, 'VALIDATION', 'Enter a name in Promoted by.');
  }
  const envelope = createPromotionsEnvelope(runtime, credential, input, now, dependencies.randomBytes);
  let failureStage = 'network';
  let upstreamStatus = 0;
  let upstreamType = 'missing';
  try {
    const response = await (dependencies.fetch || fetch)(runtime.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(envelope), redirect: 'follow', signal: AbortSignal.timeout(25000)
    });
    upstreamStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    upstreamType = contentType === 'application/json' ? 'json' : contentType === 'text/html' ? 'html' : contentType ? 'other' : 'missing';
    if (!response.ok) { failureStage = 'http'; throw new Error('Unconfirmed TEST response.'); }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 1000000) { failureStage = 'body_size'; throw new Error('Unconfirmed TEST response.'); }
    failureStage = 'json';
    const body = JSON.parse(text);
    failureStage = 'envelope';
    if (!body || Object.keys(body).length !== 5 || body.bridge !== PROMOTIONS_BRIDGE_MODE || body.target !== 'test'
      || body.installation !== 'rev' || body.requestNonce !== envelope.payload.nonce
      || !body.result || typeof body.result.ok !== 'boolean') throw new Error('Invalid TEST confirmation.');
    return respond(200, body.result);
  } catch (error) {
    const cause = UPSTREAM_CAUSES.has(error?.cause?.code) ? error.cause.code : UPSTREAM_CAUSES.has(error?.code) ? error.code : '';
    if (failureStage === 'network' && (error?.name === 'TimeoutError' || error?.name === 'AbortError' || cause.endsWith('TIMEOUT') || cause === 'ETIMEDOUT')) failureStage = 'timeout';
    const response = respond(503, { ok: false, error: { code: 'UNAVAILABLE', message: 'The TEST connection did not confirm this request. Keep the original entry and check or retry it.', retryable: true },
      ...(typeof input.requestId === 'string' ? { requestId: input.requestId } : {}) });
    // This route is already restricted to an authenticated TEST tablet. Fixed
    // categories locate an upstream failure without exposing its body or URL.
    response.headers.set('X-GIB-TEST-Upstream', failureStage);
    response.headers.set('X-GIB-TEST-Upstream-Type', upstreamType);
    if (upstreamStatus) response.headers.set('X-GIB-TEST-Upstream-Status', String(upstreamStatus));
    if (cause) response.headers.set('X-GIB-TEST-Upstream-Cause', cause);
    return response;
  }
}

export default (request, context) => handlePromotions(request, { siteId: context?.site?.id });
