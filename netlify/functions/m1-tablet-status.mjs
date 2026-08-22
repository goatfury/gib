import { jsonResponse } from './_lib/m1-common.mjs';
import {
  exactObjectKeys,
  productionDeviceAuthorization,
  productionRuntimeConfig,
  validExactProductionRequest
} from './_lib/m1-production-runtime.mjs';
import {
  richmondProductionDeviceAuthorization,
  richmondProductionRuntimeConfig,
  validExactRichmondProductionRequest
} from './_lib/m1-richmond-production-runtime.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';

export const TABLET_STATUS_PATH = '/api/m1-tablet-status';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-tablet-status',
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

function statusResponse(status, authorized = false, richmond = null) {
  return jsonResponse(status, richmond
    ? {
      authorized: authorized === true,
      writesEnabled: richmond.writesEnabled === true,
      activation: richmond.writesEnabled === true ? 'active' : 'pending'
    }
    : { authorized: authorized === true });
}

async function readExactEmptyJson(request) {
  if (request.method !== 'POST') return false;
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:;|$)/iu.test(contentType.trim())) return false;
  let text;
  try {
    text = await request.text();
  } catch {
    return false;
  }
  if (!text || Buffer.byteLength(text, 'utf8') > 32) return false;
  try {
    return exactObjectKeys(JSON.parse(text), []);
  } catch {
    return false;
  }
}

export async function handleTabletStatus(request, dependencies = {}) {
  const profile = deploymentInstallationProfile(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  );
  const richmondProduction = profile?.installationId === 'richmond'
    && profile.environment === 'production';
  const validRequest = richmondProduction
    ? validExactRichmondProductionRequest(request, TABLET_STATUS_PATH)
    : validExactProductionRequest(request, TABLET_STATUS_PATH);
  if (!validRequest) {
    return statusResponse(403);
  }
  if (!await readExactEmptyJson(request)) return statusResponse(400);

  const runtime = richmondProduction
    ? richmondProductionRuntimeConfig(
      dependencies.env || process.env,
      request.url,
      {
        installationId: dependencies.installationId,
        environment: dependencies.environment,
        activation: dependencies.activation
      }
    )
    : productionRuntimeConfig(dependencies.env || process.env);
  if (!runtime) return statusResponse(503);
  const device = richmondProduction
    ? richmondProductionDeviceAuthorization(
      request,
      runtime,
      dependencies.now ?? Date.now()
    )
    : productionDeviceAuthorization(
    request,
    runtime,
    dependencies.now ?? Date.now()
    );
  return statusResponse(200, device.authorized, richmondProduction ? runtime : null);
}

export default request => handleTabletStatus(request);
