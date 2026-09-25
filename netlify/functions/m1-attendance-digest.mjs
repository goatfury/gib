import { jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { managerReviewScope } from './_lib/m1-manager-scope.mjs';
import { validId } from './_lib/m1-test-read-callback.mjs';
import { DIGEST_ORIGIN } from './_lib/m1-attendance-digest.mjs';
import { defaultDigestStore, digestState, saveDigestConfiguration, startManualDigest } from './_lib/m1-attendance-digest-outbox.mjs';

export const config = { path: '/api/m1-attendance-digest', rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export function attendanceDigestScope(request, dependencies = {}) {
  const url = new URL(request.url), scope = managerReviewScope(request, dependencies);
  if (url.origin !== DIGEST_ORIGIN || !scope || scope.target !== 'test' || scope.profile.installationId !== 'rev') return null;
  return scope;
}
export async function handleAttendanceDigest(request, dependencies = {}) {
  const url = new URL(request.url);
  if (url.pathname !== config.path || url.hash || !['GET', 'POST'].includes(request.method)
    || [...url.searchParams.keys()].some(key => key !== 'requestId') || url.searchParams.getAll('requestId').length > 1
    || (url.search && request.method !== 'GET')) return jsonResponse(404, { ok: false, message: 'Digest capture unavailable.' });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope) return jsonResponse(403, { ok: false, message: 'Revolution TEST capture required.' });
  if ((request.headers.get('Origin') && request.headers.get('Origin') !== DIGEST_ORIGIN)
    || (request.headers.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(request.headers.get('Sec-Fetch-Site')))) return jsonResponse(403, { ok: false, message: 'Use the authenticated Admin page.' });
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  if (runtime?.target !== 'test') return jsonResponse(503, { ok: false, message: 'TEST service unavailable.' });
  const auth = requireAdmin(request, runtime, (dependencies.clock || Date.now)());
  if (auth.response) return auth.response;
  try {
    if (request.method === 'GET') {
      const id = url.searchParams.get('requestId');
      if (id !== null && !validId(id)) return jsonResponse(400, { ok: false, message: 'Use the original capture request.' });
      return jsonResponse(200, await digestState(scope, id, dependencies));
    }
    const parsed = await readJson(request, 4096);
    if (parsed.response) return parsed.response;
    const input = parsed.value;
    if (input.action === 'capture' && Object.keys(input).sort().join('|') === 'action|requestId' && validId(input.requestId)) {
      const result = await startManualDigest(input.requestId, auth.session.adminName, runtime, scope, dependencies);
      return jsonResponse(result.state === 'pending' ? 202 : 200, { ok: true, requestId: input.requestId, state: result.state,
        expiresAt: result.binding.expiresAt, messageId: result.messageId });
    }
    if (input.action === 'configure' && Object.keys(input).sort().join('|') === 'action|dailyLocalTime') {
      const store = dependencies.digestStore || await defaultDigestStore();
      const configuration = await saveDigestConfiguration(store, scope, input.dailyLocalTime, auth.session.adminName, dependencies);
      return jsonResponse(200, { ok: true, target: 'test', sendingEnabled: false, configuration });
    }
    return jsonResponse(400, { ok: false, message: 'Choose a TEST capture or a daily closing time. Email sending remains disabled.' });
  } catch (error) {
    return jsonResponse(error.status || 503, { ok: false, code: error.code || 'DIGEST_UNAVAILABLE', message: 'Digest capture is unavailable. The original request and any saved failure remain available for recovery. No email was sent.' });
  }
}
export default (request, context) => handleAttendanceDigest(request, { context, env: process.env });
