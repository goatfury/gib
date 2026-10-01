import { jsonResponse, readJson, runtimeConfig, validTestSameOriginRequest } from './_lib/m1-common.mjs';
import { releaseFeatureScope } from './_lib/m1-release-scope.mjs';
import { productionDeviceAuthorization, productionRuntimeConfig, validExactProductionRequest } from './_lib/m1-production-runtime.mjs';
import { richmondProductionDeviceAuthorization, richmondProductionRuntimeConfig, validExactRichmondProductionRequest } from './_lib/m1-richmond-production-runtime.mjs';
import { recordUploadEvidence, uploadEvidenceStore } from './_lib/m1-upload-evidence.mjs';

export const config = { path: '/api/m1-upload-evidence', rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleUploadEvidence(request, dependencies = {}) {
  const url = new URL(request.url), env = dependencies.env || process.env;
  if (request.method !== 'POST' || url.pathname !== config.path || url.search || url.hash) return jsonResponse(404, { ok: false });
  const scope = releaseFeatureScope(request, 'reminders', dependencies);
  if (!scope) return jsonResponse(403, { ok: false });
  const now = (dependencies.clock || Date.now)();
  if (scope.target === 'production') {
    const richmond = scope.profile.installationId === 'richmond';
    if (!(richmond ? validExactRichmondProductionRequest : validExactProductionRequest)(request, config.path)) return jsonResponse(403, { ok: false });
    const runtime = richmond ? richmondProductionRuntimeConfig(env, request.url, { installationId: 'richmond', environment: 'production', activation: 'active' }) : productionRuntimeConfig(env);
    if (!runtime || !(richmond ? richmondProductionDeviceAuthorization : productionDeviceAuthorization)(request, runtime, now).authorized) return jsonResponse(401, { ok: false });
  } else if (!validTestSameOriginRequest(request, config.path, scope.profile.installationId, scope.profile.environment, scope.profile.activation)
    || !runtimeConfig(env, { requestUrl: request.url, installationId: scope.profile.installationId })) return jsonResponse(403, { ok: false });
  const parsed = await readJson(request, 160000); if (parsed.response) return parsed.response;
  try { return jsonResponse(200, await recordUploadEvidence(dependencies.uploadStore || await uploadEvidenceStore(scope), parsed.value, now)); }
  catch { return jsonResponse(503, { ok: false, code: 'UPLOAD_EVIDENCE_UNAVAILABLE' }); }
}
export default (request, context) => handleUploadEvidence(request, { context, env: process.env });
