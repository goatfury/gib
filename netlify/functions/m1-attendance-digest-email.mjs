import { jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { DIGEST_ORIGIN } from './_lib/m1-attendance-digest.mjs';
import { buildTestDigestEmail, TEST_EMAIL_MESSAGE_ID } from './_lib/m1-attendance-digest-email-proposal.mjs';
import { deliverTestDigestEmail, readTestDigestEmailDelivery } from './_lib/m1-attendance-digest-email-delivery.mjs';

export const config = { path: '/api/m1-attendance-digest-email', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// This is a separate, explicitly selected synthetic message. Captured daily
// messages and their original identities never enter this sending path.
export async function handleAttendanceDigestEmail(request, dependencies = {}) {
  const url = new URL(request.url);
  if (url.pathname !== config.path || url.search || url.hash || !['GET', 'POST'].includes(request.method)) {
    return jsonResponse(404, { ok: false, message: 'TEST email unavailable.' });
  }
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope || (request.headers.get('Origin') && request.headers.get('Origin') !== DIGEST_ORIGIN)
    || (request.headers.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(request.headers.get('Sec-Fetch-Site')))) {
    return jsonResponse(403, { ok: false, message: 'Use Revolution TEST Admin.' });
  }
  const env = dependencies.env || process.env;
  const runtime = runtimeConfig(env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  if (runtime?.target !== 'test') return jsonResponse(503, { ok: false, message: 'TEST service unavailable.' });
  const auth = requireAdmin(request, runtime, (dependencies.clock || Date.now)());
  if (auth.response) return auth.response;
  try {
    const message = buildTestDigestEmail(env.GIB_M1_DIGEST_TEST_EMAIL_RECIPIENT);
    const deps = { ...dependencies, env, scope };
    if (request.method === 'GET') {
      const delivery = await readTestDigestEmailDelivery(message, deps);
      return jsonResponse(200, { ok: true, target: 'test', sendingEnabled: env.GIB_M1_DIGEST_TEST_SEND_ENABLED === 'true', recurringEnabled: false,
        provider: 'resend', message, delivery,
        recipientSettings: { andrew: { address: message.to[0], source: 'user-confirmed TEST recipient' }, stu: { address: null } } });
    }
    const parsed = await readJson(request, 2048);
    if (parsed.response) return parsed.response;
    const input = parsed.value;
    if (!input || Object.keys(input).sort().join('|') !== 'action|hash|messageId' || input.action !== 'sendApprovedTest'
      || input.messageId !== TEST_EMAIL_MESSAGE_ID || input.hash !== message.hash) {
      return jsonResponse(409, { ok: false, code: 'TEST_EMAIL_REVIEW_CHANGED', message: 'Review the exact original TEST email before sending.' });
    }
    const delivery = await deliverTestDigestEmail(message, deps);
    // Acceptance confirms the provider's receipt only, never inbox delivery.
    return jsonResponse(delivery.state === 'disabled' ? 403 : 200, { ok: delivery.state === 'accepted', target: 'test', recurringEnabled: false, delivery });
  } catch (error) {
    return jsonResponse(503, { ok: false, code: 'TEST_EMAIL_UNAVAILABLE',
      message: 'The original TEST email status is unavailable. Delivery is not confirmed. Do not start a replacement send.' });
  }
}

export default (request, context) => handleAttendanceDigestEmail(request, { context, env: process.env });
