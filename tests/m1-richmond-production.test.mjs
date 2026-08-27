import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  installationProfile,
  ownsInstallationStorageKey,
  scopedStorageKey
} from '../m1/installation-profile-core.mjs';
import {
  obviousRichmondProductionTestValue,
  obviousTestValue,
  readAdminSession,
  runtimeConfig
} from '../netlify/functions/_lib/m1-common.mjs';
import {
  PRODUCTION_DEVICE_COOKIE,
  productionRuntimeConfig
} from '../netlify/functions/_lib/m1-production-runtime.mjs';
import {
  RICHMOND_PRODUCTION_DEVICE_COOKIE,
  createRichmondProductionDeviceCredential,
  richmondProductionDeviceCookieHeader
} from '../netlify/functions/_lib/m1-richmond-production-runtime.mjs';
import {
  RICHMOND_LAST_KNOWN_GOOD_KEY,
  RICHMOND_LAST_KNOWN_GOOD_STORE,
  RICHMOND_PRODUCTION_LAST_KNOWN_GOOD_KEY,
  RICHMOND_PRODUCTION_LAST_KNOWN_GOOD_STORE
} from '../netlify/functions/_lib/m1-richmond-schedule.mjs';
import { handleAdminAdd } from '../netlify/functions/m1-admin-add.mjs';
import { handleAdminLogin } from '../netlify/functions/m1-admin-login.mjs';
import { handleAdminTabletAuthorize } from '../netlify/functions/m1-admin-tablet-authorize.mjs';
import { handleKioskSync } from '../netlify/functions/m1-kiosk-sync.mjs';
import { handleProductionStatus } from '../netlify/functions/m1-production-status.mjs';
import { handleTabletInstall } from '../netlify/functions/m1-tablet-install.mjs';
import { handleTabletStatus } from '../netlify/functions/m1-tablet-status.mjs';

const ROOT = new URL('../', import.meta.url);
const kioskHtml = readFileSync(new URL('m1/index.html', ROOT), 'utf8');
const adminHtml = readFileSync(new URL('m1/admin/index.html', ROOT), 'utf8');
const serviceWorker = readFileSync(new URL('m1/service-worker.js', ROOT), 'utf8');
const buildTool = readFileSync(new URL('tools/build-m1-installation-profile.mjs', ROOT), 'utf8');
const productionStatusSource = readFileSync(new URL('netlify/functions/m1-production-status.mjs', ROOT), 'utf8');

const ORIGIN = 'https://gib-richmond-live.netlify.app';
const TEST_ORIGIN = 'https://gib-richmond-test.netlify.app';

const BASE_ENV = Object.freeze({
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_REV_TEST_RECEIVER_123456/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'rev-test-webhook-token-1234567890abcdef',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'rev-test-admin-action-token-1234567890abcdef',
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_REV_PRODUCTION_RECEIVER_123456/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'rev-production-webhook-token-1234567890abcdef',
  GIB_M1_ADMIN_ACTION_TOKEN: 'rev-production-admin-action-token-1234567890abcdef',
  GIB_M1_ADMIN_PASSPHRASE: 'violet harbor maple lantern',
  GIB_M1_PRODUCTION_DEVICE_TOKEN: 'rev-production-device-token-1234567890abcdef',
  GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: 'rev-production-install-secret-1234567890abcdef',
  GIB_RICHMOND_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_TEST_RECEIVER_123456/exec',
  GIB_RICHMOND_TEST_WEBHOOK_TOKEN: 'richmond-test-webhook-token-1234567890abcdef',
  GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN: 'richmond-test-admin-action-token-1234567890abcdef'
});

const PENDING_ENV = Object.freeze({
  ...BASE_ENV,
  GIB_M1_INSTALLATION: 'richmond',
  GIB_M1_ENVIRONMENT: 'production',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_PRODUCTION_RECEIVER_123456/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'richmond-production-webhook-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'richmond-production-admin-action-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'cedar orbit copper meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'richmond-production-device-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_INSTALL_CAPABILITY_SECRET: 'richmond-production-install-secret-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'pending',
  GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'false'
});

const ACTIVE_ENV = Object.freeze({
  ...PENDING_ENV,
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active',
  GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true'
});

function request(path, options = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: options.method || 'POST',
    headers: {
      Host: 'gib-richmond-live.netlify.app',
      Origin: ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

function row() {
  return {
    RowID: 'gib-m1-11111111-1111-4111-8111-111111111111',
    Timestamp: '2026-08-21 12:00:00',
    Date: '2026-08-21',
    'Class Label': '6:00 AM–7:00 AM Muay Thai Fundamentals',
    'Duration (hr)': 1,
    Instructor: 'Richmond Instructor',
    Site: 'Richmond',
    Device: 'Richmond Front Desk Tablet',
    Build: 'richmond-production-unit',
    Notes: ''
  };
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  installationId: 'richmond',
  environment: 'production'
});

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = source.indexOf('{', start);
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

function readUiCopy(source, functionName, enabled) {
  const functionSource = namedFunctionSource(source, functionName);
  return Function(`"use strict"; return (${functionSource})(${JSON.stringify(enabled)});`)();
}

test('Richmond production profile is fixed, pending, and storage-isolated from TEST and Rev', () => {
  const rev = installationProfile('rev');
  const richmondTest = installationProfile('richmond', 'test');
  const production = installationProfile('richmond', 'production', 'pending');
  assert.deepEqual(production, {
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'richmond',
    gymName: 'Richmond BJJ',
    siteCode: 'Richmond',
    deviceLabel: 'Richmond Front Desk Tablet',
    storagePrefix: 'gib_m1_richmond_production_',
    environment: 'production',
    allowedOrigin: ORIGIN,
    activation: 'pending',
    writesEnabled: false,
    scheduleSource: { mode: 'richmond-website', endpoint: '/api/m1-schedule' },
    featureFlags: { staffClock: false },
    backend: { enabled: true, transportTarget: 'richmond-production' }
  });
  const key = 'gib_m1_sync_queue_v1';
  assert.equal(scopedStorageKey(rev, key), key);
  assert.equal(scopedStorageKey(richmondTest, key), 'gib_m1_richmond_sync_queue_v1');
  assert.equal(
    scopedStorageKey(production, key),
    'gib_m1_richmond_production_sync_queue_v1'
  );
  assert.equal(ownsInstallationStorageKey(production, 'gib_m1_richmond_sync_queue_v1'), false);
  assert.equal(ownsInstallationStorageKey(richmondTest, 'gib_m1_richmond_production_sync_queue_v1'), false);
  assert.equal(ownsInstallationStorageKey(rev, 'gib_m1_richmond_production_sync_queue_v1'), false);
});

test('Netlify Richmond production rejects delimited fake-name markers without rejecting embedded letters', async () => {
  const rejectedNames = [
    'QA_Test',
    'Fake_Student',
    'QA1',
    'qA',
    'Demo Instructor',
    'Student-tEsT',
    'Coach.dEmO',
    '9fAkE'
  ];
  const acceptedNames = [
    'Qadir Smith',
    'Stefano Testa',
    'Mina Faker',
    'Demos Brown',
    'Nina Contesta',
    'Testé Martin'
  ];

  rejectedNames.forEach(name => assert.equal(obviousRichmondProductionTestValue(name), true, name));
  acceptedNames.forEach(name => assert.equal(obviousRichmondProductionTestValue(name), false, name));
  ['QA_Test', 'Fake_Student', 'QA1'].forEach(name => assert.equal(
    obviousTestValue(name),
    false,
    `TEST behavior changed for ${name}`
  ));

  const now = Date.parse('2026-08-21T16:00:00Z');
  const credential = createRichmondProductionDeviceCredential(
    ACTIVE_ENV.GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN,
    () => Buffer.alloc(32, 7),
    now
  );
  const cookie = richmondProductionDeviceCookieHeader(credential).split(';')[0];
  let fetchCalls = 0;

  for (const instructor of ['QA_Test', 'Fake_Student', 'QA1']) {
    const response = await handleKioskSync(request('/api/m1-kiosk-sync', {
      body: { rows: [{ ...row(), Instructor: instructor }] },
      cookie
    }), {
      ...PRODUCTION_DEPENDENCIES,
      activation: 'active',
      env: ACTIVE_ENV,
      now,
      dateNow: new Date(now),
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('rejected names must not reach Apps Script');
      }
    });
    assert.equal(response.status, 200, instructor);
    const result = await response.json();
    assert.equal(result.results[0].result, 'rejected', instructor);
  }
  assert.equal(fetchCalls, 0);
});

test('production and TEST origins and credentials cannot cross-authorize', () => {
  const pending = runtimeConfig(PENDING_ENV, {
    requestUrl: `${ORIGIN}/api/m1-kiosk-sync`,
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending'
  });
  assert.equal(pending.environment, 'production');
  assert.equal(pending.target, 'production');
  assert.equal(pending.writesEnabled, false);
  assert.equal(runtimeConfig(PENDING_ENV, {
    requestUrl: `${TEST_ORIGIN}/api/m1-kiosk-sync`,
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending'
  }), null);
  assert.equal(runtimeConfig({
    ...PENDING_ENV,
    GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: PENDING_ENV.GIB_RICHMOND_TEST_WEBHOOK_TOKEN
  }, {
    requestUrl: `${ORIGIN}/api/m1-kiosk-sync`,
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending'
  }), null);
  assert.equal(productionRuntimeConfig(PENDING_ENV, { installationId: 'richmond' }), null);
});

test('Netlify blocks Richmond production writes before Google while activation is pending', async () => {
  let fetchCalls = 0;
  const response = await handleKioskSync(request('/api/m1-kiosk-sync', {
    body: { rows: [row()] }
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV,
    fetch: async () => { fetchCalls += 1; throw new Error('must not run'); },
    dateNow: new Date('2026-08-21T16:00:00Z')
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).message, /writes are disabled/iu);
  assert.equal(fetchCalls, 0);

  const adminMutation = await handleAdminAdd(request('/.netlify/functions/m1-admin-add', {
    body: {
      requestId: '11111111-1111-4111-8111-111111111111',
      date: '2026-08-21',
      classLabel: row()['Class Label'],
      duration: 1,
      instructor: row().Instructor,
      site: 'Richmond',
      notes: '',
      reason: 'Missed tablet sign-in'
    }
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV,
    fetch: async () => { fetchCalls += 1; throw new Error('must not run'); }
  });
  assert.equal(adminMutation.status, 403);
  assert.equal(fetchCalls, 0);
});

test('pending Richmond Admin requires the passphrase, stays read-only, and expires on activation', async () => {
  const now = Date.parse('2026-08-22T16:00:00Z');
  const bypassBody = {
    adminName: 'Andrew Smith',
    passphrase: '',
    testShortcut: false,
    readOnlyPending: true
  };
  const pendingConfig = runtimeConfig(PENDING_ENV, {
    requestUrl: `${ORIGIN}/.netlify/functions/m1-admin-login`,
    admin: true,
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending'
  });
  const activeConfig = runtimeConfig(ACTIVE_ENV, {
    requestUrl: `${ORIGIN}/.netlify/functions/m1-admin-login`,
    admin: true,
    ...PRODUCTION_DEPENDENCIES,
    activation: 'active'
  });
  assert.notEqual(pendingConfig.sessionSecret, activeConfig.sessionSecret);

  const bypassLogin = await handleAdminLogin(request('/.netlify/functions/m1-admin-login', {
    body: bypassBody
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV,
    now
  });
  assert.equal(bypassLogin.status, 401);

  const pendingLogin = await handleAdminLogin(request('/.netlify/functions/m1-admin-login', {
    body: {
      adminName: 'Andrew Smith',
      passphrase: PENDING_ENV.GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE,
      testShortcut: false
    }
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV,
    now
  });
  assert.equal(pendingLogin.status, 200);
  const loginData = await pendingLogin.json();
  assert.equal(loginData.readOnly, true);
  const cookie = pendingLogin.headers.get('set-cookie').split(';')[0].split('=')[1];
  assert.ok(readAdminSession(cookie, pendingConfig.sessionSecret, now));
  assert.equal(readAdminSession(cookie, activeConfig.sessionSecret, now), null);

  const activeLogin = await handleAdminLogin(request('/.netlify/functions/m1-admin-login', {
    body: bypassBody
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'active',
    env: ACTIVE_ENV,
    now
  });
  assert.equal(activeLogin.status, 401);
});

test('pending Daily Review status is authenticated server-side, sanitized for the browser, and removed on activation', async () => {
  let forwarded = null;
  const response = await handleProductionStatus(request('/api/m1-production-status', {
    body: {}
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV,
    fetch: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return new Response(JSON.stringify({
        ok: true,
        date: '2026-08-22',
        records: [],
        warnings: [],
        auditHistory: []
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    dateNow: new Date('2026-08-22T16:00:00Z')
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    empty: true,
    writesEnabled: false
  });
  assert.equal(forwarded.action, 'dailyReview');
  assert.equal(forwarded.date, '2026-08-22');
  assert.equal(forwarded.target, 'production');
  assert.equal(forwarded.installation, 'richmond');
  assert.equal(forwarded.environment, 'production');
  assert.equal(forwarded.voidEligibilityVersion, 'richmond-instructor-void-v1');
  assert.equal(forwarded.token, PENDING_ENV.GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN);
  assert.equal(forwarded.adminActionToken, PENDING_ENV.GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN);

  const pendingRecord = {
    displayId: 'sheet-row-2',
    recordId: 'gib-m1-11111111-1111-4111-8111-111111111111',
    timestamp: '2026-08-22 10:00:00',
    date: '2026-08-22',
    classLabel: '10:00 AM Richmond BJJ',
    duration: 1,
    instructor: 'Andrew Smith',
    site: 'Richmond',
    notes: '',
    source: 'Kiosk',
    reviewRequired: false,
    reviewMessage: '',
    voidEligible: false
  };
  const nonEmpty = await handleProductionStatus(request('/api/m1-production-status', {
    body: {}
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV,
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      date: '2026-08-22',
      records: [pendingRecord],
      warnings: [],
      auditHistory: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    dateNow: new Date('2026-08-22T16:00:00Z')
  });
  assert.equal(nonEmpty.status, 200);
  assert.deepEqual(await nonEmpty.json(), {
    ok: true,
    empty: false,
    writesEnabled: false
  });

  const missingEligibility = await handleProductionStatus(request('/api/m1-production-status', {
    body: {}
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV,
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      date: '2026-08-22',
      records: [{
        ...pendingRecord,
        voidEligible: undefined
      }],
      warnings: [],
      auditHistory: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    dateNow: new Date('2026-08-22T16:00:00Z')
  });
  assert.equal(missingEligibility.status, 502);

  let activeFetchCalls = 0;
  const active = await handleProductionStatus(request('/api/m1-production-status', {
    body: {}
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'active',
    env: ACTIVE_ENV,
    fetch: async () => { activeFetchCalls += 1; throw new Error('must not run'); }
  });
  assert.equal(active.status, 404);
  assert.equal(activeFetchCalls, 0);
});

test('later write enablement still requires both the server gate and Richmond-only device cookie', async () => {
  const withoutDevice = await handleKioskSync(request('/api/m1-kiosk-sync', {
    body: { rows: [row()] }
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'active',
    env: ACTIVE_ENV,
    dateNow: new Date('2026-08-21T16:00:00Z')
  });
  assert.equal(withoutDevice.status, 401);

  const now = Date.parse('2026-08-21T16:00:00Z');
  const credential = createRichmondProductionDeviceCredential(
    ACTIVE_ENV.GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN,
    () => Buffer.alloc(32, 7),
    now
  );
  const cookie = richmondProductionDeviceCookieHeader(credential).split(';')[0];
  let forwarded = null;
  const enabled = await handleKioskSync(request('/api/m1-kiosk-sync', {
    body: { rows: [row()] },
    cookie
  }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'active',
    env: ACTIVE_ENV,
    now,
    dateNow: new Date(now),
    fetch: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return new Response(JSON.stringify({
        ok: true,
        target: 'production',
        results: [{
          rowId: row().RowID,
          result: 'added',
          linkedRecordId: row().RowID
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(enabled.status, 200);
  assert.equal(forwarded.installation, 'richmond');
  assert.equal(forwarded.environment, 'production');
  assert.equal(forwarded.target, 'production');
  assert.notEqual(RICHMOND_PRODUCTION_DEVICE_COOKIE, PRODUCTION_DEVICE_COOKIE);
});

test('tablet status exposes pending without authorizing or issuing a cookie', async () => {
  const response = await handleTabletStatus(request('/api/m1-tablet-status', { body: {} }), {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'pending',
    env: PENDING_ENV
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    authorized: false,
    writesEnabled: false,
    activation: 'pending'
  });
  assert.equal(response.headers.get('set-cookie'), null);
});

test('Richmond production cannot expose or consume Revolution tablet recovery', async () => {
  const dependencies = {
    ...PRODUCTION_DEPENDENCIES,
    activation: 'active',
    env: ACTIVE_ENV
  };
  const issue = await handleAdminTabletAuthorize(request(
    '/api/m1-admin-tablet-authorize',
    { body: { operation: 'issue' } }
  ), dependencies);
  const install = await handleTabletInstall(request(
    '/api/m1-tablet-install',
    { body: { operation: 'installAdminGrant' } }
  ), dependencies);

  assert.equal(issue.status, 404);
  assert.equal(install.status, 404);
  assert.equal(issue.headers.has('set-cookie'), false);
  assert.equal(install.headers.has('set-cookie'), false);
  assert.match(adminHtml, /TABLET_AUTHORIZATION_AVAILABLE = !IS_RICHMOND\s*&& STAFF_CLOCK_ENABLED/u);
  assert.match(adminHtml, /\$\('#tabletAuthorization'\)\.hidden = !TABLET_AUTHORIZATION_AVAILABLE/u);
});

test('browser, service-worker, schedule, and build sources keep Richmond production isolated and visibly disabled', () => {
  assert.match(kioskHtml, /gib_m1_richmond_production_/u);
  assert.match(kioskHtml, /PRODUCTION · ACTIVATION PENDING/u);
  assert.match(kioskHtml, /Activation pending — Instructor Sign-In and all production writes are unavailable/u);
  assert.match(kioskHtml, /if \(IS_RICHMOND_PRODUCTION && !RICHMOND_WRITES_ENABLED\)[\s\S]*return;/u);
  assert.match(kioskHtml, /profile\?\.installationId === 'richmond' && profile\?\.environment === 'production'[\s\S]*location\.href = '\/m1\/admin\/'/u);
  assert.match(adminHtml, /Richmond Production — Read-only Daily Sign-in Review/u);
  assert.match(adminHtml, /enter the Admin passphrase/u);
  assert.match(adminHtml, /Today’s production Daily Review is empty — no sign-ins or audit actions for today/u);
  assert.doesNotMatch(adminHtml, /readOnlyPending|no passphrase is required/u);
  assert.match(adminHtml, /Changes unavailable while Richmond production activation is pending/u);
  assert.match(adminHtml, /if \(mutationsEnabled\) row\.append\(buildAddForm/u);
  assert.match(serviceWorker, /gib-m1-richmond-production-shell-/u);
  assert.notEqual(RICHMOND_PRODUCTION_LAST_KNOWN_GOOD_STORE, RICHMOND_LAST_KNOWN_GOOD_STORE);
  assert.notEqual(RICHMOND_PRODUCTION_LAST_KNOWN_GOOD_KEY, RICHMOND_LAST_KNOWN_GOOD_KEY);
  assert.match(buildTool, /GIB_M1_ENVIRONMENT/u);
  assert.match(buildTool, /GIB_RICHMOND_PRODUCTION_ACTIVATION/u);
  assert.match(buildTool, /GIB_RICHMOND_PRODUCTION_WRITE_ENABLED/u);
  assert.match(productionStatusSource, /path: '\/api\/m1-production-status'/u);
  assert.doesNotMatch(kioskHtml + adminHtml, /SYNTHETIC_RICHMOND_PRODUCTION|macros\/s\//u);
});

test('active Richmond production UI removes pending and disabled labels without a redesign', () => {
  const activeProfile = installationProfile('richmond', 'production', 'active');
  assert.equal(activeProfile.activation, 'active');
  assert.equal(activeProfile.writesEnabled, true);

  const activeKiosk = readUiCopy(kioskHtml, 'richmondProductionKioskCopy', true);
  const activeAdmin = readUiCopy(adminHtml, 'richmondProductionAdminCopy', true);
  const pendingKiosk = readUiCopy(kioskHtml, 'richmondProductionKioskCopy', false);
  const pendingAdmin = readUiCopy(adminHtml, 'richmondProductionAdminCopy', false);

  assert.doesNotMatch(JSON.stringify(activeKiosk), /pending|disabled|read-only/iu);
  assert.doesNotMatch(JSON.stringify(activeAdmin), /pending|disabled|read-only/iu);
  assert.match(activeKiosk.title, /Instructor Sign-In/u);
  assert.match(activeAdmin.loginHeading, /Daily Sign-in Review/u);
  assert.match(JSON.stringify(pendingKiosk), /pending|disabled/iu);
  assert.match(JSON.stringify(pendingAdmin), /pending|disabled|read-only/iu);
});
