import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const kiosk = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');

const BASELINE_BUTTON_IDS = Object.freeze([
  'btnAdmin',
  'toggleClasses',
  'btnSignIn',
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

const ADMIN_CLICK_IDS = Object.freeze([
  'btnKiosk',
  'btnAdmin',
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
  'btnCancelAdminPin',
  'btnConfirmAdminPin'
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
    contains(token) { return values.has(token); },
    snapshot() { return [...values].sort(); }
  };
}

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  let writes = 0;
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { writes += 1; values.set(key, String(value)); },
    removeItem(key) { writes += 1; values.delete(key); },
    clear() { writes += 1; values.clear(); },
    get writes() { return writes; },
    snapshot() { return JSON.stringify([...values.entries()]); }
  };
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

test('default Admin document is status-first with calm native disclosures', () => {
  const admin = sourceBetween(kiosk, '<!-- ADMIN -->', '<div id="toast"');
  const summaryIndex = admin.indexOf('id="adminStatusHeading"');
  const actionsIndex = admin.indexOf('id="adminActionsHeading"');
  const recentIndex = admin.indexOf('id="recentSignins"');
  const temporaryIndex = admin.indexOf('id="temporaryClassesSection"');
  const weeklyIndex = admin.indexOf('id="weeklyScheduleSection"');
  const advancedIndex = admin.indexOf('id="advancedSettings"');
  const dangerIndex = admin.indexOf('id="dangerZone"');

  assert.match(admin, /<h2 id="adminHeading"[^>]*>M1 Admin<\/h2>/u);
  assert.match(admin, /id="btnKiosk"[^>]*>Return to Instructor Sign-In<\/button>/u);
  assert.match(admin, /id="btnAdminLogout"[^>]*>Log out Admin<\/button>/u);
  assert.ok(summaryIndex < actionsIndex);
  assert.ok(actionsIndex < recentIndex);
  assert.ok(recentIndex < temporaryIndex);
  assert.ok(temporaryIndex < weeklyIndex);
  assert.ok(weeklyIndex < advancedIndex);
  assert.ok(advancedIndex < dangerIndex);

  for (const [id, label] of [
    ['temporaryClassesSection', 'Temporary classes'],
    ['weeklyScheduleSection', 'Weekly schedule'],
    ['advancedSettings', 'Advanced settings'],
    ['dangerZone', 'Danger zone']
  ]) {
    assert.doesNotMatch(openingTag(id), /\sopen(?:\s|=|>)/u, `${id} must start closed`);
    assert.match(admin, new RegExp(`<details id="${id}"[\\s\\S]*?<summary>${label}<\\/summary>`, 'u'));
  }
  assert.match(openingTag('recentSignins'), /\sopen(?:\s|=|>)/u);
  for (const id of ['manualScheduleSettings', 'durationRulesSettings', 'troubleshootingSettings']) {
    assert.doesNotMatch(openingTag(id), /\sopen(?:\s|=|>)/u, `${id} must start closed`);
  }

  const dangerSummary = sourceBetween(admin, '<details id="dangerZone"', '<div class="admin-disclosure-body">');
  assert.match(dangerSummary, /<summary>Danger zone<\/summary>/u);
  assert.doesNotMatch(dangerSummary, /<button|onclick=|ontoggle=/iu);
  assert.doesNotMatch(kiosk, /addEventListener\(['"]toggle['"]/u);
});

test('every baseline control remains unique and every Admin button stays bound', () => {
  assert.deepEqual(elementIds(['button']), [...BASELINE_BUTTON_IDS]);
  assert.deepEqual(elementIds(['input', 'select', 'textarea', 'datalist']), [...BASELINE_FIELD_IDS]);
  assert.equal((kiosk.match(/<input[^>]*\bdata-series-day\b[^>]*>/giu) || []).length, 7);

  for (const id of [...BASELINE_BUTTON_IDS, ...BASELINE_FIELD_IDS]) {
    assert.equal((kiosk.match(new RegExp(`\\bid="${escapeRegExp(id)}"`, 'gu')) || []).length, 1, id);
  }
  for (const id of ADMIN_CLICK_IDS) {
    const pattern = new RegExp(`\\$\\('#${escapeRegExp(id)}'\\)\\.addEventListener\\('click'`, 'gu');
    assert.equal((kiosk.match(pattern) || []).length, 1, `${id} lost or duplicated its click binding`);
  }

  for (const [id, action] of [
    ['btnKiosk', 'showKiosk'],
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

  for (const [id, effect] of [
    ['btnSaveDevice', 'saveDevice\\(cfg\\)'],
    ['btnResetDevice', 'resetDevice\\(\\)'],
    ['btnFactoryReset', 'factoryReset\\(\\)'],
    ['btnSaveAdminPin', 'setAdminPin\\(nextPin\\)'],
    ['btnSaveSchedule', "saveSchedule\\(scheduleDraft, 'manual'\\)"],
    ['btnAddDurationRule', 'saveDurationRules\\(rules\\)'],
    ['btnGenerateDurationRules', 'generateDurationRulesFromSchedule\\(\\)'],
    ['btnClearSchedule', 'refreshCanonicalSchedule\\(\\)'],
    ['btnDisableSchedule', "saveSchedule\\(empty, 'disabled'\\)"],
    ['btnAddSeries', 'addSeriesFromForm\\(\\)'],
    ['btnClearSeriesForm', 'clearSeriesForm\\(\\)'],
    ['btnLoadScheduleUrl', 'saveSchedule\\(validateCanonicalDays\\(data\\.days\\), \'url\'\\)'],
    ['btnClearSignins', 'saveSignins\\(\\[\\]\\)']
  ]) {
    assert.match(
      kiosk,
      new RegExp(`\\$\\('#${id}'\\)\\.addEventListener\\('click',[\\s\\S]{0,1800}?${effect}`, 'u'),
      `${id} lost its original action`
    );
  }
});

test('organizeAdminView reparents the same live controls into the intended sections exactly once', () => {
  const organizer = sourceBetween(kiosk, 'let adminViewOrganized = false;', '// UI helpers');
  assert.match(organizer, /\['btnSyncNow', 'btnExport', 'btnVoidLast'\]/u);
  for (const [elementId, targetId] of Object.entries(REPARENT_MAP)) {
    if (targetId === 'dangerZoneActions') continue;
    assert.match(organizer, new RegExp(`moveAdminElement\\('${elementId}', '${targetId}'\\)`, 'u'));
  }
  assert.match(
    organizer,
    /\['btnResetDevice', 'btnFactoryReset', 'btnClearSignins', 'btnDisableSchedule'\][\s\S]*moveAdminElement\(id, 'dangerZoneActions'\)/u
  );

  const ids = new Set([
    ...Object.keys(REPARENT_MAP),
    ...Object.values(REPARENT_MAP),
    'adminPrimaryActions',
    'recentSigninsLink',
    'btnSyncNow',
    'btnExport',
    'btnVoidLast'
  ]);
  const nodes = new Map([...ids].map(id => [id, new FakeNode(id)]));
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
    ['btnSyncNow', 'btnExport', 'btnVoidLast', 'recentSigninsLink']
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

function createSummaryRuntime({ storageEntries = {}, queue = [], device = null, signins = [] } = {}) {
  const summarySource = sourceBetween(kiosk, 'function adminScheduleSummary(', 'const DAY_ABBREV');
  const elementIds = [
    'admin',
    'adminSummarySchedule', 'adminSummaryScheduleCard',
    'adminSummarySync', 'adminSummarySyncCard',
    'adminSummaryLastSync', 'adminSummaryLastSyncCard',
    'adminSummaryDevice', 'adminSummaryDeviceCard',
    'adminSummarySignins', 'adminSummarySigninsCard'
  ];
  const elements = new Map(elementIds.map(id => [id, {
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
  const model = { schedule: null, queue, device, signins };
  const context = vm.createContext({
    $: selector => elements.get(String(selector).replace(/^#/u, '')) || null,
    DEVICE_LABEL_KEY: 'gib_m1_device_label_v1',
    fetch() { networkCalls += 1; throw new Error('network forbidden'); },
    loadDevice: () => model.device,
    loadSchedule: () => model.schedule,
    LOCAL_STATE_KEY: 'gib_m1_local_state_v2',
    SIGNINS_KEY: 'gib_m1_signins_v1',
    SYNC_QUEUE_KEY: 'gib_m1_sync_queue_v1',
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

test('schedule summary wording distinguishes website, fallback, local override, and disabled modes', () => {
  const runtime = createSummaryRuntime();
  const healthy = {
    override: false,
    canonical: { current: true, status: { reason: null, storageWarning: null } }
  };
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary(healthy) },
    { text: 'Website schedule current', tone: 'good' }
  );

  const fallback = {
    override: false,
    canonical: { current: false, status: { reason: 'network-timeout', storageWarning: null } }
  };
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary(fallback) },
    { text: 'Using a safe fallback schedule', tone: 'warn' }
  );
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({ override: true, mode: 'manual' }) },
    { text: 'Local schedule in use', tone: 'warn' }
  );
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({ override: true, mode: 'disabled' }) },
    { text: 'Schedule disabled on this device', tone: 'warn' }
  );
  runtime.context.hooks.setPhase('loading');
  assert.deepEqual(
    { ...runtime.context.hooks.adminScheduleSummary({ override: false, canonical: null }) },
    { text: 'Checking website schedule', tone: '' }
  );

  assert.match(kiosk, /Website schedule updates are paused on this device\./u);
  assert.match(kiosk, /renderScheduleStatuses\(schedule = loadSchedule\(\)\)[\s\S]*renderAdminSummary\(schedule\)/u);
});

test('renderAdminSummary uses existing state only and exposes the five useful answers', () => {
  const active = {
    RowID: 'gib-m1-00000000-0000-4000-8000-000000000001',
    Status: 'OK'
  };
  const runtime = createSummaryRuntime({
    storageEntries: {
      gib_m1_device_label_v1: 'QA front tablet',
      gib_m1_sync_last: '2026-08-09T13:00:00.000Z'
    },
    queue: [{ RowID: active.RowID }],
    device: { location: 'Fallback location' },
    signins: [active, { ...active, RowID: 'void-row', Status: 'VOID' }]
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

  const empty = createSummaryRuntime();
  empty.model.schedule = { override: true, mode: 'manual' };
  empty.context.hooks.renderAdminSummary(empty.model.schedule);
  assert.equal(empty.elements.get('adminSummarySchedule').textContent, 'Local schedule in use');
  assert.equal(empty.elements.get('adminSummarySync').textContent, '0 rows waiting to sync');
  assert.equal(empty.elements.get('adminSummaryLastSync').textContent, 'No confirmed sync yet.');
  assert.equal(empty.elements.get('adminSummaryDevice').textContent, 'Not configured.');
  assert.equal(empty.elements.get('adminSummarySignins').textContent, '0 active sign-ins');
  assert.equal(empty.storage.writes, 0);
  assert.equal(empty.networkCalls, 0);
});

test('opening Admin and opening or closing its disclosures mutate no local state and make no request', () => {
  const showAdminSource = sourceBetween(kiosk, 'function showAdmin()', '// Toggle class list');
  assert.doesNotMatch(showAdminSource, /\b(?:fetch|requestAcknowledgements|syncNow)\s*\(/u);
  assert.doesNotMatch(showAdminSource, /localStorage\.(?:setItem|removeItem|clear)\s*\(/u);

  const protectedEntries = {
    gib_m1_local_state_v2: JSON.stringify({
      version: 2,
      ledger: [{ RowID: 'gib-m1-00000000-0000-4000-8000-000000000001', Status: 'OK' }],
      queue: [{ RowID: 'gib-m1-00000000-0000-4000-8000-000000000002' }]
    }),
    gib_m1_signins_v1: '[{"RowID":"gib-m1-canary","Status":"OK"}]',
    gib_m1_sync_queue_v1: '[{"RowID":"gib-m1-waiting"}]',
    gib_m1_sync_auto_v1: 'false',
    gib_m1_sync_last: '2026-08-09T13:00:00.000Z',
    gib_m1_sync_error: '',
    gib_m1_device_v1: '{"gymName":"QA Gym","location":"QA tablet","siteCode":"TEST"}',
    gib_m1_device_label_v1: 'QA tablet',
    gib_m1_schedule_v1: '{"source":"manual","days":{}}',
    gib_m1_schedule_url_v1: 'https://example.test/schedule.json',
    gib_m1_schedule_mode_v1: 'manual',
    gib_m1_canonical_schedule_cache_v1: '{"version":"canary"}',
    gib_m1_series_v1: '[{"id":"series-canary"}]',
    gib_m1_duration_rules_v1: '[{"match":"Kids","duration":0.5}]',
    gib_m1_instructor_names_v1: '["QA Test Instructor"]',
    gib_m1_admin_pin_v1: '1234'
  };
  const storage = memoryStorage(protectedEntries);
  const elements = new Map();
  for (const id of [
    'kiosk', 'admin', 'cfgGymName', 'cfgLocation', 'cfgSiteCode', 'debugBox', 'adminHeading',
    'recentSignins', 'temporaryClassesSection', 'weeklyScheduleSection', 'advancedSettings', 'dangerZone'
  ]) {
    elements.set(id, {
      id,
      open: id === 'recentSignins',
      style: {},
      value: '',
      focused: false,
      focus() { this.focused = true; }
    });
  }
  const bodyClasses = classList('kiosk-mode');
  let networkCalls = 0;
  const calls = [];
  const context = vm.createContext({
    $: selector => elements.get(String(selector).replace(/^#/u, '')) || null,
    clearSeriesForm: () => calls.push('clearSeriesForm'),
    debugSnapshot: () => ({ safe: true }),
    document: { body: { classList: bodyClasses } },
    fetch() { networkCalls += 1; throw new Error('network forbidden'); },
    loadDevice: () => ({ gymName: 'QA Gym', location: 'QA tablet', siteCode: 'TEST' }),
    loadScheduleIntoAdmin: () => calls.push('loadScheduleIntoAdmin'),
    loadSyncSettings: () => calls.push('loadSyncSettings'),
    localStorage: storage,
    organizeAdminView: () => calls.push('organizeAdminView'),
    renderAdminSummary: () => calls.push('renderAdminSummary'),
    renderAdminTable: () => calls.push('renderAdminTable'),
    renderDurationRules: () => calls.push('renderDurationRules'),
    renderSeriesList: () => calls.push('renderSeriesList'),
    requestAcknowledgements() { networkCalls += 1; throw new Error('sync forbidden'); },
    syncNow() { networkCalls += 1; throw new Error('sync forbidden'); },
    updateAdminPinUI: () => calls.push('updateAdminPinUI'),
    updateSyncStatus: () => calls.push('updateSyncStatus'),
    window: { setTimeout(callback) { callback(); return 1; } }
  });
  new vm.Script(`
    ${showAdminSource}
    globalThis.hooks = { showAdmin };
  `, { filename: 'm1-show-admin.js' }).runInContext(context);

  const before = storage.snapshot();
  context.hooks.showAdmin();
  assert.equal(elements.get('kiosk').style.display, 'none');
  assert.equal(elements.get('admin').style.display, 'block');
  assert.equal(bodyClasses.contains('kiosk-mode'), false);
  assert.equal(bodyClasses.contains('admin-mode'), true);
  assert.equal(elements.get('cfgGymName').value, 'QA Gym');
  assert.equal(elements.get('cfgLocation').value, 'QA tablet');
  assert.equal(elements.get('cfgSiteCode').value, 'TEST');
  assert.equal(elements.get('adminHeading').focused, true);
  for (const expected of [
    'organizeAdminView', 'updateAdminPinUI', 'loadScheduleIntoAdmin', 'renderDurationRules',
    'renderSeriesList', 'clearSeriesForm', 'renderAdminTable', 'loadSyncSettings',
    'updateSyncStatus', 'renderAdminSummary'
  ]) assert.ok(calls.includes(expected), expected);

  for (const id of ['recentSignins', 'temporaryClassesSection', 'weeklyScheduleSection', 'advancedSettings', 'dangerZone']) {
    elements.get(id).open = !elements.get(id).open;
    elements.get(id).open = !elements.get(id).open;
  }
  assert.equal(storage.snapshot(), before);
  assert.equal(storage.writes, 0);
  assert.equal(networkCalls, 0);

  let recentHandler = null;
  const recentSource = sourceBetween(
    kiosk,
    "$('#recentSigninsLink').addEventListener('click'",
    "$('#btnSignIn').addEventListener('click'"
  );
  const linkContext = vm.createContext({
    $: selector => selector === '#recentSigninsLink'
      ? { addEventListener(_type, handler) { recentHandler = handler; } }
      : elements.get(String(selector).replace(/^#/u, ''))
  });
  new vm.Script(recentSource, { filename: 'm1-recent-signins-link.js' }).runInContext(linkContext);
  elements.get('recentSignins').open = false;
  recentHandler();
  assert.equal(elements.get('recentSignins').open, true);
  assert.equal(storage.snapshot(), before);
  assert.equal(networkCalls, 0);
});

test('real CSV builder preserves payroll columns, active-row order, and local-only behavior', () => {
  const buildCsvSource = sourceBetween(kiosk, 'function buildCSV()', 'async function exportCSV()');
  const rows = [
    {
      RowID: 'row-one', Timestamp: '2026-08-09 09:00:00', Date: '2026-08-09',
      'Class Label': 'TEST, "Quoted" BJJ', 'Duration (hr)': 1, Instructor: 'First',
      Site: 'TEST', Notes: 'safe', Status: 'OK'
    },
    {
      RowID: 'row-void', Timestamp: '2026-08-09 10:00:00', Date: '2026-08-09',
      'Class Label': 'VOID class', 'Duration (hr)': 1, Instructor: 'Hidden',
      Site: 'TEST', Notes: '', Status: 'VOID'
    },
    {
      RowID: 'row-two', Timestamp: '2026-08-09 11:00:00', Date: '2026-08-09',
      'Class Label': 'TEST Judo', 'Duration (hr)': 0.5, Instructor: 'Second',
      Site: 'TEST', Notes: 'line one\nline two', Status: 'OK'
    }
  ];
  let networkCalls = 0;
  const context = vm.createContext({
    fetch() { networkCalls += 1; throw new Error('network forbidden'); },
    loadSignins: () => rows,
    requestAcknowledgements() { networkCalls += 1; throw new Error('sync forbidden'); }
  });
  new vm.Script(`${buildCsvSource}\nglobalThis.buildCSV = buildCSV;`, {
    filename: 'm1-build-csv.js'
  }).runInContext(context);
  const csv = context.buildCSV();
  assert.equal(csv, [
    'Timestamp,Date,Class Label,Duration (hr),Instructor,Site,Notes',
    '2026-08-09 09:00:00,2026-08-09,"TEST, ""Quoted"" BJJ",1,First,TEST,safe',
    '2026-08-09 11:00:00,2026-08-09,TEST Judo,0.5,Second,TEST,"line one\nline two"'
  ].join('\n'));
  assert.doesNotMatch(csv, /row-one|row-two|row-void|VOID class/u);
  assert.equal(networkCalls, 0);
});

test('real VOID behavior changes only the last active row and its matching waiting row', () => {
  const voidSource = sourceBetween(kiosk, 'function voidLastSignin()', '// --- Sync helpers ---');
  const firstId = 'gib-m1-00000000-0000-4000-8000-000000000001';
  const oldVoidId = 'gib-m1-00000000-0000-4000-8000-000000000002';
  const lastId = 'gib-m1-00000000-0000-4000-8000-000000000003';
  const state = {
    version: 2,
    ledger: [
      { RowID: firstId, Status: 'OK', Instructor: 'First' },
      { RowID: oldVoidId, Status: 'VOID', Instructor: 'Already void' },
      { RowID: lastId, Status: 'OK', Instructor: 'Last active' }
    ],
    queue: [{ RowID: firstId }, { RowID: lastId }]
  };
  let persisted = null;
  let networkCalls = 0;
  let tableRenders = 0;
  let syncRenders = 0;
  const context = vm.createContext({
    alert(message) { throw new Error(`Unexpected alert: ${message}`); },
    fetch() { networkCalls += 1; throw new Error('network forbidden'); },
    fmtTS: () => '2026-08-09 12:00:00',
    loadLocalState: () => state,
    persistLocalState: next => { persisted = JSON.parse(JSON.stringify(next)); },
    prompt: () => 'correction',
    renderAdminTable: () => { tableRenders += 1; },
    requestAcknowledgements() { networkCalls += 1; throw new Error('sync forbidden'); },
    showToast() {},
    updateSyncStatus: () => { syncRenders += 1; }
  });
  new vm.Script(`
    let syncInFlight = false;
    ${voidSource}
    globalThis.hooks = { voidLastSignin, setInFlight(value) { syncInFlight = value; } };
  `, { filename: 'm1-void-last.js' }).runInContext(context);
  context.hooks.voidLastSignin();

  assert.deepEqual(persisted.ledger.map(row => row.RowID), [firstId, oldVoidId, lastId]);
  assert.equal(persisted.ledger[0].Status, 'OK');
  assert.equal(persisted.ledger[1].Status, 'VOID');
  assert.equal(persisted.ledger[2].Status, 'VOID');
  assert.equal(persisted.ledger[2].void_reason, 'correction');
  assert.equal(persisted.ledger[2].voided_at, '2026-08-09 12:00:00');
  assert.deepEqual(persisted.queue.map(row => row.RowID), [firstId]);
  assert.equal(tableRenders, 1);
  assert.equal(syncRenders, 1);
  assert.equal(networkCalls, 0);
});

test('Clear All stays blocked by waiting rows or in-flight sync and still requires confirmation', () => {
  const clearSource = sourceBetween(
    kiosk,
    "$('#btnClearSignins').addEventListener('click'",
    '// Sync field & button listeners'
  );
  let handler = null;
  let alerts = 0;
  let confirms = 0;
  let saves = 0;
  let queue = [{ RowID: 'waiting' }];
  let confirmResult = true;
  let networkCalls = 0;
  const context = vm.createContext({
    $: () => ({ addEventListener(_type, callback) { handler = callback; } }),
    alert(message) {
      alerts += 1;
      assert.match(message, /Waiting rows must be confirmed or individually voided/u);
    },
    confirm() { confirms += 1; return confirmResult; },
    fetch() { networkCalls += 1; throw new Error('network forbidden'); },
    loadSyncQueue: () => queue,
    renderAdminTable() {},
    saveSignins(rows) { assert.equal(Array.isArray(rows) && rows.length === 0, true); saves += 1; },
    showToast() {}
  });
  new vm.Script(`
    let syncInFlight = false;
    ${clearSource}
    globalThis.hooks = { setInFlight(value) { syncInFlight = value; } };
  `, { filename: 'm1-clear-signins.js' }).runInContext(context);

  handler();
  assert.equal(alerts, 1);
  assert.equal(confirms, 0);
  assert.equal(saves, 0);

  queue = [];
  context.hooks.setInFlight(true);
  handler();
  assert.equal(alerts, 2);
  assert.equal(confirms, 0);
  assert.equal(saves, 0);

  context.hooks.setInFlight(false);
  confirmResult = false;
  handler();
  assert.equal(confirms, 1);
  assert.equal(saves, 0);

  confirmResult = true;
  handler();
  assert.equal(confirms, 2);
  assert.equal(saves, 1);
  assert.equal(networkCalls, 0);
});

test('reset and Factory reset retain their existing confirmation protections', () => {
  const resetSource = sourceBetween(
    kiosk,
    "$('#btnResetDevice').addEventListener('click'",
    '// Admin PIN actions'
  );
  const handlers = new Map();
  const status = { innerHTML: 'unchanged' };
  let confirmResult = false;
  let promptResult = 'NOT RESET';
  let resets = 0;
  let factoryResets = 0;
  let cancelledAlerts = 0;
  let syncSettingsLoads = 0;
  let syncStatusRenders = 0;
  let networkCalls = 0;
  const context = vm.createContext({
    $: selector => selector === '#deviceStatus'
      ? status
      : { addEventListener(_type, callback) { handlers.set(selector, callback); } },
    alert(message) { assert.equal(message, 'Factory reset cancelled'); cancelledAlerts += 1; },
    confirm: () => confirmResult,
    factoryReset: () => { factoryResets += 1; },
    fetch() { networkCalls += 1; throw new Error('network forbidden'); },
    loadSyncSettings: () => { syncSettingsLoads += 1; },
    prompt: () => promptResult,
    resetDevice: () => { resets += 1; },
    updateSyncStatus: () => { syncStatusRenders += 1; }
  });
  new vm.Script(resetSource, { filename: 'm1-reset-guards.js' }).runInContext(context);

  handlers.get('#btnResetDevice')();
  assert.equal(resets, 0);
  assert.equal(status.innerHTML, 'unchanged');
  confirmResult = true;
  handlers.get('#btnResetDevice')();
  assert.equal(resets, 1);
  assert.match(status.innerHTML, /Device reset/u);

  handlers.get('#btnFactoryReset')();
  assert.equal(factoryResets, 0);
  assert.equal(cancelledAlerts, 1);
  promptResult = ' RESET ';
  handlers.get('#btnFactoryReset')();
  assert.equal(factoryResets, 1);
  assert.match(status.innerHTML, /Factory reset complete/u);
  assert.equal(syncSettingsLoads, 2);
  assert.equal(syncStatusRenders, 2);
  assert.equal(networkCalls, 0);
});

test('Admin organization and navigation contain no Google or production write path', () => {
  const adminSource = [
    sourceBetween(kiosk, 'function adminScheduleSummary(', 'const DAY_ABBREV'),
    sourceBetween(kiosk, 'let adminViewOrganized = false;', '// UI helpers'),
    sourceBetween(kiosk, 'function showAdmin()', '// Toggle class list')
  ].join('\n');
  assert.doesNotMatch(adminSource, /fetch\s*\(|requestAcknowledgements\s*\(|syncNow\s*\(/u);
  assert.doesNotMatch(adminSource, /localStorage\.(?:setItem|removeItem|clear)\s*\(/u);
  assert.doesNotMatch(adminSource, /script\.google\.com|googleapis\.com|\/api\/m1-kiosk-sync/iu);
  assert.doesNotMatch(adminSource, /GIB_(?:TEST|M1)_/u);
  assert.doesNotMatch(kiosk, /script\.google\.com\/macros/iu);
});
