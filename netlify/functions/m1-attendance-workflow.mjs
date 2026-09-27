import { ADMIN_REQUEST_HEADER, jsonResponse, readJson, requireAdmin, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { DIGEST_ORIGIN } from './_lib/m1-attendance-digest.mjs';
import { validId } from './_lib/m1-test-read-callback.mjs';
import { readAttendanceWorkflowExamples, prepareAttendanceWorkflowExamples } from './_lib/m1-attendance-workflow-examples.mjs';
import { workflowHealth, workflowMessages } from './_lib/m1-attendance-digest-workflow.mjs';

export const config = { path: '/api/m1-attendance-workflow', rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
const response = (status, value) => jsonResponse(status, value);
export async function handleAttendanceWorkflow(request, dependencies = {}) {
  const url = new URL(request.url);
  if (url.pathname !== config.path || url.hash || !['GET', 'POST'].includes(request.method)
    || [...url.searchParams.keys()].some(key => key !== 'runId') || url.searchParams.getAll('runId').length > 1
    || (request.method === 'POST' && url.search)) return response(404, { ok: false, message: 'TEST workflow unavailable.' });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope) return response(403, { ok: false, message: 'Revolution TEST required.' });
  if ((request.headers.get('Origin') && request.headers.get('Origin') !== DIGEST_ORIGIN)
    || (request.headers.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(request.headers.get('Sec-Fetch-Site'))))
    return response(403, { ok: false, message: 'Use the authenticated Admin page.' });
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: 'rev' });
  if (runtime?.target !== 'test') return response(503, { ok: false, message: 'TEST service unavailable.' });
  const auth = requireAdmin(request, runtime, (dependencies.clock || Date.now)());
  if (auth.response) return auth.response;
  const deps = { ...dependencies, scope };
  try {
    let latestRun;
    if (request.method === 'GET') {
      const id = url.searchParams.get('runId');
      if (id !== null && !validId(id)) return response(400, { ok: false, message: 'Use the original TEST example request.' });
      latestRun = await (dependencies.readExamples || readAttendanceWorkflowExamples)(id, deps);
    } else {
      const parsed = await readJson(request, 4096);
      if (parsed.response) return parsed.response;
      const input = parsed.value;
      if (!input || Object.keys(input).sort().join('|') !== 'action|requestId' || input.action !== 'runExamples' || !validId(input.requestId))
        return response(400, { ok: false, message: 'Choose the isolated TEST examples. Real sending is disabled.' });
      // This adapter owns its fixed synthetic data and simulated provider. Client
      // input cannot supply recipients, a provider URL, credentials or send flags.
      await (dependencies.prepareExamples || prepareAttendanceWorkflowExamples)(input.requestId, deps);
      latestRun = await (dependencies.readExamples || readAttendanceWorkflowExamples)(input.requestId, deps);
      if (!latestRun) {
        // The run is durably recorded before invoking the supported background
        // function. Its 202 is dispatch acknowledgment, never a passed result.
        const dispatch = dependencies.dispatchExamples || (async runId => {
          const result = await fetch(DIGEST_ORIGIN + '/api/m1-attendance-workflow-background', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { 'Content-Type': 'application/json', Origin: DIGEST_ORIGIN,
              Cookie: request.headers.get('Cookie') || '', [ADMIN_REQUEST_HEADER]: request.headers.get(ADMIN_REQUEST_HEADER) || '' },
            body: JSON.stringify({ action: 'runExamples', requestId: runId })
          });
          await result.body?.cancel();
          if (result.status !== 202) throw new Error('Dispatch unavailable');
        });
        await dispatch(input.requestId);
        return response(202, { ok: true, target: 'test', sendingEnabled: false, recurringEnabled: false,
          latestRun: null, request: { runId: input.requestId, state: 'pending' } });
      }
    }
    const health = await (dependencies.readHealth || workflowHealth)(scope, deps);
    const messages = await (dependencies.readMessages || workflowMessages)(scope, deps);
    return response(200, { ok: true, target: 'test', sendingEnabled: false, recurringEnabled: false,
      latestRun: latestRun || null, current: { health, messages },
      setup: { revolutionReviewer: 'Stu', richmondReviewer: 'Trey', copyAndrewDefault: false,
        recipientAddressesVerified: false, richmondReviewerAccessVerified: false, senderVerified: false, cutoffConfirmed: false } });
  } catch (error) {
    const code = error?.code === 'WORKFLOW_EXAMPLES_IN_PROGRESS' ? error.code : 'WORKFLOW_UNAVAILABLE';
    return response(code === 'WORKFLOW_EXAMPLES_IN_PROGRESS' ? 409 : 503, { ok: false, code,
      message: code === 'WORKFLOW_EXAMPLES_IN_PROGRESS' ? 'The original TEST run is still in progress. Check that same run again.'
        : 'Attendance workflow status unavailable. Keep the original request; this is not an all-clear.' });
  }
}
export default (request, context) => handleAttendanceWorkflow(request, { context, env: process.env });
