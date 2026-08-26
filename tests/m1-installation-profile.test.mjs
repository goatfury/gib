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
  deploymentInstallationProfile,
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
const serverProfile = readFileSync(
  new URL('netlify/functions/_lib/m1-installation.generated.mjs', ROOT),
  'utf8'
);
const PREVIEW_ORIGIN = 'https://deploy-preview-77--gib-live.netlify.app';
const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';
const RICHMOND_ORIGIN = 'https://gib-richmond-test.netlify.app';

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

const RICHMOND_ENV = Object.freeze({
  ...COMPLETE_ENV,
  GIB_M1_INSTALLATION: 'richmond',
  GIB_M1_ENVIRONMENT: 'test',
  GIB_RICHMOND_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_RECEIVER_123456/exec',
  GIB_RICHMOND_TEST_WEBHOOK_TOKEN: 'richmond-webhook-token-1234567890abcdef',
  GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN: 'richmond-admin-token-1234567890abcdef'
});

function sameOriginRequest(path, options = {}) {
  const origin = options.origin || PREVIEW_ORIGIN;
  return new Request(`${origin}${path}`, {
    method: options.method || 'GET',
    headers: {
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

test('Rev stays the exact default while Richmond is a fixed isolated TEST installation', () => {
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
    deviceLabel: 'Richmond TEST Browser',
    storagePrefix: 'gib_m1_richmond_',
    environment: 'test',
    allowedOrigin: RICHMOND_ORIGIN,
    scheduleSource: { mode: 'richmond-website', endpoint: '/api/m1-schedule' },
    featureFlags: { staffClock: false },
    backend: { enabled: true, transportTarget: 'richmond-test' }
  });
  assert.equal(deploymentInstallationProfile(), rev);
  assert.equal(deploymentInstallationProfile('richmond'), richmond);
  assert.equal(validInstallationProfile({ ...richmond, siteCode: 'Rev' }), false);
  assert.equal(remoteBackendEnabled('richmond'), true);
  assert.equal(remoteScheduleEnabled('richmond'), true);
  assert.equal(staffClockEnabled('richmond'), false);
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
  assert.match(buildTool, /m1-installation\.generated\.mjs/u);
  assert.match(serverProfile, /DEPLOYMENT_INSTALLATION_ID = ["']rev["']/u);
  assert.match(netlifyConfig, /\[context\."agent\/m1-richmond-installation-preview"\.environment\][\s\S]*GIB_M1_INSTALLATION = "richmond"/u);
  assert.match(netlifyConfig, /command = "npm run build"/u);
});

test('Richmond client is fixed to its site, official schedule, remote Daily Review, and TEST transport', () => {
  assert.match(kioskHtml, /function getSiteCode\(\) \{\s*if \(IS_RICHMOND\) return INSTALLATION\.siteCode;/u);
  assert.match(kioskHtml, /https:\/\/www\.richmondbjj\.com\/schedule/u);
  assert.match(kioskHtml, /11:15 AM–1:00 PM Brazilian Jiu-Jitsu Fundamentals/u);
  assert.match(kioskHtml, /html\[data-m1-installation="richmond"\] body\.kiosk-mode header #hdrGym/u);
  assert.match(kioskHtml, /Richmond BJJ'\} · TEST Preview/u);
  assert.doesNotMatch(kioskHtml, /RICHMOND TEST ONLY — QA Preview Class/u);
  assert.doesNotMatch(kioskHtml, /phase: 'disabled'/u);
  assert.match(kioskHtml, /if \(BACKEND_ENABLED && localStorage\.getItem\(SYNC_AUTO_KEY\) === 'true'\)/u);
  assert.match(kioskHtml, /if \(IS_RICHMOND && !IS_RICHMOND_PRODUCTION && localStorage\.getItem\(SYNC_AUTO_KEY\) === null\)[\s\S]*localStorage\.setItem\(SYNC_AUTO_KEY, 'true'\)/u);
  assert.match(kioskHtml, /window\.addEventListener\('online',[\s\S]*loadSyncQueue\(\)\.length[\s\S]*syncNow\(\)/u);
  assert.match(kioskHtml, /navigator\.onLine !== false[\s\S]*window\.setTimeout\(syncNow, 0\)/u);
  assert.match(kioskHtml, /\$\('#dailyReviewLink'\)\.href = '\/m1\/admin\/'/u);
  assert.match(kioskHtml, /Rows sync only to the dedicated Richmond TEST Sheet/u);
  assert.match(staffClient, /installationProfile\.installationId === 'rev'[\s\S]*featureFlags\?\.staffClock === true[\s\S]*initializeStaffClockClient\(\)/u);
  assert.match(kioskHtml, /html:not\(\[data-m1-staff-clock="true"\]\) #staffClock/u);
});

test('Richmond runtime accepts only its dedicated TEST origin and credentials', () => {
  assert.equal(runtimeConfig({ ...COMPLETE_ENV, GIB_M1_INSTALLATION: 'richmond' }, {
    requestUrl: `${RICHMOND_ORIGIN}/api/m1-kiosk-sync`,
    installationId: 'richmond'
  }), null);
  const config = runtimeConfig(RICHMOND_ENV, {
    requestUrl: `${RICHMOND_ORIGIN}/api/m1-kiosk-sync`,
    installationId: 'richmond'
  });
  assert.equal(config.target, 'test');
  assert.equal(config.installationId, 'richmond');
  assert.equal(config.environment, 'test');
  assert.equal(runtimeConfig(RICHMOND_ENV, {
    requestUrl: `${PREVIEW_ORIGIN}/api/m1-kiosk-sync`,
    installationId: 'richmond'
  }), null);
  assert.equal(productionRuntimeConfig(RICHMOND_ENV, { installationId: 'richmond' }), null);
});

test('Richmond server routes use only Richmond TEST transport while Staff Clock stays disabled', async () => {
  const env = RICHMOND_ENV;
  let fetchCalls = 0;
  let forwarded = null;
  const fetch = async (_url, options) => {
    fetchCalls += 1;
    forwarded = JSON.parse(options.body);
    return new Response(JSON.stringify({
      ok: true,
      target: 'test',
      results: [{
        rowId: 'gib-m1-11111111-1111-4111-8111-111111111111',
        result: 'added',
        linkedRecordId: 'gib-m1-11111111-1111-4111-8111-111111111111'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const kiosk = await handleKioskSync(
    sameOriginRequest('/api/m1-kiosk-sync', {
      origin: RICHMOND_ORIGIN,
      method: 'POST',
      body: { rows: [{
        RowID: 'gib-m1-11111111-1111-4111-8111-111111111111',
        Timestamp: '2026-08-21 12:00:00',
        Date: '2026-08-21',
        'Class Label': '6:00 AM–7:00 AM Muay Thai Fundamentals',
        'Duration (hr)': 1,
        Instructor: 'Richmond QA Test',
        Site: 'Richmond',
        Device: 'Richmond TEST Browser',
        Build: 'RICHMOND TEST',
        Notes: 'QA TEST'
      }] }
    }),
    { env, fetch, installationId: 'richmond', dateNow: new Date('2026-08-21T16:00:00Z') }
  );
  assert.equal(kiosk.status, 200);
  assert.equal((await kiosk.json()).results[0].result, 'added');
  assert.equal(forwarded.installation, 'richmond');
  assert.equal(forwarded.environment, 'test');
  assert.equal(forwarded.rows[0].Site, 'Richmond');

  const staff = await handleStaffClock(
    sameOriginRequest('/api/m1-staff-clock', { origin: RICHMOND_ORIGIN, method: 'POST' }),
    { env, fetch, installationId: 'richmond' }
  );
  assert.equal(staff.status, 404);
  assert.match((await staff.json()).message, /disabled/iu);

  const admin = await handleAdminLogin(
    sameOriginRequest('/.netlify/functions/m1-admin-login', {
      origin: RICHMOND_ORIGIN,
      method: 'POST',
      body: { adminName: 'Andrew Smith', passphrase: '', testShortcut: true }
    }),
    { env, installationId: 'richmond' }
  );
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get('set-cookie'), /gib_m1_admin_session=/u);
  assert.equal(fetchCalls, 1);
});
