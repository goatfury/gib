import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { createDayRolloverController } from '../m1/sync-core.mjs';

const kiosk = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');
const admin = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');
const service = readFileSync(new URL('../netlify/functions/m1-schedule.mjs', import.meta.url), 'utf8');
const shared = JSON.parse(readFileSync(new URL('../m1/shared-schedule.json', import.meta.url), 'utf8'));

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function functionSource(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const signature = new RegExp(
    `^[ \\t]*(?:async[ \\t]+)?function[ \\t]+${escapedName}[ \\t]*\\(`,
    'mu'
  );
  const match = signature.exec(source);
  assert.ok(match, `Missing function: ${name}`);
  const remainder = source.slice(match.index + match[0].length);
  const nextFunction = /^[ \t]*(?:async[ \t]+)?function[ \t]+[$A-Z_a-z][\w$]*[ \t]*\(/mu.exec(remainder);
  const endIndex = nextFunction
    ? match.index + match[0].length + nextFunction.index
    : source.length;
  return source.slice(match.index, endIndex);
}

function scheduleResponse(days = shared.days, overrides = {}) {
  const contentHash = createHash('sha256').update(JSON.stringify(days), 'utf8').digest('hex');
  const sourceType = overrides.sourceType || 'wordpress-rest';
  const current = overrides.current ?? sourceType === 'wordpress-rest';
  const fallback = overrides.fallback || (current ? 'none' : 'bootstrap');
  return {
    timezone: 'America/New_York',
    site: 'Rev',
    version: `revbjj-${contentHash.slice(0, 16)}`,
    contentHash,
    days: structuredClone(days),
    source: {
      url: 'https://revolutionbjj.com/schedule/',
      upstreamUrl: 'https://revolutionbjj.com/wp-json/wp/v2/pages?slug=schedule&status=publish&_fields=id,type,slug,status,link,title,modified,modified_gmt,content',
      type: sourceType,
      pageId: sourceType === 'wordpress-rest' ? 15 : null,
      modifiedAt: overrides.modifiedAt || (sourceType === 'wordpress-rest'
        ? '2026-08-11T20:24:26Z'
        : '2026-08-11')
    },
    fetchedAt: overrides.fetchedAt || '2026-08-11T21:00:00.000Z',
    current,
    fallback,
    status: {
      state: current ? 'current' : 'fallback',
      current,
      fallback,
      reason: overrides.reason ?? null,
      storageWarning: overrides.storageWarning ?? null,
      servedAt: overrides.servedAt || '2026-08-11T21:00:01.000Z'
    },
    cache: { refreshIntervalSeconds: 300 }
  };
}

function browserContext(extras = {}) {
  return vm.createContext({
    AbortController,
    Response,
    TextEncoder,
    Uint8Array,
    URL,
    crypto: webcrypto,
    console: { warn() {}, error() {} },
    IS_RICHMOND: false,
    BACKEND_ENABLED: true,
    structuredClone,
    ...extras
  });
}

function kioskValidationRuntime(extras = {}) {
  const validation = sourceBetween(
    kiosk,
    'function isPlainObject(value)',
    'function loadLocalScheduleOverride()'
  );
  const context = browserContext(extras);
  new vm.Script(`
    const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const TZ = 'America/New_York';
    const MAX_CLASS_LABEL_LENGTH = 200;
    const MAX_CLASSES_PER_DAY = 24;
    const MIN_TOTAL_CLASSES = 30;
    const MAX_TOTAL_CLASSES = 100;
    const MIN_CLASSES_BY_DAY = Object.freeze({
      Monday: 5, Tuesday: 5, Wednesday: 5, Thursday: 5,
      Friday: 2, Saturday: 2, Sunday: 1
    });
    const CANONICAL_SCHEDULE_CACHE_KEY = 'gib_m1_canonical_schedule_cache_v1';
    const CANONICAL_SCHEDULE_SOURCE_URL = 'https://revolutionbjj.com/schedule/';
    const CANONICAL_SCHEDULE_UPSTREAM_URL = 'https://revolutionbjj.com/wp-json/wp/v2/pages?slug=schedule&status=publish&_fields=id,type,slug,status,link,title,modified,modified_gmt,content';
    const CHECKED_IN_SCHEDULE_VERSION = '2026-08-11';
    const DEFAULT_SCHEDULE = ${JSON.stringify(shared.days)};
    function safeParse(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    }
    function parseStartMinutes(value) {
      const match = /^(\\d{1,2}):(\\d{2})\\s+(AM|PM)\\b/i.exec(String(value));
      if (!match) return Infinity;
      const hour = Number(match[1]);
      return (hour % 12) * 60 + Number(match[2]) + (match[3].toUpperCase() === 'PM' ? 720 : 0);
    }
    ${validation}
    globalThis.hooks = {
      compareCanonicalScheduleFreshness,
      loadCanonicalScheduleCache,
      validateCanonicalSchedule
    };
  `, { filename: 'm1-kiosk-schedule-validation.js' }).runInContext(context);
  return context;
}

function adminValidationRuntime(extras = {}) {
  const validation = sourceBetween(
    admin,
    'function comparisonScheduleLabel(value)',
    'function renderScheduleSource()'
  );
  const context = browserContext(extras);
  new vm.Script(`
    const API = Object.freeze({ scheduleBootstrap: '/m1/shared-schedule.json' });
    const TIME_ZONE = 'America/New_York';
    const SITE = 'Rev';
    const SCHEDULE_DAYS = Object.freeze(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']);
    const SCHEDULE_SOURCE_URL = 'https://revolutionbjj.com/schedule/';
    const SCHEDULE_UPSTREAM_URL = 'https://revolutionbjj.com/wp-json/wp/v2/pages?slug=schedule&status=publish&_fields=id,type,slug,status,link,title,modified,modified_gmt,content';
    const SCHEDULE_VERSION_PATTERN = /^revbjj-([a-f0-9]{16})$/;
    const SCHEDULE_HASH_PATTERN = /^[a-f0-9]{64}$/;
    const SCHEDULE_STATUS_REASON_PATTERN = /^[a-z0-9-]{1,80}$/;
    const MAX_CLASSES_PER_DAY = 24;
    const MIN_TOTAL_CLASSES = 30;
    const MAX_TOTAL_CLASSES = 100;
    const MAX_CLASS_LABEL_LENGTH = 200;
    const MIN_CLASSES_BY_DAY = Object.freeze({
      Monday: 5, Tuesday: 5, Wednesday: 5, Thursday: 5,
      Friday: 2, Saturday: 2, Sunday: 1
    });
    function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
    function validIsoTimestamp(value) {
      return typeof value === 'string'
        && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(value)
        && Number.isFinite(Date.parse(value));
    }
    ${validation}
    globalThis.hooks = { loadCheckedInScheduleBootstrap, validateScheduleResponse };
  `, { filename: 'm1-admin-schedule-validation.js' }).runInContext(context);
  return context;
}

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function kioskRefreshRuntime({ storage, fetchImpl, override = null }) {
  const refresh = [
    functionSource(kiosk, 'refreshCanonicalSchedule'),
    functionSource(kiosk, 'refreshCanonicalScheduleNow')
  ].join('\n');
  const context = kioskValidationRuntime({
    localStorage: storage,
    fetch: fetchImpl,
    window: { setTimeout() { return 1; }, clearTimeout() {} }
  });
  new vm.Script(`
    const CANONICAL_SCHEDULE_ENDPOINT = '/api/m1-schedule';
    const SCHEDULE_FETCH_TIMEOUT_MS = 10000;
    const MAX_SCHEDULE_RESPONSE_CHARS = 100000;
    let canonicalScheduleMemory = null;
    let canonicalScheduleMemoryOrigin = null;
    let canonicalScheduleRuntime = {
      phase: 'idle', error: '', attemptedAt: null, receivedAt: null
    };
    let canonicalScheduleRefreshPromise = null;
    let viewRefreshes = 0;
    let localOverride = ${JSON.stringify(override)};
    function loadLocalScheduleOverride() { return localOverride; }
    function loadSchedule() { return { canonical: canonicalScheduleMemory }; }
    function renderScheduleStatuses() {}
    function refreshScheduleViews() { viewRefreshes += 1; return true; }
    ${refresh}
    globalThis.hooks.refreshCanonicalSchedule = refreshCanonicalSchedule;
    globalThis.hooks.refreshState = () => ({
      memory: canonicalScheduleMemory,
      origin: canonicalScheduleMemoryOrigin,
      runtime: canonicalScheduleRuntime,
      viewRefreshes
    });
  `, { filename: 'm1-kiosk-schedule-refresh.js' }).runInContext(context);
  return context;
}

function kioskOverrideRuntime(storage, canonical = null) {
  const loader = sourceBetween(kiosk, 'function loadLocalScheduleOverride()', 'function saveSchedule(');
  const status = sourceBetween(kiosk, 'function formatScheduleTimestamp(value)', 'function renderScheduleStatuses(');
  const context = browserContext({ localStorage: storage });
  new vm.Script(`
    const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const SCHEDULE_KEY = 'gib_m1_schedule_v1';
    const SCHEDULE_URL_KEY = 'gib_m1_schedule_url_v1';
    const SCHEDULE_MODE_KEY = 'gib_m1_schedule_mode_v1';
    const DEFAULT_SCHEDULE = ${JSON.stringify(shared.days)};
    let canonicalScheduleMemory = ${JSON.stringify(canonical)};
    let canonicalScheduleMemoryOrigin = canonicalScheduleMemory ? 'network' : null;
    let canonicalScheduleRuntime = { phase: 'idle', error: '' };
    function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
    function safeParse(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    }
    function normalizeDayKey(value) {
      return DAYS.find(day => day.toLowerCase() === String(value || '').toLowerCase()) || null;
    }
    ${loader}
    ${status}
    globalThis.hooks = {
      loadSchedule,
      scheduleStatusMessage,
      setCanonical(value, origin = 'network') {
        canonicalScheduleMemory = value;
        canonicalScheduleMemoryOrigin = origin;
      }
    };
  `, { filename: 'm1-kiosk-schedule-overrides.js' }).runInContext(context);
  return context;
}

test('kiosk bootstrap and Daily Review share one checked-in Rev schedule contract', () => {
  const marker = 'const DEFAULT_SCHEDULE = ';
  const bootstrapSource = sourceBetween(kiosk, marker, '// Additional default schedule');
  const objectLiteral = bootstrapSource.slice(marker.length).trim().replace(/;$/u, '');
  const kioskBootstrap = vm.runInNewContext(`(${objectLiteral})`);
  assert.deepEqual(JSON.parse(JSON.stringify(kioskBootstrap)), shared.days);
  assert.equal(shared.timezone, 'America/New_York');
  assert.equal(shared.site, 'Rev');
  assert.equal(Object.values(shared.days).flat().length, 55);
  assert.match(kiosk, /CANONICAL_SCHEDULE_ENDPOINT = INSTALLATION\.scheduleSource\.endpoint/u);
  assert.match(admin, /schedule: '\/api\/m1-schedule'/u);
  assert.match(admin, /scheduleBootstrap: '\/m1\/shared-schedule\.json'/u);
  assert.match(admin, /loadCheckedInScheduleBootstrap/u);
});

test('both real client validators accept the same schedule and reject a false content version', async () => {
  const body = scheduleResponse();
  const kioskRuntime = kioskValidationRuntime({
    localStorage: { getItem() { return null; } }
  });
  const adminRuntime = adminValidationRuntime();
  const kioskValue = await kioskRuntime.hooks.validateCanonicalSchedule(structuredClone(body));
  const adminValue = await adminRuntime.hooks.validateScheduleResponse(structuredClone(body));
  assert.equal(kioskValue.version, adminValue.version);
  assert.deepEqual(
    JSON.parse(JSON.stringify(kioskValue.days)),
    JSON.parse(JSON.stringify(adminValue.days))
  );

  const tampered = structuredClone(body);
  tampered.days.Monday[0] = '6:00 AM Tampered BJJ (Level 2)';
  await assert.rejects(
    kioskRuntime.hooks.validateCanonicalSchedule(structuredClone(tampered)),
    /hash does not match/u
  );
  await assert.rejects(
    adminRuntime.hooks.validateScheduleResponse(structuredClone(tampered)),
    /hash does not match/u
  );
});

test('both client validators accept a 200-character class label and reject 201', async () => {
  assert.match(kiosk, /const MAX_CLASS_LABEL_LENGTH = 200;/u);
  assert.match(admin, /const MAX_CLASS_LABEL_LENGTH = 200;/u);
  const kioskRuntime = kioskValidationRuntime({
    localStorage: { getItem() { return null; } }
  });
  const adminRuntime = adminValidationRuntime();
  const exactDays = structuredClone(shared.days);
  exactDays.Monday[0] = '6:00 AM '.padEnd(200, 'A');
  assert.equal(exactDays.Monday[0].length, 200);
  const exact = scheduleResponse(exactDays);
  await kioskRuntime.hooks.validateCanonicalSchedule(structuredClone(exact));
  await adminRuntime.hooks.validateScheduleResponse(structuredClone(exact));

  const oversizedDays = structuredClone(exactDays);
  oversizedDays.Monday[0] += 'A';
  const oversized = scheduleResponse(oversizedDays);
  await assert.rejects(
    kioskRuntime.hooks.validateCanonicalSchedule(structuredClone(oversized)),
    /unsafe or oversized class label/u
  );
  await assert.rejects(
    adminRuntime.hooks.validateScheduleResponse(structuredClone(oversized)),
    /schedule label is invalid/u
  );
});

test('Daily Review executes its validated checked-in bootstrap when the service is unavailable', async () => {
  let requests = 0;
  const runtime = adminValidationRuntime({
    fetch: async (url, init) => {
      requests += 1;
      assert.equal(url, '/m1/shared-schedule.json');
      assert.equal(init.cache, 'no-store');
      return new Response(JSON.stringify(shared), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const fallback = await runtime.hooks.loadCheckedInScheduleBootstrap();
  assert.equal(requests, 1);
  assert.equal(fallback.current, false);
  assert.equal(fallback.fallback, 'bootstrap');
  assert.equal(fallback.source.type, 'checked-in-bootstrap');
  assert.equal(fallback.status.reason, 'schedule-service-unavailable');
  assert.equal(fallback.version, scheduleResponse().version);
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.days)), shared.days);
});

test('automatic kiosk refresh writes only its dedicated canonical schedule cache', () => {
  const refresh = functionSource(kiosk, 'refreshCanonicalScheduleNow');
  const storageWrites = [...refresh.matchAll(/localStorage\.(?:setItem|removeItem)\(([^\n]+)/gu)]
    .map(match => match[0]);
  assert.deepEqual(storageWrites, [
    'localStorage.setItem(CANONICAL_SCHEDULE_CACHE_KEY, JSON.stringify(validated));'
  ]);
  for (const protectedKey of [
    'SIGNINS_KEY',
    'LOCAL_STATE_KEY',
    'SYNC_QUEUE_KEY',
    'SYNC_AUTO_KEY',
    'DEVICE_KEY',
    'DEVICE_LABEL_KEY',
    'SERIES_KEY',
    'SCHEDULE_KEY'
  ]) {
    assert.doesNotMatch(refresh, new RegExp(`localStorage\\.(?:setItem|removeItem)\\(${protectedKey}\\b`, 'u'));
  }
  assert.doesNotMatch(service, /m1-common|postGoogle|GibM1Receiver|Admin Audit|Signins/u);
});

test('canonical schedule refresh runs at least every 15 minutes and on app lifecycle wakeups', () => {
  const intervalMatch = kiosk.match(
    /const CANONICAL_SCHEDULE_REFRESH_INTERVAL_MS = ([^;]+);/u
  );
  assert.ok(intervalMatch, 'canonical refresh interval must be declared');
  const intervalMs = vm.runInNewContext(intervalMatch[1]);
  assert.equal(Number.isFinite(intervalMs), true);
  assert.ok(intervalMs > 0);
  assert.ok(intervalMs <= 15 * 60 * 1_000);

  const start = functionSource(kiosk, 'startCanonicalScheduleRefresh');
  assert.match(
    start,
    /window\.setInterval\(refreshCanonicalSchedule, CANONICAL_SCHEDULE_REFRESH_INTERVAL_MS\)/u
  );
  assert.match(start, /document\.addEventListener\('visibilitychange'/u);
  assert.match(start, /document\.visibilityState === 'visible'/u);
  assert.match(start, /document\.addEventListener\('resume', refreshCanonicalScheduleIfDue\)/u);
  assert.match(start, /window\.addEventListener\('focus', refreshCanonicalScheduleIfDue\)/u);
  assert.match(start, /window\.addEventListener\('pageshow', refreshCanonicalScheduleIfDue\)/u);
  assert.match(start, /refreshCanonicalSchedule\(\)/u);

  const due = functionSource(kiosk, 'refreshCanonicalScheduleIfDue');
  assert.match(
    due,
    /Date\.now\(\) - attemptedAt >= CANONICAL_SCHEDULE_REFRESH_INTERVAL_MS/u
  );
});

test('executed kiosk refresh retains newer cache offline and mutates no protected state', async () => {
  const canonicalKey = 'gib_m1_canonical_schedule_cache_v1';
  const protectedEntries = {
    gib_m1_signins_v1: JSON.stringify([{ RowID: 'gib-m1-canary-row', Status: 'OK' }]),
    gib_m1_local_state_v2: JSON.stringify({ ledger: [{ RowID: 'gib-m1-canary-row' }], queue: [] }),
    gib_m1_sync_queue_v1: JSON.stringify([{ RowID: 'gib-m1-waiting-row' }]),
    gib_m1_sync_auto_v1: 'true',
    gib_m1_device_v1: JSON.stringify({ siteCode: 'TEST' }),
    gib_m1_device_label_v1: 'QA tablet',
    gib_m1_duration_rules_v1: JSON.stringify([{ match: 'Kids', duration: 0.5 }]),
    gib_m1_instructor_names_v1: JSON.stringify(['QA Test Instructor']),
    gib_m1_admin_pin_v1: 'canary-pin',
    gib_m1_series_v1: JSON.stringify([{ id: 'series-canary' }])
  };
  const current = scheduleResponse();
  const olderDays = structuredClone(shared.days);
  olderDays.Monday[0] = '6:00 AM Older BJJ (Level 2)';
  const olderBootstrap = scheduleResponse(olderDays, {
    sourceType: 'checked-in-bootstrap',
    current: false,
    fallback: 'bootstrap',
    modifiedAt: '2026-08-08',
    reason: 'network-timeout'
  });
  const storage = memoryStorage({
    ...protectedEntries,
    [canonicalKey]: JSON.stringify(current)
  });
  const before = Object.fromEntries(storage.values);
  const olderRuntime = kioskRefreshRuntime({
    storage,
    fetchImpl: async () => new Response(JSON.stringify(olderBootstrap), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.equal(await olderRuntime.hooks.refreshCanonicalSchedule(), false);
  assert.equal(olderRuntime.hooks.refreshState().memory.version, current.version);
  assert.match(olderRuntime.hooks.refreshState().runtime.error, /older or conflicting/u);
  assert.equal(JSON.parse(storage.getItem(canonicalKey)).version, current.version);
  for (const [key, value] of Object.entries(protectedEntries)) {
    assert.equal(storage.getItem(key), value, key);
  }
  assert.deepEqual(
    Object.fromEntries([...storage.values].filter(([key]) => key !== canonicalKey)),
    Object.fromEntries(Object.entries(before).filter(([key]) => key !== canonicalKey))
  );

  const offlineRuntime = kioskRefreshRuntime({
    storage,
    fetchImpl: async () => { throw new TypeError('offline'); }
  });
  assert.equal(await offlineRuntime.hooks.refreshCanonicalSchedule(), false);
  assert.equal(offlineRuntime.hooks.refreshState().memory.version, current.version);
  assert.equal(offlineRuntime.hooks.refreshState().origin, 'local-cache');
  assert.equal(JSON.parse(storage.getItem(canonicalKey)).version, current.version);

  const oldWebsiteDays = structuredClone(shared.days);
  oldWebsiteDays.Monday[0] = '6:00 AM July BJJ (Level 2)';
  const oldWebsite = scheduleResponse(oldWebsiteDays, {
    modifiedAt: '2026-07-01T12:00:00Z',
    fetchedAt: '2026-07-01T13:00:00.000Z',
    servedAt: '2026-07-01T13:00:01.000Z'
  });
  const newerBootstrap = scheduleResponse(shared.days, {
    sourceType: 'checked-in-bootstrap',
    current: false,
    fallback: 'bootstrap',
    modifiedAt: '2026-08-09',
    reason: 'network-timeout'
  });
  const olderCacheStorage = memoryStorage({
    ...protectedEntries,
    [canonicalKey]: JSON.stringify(oldWebsite)
  });
  const newerBootstrapRuntime = kioskRefreshRuntime({
    storage: olderCacheStorage,
    fetchImpl: async () => new Response(JSON.stringify(newerBootstrap), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.equal(await newerBootstrapRuntime.hooks.refreshCanonicalSchedule(), true);
  assert.equal(newerBootstrapRuntime.hooks.refreshState().memory.version, newerBootstrap.version);
  assert.equal(JSON.parse(olderCacheStorage.getItem(canonicalKey)).version, newerBootstrap.version);

  const emptyStorage = memoryStorage(protectedEntries);
  const successRuntime = kioskRefreshRuntime({
    storage: emptyStorage,
    fetchImpl: async () => new Response(JSON.stringify(current), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.equal(await successRuntime.hooks.refreshCanonicalSchedule(), true);
  assert.equal(successRuntime.hooks.refreshState().memory.version, current.version);
  assert.equal(successRuntime.hooks.refreshState().origin, 'network');
  assert.equal(JSON.parse(emptyStorage.getItem(canonicalKey)).version, current.version);
  for (const [key, value] of Object.entries(protectedEntries)) {
    assert.equal(emptyStorage.getItem(key), value, key);
  }

  const bootstrapStorage = memoryStorage(protectedEntries);
  const bootstrapRuntime = kioskRefreshRuntime({
    storage: bootstrapStorage,
    fetchImpl: async () => { throw new TypeError('schedule service unavailable'); }
  });
  assert.equal(await bootstrapRuntime.hooks.refreshCanonicalSchedule(), false);
  const bootstrapState = bootstrapRuntime.hooks.refreshState();
  assert.equal(bootstrapState.memory.fallback, 'bootstrap');
  assert.equal(bootstrapState.memory.version, current.version);
  assert.equal(bootstrapState.origin, 'built-in-bootstrap');
  assert.equal(bootstrapStorage.getItem(canonicalKey), null);
  for (const [key, value] of Object.entries(protectedEntries)) {
    assert.equal(bootstrapStorage.getItem(key), value, key);
  }
});

test('executed kiosk refresh keeps a valid network schedule when browser cache persistence fails', async () => {
  const canonicalKey = 'gib_m1_canonical_schedule_cache_v1';
  const oldDays = structuredClone(shared.days);
  oldDays.Monday[0] = '6:00 AM Older Cached BJJ (Level 2)';
  const oldCache = scheduleResponse(oldDays, {
    modifiedAt: '2026-07-01T12:00:00Z',
    fetchedAt: '2026-07-01T13:00:00.000Z',
    servedAt: '2026-07-01T13:00:01.000Z'
  });
  const current = scheduleResponse();
  const backing = memoryStorage({ [canonicalKey]: JSON.stringify(oldCache) });
  let persistenceAttempts = 0;
  const storage = {
    getItem(key) { return backing.getItem(key); },
    setItem(key, value) {
      persistenceAttempts += 1;
      if (key === canonicalKey) throw new DOMException('quota exceeded', 'QuotaExceededError');
      backing.setItem(key, value);
    },
    removeItem(key) { backing.removeItem(key); }
  };
  const runtime = kioskRefreshRuntime({
    storage,
    fetchImpl: async () => new Response(JSON.stringify(current), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });

  assert.equal(await runtime.hooks.refreshCanonicalSchedule(), true);
  const state = runtime.hooks.refreshState();
  assert.equal(persistenceAttempts, 1);
  assert.equal(state.memory.version, current.version);
  assert.equal(state.memory.status.storageWarning, 'browser-cache-not-updated');
  assert.equal(state.origin, 'network');
  assert.equal(state.runtime.phase, 'ready');
  assert.equal(JSON.parse(backing.getItem(canonicalKey)).version, oldCache.version);
});

test('executed kiosk refresh performs no fetch or write while any local override is active', async () => {
  const storage = memoryStorage({
    gib_m1_schedule_v1: JSON.stringify({ days: {}, source: 'manual' }),
    gib_m1_signins_v1: '[{"RowID":"canary"}]'
  });
  let fetches = 0;
  const runtime = kioskRefreshRuntime({
    storage,
    override: { days: {}, source: 'manual' },
    fetchImpl: async () => {
      fetches += 1;
      return new Response('{}');
    }
  });
  const before = Object.fromEntries(storage.values);
  assert.equal(await runtime.hooks.refreshCanonicalSchedule(), false);
  assert.equal(fetches, 0);
  assert.deepEqual(Object.fromEntries(storage.values), before);
  assert.equal(runtime.hooks.refreshState().runtime.phase, 'override');
});

test('website schedule, validated offline cache, and built-in bootstrap have explicit precedence', () => {
  const loader = sourceBetween(kiosk, 'function loadSchedule()', 'function saveSchedule(');
  assert.ok(loader.indexOf('loadLocalScheduleOverride()') < loader.indexOf('const canonical = canonicalScheduleMemory'));
  assert.ok(loader.indexOf('const canonical = canonicalScheduleMemory') < loader.indexOf('DEFAULT_SCHEDULE'));
  assert.match(loader, /source: 'website'/u);
  assert.match(loader, /cacheOrigin: canonicalScheduleMemoryOrigin \|\| 'network'/u);
  assert.match(loader, /cacheOrigin: 'built-in-bootstrap'/u);

  const refresh = functionSource(kiosk, 'refreshCanonicalScheduleNow');
  assert.match(refresh, /refresh unavailable; retaining validated local schedule/u);
  assert.match(refresh, /refreshScheduleViews\(/u);
});

test('local manual, URL, and disabled schedules remain visible paused overrides', () => {
  assert.match(kiosk, /source === 'url' \|\| source === 'disabled' \|\| source === 'manual'/u);
  assert.match(kiosk, /Local schedule override active/u);
  assert.match(kiosk, /Website updates are paused on this device\./u);
  assert.match(kiosk, /saveSchedule\(scheduleDraft, 'manual'\)/u);
  assert.match(kiosk, /saveSchedule\(validateCanonicalDays\(data\.days\), 'url'\)/u);
  assert.match(kiosk, /saveSchedule\(empty, 'disabled'\)/u);
  assert.match(kiosk, />Revert to website schedule<\/button>/u);
  const summary = functionSource(kiosk, 'adminScheduleSummary');
  assert.match(summary, /Local \$\{source\} schedule/u);
  assert.match(summary, /saved \$\{savedAt\}/u);
  assert.match(summary, /website updates paused/u);
});

test('executed kiosk precedence visibly distinguishes shared, manual, URL, and disabled modes', () => {
  const storage = memoryStorage();
  const canonical = scheduleResponse();
  const runtime = kioskOverrideRuntime(storage, canonical);
  const sharedMode = runtime.hooks.loadSchedule();
  assert.equal(sharedMode.override, false);
  assert.equal(sharedMode.mode, 'website');
  assert.equal(sharedMode.canonical.version, canonical.version);
  assert.match(runtime.hooks.scheduleStatusMessage(sharedMode), /Website schedule current/u);

  const overrideDays = Object.fromEntries(Object.keys(shared.days).map(day => [day, []]));
  const updatedAt = '2026-08-09T13:30:00.000Z';
  const savedLabel = new Date(updatedAt).toLocaleString();
  for (const source of ['manual', 'url', 'disabled']) {
    storage.setItem('gib_m1_schedule_v1', JSON.stringify({
      days: overrideDays,
      source,
      updatedAt
    }));
    if (source === 'url') {
      storage.setItem('gib_m1_schedule_url_v1', 'https://example.test/local-schedule.json');
    } else {
      storage.removeItem('gib_m1_schedule_url_v1');
    }
    const loaded = runtime.hooks.loadSchedule();
    const status = runtime.hooks.scheduleStatusMessage(loaded);
    assert.equal(loaded.override, true, source);
    assert.equal(loaded.mode, source, source);
    assert.match(status, /^Local schedule override active/u, source);
    assert.ok(status.includes(source === 'url' ? 'URL' : source), source);
    assert.ok(status.includes('saved ' + savedLabel), source);
    assert.match(status, /Website updates are paused on this device/u, source);
    if (source === 'url') {
      assert.match(status, /from https:\/\/example\.test\/local-schedule\.json/u);
    }
  }
});

test('revert removes only schedule-override metadata before refreshing the website source', () => {
  const revert = sourceBetween(
    kiosk,
    "$('#btnClearSchedule').addEventListener('click'",
    "$('#btnDisableSchedule').addEventListener('click'"
  );
  assert.match(revert, /removeItem\(SCHEDULE_KEY\)/u);
  assert.match(revert, /removeItem\(SCHEDULE_URL_KEY\)/u);
  assert.match(revert, /removeItem\(SCHEDULE_MODE_KEY\)/u);
  assert.match(revert, /refreshCanonicalSchedule\(\)/u);
  for (const preservedKey of [
    'CANONICAL_SCHEDULE_CACHE_KEY',
    'SIGNINS_KEY',
    'LOCAL_STATE_KEY',
    'SYNC_QUEUE_KEY',
    'SYNC_AUTO_KEY',
    'DEVICE_KEY',
    'DEVICE_LABEL_KEY',
    'SERIES_KEY'
  ]) {
    assert.doesNotMatch(revert, new RegExp(`removeItem\\(${preservedKey}\\)`, 'u'));
  }
});

test('executed revert preserves every nonschedule canary and requests one website refresh', () => {
  const storage = memoryStorage({
    gib_m1_schedule_v1: '{"source":"manual","days":{}}',
    gib_m1_schedule_url_v1: 'https://example.test/local.json',
    gib_m1_schedule_mode_v1: 'manual',
    gib_m1_canonical_schedule_cache_v1: '{"version":"canary-cache"}',
    gib_m1_signins_v1: '[{"RowID":"canary-ledger"}]',
    gib_m1_local_state_v2: '{"queue":[{"RowID":"canary-waiting"}]}',
    gib_m1_sync_queue_v1: '[{"RowID":"canary-waiting"}]',
    gib_m1_sync_auto_v1: 'false',
    gib_m1_device_v1: '{"siteCode":"TEST"}',
    gib_m1_device_label_v1: 'QA tablet',
    gib_m1_duration_rules_v1: '[{"match":"Kids","duration":0.5}]',
    gib_m1_instructor_names_v1: '["QA Test Instructor"]',
    gib_m1_admin_pin_v1: 'pin-canary',
    gib_m1_series_v1: '[{"id":"series-canary"}]'
  });
  const revert = sourceBetween(
    kiosk,
    "$('#btnClearSchedule').addEventListener('click'",
    "$('#btnDisableSchedule').addEventListener('click'"
  );
  const preservedBefore = Object.fromEntries(
    [...storage.values].filter(([key]) => ![
      'gib_m1_schedule_v1',
      'gib_m1_schedule_url_v1',
      'gib_m1_schedule_mode_v1'
    ].includes(key))
  );
  let handler = null;
  let viewRefreshes = 0;
  let websiteRefreshes = 0;
  const context = browserContext({
    localStorage: storage,
    confirm: () => true,
    $: () => ({ addEventListener(_type, callback) { handler = callback; } })
  });
  new vm.Script(`
    const SCHEDULE_KEY = 'gib_m1_schedule_v1';
    const SCHEDULE_URL_KEY = 'gib_m1_schedule_url_v1';
    const SCHEDULE_MODE_KEY = 'gib_m1_schedule_mode_v1';
    let canonicalScheduleRuntime = { phase: 'override' };
    let scheduleDraftDirty = true;
    function refreshScheduleViews() { globalThis.viewRefreshes += 1; }
    function refreshCanonicalSchedule() { globalThis.websiteRefreshes += 1; }
    function showToast() {}
    ${revert}
  `, { filename: 'm1-kiosk-schedule-revert.js' }).runInContext(Object.assign(context, {
    viewRefreshes,
    websiteRefreshes
  }));
  assert.equal(typeof handler, 'function');
  handler();
  assert.equal(storage.getItem('gib_m1_schedule_v1'), null);
  assert.equal(storage.getItem('gib_m1_schedule_url_v1'), null);
  assert.equal(storage.getItem('gib_m1_schedule_mode_v1'), null);
  assert.deepEqual(Object.fromEntries(storage.values), preservedBefore);
  assert.equal(context.viewRefreshes, 1);
  assert.equal(context.websiteRefreshes, 1);
});

test('Series remains a separate chronological overlay for the rollover date key', () => {
  const classes = functionSource(kiosk, 'classesForDateKey');
  assert.match(classes, /dayNameForDateKey\(dateKey\)/u);
  assert.match(classes, /seriesClassesForDate\(dn, dateKey\)/u);
  assert.match(classes, /sortClassesChronologically\(mergeUniqueClasses\(scheduled, series\)\)/u);

  const today = functionSource(kiosk, 'classesForToday');
  assert.match(today, /classesForDateKey\(fmtDate\(date\)\)/u);
});

test('canonical class replacement flows through the day-rollover form guard', () => {
  const refresh = functionSource(kiosk, 'refreshCanonicalScheduleNow');
  const refreshViews = functionSource(kiosk, 'refreshScheduleViews');
  const pending = functionSource(kiosk, 'applyPendingScheduleViewIfSafe');
  const formGuard = functionSource(kiosk, 'kioskFormInProgress');

  assert.match(
    refresh,
    /canonicalScheduleMemory = memorySchedule;[\s\S]*refreshScheduleViews\(/u
  );
  assert.doesNotMatch(refresh, /renderClassesForDateKey|classListWrap/u);
  assert.match(refreshViews, /dayRolloverController[\s\S]*requestRefresh\(\)/u);
  assert.match(pending, /!kioskFormInProgress\(\)[\s\S]*dayRolloverController\?\.flushPending\(\)/u);
  assert.match(formGuard, /#nameInput[\s\S]*#notesInput[\s\S]*selectedClasses\(\)\.length/u);

  const fields = {
    '#nameInput': { value: 'Instructor entry in progress' },
    '#notesInput': { value: '' }
  };
  const replacements = [];
  const selected = [];
  const context = browserContext({
    $: selector => fields[selector],
    selectedClasses: () => selected,
    dayRolloverController: null,
    scheduleDraftDirty: false,
    loadSchedule: () => ({ canonical: scheduleResponse() }),
    renderScheduleStatuses() {},
    renderWeekAtGlance() {},
    loadScheduleIntoAdmin() {}
  });
  new vm.Script([
    formGuard,
    refreshViews,
    pending,
    'globalThis.hooks = { applyPendingScheduleViewIfSafe, kioskFormInProgress, refreshScheduleViews };'
  ].join('\n'), { filename: 'm1-canonical-rollover-guard.js' }).runInContext(context);

  const eventTarget = {
    addEventListener() {},
    removeEventListener() {}
  };
  context.dayRolloverController = createDayRolloverController({
    getDateKey: () => '2026-08-11',
    isFormInProgress: context.hooks.kioskFormInProgress,
    updateDisplayedDay() {},
    replaceClasses: dateKey => replacements.push(dateKey),
    schedule: () => 1,
    cancelSchedule() {},
    documentTarget: eventTarget,
    windowTarget: eventTarget
  });

  assert.equal(context.hooks.refreshScheduleViews(), false);
  assert.deepEqual(replacements, []);
  assert.equal(context.dayRolloverController.snapshot().pendingDate, '2026-08-11');

  fields['#nameInput'].value = '';
  context.hooks.applyPendingScheduleViewIfSafe();
  assert.deepEqual(replacements, ['2026-08-11']);
});

test('executed Series boundaries stay separate while merged classes sort stably', () => {
  const active = sourceBetween(kiosk, 'function seriesIsActiveForDate(', 'function seriesClassesForDate(');
  const merge = sourceBetween(kiosk, 'function mergeUniqueClasses(', 'function updateSeriesHint(');
  const ordering = sourceBetween(kiosk, 'function parseStartMinutes(', 'function renderDurationRules(');
  const context = browserContext();
  new vm.Script(`
    ${active}
    ${merge}
    ${ordering}
    globalThis.hooks = { mergeUniqueClasses, seriesIsActiveForDate, sortClassesChronologically };
  `, { filename: 'm1-kiosk-series-overlay.js' }).runInContext(context);

  const series = {
    enabled: true,
    days: ['Monday'],
    startDate: '2026-08-03',
    endDate: '2026-08-17'
  };
  assert.equal(context.hooks.seriesIsActiveForDate(series, 'Monday', '2026-08-03'), true);
  assert.equal(context.hooks.seriesIsActiveForDate(series, 'Monday', '2026-08-17'), true);
  assert.equal(context.hooks.seriesIsActiveForDate(series, 'Monday', '2026-08-18'), false);
  assert.equal(context.hooks.seriesIsActiveForDate(series, 'Tuesday', '2026-08-10'), false);
  assert.equal(context.hooks.seriesIsActiveForDate({ ...series, enabled: false }, 'Monday', '2026-08-10'), false);

  const base = ['7:00 PM BJJ', '5:30 PM BJJ', '6:30 PM Judo'];
  const overlay = ['6:00 PM TEST Series', '5:30 PM BJJ', '6:30 PM Wrestling'];
  const merged = context.hooks.mergeUniqueClasses(base, overlay);
  assert.deepEqual(
    Array.from(context.hooks.sortClassesChronologically(merged)),
    ['5:30 PM BJJ', '6:00 PM TEST Series', '6:30 PM Judo', '6:30 PM Wrestling', '7:00 PM BJJ']
  );
  assert.deepEqual(base, ['7:00 PM BJJ', '5:30 PM BJJ', '6:30 PM Judo']);
  assert.deepEqual(overlay, ['6:00 PM TEST Series', '5:30 PM BJJ', '6:30 PM Wrestling']);
});

test('both screens visibly expose canonical source, version, and fallback state', () => {
  const kioskStatus = functionSource(kiosk, 'scheduleStatusMessage');
  assert.match(kiosk, /id="kioskScheduleStatus"/u);
  assert.match(kioskStatus, /Website schedule current[\s\S]*?\$\{version\}/u);
  assert.match(kioskStatus, /Website unavailable[\s\S]*?using \$\{retainedSource\}/u);
  assert.match(kioskStatus, /'emergency schedule'/u);
  assert.match(kioskStatus, /'last good schedule'/u);
  assert.match(admin, /id="scheduleSource"/u);
  assert.match(admin, /`Version: \$\{schedule\.version\}`/u);
  assert.match(admin, /schedule\.current[\s\S]*\? 'current'[\s\S]*last validated fallback/u);
  assert.match(kiosk, /Boolean\(schedule\.canonical\?\.status\?\.storageWarning\)/u);
  assert.match(admin, /Storage: \$\{schedule\.status\.storageWarning\}/u);
  assert.match(admin, /!schedule\.current \|\| Boolean\(schedule\.status\.reason\) \|\| Boolean\(schedule\.status\.storageWarning\)/u);

  const warning = scheduleResponse(shared.days, {
    storageWarning: 'last-known-good-storage-not-updated'
  });
  const runtime = kioskOverrideRuntime(memoryStorage(), warning);
  assert.match(
    runtime.hooks.scheduleStatusMessage(runtime.hooks.loadSchedule()),
    /attention: last known good storage not updated/u
  );
});
