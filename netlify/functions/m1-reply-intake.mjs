import { jsonResponse, runtimeConfig, requireAdmin, constantTimeSecretEqual, readJson } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { digestGym, digestOrigin } from './_lib/m1-attendance-digest.mjs';
import { REPLY_SCHEMA, replySignature, replyStore, recordReplyPoll, replyQueue, reviewReply } from './_lib/m1-reply-intake.mjs';

export const config = { path: '/api/m1-reply-intake', rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleReplyIntake(request, dependencies = {}) {
  const url = new URL(request.url), env = dependencies.env || process.env, now = (dependencies.clock || Date.now)();
  if (url.pathname !== config.path || url.search || url.hash || !['GET', 'POST'].includes(request.method)) return jsonResponse(404, { ok: false });
  const scope = attendanceDigestScope(request, dependencies);
  // No preview may open the site-wide production store, even with production credentials.
  if (!scope || scope.target !== 'production') return jsonResponse(403, { ok: false, code: 'REPLY_SCOPE_REQUIRED' });
  if (env.GIB_M1_REPLY_INTAKE_ENABLED !== 'true') return jsonResponse(503, { ok: false, code: 'REPLY_DISABLED' });
  const gym = digestGym(scope), runtime = runtimeConfig(env, { admin: true, requestUrl: request.url,
    installationId: gym, environment: scope.profile.environment, activation: scope.profile.activation });
  if (runtime?.target !== 'production') return jsonResponse(503, { ok: false, code: 'REPLY_RUNTIME_UNAVAILABLE' });
  try {
    if (request.method === 'POST' && request.headers.has('X-GIB-M1-Reply-Signature')) {
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return jsonResponse(400, { ok: false });
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 800000) return jsonResponse(413, { ok: false });
      const signature = request.headers.get('X-GIB-M1-Reply-Signature');
      if (!/^[0-9a-f]{64}$/.test(signature) || !constantTimeSecretEqual(signature, replySignature(raw, runtime.adminActionToken))) return jsonResponse(403, { ok: false });
      const input = JSON.parse(raw);
      if (input.schema !== REPLY_SCHEMA || input.gym !== gym || input.target !== 'production' || !['poll', 'read'].includes(input.action)
        || !Number.isSafeInteger(input.createdAt) || input.createdAt > now + 5000 || input.expiresAt !== input.createdAt + 60000 || now >= input.expiresAt) return jsonResponse(409, { ok: false, code: 'REPLY_BINDING_INVALID' });
      const store = await replyStore(scope, dependencies);
      if (input.action === 'read') return jsonResponse(200, { ok: true, requestId: input.requestId, ...await replyQueue(store, gym, now) });
      const result = await recordReplyPoll(store, gym, input, now);
      return jsonResponse(200, { ok: true, requestId: input.requestId, ...result });
    }
    if (request.headers.get('Origin') !== digestOrigin(scope)
      || request.headers.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(request.headers.get('Sec-Fetch-Site'))) return jsonResponse(403, { ok: false });
    const auth = requireAdmin(request, runtime, now);
    if (auth.response) return auth.response;
    const store = await replyStore(scope, dependencies);
    if (request.method === 'GET') return jsonResponse(200, { ok: true, ...await replyQueue(store, gym, now) });
    const parsed = await readJson(request, 4096); if (parsed.response) return parsed.response;
    return jsonResponse(200, { ok: true, review: await reviewReply(store, gym, parsed.value, auth.session.adminName, now) });
  } catch (error) {
    const code = /^REPLY_[A-Z_]+$/.test(error?.code) ? error.code : 'REPLY_UNAVAILABLE';
    return jsonResponse(503, { ok: false, code });
  }
}
export default (request, context) => handleReplyIntake(request, { context, env: process.env });
