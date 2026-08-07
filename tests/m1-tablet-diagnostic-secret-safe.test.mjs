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
  CREDENTIAL_PROOF_VALUE,
  DIAGNOSTIC_PURPOSE,
  ENDPOINT_PROOF_DOMAIN,
  TRANSPORT_PROOF_VALUE,
  config as verifierConfig,
  handleAdminTabletDiagnostic
} from '../netlify/functions/m1-admin-tablet-diagnostic.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const diagnosticHtml = read('m1/tablet-diagnostic.html');
const adminHtml = read('m1/admin/index.html');
const kioskHtml = read('m1/index.html');
const syncCore = read('m1/sync-core.mjs');
const verifierSource = read('netlify/functions/m1-admin-tablet-diagnostic.mjs');
const workflow = read('.github/workflows/m1-admin-only-required.yml');
const runbook = read('docs/m1-kiosk-sync-incident-runbook.md');

const PROD_ORIGIN = 'https://gib-live.netlify.app';
const PREVIEW_ORIGIN = 'https://deploy-preview-47--gib-live.netlify.app';
const DIAGNOSTIC_PATH = '/m1/tablet-diagnostic.html';
const VERIFIER_PATH = '/api/m1-tablet-diagnostic-verifier';
const REQUEST_TYPE = 'gib:m1:diagnostic-request:v1';
const PROOFS_TYPE = 'gib:m1:diagnostic-proofs:v1';
const RESULT_TYPE = 'gib:m1:diagnostic-result:v1';
const ADMIN_TOKEN = Buffer.alloc(32, 7).toString('base64url');
const ALT_ADMIN_TOKEN = Buffer.alloc(32, 8).toString('base64url');
const NOW = Date.parse('2026-08-05T12:00:00Z');
const RUN_A = 'a'.repeat(32);
const RUN_B = 'b'.repeat(32);
const PROD_TRANSPORT_CANARY = Buffer.alloc(24, 11).toString('base64url');
const PREVIEW_TRANSPORT_CANARY = Buffer.alloc(24, 13).toString('base64url');
const PROD_WEBHOOK_CANARY = ['https://script.google.com/macros/s/', 'SYNTHETIC_PROD_TARGET', '/exec'].join('');
const PREVIEW_WEBHOOK_CANARY = ['https://script.google.com/macros/s/', 'SYNTHETIC_PREVIEW_TARGET', '/exec'].join('');
const PROD_ENV = Object.freeze({
  GIB_M1_WEBHOOK_URL: PROD_WEBHOOK_CANARY,
  GIB_M1_WEBHOOK_TOKEN: PROD_TRANSPORT_CANARY,
  GIB_M1_ADMIN_ACTION_TOKEN: 'synthetic-admin-action-token',
  GIB_M1_ADMIN_PASSPHRASE: 'synthetic private admin access phrase'
});
const PREVIEW_ENV = Object.freeze({
  ...PROD_ENV,
  GIB_TEST_WEBHOOK_URL: PREVIEW_WEBHOOK_CANARY,
  GIB_TEST_WEBHOOK_TOKEN: PREVIEW_TRANSPORT_CANARY,
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-preview-admin-token'
});

const json = async response => JSON.parse(await response.text());
const cookiePair = response => (response.headers.get('set-cookie') || '').split(';', 1)[0];
const secretFor = (origin, env) => origin === PROD_ORIGIN
  ? env.GIB_M1_ADMIN_PASSPHRASE
  : env.GIB_TEST_WEBHOOK_TOKEN;

function adminCookie(origin = PROD_ORIGIN, env = PROD_ENV, token = ADMIN_TOKEN) {
  const value = createAdminSession('Andrew Smith', secretFor(origin, env), NOW, token);
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}`;
}

function actionRequest({
  origin = PROD_ORIGIN,
  body,
  adminCookieValue = adminCookie(origin, origin === PROD_ORIGIN ? PROD_ENV : PREVIEW_ENV),
  capabilityCookie = '',
  adminHeader = null,
  path = VERIFIER_PATH
}) {
  const cookies = [adminCookieValue, capabilityCookie].filter(Boolean).join('; ');
  return new Request(`${origin}${path}`, {
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
  return {
    response,
    body: await json(response.clone()),
    capabilityCookie: cookiePair(response)
  };
}

function hmacProof(proofKey, runId, domain, value) {
  return createHmac('sha256', Buffer.from(proofKey, 'utf8'))
    .update(`${domain}\0${runId}\0${value}`, 'utf8')
    .digest('hex');
}

function proofBody(issued, runId = issued.body.runId) {
  return {
    action: 'verify',
    purpose: DIAGNOSTIC_PURPOSE,
    runId,
    endpointProof: hmacProof(
      issued.body.proofKey,
      runId,
      ENDPOINT_PROOF_DOMAIN,
      TRANSPORT_PROOF_VALUE
    ),
    credentialProof: hmacProof(
      issued.body.proofKey,
      runId,
      CREDENTIAL_PROOF_DOMAIN,
      CREDENTIAL_PROOF_VALUE
    )
  };
}

function assertCapabilityCleared(response) {
  const value = response.headers.get('set-cookie') || '';
  assert.match(value, new RegExp(`^${CAPABILITY_COOKIE}=;`));
  assert.match(value, /Max-Age=0/u);
  assert.match(value, /Secure/u);
  assert.match(value, /HttpOnly/u);
  assert.match(value, /SameSite=Strict/u);
}

function inlineScript(html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.equal(scripts.length, 1);
  return scripts[0];
}

function browserHarness(storage) {
  const elements = new Map([
    'statusMessage',
    'endpointResult',
    'credentialResult',
    'autoResult',
    'queueResult',
    'historyResult'
  ].map(id => [id, { textContent: 'NOT CHECKED' }]));
  elements.set('diagnosticResults', { hidden: true });
  const listeners = new Map();
  const posted = [];
  const storageCalls = [];
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
      storageCalls.push({ action: 'get', key });
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storageCalls.push({ action: 'set', key });
      storage.set(key, String(value));
    },
    removeItem(key) {
      storageCalls.push({ action: 'remove', key });
      storage.delete(key);
    }
  };
  const context = vm.createContext({
    window: windowObject,
    document: { getElementById: id => elements.get(id) },
    localStorage,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    JSON,
    Object,
    Array,
    String,
    RegExp,
    console: Object.freeze({ log() {}, error() {}, warn() {} })
  });
  new vm.Script(`(() => {${inlineScript(diagnosticHtml)}})();`).runInContext(context);
  const dispatch = data => listeners.get('message')({
    origin: PROD_ORIGIN,
    source: opener,
    data
  });
  return { dispatch, elements, posted, storageCalls };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected asynchronous browser diagnostic result.');
}

test('tablet diagnostic is same-origin state-only and has no credential installer', () => {
  assert.match(diagnosticHtml, /connect-src 'none'/u);
  assert.match(diagnosticHtml, /receives no receiver address or credential/u);
  assert.match(diagnosticHtml, /OBSOLETE_BROWSER_SYNC_KEYS\.forEach\(key => localStorage\.removeItem\(key\)\)/u);
  assert.doesNotMatch(diagnosticHtml, /script\.google\.com|macros\/s\/|installEnvelope|decryptInstall|ECDH|AES-GCM/u);
  assert.doesNotMatch(diagnosticHtml, /localStorage\.setItem\([^\n]*(?:sync_url|sync_token)/u);
  assert.doesNotMatch(diagnosticHtml, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/u);
  assert.match(adminHtml, /id="installSyncSettingsButton"[^>]*hidden disabled aria-hidden="true"/u);
  assert.match(adminHtml, /if \(purpose !== 'diagnostic'\) return;/u);
  assert.doesNotMatch(adminHtml, /installSyncSettingsButton'\)\.addEventListener/u);
});

test('server rejects the removed install action without creating a capability', async () => {
  let randomCalls = 0;
  const response = await handleAdminTabletDiagnostic(actionRequest({
    body: { action: 'issue-install', runId: RUN_A, clientPublicKey: {} },
    adminHeader: ADMIN_TOKEN
  }), {
    env: PROD_ENV,
    now: NOW,
    randomBytes() { randomCalls += 1; return Buffer.alloc(32); }
  });
  assert.equal(response.status, 400);
  assert.equal(randomCalls, 0);
  assertCapabilityCleared(response);
  assert.doesNotMatch(await response.text(), /install|credential|webhook|script\.google/u);
});

test('issue requires same-origin Admin authentication and returns only a short capability grant', async () => {
  const unauthenticated = await handleAdminTabletDiagnostic(actionRequest({
    body: { action: 'issue', runId: RUN_A },
    adminCookieValue: '',
    adminHeader: ADMIN_TOKEN
  }), { env: PROD_ENV, now: NOW });
  assert.equal(unauthenticated.status, 401);
  assertCapabilityCleared(unauthenticated);

  const issued = await issue();
  assert.equal(issued.response.status, 200);
  assert.deepEqual(Object.keys(issued.body).sort(), [
    'expiresInSeconds',
    'ok',
    'proofKey',
    'runId'
  ]);
  assert.equal(issued.body.ok, true);
  assert.equal(issued.body.expiresInSeconds, CAPABILITY_SECONDS);
  assert.match(issued.body.proofKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(issued.capabilityCookie, new RegExp(`^${CAPABILITY_COOKIE}=`));
  const serialized = JSON.stringify(issued.body);
  for (const canary of [
    PROD_WEBHOOK_CANARY,
    PROD_TRANSPORT_CANARY,
    PREVIEW_WEBHOOK_CANARY,
    PREVIEW_TRANSPORT_CANARY
  ]) assert.equal(serialized.includes(canary), false);
});

test('valid diagnostic proofs confirm fixed nonsecret same-origin invariants', async () => {
  const issued = await issue();
  const response = await handleAdminTabletDiagnostic(actionRequest({
    body: proofBody(issued),
    capabilityCookie: issued.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response.clone()), {
    ok: true,
    endpointExpected: true,
    credentialMatch: true
  });
  assertCapabilityCleared(response);
});

test('verification is run-bound, session-bound, expiring, and rejects the general Admin header', async () => {
  const issued = await issue();
  const wrongRun = await handleAdminTabletDiagnostic(actionRequest({
    body: proofBody(issued, RUN_B),
    capabilityCookie: issued.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(wrongRun.status, 403);
  assertCapabilityCleared(wrongRun);

  const wrongSession = await handleAdminTabletDiagnostic(actionRequest({
    body: proofBody(issued),
    adminCookieValue: adminCookie(PROD_ORIGIN, PROD_ENV, ALT_ADMIN_TOKEN),
    capabilityCookie: issued.capabilityCookie
  }), { env: PROD_ENV, now: NOW });
  assert.equal(wrongSession.status, 403);

  const expired = await handleAdminTabletDiagnostic(actionRequest({
    body: proofBody(issued),
    capabilityCookie: issued.capabilityCookie
  }), { env: PROD_ENV, now: NOW + (CAPABILITY_SECONDS + 1) * 1_000 });
  assert.equal(expired.status, 403);

  const headerRejected = await handleAdminTabletDiagnostic(actionRequest({
    body: proofBody(issued),
    capabilityCookie: issued.capabilityCookie,
    adminHeader: ADMIN_TOKEN
  }), { env: PROD_ENV, now: NOW });
  assert.equal(headerRejected.status, 400);
  assertCapabilityCleared(headerRejected);
});

test('invalid host, origin, path, and extra issue fields fail closed', async () => {
  const foreign = await handleAdminTabletDiagnostic(actionRequest({
    origin: 'https://example.com',
    body: { action: 'issue', runId: RUN_A },
    adminCookieValue: '',
    adminHeader: ADMIN_TOKEN
  }), { env: PROD_ENV, now: NOW });
  assert.equal(foreign.status, 403);

  const wrongPath = await handleAdminTabletDiagnostic(actionRequest({
    body: { action: 'issue', runId: RUN_A },
    path: '/.netlify/functions/m1-admin-tablet-diagnostic',
    adminHeader: ADMIN_TOKEN
  }), { env: PROD_ENV, now: NOW });
  assert.equal(wrongPath.status, 403);

  const extra = await handleAdminTabletDiagnostic(actionRequest({
    body: { action: 'issue', runId: RUN_A, credential: 'forbidden' },
    adminHeader: ADMIN_TOKEN
  }), { env: PROD_ENV, now: NOW });
  assert.equal(extra.status, 400);
});

test('production and Deploy Preview diagnostics never return server transport values', async () => {
  for (const [origin, env, seed] of [
    [PROD_ORIGIN, PROD_ENV, 31],
    [PREVIEW_ORIGIN, PREVIEW_ENV, 41]
  ]) {
    const issued = await issue({ origin, env, seed });
    assert.equal(issued.response.status, 200);
    const response = await handleAdminTabletDiagnostic(actionRequest({
      origin,
      body: proofBody(issued),
      adminCookieValue: adminCookie(origin, env),
      capabilityCookie: issued.capabilityCookie
    }), { env, now: NOW });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.deepEqual(JSON.parse(serialized), {
      ok: true,
      endpointExpected: true,
      credentialMatch: true
    });
    for (const canary of Object.values(env)) {
      assert.equal(serialized.includes(canary), false);
    }
  }
});

test('browser clears obsolete settings without reading them and reports canonical counts', async () => {
  const oldEndpointCanary = 'forbidden-endpoint-canary';
  const oldCredentialCanary = 'forbidden-credential-canary';
  const storage = new Map([
    ['gib_m1_sync_url_v1', oldEndpointCanary],
    ['gib_m1_sync_token_v1', oldCredentialCanary],
    ['gib_m1_sync_auto_v1', 'true'],
    ['gib_m1_local_state_v2', JSON.stringify({
      version: 2,
      ledger: [{ RowID: 'one' }, { RowID: 'two' }],
      queue: [{ RowID: 'two' }]
    })]
  ]);
  const harness = browserHarness(storage);
  const proofKey = Buffer.alloc(32, 5).toString('base64url');
  harness.dispatch({ type: REQUEST_TYPE, runId: RUN_A, proofKey });
  await waitFor(() => harness.posted.length === 1);

  assert.equal(storage.has('gib_m1_sync_url_v1'), false);
  assert.equal(storage.has('gib_m1_sync_token_v1'), false);
  assert.equal(storage.get('gib_m1_sync_auto_v1'), 'false');
  const forbiddenGets = harness.storageCalls.filter(call =>
    call.action === 'get'
    && (call.key === 'gib_m1_sync_url_v1' || call.key === 'gib_m1_sync_token_v1')
  );
  assert.deepEqual(forbiddenGets, []);

  const posted = harness.posted[0];
  assert.equal(posted.targetOrigin, PROD_ORIGIN);
  assert.equal(posted.message.type, PROOFS_TYPE);
  assert.equal(posted.message.queueCount, 1);
  assert.equal(posted.message.historyCount, 2);
  assert.equal(posted.message.autoSync, false);
  const serialized = JSON.stringify(posted);
  assert.equal(serialized.includes(oldEndpointCanary), false);
  assert.equal(serialized.includes(oldCredentialCanary), false);

  harness.dispatch({
    type: RESULT_TYPE,
    runId: RUN_A,
    endpointExpected: true,
    credentialMatch: true
  });
  assert.equal(harness.elements.get('diagnosticResults').hidden, false);
  assert.equal(harness.elements.get('endpointResult').textContent, 'SAME-ORIGIN');
  assert.equal(harness.elements.get('credentialResult').textContent, 'ABSENT');
  assert.equal(harness.elements.get('autoResult').textContent, 'OFF');
  assert.equal(harness.elements.get('queueResult').textContent, '1');
  assert.equal(harness.elements.get('historyResult').textContent, '2');
});

test('browser source and verifier contain no backend identifier or credential disclosure route', () => {
  assert.doesNotMatch(diagnosticHtml, /GIB_(?:M1|TEST)_WEBHOOK|script\.google|macros\/s\//u);
  assert.doesNotMatch(verifierSource, /LEGACY_KIOSK|createInstallEnvelope|installEnvelope|createECDH|hkdfSync/u);
  assert.doesNotMatch(verifierSource, /\.webhookUrl|\.webhookToken/u);
  assert.doesNotMatch(kioskHtml, /SYNC_URL_KEY|SYNC_TOKEN_KEY|mode:\s*['"]no-cors['"]/u);
  assert.doesNotMatch(syncCore, /script\.google|GIB_TEST_WEBHOOK|token\s*:/u);
  assert.match(workflow, /m1\/tablet-diagnostic\.html/u);
  assert.match(workflow, /m1-admin-tablet-diagnostic\.mjs/u);
  assert.match(verifierConfig.path, /^\/api\/m1-tablet-diagnostic-verifier$/u);
  assert.match(runbook, /same-origin/u);
});

test('kiosk disclosure path is removed and required CI covers the replacement', () => {
  assert.doesNotMatch(kioskHtml, /id="cfgSyncUrl"|id="cfgSyncToken"/u);
  assert.doesNotMatch(kioskHtml, /SYNC_URL_KEY|SYNC_TOKEN_KEY|mode:\s*['"]no-cors['"]/u);
  assert.match(kioskHtml, /requestAcknowledgements\(submittedRows/u);
  assert.match(workflow, /m1\/index\.html/u);
  assert.match(workflow, /m1\/sync-core\.mjs/u);
  assert.match(workflow, /netlify\/functions\/m1-kiosk-sync\.mjs/u);
});
