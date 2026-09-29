import { constantTimeSecretEqual, jsonResponse, runtimeConfig } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { digestGym } from './_lib/m1-attendance-digest.mjs';
import { validId } from './_lib/m1-test-read-callback.mjs';
import { executeAttendanceWorkflowJob, workflowDispatchSignature, WORKFLOW_DISPATCH_HEADER, WORKFLOW_DISPATCH_PATH } from './_lib/m1-attendance-digest-workflow.mjs';

export const config = { path: '/api/m1-attendance-delivery-background' };
export async function handleAttendanceDeliveryBackground(request, dependencies = {}) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== WORKFLOW_DISPATCH_PATH || url.search || url.hash) return jsonResponse(404, { ok: false });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope) return jsonResponse(403, { ok: false, code: 'WORKFLOW_TEST_SCOPE_REQUIRED' });
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: digestGym(scope), environment: scope.profile.environment, activation: scope.profile.activation });
  if (runtime?.target !== scope.target) return jsonResponse(503, { ok: false, code: 'WORKFLOW_RUNTIME_UNAVAILABLE' });
  try {
    const raw = await request.text(), signature = request.headers.get(WORKFLOW_DISPATCH_HEADER);
    if (Buffer.byteLength(raw, 'utf8') > 128 || !/^[a-f0-9]{64}$/.test(signature || '') || !constantTimeSecretEqual(signature, workflowDispatchSignature(raw, runtime.adminActionToken))) return jsonResponse(403, { ok: false, code: 'WORKFLOW_AUTHENTICATION_REQUIRED' });
    const value = JSON.parse(raw);
    if (!value || Object.keys(value).join('|') !== 'jobId' || !validId(value.jobId)) return jsonResponse(400, { ok: false, code: 'WORKFLOW_JOB_INVALID' });
    // Netlify owns this awaited invocation for the background function lifetime.
    const result = await executeAttendanceWorkflowJob(value.jobId, scope, dependencies);
    return jsonResponse(200, { ok: true, ...result });
  } catch { return jsonResponse(503, { ok: false, code: 'WORKFLOW_JOB_UNCONFIRMED' }); }
}
export default (request, context) => handleAttendanceDeliveryBackground(request, { context, env: process.env });
