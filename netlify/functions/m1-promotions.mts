import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import {
  PROMOTIONS_ENV_KEYS, PROMOTIONS_INSTALL_PATH,
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
  const requestUrl = new URL(request.url);
  const runtime = promotionsRuntimeConfig(env, { siteId: dependencies.siteId, installationId, requestOrigin: requestUrl.origin });
  if (!runtime) return failure(503, 'UNAVAILABLE', 'The promotion service is not configured.');
  const tabletLabel = runtime.target === 'test' ? 'TEST tablet' : 'tablet';
  if (!validPromotionsRequest(request, runtime)) return failure(403, 'UNAUTHORIZED', `A same-origin authorized Revolution ${tabletLabel} is required.`);
  const installer = requestUrl.pathname === PROMOTIONS_INSTALL_PATH;
  const now = dependencies.now ?? Date.now();
  const credential = promotionsDeviceCredential(request, runtime, now);
  if (!installer && !credential) return failure(401, 'UNAUTHORIZED', `This ${tabletLabel} needs authorization before looking up or recording promotions.`);
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
  if (WRITE_OPERATIONS.has(input.operation) && (!validAttribution(input)
    || (runtime.target === 'live' && !Object.hasOwn(input, 'approverName')))) {
    return failure(400, 'VALIDATION', 'Enter a name in Promoted by.');
  }
  const envelope = createPromotionsEnvelope(runtime, credential, input, now, dependencies.randomBytes);
  let phase = 'fetch';
  let upstreamStatus = 0;
  const upstreamStarted = performance.now();
  try {
    const response = await (dependencies.fetch || fetch)(runtime.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(envelope), redirect: 'follow', signal: AbortSignal.timeout(25000)
    });
    upstreamStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
    phase = 'body';
    const text = await response.text();
    if (!response.ok) { phase = 'http'; throw new Error('Unconfirmed promotion response.'); }
    if (Buffer.byteLength(text, 'utf8') > 1000000) throw new Error('Unconfirmed promotion response.');
    phase = 'json';
    const body = JSON.parse(text);
    phase = 'envelope';
    if (!body || Object.keys(body).length !== 5 || body.bridge !== runtime.mode || body.target !== runtime.target
      || body.installation !== 'rev' || body.requestNonce !== envelope.payload.nonce
      || !body.result || typeof body.result.ok !== 'boolean') throw new Error('Invalid promotion confirmation.');
    return respond(200, body.result);
  } catch {
    const response = respond(503, { ok: false, error: { code: 'UNAVAILABLE', message: `The ${runtime.target === 'test' ? 'TEST ' : ''}connection did not confirm this request. Keep the original entry and check or retry it.`, retryable: true },
      ...(typeof input.requestId === 'string' ? { requestId: input.requestId } : {}) });
    // Authenticated TEST failures expose only fixed stages and numeric timing.
    // Live responses never include diagnostic headers or private upstream data.
    if (runtime.target === 'test') {
      response.headers.set('X-GIB-TEST-Upstream', phase);
      response.headers.set('X-GIB-TEST-Upstream-Ms', String(Math.max(0, Math.round(performance.now() - upstreamStarted))));
      if (upstreamStatus) response.headers.set('X-GIB-TEST-Upstream-Status', String(upstreamStatus));
    }
    return response;
  }
}

export default (request, context) => handlePromotions(request, { siteId: context?.site?.id });
