import { jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { DIGEST_ORIGIN } from './_lib/m1-attendance-digest.mjs';
import { validId } from './_lib/m1-test-read-callback.mjs';
import { runAttendanceWorkflowExamples, runAttendanceWorkflowHistoryExamples, runAttendanceWorkflowDailyExamples, runAttendanceWorkflowMailAppExamples } from './_lib/m1-attendance-workflow-examples.mjs';
import { runGoogleEmailTest } from './_lib/m1-attendance-google-email-test.mjs';

export const config = { path: '/api/m1-attendance-workflow-background' };
export async function handleAttendanceWorkflowBackground(request, dependencies = {}) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== config.path || url.search || url.hash)
    return jsonResponse(404, { ok: false });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope || request.headers.get('Origin') !== DIGEST_ORIGIN) return jsonResponse(403, { ok: false });
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  if (runtime?.target !== 'test') return jsonResponse(503, { ok: false });
  const auth = requireAdmin(request, runtime, (dependencies.clock || Date.now)());
  if (auth.response) return auth.response;
  const parsed = await readJson(request, 4096);
  if (parsed.response) return parsed.response;
  const input = parsed.value;
  if (!input || Object.keys(input).sort().join('|') !== 'action|requestId' || !['runExamples', 'runHistory', 'runDaily', 'runMailApp', 'runGoogleEmail'].includes(input.action) || !validId(input.requestId))
    return jsonResponse(400, { ok: false });
  try {
    if (input.action === 'runGoogleEmail') {
      await runGoogleEmailTest(input.requestId, { ...dependencies, env: dependencies.env || process.env, scope, runtime });
      return jsonResponse(200, { ok: true });
    }
    // One awaited, bounded synthetic run; Netlify's -background lifecycle owns
    // execution after the caller receives 202. It never invokes a real provider.
    const run = input.action === 'runMailApp' ? dependencies.runMailApp || runAttendanceWorkflowMailAppExamples
      : input.action === 'runDaily' ? dependencies.runDaily || runAttendanceWorkflowDailyExamples
      : input.action === 'runHistory' ? dependencies.runHistory || runAttendanceWorkflowHistoryExamples
      : dependencies.runExamples || runAttendanceWorkflowExamples;
    await run(input.requestId, { ...dependencies, scope, requirePrepared: true });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    // Keep original durable run/checkpoints for retry; do not log data or auth.
    const code = ['GOOGLE_EMAIL_ORIGINAL_REQUIRED', 'GOOGLE_EMAIL_AUTHORIZATION_REQUIRED', 'GOOGLE_EMAIL_AUTHORIZATION_CONSUMED',
      'GOOGLE_EMAIL_EXISTING_DELIVERY_HOLD', 'GOOGLE_EMAIL_STORAGE_UNAVAILABLE', 'GOOGLE_EMAIL_STORAGE_UNCONFIRMED',
      'GOOGLE_EMAIL_ORIGINAL_INVALID', 'GOOGLE_EMAIL_AUTHORIZATION_INVALID', 'GOOGLE_EMAIL_REQUEST_INVALID', 'GOOGLE_EMAIL_DATE_EXPIRED',
      'WORKFLOW_EXAMPLES_IN_PROGRESS', 'WORKFLOW_EXAMPLES_KIND_MISMATCH', 'WORKFLOW_EXAMPLES_ORIGINAL_REQUIRED'].includes(error?.code)
      ? error.code : 'WORKFLOW_EXAMPLES_UNAVAILABLE';
    try { (dependencies.traceLog || console.info)('M1_TEST_WORKFLOW_EXAMPLES', JSON.stringify({ requestId: input.requestId, code })); } catch {}
    return jsonResponse(code === 'WORKFLOW_EXAMPLES_ORIGINAL_REQUIRED' ? 404 : code === 'WORKFLOW_EXAMPLES_UNAVAILABLE' ? 503 : 409, { ok: false, code });
  }
}
export default (request, context) => handleAttendanceWorkflowBackground(request, { context, env: process.env });
