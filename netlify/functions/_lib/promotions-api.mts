import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const PROMOTIONS_API_ENV_KEYS = [
  'GIB_PROMOTIONS_TEST_API_ENABLED', 'GIB_PROMOTIONS_TEST_API_SETUP_ENABLED',
  'GIB_PROMOTIONS_TEST_API_DEPLOYMENT_ID', 'GIB_PROMOTIONS_TEST_API_CLIENT_ID',
  'GIB_PROMOTIONS_TEST_API_CLIENT_SECRET', 'GIB_PROMOTIONS_TEST_API_OWNER_EMAIL', 'GIB_PROMOTIONS_TEST_API_WORKBOOK_ID'
];
export const API_TEST_ORIGIN = 'https://deploy-preview-86--gib-live.netlify.app';
export const API_OAUTH_PATH = '/api/m1-promotions-api-oauth';
export const API_CALLBACK_PATH = API_OAUTH_PATH + '/callback';
export const API_SETUP_PATH = '/m1/promotions-api-setup.html';
export const API_STORE_NAME = 'gib-m1-promotions-api-test-v1';
export const API_CREDENTIAL_KEY = 'rev/test/credential-v1';
export const API_SCOPES = Object.freeze(['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email']);
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const API_MODE = 'm1-authorized-tablet-test-v1';
const OWNER = 'revbjjops@gmail.com';
const bounded = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
export const apiHash = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function promotionsApiConfig(env, runtime) {
  if (!runtime || runtime.target !== 'test' || runtime.installation !== 'rev' || runtime.mode !== API_MODE
    || runtime.origin !== API_TEST_ORIGIN || !runtime.siteId || env?.GIB_PROMOTIONS_TEST_SITE_ID !== runtime.siteId
    || !bounded(runtime.installSecret, 32, 512) || !bounded(runtime.bridgeSecret, 32, 512)) return null;
  const enabled = env.GIB_PROMOTIONS_TEST_API_ENABLED === 'true';
  const setupEnabled = env.GIB_PROMOTIONS_TEST_API_SETUP_ENABLED === 'true';
  const deploymentId = env.GIB_PROMOTIONS_TEST_API_DEPLOYMENT_ID;
  const clientId = env.GIB_PROMOTIONS_TEST_API_CLIENT_ID;
  const clientSecret = env.GIB_PROMOTIONS_TEST_API_CLIENT_SECRET;
  const ownerEmail = env.GIB_PROMOTIONS_TEST_API_OWNER_EMAIL;
  const workbookId = env.GIB_PROMOTIONS_TEST_API_WORKBOOK_ID;
  if ((!enabled && !setupEnabled) || !/^[A-Za-z0-9_-]{12,512}$/u.test(deploymentId || '')
    || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(clientId || '')
    || !bounded(clientSecret, 16, 512) || ownerEmail !== OWNER || !/^[A-Za-z0-9_-]{16,128}$/u.test(workbookId || '')) return null;
  return Object.freeze({ target:'test', installation:'rev', mode:API_MODE, origin:API_TEST_ORIGIN, siteId:runtime.siteId,
    enabled, setupEnabled, deploymentId, clientId, clientSecret, ownerEmail, workbookId,
    redirectUri:API_TEST_ORIGIN + API_CALLBACK_PATH, bridgeSecret:runtime.bridgeSecret, installSecret:runtime.installSecret });
}

export class PromotionsApiError extends Error {
  constructor(code, phase = 'configuration') {
    super('The private TEST API connection did not confirm this request.');
    this.name = 'PromotionsApiError'; this.code = code; this.phase = phase;
  }
}
export const apiError = (code, phase) => new PromotionsApiError(code, phase);
async function withinSignal(work, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once:true });
    })]);
  } catch (error) { if (signal.aborted) throw signal.reason; throw error; }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}
export function safeApiError(error, phase = 'api') {
  if (error instanceof PromotionsApiError) return error;
  if ([error, error?.cause].some(value => value?.name === 'TimeoutError')) return apiError('TIMEOUT', phase);
  if ([error, error?.cause].some(value => value?.name === 'AbortError')) return apiError('ABORTED', phase);
  return apiError('NETWORK', phase);
}
export async function apiStore(dependencies = {}, signal = dependencies.signal || AbortSignal.timeout(25000)) {
  signal.throwIfAborted();
  let store = dependencies.store;
  if (!store) {
    const { getStore } = await import('@netlify/blobs');
    store = getStore({ name:API_STORE_NAME, consistency:'strong', fetch:async (url, options) => {
      // The SDK normally retries network/5xx failures. A terminal local 408
      // prevents background retries or writes after this request's deadline.
      try {
        signal.throwIfAborted();
        const response = await globalThis.fetch(url,{...options,signal});
        if (response.status !== 429 && response.status < 500) return response;
        void response.body?.cancel().catch(() => {});
      } catch { /* Store errors are surfaced only as the fixed STORE category. */ }
      return new Response(null,{status:408});
    } });
  }
  return {
    getWithMetadata:(...args) => withinSignal(() => store.getWithMetadata(...args),signal),
    set:(...args) => withinSignal(() => store.set(...args),signal)
  };
}
function storageContext(config, key) {
  return 'gib-promotions-api-test-store:v1\n' + [config.origin, config.siteId, config.clientId, config.deploymentId, config.workbookId, config.ownerEmail, key].join('\n');
}
function encryptionKey(config) {
  return Buffer.from(hkdfSync('sha256', config.installSecret, config.origin, 'gib-promotions-api-test-encryption:v1', 32));
}
export function encryptApiRecord(config, key, value, random = randomBytes) {
  const iv = Buffer.from(random(12));
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(config), iv);
  cipher.setAAD(Buffer.from(storageContext(config, key), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version:1, iv:iv.toString('base64url'), tag:cipher.getAuthTag().toString('base64url'), ciphertext:encrypted.toString('base64url') };
}
export function decryptApiRecord(config, key, record) {
  try {
    if (!record || Object.keys(record).sort().join(',') !== 'ciphertext,iv,tag,version' || record.version !== 1
      || !/^[A-Za-z0-9_-]{16}$/u.test(record.iv) || !/^[A-Za-z0-9_-]{22}$/u.test(record.tag)
      || !/^[A-Za-z0-9_-]{1,32000}$/u.test(record.ciphertext)) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(config), Buffer.from(record.iv, 'base64url'));
    decipher.setAAD(Buffer.from(storageContext(config, key), 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { throw apiError('STORE', 'storage'); }
}
export async function readApiRecord(store, config, key) {
  try {
    const found = await store.getWithMetadata(key, { type:'json', consistency:'strong' });
    if (!found) return null;
    if (!found.etag) throw new Error();
    const raw = typeof found.data === 'string' ? JSON.parse(found.data) : found.data;
    return { value:decryptApiRecord(config, key, raw), etag:found.etag };
  } catch { throw apiError('STORE', 'storage'); }
}
export async function writeApiRecord(store, config, key, value, condition) {
  try {
    const result = await store.set(key, JSON.stringify(encryptApiRecord(config, key, value)), condition);
    return result?.modified === true;
  } catch { throw apiError('STORE', 'storage'); }
}
export function validApiScopes(value) {
  if (typeof value !== 'string') return false;
  const scopes = value.trim().split(/\s+/u);
  return scopes.length === API_SCOPES.length && API_SCOPES.every(scope => scopes.includes(scope));
}
function scopeApiError(value) {
  const scopes = typeof value === 'string' ? value.trim().split(/\s+/u).filter(Boolean) : [];
  const error = apiError('TOKEN_SCOPE','token');
  error.expectedScopesPresent = API_SCOPES.every(scope => scopes.includes(scope));
  error.unexpectedScopeCount = Math.min(20,scopes.filter(scope => !API_SCOPES.includes(scope)).length);
  error.openidPresent = scopes.includes('openid');
  return error;
}
export function validApiCredential(value, config) {
  return value && value.version === 1 && value.initialized === true && value.ownerEmail === config.ownerEmail
    && value.clientId === config.clientId && value.deploymentId === config.deploymentId && value.origin === config.origin
    && value.workbookId === config.workbookId && bounded(value.refreshToken, 1, 4096)
    && validApiScopes(value.scope) && Number.isSafeInteger(value.createdAt) && value.createdAt > 0;
}

async function boundedJson(response, signal, maximum, phase) {
  let reader;
  let abort;
  try {
    signal.throwIfAborted();
    if (!response.body) throw apiError('INVALID_JSON', phase);
    reader = response.body.getReader();
    const aborted = new Promise((_, reject) => {
      abort = () => { void reader.cancel(signal.reason).catch(() => {}); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once:true });
    });
    const chunks = []; let size = 0;
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw apiError('RESPONSE_TOO_LARGE', phase);
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw apiError('INVALID_JSON', phase); }
  } catch (error) {
    if (reader) void reader.cancel().catch(() => {});
    else void response.body?.cancel().catch(() => {});
    throw safeApiError(error, phase);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    reader?.releaseLock();
  }
}
export async function apiJson(url, options, dependencies, maximum, phase) {
  const signal = options.signal;
  let httpStatus;
  try {
    signal.throwIfAborted();
    const response = await (dependencies.fetch || globalThis.fetch)(url, { ...options, redirect:'manual' });
    httpStatus = response.status;
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw apiError('REDIRECT', phase); }
    const body = await boundedJson(response, signal, maximum, phase);
    if (!response.ok) {
      if (phase === 'token' && body?.error === 'invalid_grant') throw apiError('TOKEN_REVOKED', phase);
      if ([401, 403].includes(response.status) || phase === 'token' && ['invalid_client','deleted_client','access_denied'].includes(body?.error)) throw apiError('ACCESS_DENIED', phase);
      throw apiError('HTTP_ERROR', phase);
    }
    return body;
  } catch (error) {
    const safe = safeApiError(error, phase);
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) safe.httpStatus = httpStatus;
    throw safe;
  }
}
function validToken(token) {
  return token && bounded(token.access_token, 1, 8192) && token.token_type === 'Bearer'
    && Number.isFinite(token.expires_in) && token.expires_in > 360 && token.expires_in <= 86400;
}
export async function exchangeApiCode(code, verifier, config, dependencies, signal) {
  const token = await apiJson(TOKEN_URL, { method:'POST', signal,
    headers:{ 'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json' },
    body:new URLSearchParams({ grant_type:'authorization_code', client_id:config.clientId, client_secret:config.clientSecret,
      redirect_uri:config.redirectUri, code, code_verifier:verifier }).toString()
  }, dependencies, 65536, 'token');
  if (!validToken(token) || !bounded(token.refresh_token, 1, 4096)) throw apiError('TOKEN_RESPONSE', 'token');
  if (!validApiScopes(token.scope)) throw scopeApiError(token.scope);
  const identity = await apiJson(USERINFO_URL, { method:'GET', signal,
    headers:{ Authorization:'Bearer ' + token.access_token, Accept:'application/json' }
  }, dependencies, 16384, 'identity');
  if (identity?.verified_email !== true || typeof identity.email !== 'string' || identity.email.toLowerCase() !== config.ownerEmail) throw apiError('TOKEN_IDENTITY', 'identity');
  return { accessToken:token.access_token, refreshToken:token.refresh_token, scope:token.scope };
}
async function refreshApiToken(credential, config, dependencies, signal) {
  const token = await apiJson(TOKEN_URL, { method:'POST', signal,
    headers:{ 'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json' },
    body:new URLSearchParams({ grant_type:'refresh_token', client_id:config.clientId, client_secret:config.clientSecret, refresh_token:credential.refreshToken }).toString()
  }, dependencies, 65536, 'token');
  if (!validToken(token)) throw apiError('TOKEN_RESPONSE', 'token');
  // OAuth permits scope omission on refresh: it then retains the verified grant.
  if (token.scope !== undefined && !validApiScopes(token.scope)) throw scopeApiError(token.scope);
  return token.access_token;
}
async function executeApiFunction(name, parameters, config, accessToken, dependencies, signal) {
  const result = await apiJson('https://script.googleapis.com/v1/scripts/' + config.deploymentId + ':run', {
    method:'POST', signal, headers:{ Authorization:'Bearer ' + accessToken, 'Content-Type':'application/json', Accept:'application/json' },
    body:JSON.stringify({ function:name, parameters, devMode:false })
  }, dependencies, 1000000, 'api');
  if (!result || result.done !== true || Object.hasOwn(result, 'error') || !result.response || !Object.hasOwn(result.response, 'result')) throw apiError('API_RESULT', 'api');
  return result.response.result;
}
export async function initializePromotionsApi(config, accessToken, dependencies, signal) {
  if (!config.setupEnabled) throw apiError('SETUP_DISABLED', 'configuration');
  const value = await executeApiFunction('configureTestReader', [{
    TEST_OWNER_EMAIL:config.ownerEmail, TEST_WORKBOOK_ID:config.workbookId, TEST_BRIDGE_ORIGIN:config.origin,
    TEST_BRIDGE_SECRET:config.bridgeSecret, TEST_BRIDGE_MODE:config.mode, TEST_BRIDGE_INSTALLATION:'rev'
  }], config, accessToken, dependencies, signal);
  if (!value || Object.keys(value).length !== 2 || value.ok !== true || !['configured','already_configured'].includes(value.status)) throw apiError('INITIALIZE', 'api');
}
export async function runPromotionsApiRead(envelope, config, dependencies = {}) {
  const started = performance.now(); let phase = 'configuration';
  const signal = dependencies.signal || AbortSignal.timeout(18000);
  try {
    if (!config?.enabled || config.target !== 'test' || config.origin !== API_TEST_ORIGIN || config.ownerEmail !== OWNER
      || !envelope || envelope.payload?.target !== 'test' || envelope.payload?.mode !== API_MODE
      || envelope.payload?.installation !== 'rev' || envelope.payload?.origin !== config.origin
      || !['bootstrap','readStudent'].includes(envelope.payload?.request?.operation)) throw apiError('CONFIG', phase);
    phase = 'storage'; signal.throwIfAborted();
    const store = await withinSignal(() => apiStore(dependencies,signal), signal);
    const found = await withinSignal(() => readApiRecord(store, config, API_CREDENTIAL_KEY), signal);
    signal.throwIfAborted();
    if (!found || !validApiCredential(found.value, config)) throw apiError('NOT_CONNECTED', phase);
    phase = 'token';
    // The isolated proof refreshes before each read, so revoked refresh access
    // fails before execution and no persistent access-token cache is needed.
    const accessToken = await refreshApiToken(found.value, config, dependencies, signal);
    phase = 'api';
    const wrapper = await executeApiFunction('readPromotions', [envelope], config, accessToken, dependencies, signal);
    return { wrapper, diagnostics:{ phase:'complete', ms:Math.max(0, Math.round(performance.now() - started)), errorCode:'none', attempts:1 } };
  } catch (error) {
    const safe = safeApiError(error, phase);
    safe.diagnostics = { phase:safe.phase, ms:Math.max(0, Math.round(performance.now() - started)), errorCode:safe.code, attempts:1 };
    throw safe;
  }
}
