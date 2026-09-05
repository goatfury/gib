import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { handleKioskSync, richmondUploadFailureCode } from '../netlify/functions/m1-kiosk-sync.mjs';
import { createRichmondProductionDeviceCredential, RICHMOND_PRODUCTION_DEVICE_COOKIE } from '../netlify/functions/_lib/m1-richmond-production-runtime.mjs';
import { appendBatchToState, applyAcknowledgements, createPermanentRowId, formatDateInTimeZone,
  formatTimestampInTimeZone, requestAcknowledgements, recordRichmondSyncEvent, readRichmondSyncHistory,
  RICHMOND_SYNC_HISTORY_KEY, SYNC_EVENT_MESSAGES, syncFailureCode, kioskDeliveryText } from '../m1/sync-core.mjs';

// All credentials, rows and receiver replies are synthetic. Both transport
// boundaries are injected; this suite never makes an external network request.
const ORIGIN = 'https://gib-richmond-live.netlify.app';
const PREFIX = 'gib_m1_richmond_production_';
const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const ENV = {
  GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'production',
  GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_HISTORY_RECEIVER_123456/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'synthetic-webhook-secret-for-history-tests',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'synthetic-admin-action-secret-for-history-tests',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'synthetic history test passphrase',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'synthetic-device-secret-for-history-tests'
};
const now = Date.now();
const cookie = `${RICHMOND_PRODUCTION_DEVICE_COOKIE}=${createRichmondProductionDeviceCredential(
  ENV.GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN, undefined, now
)}`;

function source(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const brace = html.indexOf('{', html.indexOf(')', start));
  let depth = 0;
  for (let i = brace; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`Missing function end: ${name}`);
}

function harness({ storage = new Map(), received = new Map() } = {}) {
  if (!storage.has(`${PREFIX}local_state_v2`)) storage.set(`${PREFIX}local_state_v2`, JSON.stringify({ version: 2, ledger: [], queue: [] }));
  if (!storage.has(`${PREFIX}sync_auto_v1`)) storage.set(`${PREFIX}sync_auto_v1`, 'true');
  storage.set(`${PREFIX}activation_auto_sync_migration_v1`, 'richmond-production-auto-sync-v1');
  const localStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const state = () => JSON.parse(storage.get(`${PREFIX}local_state_v2`));
  let mode = 'good';
  let calls = 0;
  let statusText = '';
  const timers = new Map();
  let nextTimer = 0;
  const fields = { '#nameInput': { value: 'Richmond Instructor' }, '#notesInput': { value: '' } };
  const navigator = { onLine: true };
  const transport = async (path, init) => {
    calls += 1;
    assert.equal(path, '/api/m1-kiosk-sync');
    if (mode === 'network') throw new TypeError('synthetic network loss');
    if (mode === 'stall-body') return { ok: true, status: 200, json: () => new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(new Error('synthetic body stall')))) };
    if (mode === 'bad-json') return new Response('{broken');
    const request = new Request(`${ORIGIN}${path}`, { ...init, headers: { ...init.headers,
      Host: 'gib-richmond-live.netlify.app', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin',
      Cookie: mode === 'unauthorized' ? '' : cookie } });
    const response = await handleKioskSync(request, {
      installationId: 'richmond', environment: 'production', activation: 'active', env: ENV, now,
      fetch: async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(payload.action, 'kioskSignIn');
        if (mode === 'google-network') throw new TypeError('synthetic Google outage');
        if (mode === 'google-html') return new Response('<html>synthetic failure</html>');
        const results = payload.rows.map(row => {
          if (mode === 'row-rejected') return { rowId: row.RowID, result: 'rejected', linkedRecordId: '' };
          const exists = received.has(row.RowID);
          received.set(row.RowID, row);
          return { rowId: row.RowID, result: exists ? 'already exists' : 'added', linkedRecordId: row.RowID };
        });
        return new Response(JSON.stringify({ ok: true, target: 'production', results }));
      }
    });
    if (mode === 'lost-ack') throw new TypeError('synthetic response lost after server write');
    return response;
  };
  const context = vm.createContext({
    Date, Promise, AbortController, navigator, localStorage,
    IS_RICHMOND: true, IS_RICHMOND_PRODUCTION: true, IS_RICHMOND_PRODUCTION_ORIGIN: true,
    RICHMOND_WRITES_ENABLED: true, IS_PRODUCTION_SYNC_ORIGIN: true, BACKEND_ENABLED: true,
    INSTALLATION: { deviceLabel: 'Richmond Front Desk Tablet' }, BUILD: 'synthetic-history-unit',
    SYNC_AUTO_KEY: `${PREFIX}sync_auto_v1`, SYNC_LAST_KEY: `${PREFIX}sync_last`,
    SYNC_ERROR_KEY: `${PREFIX}sync_error`, RICHMOND_ACTIVATION_MIGRATION_KEY: `${PREFIX}activation_auto_sync_migration_v1`,
    INSTRUCTOR_SYNC_BATCH_SIZE: 50, appendBatchToState, applyAcknowledgements, createPermanentRowId,
    fmtTS: formatTimestampInTimeZone, fmtDate: formatDateInTimeZone,
    loadLocalState: state, readAdminLocalStateSnapshot: state, loadSyncQueue: () => state().queue,
    persistLocalState: value => localStorage.setItem(`${PREFIX}local_state_v2`, JSON.stringify(value)),
    requestAcknowledgements: (rows, options) => requestAcknowledgements(rows, { ...options, fetchImpl: transport }),
    recordRichmondSyncEvent, syncFailureCode,
    getSiteCode: () => 'Richmond', getDurationForClass: () => 1,
    selectedClasses: () => ['6:00 AM–7:00 AM Muay Thai Fundamentals'], $: id => fields[id],
    upsertName() {}, refreshNameDatalist() {},
    openSignInModal() { assert.equal(state().queue.length > 0, true, 'confirmation requires durable local save'); },
    alert(message) { assert.fail(message); }, showToast() {},
    updateSyncStatus() { statusText = kioskDeliveryText({ waiting: state().queue.length,
      last: localStorage.getItem(`${PREFIX}sync_last`), automatic: localStorage.getItem(`${PREFIX}sync_auto_v1`) === 'true',
      error: localStorage.getItem(`${PREFIX}sync_error`) }); },
    window: { setTimeout(callback, delay = 0) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); } }
  });
  vm.runInContext('let syncInFlight = false; let signInLocked = false; let lastSigninBatchId = null; let signInSecondsRemaining = 0;\n'
    + ['recordSyncEvent', 'signIn', 'syncNow', 'resumeInstructorSync'].map(source).join('\n'), context);
  const runTimers = async delay => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  return { storage, localStorage, state, received, navigator, timers,
    get calls() { return calls; }, get text() { return statusText; },
    setMode(value) { mode = value; }, signIn: () => context.signIn(), sync: () => context.syncNow(),
    async wake() { context.resumeInstructorSync(); await runTimers(0); },
    expire: () => runTimers(30_000) };
}

test('real kiosk save, failed upload, reload and wake resend preserve identity and failure evidence', async () => {
  const first = harness();
  first.signIn();
  const id = first.state().queue[0].RowID;
  first.setMode('network');
  await first.sync();
  assert.match(first.text, /saved on this tablet.*waiting to send/);
  assert.equal(first.state().queue[0].RowID, id);
  const reopened = harness({ storage: first.storage, received: first.received });
  await reopened.wake();
  assert.equal(reopened.received.size, 1);
  assert.equal(reopened.state().queue.length, 0);
  assert.equal(reopened.state().ledger[0].RowID, id);
  assert.match(reopened.text, /All saved sign-ins sent/);
  assert.deepEqual(readRichmondSyncHistory(reopened.localStorage).map(e => e.code), ['TABLET_SERVICE_UNREACHABLE', 'UPLOAD_CONFIRMED']);
});

test('lost acknowledgment after a server write retries the same row once after reload', async () => {
  const first = harness(); first.signIn(); first.setMode('lost-ack'); await first.sync();
  assert.equal(first.received.size, 1); assert.equal(first.state().queue.length, 1);
  const reopened = harness({ storage: first.storage, received: first.received });
  await reopened.wake();
  assert.equal(reopened.received.size, 1); assert.equal(reopened.state().queue.length, 0);
  assert.equal(reopened.state().ledger[0].__syncResult, 'already exists');
});

test('stalled upload body releases the in-flight request and a later wake recovers without reload', async () => {
  const h = harness(); h.signIn(); h.setMode('stall-body');
  const pending = h.sync(); await new Promise(resolve => setImmediate(resolve));
  await h.wake(); assert.equal(h.calls, 1);
  await h.expire(); await pending;
  assert.equal(readRichmondSyncHistory(h.localStorage)[0].code, 'TABLET_REQUEST_TIMEOUT');
  h.setMode('good'); await h.wake();
  assert.equal(h.calls, 2); assert.equal(h.state().queue.length, 0);
});

test('offline, authorization, Google failures and rejected rows remain queued with distinct evidence', async () => {
  for (const [mode, code] of [['offline', 'OFFLINE'], ['unauthorized', 'TABLET_NOT_AUTHORIZED'],
    ['google-network', 'SHEET_TIMEOUT_OR_NETWORK'], ['google-html', 'SHEET_HTML_RESPONSE'],
    ['bad-json', 'INVALID_ACK'], ['row-rejected', 'ROWS_UNCONFIRMED']]) {
    const h = harness(); h.signIn(); h.setMode(mode); h.navigator.onLine = mode !== 'offline';
    await h.sync();
    assert.equal(h.state().queue.length, 1, mode);
    assert.equal(readRichmondSyncHistory(h.localStorage)[0].code, code, mode);
    h.navigator.onLine = true; h.setMode('good'); await h.wake();
    assert.equal(h.state().queue.length, 0, mode);
    assert.equal(readRichmondSyncHistory(h.localStorage)[0].code, code, 'success must retain prior failure');
  }
});

test('history is bounded, strips private fields, survives success and cannot block payroll persistence', () => {
  const h = harness();
  const event = { stage: 'upload', code: 'SHEET_HTML_RESPONSE', waiting: 2, token: 'PRIVATE', Instructor: 'PRIVATE' };
  for (let i = 0; i < 100; i += 1) recordRichmondSyncEvent(h.localStorage, event);
  const entries = readRichmondSyncHistory(h.localStorage);
  assert.equal(entries.length, 1); assert.equal(entries[0].attempts, 100);
  assert.equal(h.storage.get(RICHMOND_SYNC_HISTORY_KEY).includes('PRIVATE'), false);
  recordRichmondSyncEvent(h.localStorage, { stage: 'upload', code: 'UPLOAD_CONFIRMED', waiting: 0 });
  assert.equal(readRichmondSyncHistory(h.localStorage).length, 2);
  for (let i = 0; i < 30; i += 1) recordRichmondSyncEvent(h.localStorage, { ...event, waiting: i });
  assert.equal(readRichmondSyncHistory(h.localStorage).length, 20);
  assert.equal(recordRichmondSyncEvent({ getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } }, event), false);
  assert.equal(recordRichmondSyncEvent(h.localStorage, { ...event, code: 'PRIVATE RAW ERROR' }), false);
});

test('a current access check or empty local history never produces a false delivery claim', () => {
  assert.doesNotMatch(kioskDeliveryText({ waiting: 0, automatic: true, last: null }), /All.*sent|connected|healthy/i);
  assert.match(kioskDeliveryText({ waiting: 2, automatic: false }), /automatic sending is off/);
  assert.match(kioskDeliveryText({ waiting: 2, automatic: true, sending: true }), /sending/);
});

test('server failure categories and browser headers cannot leak arbitrary upstream text', async () => {
  assert.equal(richmondUploadFailureCode({ readable: false, failureClass: 'PRIVATE' }), 'SHEET_INVALID_RESPONSE');
  for (const header of ['PRIVATE', 'constructor', 'UPLOAD_CONFIRMED']) {
    await assert.rejects(requestAcknowledgements([{ RowID: 'synthetic' }], {
      richmondDiagnostics: true, fetchImpl: async () => new Response('', { status: 502, headers: { 'X-GIB-M1-Sync-Code': header } })
    }), error => error.syncCode === 'SERVICE_UNAVAILABLE' && !error.message.includes(header));
  }
  assert.equal(Object.values(SYNC_EVENT_MESSAGES).some(value => value.includes('PRIVATE')), false);
});
