import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  ADMIN_COOKIE,
  ADMIN_REQUEST_HEADER,
  createAdminSession
} from '../netlify/functions/_lib/m1-common.mjs';
import {
  CAPABILITY_COOKIE,
  CAPABILITY_PATH,
  CAPABILITY_SECONDS,
  CREDENTIAL_PROOF_DOMAIN,
  DIAGNOSTIC_PURPOSE,
  ENDPOINT_PROOF_DOMAIN,
  INSTALL_PURPOSE,
  PREVIEW_LEGACY_KIOSK_ENV,
  PRODUCTION_LEGACY_KIOSK_ENV,
  config as verifierConfig,
  handleAdminTabletDiagnostic
} from '../netlify/functions/m1-admin-tablet-diagnostic.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const diagnosticHtml = read('m1/tablet-diagnostic.html');
const adminHtml = read('m1/admin/index.html');
const verifierSource = read('netlify/functions/m1-admin-tablet-diagnostic.mjs');
const kioskHtml = read('m1/index.html');
const workflow = read('.github/workflows/m1-admin-only-required.yml');
const runbook = read('docs/m1-kiosk-sync-incident-runbook.md');

const PROD_ORIGIN = 'https://gib-live.netlify.app';
const PREVIEW_ORIGIN = 'https://deploy-preview-47--gib-live.netlify.app';
const DIAGNOSTIC_PATH = '/m1/tablet-diagnostic.html';
const VERIFIER_PATH = '/api/m1-tablet-diagnostic-verifier';
const REQUEST_TYPE = 'gib:m1:diagnostic-request:v1';
const INSTALL_INIT_TYPE = 'gib:m1:diagnostic-install-init:v1';
const INSTALL_READY_TYPE = 'gib:m1:diagnostic-install-ready:v1';
const INSTALL_REQUEST_TYPE = 'gib:m1:diagnostic-install-request:v1';
const PROOFS_TYPE = 'gib:m1:diagnostic-proofs:v1';
const RESULT_TYPE = 'gib:m1:diagnostic-result:v1';
const INSTALL_RESULT_TYPE = 'gib:m1:diagnostic-install-result:v1';
const ADMIN_TOKEN = Buffer.alloc(32, 7).toString('base64url');
const ALT_ADMIN_TOKEN = Buffer.alloc(32, 8).toString('base64url');
const NOW = Date.parse('2026-08-05T12:00:00Z');
const RUN_A = 'a'.repeat(32);
const RUN_B = 'b'.repeat(32);
const PROD_TRANSPORT_TOKEN = Buffer.alloc(24, 11).toString('base64url');
const PROD_LEGACY_TOKEN = Buffer.alloc(18, 12).toString('base64url');
const PREVIEW_TRANSPORT_TOKEN = Buffer.alloc(24, 13).toString('base64url');
const PREVIEW_LEGACY_TOKEN = Buffer.alloc(18, 14).toString('base64url');
const syntheticGoogleUrl = label => ['https://', 'script.google.com', '/macros/s/', label, '/exec'].join('');
const PROD_WEBHOOK_URL = syntheticGoogleUrl(['SYNTHETIC', 'TEST', 'TARGET'].join('_'));
const PREVIEW_WEBHOOK_URL = syntheticGoogleUrl(['SYNTHETIC', 'PREVIEW', 'TARGET'].join('_'));
const PROD_ENV = Object.freeze({
  GIB_M1_WEBHOOK_URL: PROD_WEBHOOK_URL,
  GIB_M1_WEBHOOK_TOKEN: PROD_TRANSPORT_TOKEN,
  [PRODUCTION_LEGACY_KIOSK_ENV]: PROD_LEGACY_TOKEN,
  GIB_M1_ADMIN_ACTION_TOKEN: 'synthetic-admin-action-token',
  GIB_M1_ADMIN_PASSPHRASE: 'synthetic private admin access phrase'
});
const PREVIEW_ENV = Object.freeze({
  ...PROD_ENV,
  GIB_TEST_WEBHOOK_URL: PREVIEW_WEBHOOK_URL,
  GIB_TEST_WEBHOOK_TOKEN: PREVIEW_TRANSPORT_TOKEN,
  [PREVIEW_LEGACY_KIOSK_ENV]: PREVIEW_LEGACY_TOKEN,
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-preview-admin-token'
});

const json = async response => JSON.parse(await response.text());
const cookiePair = response => (response.headers.get('set-cookie') || '').split(';', 1)[0];
const secretFor = (origin, env) => origin === PROD_ORIGIN
  ? env.GIB_M1_ADMIN_PASSPHRASE
  : env.GIB_TEST_WEBHOOK_TOKEN;

function adminCookie(origin = PROD_ORIGIN, env = PROD_ENV, token = ADMIN_TOKEN, name = 'Andrew Smith') {
  const value = createAdminSession(name, secretFor(origin, env), NOW, token);
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}`;
}

function actionRequest({
  origin = PROD_ORIGIN,
  body,
  adminCookieValue = adminCookie(origin, origin === PROD_ORIGIN ? PROD_ENV : PREVIEW_ENV),
  capabilityCookie = '',
  adminHeader = null
}) {
  const cookies = [adminCookieValue, capabilityCookie].filter(Boolean).join('; ');
  return new Request(`${origin}${VERIFIER_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Host: new URL(origin).host,
      'Sec-Fetch-Site': 'same-origin',
      ...(cookies ? { Cookie: cookies } : {}),
      ...(adminHeader == null ? {} : { [ADMIN_REQUEST_HEADER]: adminHeader })
    },
    body: JSON.stringify(body)
  });
}

function deterministicRandom(seed) {
  let call = 0;
  return length => Buffer.alloc(length, (seed + call++) & 0xff);
}

async function issue({
  origin = PROD_ORIGIN,
  env = PROD_ENV,
  runId = RUN_A,
  token = ADMIN_TOKEN,
  seed = 10,
  cookie = adminCookie(origin, env, token)
} = {}) {
  const response = await handleAdminTabletDiagnostic(actionRequest({
    origin,
    body: { action: 'issue', runId },
    adminCookieValue: cookie,
    adminHeader: token
  }), { env, now: NOW, randomBytes: deterministicRandom(seed) });
  const body = await json(response);
  return { response, body, capabilityCookie: cookiePair(response) };
}

async function issueInstall({
  origin = PROD_ORIGIN,
  env = PROD_ENV,
  runId = RUN_A,
  token = ADMIN_TOKEN,
  seed = 50,
  cookie = adminCookie(origin, env, token),
  adminHeader = token,
  clientKeyPair = null,
  clientPublicKey = null
} = {}) {
  const client = clientKeyPair || (clientPublicKey ? null : await generateInstallClientKeyPair());
  const publicKey = clientPublicKey || client.publicKey;
  const response = await handleAdminTabletDiagnostic(actionRequest({
    origin,
    body: { action: 'issue-install', runId, clientPublicKey: publicKey },
    adminCookieValue: cookie,
    adminHeader
  }), { env, now: NOW, randomBytes: deterministicRandom(seed) });
  const body = await json(response);
  return {
    response,
    body,
    capabilityCookie: cookiePair(response),
    clientPrivateKey: client && client.privateKey
  };
}

async function generateInstallClientKeyPair() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: {
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
      y: exported.y,
      ext: true,
      key_ops: []
    }
  };
}

function hmacProof(proofKey, runId, domain, value) {
  return createHmac('sha256', Buffer.from(proofKey, 'utf8'))
    .update(`${domain}\0${runId}\0${value}`, 'utf8')
    .digest('hex');
}

function proofBody(issued, runId = issued.body.runId, env = PROD_ENV, purpose = DIAGNOSTIC_PURPOSE) {
  return {
    action: 'verify',
    purpose,
    runId,
    endpointProof: hmacProof(issued.body.proofKey, runId, ENDPOINT_PROOF_DOMAIN,
      env.GIB_M1_WEBHOOK_URL || env.GIB_TEST_WEBHOOK_URL),
    credentialProof: hmacProof(issued.body.proofKey, runId, CREDENTIAL_PROOF_DOMAIN,
      env[PRODUCTION_LEGACY_KIOSK_ENV])
  };
}

function assertCapabilityCleared(response) {
  const value = response.headers.get('set-cookie') || '';
  assert.match(value, new RegExp(`^${CAPABILITY_COOKIE}=;`));
  assert.match(value, new RegExp(`Path=${CAPABILITY_PATH.replaceAll('/', '\\/')}(?:;|$)`));
  assert.match(value, /Max-Age=0/u);
  assert.match(value, /Secure/u);
  assert.match(value, /HttpOnly/u);
  assert.match(value, /SameSite=Strict/u);
}

function inlineScript(html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)]
    .map(match => match[1]).filter(source => source.trim());
  assert.equal(scripts.length, 1);
  return scripts[0];
}

async function decryptInstallEnvelope(issued, {
  origin = PROD_ORIGIN,
  clientPrivateKey = issued.clientPrivateKey
} = {}) {
  assert.ok(clientPrivateKey, 'the out-of-band client private key is required');
  const [serverX, serverY, ivText, ciphertextText, tagText] = issued.body.installEnvelope.split('.');
  const serverPublicKey = await webcrypto.subtle.importKey('jwk', {
    kty: 'EC',
    crv: 'P-256',
    x: serverX,
    y: serverY,
    ext: true,
    key_ops: []
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = await webcrypto.subtle.deriveBits({
    name: 'ECDH',
    public: serverPublicKey
  }, clientPrivateKey, 256);
  const aad = new TextEncoder().encode(
    `gib-m1-tablet-diagnostic:install-envelope:aad:v1\0${origin}\0${DIAGNOSTIC_PATH}\0${issued.body.runId}`
  );
  const material = await webcrypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: aad,
    info: new TextEncoder().encode(
      `gib-m1-tablet-diagnostic:install-envelope:key:v1\0${issued.body.proofKey}`
    )
  }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const encrypted = Buffer.concat([
    Buffer.from(ciphertextText, 'base64url'),
    Buffer.from(tagText, 'base64url')
  ]);
  const plaintext = await webcrypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: Buffer.from(ivText, 'base64url'),
    additionalData: aad,
    tagLength: 128
  }, key, encrypted);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function browserHarness(storage, { failFirstSetKey = '', failSafeState = false } = {}) {
  const elements = new Map(['statusMessage', 'endpointResult', 'credentialResult', 'autoResult', 'queueResult', 'historyResult']
    .map(id => [id, { textContent: 'NOT CHECKED' }]));
  elements.set('diagnosticResults', { hidden: true });
  const listeners = new Map();
  const posted = [];
  const storageCalls = [];
  const logs = [];
  const network = [];
  let failedSet = false;
  const opener = {
    closed: false,
    location: { origin: PROD_ORIGIN, pathname: '/m1/admin/' },
    postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); }
  };
  const windowObject = {
    opener,
    location: { origin: PROD_ORIGIN, pathname: DIAGNOSTIC_PATH },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  windowObject.window = windowObject;
  const localStorage = {
    getItem(key) {
      if (failSafeState && (key === 'gib_m1_sync_token_v1' || key === 'gib_m1_sync_auto_v1')) {
        throw new Error('synthetic persistent storage failure');
      }
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      const text = String(value);
      storageCalls.push({ action: 'set', key, value: text });
      if (failSafeState && key === 'gib_m1_sync_auto_v1') {
        throw new Error('synthetic persistent storage failure');
      }
      if (key === failFirstSetKey && !failedSet) {
        failedSet = true;
        throw new Error('synthetic storage failure');
      }
      storage.set(key, text);
    },
    removeItem(key) {
      storageCalls.push({ action: 'remove', key });
      if (failSafeState && key === 'gib_m1_sync_token_v1') {
        throw new Error('synthetic persistent storage failure');
      }
      storage.delete(key);
    }
  };
  const noNetwork = (...args) => {
    network.push(args);
    throw new Error('network forbidden');
  };
  vm.runInContext(inlineScript(diagnosticHtml), vm.createContext({
    TextEncoder,
    TextDecoder,
    atob,
    crypto: webcrypto,
    document: { getElementById: id => elements.get(id) },
    localStorage,
    window: windowObject,
    fetch: noNetwork,
    XMLHttpRequest: noNetwork,
    WebSocket: noNetwork,
    navigator: { sendBeacon: noNetwork, clipboard: { writeText: noNetwork } },
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) }
  }));
  return { elements, listeners, posted, storageCalls, logs, network, opener };
}

async function waitForMessage(posted, type) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = posted.find(item => item.message.type === type);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return null;
}

test('same-origin instructions, no raw entry, no child network, and preview alignment are pinned', () => {
  assert.match(runbook, /https:\/\/gib-live\.netlify\.app\/m1\/tablet-diagnostic\.html/u);
  assert.match(runbook, /bjjsite\.com[^\n]+(?:not|must not)[^\n]+tablet diagnostic/iu);
  assert.match(diagnosticHtml, /connect-src 'none'/u);
  assert.doesNotMatch(diagnosticHtml, /<input\b|<textarea\b|<form\b/iu);
  assert.doesNotMatch(diagnosticHtml, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|requestToken/iu);
  assert.match(diagnosticHtml, /deploy-preview-\\d\+--gib-live\\\.netlify\\\.app/u);
  assert.match(adminHtml, /deploy-preview-\\d\+--gib-live\\\.netlify\\\.app/u);
});

test('verifier keeps the two-request limit and exact diagnostic/install actions', () => {
  assert.match(adminHtml, /tabletDiagnostic:\s*'\/api\/m1-tablet-diagnostic-verifier'/u);
  assert.match(verifierSource, /url\.pathname\s*!==\s*CAPABILITY_PATH/u);
  assert.deepEqual(verifierConfig, {
    path: VERIFIER_PATH,
    rateLimit: {
      windowLimit: 2,
      windowSize: 60,
      aggregateBy: ['ip', 'domain']
    }
  });
  assert.match(
    verifierSource,
    /export const config\s*=\s*\{[\s\S]*?path:\s*'\/api\/m1-tablet-diagnostic-verifier'[\s\S]*?windowLimit:\s*2[\s\S]*?windowSize:\s*60[\s\S]*?aggregateBy:\s*\['ip',\s*'domain'\][\s\S]*?\};/u
  );
  assert.match(verifierSource, /Object\.keys\(value\)\.length\s*===\s*2[\s\S]*value\.action\s*===\s*'issue'/u);
  assert.match(verifierSource, /action\s*===\s*'issue-install'[\s\S]*Object\.keys\(value\)\.length\s*===\s*3[\s\S]*validClientPublicJwk\(value\.clientPublicKey\)/u);
  assert.match(verifierSource, /Object\.keys\(value\)\.length\s*===\s*5[\s\S]*value\.action\s*===\s*'verify'/u);
  const dispatch = verifierSource.slice(
    verifierSource.indexOf('export async function handleAdminTabletDiagnostic'),
    verifierSource.indexOf('export default request')
  );
  assert.deepEqual(
    [...dispatch.matchAll(/parsed\.value\.action\s*===\s*'([^']+)'/gu)].map(match => match[1]),
    ['issue', 'issue-install', 'verify']
  );
  assert.match(dispatch, /return withCapabilityCleared\(invalidRequestResponse\(\)\);/u);
});

test('Admin obtains a child-generated P-256 key before requesting an opaque install envelope', () => {
  const installSource = adminHtml.slice(
    adminHtml.indexOf('async function openTabletDiagnostic('),
    adminHtml.indexOf('async function requestJson')
  );
  const childMessages = [...installSource.matchAll(/popup\.postMessage\(\{([\s\S]*?)\},\s*location\.origin\)/gu)]
    .map(match => match[1]);
  const diagnosticMessage = childMessages.find(source => /TABLET_DIAGNOSTIC_REQUEST/u.test(source));
  const installInitMessage = childMessages.find(source => /TABLET_INSTALL_INIT/u.test(source));
  const installMessage = childMessages.find(source => /TABLET_INSTALL_REQUEST/u.test(source));
  assert.ok(diagnosticMessage);
  assert.ok(installInitMessage);
  assert.ok(installMessage);
  assert.match(diagnosticMessage, /type:\s*TABLET_DIAGNOSTIC_REQUEST[\s\S]*runId[\s\S]*proofKey/u);
  assert.match(installInitMessage, /type:\s*TABLET_INSTALL_INIT[\s\S]*runId/u);
  assert.doesNotMatch(installInitMessage, /proofKey|installEnvelope|clientPublicKey/u);
  assert.match(installMessage, /type:\s*TABLET_INSTALL_REQUEST[\s\S]*runId[\s\S]*proofKey[\s\S]*installEnvelope/u);
  assert.doesNotMatch(childMessages.join('\n'), /requestToken|adminRequestToken|endpointProof|credentialProof|endpoint\s*:|credential\s*:/u);
  assert.match(installSource, /action:\s*'issue-install'[\s\S]*runId[\s\S]*clientPublicKey/u);
  assert.match(adminHtml, /exactObjectKeys\(value,\s*\['type',\s*'runId',\s*'clientPublicKey'\]\)/u);
  assert.match(adminHtml, /value\.kty\s*===\s*'EC'[\s\S]*value\.crv\s*===\s*'P-256'/u);
  const verifySource = adminHtml.slice(
    adminHtml.indexOf('async function requestDiagnosticVerification'),
    adminHtml.indexOf('async function requestJson')
  );
  assert.doesNotMatch(verifySource, /ADMIN_REQUEST_HEADER|adminRequestToken/u);
  assert.match(verifySource, /action:\s*'verify'[\s\S]*purpose[\s\S]*runId[\s\S]*endpointProof[\s\S]*credentialProof/u);
  assert.match(diagnosticHtml, /endpoint:\s*'gib-m1-tablet-diagnostic:endpoint:v2'/u);
  assert.match(diagnosticHtml, /credential:\s*'gib-m1-tablet-diagnostic:credential:v2'/u);
  assert.match(diagnosticHtml, /hmacProof\(key,\s*HMAC_DOMAIN\.endpoint,\s*runId,/u);
  assert.match(diagnosticHtml, /crypto\.subtle\.generateKey\(\{[\s\S]*name:\s*'ECDH'[\s\S]*namedCurve:\s*'P-256'[\s\S]*false,\s*\['deriveBits'\]/u);
});

test('issue requires Admin and sets a 60-second verifier-path capability cookie', async () => {
  const noAdmin = await handleAdminTabletDiagnostic(actionRequest({
    body: { action: 'issue', runId: RUN_A },
    adminCookieValue: '',
    adminHeader: ADMIN_TOKEN
  }), { env: PROD_ENV, now: NOW, randomBytes: deterministicRandom(1) });
  assert.equal(noAdmin.status, 401);

  const issued = await issue();
  assert.equal(issued.response.status, 200);
  assert.deepEqual(Object.keys(issued.body).sort(), ['expiresInSeconds', 'ok', 'proofKey', 'runId']);
  assert.equal(issued.body.expiresInSeconds, CAPABILITY_SECONDS);
  assert.match(issued.body.proofKey, /^[A-Za-z0-9_-]{43}$/u);
  const setCookie = issued.response.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`^${CAPABILITY_COOKIE}=`));
  assert.match(setCookie, new RegExp(`Path=${CAPABILITY_PATH.replaceAll('/', '\\/')}(?:;|$)`));
  assert.match(setCookie, /Max-Age=60/u);
  assert.match(setCookie, /Secure/u);
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /SameSite=Strict/u);
});

test('verify requires matching Admin and capability cookies, forbids the general header, and always clears capability', async () => {
  assert.notEqual(PROD_TRANSPORT_TOKEN, PROD_LEGACY_TOKEN);
  const issued = await issue();
  const body = proofBody(issued);
  const valid = await handleAdminTabletDiagnostic(actionRequest({
    body,
    capabilityCookie: issued.capabilityCookie,
    adminHeader: null
  }), { env: PROD_ENV, now: NOW });
  assert.equal(valid.status, 200);
  assert.deepEqual(await json(valid), { ok: true, endpointExpected: true, credentialMatch: true });
  assertCapabilityCleared(valid);

  const cases = [
    actionRequest({ body, capabilityCookie: issued.capabilityCookie, adminHeader: ADMIN_TOKEN }),
    actionRequest({ body, capabilityCookie: '', adminHeader: null }),
    actionRequest({ body, capabilityCookie: issued.capabilityCookie, adminCookieValue: '', adminHeader: null })
  ];
  for (const request of cases) {
    const response = await handleAdminTabletDiagnostic(request, { env: PROD_ENV, now: NOW });
    assert.ok(response.status >= 400);
    assertCapabilityCleared(response);
  }
  assert.doesNotMatch(verifierSource, /\bfetch\s*\(|postGoogle|Spreadsheet|console\./u);
});

test('credential comparison uses only the legacy kiosk credential and fails closed when it is absent', async () => {
  assert.equal(PRODUCTION_LEGACY_KIOSK_ENV, 'GIB_M1_LEGACY_KIOSK_TOKEN');
  assert.equal(PREVIEW_LEGACY_KIOSK_ENV, 'GIB_TEST_LEGACY_KIOSK_TOKEN');
  const transportAttempt = await issue({ runId: 'c'.repeat(32), seed: 41 });
  const transportBody = proofBody(transportAttempt);
  transportBody.credentialProof = hmacProof(
    transportAttempt.body.proofKey,
    transportAttempt.body.runId,
    CREDENTIAL_PROOF_DOMAIN,
    PROD_TRANSPORT_TOKEN
  );
  const transportResponse = await handleAdminTabletDiagnostic(actionRequest({
    body: transportBody,
    capabilityCookie: transportAttempt.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(transportResponse.status, 200);
  assert.deepEqual(await json(transportResponse), {
    ok: true,
    endpointExpected: true,
    credentialMatch: false
  });

  const wrongAttempt = await issue({ runId: 'd'.repeat(32), seed: 42 });
  const wrongBody = proofBody(wrongAttempt);
  wrongBody.credentialProof = hmacProof(
    wrongAttempt.body.proofKey,
    wrongAttempt.body.runId,
    CREDENTIAL_PROOF_DOMAIN,
    Buffer.alloc(18, 99).toString('base64url')
  );
  const wrongResponse = await handleAdminTabletDiagnostic(actionRequest({
    body: wrongBody,
    capabilityCookie: wrongAttempt.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(wrongResponse.status, 200);
  assert.deepEqual(await json(wrongResponse), {
    ok: true,
    endpointExpected: true,
    credentialMatch: false
  });

  const { [PRODUCTION_LEGACY_KIOSK_ENV]: _removed, ...missingLegacyEnv } = PROD_ENV;
  const missing = await issue({ env: missingLegacyEnv, runId: 'e'.repeat(32), seed: 43 });
  assert.equal(missing.response.status, 503);
  assert.deepEqual(missing.body.ok, false);
  assertCapabilityCleared(missing.response);
});

test('capability is bound to session, run, and expiry; old proofs cannot validate a fresh run', async () => {
  const first = await issue({ runId: RUN_A, seed: 20 });
  const second = await issue({ runId: RUN_B, seed: 30 });
  const firstProofs = proofBody(first, RUN_A);

  const wrongRun = await handleAdminTabletDiagnostic(actionRequest({
    body: { ...firstProofs, runId: RUN_B },
    capabilityCookie: first.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(wrongRun.status, 403);
  assertCapabilityCleared(wrongRun);

  const replayFresh = await handleAdminTabletDiagnostic(actionRequest({
    body: { ...firstProofs, runId: RUN_B },
    capabilityCookie: second.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(replayFresh.status, 200);
  assert.deepEqual(await json(replayFresh), { ok: true, endpointExpected: false, credentialMatch: false });
  assertCapabilityCleared(replayFresh);

  const expired = await handleAdminTabletDiagnostic(actionRequest({
    body: firstProofs,
    capabilityCookie: first.capabilityCookie
  }), { env: PROD_ENV, now: NOW + 61_000 });
  assert.equal(expired.status, 403);
  assertCapabilityCleared(expired);

  const otherSession = adminCookie(PROD_ORIGIN, PROD_ENV, ALT_ADMIN_TOKEN, 'Stuart Turner');
  const rebound = await handleAdminTabletDiagnostic(actionRequest({
    body: firstProofs,
    capabilityCookie: first.capabilityCookie,
    adminCookieValue: otherSession
  }), { env: PROD_ENV, now: NOW });
  assert.equal(rebound.status, 403);
  assertCapabilityCleared(rebound);
});

test('deploy-preview issue and verify use the same capability protocol', async () => {
  const issued = await issue({ origin: PREVIEW_ORIGIN, env: PREVIEW_ENV, seed: 40 });
  assert.equal(issued.response.status, 200);
  const body = {
    action: 'verify',
    purpose: DIAGNOSTIC_PURPOSE,
    runId: RUN_A,
    endpointProof: hmacProof(issued.body.proofKey, RUN_A, ENDPOINT_PROOF_DOMAIN, PREVIEW_ENV.GIB_TEST_WEBHOOK_URL),
    credentialProof: hmacProof(issued.body.proofKey, RUN_A, CREDENTIAL_PROOF_DOMAIN, PREVIEW_ENV[PREVIEW_LEGACY_KIOSK_ENV])
  };
  const response = await handleAdminTabletDiagnostic(actionRequest({
    origin: PREVIEW_ORIGIN,
    body,
    adminCookieValue: adminCookie(PREVIEW_ORIGIN, PREVIEW_ENV),
    capabilityCookie: issued.capabilityCookie
  }), { env: PREVIEW_ENV, now: NOW });
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, endpointExpected: true, credentialMatch: true });
  assertCapabilityCleared(response);
});

test('install issuance is authenticated, same-origin, opaque, distinct, and fail-closed', async () => {
  const issued = await issueInstall();
  assert.equal(issued.response.status, 200);
  assert.deepEqual(Object.keys(issued.body).sort(), [
    'expiresInSeconds', 'installEnvelope', 'ok', 'proofKey', 'runId'
  ]);
  assert.equal(issued.response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.match(
    issued.body.installEnvelope,
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u
  );
  assert.equal(issued.body.installEnvelope.split('.').length, 5);
  assert.equal('clientPrivateKey' in issued.body, false);
  assert.equal('clientPublicKey' in issued.body, false);
  const plaintext = await decryptInstallEnvelope(issued);
  assert.deepEqual(plaintext, {
    v: 1,
    runId: RUN_A,
    endpoint: PROD_WEBHOOK_URL,
    credential: PROD_LEGACY_TOKEN,
    autoSync: false
  });
  assert.notEqual(plaintext.credential, PROD_TRANSPORT_TOKEN);
  assert.notEqual(plaintext.credential, PROD_ENV.GIB_M1_ADMIN_ACTION_TOKEN);
  assert.notEqual(plaintext.credential, PROD_ENV.GIB_M1_ADMIN_PASSPHRASE);
  const unrelatedClient = await generateInstallClientKeyPair();
  await assert.rejects(decryptInstallEnvelope(issued, {
    clientPrivateKey: unrelatedClient.privateKey
  }));
  const responseText = JSON.stringify(issued.body);
  for (const raw of [PROD_WEBHOOK_URL, PROD_LEGACY_TOKEN, PROD_TRANSPORT_TOKEN, PROD_ENV.GIB_M1_ADMIN_ACTION_TOKEN]) {
    assert.equal(responseText.includes(raw), false);
  }

  const unauthenticated = await issueInstall({ cookie: '', adminHeader: ADMIN_TOKEN, seed: 51 });
  assert.equal(unauthenticated.response.status, 401);
  const wrongOrigin = await issueInstall({
    origin: 'https://bjjsite.com',
    cookie: adminCookie(PROD_ORIGIN, PROD_ENV),
    seed: 52
  });
  assert.equal(wrongOrigin.response.status, 403);

  const missingEndpointEnv = { ...PROD_ENV, GIB_M1_WEBHOOK_URL: '' };
  const missingEndpoint = await issueInstall({
    env: missingEndpointEnv,
    cookie: adminCookie(PROD_ORIGIN, missingEndpointEnv),
    seed: 53
  });
  assert.equal(missingEndpoint.response.status, 503);
  const { [PRODUCTION_LEGACY_KIOSK_ENV]: _legacy, ...missingLegacyEnv } = PROD_ENV;
  const missingLegacy = await issueInstall({
    env: missingLegacyEnv,
    cookie: adminCookie(PROD_ORIGIN, missingLegacyEnv),
    seed: 54
  });
  assert.equal(missingLegacy.response.status, 503);
  const transportCollisionEnv = {
    ...PROD_ENV,
    [PRODUCTION_LEGACY_KIOSK_ENV]: PROD_TRANSPORT_TOKEN
  };
  const transportCollision = await issueInstall({
    env: transportCollisionEnv,
    cookie: adminCookie(PROD_ORIGIN, transportCollisionEnv),
    seed: 55
  });
  assert.equal(transportCollision.response.status, 503);
  const whitespaceTransportCollisionEnv = {
    ...PROD_ENV,
    [PRODUCTION_LEGACY_KIOSK_ENV]: ` ${PROD_TRANSPORT_TOKEN} `
  };
  const whitespaceTransportCollision = await issueInstall({
    env: whitespaceTransportCollisionEnv,
    cookie: adminCookie(PROD_ORIGIN, whitespaceTransportCollisionEnv),
    seed: 56
  });
  assert.equal(whitespaceTransportCollision.response.status, 503);
  const passphraseCollisionEnv = {
    ...PROD_ENV,
    [PRODUCTION_LEGACY_KIOSK_ENV]: PROD_ENV.GIB_M1_ADMIN_PASSPHRASE
  };
  const passphraseCollision = await issueInstall({
    env: passphraseCollisionEnv,
    cookie: adminCookie(PROD_ORIGIN, passphraseCollisionEnv),
    seed: 57
  });
  assert.equal(passphraseCollision.response.status, 503);
  const errorText = JSON.stringify([
    unauthenticated.body,
    wrongOrigin.body,
    missingEndpoint.body,
    missingLegacy.body,
    transportCollision.body,
    whitespaceTransportCollision.body,
    passphraseCollision.body
  ]);
  for (const raw of [PROD_WEBHOOK_URL, PROD_LEGACY_TOKEN, PROD_TRANSPORT_TOKEN]) {
    assert.equal(errorText.includes(raw), false);
  }
  assert.doesNotMatch(verifierSource, /\bfetch\s*\(|postGoogle|Spreadsheet|console\./u);
});

test('install capability is purpose-bound and clears on verification', async () => {
  const wrongPurposeIssue = await issueInstall({ runId: RUN_A, seed: 56 });
  const wrongPurpose = await handleAdminTabletDiagnostic(actionRequest({
    body: proofBody(wrongPurposeIssue, RUN_A, PROD_ENV, DIAGNOSTIC_PURPOSE),
    capabilityCookie: wrongPurposeIssue.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(wrongPurpose.status, 403);
  assertCapabilityCleared(wrongPurpose);

  const validIssue = await issueInstall({ runId: RUN_B, seed: 57 });
  const valid = await handleAdminTabletDiagnostic(actionRequest({
    body: proofBody(validIssue, RUN_B, PROD_ENV, INSTALL_PURPOSE),
    capabilityCookie: validIssue.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(valid.status, 200);
  assert.deepEqual(await json(valid), { ok: true, endpointExpected: true, credentialMatch: true });
  assertCapabilityCleared(valid);
});

test('synthetic install preserves tablet data, forces OFF, performs no delivery, and diagnoses cleanly', async () => {
  const queueBytes = '[\r\n {"id":"queue-α","nested":{"z":1}}\r\n]';
  const historyBytes = '[ {"id":"history-β"}, {"id":"history-γ"} ]';
  const storage = new Map([
    ['gib_m1_sync_url_v1', 'https://old.invalid/receiver'],
    ['gib_m1_sync_token_v1', 'old-local-token'],
    ['gib_m1_sync_auto_v1', 'true'],
    ['gib_m1_sync_queue_v1', queueBytes],
    ['gib_m1_signins_v1', historyBytes],
    ['gib_m1_device_id', 'device-byte-preserved'],
    ['unrelated', 'unchanged']
  ]);
  const before = new Map(storage);
  const harness = browserHarness(storage);
  const onMessage = harness.listeners.get('message');
  onMessage({
    origin: 'https://bjjsite.com',
    source: harness.opener,
    data: {
      type: INSTALL_INIT_TYPE,
      runId: RUN_A
    }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(harness.posted.length, 0);
  assert.deepEqual(storage, before);
  onMessage({
    origin: PROD_ORIGIN,
    source: harness.opener,
    data: { type: INSTALL_INIT_TYPE, runId: RUN_A }
  });
  const ready = await waitForMessage(harness.posted, INSTALL_READY_TYPE);
  assert.ok(ready);
  assert.equal(ready.targetOrigin, PROD_ORIGIN);
  assert.deepEqual(Object.keys(ready.message).sort(), ['clientPublicKey', 'runId', 'type']);
  assert.deepEqual(Object.keys(ready.message.clientPublicKey).sort(), ['crv', 'ext', 'key_ops', 'kty', 'x', 'y']);
  assert.equal(ready.message.clientPublicKey.kty, 'EC');
  assert.equal(ready.message.clientPublicKey.crv, 'P-256');
  assert.equal(ready.message.clientPublicKey.ext, true);
  assert.equal(Array.isArray(ready.message.clientPublicKey.key_ops), true);
  assert.equal(ready.message.clientPublicKey.key_ops.length, 0);
  assert.match(ready.message.clientPublicKey.x, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(ready.message.clientPublicKey.y, /^[A-Za-z0-9_-]{43}$/u);
  const issued = await issueInstall({
    seed: 58,
    clientPublicKey: ready.message.clientPublicKey
  });
  assert.equal(issued.response.status, 200);
  onMessage({
    origin: PROD_ORIGIN,
    source: harness.opener,
    data: {
      type: INSTALL_REQUEST_TYPE,
      runId: issued.body.runId,
      proofKey: issued.body.proofKey,
      installEnvelope: issued.body.installEnvelope
    }
  });
  const proofs = await waitForMessage(harness.posted, PROOFS_TYPE);
  assert.ok(proofs);
  assert.deepEqual(
    Object.keys(proofs.message).sort(),
    ['autoSync', 'credentialProof', 'endpointProof', 'historyCount', 'queueCount', 'runId', 'type']
  );
  assert.equal(proofs.message.autoSync, false);
  assert.equal(proofs.message.queueCount, 1);
  assert.equal(proofs.message.historyCount, 2);
  const verified = await handleAdminTabletDiagnostic(actionRequest({
    body: {
      action: 'verify',
      purpose: INSTALL_PURPOSE,
      runId: issued.body.runId,
      endpointProof: proofs.message.endpointProof,
      credentialProof: proofs.message.credentialProof
    },
    capabilityCookie: issued.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  const verifiedBody = await json(verified);
  assert.deepEqual(verifiedBody, { ok: true, endpointExpected: true, credentialMatch: true });
  onMessage({
    origin: PROD_ORIGIN,
    source: harness.opener,
    data: {
      type: RESULT_TYPE,
      runId: RUN_A,
      endpointExpected: verifiedBody.endpointExpected,
      credentialMatch: verifiedBody.credentialMatch
    }
  });
  const installed = await waitForMessage(harness.posted, INSTALL_RESULT_TYPE);
  assert.ok(installed);
  assert.equal(installed.message.installed, true);
  assert.equal(harness.elements.get('statusMessage').textContent, 'Repaired sync settings installed');
  assert.equal(storage.get('gib_m1_sync_url_v1'), PROD_WEBHOOK_URL);
  assert.equal(storage.get('gib_m1_sync_token_v1'), PROD_LEGACY_TOKEN);
  assert.equal(storage.get('gib_m1_sync_auto_v1'), 'false');
  assert.equal(storage.get('gib_m1_sync_queue_v1'), queueBytes);
  assert.equal(storage.get('gib_m1_signins_v1'), historyBytes);
  assert.equal(storage.get('gib_m1_device_id'), before.get('gib_m1_device_id'));
  assert.equal(storage.get('unrelated'), before.get('unrelated'));
  assert.equal(harness.storageCalls[0].key, 'gib_m1_sync_auto_v1');
  assert.deepEqual(
    [...new Set(harness.storageCalls.map(call => call.key))].sort(),
    ['gib_m1_sync_auto_v1', 'gib_m1_sync_token_v1', 'gib_m1_sync_url_v1'].sort()
  );
  assert.equal(harness.network.length, 0);
  assert.equal(harness.logs.length, 0);

  const diagnosticIssue = await issue({ runId: RUN_B, seed: 59 });
  const diagnosticHarness = browserHarness(storage);
  const diagnosticMessage = diagnosticHarness.listeners.get('message');
  diagnosticMessage({
    origin: PROD_ORIGIN,
    source: diagnosticHarness.opener,
    data: { type: REQUEST_TYPE, runId: RUN_B, proofKey: diagnosticIssue.body.proofKey }
  });
  const diagnosticProofs = await waitForMessage(diagnosticHarness.posted, PROOFS_TYPE);
  assert.ok(diagnosticProofs);
  const diagnosticVerify = await handleAdminTabletDiagnostic(actionRequest({
    body: {
      action: 'verify',
      purpose: DIAGNOSTIC_PURPOSE,
      runId: RUN_B,
      endpointProof: diagnosticProofs.message.endpointProof,
      credentialProof: diagnosticProofs.message.credentialProof
    },
    capabilityCookie: diagnosticIssue.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  const diagnosticResult = await json(diagnosticVerify);
  diagnosticMessage({
    origin: PROD_ORIGIN,
    source: diagnosticHarness.opener,
    data: {
      type: RESULT_TYPE,
      runId: RUN_B,
      endpointExpected: diagnosticResult.endpointExpected,
      credentialMatch: diagnosticResult.credentialMatch
    }
  });
  assert.deepEqual([
    diagnosticHarness.elements.get('endpointResult').textContent,
    diagnosticHarness.elements.get('credentialResult').textContent,
    diagnosticHarness.elements.get('autoResult').textContent,
    diagnosticHarness.elements.get('queueResult').textContent,
    diagnosticHarness.elements.get('historyResult').textContent
  ], ['EXPECTED', 'MATCH', 'OFF', '1', '2']);

  const observable = [
    ...harness.elements.values(),
    ...diagnosticHarness.elements.values()
  ].map(value => value.textContent || '').join('\n')
    + JSON.stringify(harness.posted)
    + JSON.stringify(diagnosticHarness.posted);
  for (const raw of [PROD_WEBHOOK_URL, PROD_LEGACY_TOKEN, PROD_TRANSPORT_TOKEN]) {
    assert.equal(observable.includes(raw), false);
  }
});

test('partial endpoint or credential writes fail closed with no credential and auto-sync OFF', async () => {
  const oldEndpoint = 'https://old.invalid/receiver';
  const oldCredential = 'old-local-token';
  const queueBytes = '[{"queue":"unchanged"}]';
  const historyBytes = '[{"history":"unchanged"}]';
  for (const [index, failFirstSetKey] of [
    'gib_m1_sync_url_v1',
    'gib_m1_sync_token_v1'
  ].entries()) {
    const storage = new Map([
      ['gib_m1_sync_url_v1', oldEndpoint],
      ['gib_m1_sync_token_v1', oldCredential],
      ['gib_m1_sync_auto_v1', 'true'],
      ['gib_m1_sync_queue_v1', queueBytes],
      ['gib_m1_signins_v1', historyBytes]
    ]);
    const harness = browserHarness(storage, { failFirstSetKey });
    const onMessage = harness.listeners.get('message');
    onMessage({
      origin: PROD_ORIGIN,
      source: harness.opener,
      data: { type: INSTALL_INIT_TYPE, runId: RUN_A }
    });
    const ready = await waitForMessage(harness.posted, INSTALL_READY_TYPE);
    assert.ok(ready);
    const issued = await issueInstall({
      seed: 60 + index,
      clientPublicKey: ready.message.clientPublicKey
    });
    onMessage({
      origin: PROD_ORIGIN,
      source: harness.opener,
      data: {
        type: INSTALL_REQUEST_TYPE,
        runId: RUN_A,
        proofKey: issued.body.proofKey,
        installEnvelope: issued.body.installEnvelope
      }
    });
    const proofs = await waitForMessage(harness.posted, PROOFS_TYPE);
    assert.ok(proofs);
    onMessage({
      origin: PROD_ORIGIN,
      source: harness.opener,
      data: { type: RESULT_TYPE, runId: RUN_A, endpointExpected: true, credentialMatch: true }
    });
    const result = await waitForMessage(harness.posted, INSTALL_RESULT_TYPE);
    assert.equal(result.message.installed, false);
    assert.equal(harness.elements.get('statusMessage').textContent, 'Installation failed safely');
    assert.equal(storage.has('gib_m1_sync_token_v1'), false);
    assert.equal(storage.get('gib_m1_sync_auto_v1'), 'false');
    assert.equal(
      storage.get('gib_m1_sync_url_v1'),
      failFirstSetKey === 'gib_m1_sync_url_v1' ? oldEndpoint : PROD_WEBHOOK_URL
    );
    assert.equal(storage.get('gib_m1_sync_queue_v1'), queueBytes);
    assert.equal(storage.get('gib_m1_signins_v1'), historyBytes);
    assert.equal(harness.network.length, 0);
    assert.equal(harness.logs.length, 0);
  }
});

test('unverifiable storage safety produces no acknowledgement or false-safe result', async () => {
  const storage = new Map([
    ['gib_m1_sync_url_v1', 'https://old.invalid/receiver'],
    ['gib_m1_sync_token_v1', 'old-local-token'],
    ['gib_m1_sync_auto_v1', 'true'],
    ['gib_m1_sync_queue_v1', '[{"queue":"unchanged"}]'],
    ['gib_m1_signins_v1', '[{"history":"unchanged"}]']
  ]);
  const harness = browserHarness(storage, { failSafeState: true });
  const onMessage = harness.listeners.get('message');
  onMessage({
    origin: PROD_ORIGIN,
    source: harness.opener,
    data: { type: INSTALL_INIT_TYPE, runId: RUN_A }
  });
  const ready = await waitForMessage(harness.posted, INSTALL_READY_TYPE);
  assert.ok(ready);
  const issued = await issueInstall({ clientPublicKey: ready.message.clientPublicKey, seed: 70 });
  onMessage({
    origin: PROD_ORIGIN,
    source: harness.opener,
    data: {
      type: INSTALL_REQUEST_TYPE,
      runId: RUN_A,
      proofKey: issued.body.proofKey,
      installEnvelope: issued.body.installEnvelope
    }
  });
  assert.ok(await waitForMessage(harness.posted, PROOFS_TYPE));
  onMessage({
    origin: PROD_ORIGIN,
    source: harness.opener,
    data: { type: RESULT_TYPE, runId: RUN_A, endpointExpected: true, credentialMatch: true }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(harness.posted.some(item => item.message.type === INSTALL_RESULT_TYPE), false);
  assert.equal(harness.elements.get('statusMessage').textContent, '');
  assert.doesNotMatch(adminHtml, /diagnosticAwaitingInstallAck\)\s*failSyncInstallation\(\)/u);
  assert.match(adminHtml, /diagnosticAwaitingInstallAck\)\s*clearDiagnosticRun\(true\)/u);
  assert.equal(harness.network.length, 0);
  assert.equal(harness.logs.length, 0);
});

test('proof mismatch acknowledges failure only after credential clearing and auto-sync OFF are verified', async () => {
  for (const [index, failSafeState] of [false, true].entries()) {
    const storage = new Map([
      ['gib_m1_sync_url_v1', 'https://old.invalid/receiver'],
      ['gib_m1_sync_token_v1', 'old-local-token'],
      ['gib_m1_sync_auto_v1', 'true'],
      ['gib_m1_sync_queue_v1', '[{"queue":"unchanged"}]'],
      ['gib_m1_signins_v1', '[{"history":"unchanged"}]']
    ]);
    const harness = browserHarness(storage, { failSafeState });
    const onMessage = harness.listeners.get('message');
    onMessage({
      origin: PROD_ORIGIN,
      source: harness.opener,
      data: { type: INSTALL_INIT_TYPE, runId: RUN_A }
    });
    const ready = await waitForMessage(harness.posted, INSTALL_READY_TYPE);
    assert.ok(ready);
    const issued = await issueInstall({ clientPublicKey: ready.message.clientPublicKey, seed: 80 + index });
    onMessage({
      origin: PROD_ORIGIN,
      source: harness.opener,
      data: {
        type: INSTALL_REQUEST_TYPE,
        runId: RUN_A,
        proofKey: issued.body.proofKey,
        installEnvelope: issued.body.installEnvelope
      }
    });
    assert.ok(await waitForMessage(harness.posted, PROOFS_TYPE));
    onMessage({
      origin: PROD_ORIGIN,
      source: harness.opener,
      data: { type: RESULT_TYPE, runId: RUN_A, endpointExpected: false, credentialMatch: false }
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = harness.posted.find(item => item.message.type === INSTALL_RESULT_TYPE);
    if (failSafeState) {
      assert.equal(result, undefined);
      assert.equal(harness.elements.get('statusMessage').textContent, '');
    } else {
      assert.equal(result.message.installed, false);
      assert.equal(harness.elements.get('statusMessage').textContent, 'Installation failed safely');
      assert.equal(storage.has('gib_m1_sync_token_v1'), false);
      assert.equal(storage.get('gib_m1_sync_auto_v1'), 'false');
    }
    assert.equal(storage.get('gib_m1_sync_queue_v1'), '[{"queue":"unchanged"}]');
    assert.equal(storage.get('gib_m1_signins_v1'), '[{"history":"unchanged"}]');
    assert.equal(harness.network.length, 0);
    assert.equal(harness.logs.length, 0);
  }
});

test('kiosk disclosure path is removed and required CI pins the reviewed replacement', () => {
  assert.doesNotMatch(kioskHtml, /id="cfgSyncUrl"|id="cfgSyncToken"/u);
  assert.doesNotMatch(kioskHtml, /localStorage\.getItem\(SYNC_(?:URL|TOKEN)_KEY\)[^\n]+\.value/u);
  assert.match(kioskHtml, /localStorage\.getItem\(SYNC_URL_KEY\)/u);
  assert.match(kioskHtml, /localStorage\.getItem\(SYNC_TOKEN_KEY\)/u);
  assert.match(workflow, /m1\/index\.html/u);
  assert.match(workflow, /894a2b62542ffb9264cb989b9275131826764bf7/u);
});

test('seeded same-origin storage emits v2 run-bound proofs and the five safe outputs', async () => {
  const proofKey = 'P'.repeat(43);
  const elements = new Map(['statusMessage', 'endpointResult', 'credentialResult', 'autoResult', 'queueResult', 'historyResult']
    .map(id => [id, { textContent: 'NOT CHECKED' }]));
  elements.set('diagnosticResults', { hidden: true });
  const storage = new Map([
    ['gib_m1_sync_url_v1', PROD_ENV.GIB_M1_WEBHOOK_URL],
    ['gib_m1_sync_token_v1', ` ${PROD_ENV[PRODUCTION_LEGACY_KIOSK_ENV]} `],
    ['gib_m1_sync_auto_v1', 'false'],
    ['gib_m1_sync_queue_v1', JSON.stringify([{}, {}])],
    ['gib_m1_signins_v1', JSON.stringify([{}, {}, {}])]
  ]);
  const listeners = new Map();
  const posted = [];
  const opener = {
    closed: false,
    location: { origin: PROD_ORIGIN, pathname: '/m1/admin/' },
    postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); }
  };
  const windowObject = {
    opener,
    location: { origin: PROD_ORIGIN, pathname: DIAGNOSTIC_PATH },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  windowObject.window = windowObject;
  vm.runInContext(inlineScript(diagnosticHtml), vm.createContext({
    TextEncoder,
    TextDecoder,
    atob,
    crypto: webcrypto,
    document: { getElementById: id => elements.get(id) },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    window: windowObject
  }));
  const onMessage = listeners.get('message');
  assert.equal(typeof onMessage, 'function');
  onMessage({ origin: PROD_ORIGIN, source: opener, data: { type: REQUEST_TYPE, runId: RUN_A, proofKey } });
  for (let attempt = 0; attempt < 20 && !posted.length; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const proofMessage = posted.find(item => item.message.type === PROOFS_TYPE);
  assert.ok(proofMessage);
  assert.equal(proofMessage.targetOrigin, PROD_ORIGIN);
  assert.equal(proofMessage.message.runId, RUN_A);
  assert.equal(proofMessage.message.endpointProof,
    hmacProof(proofKey, RUN_A, ENDPOINT_PROOF_DOMAIN, PROD_ENV.GIB_M1_WEBHOOK_URL));
  assert.equal(proofMessage.message.credentialProof,
    hmacProof(proofKey, RUN_A, CREDENTIAL_PROOF_DOMAIN, PROD_ENV[PRODUCTION_LEGACY_KIOSK_ENV]));
  assert.equal('proofKey' in proofMessage.message, false);
  assert.equal('requestToken' in proofMessage.message, false);

  onMessage({
    origin: PROD_ORIGIN,
    source: opener,
    data: { type: RESULT_TYPE, runId: RUN_A, endpointExpected: true, credentialMatch: true }
  });
  assert.deepEqual([
    elements.get('endpointResult').textContent,
    elements.get('credentialResult').textContent,
    elements.get('autoResult').textContent,
    elements.get('queueResult').textContent,
    elements.get('historyResult').textContent
  ], ['EXPECTED', 'MATCH', 'OFF', '2', '3']);

  const rawCredentials = [
    PROD_WEBHOOK_URL,
    PREVIEW_WEBHOOK_URL,
    PROD_TRANSPORT_TOKEN,
    PROD_LEGACY_TOKEN,
    PREVIEW_TRANSPORT_TOKEN,
    PREVIEW_LEGACY_TOKEN
  ];
  const visibleOutput = [...elements.values()].map(element => element.textContent).join('\n');
  const outboundMessages = JSON.stringify(posted);
  const browserUrls = [PROD_ORIGIN, PREVIEW_ORIGIN, DIAGNOSTIC_PATH, VERIFIER_PATH].join('\n');
  const committedFixtures = [
    diagnosticHtml,
    adminHtml,
    kioskHtml,
    workflow,
    runbook,
    verifierSource,
    read('tests/m1-tablet-diagnostic-secret-safe.test.mjs')
  ].join('\n');
  for (const rawCredential of rawCredentials) {
    assert.equal(visibleOutput.includes(rawCredential), false);
    assert.equal(outboundMessages.includes(rawCredential), false);
    assert.equal(browserUrls.includes(rawCredential), false);
    assert.equal(committedFixtures.includes(rawCredential), false);
  }
  assert.doesNotMatch(diagnosticHtml + verifierSource, /console\./u);
});
