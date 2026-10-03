import { jsonResponse, readJson, runtimeConfig, validTestSameOriginRequest } from './_lib/m1-common.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import { releaseFeatureScope } from './_lib/m1-release-scope.mjs';
import { productionDeviceAuthorization, productionRuntimeConfig, validExactProductionRequest } from './_lib/m1-production-runtime.mjs';
import { richmondProductionDeviceAuthorization, richmondProductionRuntimeConfig, validExactRichmondProductionRequest } from './_lib/m1-richmond-production-runtime.mjs';
import { recordUploadEvidence, uploadEvidenceStore } from './_lib/m1-upload-evidence.mjs';

export const config = { path: '/api/m1-upload-evidence', rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleUploadEvidence(request, dependencies = {}) {
  const url = new URL(request.url), env = dependencies.env || process.env;
  const profile = deploymentInstallationProfile(dependencies.installationId, dependencies.environment, dependencies.activation);
  function trace(stage, status) {
    const expected = profile?.allowedOrigin ? new URL(profile.allowedOrigin) : null;
    const requestId = dependencies.context?.requestId;
    const event = { schema: 'm1-upload-request-status/v1', stage, status,
      gym: ['rev', 'richmond'].includes(profile?.installationId) ? profile.installationId : null,
      requestId: typeof requestId === 'string' && /^[A-Za-z0-9_:-]{8,128}$/.test(requestId) ? requestId : null,
      urlMatchesExpected: Boolean(expected && url.origin === expected.origin),
      hostMatchesExpected: Boolean(expected && request.headers.get('host')?.toLowerCase() === expected.host),
      originMatchesExpected: Boolean(expected && request.headers.get('origin') === expected.origin),
      sameOriginFetch: request.headers.get('sec-fetch-site') === 'same-origin' };
    // No body, manifest, header values, credentials, IPs or instructor details.
    try { (dependencies.traceLog || (value => console.info(JSON.stringify(value))))(event); } catch {}
  }
  const finish = (status, stage, body = { ok: false }) => { trace(stage, status); return jsonResponse(status, body); };
  if (request.method !== 'POST' || url.pathname !== config.path || url.search || url.hash) return finish(404, 'route-rejected');
  const scope = releaseFeatureScope(request, 'reminders', dependencies);
  if (!scope) return finish(403, 'scope-rejected');
  const now = (dependencies.clock || Date.now)();
  if (scope.target === 'production') {
    const richmond = scope.profile.installationId === 'richmond';
    if (!(richmond ? validExactRichmondProductionRequest : validExactProductionRequest)(request, config.path)) return finish(403, 'origin-rejected');
    const runtime = richmond ? richmondProductionRuntimeConfig(env, request.url, { installationId: 'richmond', environment: 'production', activation: 'active' }) : productionRuntimeConfig(env);
    if (!runtime) return finish(401, 'runtime-unavailable');
    if (!(richmond ? richmondProductionDeviceAuthorization : productionDeviceAuthorization)(request, runtime, now).authorized) return finish(401, 'device-authorization-rejected');
  } else if (!validTestSameOriginRequest(request, config.path, scope.profile.installationId, scope.profile.environment, scope.profile.activation)
    || !runtimeConfig(env, { requestUrl: request.url, installationId: scope.profile.installationId })) return finish(403, 'origin-rejected');
  const parsed = await readJson(request, 160000);
  if (parsed.response) { trace('json-rejected', parsed.response.status); return parsed.response; }
  try {
    const receipt = await recordUploadEvidence(dependencies.uploadStore || await uploadEvidenceStore(scope), parsed.value, now);
    return finish(200, 'report-stored', receipt);
  } catch { return finish(503, 'manifest-or-persistence-unconfirmed', { ok: false, code: 'UPLOAD_EVIDENCE_UNAVAILABLE' }); }
}
export default (request, context) => handleUploadEvidence(request, { context, env: process.env });
