import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  RICHMOND_SYNC_HISTORY_KEY,
  activationFailureCode,
  kioskDeliveryText,
  readRichmondSyncHistory,
  recordRichmondSyncEvent,
  requestAcknowledgements
} from '../m1/sync-core.mjs';
import { handleKioskSync, richmondUploadFailureCode } from '../netlify/functions/m1-kiosk-sync.mjs';
import { handleTabletStatus, richmondLedgerCheckCode } from '../netlify/functions/m1-tablet-status.mjs';
import {
  createRichmondProductionDeviceCredential,
  richmondProductionDeviceCookieHeader
} from '../netlify/functions/_lib/m1-richmond-production-runtime.mjs';

const kiosk = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const ORIGIN = 'https://gib-richmond-live.netlify.app';
const NOW = Date.parse('2026-09-07T20:00:00.000Z');
// Synthetic constants only. All receiver calls in this file use injected fakes.
const ENV = Object.freeze({
  GIB_M1_INSTALLATION: 'richmond',
  GIB_M1_ENVIRONMENT: 'production',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_HOTFIX_RECEIVER_123456/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'synthetic-hotfix-webhook-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'synthetic-hotfix-admin-action-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'synthetic coral orbit meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'synthetic-hotfix-device-token-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_INSTALL_CAPABILITY_SECRET: 'synthetic-hotfix-install-secret-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active',
  GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true'
});
const DEVICE_COOKIE = richmondProductionDeviceCookieHeader(createRichmondProductionDeviceCredential(
  ENV.GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN, () => Buffer.alloc(32, 9), NOW
)).split(';')[0];
const ROW = Object.freeze({
  RowID: 'gib-m1-20000000-0000-4000-8000-000000000001',
  Timestamp: '2026-09-07 16:00:00', Date: '2026-09-07',
  'Class Label': '8:00 AM Synthetic Class', 'Duration (hr)': 1,
  Instructor: 'Synthetic Instructor', Site: 'Richmond', Device: 'Richmond Front Desk Tablet',
  Build: 'hotfix-unit-only', Notes: 'In-memory regression fixture'
});

function storageHarness() {
  const values = new Map();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}
function sourceBetween(startMarker, endMarker) {
  const start = kiosk.indexOf(startMarker);
  const end = kiosk.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start);
  return kiosk.slice(start, end);
}
function serverRequest(path, { authorized = true, diagnostic = true, badOrigin = false } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Host: new URL(ORIGIN).host, Origin: badOrigin ? 'https://invalid.example' : ORIGIN,
      'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
      ...(authorized ? { Cookie: DEVICE_COOKIE } : {}),
      ...(diagnostic ? {
        'X-GIB-M1-Sync-Diagnostic': 'v1', 'X-GIB-M1-Connection-Check': 'details-v1'
      } : {})
    },
    body: JSON.stringify(path.endsWith('sync') ? { rows: [ROW] } : {})
  });
}
function serverDependencies(fetchImpl) {
  return {
    installationId: 'richmond', environment: 'production', activation: 'active',
    env: ENV, now: NOW, dateNow: new Date(NOW), fetch: fetchImpl
  };
}

test('Richmond delivery history is counts-only, coalesced, bounded, and cannot obstruct sign-in persistence', () => {
  const storage = storageHarness();
  storage.setItem('gib_m1_richmond_production_local_state_v2', 'protected-ledger-sentinel');
  const event = {
    stage: 'upload', code: 'TABLET_SERVICE_UNREACHABLE', waiting: 2,
    Instructor: 'PRIVATE-NAME-SENTINEL', RowID: 'PRIVATE-ROW-SENTINEL',
    response: 'PRIVATE-RESPONSE-SENTINEL', token: 'PRIVATE-TOKEN-SENTINEL'
  };
  recordRichmondSyncEvent(storage, event, '2026-09-07T20:00:00Z');
  recordRichmondSyncEvent(storage, event, '2026-09-07T20:01:00Z');
  assert.deepEqual(readRichmondSyncHistory(storage), [{
    at: '2026-09-07T20:01:00.000Z', firstAt: '2026-09-07T20:00:00.000Z',
    stage: 'upload', code: 'TABLET_SERVICE_UNREACHABLE', waiting: 2, attempts: 2
  }]);
  assert.doesNotMatch(storage.getItem(RICHMOND_SYNC_HISTORY_KEY), /PRIVATE-|Instructor|RowID|response|token/u);
  for (let i = 0; i < 25; i += 1) {
    recordRichmondSyncEvent(storage, { stage: 'upload', code: 'UPLOAD_CONFIRMED', waiting: i },
      `2026-09-07T20:02:${String(i).padStart(2, '0')}Z`);
  }
  assert.equal(readRichmondSyncHistory(storage).length, 20);
  assert.equal(readRichmondSyncHistory(storage)[0].waiting, 5);
  assert.equal(storage.getItem('gib_m1_richmond_production_local_state_v2'), 'protected-ledger-sentinel');
  assert.equal(recordRichmondSyncEvent(storage, { stage: 'upload', code: 'UPSTREAM_PRIVATE_TEXT', waiting: 2 }), false);
  assert.equal(recordRichmondSyncEvent({ getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } }, event), false);
  storage.setItem(RICHMOND_SYNC_HISTORY_KEY, 'invalid JSON');
  assert.deepEqual(readRichmondSyncHistory(storage), []);
});

test('delivery copy distinguishes unsent records, disabled sending, and confirmed delivery', () => {
  assert.equal(kioskDeliveryText({ waiting: 2, automatic: false }), '2 sign-ins saved on this tablet · automatic sending is off');
  assert.equal(kioskDeliveryText({ waiting: 1, automatic: true, sending: true }), '1 sign-in saved on this tablet · sending…');
  assert.match(kioskDeliveryText({ waiting: 1, automatic: true, error: 'x' }), /waiting to send; will retry automatically/u);
  assert.equal(kioskDeliveryText({ waiting: 0, automatic: true, last: '' }), 'Sign-ins save on this tablet and send automatically');
  assert.equal(kioskDeliveryText({ waiting: 0, automatic: true, last: '2026-09-07T20:00:00Z' }), 'All saved sign-ins sent to the sheet');
  assert.equal(kioskDeliveryText({ waiting: NaN, automatic: true }), 'Sending status unavailable');
});

test('initial Richmond authorization is retried on normal wakeups while later manual Auto-sync OFF is preserved', () => {
  const storage = storageHarness();
  storage.setItem('auto', 'false');
  let activations = 0;
  const scheduled = [];
  const context = vm.createContext({
    BACKEND_ENABLED: true, IS_RICHMOND_PRODUCTION: true, RICHMOND_WRITES_ENABLED: true,
    navigator: { onLine: true }, localStorage: storage,
    RICHMOND_ACTIVATION_MIGRATION_KEY: 'activated', SYNC_AUTO_KEY: 'auto',
    runRichmondActivationMigration() { activations += 1; }, loadSyncQueue: () => [ROW],
    syncNow() {}, window: { setTimeout: (callback, delay) => scheduled.push({ callback, delay }) }
  });
  new vm.Script(sourceBetween('  function resumeInstructorSync()', '  function debugSnapshot()')
    + '\nglobalThis.resume = resumeInstructorSync;').runInContext(context);
  assert.equal(context.resume(), false);
  assert.equal(context.resume(), false);
  assert.equal(activations, 2, 'no fresh online event is needed for a subsequent wakeup');
  assert.equal(storage.getItem('auto'), 'false');
  assert.equal(scheduled.length, 0);
  storage.setItem('activated', 'v1');
  assert.equal(context.resume(), false);
  assert.equal(activations, 2, 'completed migration never overrides a later OFF choice');
  storage.setItem('auto', 'true');
  assert.equal(context.resume(), true);
  assert.equal(scheduled.length, 1);
  context.navigator.onLine = false;
  assert.equal(context.resume(), false);
  assert.equal(scheduled.length, 1);
});

test('Richmond activation timeout includes response-body wait and releases the timer', async () => {
  const timers = [];
  const cleared = [];
  const events = [];
  let requested;
  let bodyStarted = false;
  const context = vm.createContext({
    AbortController,
    window: { setTimeout(callback, delay) { timers.push({ callback, delay }); return 31; }, clearTimeout: id => cleared.push(id) },
    recordSyncEvent: (...value) => events.push(value), activationFailureCode,
    fetch: async (url, init) => {
      requested = { url, init };
      return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
        bodyStarted = true;
        init.signal.addEventListener('abort', () => reject(new Error('Synthetic body timeout')), { once: true });
      }) };
    }
  });
  new vm.Script(sourceBetween('  async function requestRichmondActivationStatus()', '  let richmondActivationMigrationInFlight')
    + '\nglobalThis.check = requestRichmondActivationStatus;').runInContext(context);
  const pending = context.check();
  const rejection = assert.rejects(pending, /Synthetic body timeout/u);
  await new Promise(setImmediate);
  assert.equal(bodyStarted, true);
  assert.equal(timers[0].delay, 30_000);
  assert.deepEqual(cleared, []);
  assert.equal(requested.url, '/api/m1-tablet-status');
  assert.equal(requested.init.credentials, 'same-origin');
  assert.equal(requested.init.redirect, 'error');
  assert.equal(requested.init.body, '{}');
  timers[0].callback();
  await rejection;
  assert.deepEqual(events, [['activation', 'TABLET_REQUEST_TIMEOUT']]);
  assert.deepEqual(cleared, [31]);
});

test('Richmond server diagnostic categories are fixed and ledger success remains exact', () => {
  for (const [failureClass, statusCode, uploadCode] of [
    ['UNREACHABLE', 'TIMEOUT_OR_NETWORK', 'SHEET_TIMEOUT_OR_NETWORK'],
    ['HTML', 'HTML_RESPONSE', 'SHEET_HTML_RESPONSE'],
    ['HTTP_FAILURE', 'HTTP_FAILURE', 'SHEET_HTTP_FAILURE'],
    ['EMPTY', 'EMPTY_RESPONSE', 'SHEET_EMPTY_RESPONSE'],
    ['READ_FAILED', 'INCOMPLETE_RESPONSE', 'SHEET_INCOMPLETE_RESPONSE'],
    ['PRIVATE_UNRECOGNIZED', 'INVALID_RESPONSE', 'SHEET_INVALID_RESPONSE']
  ]) {
    const value = { readable: false, failureClass, body: 'PRIVATE-UPSTREAM-SENTINEL' };
    assert.equal(richmondLedgerCheckCode(value), statusCode);
    assert.equal(richmondUploadFailureCode(value), uploadCode);
  }
  const value = { ok: true, target: 'production', installation: 'richmond', environment: 'production',
    empty: false, signinsRows: 1, auditRows: 0, writesEnabled: true };
  assert.equal(richmondLedgerCheckCode({ readable: true, value }), 'CONFIRMED');
  for (const changed of [{ installation: 'revolution' }, { signinsRows: -1 }, { empty: true }, { extra: 'PRIVATE' }]) {
    assert.equal(richmondLedgerCheckCode({ readable: true, value: { ...value, ...changed } }), 'CONTRACT_MISMATCH');
  }
  assert.equal(richmondLedgerCheckCode({ readable: true, value: { ...value, writesEnabled: false } }), 'WRITES_DISABLED');
});

test('Richmond diagnostic headers require existing device authorization, exact origin, and explicit opt-in', async () => {
  for (const [path, handler, header, expectedCode] of [
    ['/api/m1-kiosk-sync', handleKioskSync, 'X-GIB-M1-Sync-Code', 'SHEET_HTML_RESPONSE'],
    ['/api/m1-tablet-status', handleTabletStatus, 'X-GIB-M1-Check-Code', 'HTML_RESPONSE']
  ]) {
    for (const options of [{}, { diagnostic: false }, { authorized: false }, { badOrigin: true }]) {
      let calls = 0;
      const response = await handler(serverRequest(path, options), serverDependencies(async () => {
        calls += 1;
        return new Response('<html>PRIVATE-UPSTREAM-SENTINEL</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      }));
      const permitted = options.diagnostic !== false && options.authorized !== false && options.badOrigin !== true;
      assert.equal(response.headers.get(header), permitted ? expectedCode : null);
      assert.equal(calls, options.authorized === false || options.badOrigin === true ? 0 : 1);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.doesNotMatch(await response.text(), /PRIVATE-|SYNTHETIC_HOTFIX|token|device-token/u);
    }
  }
});

test('client diagnostics cannot reinterpret arbitrary headers as trusted confirmation or expose upstream text', async () => {
  for (const [richmondDiagnostics, status, reported, expected] of [
    [true, 502, 'SHEET_HTML_RESPONSE', 'SHEET_HTML_RESPONSE'],
    [false, 502, 'SHEET_HTML_RESPONSE', 'SERVICE_UNAVAILABLE'],
    [true, 503, 'SHEET_HTML_RESPONSE', 'SERVICE_UNAVAILABLE'],
    [true, 502, 'PRIVATE-UPSTREAM-SENTINEL', 'SERVICE_UNAVAILABLE'],
    [true, 401, 'SHEET_HTML_RESPONSE', 'TABLET_NOT_AUTHORIZED']
  ]) {
    await assert.rejects(requestAcknowledgements([ROW], {
      productionOrigin: true, richmondDiagnostics,
      fetchImpl: async (_url, init) => {
        assert.equal(init.credentials, 'same-origin');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers['X-GIB-M1-Sync-Diagnostic'], richmondDiagnostics ? 'v1' : undefined);
        return new Response('PRIVATE-UPSTREAM-SENTINEL', { status, headers: { 'X-GIB-M1-Sync-Code': reported } });
      }
    }), error => error.syncCode === expected && !error.message.includes('PRIVATE'));
  }
  const response = new Response('{}', { headers: { 'X-GIB-M1-Check-Code': 'HTML_RESPONSE' } });
  assert.equal(activationFailureCode(response, { authorized: false }), 'TABLET_NOT_AUTHORIZED');
  assert.equal(activationFailureCode(response, {}), 'ACTIVATION_UNCONFIRMED');
  assert.equal(activationFailureCode(response, { authorized: true }), 'SHEET_HTML_RESPONSE');
});
