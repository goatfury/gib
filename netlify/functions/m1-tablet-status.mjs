import { jsonResponse } from './_lib/m1-common.mjs';
import {
  exactObjectKeys,
  productionDeviceAuthorization,
  productionRuntimeConfig,
  validExactProductionRequest
} from './_lib/m1-production-runtime.mjs';

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

function statusResponse(status, authorized = false) {
  return jsonResponse(status, { authorized: authorized === true });
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
  if (!validExactProductionRequest(request, TABLET_STATUS_PATH)) {
    return statusResponse(403);
  }
  if (!await readExactEmptyJson(request)) return statusResponse(400);

  const runtime = productionRuntimeConfig(dependencies.env || process.env);
  if (!runtime) return statusResponse(503);
  const device = productionDeviceAuthorization(
    request,
    runtime,
    dependencies.now ?? Date.now()
  );
  return statusResponse(200, device.authorized);
}

export default request => handleTabletStatus(request);
