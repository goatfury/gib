import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { installationProfile } from '../m1/installation-profile-core.mjs';
import { activationFailureCode } from '../m1/sync-core.mjs';

const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const AUTO = 'gib_m1_richmond_production_sync_auto_v1';
const MARKER = 'gib_m1_richmond_production_activation_auto_sync_migration_v1';
const STATE = 'gib_m1_richmond_production_local_state_v2';
const ACTIVE = { authorized: true, writesEnabled: true, activation: 'active' };

function functionSource(name) {
  let start = html.indexOf(`async function ${name}(`);
  if (start < 0) start = html.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const brace = html.indexOf('{', html.indexOf(')', start));
  let depth = 0;
  for (let index = brace; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Incomplete function: ${name}`);
}

function harness({ initial = {}, fetchImpl, richmond = true, online = true } = {}) {
  const originalState = JSON.stringify({ version: 2, ledger: [{ RowID: 'saved-row' }], queue: [{ RowID: 'saved-row' }] });
  const storage = new Map([[AUTO, 'false'], [STATE, originalState], ...Object.entries(initial)]);
  const listeners = new Map();
  const intervals = [];
  const timeouts = new Map();
  const requests = [];
  let sequence = 0;
  let sends = 0;
  let responder = fetchImpl || (async () => new Response(JSON.stringify(ACTIVE)));
  const navigator = { onLine: online };
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, callback) => listeners.set(name, callback)
  };
  const window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    setInterval: callback => intervals.push(callback),
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timeouts.delete(id)
  };
  const context = vm.createContext({
    Promise, Response, AbortController,
    location: { origin: richmond ? 'https://gib-richmond-live.netlify.app' : 'https://gib-live.netlify.app' },
    INSTALLATION: richmond ? installationProfile('richmond', 'production', 'active') : installationProfile('rev'),
    SYNC_AUTO_KEY: AUTO,
    RICHMOND_ACTIVATION_MIGRATION_KEY: MARKER,
    BACKEND_ENABLED: true,
    IS_RICHMOND_PRODUCTION: richmond,
    RICHMOND_WRITES_ENABLED: richmond,
    INSTRUCTOR_SYNC_RETRY_INTERVAL_MS: 30_000,
    navigator, document, window,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    loadSyncQueue: () => JSON.parse(storage.get(STATE)).queue,
    syncNow: () => { sends += 1; },
    loadSyncSettings() {},
    updateSyncStatus() {},
    recordSyncEvent() {},
    activationFailureCode,
    fetch: (url, options) => {
      requests.push({ url, options });
      return responder(url, options);
    }
  });
  const start = html.indexOf('  if (BACKEND_ENABLED && (!IS_RICHMOND_PRODUCTION || RICHMOND_WRITES_ENABLED)) {');
  const end = html.indexOf('  refreshNameDatalist();', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext([
    functionSource('applyRichmondActivationMigration'),
    functionSource('requestRichmondActivationStatus'),
    'let richmondActivationMigrationInFlight = null;',
    functionSource('runRichmondActivationMigration'),
    functionSource('resumeInstructorSync'),
    html.slice(start, end)
  ].join('\n'), context);

  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    for (const [id, timer] of timeouts) {
      if (timer.delay !== 0) continue;
      timeouts.delete(id);
      timer.callback();
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  return {
    storage, requests, timeouts, originalState,
    get sends() { return sends; },
    setResponder(value) { responder = value; },
    settle,
    async interval() { intervals.forEach(callback => callback()); await settle(); },
    async event(name) { listeners.get(name)?.(); await settle(); },
    async expireRequests() {
      for (const [id, timer] of [...timeouts]) {
        if (timer.delay !== 30_000) continue;
        timeouts.delete(id);
        timer.callback();
      }
      await settle();
    }
  };
}

test('Richmond retries a failed startup check while Wi-Fi stays connected, without refreshing', async () => {
  const h = harness({ fetchImpl: async () => { throw new Error('temporary network failure'); } });
  await h.settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.storage.get(AUTO), 'false');
  assert.equal(h.storage.get(STATE), h.originalState);
  h.setResponder(async () => new Response(JSON.stringify(ACTIVE)));
  await h.interval();
  assert.equal(h.requests.length, 2, 'the regular timer must retry authorization, not remain stuck OFF');
  assert.equal(h.storage.get(AUTO), 'true');
  assert.equal(h.sends, 1);
  assert.equal(h.storage.get(STATE), h.originalState, 'activation must preserve queued entries until upload acknowledgment');
});

test('Richmond retries the initial check on wake without a network-change event', async () => {
  for (const event of ['focus', 'pageshow', 'visibilitychange']) {
    const h = harness({ fetchImpl: async () => new Response('{}', { status: 503 }) });
    await h.settle();
    h.setResponder(async () => new Response(JSON.stringify(ACTIVE)));
    await h.event(event);
    assert.equal(h.sends, 1, event);
    assert.equal(h.storage.get(STATE), h.originalState);
  }
});

test('a stalled status response times out, releases the pending check, and recovers on the next retry', async () => {
  const h = harness({ fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('request timed out')));
  }) });
  await h.settle();
  await h.interval();
  await h.event('online');
  assert.equal(h.requests.length, 1, 'only one status request may be in flight');
  assert.equal([...h.timeouts.values()].filter(timer => timer.delay === 30_000).length, 1);
  await h.expireRequests();
  h.setResponder(async () => new Response(JSON.stringify(ACTIVE)));
  await h.interval();
  assert.equal(h.requests.length, 2);
  assert.equal(h.sends, 1);
  assert.equal(h.timeouts.size, 0, 'completed checks must clear their timeout');
});

test('failed authorization and disabled write gates never enable uploads or alter stored entries', async () => {
  for (const status of [{ ...ACTIVE, authorized: false }, { authorized: true, writesEnabled: false, activation: 'pending' }]) {
    const h = harness({ fetchImpl: async () => new Response(JSON.stringify(status)) });
    await h.settle();
    await h.interval();
    assert.equal(h.requests.length, 2);
    assert.equal(h.storage.get(AUTO), 'false');
    assert.equal(h.storage.has(MARKER), false);
    assert.equal(h.storage.get(STATE), h.originalState);
    assert.equal(h.sends, 0);
  }
});

test('an intentional OFF setting after activation stays OFF, and Revolution skips Richmond activation', async () => {
  for (const options of [{ initial: { [MARKER]: 'richmond-production-auto-sync-v1' } }, { richmond: false }]) {
    const h = harness(options);
    await h.settle();
    await h.interval();
    await h.event('focus');
    await h.event('online');
    assert.equal(h.requests.length, 0);
    assert.equal(h.sends, 0);
    assert.equal(h.storage.get(AUTO), 'false');
    assert.equal(h.storage.get(STATE), h.originalState);
  }
});
