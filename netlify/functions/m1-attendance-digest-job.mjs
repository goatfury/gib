import { jsonResponse, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { DIGEST_SIGNATURE_HEADER, authenticateDigestJob, processDigestJob } from './_lib/m1-attendance-digest-outbox.mjs';
import { validId } from './_lib/m1-test-read-callback.mjs';
import { processDigestRehearsal } from './_lib/m1-attendance-digest-rehearsal.mjs';

export const config = { path: '/api/m1-attendance-digest-job', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
const responseCodes = new Set(['DIGEST_AUTHENTICATION_FAILED', 'DIGEST_RUNTIME_UNAVAILABLE', 'DIGEST_INVALID_JSON', 'DIGEST_INVALID_ENVELOPE',
  'DIGEST_BINDING_MISMATCH', 'DIGEST_REQUEST_EXPIRED', 'DIGEST_GYM_MISMATCH', 'DIGEST_MANUAL_REQUEST_MISSING', 'DIGEST_RESULT_CONFLICT',
  'DIGEST_STORAGE_INCOMPLETE', 'DIGEST_STORAGE_UNCONFIRMED', 'DIGEST_CONFIGURATION_UNAVAILABLE', 'DIGEST_REQUEST_MISSING',
  'DIGEST_OUTBOX_UNCONFIRMED', 'DIGEST_OUTBOX_INCOMPLETE', 'DIGEST_CAPTURE_CONFLICT', 'DIGEST_CAPTURE_UNCONFIRMED',
  'DIGEST_CAPTURE_STATUS_UNCONFIRMED', 'DIGEST_JOB_UNAVAILABLE', 'DIGEST_REHEARSAL_EXPIRED', 'DIGEST_REHEARSAL_MISSING', 'DIGEST_REHEARSAL_INVALID', 'DIGEST_REHEARSAL_UNAVAILABLE']);
export async function handleAttendanceDigestJob(request, dependencies = {}) {
  const url = new URL(request.url), clock = dependencies.clock || Date.now, started = clock();
  let requestId = null, stage = 'job.scope';
  const report = (status, code) => {
    try { (dependencies.traceLog || console.info)('M1_TEST_DIGEST_JOB_STAGE', JSON.stringify({
      requestId, invocation: /^[a-zA-Z0-9_-]{1,100}$/.test(dependencies.context?.requestId || '') ? dependencies.context.requestId : null,
      stage, status, code, elapsedMs: Math.max(0, clock() - started)
    })); } catch {} // Fixed categories only; diagnostics are never a capture dependency.
  };
  const reject = (status, code) => { report(status, code); return jsonResponse(status, { ok: false, code }); };
  if (request.method !== 'POST' || url.pathname !== config.path || url.search || url.hash) return jsonResponse(404, { ok: false, message: 'Digest job unavailable.' });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope) return reject(403, 'DIGEST_SCOPE_REQUIRED');
  stage = 'job.runtime';
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  if (runtime?.target !== 'test') return reject(503, 'DIGEST_RUNTIME_UNAVAILABLE');
  stage = 'job.envelope';
  const declared = request.headers.get('Content-Length');
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '') || (declared && (!/^\d+$/.test(declared) || Number(declared) > 400000))) return reject(400, 'DIGEST_INVALID_ENVELOPE');
  try {
    const raw = await request.text();
    if (!raw || Buffer.byteLength(raw, 'utf8') > 400000) return reject(400, 'DIGEST_INVALID_ENVELOPE');
    // This unauthenticated correlation hint is UUID-only and never authorizes a
    // read or save. Neither the raw payload nor its signature reaches logs.
    try { const hint = JSON.parse(raw)?.requestId; if (validId(hint)) requestId = hint; } catch {}
    stage = 'job.authentication';
    const job = authenticateDigestJob(raw, request.headers.get(DIGEST_SIGNATURE_HEADER), runtime, clock());
    requestId = job.binding.requestId;
    stage = 'job.capture';
    // Await complete central capture before acknowledging the scheduler. No
    // unowned dispatch, browser timer, real mail or Google response dependency.
    const result = await (job.binding.mode === 'rehearsal' ? processDigestRehearsal : processDigestJob)(job, scope, dependencies);
    report(200, 'DIGEST_JOB_ACCEPTED');
    return jsonResponse(200, { ok: true, accepted: true, requestId: job.binding.requestId, state: result.state, messageId: result.messageId || null });
  } catch (error) {
    return reject(Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 503,
      responseCodes.has(error.code) ? error.code : 'DIGEST_JOB_UNAVAILABLE');
  }
}
export default (request, context) => handleAttendanceDigestJob(request, { context, env: process.env });
