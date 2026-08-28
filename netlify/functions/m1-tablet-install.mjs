import { jsonResponse, readJson } from './_lib/m1-common.mjs';
import {
  PRODUCTION_INSTALL_STORE,
  createProductionDeviceCredential,
  exactObjectKeys,
  productionDeviceCookieHeader,
  productionInstallConsumptionKey,
  productionInstallerConfig,
  readProductionInstallCapability,
  validExactProductionRequest
} from './_lib/m1-production-runtime.mjs';
import {
  RICHMOND_PRODUCTION_INSTALL_STORE,
  createRichmondProductionDeviceCredential,
  readRichmondProductionInstallCapability,
  richmondProductionDeviceCookieHeader,
  richmondProductionInstallConsumptionKey,
  richmondProductionInstallerConfig,
  validExactRichmondProductionRequest
} from './_lib/m1-richmond-production-runtime.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';

export const TABLET_INSTALL_PATH = '/api/m1-tablet-install';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-tablet-install',
  rateLimit: {
    windowLimit: 5,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_INSTALL_REQUEST_BYTES = 4_096;

function rejectedInstallResponse() {
  return jsonResponse(403, {
    ok: false,
    message: 'Tablet installation was not accepted.'
  });
}

function unconfiguredInstallResponse() {
  return jsonResponse(503, {
    ok: false,
    message: 'Production tablet installation is not configured.'
  });
}

async function defaultStore(name = PRODUCTION_INSTALL_STORE) {
  const { getStore } = await import('@netlify/blobs');
  return getStore({
    name,
    consistency: 'strong'
  });
}

async function consumeCapability(token, now, dependencies, options = {}) {
  const store = dependencies.store || await defaultStore(options.storeName);
  if (!store || typeof store.set !== 'function') throw new Error('Replay store unavailable.');
  const key = options.consumptionKey(token);
  const result = await store.set(
    key,
    JSON.stringify({
      v: 1,
      consumedAt: Math.floor(Number(now) / 1_000)
    }),
    { onlyIfNew: true }
  );
  return Boolean(result && result.modified === true);
}

export async function handleTabletInstall(request, dependencies = {}) {
  const profile = deploymentInstallationProfile(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  );
  const richmondProduction = profile?.installationId === 'richmond'
    && profile.environment === 'production';
  const validRequest = richmondProduction
    ? validExactRichmondProductionRequest(request, TABLET_INSTALL_PATH)
    : validExactProductionRequest(request, TABLET_INSTALL_PATH);
  if (!validRequest) {
    return rejectedInstallResponse();
  }

  const parsed = await readJson(request, MAX_INSTALL_REQUEST_BYTES);
  if (parsed.response) return rejectedInstallResponse();
  if (
    !exactObjectKeys(parsed.value, ['capability'])
    || typeof parsed.value.capability !== 'string'
  ) return rejectedInstallResponse();

  const env = dependencies.env || process.env;
  const runtime = richmondProduction
    ? richmondProductionInstallerConfig(env, request.url, {
      installationId: dependencies.installationId,
      environment: dependencies.environment,
      activation: dependencies.activation
    })
    : productionInstallerConfig(env);
  if (!runtime) return unconfiguredInstallResponse();

  const now = dependencies.now ?? Date.now();
  const capability = (richmondProduction
    ? readRichmondProductionInstallCapability
    : readProductionInstallCapability)(
    parsed.value.capability,
    runtime,
    now
  );
  if (!capability) return rejectedInstallResponse();

  let consumed;
  try {
    consumed = await consumeCapability(parsed.value.capability, now, dependencies, {
      storeName: richmondProduction
        ? RICHMOND_PRODUCTION_INSTALL_STORE
        : PRODUCTION_INSTALL_STORE,
      consumptionKey: richmondProduction
        ? richmondProductionInstallConsumptionKey
        : productionInstallConsumptionKey
    });
  } catch {
    return unconfiguredInstallResponse();
  }
  if (!consumed) return rejectedInstallResponse();

  let credential;
  try {
    credential = (richmondProduction
      ? createRichmondProductionDeviceCredential
      : createProductionDeviceCredential)(
      runtime.deviceToken,
      dependencies.randomBytes,
      now
    );
  } catch {
    // The capability remains burned if credential creation or response delivery
    // fails. A new run-bound capability is required; replays never recover it.
    return unconfiguredInstallResponse();
  }

  return jsonResponse(200, {
    ok: true,
    installed: true
  }, {
    'Set-Cookie': (richmondProduction
      ? richmondProductionDeviceCookieHeader
      : productionDeviceCookieHeader)(credential)
  });
}

export default request => handleTabletInstall(request);
