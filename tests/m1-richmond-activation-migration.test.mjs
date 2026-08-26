import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { installationProfile } from '../m1/installation-profile-core.mjs';
import {
  createRichmondProductionDeviceCredential,
  richmondProductionDeviceCookieHeader
} from '../netlify/functions/_lib/m1-richmond-production-runtime.mjs';
import {
  TABLET_STATUS_PATH,
  handleTabletStatus
} from '../netlify/functions/m1-tablet-status.mjs';

const ROOT = new URL('../', import.meta.url);
const kioskHtml = readFileSync(new URL('m1/index.html', ROOT), 'utf8');
const ORIGIN = 'https://gib-richmond-live.netlify.app';
const REV_ORIGIN = 'https://gib-live.netlify.app';
const AUTO_SYNC_KEY = 'gib_m1_richmond_production_sync_auto_v1';
const MARKER_KEY = 'gib_m1_richmond_production_activation_auto_sync_migration_v1';
const MARKER_VALUE = 'richmond-production-auto-sync-v1';
const ROW_ID = 'gib-m1-12345678-1234-4123-8123-123456789abc';
const NOW_MS = Date.parse('2026-08-26T14:30:00Z');

const ACTIVE_ENV = Object.freeze({
  GIB_M1_INSTALLATION: 'richmond',
  GIB_M1_ENVIRONMENT: 'production',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL:
    'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_PRODUCTION_RECEIVER_123456/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN:
    'richmond-production-webhook-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN:
    'richmond-production-admin-action-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'cedar orbit copper meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN:
    'richmond-production-device-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active',
  GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true'
});

function namedFunctionSource(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = source.indexOf(')', start);
  const brace = source.indexOf('{', signatureEnd);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

const migrationSource = namedFunctionSource(kioskHtml, 'applyRichmondActivationMigration');
const applyMigration = Function(`"use strict"; return (${migrationSource});`)();

function signInState() {
  const shared = {
    RowID: ROW_ID,
    Timestamp: '2026-08-26 06:59:00',
    Date: '2026-08-26',
    'Class Label': '6:00 AM–7:00 AM Muay Thai Fundamentals',
    'Duration (hr)': 1,
    Instructor: 'Andrew Smith',
    Site: 'Richmond',
    Notes: 'Install check only',
    __batchId: 'gib-m1-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  };
  const ledgerRow = { ...shared, Status: 'OK' };
  const queuedRow = {
    ...shared,
    Device: 'Richmond Front Desk Tablet',
    Build: '2026-08-22 RICHMOND M1 PRODUCTION'
  };
  return { ledgerRow, queuedRow };
}

function initialStorage() {
  const { ledgerRow, queuedRow } = signInState();
  return {
    gib_m1_local_state_v2: '{"rev":"preserved"}',
    gib_m1_sync_queue_v1: '[{"rev":"queue"}]',
    gib_m1_sync_auto_v1: 'false',
    gib_m1_richmond_production_local_state_v2: JSON.stringify({
      version: 2,
      ledger: [ledgerRow],
      queue: [queuedRow]
    }),
    gib_m1_richmond_production_signins_v1: JSON.stringify([ledgerRow]),
    gib_m1_richmond_production_sync_queue_v1: JSON.stringify([queuedRow]),
    [AUTO_SYNC_KEY]: 'false',
    gib_m1_richmond_production_instructor_names_v1: '["Andrew Smith"]',
    gib_m1_richmond_production_device_v1:
      '{"gymName":"Richmond BJJ","location":"Front Desk Tablet","siteCode":"Richmond"}'
  };
}

function storageHarness(initial = initialStorage(), options = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  const removals = [];
  return {
    values,
    writes,
    removals,
    storage: {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        const text = String(value);
        writes.push([key, text]);
        if (options.failMarker && key === MARKER_KEY) throw new Error('marker unavailable');
        values.set(key, text);
      },
      removeItem(key) {
        removals.push(key);
        values.delete(key);
      }
    },
    snapshot() {
      return Object.fromEntries(values);
    }
  };
}

function activeStatus(overrides = {}) {
  return {
    authorized: true,
    writesEnabled: true,
    activation: 'active',
    ...overrides
  };
}

function migrationOptions(harness, overrides = {}) {
  let syncCalls = 0;
  let statusCalls = 0;
  let syncSnapshot = null;
  const options = {
    origin: ORIGIN,
    profile: installationProfile('richmond', 'production', 'active'),
    storage: harness.storage,
    autoSyncKey: AUTO_SYNC_KEY,
    markerKey: MARKER_KEY,
    statusRequest: async () => {
      statusCalls += 1;
      assert.deepEqual(harness.writes, [], 'storage changed before tablet authorization');
      return new Response(JSON.stringify(activeStatus()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    readQueue: () => {
      return JSON.parse(harness.storage.getItem(
        'gib_m1_richmond_production_local_state_v2'
      )).queue;
    },
    triggerSync: async () => {
      syncCalls += 1;
      syncSnapshot = harness.snapshot();
    },
    refreshSettings() {},
    refreshStatus() {},
    ...overrides
  };
  return {
    options,
    get syncCalls() { return syncCalls; },
    get statusCalls() { return statusCalls; },
    get syncSnapshot() { return syncSnapshot; }
  };
}

function richmondRequest(cookie = '') {
  return new Request(`${ORIGIN}${TABLET_STATUS_PATH}`, {
    method: 'POST',
    headers: {
      Host: 'gib-richmond-live.netlify.app',
      Origin: ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: '{}'
  });
}

function deviceCookie() {
  const credential = createRichmondProductionDeviceCredential(
    ACTIVE_ENV.GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN,
    () => Buffer.alloc(32, 0x41),
    NOW_MS
  );
  return richmondProductionDeviceCookieHeader(credential).split(';', 1)[0];
}

function ledgerStatus(overrides = {}) {
  return {
    ok: true,
    target: 'production',
    installation: 'richmond',
    environment: 'production',
    empty: true,
    signinsRows: 0,
    auditRows: 0,
    writesEnabled: true,
    ...overrides
  };
}

test('authorized active Richmond confirms both gates through read-only ledgerStatus', async () => {
  const upstream = [];
  const response = await handleTabletStatus(richmondRequest(deviceCookie()), {
    installationId: 'richmond',
    environment: 'production',
    activation: 'active',
    env: ACTIVE_ENV,
    now: NOW_MS,
    fetch: async (url, init) => {
      upstream.push({ url, init });
      return new Response(JSON.stringify(ledgerStatus()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), activeStatus());
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].url, ACTIVE_ENV.GIB_RICHMOND_PRODUCTION_WEBHOOK_URL);
  const body = JSON.parse(upstream[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), [
    'action',
    'adminActionToken',
    'environment',
    'installation',
    'target',
    'token'
  ]);
  assert.equal(body.action, 'ledgerStatus');
  assert.equal(body.installation, 'richmond');
  assert.equal(body.environment, 'production');
  assert.equal(body.target, 'production');
  assert.equal(Object.hasOwn(body, 'rows'), false);
});

test('Richmond tablet status fails closed when the Apps Script write gate is not exact', async t => {
  const variants = [
    ['off', ledgerStatus({ writesEnabled: false })],
    ['count mismatch', ledgerStatus({ empty: true, signinsRows: 1 })],
    ['wrong installation', ledgerStatus({ installation: 'rev' })],
    ['extra field', { ...ledgerStatus(), extra: true }],
    ['rejected', { ok: false, result: 'rejected' }]
  ];
  for (const [name, value] of variants) {
    await t.test(name, async () => {
      const response = await handleTabletStatus(richmondRequest(deviceCookie()), {
        installationId: 'richmond',
        environment: 'production',
        activation: 'active',
        env: ACTIVE_ENV,
        now: NOW_MS,
        fetch: async () => new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        authorized: true,
        writesEnabled: false,
        activation: 'pending'
      });
    });
  }
});

test('unauthorized active Richmond never calls Apps Script', async () => {
  let upstreamCalls = 0;
  const response = await handleTabletStatus(richmondRequest(), {
    installationId: 'richmond',
    environment: 'production',
    activation: 'active',
    env: ACTIVE_ENV,
    now: NOW_MS,
    fetch: async () => {
      upstreamCalls += 1;
      throw new Error('unauthorized status must not reach Apps Script');
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), activeStatus({ authorized: false }));
  assert.equal(upstreamCalls, 0);
});

test('authorized active Richmond fails closed when Apps Script is unreachable', async () => {
  const response = await handleTabletStatus(richmondRequest(deviceCookie()), {
    installationId: 'richmond',
    environment: 'production',
    activation: 'active',
    env: ACTIVE_ENV,
    now: NOW_MS,
    fetch: async () => { throw new Error('offline'); }
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    authorized: true,
    writesEnabled: false,
    activation: 'pending'
  });
});

test('one-time migration preserves the Richmond row and every non-setting storage byte', async () => {
  const initial = initialStorage();
  const harness = storageHarness(initial);
  const run = migrationOptions(harness);
  assert.equal(await applyMigration(run.options), true);

  assert.equal(run.statusCalls, 1);
  assert.equal(run.syncCalls, 1);
  assert.ok(run.syncSnapshot);
  assert.equal(run.syncSnapshot[AUTO_SYNC_KEY], 'true');
  assert.equal(run.syncSnapshot[MARKER_KEY], MARKER_VALUE);
  for (const [key, value] of Object.entries(initial)) {
    if (key === AUTO_SYNC_KEY) continue;
    assert.equal(run.syncSnapshot[key], value, `${key} changed before sync`);
  }
  const beforeState = JSON.parse(initial.gib_m1_richmond_production_local_state_v2);
  const duringState = JSON.parse(
    run.syncSnapshot.gib_m1_richmond_production_local_state_v2
  );
  assert.deepEqual(duringState, beforeState);
  assert.equal(duringState.ledger[0].RowID, ROW_ID);
  assert.equal(duringState.queue[0].RowID, ROW_ID);
  assert.deepEqual(harness.writes, [
    [AUTO_SYNC_KEY, 'true'],
    [MARKER_KEY, MARKER_VALUE]
  ]);
  assert.deepEqual(harness.removals, []);
});

test('versioned marker preserves a later manual auto-sync OFF choice', async () => {
  const initial = {
    ...initialStorage(),
    [AUTO_SYNC_KEY]: 'false',
    [MARKER_KEY]: MARKER_VALUE
  };
  const harness = storageHarness(initial);
  const run = migrationOptions(harness, {
    statusRequest: async () => {
      throw new Error('marker-present migration must not call status');
    },
    triggerSync: async () => {
      throw new Error('marker-present migration must not sync');
    }
  });
  assert.equal(await applyMigration(run.options), false);
  assert.deepEqual(harness.snapshot(), initial);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.removals, []);
});

test('migration fails closed for other origins, profiles, and tablet-status results', async t => {
  const active = installationProfile('richmond', 'production', 'active');
  const cases = [
    ['lookalike origin', { origin: 'https://6a8ef6b20bba220fe005ae06--gib-richmond-live.netlify.app' }],
    ['Revolution', { origin: REV_ORIGIN, profile: installationProfile('rev') }],
    ['Richmond TEST', { origin: 'https://gib-richmond-test.netlify.app', profile: installationProfile('richmond', 'test') }],
    ['pending Richmond', { profile: installationProfile('richmond', 'production', 'pending') }],
    ['profile write off', { profile: { ...active, writesEnabled: false } }],
    ['unauthorized tablet', {
      statusRequest: async () => new Response(JSON.stringify(activeStatus({ authorized: false })), { status: 200 })
    }],
    ['runtime gate off', {
      statusRequest: async () => new Response(JSON.stringify({
        authorized: true,
        writesEnabled: false,
        activation: 'pending'
      }), { status: 200 })
    }],
    ['status unavailable', {
      statusRequest: async () => new Response('{}', { status: 503 })
    }],
    ['status has extra field', {
      statusRequest: async () => new Response(JSON.stringify({
        ...activeStatus(),
        extra: true
      }), { status: 200 })
    }]
  ];

  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const initial = initialStorage();
      const harness = storageHarness(initial);
      let syncCalls = 0;
      const run = migrationOptions(harness, {
        ...override,
        triggerSync: async () => { syncCalls += 1; }
      });
      assert.equal(await applyMigration(run.options), false);
      assert.equal(syncCalls, 0);
      assert.deepEqual(harness.snapshot(), initial);
      assert.deepEqual(harness.writes, []);
      assert.deepEqual(harness.removals, []);
    });
  }
});

test('partial marker storage failure restores the previous auto-sync choice and never syncs', async () => {
  const initial = initialStorage();
  const harness = storageHarness(initial, { failMarker: true });
  let syncCalls = 0;
  const run = migrationOptions(harness, {
    triggerSync: async () => { syncCalls += 1; }
  });
  assert.equal(await applyMigration(run.options), false);
  assert.equal(syncCalls, 0);
  assert.deepEqual(harness.snapshot(), initial);
  assert.equal(harness.snapshot()[MARKER_KEY], undefined);
});

test('shipped migration and production sync stay Richmond-only and Staff Clock remains off', () => {
  assert.match(migrationSource, /https:\/\/gib-richmond-live\.netlify\.app/u);
  assert.match(migrationSource, /authorized !== true/u);
  assert.match(migrationSource, /writesEnabled !== true/u);
  assert.match(migrationSource, /activation !== 'active'/u);
  assert.match(migrationSource, /richmond-production-auto-sync-v1/u);
  assert.doesNotMatch(migrationSource, /staff_clock|punch|gib_m1_sync_queue_v1/u);
  assert.match(kioskHtml, /fetch\('\/api\/m1-tablet-status',[\s\S]*credentials: 'same-origin'/u);
  assert.match(
    kioskHtml,
    /const IS_REVOLUTION_PRODUCTION_ORIGIN = !IS_RICHMOND[\s\S]*INSTALLATION\.installationId === 'rev'[\s\S]*IS_PRODUCTION_ORIGIN;/u
  );
  assert.match(
    kioskHtml,
    /const IS_PRODUCTION_SYNC_ORIGIN = IS_REVOLUTION_PRODUCTION_ORIGIN\s*\|\| IS_RICHMOND_PRODUCTION_ORIGIN;/u
  );
  assert.equal(
    [...kioskHtml.matchAll(/productionOrigin: IS_PRODUCTION_SYNC_ORIGIN/gu)].length,
    3
  );
  assert.match(
    kioskHtml,
    /if \(IS_RICHMOND && !IS_RICHMOND_PRODUCTION && localStorage\.getItem\(SYNC_AUTO_KEY\) === null\)/u
  );
  assert.equal(installationProfile('richmond', 'production', 'active').featureFlags.staffClock, false);
  assert.equal(installationProfile('rev').storagePrefix, 'gib_m1_');
});
