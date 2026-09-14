import { createHash } from 'node:crypto';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import {
  comparisonMetadata, comparisonErrorCode, nextComparisonInvocation,
  fetchComparisonAutomatic, fetchComparisonHttps, readComparisonBody
} from './_lib/promotions-transport-compare.mts';
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

const responseType = response => {
  const type = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
  return !type ? 'missing' : type === 'application/json' ? 'json' : type === 'text/html' ? 'html' : 'other';
};
const hostCategory = url => {
  if (!url) return 'missing';
  try {
    const host = new URL(url).hostname;
    return host === 'script.googleusercontent.com' ? 'google-content' : host === 'script.google.com' ? 'google-script' : host === 'accounts.google.com' ? 'google-auth' : 'other';
  } catch { return 'other'; }
};
const pathCategory = url => {
  if (!url) return 'missing';
  try {
    const path = new URL(url).pathname;
    if (/^\/(?:a\/[^/]+\/)?macros\/s\/[^/]+\/exec\/?$/u.test(path)) return 'web-app-exec';
    if (/^\/(?:a\/[^/]+\/)?macros\/s\/[^/]+\/dev\/?$/u.test(path)) return 'web-app-dev';
    if (path === '/macros/echo') return 'content-response';
    if (/^\/(?:ServiceLogin|AccountChooser)(?:\/|$)|^\/(?:v[0-9]+\/)?signin(?:\/|$)|^\/(?:o\/)?oauth2(?:\/|$)/u.test(path)) return 'accounts';
    return 'other';
  } catch { return 'other'; }
};
const responseDigest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ownerTitles = ['Promotions · PRIVATE SYNTHETIC TEST', 'Promotions · TEST'];
function htmlDiagnostics(text, type, host) {
  if (!text.trim()) return { category:'missing', title:'missing', reason:'none' };
  if (type === 'json' || type !== 'html' && !/^\s*<(?:!doctype\s+html|html|title)(?:\s|>)/iu.test(text)) return { category:'not-html', title:'missing', reason:'none' };
  const rawTitle = text.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu)?.[1];
  const title = rawTitle?.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim();
  const googleHost = ['google-script','google-content','google-auth'].includes(host);
  const ownerPage = ownerTitles.includes(title)
    || (/<(?:iframe|script)\b/iu.test(text) && /userHtml|google\.script/u.test(text) && ownerTitles.some(known => text.includes(known)));
  const signInTitle = googleHost && ['sign in - google accounts','sign in – google accounts','google accounts'].includes(title?.toLowerCase());
  const errorTitle = googleHost && ['error','google apps script - error','error - google apps script'].includes(title?.toLowerCase());
  const titleCategory = !title ? 'missing' : ownerTitles.includes(title) ? 'owner-page' : signInTitle ? 'google-sign-in'
    : googleHost && title === 'Google Drive' ? 'google-drive' : errorTitle ? 'google-error' : 'other';
  if (text.includes('Private TEST access required') || text.includes('This promotion tool is available only to its configured TEST manager.')) {
    return { category:'owner-denial', title:titleCategory, reason:'owner-access-required' };
  }
  if (ownerPage) return { category:'owner-page', title:titleCategory, reason:'none' };
  if (signInTitle || googleHost && text.includes('Sign in to continue to Google Drive')) return { category:'google-auth', title:titleCategory, reason:'google-sign-in-required' };
  if (googleHost && (text.includes('Sorry, unable to open the file at this time.') || text.includes('Sorry, the file you have requested does not exist.'))) {
    return { category:'google-error', title:titleCategory, reason:'google-file-unavailable' };
  }
  if (googleHost && (text.includes('Script function not found:') || text.includes('The script completed but did not return anything.'))) {
    return { category:'google-error', title:titleCategory, reason:'google-script-error' };
  }
  if (googleHost && /(?:<title\b[^>]*>|<h1\b[^>]*>)\s*(?:503\s+)?Service Unavailable\s*</iu.test(text)) {
    return { category:'google-error', title:titleCategory, reason:'google-service-unavailable' };
  }
  return { category:errorTitle ? 'google-error' : 'other-html', title:titleCategory, reason:'unknown' };
}

// Observe the TEST redirect chain instead of losing it inside fetch(). The
// signed request is never retried; redirects share the original 25-second budget.
async function fetchTestRedirects(fetcher, firstUrl, options, trace, cleanupOnFailure = false) {
  let url = firstUrl;
  let method = options.method;
  let body = options.body;
  let headers = options.headers;
  for (let redirects = 0; redirects <= 20; redirects += 1) {
    const started = performance.now();
    const hop = { method, host:hostCategory(url), path:pathCategory(url), status:null, type:'missing', ms:0, destination:'none', destinationPath:'none' };
    trace.push(hop);
    let response;
    try {
      response = await fetcher(url, { ...options, method, headers, body, redirect:'manual' });
      hop.status = response.status;
      hop.type = responseType(response);
    } finally { hop.ms = Math.max(0, Math.round(performance.now() - started)); }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    let next;
    try { next = new URL(location, url); }
    catch (error) {
      if (cleanupOnFailure) void response.body?.cancel().catch(() => {});
      throw error;
    }
    hop.destination = hostCategory(next.href);
    hop.destinationPath = pathCategory(next.href);
    // Only the already authorized Google service may receive a redirect. Never
    // expose a signed envelope or a one-time response URL to another host.
    if (next.protocol !== 'https:' || next.username || next.password || (next.port && next.port !== '443')
      || !['google-script', 'google-content'].includes(hop.destination) || redirects === 20) return response;
    await response.body?.cancel();
    if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
      method = 'GET'; body = undefined; headers = { Accept:'application/json' };
    }
    // Validate with URL, but preserve an absolute one-time Location byte-for-byte.
    url = /^https:\/\//iu.test(location) ? location : next.href;
  }
}

export async function handlePromotions(request, dependencies = {}) {
  const invocation = nextComparisonInvocation();
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
  // The selector is diagnostic-only and cannot select a URL, a write, checkSave,
  // another installation, or an unauthenticated request. LIVE ignores it.
  const comparisonArm = runtime.target === 'test' ? request.headers.get('X-GIB-TEST-Transport') : null;
  if (comparisonArm !== null && (!['preflight', 'A', 'B', 'C'].includes(comparisonArm)
    || !['bootstrap', 'readStudent'].includes(input.operation))) {
    return failure(400, 'VALIDATION', 'Transport comparison supports authorized TEST record reads only.');
  }
  const comparison = comparisonArm === null ? null : comparisonMetadata(comparisonArm, runtime.webhookUrl, invocation,
    dependencies.comparisonEnvironment || Object.fromEntries(['CONTEXT', 'AWS_REGION', 'DEPLOY_ID'].map(key => [key, globalThis.Netlify?.env?.get(key) || process.env[key]])));
  if (comparisonArm === 'preflight') {
    const response = respond(200, { ok:true, data:{ diagnosticOnly:true, preflight:comparison } });
    response.headers.set('X-GIB-TEST-Comparison', JSON.stringify(comparison));
    return response;
  }
  const envelope = createPromotionsEnvelope(runtime, credential, input, now, dependencies.randomBytes);
  let phase = 'fetch';
  let upstreamStatus = 0;
  let upstreamType = 'missing';
  let upstreamRedirected = false;
  let upstreamHost = 'missing';
  let envelopeFailure = 'none';
  const upstreamTrace = [];
  const socketTrace = [];
  const upstreamStarted = performance.now();
  const traceId = runtime.target === 'test' ? responseDigest('gib-test-response-trace:v1\n' + envelope.payload.nonce).slice(0, 24) : '';
  let responseFingerprint = '';
  let html = { category:'missing', title:'missing', reason:'none' };
  function withTestDiagnostics(response) {
    if (runtime.target !== 'test') return response;
    if (comparison) response.headers.set('X-GIB-TEST-Comparison', JSON.stringify(comparison));
    if (comparisonArm === 'C') response.headers.set('X-GIB-TEST-Socket-Trace', JSON.stringify(socketTrace));
    response.headers.set('X-GIB-TEST-Trace-Id', traceId);
    response.headers.set('X-GIB-TEST-Upstream', phase);
    response.headers.set('X-GIB-TEST-Upstream-Ms', String(Math.max(0, Math.round(performance.now() - upstreamStarted))));
    if (upstreamStatus) response.headers.set('X-GIB-TEST-Upstream-Status', String(upstreamStatus));
    response.headers.set('X-GIB-TEST-Upstream-Type', upstreamType);
    response.headers.set('X-GIB-TEST-Upstream-Redirected', upstreamRedirected ? '1' : '0');
    response.headers.set('X-GIB-TEST-Upstream-Host', upstreamHost);
    response.headers.set('X-GIB-TEST-Upstream-Envelope', envelopeFailure);
    response.headers.set('X-GIB-TEST-Upstream-Trace', JSON.stringify(upstreamTrace));
    if (responseFingerprint) response.headers.set('X-GIB-TEST-Response-Fingerprint', responseFingerprint);
    response.headers.set('X-GIB-TEST-HTML-Category', html.category);
    response.headers.set('X-GIB-TEST-HTML-Title', html.title);
    response.headers.set('X-GIB-TEST-HTML-Reason', html.reason);
    return response;
  }
  try {
    const options = {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(envelope), redirect: 'follow', signal: comparison
        ? AbortSignal.any([AbortSignal.timeout(25000), request.signal, ...(dependencies.comparisonSignal ? [dependencies.comparisonSignal] : [])])
        : AbortSignal.timeout(25000)
    };
    const fetcher = dependencies.fetch || fetch;
    const diagnostics = { hostCategory, pathCategory, responseType };
    const response = comparisonArm === 'B' ? await fetchComparisonAutomatic(fetcher, runtime.webhookUrl, options, upstreamTrace, diagnostics, dependencies.comparisonDispatcher)
      : comparisonArm === 'C' ? await fetchComparisonHttps(runtime.webhookUrl, options, upstreamTrace, socketTrace, diagnostics, dependencies.httpsRequest)
      : runtime.target === 'test' ? await fetchTestRedirects(fetcher, runtime.webhookUrl, options, upstreamTrace, Boolean(comparison))
      : await fetcher(runtime.webhookUrl, options);
    upstreamStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
    if (runtime.target === 'test') {
      upstreamType = responseType(response);
      upstreamRedirected = response.redirected === true || upstreamTrace.length > 1;
      upstreamHost = response.url ? hostCategory(response.url) : upstreamTrace.at(-1)?.host || 'missing';
    }
    phase = 'body';
    const text = comparison ? await readComparisonBody(response, options.signal) : await response.text();
    if (runtime.target === 'test') {
      responseFingerprint = responseDigest(text);
      html = htmlDiagnostics(text, upstreamType, upstreamHost);
    }
    if (!response.ok) { phase = 'http'; throw new Error('Unconfirmed promotion response.'); }
    if (Buffer.byteLength(text, 'utf8') > 1000000) throw new Error('Unconfirmed promotion response.');
    phase = 'json';
    const body = JSON.parse(text);
    phase = 'envelope';
    if (runtime.target === 'test') envelopeFailure = body?.ok === false && body?.error?.code === 'UNAUTHORIZED' ? 'bare-auth-denial' : 'mismatch';
    if (!body || Object.keys(body).length !== 5 || body.bridge !== runtime.mode || body.target !== runtime.target
      || body.installation !== 'rev' || body.requestNonce !== envelope.payload.nonce
      || !body.result || typeof body.result.ok !== 'boolean') throw new Error('Invalid promotion confirmation.');
    if (runtime.target === 'test') envelopeFailure = 'none';
    return withTestDiagnostics(respond(200, body.result));
  } catch (error) {
    if (comparison) comparison.errorCode = comparisonErrorCode(error);
    const response = respond(503, { ok: false, error: { code: 'UNAVAILABLE', message: `The ${runtime.target === 'test' ? 'TEST ' : ''}connection did not confirm this request. Keep the original entry and check or retry it.`, retryable: true },
      ...(typeof input.requestId === 'string' ? { requestId: input.requestId } : {}) });
    // Only authenticated TEST responses expose fixed categories and digests.
    return withTestDiagnostics(response);
  }
}

export default (request, context) => handlePromotions(request, { siteId: context?.site?.id,
  comparisonEnvironment:{
    CONTEXT:context?.deploy?.context || globalThis.Netlify?.env?.get('CONTEXT') || process.env.CONTEXT,
    DEPLOY_ID:context?.deploy?.id || globalThis.Netlify?.env?.get('DEPLOY_ID') || process.env.DEPLOY_ID,
    AWS_REGION:process.env.AWS_REGION || globalThis.Netlify?.env?.get('AWS_REGION')
  }
});
