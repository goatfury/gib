import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  browserInstallationProfileSource,
  installationProfile,
  ownsInstallationStorageKey,
  scopedStorageKey,
  validInstallationProfile
} from '../m1/installation-profile-core.mjs';
import { appendBatchToState, blankLocalState } from '../m1/sync-core.mjs';
import {
  installationProfileForEnvironment,
  remoteBackendEnabled,
  remoteScheduleEnabled,
  staffClockEnabled
} from '../netlify/functions/_lib/m1-installation.mjs';
import { runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { productionRuntimeConfig } from '../netlify/functions/_lib/m1-production-runtime.mjs';
import { handleAdminLogin } from '../netlify/functions/m1-admin-login.mjs';
import { handleKioskSync } from '../netlify/functions/m1-kiosk-sync.mjs';
import { handleM1Schedule } from '../netlify/functions/m1-schedule.mjs';
import { handleStaffClock } from '../netlify/functions/m1-staff-clock.mjs';

const ROOT = new URL('../', import.meta.url);
const kioskHtml = readFileSync(new URL('m1/index.html', ROOT), 'utf8');
const staffClient = readFileSync(new URL('m1/staff-clock-client.mjs', ROOT), 'utf8');
const netlifyConfig = readFileSync(new URL('netlify.toml', ROOT), 'utf8');
const buildTool = readFileSync(new URL('tools/build-m1-installation-profile.mjs', ROOT), 'utf8');
const PREVIEW_ORIGIN = 'https://deploy-preview-77--gib-live.netlify.app';
const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';

const COMPLETE_ENV = Object.freeze({
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER_123456/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'test-webhook-token-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'test-admin-action-token-1234567890abcdef',
  GIB_M1_PRODUCTION_SYNC_ENABLED: 'true',
  GIB_M1_PRODUCTION_ORIGIN: PRODUCTION_ORIGIN,
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION_RECEIVER_123456/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'production-webhook-token-1234567890abcdef',
  GIB_M1_PRODUCTION_DEVICE_TOKEN: 'production-device-token-1234567890abcdef',
  GIB_M1_ADMIN_ACTION_TOKEN: 'production-admin-action-token-1234567890abcdef',
  GIB_M1_ADMIN_PASSPHRASE: 'violet harbor maple lantern',
  GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: 'production-install-secret-1234567890abcdef'
});

function sameOriginRequest(path, options = {}) {
  return new Request(`${PREVIEW_ORIGIN}${path}`, {
    method: options.method || 'GET',
    headers: {
      Origin: PREVIEW_ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

test('Rev stays the exact default while Richmond is a fixed local-only installation', () => {
  const rev = installationProfile('rev');
  const richmond = installationProfile('richmond');

  assert.deepEqual(rev, {
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'rev',
    gymName: 'Revolution BJJ',
    siteCode: 'Rev',
    deviceLabel: 'Revolution BJJ front desk',
    storagePrefix: 'gib_m1_',
    scheduleSource: { mode: 'rev-website', endpoint: '/api/m1-schedule' },
    featureFlags: { staffClock: true },
    backend: { enabled: true, transportTarget: 'rev' }
  });
  assert.deepEqual(richmond, {
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'richmond',
    gymName: 'Richmond BJJ',
    siteCode: 'Richmond',
    deviceLabel: 'Richmond TEST preview device',
    storagePrefix: 'gib_m1_richmond_',
    scheduleSource: { mode: 'test-only', endpoint: '' },
    featureFlags: { staffClock: false },
    backend: { enabled: false, transportTarget: 'none' }
  });
  assert.equal(installationProfileForEnvironment({}), rev);
  assert.equal(installationProfileForEnvironment({ GIB_M1_INSTALLATION: 'richmond' }), richmond);
  assert.equal(installationProfileForEnvironment({ GIB_M1_INSTALLATION: 'unknown' }), null);
  assert.equal(validInstallationProfile({ ...richmond, siteCode: 'Rev' }), false);
  assert.equal(remoteBackendEnabled({ GIB_M1_INSTALLATION: 'richmond' }), false);
  assert.equal(remoteScheduleEnabled({ GIB_M1_INSTALLATION: 'richmond' }), false);
  assert.equal(staffClockEnabled({ GIB_M1_INSTALLATION: 'richmond' }), false);
});

test('Richmond maps every browser key into its own namespace and ignores Rev state on reload', () => {
  const rev = installationProfile('rev');
  const richmond = installationProfile('richmond');
  const baseKeys = [
    'gib_m1_instructor_names_v1',
    'gib_m1_signins_v1',
    'gib_m1_schedule_v1',
    'gib_m1_device_v1',
    'gib_m1_admin_pin_v1',
    'gib_m1_duration_rules_v1',
    'gib_m1_series_v1',
    'gib_m1_schedule_url_v1',
    'gib_m1_schedule_mode_v1',
    'gib_m1_canonical_schedule_cache_v1',
    'gib_m1_local_state_v2',
    'gib_m1_sync_queue_v1',
    'gib_m1_sync_auto_v1',
    'gib_m1_device_label_v1',
    'gib_m1_sync_last',
    'gib_m1_sync_error'
  ];
  for (const key of baseKeys) {
    assert.equal(scopedStorageKey(rev, key), key);
    assert.equal(
      scopedStorageKey(richmond, key),
      `gib_m1_richmond_${key.slice('gib_m1_'.length)}`
    );
  }
  assert.equal(ownsInstallationStorageKey(richmond, 'gib_m1_richmond_local_state_v2'), true);
  assert.equal(ownsInstallationStorageKey(richmond, 'gib_m1_local_state_v2'), false);
  assert.equal(ownsInstallationStorageKey(richmond, 'rbjj_signins_v2'), false);
  assert.equal(ownsInstallationStorageKey(rev, 'gib_m1_richmond_local_state_v2'), false);

  const row = {
    RowID: 'gib-m1-11111111-1111-4111-8111-111111111111',
    Timestamp: '2026-08-21 12:00:00',
    Date: '2026-08-21',
    'Class Label': '9:00 AM RICHMOND TEST ONLY — QA Preview Class',
    'Duration (hr)': 1,
    Instructor: 'QA Richmond Preview',
    Site: 'Richmond',
    Notes: 'QA TEST local retention',
    __batchId: 'gib-m1-22222222-2222-4222-8222-222222222222'
  };
  const state = appendBatchToState(
    blankLocalState(),
    [{ ...row, Status: 'OK' }],
    [{ ...row, Device: richmond.deviceLabel, Build: 'RICHMOND TEST' }]
  );
  const storage = new Map([
    ['gib_m1_local_state_v2', '{"rev":"preserve"}'],
    ['gib_m1_richmond_local_state_v2', JSON.stringify(state)]
  ]);
  const reloaded = JSON.parse(storage.get(scopedStorageKey(richmond, 'gib_m1_local_state_v2')));
  assert.equal(reloaded.ledger[0].Site, 'Richmond');
  assert.equal(reloaded.queue.length, 1);
  assert.equal(storage.get('gib_m1_local_state_v2'), '{"rev":"preserve"}');
});

test('the generated browser profile is frozen and cannot be selected by URL or storage', () => {
  const richmond = installationProfile('richmond');
  const context = vm.createContext({
    document: { documentElement: { dataset: {} } }
  });
  vm.runInContext(browserInstallationProfileSource(richmond), context);
  assert.equal(
    JSON.stringify(context.M1_INSTALLATION_PROFILE),
    JSON.stringify(richmond)
  );
  assert.equal(Object.isFrozen(context.M1_INSTALLATION_PROFILE), true);
  assert.equal(Object.isFrozen(context.M1_INSTALLATION_PROFILE.backend), true);
  assert.equal(context.document.documentElement.dataset.m1Installation, 'richmond');
  assert.equal(context.document.documentElement.dataset.m1StaffClock, 'false');
  assert.equal(Object.getOwnPropertyDescriptor(context, 'M1_INSTALLATION_PROFILE').writable, false);

  const profileGate = kioskHtml.slice(
    kioskHtml.indexOf('const INSTALLATION ='),
    kioskHtml.indexOf('// Update the build stamp')
  );
  assert.doesNotMatch(profileGate, /URLSearchParams|location\.(?:search|hash)|localStorage/u);
  assert.match(profileGate, /JSON\.stringify\(INSTALLATION\) !== JSON\.stringify\(expectedInstallation\)/u);
  assert.match(buildTool, /process\.env\.GIB_M1_INSTALLATION \|\| 'rev'/u);
  assert.match(netlifyConfig, /\[context\."agent\/m1-richmond-installation-preview"\.environment\][\s\S]*GIB_M1_INSTALLATION = "richmond"/u);
  assert.match(netlifyConfig, /command = "npm run build"/u);
});

test('Richmond client is fixed to Site Richmond, TEST schedule, local review, and no automatic transport', () => {
  assert.match(kioskHtml, /function getSiteCode\(\) \{\s*if \(IS_RICHMOND\) return INSTALLATION\.siteCode;/u);
  assert.match(kioskHtml, /RICHMOND TEST ONLY — QA Preview Class/u);
  assert.match(kioskHtml, /function startCanonicalScheduleRefresh\(\) \{\s*if \(IS_RICHMOND\)/u);
  assert.match(kioskHtml, /if \(BACKEND_ENABLED && localStorage\.getItem\(SYNC_AUTO_KEY\) === 'true'\)/u);
  assert.match(kioskHtml, /if \(!BACKEND_ENABLED\) \{[\s\S]*Local only — rows kept/u);
  assert.match(kioskHtml, /function addRichmondForgottenSignin\(\)[\s\S]*'Site': INSTALLATION\.siteCode[\s\S]*appendBatchToState/u);
  assert.match(kioskHtml, /Forgotten Sign-In \/ Daily Review · local preview/u);
  assert.match(staffClient, /installationProfile\.installationId === 'rev'[\s\S]*featureFlags\?\.staffClock === true[\s\S]*initializeStaffClockClient\(\)/u);
  assert.match(kioskHtml, /html:not\(\[data-m1-staff-clock="true"\]\) #staffClock/u);
});

test('Richmond disables TEST and production runtime configuration even when Rev secrets exist', () => {
  const env = { ...COMPLETE_ENV, GIB_M1_INSTALLATION: 'richmond' };
  assert.equal(runtimeConfig(env, { requestUrl: `${PREVIEW_ORIGIN}/api/m1-kiosk-sync` }), null);
  assert.equal(productionRuntimeConfig(env), null);
});

test('Richmond server routes fail closed before TEST, production, Staff Clock, schedule, or Admin transport', async () => {
  const env = { ...COMPLETE_ENV, GIB_M1_INSTALLATION: 'richmond' };
  let fetchCalls = 0;
  let storeCalls = 0;
  const fetch = async () => {
    fetchCalls += 1;
    throw new Error('transport must not be called');
  };

  const kiosk = await handleKioskSync(
    sameOriginRequest('/api/m1-kiosk-sync', {
      method: 'POST',
      body: { rows: [{ forged: 'Rev' }] }
    }),
    { env, fetch }
  );
  assert.equal(kiosk.status, 503);
  assert.match((await kiosk.json()).message, /no configured backend transport/iu);

  const staff = await handleStaffClock(
    sameOriginRequest('/api/m1-staff-clock', { method: 'POST' }),
    { env, fetch }
  );
  assert.equal(staff.status, 404);
  assert.match((await staff.json()).message, /disabled/iu);

  const schedule = await handleM1Schedule(
    sameOriginRequest('/api/m1-schedule'),
    {
      env,
      deployContext: 'deploy-preview',
      published: false,
      fetchImpl: fetch,
      store: {
        async get() { storeCalls += 1; },
        async set() { storeCalls += 1; }
      }
    }
  );
  assert.equal(schedule.status, 503);
  assert.match((await schedule.json()).message, /deployment-local TEST schedule/iu);

  const admin = await handleAdminLogin(
    sameOriginRequest('/.netlify/functions/m1-admin-login', {
      method: 'POST',
      body: { adminName: 'Andrew Smith', passphrase: '', testShortcut: true }
    }),
    { env }
  );
  assert.equal(admin.status, 503);
  assert.equal(admin.headers.get('set-cookie'), null);
  assert.equal(fetchCalls, 0);
  assert.equal(storeCalls, 0);
});
