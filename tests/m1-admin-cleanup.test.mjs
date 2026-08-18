import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import * as syncCore from '../m1/sync-core.mjs';

const kiosk = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');
const staffClockClient = readFileSync(
  new URL('../m1/staff-clock-client.mjs', import.meta.url),
  'utf8'
).replace(/\r\n?/gu, '\n');

const BASELINE_BUTTON_IDS = Object.freeze([
  'btnAdmin',
  'toggleClasses',
  'btnSignIn',
  'btnStaffClockAction',
  'btnStaffClockDone',
  'btnKiosk',
  'btnAdminPinToggle',
  'btnAdminLogout',
  'btnSaveAdminPin',
  'btnSaveDevice',
  'btnResetDevice',
  'btnFactoryReset',
  'btnLoadScheduleUrl',
  'btnSaveSchedule',
  'btnLoadDefaultSchedule',
  'btnLoadRichSchedule',
  'btnClearSchedule',
  'btnDisableSchedule',
  'btnAddSeries',
  'btnClearSeriesForm',
  'btnAddDurationRule',
  'btnGenerateDurationRules',
  'btnExport',
  'btnCopy',
  'btnVoidLast',
  'btnClearSignins',
  'btnSyncNow',
  'btnCopyDebug',
  'btnSelectDebug',
  'btnConfirmSignInDone',
  'btnConfirmSignInUndo',
  'btnCancelAdminPin',
  'btnConfirmAdminPin'
]);

const BASELINE_FIELD_IDS = Object.freeze([
  'nameInput',
  'nameDatalist',
  'notesInput',
  'staffClockName',
  'adminPinInput',
  'cfgGymName',
  'cfgLocation',
  'cfgSiteCode',
  'cfgScheduleUrl',
  'schedDay',
  'schedText',
  'seriesLabel',
  'seriesTime',
  'seriesStart',
  'seriesWeeks',
  'seriesEnd',
  'csvTextarea',
  'cfgDeviceLabel',
  'cfgAutoSync',
  'debugBox',
  'adminPinSetup',
  'adminPinSetupConfirm'
]);

const REPARENT_MAP = Object.freeze({
  signinsCard: 'recentSigninsSlot',
  temporaryClassesCard: 'temporaryClassesSlot',
  weeklyScheduleCard: 'weeklyScheduleSlot',
  btnAdminPinToggle: 'advancedPinSlot',
  adminPinPanel: 'advancedPinSlot',
  deviceSetupCard: 'advancedDeviceSlot',
  syncSettingsCard: 'advancedSyncSlot',
  scheduleEditorCard: 'advancedScheduleSlot',
  durationRulesCard: 'advancedDurationSlot',
  troubleshootingCard: 'advancedTroubleshootingSlot',
  btnResetDevice: 'dangerZoneActions',
  btnFactoryReset: 'dangerZoneActions',
  btnClearSignins: 'dangerZoneActions',
  btnDisableSchedule: 'dangerZoneActions'
});

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function openingTag(id) {
  const match = kiosk.match(new RegExp(`<[^>]+\\bid="${escapeRegExp(id)}"[^>]*>`, 'u'));
  assert.ok(match, `Missing opening tag for #${id}`);
  return match[0];
}

function elementIds(tags) {
  const tagPattern = tags.join('|');
  return [...kiosk.matchAll(new RegExp(`<(?:${tagPattern})[^>]*\\bid="([^"]+)"[^>]*>`, 'giu'))]
    .map(match => match[1]);
}

class FakeNode {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.parentElement = null;
    this.originalAction = `original:${id}`;
  }

  detach(child) {
    if (!child.parentElement) return;
    const siblings = child.parentElement.children;
    const index = siblings.indexOf(child);
    if (index !== -1) siblings.splice(index, 1);
  }

  appendChild(child) {
    this.detach(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  insertBefore(child, reference) {
    this.detach(child);
    const index = this.children.indexOf(reference);
    assert.notEqual(index, -1, `Missing reference node ${reference.id}`);
    this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }
}

test('default Admin document is status-first with the required calm disclosures', () => {
  const admin = sourceBetween(kiosk, '<!-- ADMIN -->', '<div id="toast"');
  const orderedIds = [
    'adminStatusHeading',
    'adminActionsHeading',
    'recentSignins',
    'staffTimeSection',
    'temporaryClassesSection',
    'weeklyScheduleSection',
    'advancedSettings',
    'dangerZone'
  ];
  const positions = orderedIds.map(id => admin.indexOf(`id="${id}"`));
  assert.equal(positions.every(position => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);

  assert.match(admin, /<h2 id="adminHeading"[^>]*>M1 Admin<\/h2>/u);
  assert.match(admin, /id="btnKiosk"[^>]*>Return to Instructor Sign-In<\/button>/u);
  assert.match(admin, /id="dailyReviewLink"[^>]*>Forgotten sign-in \/ Daily Review<\/a>/u);
  assert.match(openingTag('dailyReviewLink'), /href="\/m1\/admin\/"/u);
  assert.doesNotMatch(openingTag('dailyReviewLink'), /\btarget\s*=/iu);
  assert.doesNotMatch(kiosk, /window\.open\s*\(/u);

  assert.match(openingTag('recentSignins'), /\sopen(?:\s|=|>)/u);
  assert.match(openingTag('staffTimeSection'), /\sopen(?:\s|=|>)/u);
  for (const id of [
    'temporaryClassesSection',
    'weeklyScheduleSection',
    'advancedSettings',
    'dangerZone',
    'manualScheduleSettings',
    'durationRulesSettings',
    'troubleshootingSettings'
  ]) {
    assert.doesNotMatch(openingTag(id), /\sopen(?:\s|=|>)/u, `${id} must start closed`);
  }
  assert.doesNotMatch(kiosk, /addEventListener\(['"]toggle['"]/u);
});

test('every inherited control remains unique and connected after organization', () => {
  assert.deepEqual(elementIds(['button']), [...BASELINE_BUTTON_IDS]);
  assert.deepEqual(elementIds(['input', 'select', 'textarea', 'datalist']), [...BASELINE_FIELD_IDS]);
  assert.equal((kiosk.match(/<input[^>]*\bdata-series-day\b[^>]*>/giu) || []).length, 7);

  for (const id of [...BASELINE_BUTTON_IDS, ...BASELINE_FIELD_IDS, 'dailyReviewLink']) {
    assert.equal((kiosk.match(new RegExp(`\\bid="${escapeRegExp(id)}"`, 'gu')) || []).length, 1, id);
  }

  for (const [id, action] of [
    ['btnKiosk', 'showKiosk'],
    ['btnAdmin', 'openAdminWithGate'],
    ['btnAdminLogout', 'showKiosk'],
    ['btnSignIn', 'signIn'],
    ['btnConfirmSignInUndo', 'undoLastSigninBatch'],
    ['btnConfirmSignInDone', 'confirmSigninDone'],
    ['btnExport', 'exportCSV'],
    ['btnCopy', 'copyCSV'],
    ['btnVoidLast', 'voidLastSignin'],
    ['btnSyncNow', 'syncNow'],
    ['btnCopyDebug', 'copyDebug']
  ]) {
    assert.match(
      kiosk,
      new RegExp(`\\$\\('#${id}'\\)\\.addEventListener\\('click', ${action}\\);`, 'u'),
      `${id} must remain connected to ${action}`
    );
  }

  for (const [id, action] of [
    ['btnStaffClockAction', 'performStaffClockAction'],
    ['btnStaffClockDone', 'resetStaffClockCard']
  ]) {
    assert.match(
      staffClockClient,
      new RegExp(`\\$\\('#${id}'\\)\\?\\.addEventListener\\('click', ${action}\\);`, 'u'),
      `${id} must remain connected to ${action}`
    );
  }

  for (const id of [
    'btnAdminPinToggle', 'btnSaveAdminPin', 'btnSaveDevice', 'btnResetDevice',
    'btnFactoryReset', 'btnLoadScheduleUrl', 'btnSaveSchedule', 'btnLoadDefaultSchedule',
    'btnLoadRichSchedule', 'btnClearSchedule', 'btnDisableSchedule', 'btnAddSeries',
    'btnClearSeriesForm', 'btnAddDurationRule', 'btnGenerateDurationRules',
    'btnClearSignins', 'btnSelectDebug', 'btnCancelAdminPin', 'btnConfirmAdminPin'
  ]) {
    assert.equal(
      (kiosk.match(new RegExp(`\\$\\('#${id}'\\)\\.addEventListener\\('click'`, 'gu')) || []).length,
      1,
      `${id} lost or duplicated its click binding`
    );
  }

  assert.match(kiosk, /Waiting rows must be confirmed or individually voided before clearing local sign-ins\./u);
  assert.match(kiosk, /Reset this device\? This clears the device label\/location\/site\/setup,[\s\S]*Sign-ins and rows waiting to sync are NOT deleted\./u);
  assert.match(kiosk, /Type “RESET” \(all caps\) to proceed\./u);
  assert.match(kiosk, /Disable the schedule\? All days will have no classes/u);
});

test('organizeAdminView reparents the same live controls exactly once', () => {
  const organizer = sourceBetween(kiosk, 'let adminViewOrganized = false;', '// UI helpers');
  const ids = new Set([
    ...Object.keys(REPARENT_MAP),
    ...Object.values(REPARENT_MAP),
    'adminPrimaryActions',
    'dailyReviewLink',
    'recentSigninsLink',
    'btnSyncNow',
    'btnExport',
    'btnVoidLast'
  ]);
  const nodes = new Map([...ids].map(id => [id, new FakeNode(id)]));
  nodes.get('adminPrimaryActions').appendChild(nodes.get('dailyReviewLink'));
  nodes.get('adminPrimaryActions').appendChild(nodes.get('recentSigninsLink'));
  for (const id of new Set([...Object.keys(REPARENT_MAP), 'btnSyncNow', 'btnExport', 'btnVoidLast'])) {
    new FakeNode(`origin:${id}`).appendChild(nodes.get(id));
  }

  const context = vm.createContext({
    $: selector => nodes.get(String(selector).replace(/^#/u, '')) || null
  });
  new vm.Script(`
    ${organizer}
    globalThis.hooks = { organizeAdminView };
  `, { filename: 'm1-admin-organizer.js' }).runInContext(context);
  context.hooks.organizeAdminView();

  assert.deepEqual(
    nodes.get('adminPrimaryActions').children.map(node => node.id),
    ['dailyReviewLink', 'btnSyncNow', 'btnExport', 'btnVoidLast', 'recentSigninsLink']
  );
  for (const [elementId, targetId] of Object.entries(REPARENT_MAP)) {
    const element = nodes.get(elementId);
    assert.equal(element.parentElement, nodes.get(targetId), elementId);
    assert.equal(element.originalAction, `original:${elementId}`, elementId);
  }

  const firstLayout = new Map(
    [...nodes].map(([id, node]) => [id, node.children.map(child => child.id).join('|')])
  );
  context.hooks.organizeAdminView();
  assert.deepEqual(
    [...nodes].map(([id, node]) => [id, node.children.map(child => child.id).join('|')]),
    [...firstLayout]
  );
});

test('Daily Review and direct Admin return routing stay in one tab and use the PIN gate', () => {
  const gateSource = sourceBetween(kiosk, 'function openAdminWithGate()', '// Toggle class list');
  let allowed = false;
  let gateCalls = 0;
  let showCalls = 0;
  const context = vm.createContext({
    requestAdminAccess() { gateCalls += 1; return allowed; },
    showAdmin() { showCalls += 1; }
  });
  new vm.Script(`${gateSource}\nglobalThis.openAdminWithGate = openAdminWithGate;`)
    .runInContext(context);
  assert.equal(context.openAdminWithGate(), false);
  assert.equal(gateCalls, 1);
  assert.equal(showCalls, 0);
  allowed = true;
  assert.equal(context.openAdminWithGate(), true);
  assert.equal(gateCalls, 2);
  assert.equal(showCalls, 1);

  const routeSource = kiosk.match(
    /const requestedInitialView = new URLSearchParams\(window\.location\.search\)\.get\('view'\);\s*if \(requestedInitialView === 'admin'\) openAdminWithGate\(\);/u
  )?.[0] || '';
  assert.ok(routeSource);
  for (const [search, expectedCalls] of [['', 0], ['?view=admin', 1]]) {
    let routedCalls = 0;
    new vm.Script(routeSource).runInNewContext({
      URLSearchParams,
      window: { location: { search } },
      openAdminWithGate() { routedCalls += 1; }
    });
    assert.equal(routedCalls, expectedCalls, search || '/m1/');
  }

  assert.match(kiosk, /\$\('#btnAdmin'\)\.addEventListener\('click', openAdminWithGate\);/u);
  assert.doesNotMatch(routeSource, /showAdmin\s*\(/u);
  assert.doesNotMatch(kiosk, /target=["']_blank|window\.open\s*\(/iu);
});

function classList(...initial) {
  const values = new Set(initial);
  return {
    add(...tokens) { tokens.forEach(token => values.add(token)); },
    remove(...tokens) { tokens.forEach(token => values.delete(token)); },
    toggle(token, force) {
      if (force === true) values.add(token);
      else if (force === false) values.delete(token);
      else if (values.has(token)) values.delete(token);
      else values.add(token);
      return values.has(token);
    },
    contains(token) { return values.has(token); }
  };
}

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  let writes = 0;
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { writes += 1; values.set(key, String(value)); },
    removeItem(key) { writes += 1; values.delete(key); },
    clear() { writes += 1; values.clear(); },
    get writes() { return writes; },
    snapshot() { return JSON.stringify([...values.entries()]); }
  };
}

function createSummaryRuntime({ storageEntries = {}, queue = [], device = null, signins = [] } = {}) {
  const summarySource = sourceBetween(kiosk, 'function adminScheduleSummary(', 'const DAY_ABBREV');
  const ids = [
    'admin',
    'adminSummarySchedule', 'adminSummaryScheduleCard',
    'adminSummarySync', 'adminSummarySyncCard',
    'adminSummaryLastSync', 'adminSummaryLastSyncCard',
    'adminSummaryDevice', 'adminSummaryDeviceCard',
    'adminSummarySignins', 'adminSummarySigninsCard'
  ];
  const elements = new Map(ids.map(id => [id, {
    id,
    textContent: '',
    style: id === 'admin' ? { display: 'block' } : {},
    classList: classList()
  }]));
  const storage = memoryStorage({
    gib_m1_local_state_v2: JSON.stringify({ version: 2, ledger: signins, queue }),
    ...storageEntries
  });
  let networkCalls = 0;
  const model = { schedule: null, device };
  const context = vm.createContext({
    $: selector => elements.get(String(selector).replace(/^#/u, '')) || null,
    DEVICE_LABEL_KEY: 'gib_m1_device_label_v1',
    LOCAL_STATE_KEY: 'gib_m1_local_state_v2',
    SIGNINS_KEY: 'gib_m1_signins_v1',
    SYNC_QUEUE_KEY: 'gib_m1_sync_queue_v1',
    fetch() { networkCalls += 1; throw new Error('network forbidden'); },
    loadDevice: () => model.device,
    loadSchedule: () => model.schedule,
    localStorage: storage
  });
  new vm.Script(`
    let canonicalScheduleRuntime = { phase: 'idle' };
    function safeParse(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    }
    ${summarySource}
    globalThis.hooks = {
      adminScheduleSummary,
      renderAdminSummary,
      setPhase(phase) { canonicalScheduleRuntime.phase = phase; }
    };
  `, { filename: 'm1-admin-summary.js' }).runInContext(context);
  return { context, elements, model, storage, get networkCalls() { return networkCalls; } };
}

test('schedule summary follows the authoritative canonical and override states', () => {
  const runtime = createSummaryRuntime();
  const overrideUpdatedAt = '2026-08-10T14:30:00.000Z';
  const savedLabel = new Date(overrideUpdatedAt).toLocaleString();
  const healthy = {
    override: false,
    canonical: { current: true, status: { reason: null, storageWarning: null } }
  };
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary(healthy) },
    { text: 'Website schedule current', tone: 'good' }
  );
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({
      override: false,
      canonical: { current: false, status: { reason: 'network-timeout', storageWarning: null } }
    }) },
    { text: 'Using a safe fallback schedule', tone: 'warn' }
  );
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({
      override: true,
      mode: 'manual',
      updatedAt: overrideUpdatedAt
    }) },
    { text: `Local manual schedule · saved ${savedLabel} · website updates paused`, tone: 'warn' }
  );
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({
      override: true,
      mode: 'url',
      updatedAt: overrideUpdatedAt
    }) },
    { text: `Local URL schedule · saved ${savedLabel} · website updates paused`, tone: 'warn' }
  );
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({
      override: true,
      mode: 'disabled',
      updatedAt: overrideUpdatedAt
    }) },
    { text: `Local disabled schedule · saved ${savedLabel} · website updates paused`, tone: 'warn' }
  );
  runtime.context.hooks.setPhase('loading');
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({ override: false, canonical: null }) },
    { text: 'Checking website schedule', tone: '' }
  );

  assert.match(kiosk, /function renderScheduleStatuses\(schedule = loadSchedule\(\)\)[\s\S]*renderAdminSummary\(schedule\)/u);
  assert.match(kiosk, /const CANONICAL_SCHEDULE_REFRESH_INTERVAL_MS = 10 \* 60 \* 1_000;/u);
  assert.match(kiosk, /window\.setInterval\(refreshCanonicalSchedule, CANONICAL_SCHEDULE_REFRESH_INTERVAL_MS\);/u);
});

test('the five initial status answers read existing state without writes or network', () => {
  const runtime = createSummaryRuntime({
    storageEntries: {
      gib_m1_sync_last: '2026-08-10T14:30:00.000Z',
      gib_m1_device_label_v1: 'QA front tablet'
    },
    queue: [{ RowID: 'gib-row-qa-waiting-0001' }],
    device: { location: 'Fallback device' },
    signins: [
      { RowID: 'gib-row-qa-live-000001', Status: 'OK' },
      { RowID: 'gib-row-qa-void-000001', Status: 'VOID' }
    ]
  });
  runtime.model.schedule = {
    override: false,
    canonical: { current: true, status: { reason: null, storageWarning: null } }
  };
  const before = runtime.storage.snapshot();
  runtime.context.hooks.renderAdminSummary(runtime.model.schedule);

  assert.equal(runtime.elements.get('adminSummarySchedule').textContent, 'Website schedule current');
  assert.equal(runtime.elements.get('adminSummarySync').textContent, '1 row waiting to sync');
  assert.notEqual(runtime.elements.get('adminSummaryLastSync').textContent, 'No confirmed sync yet.');
  assert.equal(runtime.elements.get('adminSummaryDevice').textContent, 'QA front tablet');
  assert.equal(runtime.elements.get('adminSummarySignins').textContent, '1 active sign-in');
  assert.equal(runtime.elements.get('adminSummaryScheduleCard').classList.contains('good'), true);
  assert.equal(runtime.elements.get('adminSummarySyncCard').classList.contains('warn'), true);
  assert.equal(runtime.storage.snapshot(), before);
  assert.equal(runtime.storage.writes, 0);
  assert.equal(runtime.networkCalls, 0);
});

test('opening Admin and toggling disclosures preserve current local state', () => {
  const showAdminSource = sourceBetween(kiosk, 'function showAdmin()', 'function openAdminWithGate()');
  assert.doesNotMatch(showAdminSource, /\b(?:fetch|requestAcknowledgements|syncNow)\s*\(/u);
  assert.doesNotMatch(showAdminSource, /localStorage\.(?:setItem|removeItem|clear)\s*\(/u);

  const storage = memoryStorage({
    gib_m1_local_state_v2: JSON.stringify({
      version: 2,
      ledger: [{ RowID: 'gib-row-qa-live-000001', Status: 'OK' }],
      queue: [{ RowID: 'gib-row-qa-live-000001' }]
    }),
    gib_m1_sync_auto_v1: 'true',
    gib_m1_admin_pin_v1: '1234',
    gib_m1_schedule_v1: '{"source":"manual"}'
  });
  const before = storage.snapshot();
  const ids = [
    'kiosk', 'admin', 'cfgGymName', 'cfgLocation', 'cfgSiteCode', 'debugBox', 'adminHeading',
    'recentSignins', 'staffTimeSection', 'temporaryClassesSection', 'weeklyScheduleSection', 'advancedSettings', 'dangerZone'
  ];
  const elements = new Map(ids.map(id => [id, {
    id,
    value: '',
    open: id === 'recentSignins' || id === 'staffTimeSection',
    style: { display: id === 'admin' ? 'none' : 'block' },
    focus() { this.focused = true; }
  }]));
  const bodyClasses = classList('kiosk-mode');
  const calls = [];
  let networkCalls = 0;
  const context = vm.createContext({
    $: selector => elements.get(String(selector).replace(/^#/u, '')) || null,
    document: { body: { classList: bodyClasses } },
    window: { setTimeout(callback) { callback(); } },
    localStorage: storage,
    organizeAdminView: () => calls.push('organizeAdminView'),
    loadDevice: () => ({ gymName: 'QA Gym', location: 'QA tablet', siteCode: 'TEST' }),
    updateAdminPinUI: () => calls.push('updateAdminPinUI'),
    loadScheduleIntoAdmin: () => calls.push('loadScheduleIntoAdmin'),
    renderDurationRules: () => calls.push('renderDurationRules'),
    renderSeriesList: () => calls.push('renderSeriesList'),
    clearSeriesForm: () => calls.push('clearSeriesForm'),
    renderAdminTable: () => calls.push('renderAdminTable'),
    loadSyncSettings: () => calls.push('loadSyncSettings'),
    updateSyncStatus: () => calls.push('updateSyncStatus'),
    renderAdminSummary: () => calls.push('renderAdminSummary'),
    debugSnapshot: () => ({ safe: true }),
    fetch() { networkCalls += 1; }
  });
  new vm.Script(`${showAdminSource}\nglobalThis.showAdmin = showAdmin;`)
    .runInContext(context);
  context.showAdmin();

  assert.equal(elements.get('kiosk').style.display, 'none');
  assert.equal(elements.get('admin').style.display, 'block');
  assert.equal(bodyClasses.contains('admin-mode'), true);
  assert.equal(elements.get('adminHeading').focused, true);
  assert.deepEqual(calls, [
    'organizeAdminView', 'updateAdminPinUI', 'loadScheduleIntoAdmin', 'renderDurationRules',
    'renderSeriesList', 'clearSeriesForm', 'renderAdminTable', 'loadSyncSettings',
    'updateSyncStatus', 'renderAdminSummary'
  ]);

  for (const id of ['recentSignins', 'staffTimeSection', 'temporaryClassesSection', 'weeklyScheduleSection', 'advancedSettings', 'dangerZone']) {
    elements.get(id).open = !elements.get(id).open;
  }
  assert.equal(storage.snapshot(), before);
  assert.equal(storage.writes, 0);
  assert.equal(networkCalls, 0);
});

test('CSV stays ledger-local with payroll columns and active-row order', () => {
  const buildCsvSource = sourceBetween(kiosk, 'function buildCSV()', 'async function exportCSV()');
  let networkCalls = 0;
  const context = vm.createContext({
    loadSignins: () => [
      {
        RowID: 'gib-row-one', Status: 'OK', Timestamp: '2026-08-10 06:00:07',
        Date: '2026-08-10', 'Class Label': '6:00 AM BJJ', 'Duration (hr)': 1,
        Instructor: 'QA One', Site: 'Rev', Notes: 'first'
      },
      {
        RowID: 'gib-row-void', Status: 'VOID', Timestamp: '2026-08-10 07:00:08',
        Date: '2026-08-10', 'Class Label': 'VOID class', 'Duration (hr)': 1,
        Instructor: 'QA Void', Site: 'Rev', Notes: ''
      },
      {
        RowID: 'gib-row-two', Status: 'OK', Timestamp: '2026-08-10 08:00:09',
        Date: '2026-08-10', 'Class Label': '8:00 AM BJJ', 'Duration (hr)': 1.5,
        Instructor: 'QA Two', Site: 'Rev', Notes: 'second'
      }
    ],
    fetch() { networkCalls += 1; }
  });
  new vm.Script(`${buildCsvSource}\nglobalThis.buildCSV = buildCSV;`)
    .runInContext(context);
  const csv = context.buildCSV();
  assert.equal(csv, [
    'Timestamp,Date,Class Label,Duration (hr),Instructor,Site,Notes',
    '2026-08-10 06:00:07,2026-08-10,6:00 AM BJJ,1,QA One,Rev,first',
    '2026-08-10 08:00:09,2026-08-10,8:00 AM BJJ,1.5,QA Two,Rev,second'
  ].join('\n'));
  assert.equal(networkCalls, 0);
  assert.match(kiosk, /Export CSV compatible with payroll/u);
});

test('Void last changes only the last active row and its matching waiting row', () => {
  const voidSource = sourceBetween(kiosk, 'function voidLastSignin()', '// --- Sync helpers');
  const firstId = 'gib-row-first-000001';
  const priorVoidId = 'gib-row-prior-void-01';
  const lastId = 'gib-row-last-active-01';
  const state = {
    version: 2,
    ledger: [
      { RowID: firstId, Status: 'OK' },
      { RowID: priorVoidId, Status: 'VOID' },
      { RowID: lastId, Status: 'OK' }
    ],
    queue: [{ RowID: firstId }, { RowID: lastId }]
  };
  const stateBefore = structuredClone(state);
  let persisted = null;
  let tableRenders = 0;
  let syncRenders = 0;
  let networkCalls = 0;
  let promptResult = null;
  const context = vm.createContext({
    syncInFlight: false,
    alert: message => assert.fail(message),
    prompt: () => promptResult,
    loadLocalState: () => structuredClone(state),
    fmtTS: () => '2026-08-10 12:00:00',
    persistLocalState(next) { persisted = structuredClone(next); },
    renderAdminTable() { tableRenders += 1; },
    updateSyncStatus() { syncRenders += 1; },
    showToast() {},
    fetch() { networkCalls += 1; }
  });
  new vm.Script(`${voidSource}\nglobalThis.voidLastSignin = voidLastSignin;`)
    .runInContext(context);

  context.voidLastSignin();
  assert.equal(persisted, null);
  assert.deepEqual(state, stateBefore);
  assert.equal(tableRenders, 0);
  assert.equal(syncRenders, 0);
  assert.equal(networkCalls, 0);

  promptResult = 'correction';
  context.voidLastSignin();

  assert.deepEqual(persisted.ledger.map(row => row.RowID), [firstId, priorVoidId, lastId]);
  assert.equal(persisted.ledger[0].Status, 'OK');
  assert.equal(persisted.ledger[1].Status, 'VOID');
  assert.equal(persisted.ledger[2].Status, 'VOID');
  assert.equal(persisted.ledger[2].void_reason, 'correction');
  assert.equal(persisted.ledger[2].voided_at, '2026-08-10 12:00:00');
  assert.deepEqual(persisted.queue.map(row => row.RowID), [firstId]);
  assert.equal(tableRenders, 1);
  assert.equal(syncRenders, 1);
  assert.equal(networkCalls, 0);
});

test('Clear All remains blocked by waiting rows or active sync and still confirms', () => {
  const clearSource = sourceBetween(
    kiosk,
    "$('#btnClearSignins').addEventListener('click'",
    '// Sync field & button listeners'
  );
  const handlers = new Map();
  let queue = [{ RowID: 'gib-row-waiting-0001' }];
  let confirmResult = true;
  let confirms = 0;
  let alerts = 0;
  let saves = 0;
  let renders = 0;
  let networkCalls = 0;
  const context = vm.createContext({
    syncInFlight: false,
    $: selector => ({
      addEventListener(type, handler) { handlers.set(`${selector}:${type}`, handler); }
    }),
    loadSyncQueue: () => queue,
    alert(message) {
      assert.match(message, /Waiting rows must be confirmed or individually voided/u);
      alerts += 1;
    },
    confirm() { confirms += 1; return confirmResult; },
    saveSignins(rows) { assert.equal(Array.isArray(rows) && rows.length === 0, true); saves += 1; },
    renderAdminTable() { renders += 1; },
    showToast() {},
    fetch() { networkCalls += 1; }
  });
  new vm.Script(clearSource, { filename: 'm1-clear-signins.js' }).runInContext(context);
  const handler = handlers.get('#btnClearSignins:click');
  assert.equal(typeof handler, 'function');

  handler();
  assert.equal(alerts, 1);
  assert.equal(confirms, 0);
  queue = [];
  context.syncInFlight = true;
  handler();
  assert.equal(alerts, 2);
  assert.equal(confirms, 0);
  context.syncInFlight = false;
  confirmResult = false;
  handler();
  assert.equal(confirms, 1);
  assert.equal(saves, 0);
  confirmResult = true;
  handler();
  assert.equal(confirms, 2);
  assert.equal(saves, 1);
  assert.equal(renders, 1);
  assert.equal(networkCalls, 0);
});

test('Reset and Factory reset retain their existing confirmation protections', () => {
  const deviceActions = sourceBetween(kiosk, '// Device actions', '// Admin PIN actions');
  const handlers = new Map();
  const elements = new Map();
  let confirmResult = false;
  let promptResult = '';
  let resets = 0;
  let factoryResets = 0;
  let cancelledAlerts = 0;
  let syncSettingsLoads = 0;
  let syncStatusRenders = 0;
  let networkCalls = 0;
  const context = vm.createContext({
    $: selector => {
      if (!elements.has(selector)) {
        elements.set(selector, {
          value: '',
          innerHTML: '',
          addEventListener(type, handler) { handlers.set(`${selector}:${type}`, handler); }
        });
      }
      return elements.get(selector);
    },
    confirm: () => confirmResult,
    prompt: () => promptResult,
    alert(message) {
      assert.equal(message, 'Factory reset cancelled');
      cancelledAlerts += 1;
    },
    resetDevice() { resets += 1; },
    factoryReset() { factoryResets += 1; },
    loadSyncSettings() { syncSettingsLoads += 1; },
    updateSyncStatus() { syncStatusRenders += 1; },
    saveDevice() {},
    applyDeviceToUI() {},
    renderAdminSummary() {},
    showToast() {},
    fetch() { networkCalls += 1; }
  });
  new vm.Script(deviceActions, { filename: 'm1-device-actions.js' }).runInContext(context);

  handlers.get('#btnResetDevice:click')();
  assert.equal(resets, 0);
  confirmResult = true;
  handlers.get('#btnResetDevice:click')();
  assert.equal(resets, 1);
  assert.match(elements.get('#deviceStatus').innerHTML, /Device reset/u);

  handlers.get('#btnFactoryReset:click')();
  assert.equal(factoryResets, 0);
  assert.equal(cancelledAlerts, 1);
  promptResult = 'RESET';
  handlers.get('#btnFactoryReset:click')();
  assert.equal(factoryResets, 1);
  assert.match(elements.get('#deviceStatus').innerHTML, /Factory reset complete/u);
  assert.equal(syncSettingsLoads, 2);
  assert.equal(syncStatusRenders, 2);
  assert.equal(networkCalls, 0);
});

test('Reset discloses its full scope, cancel mutates nothing, and confirm preserves sign-ins and queue', () => {
  const resetSource = sourceBetween(
    kiosk,
    'function resetDevice()',
    '// Remove all GiB/M1 and legacy RBJJ keys'
  );
  const deviceActions = sourceBetween(kiosk, '// Device actions', '// Admin PIN actions');
  const handlers = new Map();
  const elements = new Map();
  const localStateBytes = JSON.stringify({
    version: 2,
    ledger: [{ RowID: 'gib-row-preserved-ledger' }],
    queue: [{ RowID: 'gib-row-preserved-waiting' }]
  });
  const initialEntries = {
    gib_m1_local_state_v2: localStateBytes,
    gib_m1_signins_v1: '[{"RowID":"gib-row-preserved-ledger"}]',
    gib_m1_sync_queue_v1: '[{"RowID":"gib-row-preserved-waiting"}]',
    gib_m1_device_v1: '{"location":"Rev"}',
    gib_m1_device_label_v1: 'Rev front tablet',
    gib_m1_admin_pin_v1: '7319',
    gib_m1_instructor_names_v1: '["Andrew"]',
    gib_m1_sync_auto_v1: 'true',
    gib_m1_sync_last: '2026-08-10T14:30:00.000Z',
    gib_m1_sync_error: 'waiting',
    gib_m1_schedule_v1: '{"Monday":[]}',
    gib_m1_schedule_url_v1: 'https://example.invalid/schedule.json',
    gib_m1_schedule_mode_v1: 'manual',
    gib_m1_canonical_schedule_cache_v1: '{"version":"cached"}',
    gib_m1_series_v1: '[{"label":"Temporary"}]',
    gib_m1_duration_rules_v1: '[{"match":"BJJ","duration":1}]',
    unrelated_application_key: 'preserve me'
  };
  const localStorage = {};
  Object.defineProperties(localStorage, {
    getItem: {
      value(key) { return Object.hasOwn(this, key) ? this[key] : null; }
    },
    setItem: {
      value(key, value) { this[key] = String(value); }
    },
    removeItem: {
      value(key) { delete this[key]; }
    },
    snapshot: {
      value() {
        return Object.fromEntries(Object.keys(this).sort().map(key => [key, this[key]]));
      }
    }
  });
  Object.assign(localStorage, initialEntries);
  const before = localStorage.snapshot();

  let confirmResult = false;
  let confirmation = '';
  let uiRefreshes = 0;
  const context = vm.createContext({
    DEVICE_KEY: 'gib_m1_device_v1',
    SCHEDULE_KEY: 'gib_m1_schedule_v1',
    DURATION_RULES_KEY: 'gib_m1_duration_rules_v1',
    SERIES_KEY: 'gib_m1_series_v1',
    SIGNINS_KEY: 'gib_m1_signins_v1',
    SYNC_QUEUE_KEY: 'gib_m1_sync_queue_v1',
    LOCAL_STATE_KEY: 'gib_m1_local_state_v2',
    OLD_SIGNINS_KEYS: ['rbjj_signins_v2', 'rbjj_signins_roster_mode_v1'],
    localStorage,
    document: {
      getElementById() { return { value: 'configured' }; }
    },
    $: selector => {
      if (!elements.has(selector)) {
        elements.set(selector, {
          value: '',
          innerHTML: '',
          addEventListener(type, handler) { handlers.set(`${selector}:${type}`, handler); }
        });
      }
      return elements.get(selector);
    },
    confirm(message) { confirmation = message; return confirmResult; },
    prompt: () => '',
    alert() {},
    saveDevice() {},
    factoryReset() {},
    renderAdminSummary() {},
    applyDeviceToUI() { uiRefreshes += 1; },
    loadScheduleIntoAdmin() { uiRefreshes += 1; },
    renderDurationRules() { uiRefreshes += 1; },
    populateClassesForToday() { uiRefreshes += 1; },
    loadSyncSettings() { uiRefreshes += 1; },
    updateSyncStatus() { uiRefreshes += 1; },
    showToast() {}
  });
  new vm.Script(`${resetSource}\n${deviceActions}`, { filename: 'm1-executed-reset-device.js' })
    .runInContext(context);
  const resetHandler = handlers.get('#btnResetDevice:click');
  assert.equal(typeof resetHandler, 'function');

  resetHandler();
  assert.deepEqual(localStorage.snapshot(), before);
  assert.equal(uiRefreshes, 0);
  for (const expected of [
    /device label\/location\/site\/setup/u,
    /Admin PIN/u,
    /instructor roster/u,
    /auto-sync and sync status/u,
    /schedule, temporary classes, website schedule cache\/local overrides/u,
    /duration rules/u,
    /Sign-ins and rows waiting to sync are NOT deleted\. Staff Clock punches and its waiting list are also NOT deleted\./u
  ]) assert.match(confirmation, expected);

  confirmResult = true;
  resetHandler();
  assert.equal(localStorage.getItem('gib_m1_local_state_v2'), localStateBytes);
  assert.equal(localStorage.getItem('gib_m1_signins_v1'), initialEntries.gib_m1_signins_v1);
  assert.equal(localStorage.getItem('gib_m1_sync_queue_v1'), initialEntries.gib_m1_sync_queue_v1);
  assert.equal(localStorage.getItem('unrelated_application_key'), 'preserve me');
  for (const key of Object.keys(initialEntries)) {
    if (
      key !== 'gib_m1_local_state_v2'
      && key !== 'gib_m1_signins_v1'
      && key !== 'gib_m1_sync_queue_v1'
      && key !== 'unrelated_application_key'
    ) assert.equal(localStorage.getItem(key), null, key);
  }
  assert.ok(uiRefreshes > 0);
});

test('legacy-only ledgers remain visible and survive Reset before verified reload migration', async t => {
  const storageSource = sourceBetween(kiosk, '// Storage helpers', '// Normalize day keys');
  const resetSource = sourceBetween(
    kiosk,
    'function resetDevice()',
    '// Remove all GiB/M1 and legacy RBJJ keys'
  );
  const snapshotSource = sourceBetween(
    kiosk,
    'function readAdminLocalStateSnapshot()',
    'function setAdminSummaryValue'
  );
  const deviceActions = sourceBetween(kiosk, '// Device actions', '// Admin PIN actions');
  const legacyKeys = ['rbjj_signins_v2', 'rbjj_signins_roster_mode_v1'];

  for (const legacyKey of legacyKeys) {
    await t.test(legacyKey, () => {
      const handlers = new Map();
      const elements = new Map();
      const legacyRows = [{
        Timestamp: '2026-08-10 18:30:00',
        Date: '2026-08-10',
        'Class Label': '6:30 PM BJJ (Level 2)',
        'Duration (hr)': 1,
        Instructor: 'Legacy Instructor One',
        Site: 'Rev',
        Notes: 'Already synced legacy history',
        Status: 'OK'
      }, {
        Timestamp: '2026-08-10 19:00:00',
        Date: '2026-08-10',
        'Class Label': '7:00 PM BJJ (Level 2)',
        'Duration (hr)': 1,
        Instructor: 'Legacy Instructor Two',
        Site: 'Rev',
        Notes: 'Waiting legacy history',
        Status: 'OK'
      }];
      const waitingRows = [{ ...legacyRows[1], Device: 'Rev front tablet' }];
      const legacyBytes = JSON.stringify(legacyRows);
      const queueBytes = JSON.stringify(waitingRows);
      const intendedSettings = {
        gib_m1_device_v1: '{"location":"Rev"}',
        gib_m1_device_label_v1: 'Rev front tablet',
        gib_m1_admin_pin_v1: '7319',
        gib_m1_instructor_names_v1: '["Legacy Instructor One","Legacy Instructor Two"]',
        gib_m1_sync_auto_v1: 'true',
        gib_m1_sync_last: '2026-08-10T23:01:00.000Z',
        gib_m1_sync_error: 'waiting',
        gib_m1_schedule_v1: '{"days":{"Monday":[]}}',
        gib_m1_schedule_url_v1: 'https://example.invalid/schedule.json',
        gib_m1_schedule_mode_v1: 'manual',
        gib_m1_canonical_schedule_cache_v1: '{"version":"cached"}',
        gib_m1_series_v1: '[{"label":"Temporary"}]',
        gib_m1_duration_rules_v1: '[{"match":"BJJ","duration":1}]',
        rbjj_schedule_v1: '{"Monday":[]}'
      };
      const localStorage = {};
      Object.defineProperties(localStorage, {
        getItem: {
          value(key) { return Object.hasOwn(this, key) ? this[key] : null; }
        },
        setItem: {
          value(key, value) { this[key] = String(value); }
        },
        removeItem: {
          value(key) { delete this[key]; }
        },
        snapshot: {
          value() {
            return Object.fromEntries(Object.keys(this).sort().map(key => [key, this[key]]));
          }
        }
      });
      Object.assign(localStorage, {
        [legacyKey]: legacyBytes,
        gib_m1_sync_queue_v1: queueBytes,
        ...intendedSettings,
        unrelated_application_key: 'preserve me'
      });
      assert.equal(localStorage.getItem('gib_m1_local_state_v2'), null);
      assert.equal(localStorage.getItem('gib_m1_signins_v1'), null);

      let confirmResult = false;
      let generatedId = 0;
      const context = vm.createContext({
        SIGNINS_KEY: 'gib_m1_signins_v1',
        SYNC_QUEUE_KEY: 'gib_m1_sync_queue_v1',
        LOCAL_STATE_KEY: 'gib_m1_local_state_v2',
        OLD_SIGNINS_KEYS: legacyKeys,
        DEVICE_KEY: 'gib_m1_device_v1',
        SCHEDULE_KEY: 'gib_m1_schedule_v1',
        DURATION_RULES_KEY: 'gib_m1_duration_rules_v1',
        SERIES_KEY: 'gib_m1_series_v1',
        localStorage,
        createPermanentRowId() {
          generatedId += 1;
          return `gib-m1-00000000-0000-4000-8000-${String(generatedId).padStart(12, '0')}`;
        },
        validPermanentRowId: syncCore.validPermanentRowId,
        validLocalState: syncCore.validLocalState,
        document: {
          getElementById() { return { value: 'configured' }; }
        },
        $: selector => {
          if (!elements.has(selector)) {
            elements.set(selector, {
              value: '',
              innerHTML: '',
              addEventListener(type, handler) { handlers.set(`${selector}:${type}`, handler); }
            });
          }
          return elements.get(selector);
        },
        confirm() { return confirmResult; },
        prompt: () => '',
        alert() {},
        saveDevice() {},
        factoryReset() {},
        renderAdminSummary() {},
        applyDeviceToUI() {},
        loadScheduleIntoAdmin() {},
        renderDurationRules() {},
        populateClassesForToday() {},
        loadSyncSettings() {},
        updateSyncStatus() {},
        showToast() {}
      });
      new vm.Script(
        `${storageSource}\n${snapshotSource}\n${resetSource}\n${deviceActions}`,
        { filename: `m1-legacy-reset-${legacyKey}.js` }
      ).runInContext(context);

      const visibleBeforeReset = vm.runInContext('readAdminLocalStateSnapshot()', context);
      assert.equal(visibleBeforeReset.ledger.length, legacyRows.length);
      assert.equal(visibleBeforeReset.queue.length, waitingRows.length);
      const resetHandler = handlers.get('#btnResetDevice:click');
      assert.equal(typeof resetHandler, 'function');

      const beforeCancel = localStorage.snapshot();
      resetHandler();
      assert.deepEqual(localStorage.snapshot(), beforeCancel, 'cancel must be byte-identical');

      confirmResult = true;
      resetHandler();
      assert.equal(localStorage.getItem(legacyKey), legacyBytes);
      assert.equal(localStorage.getItem('gib_m1_sync_queue_v1'), queueBytes);
      assert.equal(localStorage.getItem('unrelated_application_key'), 'preserve me');
      for (const key of Object.keys(intendedSettings)) {
        assert.equal(localStorage.getItem(key), null, `${key} should be cleared`);
      }
      const visibleAfterReset = vm.runInContext('readAdminLocalStateSnapshot()', context);
      assert.equal(visibleAfterReset.ledger.length, legacyRows.length);
      assert.equal(visibleAfterReset.queue.length, waitingRows.length);

      const migrated = vm.runInContext('loadLocalState()', context);
      assert.equal(migrated.ledger.length, legacyRows.length);
      assert.equal(migrated.queue.length, waitingRows.length);
      assert.equal(migrated.ledger[1].RowID, migrated.queue[0].RowID);
      const reloaded = vm.runInContext('loadLocalState()', context);
      assert.equal(reloaded.ledger.length, legacyRows.length);
      assert.equal(reloaded.queue.length, waitingRows.length);
      assert.equal(JSON.parse(localStorage.getItem('gib_m1_signins_v1')).length, legacyRows.length);
      assert.equal(localStorage.getItem(legacyKey), legacyBytes);
    });
  }
});

test('Admin organization adds no write path and preserves PR55 rollover and sync wiring', () => {
  const summarySource = sourceBetween(kiosk, 'function adminScheduleSummary(', 'const DAY_ABBREV');
  const organizerSource = sourceBetween(kiosk, 'let adminViewOrganized = false;', '// UI helpers');
  const showAdminSource = sourceBetween(kiosk, 'function showAdmin()', 'function openAdminWithGate()');
  const adminSource = [summarySource, organizerSource, showAdminSource].join('\n');
  assert.doesNotMatch(adminSource, /fetch\s*\(|requestAcknowledgements\s*\(|syncNow\s*\(/u);
  assert.doesNotMatch(adminSource, /localStorage\.(?:setItem|removeItem|clear)\s*\(/u);
  assert.doesNotMatch(adminSource, /script\.google\.com|googleapis\.com|\/api\/m1-kiosk-sync/iu);

  assert.match(kiosk, /formatTimestampInTimeZone\(d, TZ\)/u);
  assert.match(kiosk, /dayRolloverController = createDayRolloverController\(\{/u);
  assert.match(kiosk, /isFormInProgress: kioskFormInProgress/u);
  assert.match(kiosk, /if \(dayRolloverController\) return dayRolloverController\.requestRefresh\(\);/u);
  assert.match(kiosk, /appendBatchToState\(loadLocalState\(\), ledgerRows, queuedRows\)[\s\S]*persistLocalState\(state\)/u);
  assert.match(kiosk, /function renderAdminTable\(\)[\s\S]*readAdminLocalStateSnapshot\(\)\.ledger/u);
  assert.match(kiosk, /function updateSyncStatus\(\)[\s\S]*readAdminLocalStateSnapshot\(\)\.queue/u);
});
