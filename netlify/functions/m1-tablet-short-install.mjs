import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { getStore } from '@netlify/blobs';

import { jsonResponse, readJson } from './_lib/m1-common.mjs';
import {
  RICHMOND_PRODUCTION_HOST,
  RICHMOND_PRODUCTION_INSTALL_MAX_SECONDS,
  RICHMOND_PRODUCTION_INSTALL_STORE,
  RICHMOND_PRODUCTION_ORIGIN,
  createRichmondProductionDeviceCredential,
  richmondProductionDeviceCookieHeader,
  richmondProductionInstallerConfig
} from './_lib/m1-richmond-production-runtime.mjs';

export const SHORT_TABLET_INSTALL_PATH = '/install';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/install',
  rateLimit: {
    windowLimit: 8,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const CHALLENGE_COOKIE = '__Host-' + 'gib_m1_richmond_short_install';
const CHALLENGE_SECONDS = 3 * 60;
const MAX_REQUEST_BYTES = 32;
const CHALLENGE_PATTERN = /^v1\.[A-Za-z0-9_-]{43}\.[1-9][0-9]{8,11}\.[1-9][0-9]{8,11}\.[A-Za-z0-9_-]{43}$/u;
const SIGNATURE_DOMAIN = 'gib-m1-richmond-short-install-challenge:v1\0';
const CONSUMPTION_DOMAIN = 'gib-m1-richmond-short-install-consumption:v1\0';

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), accelerometer=(), gyroscope=(), magnetometer=(), usb=()'
});

function integerSeconds(value) {
  const text = typeof value === 'string' ? value : '';
  if (!/^[1-9][0-9]{8,11}$/u.test(text)) return Number.NaN;
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) ? numeric : Number.NaN;
}

function requestUrlIsExact(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  const host = request.headers.get('host');
  return url.origin === RICHMOND_PRODUCTION_ORIGIN
    && url.protocol === 'https:'
    && url.hostname === RICHMOND_PRODUCTION_HOST
    && url.host === RICHMOND_PRODUCTION_HOST
    && !url.port && !url.username && !url.password
    && url.pathname === SHORT_TABLET_INSTALL_PATH
    && !url.search && !url.hash
    && typeof host === 'string'
    && host.toLocaleLowerCase('en-US') === RICHMOND_PRODUCTION_HOST;
}

function validTypedNavigation(request) {
  if (request.method !== 'GET' || !requestUrlIsExact(request)) return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== RICHMOND_PRODUCTION_ORIGIN) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'none') return false;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode && mode !== 'navigate') return false;
  const destination = request.headers.get('sec-fetch-dest');
  return !destination || destination === 'document';
}

function validSameOriginPost(request) {
  if (request.method !== 'POST' || !requestUrlIsExact(request)) return false;
  if (request.headers.get('origin') !== RICHMOND_PRODUCTION_ORIGIN) return false;
  const site = request.headers.get('sec-fetch-site');
  return !site || site === 'same-origin';
}

function shortInstallConfig(env, requestUrl, dependencies, now) {
  const runtime = richmondProductionInstallerConfig(env, requestUrl, {
    installationId: dependencies.installationId,
    environment: dependencies.environment,
    activation: dependencies.activation
  });
  const issuedAt = integerSeconds(env.GIB_RICHMOND_PRODUCTION_INSTALL_ISSUED_AT);
  const expiresAt = integerSeconds(env.GIB_RICHMOND_PRODUCTION_INSTALL_EXPIRES_AT);
  const nowSeconds = Math.floor(Number(now) / 1_000);
  if (
    !runtime
    || !Number.isInteger(nowSeconds)
    || !Number.isInteger(issuedAt)
    || !Number.isInteger(expiresAt)
    || issuedAt > nowSeconds
    || expiresAt <= nowSeconds
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > RICHMOND_PRODUCTION_INSTALL_MAX_SECONDS
  ) return null;
  return Object.freeze({ ...runtime, issuedAt, expiresAt });
}

function challengeSignature(secret, runId, unsigned) {
  return createHmac('sha256', secret)
    .update(SIGNATURE_DOMAIN, 'utf8')
    .update(runId, 'utf8')
    .update('\0', 'utf8')
    .update(unsigned, 'utf8')
    .digest('base64url');
}

function equalSignature(left, right) {
  const leftHash = createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const rightHash = createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function createChallenge(runtime, now, randomBytesImpl = randomBytes) {
  const nowSeconds = Math.floor(Number(now) / 1_000);
  const nonceBytes = Buffer.from(randomBytesImpl(32));
  if (nonceBytes.length !== 32) throw new Error('Invalid challenge randomness.');
  const expiresAt = Math.min(runtime.expiresAt, nowSeconds + CHALLENGE_SECONDS);
  if (expiresAt <= nowSeconds) throw new Error('Invalid challenge lifetime.');
  const unsigned = `v1.${nonceBytes.toString('base64url')}.${nowSeconds}.${expiresAt}`;
  return `${unsigned}.${challengeSignature(runtime.installSecret, runtime.runId, unsigned)}`;
}

function challengeCookieHeader(challenge) {
  return [
    `${CHALLENGE_COOKIE}=${encodeURIComponent(challenge)}`,
    'Path=/',
    `Max-Age=${CHALLENGE_SECONDS}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict'
  ].join('; ');
}

function cookieValue(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function validChallenge(request, runtime, now) {
  const value = cookieValue(request, CHALLENGE_COOKIE);
  if (!CHALLENGE_PATTERN.test(value)) return false;
  const parts = value.split('.');
  const unsigned = parts.slice(0, 4).join('.');
  const issuedAt = integerSeconds(parts[2]);
  const expiresAt = integerSeconds(parts[3]);
  const nowSeconds = Math.floor(Number(now) / 1_000);
  return Number.isInteger(issuedAt)
    && Number.isInteger(expiresAt)
    && issuedAt <= nowSeconds
    && expiresAt > nowSeconds
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= CHALLENGE_SECONDS
    && equalSignature(
      parts[4],
      challengeSignature(runtime.installSecret, runtime.runId, unsigned)
    );
}

function nonceValue(randomBytesImpl = randomBytes) {
  const bytes = Buffer.from(randomBytesImpl(18));
  if (bytes.length !== 18) throw new Error('Invalid page randomness.');
  return bytes.toString('base64url');
}

function unavailableMarkup() {
  return [
    '<main class="card error" role="main">',
    '<div class="icon" aria-hidden="true">!</div>',
    '<h1>Setup unavailable</h1>',
    '<p>This one-time setup is expired, already used, or no longer valid.</p>',
    '<p>Nothing was installed. Auto-sync remains OFF.</p>',
    '</main>'
  ].join('');
}

const PAGE_STYLE = [
  ':root{color-scheme:light;font-family:Arial,sans-serif;background:#eef2f3;color:#172126}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}',
  '.card{width:100%;max-width:620px;background:#fff;border-radius:16px;padding:32px;text-align:center;box-shadow:0 12px 32px rgba(24,42,50,.14)}',
  '.icon{width:68px;height:68px;margin:0 auto 18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:700;background:#e6f4ea;color:#16723b}',
  '.working .icon{background:#e9f1f5;color:#315663;font-size:30px}',
  '.error .icon{background:#fce8e6;color:#a1291f}',
  'h1{font-size:30px;line-height:1.18;margin:0 0 14px}',
  'p{font-size:20px;line-height:1.45;margin:8px 0}',
  '.detail{font-size:17px;color:#48565d}'
].join('');

const PAGE_SCRIPT = [
  '(function(){',
  "'use strict';",
  "var EXPECTED_ORIGIN='https://gib-richmond-live.netlify.app';",
  "var EXPECTED_PATH='/install';",
  "var AUTO_KEY='gib_m1_richmond_production_sync_auto_v1';",
  'var PRESERVED_KEYS=[',
  "'gib_m1_richmond_production_local_state_v2',",
  "'gib_m1_richmond_production_sync_queue_v1',",
  "'gib_m1_richmond_production_signins_v1'",
  '];',
  "var heading=document.getElementById('heading');",
  "var message=document.getElementById('message');",
  "var detail=document.getElementById('detail');",
  "var card=document.getElementById('card');",
  "var icon=document.getElementById('icon');",
  'var finished=false;',
  'function showFailure(text){',
  'if(finished){return;}finished=true;',
  "card.className='card error';icon.textContent='!';heading.textContent='Setup could not be confirmed';",
  'message.textContent=text;',
  "detail.textContent='Do not refresh. Auto-sync remains OFF.';",
  '}',
  'function showUnavailable(){',
  'if(finished){return;}finished=true;',
  "card.className='card error';icon.textContent='!';heading.textContent='Setup unavailable';",
  "message.textContent='This one-time setup is expired, already used, or no longer valid.';",
  "detail.textContent='Nothing was installed. Auto-sync remains OFF.';",
  '}',
  'function showSuccess(){',
  'if(finished){return;}finished=true;',
  "card.className='card';icon.textContent='✓';heading.textContent='Richmond tablet authorized';",
  "message.textContent='Setup complete. Auto-sync is OFF.';detail.textContent='You can leave this page open.';",
  '}',
  'function locationIsExact(){',
  'return window.location.protocol===\'https:\'&&window.location.host===\'gib-richmond-live.netlify.app\'&&',
  "window.location.origin===EXPECTED_ORIGIN&&window.location.pathname===EXPECTED_PATH&&!window.location.search&&!window.location.hash;",
  '}',
  'function disableAutoSync(){',
  'var before=[];var index;',
  'for(index=0;index<PRESERVED_KEYS.length;index+=1){before[index]=window.localStorage.getItem(PRESERVED_KEYS[index]);}',
  "window.localStorage.setItem(AUTO_KEY,'false');",
  "if(window.localStorage.getItem(AUTO_KEY)!=='false'){throw new Error('storage');}",
  'for(index=0;index<PRESERVED_KEYS.length;index+=1){',
  "if(window.localStorage.getItem(PRESERVED_KEYS[index])!==before[index]){throw new Error('storage');}",
  '}',
  '}',
  'function install(){',
  "if(!locationIsExact()){showFailure('Authorization was not attempted at this location.');return;}",
  'try{disableAutoSync();}catch(error){',
  "showFailure('Authorization was not attempted because auto-sync could not be confirmed OFF.');return;",
  '}',
  'var request=new XMLHttpRequest();',
  "request.open('POST',EXPECTED_PATH,true);request.withCredentials=true;request.timeout=20000;",
  "request.setRequestHeader('Content-Type','application/json');",
  'request.onreadystatechange=function(){',
  'if(request.readyState!==4||finished){return;}',
  'var body=null;try{body=JSON.parse(request.responseText);}catch(error){}',
  'if(request.status===200&&body&&body.ok===true&&body.installed===true){',
  "try{if(window.localStorage.getItem(AUTO_KEY)!=='false'){throw new Error('storage');}}catch(error){",
  "showFailure('Authorization was installed, but auto-sync could not be confirmed OFF.');return;}",
  'showSuccess();return;',
  '}',
  'if(request.status===403||request.status===410||request.status===503){showUnavailable();return;}',
  "showFailure('The setup result could not be verified.');",
  '};',
  "request.onerror=function(){showFailure('The setup request did not finish.');};",
  "request.ontimeout=function(){showFailure('The setup request timed out.');};",
  "try{request.send('{}');}catch(error){showFailure('The setup request could not be sent.');}",
  '}',
  "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',install);}else{install();}",
  '}());'
].join('');

function pageHtml(nonce, available = true) {
  const content = available
    ? [
        '<main id="card" class="card working" role="main" aria-live="polite">',
        '<div id="icon" class="icon" aria-hidden="true">…</div>',
        '<h1 id="heading">Authorizing Richmond tablet</h1>',
        '<p id="message">Keeping auto-sync OFF and installing this device authorization.</p>',
        '<p id="detail" class="detail">Please keep this page open.</p>',
        '</main>',
        `<script nonce="${nonce}">${PAGE_SCRIPT}</script>`
      ].join('')
    : unavailableMarkup();
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow,noarchive">',
    '<title>Richmond tablet setup</title>',
    `<style nonce="${nonce}">${PAGE_STYLE}</style>`,
    '</head><body>', content, '</body></html>'
  ].join('');
}

function htmlResponse(status, html, nonce, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'"
      ].join('; '),
      ...extraHeaders
    }
  });
}

function shortJsonResponse(status, body, extraHeaders = {}) {
  return jsonResponse(status, body, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ...extraHeaders
  });
}

function rejectedResponse(status = 403) {
  return shortJsonResponse(status, {
    ok: false,
    message: 'This one-time setup is unavailable.'
  });
}

function defaultStore() {
  return getStore({
    name: RICHMOND_PRODUCTION_INSTALL_STORE,
    consistency: 'strong'
  });
}

function consumptionKey(runId) {
  return `richmond-production/install-short/v1/${createHash('sha256')
    .update(CONSUMPTION_DOMAIN, 'utf8')
    .update(runId, 'utf8')
    .digest('hex')}`;
}

async function consumeRun(runtime, now, dependencies) {
  const store = dependencies.store || await defaultStore();
  if (!store || typeof store.set !== 'function') throw new Error('Replay store unavailable.');
  const result = await store.set(
    consumptionKey(runtime.runId),
    JSON.stringify({
      v: 1,
      consumedAt: Math.floor(Number(now) / 1_000)
    }),
    { onlyIfNew: true }
  );
  return Boolean(result && result.modified === true);
}

async function handleGet(request, dependencies, env, now) {
  let nonce;
  try {
    nonce = nonceValue(dependencies.randomBytes);
  } catch {
    return new Response('Setup unavailable.', { status: 503, headers: SECURITY_HEADERS });
  }
  const runtime = shortInstallConfig(env, request.url, dependencies, now);
  if (!runtime) return htmlResponse(410, pageHtml(nonce, false), nonce);
  let challenge;
  try {
    challenge = createChallenge(runtime, now, dependencies.randomBytes);
  } catch {
    return htmlResponse(503, pageHtml(nonce, false), nonce);
  }
  return htmlResponse(200, pageHtml(nonce), nonce, {
    'Set-Cookie': challengeCookieHeader(challenge)
  });
}

async function handlePost(request, dependencies, env, now) {
  const runtime = shortInstallConfig(env, request.url, dependencies, now);
  if (!runtime || !validChallenge(request, runtime, now)) return rejectedResponse(403);
  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.response || Object.keys(parsed.value).length !== 0) return rejectedResponse(403);

  let consumed;
  try {
    consumed = await consumeRun(runtime, now, dependencies);
  } catch {
    return rejectedResponse(503);
  }
  if (!consumed) return rejectedResponse(410);

  let credential;
  try {
    credential = createRichmondProductionDeviceCredential(
      runtime.deviceToken,
      dependencies.randomBytes,
      now
    );
  } catch {
    // The one-time run remains consumed if credential creation or delivery fails.
    return rejectedResponse(503);
  }
  return shortJsonResponse(200, {
    ok: true,
    installed: true
  }, {
    'Set-Cookie': richmondProductionDeviceCookieHeader(credential)
  });
}

export async function handleShortTabletInstall(request, dependencies = {}) {
  if (!requestUrlIsExact(request)) return rejectedResponse(403);
  const env = dependencies.env || process.env;
  const now = dependencies.now ?? Date.now();
  if (request.method === 'GET') {
    if (!validTypedNavigation(request)) return rejectedResponse(403);
    return handleGet(request, dependencies, env, now);
  }
  if (request.method === 'POST') {
    if (!validSameOriginPost(request)) return rejectedResponse(403);
    return handlePost(request, dependencies, env, now);
  }
  return rejectedResponse(403);
}

export default request => handleShortTabletInstall(request);
