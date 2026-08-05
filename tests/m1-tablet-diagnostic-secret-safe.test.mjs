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
  ENDPOINT_PROOF_DOMAIN,
  config as verifierConfig,
  handleAdminTabletDiagnostic
} from '../netlify/functions/m1-admin-tablet-diagnostic.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');
const diagnosticHtml = read('m1/tablet-diagnostic.html');
const adminHtml = read('m1/admin/index.html');
const verifierSource = read('netlify/functions/m1-admin-tablet-diagnostic.mjs');
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
const PROD_ENV = Object.freeze({
  GIB_M1_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_TARGET/exec',
  GIB_M1_WEBHOOK_TOKEN: 'synthetic-legacy-credential',
  GIB_M1_ADMIN_ACTION_TOKEN: 'synthetic-admin-action-token',
  GIB_M1_ADMIN_PASSPHRASE: 'synthetic private admin access phrase'
});
const PREVIEW_ENV = Object.freeze({
  ...PROD_ENV,
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PREVIEW_TARGET/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-preview-credential',
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

function hmacProof(proofKey, runId, domain, value) {
  return createHmac('sha256', Buffer.from(proofKey, 'utf8'))
    .update(`${domain}\0${runId}\0${value}`, 'utf8')
    .digest('hex');
}

function proofBody(issued, runId = issued.body.runId, env = PROD_ENV) {
  return {
    action: 'verify',
    runId,
    endpointProof: hmacProof(issued.body.proofKey, runId, ENDPOINT_PROOF_DOMAIN,
      env.GIB_M1_WEBHOOK_URL || env.GIB_TEST_WEBHOOK_URL),
    credentialProof: hmacProof(issued.body.proofKey, runId, CREDENTIAL_PROOF_DOMAIN,
      env.GIB_M1_WEBHOOK_TOKEN || env.GIB_TEST_WEBHOOK_TOKEN)
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

test('same-origin instructions, no raw entry, no child network, and preview alignment are pinned', () => {
  assert.match(runbook, /https:\/\/gib-live\.netlify\.app\/m1\/tablet-diagnostic\.html/u);
  assert.match(runbook, /bjjsite\.com[^\n]+(?:not|must not)[^\n]+tablet diagnostic/iu);
  assert.match(diagnosticHtml, /connect-src 'none'/u);
  assert.doesNotMatch(diagnosticHtml, /<input\b|<textarea\b|<form\b/iu);
  assert.doesNotMatch(diagnosticHtml, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|requestToken/iu);
  assert.match(diagnosticHtml, /deploy-preview-\\d\+--gib-live\\\.netlify\\\.app/u);
  assert.match(adminHtml, /deploy-preview-\\d\+--gib-live\\\.netlify\\\.app/u);
});

test('verifier has the exact two-request rate limit and only issue then verify actions', () => {
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
  assert.match(verifierSource, /Object\.keys\(value\)\.length\s*===\s*4[\s\S]*value\.action\s*===\s*'verify'/u);
  const dispatch = verifierSource.slice(
    verifierSource.indexOf('export async function handleAdminTabletDiagnostic'),
    verifierSource.indexOf('export default request')
  );
  assert.deepEqual(
    [...dispatch.matchAll(/parsed\.value\.action\s*===\s*'([^']+)'/gu)].map(match => match[1]),
    ['issue', 'verify']
  );
  assert.match(dispatch, /return withCapabilityCleared\(invalidRequestResponse\(\)\);/u);
});

test('Admin gives the child only a v2 run-bound proof key and verifies without the general token header', () => {
  const openSource = adminHtml.slice(
    adminHtml.indexOf('async function openTabletDiagnostic()'),
    adminHtml.indexOf('async function requestDiagnosticVerification')
  );
  const childMessage = openSource.match(/popup\.postMessage\(\{([\s\S]*?)\},\s*location\.origin\)/u);
  assert.ok(childMessage);
  assert.match(childMessage[1], /type:\s*TABLET_DIAGNOSTIC_REQUEST[\s\S]*runId[\s\S]*proofKey/u);
  assert.doesNotMatch(childMessage[1], /requestToken|adminRequestToken|endpointProof|credentialProof/u);
  assert.match(openSource, /requestJson\(API\.tabletDiagnostic,\s*\{\s*action:\s*'issue',\s*runId\s*\}\)/u);
  const verifySource = adminHtml.slice(
    adminHtml.indexOf('async function requestDiagnosticVerification'),
    adminHtml.indexOf('async function requestJson')
  );
  assert.doesNotMatch(verifySource, /ADMIN_REQUEST_HEADER|adminRequestToken/u);
  assert.match(verifySource, /action:\s*'verify'[\s\S]*runId[\s\S]*endpointProof[\s\S]*credentialProof/u);
  assert.match(diagnosticHtml, /endpoint:\s*'gib-m1-tablet-diagnostic:endpoint:v2'/u);
  assert.match(diagnosticHtml, /credential:\s*'gib-m1-tablet-diagnostic:credential:v2'/u);
  assert.match(diagnosticHtml, /hmacProof\(key,\s*HMAC_DOMAIN\.endpoint,\s*runId,/u);
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
    runId: RUN_A,
    endpointProof: hmacProof(issued.body.proofKey, RUN_A, ENDPOINT_PROOF_DOMAIN, PREVIEW_ENV.GIB_TEST_WEBHOOK_URL),
    credentialProof: hmacProof(issued.body.proofKey, RUN_A, CREDENTIAL_PROOF_DOMAIN, PREVIEW_ENV.GIB_TEST_WEBHOOK_TOKEN)
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

test('seeded same-origin storage emits v2 run-bound proofs and the five safe outputs', async () => {
  const proofKey = 'P'.repeat(43);
  const elements = new Map(['statusMessage', 'endpointResult', 'credentialResult', 'autoResult', 'queueResult', 'historyResult']
    .map(id => [id, { textContent: 'NOT CHECKED' }]));
  const storage = new Map([
    ['gib_m1_sync_url_v1', PROD_ENV.GIB_M1_WEBHOOK_URL],
    ['gib_m1_sync_token_v1', PROD_ENV.GIB_M1_WEBHOOK_TOKEN],
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
    crypto: webcrypto,
    document: { getElementById: id => elements.get(id) },
    localStorage: { getItem: key => storage.get(key) ?? null },
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
    hmacProof(proofKey, RUN_A, CREDENTIAL_PROOF_DOMAIN, PROD_ENV.GIB_M1_WEBHOOK_TOKEN));
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
});
