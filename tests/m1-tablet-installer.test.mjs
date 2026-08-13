import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');

const installerHtml = read('m1/tablet-install.html');
const diagnosticHtml = read('m1/production-diagnostic.html');
const kioskHtml = read('m1/index.html');
const headersSource = read('_headers');

const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';
const INSTALL_PATH = '/m1/tablet-install.html';
const DIAGNOSTIC_PATH = '/m1/production-diagnostic.html';
const CAPABILITY = `eyJ2IjoxLCJwdXJwb3NlIjoiZ2liLW0xLXByb2R1Y3Rpb24tdGFibGV0LWluc3RhbGwifQ.${'S'.repeat(43)}`;

function inlineScript(html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
  assert.equal(scripts.length, 1, 'page should contain exactly one inline script');
  return scripts[0][1];
}

function headerSection(path) {
  const normalized = headersSource.replaceAll('\r\n', '\n');
  const start = normalized.indexOf(`${path}\n`);
  if (start < 0) return '';
  const remainder = normalized.slice(start + path.length + 1);
  const next = remainder.search(/^\S/mu);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function response(body, { ok = true, status = ok ? 200 : 403 } = {}) {
  return {
    ok,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

function storageHarness(entries, { failSetKey = '' } = {}) {
  const data = new Map(entries);
  const calls = [];
  const storage = {
    get length() { return data.size; },
    getItem(key) {
      calls.push({ operation: 'get', key });
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      calls.push({ operation: 'set', key, value: String(value) });
      if (key === failSetKey) throw new Error('synthetic storage failure');
      data.set(key, String(value));
    },
    removeItem(key) {
      calls.push({ operation: 'remove', key });
      data.delete(key);
    },
    key(index) { return [...data.keys()][index] || null; }
  };
  return { data, calls, storage };
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function runInstaller({
  origin = PRODUCTION_ORIGIN,
  pathname = INSTALL_PATH,
  search = '',
  hash = `#${CAPABILITY}`,
  responseValue = response({ ok: true, installed: true }),
  storageEntries = [],
  failSetKey = ''
} = {}) {
  const elements = new Map([
    ['statusMessage', { textContent: 'Checking the one-time setup link...' }]
  ]);
  const storage = storageHarness(storageEntries, { failSetKey });
  const events = [];
  const requests = [];
  const logs = [];
  const location = { origin, pathname, search, hash };
  const history = {
    replaceState(state, title, url) {
      events.push({ type: 'history', url });
      location.pathname = url;
      location.search = '';
      location.hash = '';
    }
  };
  const window = { location, history };
  const context = vm.createContext({
    window,
    location,
    history,
    localStorage: storage.storage,
    document: {
      getElementById(id) {
        assert.ok(elements.has(id), `unexpected element lookup: ${id}`);
        return elements.get(id);
      }
    },
    async fetch(url, options) {
      events.push({ type: 'fetch', url });
      requests.push({ url, options });
      return responseValue;
    },
    console: {
      log: (...values) => logs.push(values),
      warn: (...values) => logs.push(values),
      error: (...values) => logs.push(values)
    }
  });
  window.window = window;
  window.document = context.document;
  window.localStorage = storage.storage;
  window.fetch = context.fetch;

  new vm.Script(inlineScript(installerHtml), { filename: 'tablet-install.inline.js' })
    .runInContext(context);
  await flushAsyncWork();
  return { ...storage, elements, events, requests, logs, location };
}

async function runDiagnostic({
  origin = PRODUCTION_ORIGIN,
  pathname = DIAGNOSTIC_PATH,
  search = '',
  responseValue = response({ authorized: true }),
  storageEntries = []
} = {}) {
  const elementIds = [
    'statusMessage',
    'originResult',
    'authorizationResult',
    'autoSyncResult',
    'historyCountResult',
    'waitingCountResult',
    'buildResult'
  ];
  const elements = new Map(elementIds.map(id => [id, { textContent: '' }]));
  const storage = storageHarness(storageEntries);
  const requests = [];
  const logs = [];
  const location = { origin, pathname, search, hash: '' };
  const window = { location };
  const context = vm.createContext({
    window,
    location,
    localStorage: storage.storage,
    document: {
      getElementById(id) {
        assert.ok(elements.has(id), `unexpected element lookup: ${id}`);
        return elements.get(id);
      }
    },
    async fetch(url, options) {
      requests.push({ url, options });
      return responseValue;
    },
    console: {
      log: (...values) => logs.push(values),
      warn: (...values) => logs.push(values),
      error: (...values) => logs.push(values)
    }
  });
  window.window = window;
  window.document = context.document;
  window.localStorage = storage.storage;
  window.fetch = context.fetch;

  new vm.Script(inlineScript(diagnosticHtml), { filename: 'production-diagnostic.inline.js' })
    .runInContext(context);
  await flushAsyncWork();
  return { ...storage, elements, requests, logs };
}

test('tablet installer is production-only, scrubs the fragment first, and posts the exact capability contract', async () => {
  const canonicalState = '{\r\n  "version": 2, "ledger": [{"RowID":"history-1"}], "queue": [{"RowID":"queue-1"}]\r\n}';
  const legacyQueue = '[ {"legacyQueue": 1} ]';
  const legacyHistory = '[ {"legacyHistory": 1} ]';
  const harness = await runInstaller({
    storageEntries: [
      ['gib_m1_local_state_v2', canonicalState],
      ['gib_m1_sync_queue_v1', legacyQueue],
      ['gib_m1_signins_v1', legacyHistory],
      ['gib_m1_sync_auto_v1', 'true'],
      ['unrelated', 'unchanged']
    ]
  });

  assert.equal(harness.events[0].type, 'history');
  assert.equal(harness.events[0].url, INSTALL_PATH);
  assert.equal(harness.location.hash, '');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].url, '/api/m1-tablet-install');
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), { capability: CAPABILITY });
  assert.equal(harness.requests[0].options.method, 'POST');
  assert.equal(harness.requests[0].options.mode, 'same-origin');
  assert.equal(harness.requests[0].options.credentials, 'same-origin');
  assert.equal(harness.requests[0].options.cache, 'no-store');
  assert.equal(harness.requests[0].options.redirect, 'error');
  assert.equal(harness.requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(harness.data.get('gib_m1_sync_auto_v1'), 'false');
  assert.equal(harness.data.get('gib_m1_local_state_v2'), canonicalState);
  assert.equal(harness.data.get('gib_m1_sync_queue_v1'), legacyQueue);
  assert.equal(harness.data.get('gib_m1_signins_v1'), legacyHistory);
  assert.equal(harness.data.get('unrelated'), 'unchanged');
  assert.deepEqual(
    [...new Set(harness.calls.filter(call => call.operation !== 'get').map(call => call.key))],
    ['gib_m1_sync_auto_v1']
  );
  assert.equal(harness.elements.get('statusMessage').textContent, 'Tablet authorization installed. Auto-sync is OFF.');
  assert.equal(harness.elements.get('statusMessage').textContent.includes(CAPABILITY), false);
  assert.equal(JSON.stringify(harness.logs).includes(CAPABILITY), false);
});

test('tablet installer fails closed for wrong origin, invalid response, and unavailable safe storage', async () => {
  const wrongOrigin = await runInstaller({ origin: 'https://deploy-preview-50--gib-live.netlify.app' });
  assert.equal(wrongOrigin.requests.length, 0);
  assert.equal(wrongOrigin.location.hash, '');
  assert.equal(wrongOrigin.elements.get('statusMessage').textContent, 'Installation is unavailable at this location.');

  const canonicalState = JSON.stringify({ version: 2, ledger: [{}], queue: [{}] });
  const rejected = await runInstaller({
    responseValue: response({ ok: false, message: 'Tablet installation was not accepted.' }, { ok: false }),
    storageEntries: [
      ['gib_m1_local_state_v2', canonicalState],
      ['gib_m1_sync_auto_v1', 'true']
    ]
  });
  assert.equal(rejected.requests.length, 1);
  assert.equal(rejected.data.get('gib_m1_sync_auto_v1'), 'false');
  assert.equal(rejected.data.get('gib_m1_local_state_v2'), canonicalState);
  assert.equal(rejected.elements.get('statusMessage').textContent, 'Installation was not completed.');
  assert.equal(rejected.elements.get('statusMessage').textContent.includes(CAPABILITY), false);

  const storageFailure = await runInstaller({
    failSetKey: 'gib_m1_sync_auto_v1',
    storageEntries: [
      ['gib_m1_local_state_v2', canonicalState],
      ['gib_m1_sync_auto_v1', 'true']
    ]
  });
  assert.equal(storageFailure.requests.length, 0);
  assert.equal(storageFailure.data.get('gib_m1_local_state_v2'), canonicalState);
  assert.match(storageFailure.elements.get('statusMessage').textContent, /stopped safely/u);
});

test('tablet installer source has no disclosure or alternate transport path', () => {
  assert.match(installerHtml, /const PRODUCTION_ORIGIN = 'https:\/\/gib-live\.netlify\.app'/u);
  assert.match(installerHtml, /const EXPECTED_PATH = '\/m1\/tablet-install\.html'/u);
  assert.match(installerHtml, /const INSTALL_ENDPOINT = '\/api\/m1-tablet-install'/u);
  assert.match(installerHtml, /history\.replaceState\(null, '', EXPECTED_PATH\)/u);
  assert.match(installerHtml, /credentials: 'same-origin'/u);
  assert.doesNotMatch(installerHtml, /script\.google|macros\/s\/|GIB_(?:M1|TEST)_|document\.cookie|navigator\.clipboard|\bconsole\./u);
  assert.doesNotMatch(installerHtml, /<input\b|<textarea\b|<form\b|localStorage\.setItem\([^\n]*local_state|localStorage\.setItem\([^\n]*(?:queue|signins)/iu);
  assert.doesNotMatch(installerHtml, /gib_m1_sync_(?:url|token)_v1/u);
});

test('production diagnostic returns only the six safe fields and never mutates storage', async () => {
  const canonicalState = '{"version":2,"ledger":[{"a":1},{"a":2},{"a":3}],"queue":[{"q":1},{"q":2}]}';
  const harness = await runDiagnostic({
    storageEntries: [
      ['gib_m1_local_state_v2', canonicalState],
      ['gib_m1_sync_auto_v1', 'false'],
      ['unrelated', 'unchanged']
    ]
  });

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].url, '/api/m1-tablet-status');
  assert.equal(harness.requests[0].options.method, 'POST');
  assert.equal(harness.requests[0].options.credentials, 'same-origin');
  assert.equal(harness.requests[0].options.body, '{}');
  assert.deepEqual([
    harness.elements.get('originResult').textContent,
    harness.elements.get('authorizationResult').textContent,
    harness.elements.get('autoSyncResult').textContent,
    harness.elements.get('historyCountResult').textContent,
    harness.elements.get('waitingCountResult').textContent,
    harness.elements.get('buildResult').textContent
  ], ['YES', 'YES', 'OFF', '3', '2', '2026-08-16 M1 PRODUCTION unified-rollout']);
  assert.equal(harness.calls.some(call => call.operation !== 'get'), false);
  assert.equal(harness.data.get('gib_m1_local_state_v2'), canonicalState);
  assert.equal(harness.data.get('unrelated'), 'unchanged');
  assert.equal(harness.logs.length, 0);

  const labels = [...diagnosticHtml.matchAll(/<dt>([^<]+)<\/dt>/gu)].map(match => match[1]);
  assert.deepEqual(labels, [
    'Correct production origin',
    'Device authorized',
    'Auto-sync',
    'Local sign-in count',
    'Waiting count',
    'Build/version'
  ]);
  const productionBuild = kioskHtml.match(/const PRODUCTION_BUILD = '([^']+)'/u);
  assert.ok(productionBuild, 'kiosk production build stamp is required');
  assert.match(diagnosticHtml, new RegExp(productionBuild[1].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('production diagnostic is read-only and never asks a preview for device status', async () => {
  const canonicalState = JSON.stringify({ version: 2, ledger: [{}], queue: [{}, {}] });
  const preview = await runDiagnostic({
    origin: 'https://deploy-preview-50--gib-live.netlify.app',
    storageEntries: [
      ['gib_m1_local_state_v2', canonicalState],
      ['gib_m1_sync_auto_v1', 'true']
    ]
  });
  assert.equal(preview.requests.length, 0);
  assert.deepEqual([
    preview.elements.get('originResult').textContent,
    preview.elements.get('authorizationResult').textContent,
    preview.elements.get('autoSyncResult').textContent,
    preview.elements.get('historyCountResult').textContent,
    preview.elements.get('waitingCountResult').textContent
  ], ['NO', 'NO', 'ON', '1', '2']);
  assert.equal(preview.calls.some(call => call.operation !== 'get'), false);

  assert.doesNotMatch(diagnosticHtml, /GIB_(?:M1|TEST)_|script\.google|macros\/s\/|document\.cookie|navigator\.clipboard|\bconsole\./u);
  assert.doesNotMatch(diagnosticHtml, /localStorage\.(?:setItem|removeItem|clear)\s*\(/u);
});

test('installer and diagnostic have strict static no-store and deny-frame controls', () => {
  for (const [path, html] of [
    [INSTALL_PATH, installerHtml],
    [DIAGNOSTIC_PATH, diagnosticHtml]
  ]) {
    assert.match(html, /<meta name="referrer" content="no-referrer">/u);
    assert.match(html, /default-src 'none'/u);
    assert.match(html, /connect-src 'self'/u);
    const section = headerSection(path);
    assert.ok(section, `missing headers for ${path}`);
    assert.match(section, /Cache-Control: no-store, max-age=0/u);
    assert.match(section, /Content-Security-Policy: default-src 'none'/u);
    assert.match(section, /frame-ancestors 'none'/u);
    assert.match(section, /X-Frame-Options: DENY/u);
    assert.match(section, /Referrer-Policy: no-referrer/u);
  }
});
