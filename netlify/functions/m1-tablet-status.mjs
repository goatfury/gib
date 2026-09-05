import { jsonResponse, postGoogle } from './_lib/m1-common.mjs';
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
export const CONNECTION_CHECK_HEADER = 'X-GIB-M1-Connection-Check';
export const CONNECTION_CODE_HEADER = 'X-GIB-M1-Check-Code';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-tablet-status',
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

function statusResponse(status, authorized = false, richmond = null, headers = {}) {
  return jsonResponse(status, richmond
    ? {
      authorized: authorized === true,
      writesEnabled: richmond.writesEnabled === true,
      activation: richmond.writesEnabled === true ? 'active' : 'pending'
    }
    : { authorized: authorized === true }, headers);
}

export function richmondLedgerCheckCode(google) {
  // Only fixed, nonsecret categories leave the server. Never return an
  // upstream body, URL, credential, exception, sheet ID, or row data.
  if (google?.readable !== true) {
    const codes = {
      UNREACHABLE: 'TIMEOUT_OR_NETWORK',
      HTML: 'HTML_RESPONSE',
      HTTP_FAILURE: 'HTTP_FAILURE',
      EMPTY: 'EMPTY_RESPONSE',
      READ_FAILED: 'INCOMPLETE_RESPONSE'
    };
    return Object.hasOwn(codes, google?.failureClass)
      ? codes[google.failureClass] : 'INVALID_RESPONSE';
  }
  const value = google?.readable === true ? google.value : null;
  if (value?.ok !== true) {
    return value?.result === 'rejected' ? 'RECEIVER_REJECTED' : 'RECEIVER_FAILED';
  }
  if (!exactObjectKeys(value, [
    'ok',
    'target',
    'installation',
    'environment',
    'empty',
    'signinsRows',
    'auditRows',
    'writesEnabled'
  ])) return 'CONTRACT_MISMATCH';
  if (
    value.ok !== true
    || value.target !== 'production'
    || value.installation !== 'richmond'
    || value.environment !== 'production'
    || !Number.isSafeInteger(value.signinsRows)
    || value.signinsRows < 0
    || !Number.isSafeInteger(value.auditRows)
    || value.auditRows < 0
    || value.empty !== (value.signinsRows === 0 && value.auditRows === 0)
  ) return 'CONTRACT_MISMATCH';
  if (value.writesEnabled === true) return 'CONFIRMED';
  return value.writesEnabled === false ? 'WRITES_DISABLED' : 'CONTRACT_MISMATCH';
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
  // The existing tablet authorization remains mandatory. Normal startup
  // responses keep the exact same body and receive no diagnostic header.
  const detailsRequested = richmondProduction && device.authorized
    && request.headers.get(CONNECTION_CHECK_HEADER) === 'details-v1';
  const details = code => detailsRequested ? { [CONNECTION_CODE_HEADER]: code } : {};
  if (richmondProduction && runtime.writesEnabled === true && device.authorized) {
    const google = await postGoogle(
      runtime,
      'ledgerStatus',
      {},
      dependencies.fetch || fetch
    );
    const code = richmondLedgerCheckCode(google);
    if (code !== 'CONFIRMED') {
      return statusResponse(503, true, { writesEnabled: false }, details(code));
    }
    return statusResponse(200, true, runtime, details('CONFIRMED'));
  }
  return statusResponse(200, device.authorized, richmondProduction ? runtime : null,
    details('SERVER_WRITES_DISABLED'));
}

export default request => handleTabletStatus(request);
