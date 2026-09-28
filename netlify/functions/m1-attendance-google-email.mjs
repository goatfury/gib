import { ADMIN_REQUEST_HEADER, jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { DIGEST_ORIGIN } from './_lib/m1-attendance-digest.mjs';
import { googleEmailTestState, queueGoogleEmailTest, checkGoogleEmailOriginal, disableGoogleEmailTest } from './_lib/m1-attendance-google-email-test.mjs';

export const config = { path: '/api/m1-attendance-google-email', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleAttendanceGoogleEmail(request, dependencies = {}) {
  const url = new URL(request.url);
  if (url.pathname !== config.path || url.search || url.hash || !['GET', 'POST'].includes(request.method)) return jsonResponse(404, { ok: false });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope || request.headers.get('Origin') && request.headers.get('Origin') !== DIGEST_ORIGIN
    || request.headers.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(request.headers.get('Sec-Fetch-Site'))) return jsonResponse(403, { ok: false });
  const env = dependencies.env || process.env, runtime = runtimeConfig(env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  if (runtime?.target !== 'test') return jsonResponse(503, { ok: false });
  const auth = requireAdmin(request, runtime, (dependencies.clock || Date.now)()); if (auth.response) return auth.response;
  const deps = { ...dependencies, env, scope, runtime };
  try {
    if (request.method === 'GET') return jsonResponse(200, await googleEmailTestState(deps));
    const parsed = await readJson(request, 2048); if (parsed.response) return parsed.response;
    const input = parsed.value;
    if (!input || Object.keys(input).sort().join('|') !== 'action|hash|messageId'
      || !['sendApprovedTest', 'checkOriginal', 'disableOriginal'].includes(input.action)) return jsonResponse(400, { ok: false, code: 'GOOGLE_EMAIL_REQUEST_INVALID' });
    const original = await googleEmailTestState(deps, false);
    if (input.messageId !== original.message.messageId || input.hash !== original.message.hash) return jsonResponse(409, { ok: false, code: 'GOOGLE_EMAIL_REVIEW_CHANGED' });
    if (input.action === 'checkOriginal') return jsonResponse(200, await checkGoogleEmailOriginal(deps));
    if (input.action === 'disableOriginal') return jsonResponse(200, await disableGoogleEmailTest(deps));
    const queued = await queueGoogleEmailTest(input.messageId, input.hash, deps);
    if (queued.dispatch) {
      const dispatch = dependencies.dispatchGoogleEmail || (async requestId => {
        const response = await fetch(DIGEST_ORIGIN + '/api/m1-attendance-workflow-background', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', Origin: DIGEST_ORIGIN, Cookie: request.headers.get('Cookie') || '',
            [ADMIN_REQUEST_HEADER]: request.headers.get(ADMIN_REQUEST_HEADER) || '' }, body: JSON.stringify({ action: 'runGoogleEmail', requestId }) });
        await response.body?.cancel(); if (response.status !== 202) throw new Error('Dispatch unavailable');
      });
      await dispatch(queued.state.requestId);
    }
    return jsonResponse(queued.state.request.state === 'pending' ? 202 : 200, queued.state);
  } catch (error) {
    const code = /^GOOGLE_EMAIL_[A-Z_]+$/.test(error?.code || '') ? error.code : 'GOOGLE_EMAIL_UNAVAILABLE';
    return jsonResponse([403, 409].includes(error?.status) ? error.status : 503, { ok: false, code,
      message: 'The original TEST email status is unavailable. Keep the same message; do not start a replacement send.' });
  }
}
export default (request, context) => handleAttendanceGoogleEmail(request, { context, env: process.env });
