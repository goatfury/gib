import { randomBytes } from 'node:crypto';
import { promotionsDeviceCredential } from './promotions-runtime.mts';
import {
  API_OAUTH_PATH, API_CALLBACK_PATH, API_SETUP_PATH, API_SCOPES, API_CREDENTIAL_KEY,
  apiHash, apiError, safeApiError, apiStore, readApiRecord, writeApiRecord, validApiCredential,
  exchangeApiCode, initializePromotionsApi
} from './promotions-api.mts';

const STATE_COOKIE = '__Host-gib_m1_promotions_api_state';
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const FAILURE_PHASES = ['token','identity','api','state','storage','configuration','setup','authorization','other'];
const FAILURE_CODES = ['STATE','STORE','TOKEN_RESPONSE','TOKEN_SCOPE','TOKEN_IDENTITY','ACCESS_DENIED','TOKEN_REVOKED','REDIRECT',
  'INVALID_JSON','RESPONSE_TOO_LARGE','HTTP_ERROR','API_RESULT','INITIALIZE','SETUP_DISABLED','TIMEOUT','ABORTED','NETWORK','CONFIG','NOT_CONNECTED','OTHER'];
export function safeOAuthFailureDiagnostic(error, phase, elapsedMs) {
  const safe = safeApiError(error,phase);
  const record = { phase:FAILURE_PHASES.includes(safe.phase) ? safe.phase : 'other', code:FAILURE_CODES.includes(safe.code) ? safe.code : 'OTHER',
    ms:Number.isFinite(elapsedMs) ? Math.min(3600000,Math.max(0,Math.round(elapsedMs))) : 0 };
  if (Number.isInteger(safe.httpStatus) && safe.httpStatus >= 100 && safe.httpStatus <= 599) record.httpStatus = safe.httpStatus;
  if (record.code === 'TOKEN_SCOPE' && typeof safe.expectedScopesPresent === 'boolean' && typeof safe.openidPresent === 'boolean'
    && Number.isInteger(safe.unexpectedScopeCount) && safe.unexpectedScopeCount >= 0 && safe.unexpectedScopeCount <= 20) {
    record.expectedScopesPresent = safe.expectedScopesPresent;
    record.unexpectedScopeCount = safe.unexpectedScopeCount;
    record.openidPresent = safe.openidPresent;
  }
  return record;
}
const stateKey = state => 'rev/test/oauth-state/' + apiHash(state);
function responseHeaders() {
  return new Headers({ 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'" });
}
export function oauthJson(status, body) {
  const headers = responseHeaders(); headers.set('Content-Type','application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}
function cookie(value, age = 600) { return `${STATE_COOKIE}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`; }
function stateCookie(request) {
  const values = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(STATE_COOKIE + '='));
  return values.length === 1 && NONCE.test(values[0].slice(STATE_COOKIE.length + 1)) ? values[0].slice(STATE_COOKIE.length + 1) : '';
}
function cleanRedirect(config, result, diagnostic) {
  const query = new URLSearchParams();
  if (diagnostic) for (const [key,value] of Object.entries(diagnostic)) query.set(key,String(value));
  query.set('result',result);
  const headers = responseHeaders(); headers.set('Location',config.origin + API_SETUP_PATH + '?' + query); headers.set('Set-Cookie',cookie('',0));
  return new Response(null, { status:303, headers });
}
function correctHost(request, config, url) {
  return url.origin === config.origin && !url.username && !url.password && !url.port && !url.hash
    && request.headers.get('host')?.toLowerCase() === url.host.toLowerCase();
}
function setupRequest(request, config, url) {
  return correctHost(request, config, url) && url.pathname === API_OAUTH_PATH && !url.search && request.method === 'POST'
    && request.headers.get('origin') === config.origin && request.headers.get('sec-fetch-site') === 'same-origin'
    && /^application\/json(?:;|$)/iu.test(request.headers.get('content-type') || '');
}
export function authorizedApiSetupRequest(request, runtime, now = Date.now()) {
  return setupRequest(request,runtime,new URL(request.url)) && Boolean(promotionsDeviceCredential(request,runtime,now));
}
async function currentCredential(store, config) {
  const record = await readApiRecord(store, config, API_CREDENTIAL_KEY);
  if (record && !validApiCredential(record.value, config)) throw apiError('STORE','storage');
  return record;
}
export async function handleApiOAuth(request, runtime, config, dependencies = {}) {
  const url = new URL(request.url);
  const callback = url.pathname === API_CALLBACK_PATH;
  if (callback) {
    if (!config.setupEnabled || !correctHost(request, config, url) || request.method !== 'GET' || url.search.length > 8192) return oauthJson(403,{ok:false,error:{code:'UNAUTHORIZED'}});
    const signal = AbortSignal.any([request.signal, dependencies.signal || AbortSignal.timeout(25000)]);
    const started = performance.now();
    let phase = 'state';
    try {
      const now = dependencies.now ?? Date.now();
      const state = url.searchParams.get('state');
      const binder = stateCookie(request);
      if (!NONCE.test(state || '') || !binder || url.searchParams.getAll('state').length !== 1
        || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1) throw apiError('STATE','state');
      phase = 'storage';
      const store = await apiStore(dependencies,signal);
      const key = stateKey(state);
      const saved = await readApiRecord(store, config, key);
      const value = saved?.value;
      if (!saved || value?.version !== 1 || value.status !== 'pending' || value.browserHash !== apiHash(binder)
        || value.origin !== config.origin || value.clientId !== config.clientId || !NONCE.test(value.verifier || '')
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 600000) throw apiError('STATE','state');
      if (!await writeApiRecord(store, config, key, { ...value, status:'consumed', verifier:'' }, { onlyIfMatch:saved.etag })) throw apiError('STATE','state');
      if (url.searchParams.has('error')) throw apiError('ACCESS_DENIED','authorization');
      const code = url.searchParams.get('code');
      if (typeof code !== 'string' || !code || code.length > 2048 || /[\u0000-\u001f\u007f]/u.test(code)) throw apiError('STATE','state');
      if (await currentCredential(store,config)) return cleanRedirect(config,'already-connected');
      phase = 'token';
      const token = await exchangeApiCode(code,value.verifier,config,dependencies,signal);
      phase = 'api';
      await initializePromotionsApi(config,token.accessToken,dependencies,signal);
      const credential = { version:1, initialized:true, ownerEmail:config.ownerEmail, origin:config.origin,
        clientId:config.clientId, deploymentId:config.deploymentId, workbookId:config.workbookId,
        refreshToken:token.refreshToken, scope:token.scope, createdAt:now };
      phase = 'storage';
      if (!await writeApiRecord(store,config,API_CREDENTIAL_KEY,credential,{onlyIfNew:true})) return cleanRedirect(config,'already-connected');
      return cleanRedirect(config,'connected');
    } catch (error) {
      const diagnostic = safeOAuthFailureDiagnostic(error,phase,performance.now() - started);
      try { console.info(JSON.stringify({ kind:'GIB_TEST_API_OAUTH_FAILURE', ...diagnostic })); } catch (_) { /* Diagnostics cannot change callback handling. */ }
      return cleanRedirect(config,diagnostic.code === 'STATE' ? 'expired' : ['TOKEN_IDENTITY','TOKEN_SCOPE','ACCESS_DENIED'].includes(diagnostic.code) ? 'denied' : 'failed',diagnostic);
    }
  }
  if (!authorizedApiSetupRequest(request,runtime,dependencies.now ?? Date.now())) return oauthJson(401,{ok:false,error:{code:'UNAUTHORIZED'}});
  try {
    const text = await request.text();
    if (text.length > 2048) return oauthJson(400,{ok:false,error:{code:'VALIDATION'}});
    let input;
    try { input = JSON.parse(text); } catch { return oauthJson(400,{ok:false,error:{code:'VALIDATION'}}); }
    if (!input || Object.keys(input).length !== 1 || !['status','start'].includes(input.operation)) return oauthJson(400,{ok:false,error:{code:'VALIDATION'}});
    const signal = AbortSignal.any([request.signal, dependencies.signal || AbortSignal.timeout(25000)]);
    const store = await apiStore(dependencies,signal);
    const existing = await currentCredential(store,config);
    if (input.operation === 'status') return oauthJson(200,{ok:true,data:{configured:true,connected:Boolean(existing),setupEnabled:config.setupEnabled}});
    if (!config.setupEnabled) return oauthJson(403,{ok:false,error:{code:'SETUP_DISABLED'}});
    if (existing) return oauthJson(409,{ok:false,error:{code:'ALREADY_CONNECTED'}});
    const random = dependencies.randomBytes || randomBytes;
    const state = Buffer.from(random(32)).toString('base64url');
    const binder = Buffer.from(random(32)).toString('base64url');
    const verifier = Buffer.from(random(32)).toString('base64url');
    const now = dependencies.now ?? Date.now();
    const stored = await writeApiRecord(store,config,stateKey(state),{ version:1, status:'pending', origin:config.origin,
      clientId:config.clientId, browserHash:apiHash(binder), verifier, expiresAt:now + 600000 },{onlyIfNew:true});
    if (!stored) throw apiError('STATE','state');
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({ client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',
      scope:API_SCOPES.join(' '),access_type:'offline',prompt:'consent',login_hint:config.ownerEmail,include_granted_scopes:'false',
      state,code_challenge:Buffer.from(apiHash(verifier),'hex').toString('base64url'),code_challenge_method:'S256' }).toString();
    const response = oauthJson(200,{ok:true,data:{authorizationUrl:authorization.href}});response.headers.set('Set-Cookie',cookie(binder));return response;
  } catch (error) {
    const safe = safeApiError(error,'setup');
    return oauthJson(503,{ok:false,error:{code:['STORE','STATE'].includes(safe.code)?safe.code:'UNAVAILABLE'}});
  }
}
