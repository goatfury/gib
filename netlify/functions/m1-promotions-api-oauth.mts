import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import { PROMOTIONS_ENV_KEYS, promotionsRuntimeConfig } from './_lib/promotions-runtime.mts';
import { API_TEST_ORIGIN, PROMOTIONS_API_ENV_KEYS, promotionsApiConfig } from './_lib/promotions-api.mts';
import { handleApiOAuth, oauthJson, authorizedApiSetupRequest } from './_lib/promotions-api-oauth.mts';

export const config = { path:['/api/m1-promotions-api-oauth','/api/m1-promotions-api-oauth/callback'], rateLimit:{windowLimit:20,windowSize:60,aggregateBy:['ip','domain']} };
export async function handlePromotionsApiOAuth(request, dependencies = {}) {
  const env = dependencies.env || Object.fromEntries([...PROMOTIONS_ENV_KEYS,...PROMOTIONS_API_ENV_KEYS].map(key=>[key,globalThis.Netlify?.env?.get(key)]));
  const runtime = promotionsRuntimeConfig(env,{siteId:dependencies.siteId,
    installationId:dependencies.installationId || deploymentInstallationProfile()?.installationId,requestOrigin:new URL(request.url).origin});
  const api = promotionsApiConfig(env,runtime);
  if (!api) {
    if (runtime?.target === 'test' && runtime.origin === API_TEST_ORIGIN && authorizedApiSetupRequest(request,runtime,dependencies.now ?? Date.now())) {
      try {
        const text = await request.text();
        const body = text.length <= 2048 ? JSON.parse(text) : null;
        if (body && Object.keys(body).length === 1 && body.operation === 'status') return oauthJson(200,{ok:true,data:{configured:false,connected:false,setupEnabled:env.GIB_PROMOTIONS_TEST_API_SETUP_ENABLED === 'true'}});
      } catch { /* Only a safe configured flag is available before setup. */ }
    }
    return oauthJson(503,{ok:false,error:{code:'UNAVAILABLE'}});
  }
  return handleApiOAuth(request,runtime,api,dependencies);
}
export default (request,context) => handlePromotionsApiOAuth(request,{siteId:context?.site?.id});
