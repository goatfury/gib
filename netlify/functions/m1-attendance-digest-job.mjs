import { jsonResponse, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { DIGEST_SIGNATURE_HEADER, authenticateDigestJob, processDigestJob, defaultDigestStore } from './_lib/m1-attendance-digest-outbox.mjs';
import { validId } from './_lib/m1-test-read-callback.mjs';
import { processDigestRehearsal } from './_lib/m1-attendance-digest-rehearsal.mjs';
import { enqueueAttendanceWorkflow } from './_lib/m1-attendance-digest-workflow.mjs';
import { digestGym } from './_lib/m1-attendance-digest.mjs';
import { managerAttendanceEmail } from './_lib/m1-manager-attendance-email.mjs';
import { prepareReplyEvent } from './_lib/m1-reply-intake.mjs';

export const config = { path: '/api/m1-attendance-digest-job', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
const responseCodes = new Set(['DIGEST_AUTHENTICATION_FAILED', 'DIGEST_RUNTIME_UNAVAILABLE', 'DIGEST_INVALID_JSON', 'DIGEST_INVALID_ENVELOPE',
  'DIGEST_BINDING_MISMATCH', 'DIGEST_REQUEST_EXPIRED', 'DIGEST_GYM_MISMATCH', 'DIGEST_MANUAL_REQUEST_MISSING', 'DIGEST_RESULT_CONFLICT',
  'DIGEST_STORAGE_INCOMPLETE', 'DIGEST_STORAGE_UNCONFIRMED', 'DIGEST_CONFIGURATION_UNAVAILABLE', 'DIGEST_REQUEST_MISSING',
  'DIGEST_OUTBOX_UNCONFIRMED', 'DIGEST_OUTBOX_INCOMPLETE', 'DIGEST_CAPTURE_CONFLICT', 'DIGEST_CAPTURE_UNCONFIRMED',
  'DIGEST_CAPTURE_STATUS_UNCONFIRMED', 'DIGEST_JOB_UNAVAILABLE', 'DIGEST_REHEARSAL_EXPIRED', 'DIGEST_REHEARSAL_MISSING', 'DIGEST_REHEARSAL_INVALID', 'DIGEST_REHEARSAL_UNAVAILABLE']);
// Read deployed metadata but stage all check/capture/schedule writes in memory.
// Authenticated live verification exercises the real pipeline without altering
// production attendance, email opportunities, captures, or dated observations.
export function readOnlyDigestOverlay(store) {
  const staged = new Map(); let serial = 0;
  return { async getWithMetadata(key, options) { return staged.has(key) ? structuredClone(staged.get(key)) : store.getWithMetadata(key, options); },
    async set(key, raw, condition = {}) {
      const before = await this.getWithMetadata(key, { type: 'json', consistency: 'strong' });
      if (condition.onlyIfNew && before || condition.onlyIfMatch && before?.etag !== condition.onlyIfMatch) return { modified: false };
      staged.set(key, { data: JSON.parse(raw), etag: 'read-only-' + (++serial) }); return { modified: true };
    } };
}
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
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url,
    installationId: scope.profile.installationId, environment: scope.profile.environment, activation: scope.profile.activation });
  if (runtime?.target !== scope.target) return reject(503, 'DIGEST_RUNTIME_UNAVAILABLE');
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
    if (job.binding.mode === 'rehearsal' && (scope.target !== 'test' || digestGym(scope) !== 'rev')) return reject(409, 'DIGEST_GYM_MISMATCH');
    requestId = job.binding.requestId;
    stage = 'job.capture';
    // Await complete central capture before acknowledging the scheduler. No
    // unowned dispatch, browser timer, real mail or Google response dependency.
    const emailFirst = scope.target === 'production' && (dependencies.env || process.env).GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED === 'true';
    const verifyOnly = emailFirst && job.binding.mode === 'scheduled' && request.headers.get('X-GIB-M1-Digest-Check') === 'read-only-v1';
    const checkDependencies = verifyOnly ? { ...dependencies, digestStore: readOnlyDigestOverlay(dependencies.digestStore || await defaultDigestStore(scope)) } : dependencies;
    let dailyEmail = null;
    const workflowDependencies = job.binding.mode === 'scheduled' ? { ...checkDependencies, onDigestCheck: async check => {
      if (emailFirst) {
        dailyEmail = managerAttendanceEmail(check.digest, check.configuration, check.uploadAssessment);
        if (!verifyOnly && dailyEmail.rendered && (dependencies.env || process.env).GIB_M1_REPLY_INTAKE_ENABLED === 'true') {
          // Queue failure cannot suppress the existing warning. No marker means
          // the Google sender keeps the existing Andrew Reply-To for this mail.
          try { dailyEmail = await prepareReplyEvent(check, scope, dailyEmail, dependencies); }
          catch { (dependencies.traceLog || console.info)('M1_REPLY_EVENT_UNAVAILABLE', JSON.stringify({ gym: digestGym(scope), requestId: check.binding.requestId })); }
        }
        return; // Google owns the one send opportunity; no detached second sender.
      }
      stage = 'job.workflow';
      await enqueueAttendanceWorkflow(check, runtime, { ...dependencies, scope });
      stage = 'job.capture';
    } } : checkDependencies;
    const result = await (job.binding.mode === 'rehearsal' ? processDigestRehearsal : processDigestJob)(job, scope, workflowDependencies);
    report(200, 'DIGEST_JOB_ACCEPTED');
    return jsonResponse(200, { ok: true, accepted: true, requestId: job.binding.requestId, state: result.state, messageId: result.messageId || null,
      ...(emailFirst ? { dailyEmail } : {}), ...(verifyOnly ? { readOnly: true } : {}) });
  } catch (error) {
    return reject(Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 503,
      responseCodes.has(error.code) ? error.code : 'DIGEST_JOB_UNAVAILABLE');
  }
}
export default (request, context) => handleAttendanceDigestJob(request, { context, env: process.env });
