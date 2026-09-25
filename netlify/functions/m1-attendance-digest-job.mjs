import { jsonResponse, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { DIGEST_SIGNATURE_HEADER, authenticateDigestJob, processDigestJob } from './_lib/m1-attendance-digest-outbox.mjs';

export const config = { path: '/api/m1-attendance-digest-job', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleAttendanceDigestJob(request, dependencies = {}) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== config.path || url.search || url.hash) return jsonResponse(404, { ok: false, message: 'Digest job unavailable.' });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope) return jsonResponse(403, { ok: false, message: 'Revolution TEST job required.' });
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  const declared = request.headers.get('Content-Length');
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '') || (declared && (!/^\d+$/.test(declared) || Number(declared) > 400000))) return jsonResponse(400, { ok: false, code: 'DIGEST_INVALID_ENVELOPE' });
  try {
    const raw = await request.text();
    if (!raw || Buffer.byteLength(raw, 'utf8') > 400000) return jsonResponse(400, { ok: false, code: 'DIGEST_INVALID_ENVELOPE' });
    const job = authenticateDigestJob(raw, request.headers.get(DIGEST_SIGNATURE_HEADER), runtime, (dependencies.clock || Date.now)());
    // Await complete central capture before acknowledging the scheduler. No
    // unowned dispatch, browser timer, real mail or Google response dependency.
    const result = await processDigestJob(job, scope, dependencies);
    return jsonResponse(200, { ok: true, accepted: true, requestId: job.binding.requestId, state: result.state, messageId: result.messageId || null });
  } catch (error) {
    return jsonResponse(error.status || 503, { ok: false, code: error.code || 'DIGEST_JOB_UNAVAILABLE' });
  }
}
export default (request, context) => handleAttendanceDigestJob(request, { context, env: process.env });
