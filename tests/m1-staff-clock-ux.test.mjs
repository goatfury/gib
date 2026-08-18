import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const kiosk = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');

const FAKE_STAFF = Object.freeze([
  'Mandy Test',
  'Front Desk Test Two',
  'Front Desk Test Three'
]);
const PROTECTED_STORAGE_KEYS = Object.freeze([
  'gib_m1_local_state_v2',
  'gib_m1_signins_v1',
  'gib_m1_sync_queue_v1',
  'gib_m1_sync_auto_v1',
  'gib_m1_device_label_v1',
  'gib_m1_device_v1',
  'gib_m1_admin_pin_v1',
  'gib_m1_schedule_v1',
  'gib_m1_schedule_url_v1',
  'gib_m1_schedule_mode_v1',
  'gib_m1_canonical_schedule_cache_v1',
  'gib_m1_series_v1',
  'gib_m1_duration_rules_v1',
  'gib_m1_instructor_names_v1'
]);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function openingTag(id) {
  const tag = kiosk.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'u'))?.[0];
  assert.ok(tag, `Missing opening tag for #${id}`);
  return tag;
}

function countId(id) {
  return (kiosk.match(new RegExp(`\\bid="${id}"`, 'gu')) || []).length;
}

function kioskFunctionSource(name) {
  const start = kiosk.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const next = kiosk.indexOf('\n  function ', start + 12);
  return kiosk.slice(start, next === -1 ? kiosk.length : next);
}

function staffStorageKey() {
  const declaration = kiosk.match(/const STAFF_CLOCK_STORAGE_KEY\s*=\s*'([^']+)';/u);
  assert.ok(declaration, 'Missing Staff Clock storage declaration');
  return declaration[1];
}

function classList(...initial) {
  const values = new Set(initial);
  return {
    add(...tokens) { tokens.forEach(token => values.add(token)); },
    remove(...tokens) { tokens.forEach(token => values.delete(token)); },
    contains(token) { return values.has(token); }
  };
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = classList();
    this.className = '';
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.type = '';
    this.value = '';
    this.focused = false;
    this._textContent = '';
  }

  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children = [];
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  replaceChildren(...children) {
    this._textContent = '';
    this.children = [];
    this.append(...children);
  }

  focus() { this.focused = true; }
}

function renderedText(element) {
  return [
    element.textContent,
    ...element.children.map(renderedText)
  ].filter(Boolean).join('\n');
}

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries).map(([key, value]) => [key, String(value)]));
  const reads = [];
  const writes = [];
  const removals = [];
  return {
    reads,
    writes,
    removals,
    getItem(key) {
      reads.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push([key, String(value)]);
      values.set(key, String(value));
    },
    removeItem(key) {
      removals.push(key);
      values.delete(key);
    },
    clear() {
      removals.push('*');
      values.clear();
    },
    value(key) { return values.get(key); },
    entriesObject() { return Object.fromEntries(values); },
    snapshot() { return JSON.stringify([...values]); }
  };
}

function newYorkDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

const STAFF_FUNCTION_NAMES = Object.freeze([
  'blankStaffClockState',
  'validStaffClockPunch',
  'trimStaffClockPunches',
  'loadStaffClockState',
  'saveStaffClockState',
  'selectedStaffClockPerson',
  'staffClockStatusFor',
  'formatStaffClockTime',
  'formatStaffClockShift',
  'newStaffClockPunchId',
  'showStaffClockConfirmation',
  'renderStaffClock',
  'performStaffClockAction',
  'resetStaffClockCard',
  'renderStaffTimeAdmin'
]);

function createStaffClockRuntime({ storageEntries = {}, now = '2026-08-18T21:27:00.000Z' } = {}) {
  const ids = [
    'staffClockName',
    'staffClockStatus',
    'btnStaffClockAction',
    'staffClockControls',
    'staffClockConfirmation',
    'staffClockConfirmationTitle',
    'staffClockConfirmationDetail',
    'btnStaffClockDone',
    'staffTimeSlot'
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement()]));
  elements.get('staffClockName').tagName = 'SELECT';
  elements.get('btnStaffClockAction').tagName = 'BUTTON';
  elements.get('btnStaffClockAction').disabled = true;
  elements.get('btnStaffClockAction').dataset.action = 'in';
  elements.get('btnStaffClockDone').tagName = 'BUTTON';
  elements.get('staffClockConfirmation').hidden = true;

  const storage = memoryStorage(storageEntries);
  let currentNow = now;
  let networkCalls = 0;
  let uuidCounter = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(value) { super(value === undefined ? currentNow : value); }
    static now() { return NativeDate.parse(currentNow); }
  }

  const context = vm.createContext({
    Date: FixedDate,
    Intl,
    Math,
    localStorage: storage,
    crypto: {
      randomUUID() {
        uuidCounter += 1;
        return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
      }
    },
    document: { createElement: tagName => new FakeElement(tagName) },
    $: selector => elements.get(String(selector).replace(/^#/u, '')) || null,
    fmtDate: value => newYorkDateKey(value),
    window: {
      setTimeout(callback, delay) {
        const id = nextTimerId;
        nextTimerId += 1;
        timers.set(id, { callback, delay, active: true });
        return id;
      },
      clearTimeout(id) {
        const timer = timers.get(id);
        if (timer) timer.active = false;
      }
    },
    fetch() {
      networkCalls += 1;
      throw new Error('Staff Clock network request is forbidden');
    }
  });
  const functions = STAFF_FUNCTION_NAMES.map(kioskFunctionSource).join('\n');
  new vm.Script(`
    const TZ = 'America/New_York';
    const STAFF_CLOCK_STORAGE_KEY = ${JSON.stringify(staffStorageKey())};
    const STAFF_CLOCK_PEOPLE = Object.freeze([
      Object.freeze({ id: 'mandy-test', name: 'Mandy Test' }),
      Object.freeze({ id: 'front-desk-test-two', name: 'Front Desk Test Two' }),
      Object.freeze({ id: 'front-desk-test-three', name: 'Front Desk Test Three' })
    ]);
    let staffClockActionLocked = false;
    let staffClockConfirmationActive = false;
    let staffClockDoneTimer = null;
    ${functions}
    globalThis.hooks = {
      loadStaffClockState,
      staffClockStatusFor,
      renderStaffClock,
      performStaffClockAction,
      resetStaffClockCard,
      renderStaffTimeAdmin
    };
  `, { filename: 'm1-staff-clock-runtime.js' }).runInContext(context);

  return {
    context,
    elements,
    storage,
    setNow(value) { currentNow = value; },
    pendingTimers() {
      return [...timers.entries()]
        .filter(([, timer]) => timer.active)
        .map(([id, timer]) => ({ id, delay: timer.delay }));
    },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer?.active, `Timer ${id} is not pending`);
      timer.active = false;
      timer.callback();
    },
    get networkCalls() { return networkCalls; }
  };
}

function protectedStorageEntries() {
  return Object.fromEntries(PROTECTED_STORAGE_KEYS.map((key, index) => [
    key,
    `PROTECTED-CANARY-${index}`
  ]));
}

test('Instructor Sign-In stays first, complete, and immediately usable above Staff Clock', () => {
  const mainMarkup = sourceBetween(kiosk, '<!-- KIOSK -->', '<!-- ADMIN -->');
  const instructorStart = mainMarkup.indexOf('id="kiosk"');
  const instructorEnd = mainMarkup.indexOf('</section>', instructorStart);
  const staffStart = mainMarkup.indexOf('id="staffClock"');
  assert.ok(instructorStart >= 0);
  assert.ok(instructorEnd > instructorStart);
  assert.ok(staffStart > instructorEnd, 'Staff Clock must be a sibling after the completed instructor form');

  const requiredInstructorOrder = [
    'Instructor Sign-In',
    'id="nameInput"',
    'id="toggleClasses"',
    'id="classListWrap"',
    'id="notesInput"',
    'id="btnSignIn"'
  ].map(marker => mainMarkup.indexOf(marker));
  assert.equal(requiredInstructorOrder.every(position => position >= 0), true);
  assert.deepEqual(
    [...requiredInstructorOrder].sort((left, right) => left - right),
    requiredInstructorOrder
  );
  assert.ok(staffStart > requiredInstructorOrder.at(-1));

  for (const id of ['nameInput', 'toggleClasses', 'classListWrap', 'notesInput', 'btnSignIn']) {
    assert.equal(countId(id), 1, id);
  }
  assert.match(kiosk, /\$\('#btnSignIn'\)\.addEventListener\('click', signIn\);/u);
  assert.match(kiosk, /function signIn\(\)\s*\{\s*if \(signInLocked\) return;/u);
  assert.match(kiosk, /appendBatchToState\(loadLocalState\(\), ledgerRows, queuedRows\)[\s\S]*?persistLocalState\(state\)/u);

  const nav = sourceBetween(kiosk, '<nav>', '</nav>');
  assert.equal((nav.match(/<button\b/gu) || []).length, 1);
  assert.doesNotMatch(mainMarkup, /\b(?:Instructor|Staff)\s+(?:tab|mode)\b/iu);
});

test('Staff Clock is compact, fake-only, and exposes one state-aware action', () => {
  const mainMarkup = sourceBetween(kiosk, '<!-- KIOSK -->', '<!-- ADMIN -->');
  const staffStart = mainMarkup.indexOf('<section id="staffClock"');
  assert.notEqual(staffStart, -1);
  const staffMarkup = mainMarkup.slice(staffStart);

  assert.match(staffMarkup, /Front desk staff clock/u);
  assert.match(staffMarkup, /For hourly front desk staff/u);
  for (const name of FAKE_STAFF) assert.match(kiosk, new RegExp(name, 'u'));
  for (const id of [
    'staffClock',
    'staffClockName',
    'staffClockStatus',
    'btnStaffClockAction',
    'staffClockConfirmation',
    'staffClockConfirmationTitle',
    'staffClockConfirmationDetail',
    'btnStaffClockDone'
  ]) {
    assert.equal(countId(id), 1, id);
  }

  assert.match(openingTag('staffClockStatus'), /\brole="status"/u);
  assert.match(openingTag('staffClockStatus'), /\baria-live="polite"/u);
  assert.equal((staffMarkup.match(/<button\b[^>]*\bid="btnStaffClockAction"/gu) || []).length, 1);
  assert.doesNotMatch(staffMarkup, /<button\b[^>]*>\s*Clock in\s*<\/button>[\s\S]*<button\b[^>]*>\s*Clock out\s*<\/button>/iu);
  assert.doesNotMatch(staffMarkup, /\bPIN\b|photo|avatar|schedule|break|overtime|rounding|geofenc|GPS|payroll export/iu);
});

test('Staff Clock uses one preview-only key and has no instructor or production request path', () => {
  const storageDeclaration = kiosk.match(
    /const STAFF_CLOCK_STORAGE_KEY\s*=\s*'([^']+)';/u
  );
  assert.ok(storageDeclaration, 'Missing Staff Clock storage declaration');
  const staffStorageKey = storageDeclaration[1];
  assert.match(staffStorageKey, /^gib_m1b_staff_clock(?:_ux)?_preview_v1$/u);
  assert.equal(PROTECTED_STORAGE_KEYS.includes(staffStorageKey), false);
  assert.equal((kiosk.match(new RegExp(staffStorageKey, 'gu')) || []).length, 1);

  const staffSource = [
    'loadStaffClockState',
    'saveStaffClockState',
    'selectedStaffClockPerson',
    'staffClockStatusFor',
    'performStaffClockAction',
    'renderStaffClock',
    'resetStaffClockCard',
    'renderStaffTimeAdmin'
  ].map(kioskFunctionSource).join('\n');

  for (const key of PROTECTED_STORAGE_KEYS) {
    assert.equal(staffSource.includes(key), false, `Staff Clock must not reference ${key}`);
  }
  assert.doesNotMatch(
    staffSource,
    /\bfetch\s*\(|requestAcknowledgements|syncNow\s*\(|\/api\/|script\.google\.com|googleusercontent|PRODUCTION_ORIGIN|IS_PRODUCTION_ORIGIN/u
  );
  assert.doesNotMatch(staffSource, /RowID|createPermanentRowId|appendBatchToState|persistLocalState|Instructor|Class Label|Duration \(hr\)|SYNC_|SCHEDULE_|DEVICE_|ADMIN_PIN/u);
});

test('fake punch flow is durable, duplicate-safe, and keeps confirmation until Done', () => {
  assert.match(kiosk, /function performStaffClockAction\(\)/u);
  assert.match(kiosk, /function staffClockStatusFor\(/u);
  assert.match(kiosk, /function loadStaffClockState\(\)/u);
  assert.match(kiosk, /function saveStaffClockState\(/u);
  assert.match(kiosk, /function resetStaffClockCard\(\)/u);
  assert.match(kiosk, /Clocked in at/u);
  assert.match(kiosk, /Not clocked in/u);
  assert.match(kiosk, /already clocked in/iu);
  assert.match(kiosk, /not currently clocked in/iu);
  assert.match(kiosk, /Clocked in/u);
  assert.match(kiosk, /Clocked out/u);
  assert.match(kiosk, /Shift:/u);
  assert.doesNotMatch(kioskFunctionSource('formatStaffClockShift'), /Math\.round/u);
  assert.match(
    kiosk,
    /\.staff-clock-confirmation-detail\s*\{[^}]*white-space:\s*pre-line;/u
  );

  const actionSource = kioskFunctionSource('performStaffClockAction');
  assert.match(actionSource, /(?:Locked|InFlight|inFlight|locked)/u);
  assert.match(actionSource, /staffClockStatusFor/u);
  assert.match(actionSource, /saveStaffClockState/u);
  assert.match(actionSource, /new Date\(\)\.toISOString\(\)|new Date\(\)/u);

  const doneBinding = /\$\('#btnStaffClockDone'\)\.addEventListener\('click', resetStaffClockCard\);/u;
  assert.match(kiosk, doneBinding);
  assert.match(kiosk, /\$\('#btnStaffClockAction'\)\.addEventListener\('click', performStaffClockAction\);/u);
  assert.match(
    kioskFunctionSource('showStaffClockConfirmation'),
    /done\.disabled = true;[\s\S]*window\.setTimeout\([\s\S]*done\.disabled = false;[\s\S]*\}, 800\);/u
  );
  assert.match(kioskFunctionSource('resetStaffClockCard'), /if \(done\.disabled\) return;/u);
  assert.match(kiosk, /renderStaffClock\(\);/u);
});

test('real Staff Clock actions clock in and out once, survive reload, and reset safely', () => {
  const storageKey = staffStorageKey();
  const protectedEntries = protectedStorageEntries();
  const first = createStaffClockRuntime({ storageEntries: protectedEntries });
  const protectedBefore = Object.fromEntries(
    PROTECTED_STORAGE_KEYS.map(key => [key, first.storage.value(key)])
  );

  first.context.hooks.renderStaffClock();
  assert.equal(first.elements.get('staffClockStatus').textContent, 'Select your name to see your status.');
  assert.equal(first.elements.get('btnStaffClockAction').disabled, true);
  assert.equal(first.storage.writes.length, 0);

  first.elements.get('staffClockName').value = 'mandy-test';
  first.context.hooks.renderStaffClock();
  assert.equal(first.elements.get('staffClockStatus').textContent, 'Not clocked in');
  assert.equal(first.elements.get('btnStaffClockAction').textContent, 'Clock in');
  assert.equal(first.elements.get('btnStaffClockAction').disabled, false);

  first.context.hooks.performStaffClockAction();
  const afterClockIn = JSON.parse(first.storage.value(storageKey));
  assert.deepEqual(afterClockIn, {
    version: 1,
    punches: [{
      id: 'm1b-preview-punch-00000000-0000-4000-8000-000000000001',
      staffId: 'mandy-test',
      type: 'in',
      at: '2026-08-18T21:27:00.000Z'
    }]
  });
  assert.equal(first.storage.writes.length, 1);
  assert.equal(first.storage.writes[0][0], storageKey);
  assert.equal(first.elements.get('staffClockControls').hidden, true);
  assert.equal(first.elements.get('staffClockConfirmation').hidden, false);
  assert.equal(first.elements.get('staffClockConfirmationTitle').textContent, 'Clocked in');
  assert.match(first.elements.get('staffClockConfirmationDetail').textContent, /^Mandy Test · 5:27 PM$/u);
  assert.equal(first.elements.get('btnStaffClockDone').disabled, true);
  assert.equal(first.elements.get('btnStaffClockDone').focused, false);
  assert.deepEqual(first.pendingTimers(), [{ id: 1, delay: 800 }]);

  first.context.hooks.performStaffClockAction();
  first.context.hooks.performStaffClockAction();
  assert.equal(first.storage.writes.length, 1, 'rapid repeated taps must not add punches');
  assert.equal(first.elements.get('staffClockConfirmation').hidden, false, 'confirmation stays visible');
  first.context.hooks.resetStaffClockCard();
  assert.equal(first.elements.get('staffClockConfirmation').hidden, false, 'rapid Done must be ignored');
  assert.equal(first.elements.get('staffClockControls').hidden, true);
  assert.equal(first.elements.get('staffClockName').value, 'mandy-test');
  assert.equal(first.storage.writes.length, 1);
  first.runTimer(1);
  assert.equal(first.elements.get('btnStaffClockDone').disabled, false);
  assert.equal(first.elements.get('btnStaffClockDone').focused, true);
  assert.deepEqual(first.pendingTimers(), []);
  first.context.hooks.resetStaffClockCard();
  assert.equal(first.elements.get('staffClockConfirmation').hidden, true);
  assert.equal(first.elements.get('staffClockControls').hidden, false);
  assert.equal(first.elements.get('staffClockName').value, '');
  assert.equal(first.storage.writes.length, 1, 'enabled Done resets only the UI');
  assert.equal(first.networkCalls, 0);
  for (const [key, value] of Object.entries(protectedBefore)) {
    assert.equal(first.storage.value(key), value, key);
  }

  const reloaded = createStaffClockRuntime({
    storageEntries: first.storage.entriesObject(),
    now: '2026-08-18T21:28:00.000Z'
  });
  reloaded.context.hooks.renderStaffClock();
  assert.equal(reloaded.elements.get('staffClockName').value, '');
  assert.equal(reloaded.elements.get('btnStaffClockAction').disabled, true);
  assert.equal(reloaded.storage.writes.length, 0, 'reload must only read preview state');

  reloaded.elements.get('staffClockName').value = 'mandy-test';
  reloaded.context.hooks.renderStaffClock();
  assert.equal(reloaded.elements.get('staffClockStatus').textContent, 'Clocked in at 5:27 PM');
  assert.equal(reloaded.elements.get('btnStaffClockAction').textContent, 'Clock out');

  reloaded.elements.get('btnStaffClockAction').dataset.action = 'in';
  reloaded.context.hooks.performStaffClockAction();
  assert.equal(reloaded.storage.writes.length, 0);
  assert.equal(reloaded.elements.get('staffClockStatus').textContent, 'Mandy Test is already clocked in.');

  reloaded.context.hooks.renderStaffClock();
  reloaded.setNow('2026-08-19T01:04:00.000Z');
  reloaded.context.hooks.performStaffClockAction();
  const afterClockOut = JSON.parse(reloaded.storage.value(storageKey));
  assert.equal(afterClockOut.punches.length, 2);
  assert.deepEqual(afterClockOut.punches.map(punch => punch.type), ['in', 'out']);
  assert.equal(afterClockOut.punches[1].at, '2026-08-19T01:04:00.000Z');
  assert.equal(reloaded.storage.writes.length, 1);
  assert.equal(reloaded.elements.get('staffClockConfirmationTitle').textContent, 'Clocked out');
  assert.equal(
    reloaded.elements.get('staffClockConfirmationDetail').textContent,
    'Mandy Test · 9:04 PM\nShift: 3 hr 37 min'
  );

  const [{ id: clockOutDoneTimer, delay: clockOutDoneDelay }] = reloaded.pendingTimers();
  assert.equal(clockOutDoneDelay, 800);
  reloaded.context.hooks.resetStaffClockCard();
  assert.equal(reloaded.elements.get('staffClockConfirmation').hidden, false);
  reloaded.runTimer(clockOutDoneTimer);
  reloaded.context.hooks.resetStaffClockCard();
  assert.equal(reloaded.elements.get('staffClockConfirmation').hidden, true);
  assert.equal(reloaded.elements.get('staffClockControls').hidden, false);
  assert.equal(reloaded.elements.get('staffClockName').value, '');
  assert.equal(reloaded.elements.get('btnStaffClockAction').disabled, true);
  assert.equal(reloaded.elements.get('staffClockName').focused, true);
  assert.equal(reloaded.storage.writes.length, 1, 'Done resets UI without changing punches');

  reloaded.elements.get('staffClockName').value = 'mandy-test';
  reloaded.context.hooks.renderStaffClock();
  assert.equal(reloaded.elements.get('staffClockStatus').textContent, 'Not clocked in');
  reloaded.elements.get('btnStaffClockAction').dataset.action = 'out';
  reloaded.context.hooks.performStaffClockAction();
  assert.equal(reloaded.storage.writes.length, 1);
  assert.equal(
    reloaded.elements.get('staffClockStatus').textContent,
    'Mandy Test is not currently clocked in.'
  );
  assert.equal(reloaded.networkCalls, 0);
  for (const [key, value] of Object.entries(protectedBefore)) {
    assert.equal(reloaded.storage.value(key), value, key);
  }
});

test('empty Staff time rendering is compact, quiet, and read-only', () => {
  const storageKey = staffStorageKey();
  const protectedEntries = protectedStorageEntries();
  const runtime = createStaffClockRuntime({
    storageEntries: protectedEntries,
    now: '2026-08-19T02:00:00.000Z'
  });
  const before = runtime.storage.snapshot();

  runtime.context.hooks.renderStaffTimeAdmin();
  const slot = runtime.elements.get('staffTimeSlot');
  const text = renderedText(slot);
  assert.equal(
    text,
    'No staff punches yet today.\nFix missed punch — planned for the operational build'
  );
  assert.ok(slot.children.length <= 2, 'empty Staff time must stay to one short state plus the placeholder');
  assert.doesNotMatch(text, /Clocked in now|Today’s punches|Needs attention/iu);
  assert.equal(slot.children.at(-1).tagName, 'BUTTON');
  assert.equal(slot.children.at(-1).disabled, true);
  assert.equal(runtime.storage.snapshot(), before);
  assert.deepEqual(runtime.storage.writes, []);
  assert.deepEqual(runtime.storage.removals, []);
  assert.deepEqual(runtime.storage.reads, [storageKey]);
  assert.equal(runtime.networkCalls, 0);
});

test('ordinary Staff time rendering shows the current worker and today’s punches without warning clutter', () => {
  const storageKey = staffStorageKey();
  const protectedEntries = protectedStorageEntries();
  const staffState = {
    version: 1,
    punches: [{
      id: 'm1b-preview-punch-mandy-in',
      staffId: 'mandy-test',
      type: 'in',
      at: '2026-08-18T21:27:00.000Z'
    }]
  };
  const runtime = createStaffClockRuntime({
    storageEntries: {
      ...protectedEntries,
      [storageKey]: JSON.stringify(staffState)
    },
    now: '2026-08-19T02:00:00.000Z'
  });
  const before = runtime.storage.snapshot();

  runtime.context.hooks.renderStaffTimeAdmin();
  const text = renderedText(runtime.elements.get('staffTimeSlot'));
  assert.match(text, /Clocked in now/u);
  assert.match(text, /Mandy Test · since 5:27 PM/u);
  assert.match(text, /Today’s punches/u);
  assert.match(text, /Mandy Test · Clocked in · 5:27 PM/u);
  assert.doesNotMatch(text, /Needs attention|missing clock-out|No obvious/iu);
  assert.match(text, /Fix missed punch — planned for the operational build/u);
  assert.equal(runtime.storage.snapshot(), before);
  assert.deepEqual(runtime.storage.writes, []);
  assert.deepEqual(runtime.storage.removals, []);
  assert.equal(runtime.networkCalls, 0);
});

test('a busy day keeps every punch inside the compact scrolling history region', () => {
  const storageKey = staffStorageKey();
  const start = Date.parse('2026-08-18T20:00:00.000Z');
  const punches = Array.from({ length: 60 }, (_, index) => ({
    id: `m1b-preview-punch-busy-${index}`,
    staffId: 'mandy-test',
    type: index % 2 === 0 ? 'in' : 'out',
    at: new Date(start + (index * 60_000)).toISOString()
  }));
  const runtime = createStaffClockRuntime({
    storageEntries: {
      ...protectedStorageEntries(),
      [storageKey]: JSON.stringify({ version: 1, punches })
    },
    now: '2026-08-19T02:00:00.000Z'
  });
  const before = runtime.storage.snapshot();

  runtime.context.hooks.renderStaffTimeAdmin();
  const grid = runtime.elements.get('staffTimeSlot').children[0];
  const punchList = grid.children[1].children[1];
  assert.equal(punchList.className, 'staff-time-list staff-time-punches');
  assert.equal(punchList.children.length, punches.length, 'the compact region must retain every visible punch');
  assert.match(
    kiosk,
    /\.staff-time-punches\s*\{[^}]*max-height:\s*120px;[^}]*overflow-y:\s*auto;/u
  );
  assert.equal(runtime.storage.snapshot(), before);
  assert.deepEqual(runtime.storage.writes, []);
  assert.deepEqual(runtime.storage.removals, []);
  assert.equal(runtime.networkCalls, 0);
});

test('Staff time shows Needs attention only for an actual missing clock-out', () => {
  const storageKey = staffStorageKey();
  const protectedEntries = protectedStorageEntries();
  const staffState = {
    version: 1,
    punches: [
      {
        id: 'm1b-preview-punch-old-open',
        staffId: 'front-desk-test-two',
        type: 'in',
        at: '2026-08-17T21:00:00.000Z'
      },
      {
        id: 'm1b-preview-punch-mandy-in',
        staffId: 'mandy-test',
        type: 'in',
        at: '2026-08-18T21:27:00.000Z'
      },
      {
        id: 'm1b-preview-punch-mandy-out',
        staffId: 'mandy-test',
        type: 'out',
        at: '2026-08-19T01:04:00.000Z'
      }
    ]
  };
  const runtime = createStaffClockRuntime({
    storageEntries: {
      ...protectedEntries,
      [storageKey]: JSON.stringify(staffState)
    },
    now: '2026-08-19T02:00:00.000Z'
  });
  const before = runtime.storage.snapshot();

  runtime.context.hooks.renderStaffTimeAdmin();
  const slot = runtime.elements.get('staffTimeSlot');
  const text = renderedText(slot);
  assert.match(text, /Clocked in now/u);
  assert.match(text, /Front Desk Test Two · since 5:00 PM/u);
  assert.match(text, /Today’s punches/u);
  assert.match(text, /Mandy Test · Clocked in · 5:27 PM/u);
  assert.match(text, /Mandy Test · Clocked out · 9:04 PM/u);
  assert.match(text, /Needs attention/u);
  assert.match(text, /Possible missing clock-out: Front Desk Test Two/u);
  assert.match(text, /Fix missed punch — planned for the operational build/u);
  assert.equal(slot.children.at(-1).tagName, 'BUTTON');
  assert.equal(slot.children.at(-1).disabled, true);
  assert.equal(runtime.storage.snapshot(), before);
  assert.deepEqual(runtime.storage.writes, []);
  assert.deepEqual(runtime.storage.removals, []);
  assert.deepEqual(runtime.storage.reads, [storageKey]);
  assert.equal(runtime.networkCalls, 0);
});

test('opening Admin preserves punches and instructor data while Recent sign-ins and Staff time stay manually collapsible', () => {
  const storageKey = staffStorageKey();
  const storageEntries = {
    ...protectedStorageEntries(),
    [storageKey]: JSON.stringify({
      version: 1,
      punches: [{
        id: 'm1b-preview-punch-admin-open',
        staffId: 'mandy-test',
        type: 'in',
        at: '2026-08-18T21:27:00.000Z'
      }]
    })
  };
  const runtime = createStaffClockRuntime({
    storageEntries,
    now: '2026-08-19T02:00:00.000Z'
  });
  const before = runtime.storage.snapshot();

  for (const id of [
    'kiosk',
    'admin',
    'cfgGymName',
    'cfgLocation',
    'cfgSiteCode',
    'debugBox',
    'adminHeading',
    'recentSignins',
    'staffTimeSection',
    'advancedSettings',
    'dangerZone'
  ]) {
    if (!runtime.elements.has(id)) runtime.elements.set(id, new FakeElement());
    runtime.elements.get(id).id = id;
  }
  runtime.elements.get('kiosk').style = { display: 'block' };
  runtime.elements.get('admin').style = { display: 'none' };
  runtime.elements.get('recentSignins').open = true;
  runtime.elements.get('staffTimeSection').open = true;
  runtime.elements.get('advancedSettings').open = false;
  runtime.elements.get('dangerZone').open = false;
  runtime.context.document.body = { classList: classList('kiosk-mode') };

  const noOp = () => {};
  Object.assign(runtime.context, {
    organizeAdminView: noOp,
    loadDevice: () => ({ gymName: 'QA Gym', location: 'QA tablet', siteCode: 'TEST' }),
    updateAdminPinUI: noOp,
    loadScheduleIntoAdmin: noOp,
    renderDurationRules: noOp,
    renderSeriesList: noOp,
    clearSeriesForm: noOp,
    renderAdminTable: noOp,
    renderStaffTimeAdmin: runtime.context.hooks.renderStaffTimeAdmin,
    loadSyncSettings: noOp,
    updateSyncStatus: noOp,
    renderAdminSummary: noOp,
    debugSnapshot: () => ({ safe: true })
  });
  const showAdminSource = sourceBetween(kiosk, 'function showAdmin()', 'function openAdminWithGate()');
  new vm.Script(`${showAdminSource}\nglobalThis.showAdmin = showAdmin;`, {
    filename: 'm1-staff-time-admin-open.js'
  }).runInContext(runtime.context);

  runtime.context.showAdmin();
  assert.equal(runtime.elements.get('recentSignins').open, true, 'Recent sign-ins starts open');
  assert.equal(runtime.elements.get('staffTimeSection').open, true, 'Staff time starts open');
  assert.equal(runtime.elements.get('advancedSettings').open, false);
  assert.equal(runtime.elements.get('dangerZone').open, false);

  runtime.elements.get('recentSignins').open = false;
  runtime.elements.get('staffTimeSection').open = false;
  runtime.context.showAdmin();
  assert.equal(runtime.elements.get('recentSignins').open, false, 'manual Recent sign-ins close survives Admin rendering');
  assert.equal(runtime.elements.get('staffTimeSection').open, false, 'manual close survives Admin rendering');

  runtime.elements.get('recentSignins').open = true;
  runtime.elements.get('staffTimeSection').open = true;
  runtime.context.showAdmin();
  assert.equal(runtime.elements.get('recentSignins').open, true, 'manual Recent sign-ins reopen survives Admin rendering');
  assert.equal(runtime.elements.get('staffTimeSection').open, true, 'manual reopen survives Admin rendering');

  assert.equal(runtime.storage.snapshot(), before);
  assert.deepEqual(runtime.storage.writes, []);
  assert.deepEqual(runtime.storage.removals, []);
  assert.equal(runtime.networkCalls, 0);
});

test('pruning retains an older unmatched clock-in behind more than 200 newer staff punches', () => {
  const storageKey = staffStorageKey();
  const protectedEntries = protectedStorageEntries();
  const olderClockIn = {
    id: 'm1b-preview-punch-mandy-unmatched',
    staffId: 'mandy-test',
    type: 'in',
    at: '2026-01-02T22:00:00.000Z'
  };
  const newerPunches = Array.from({ length: 210 }, (_, index) => ({
    id: `m1b-preview-punch-newer-${index}`,
    staffId: index % 2 === 0 ? 'front-desk-test-two' : 'front-desk-test-three',
    type: index % 4 < 2 ? 'in' : 'out',
    at: new Date(Date.parse('2026-08-01T12:00:00.000Z') + (index * 60_000)).toISOString()
  }));
  const runtime = createStaffClockRuntime({
    storageEntries: {
      ...protectedEntries,
      [storageKey]: JSON.stringify({
        version: 1,
        punches: [olderClockIn, ...newerPunches]
      })
    }
  });

  const loaded = runtime.context.hooks.loadStaffClockState();
  assert.equal(loaded.punches.length, 201);
  assert.equal(loaded.punches.some(punch => punch.id === olderClockIn.id), true);
  const mandyStatus = runtime.context.hooks.staffClockStatusFor('mandy-test', loaded);
  assert.equal(mandyStatus.clockedIn, true);
  assert.equal(mandyStatus.clockInAt, olderClockIn.at);

  runtime.elements.get('staffClockName').value = 'mandy-test';
  runtime.context.hooks.renderStaffClock();
  assert.match(runtime.elements.get('staffClockStatus').textContent, /^Clocked in at /u);
  assert.deepEqual(runtime.storage.writes, []);
  assert.equal(runtime.networkCalls, 0);
  for (const [key, value] of Object.entries(protectedEntries)) {
    assert.equal(runtime.storage.value(key), value, key);
  }
});

test('Admin prioritizes instructor review before an open-by-default, read-only Staff time disclosure', () => {
  const admin = sourceBetween(kiosk, '<!-- ADMIN -->', '<div id="toast"');
  assert.equal(countId('recentSignins'), 1);
  assert.equal(countId('staffTimeSection'), 1);
  assert.equal(countId('staffTimeSlot'), 1);
  assert.match(admin, /<details id="recentSignins"[^>]*\bopen\b[^>]*>\s*<summary>Recent sign-ins<\/summary>/u);
  assert.match(admin, /<details id="staffTimeSection"[^>]*\bopen\b[^>]*>\s*<summary>Staff time<\/summary>/u);
  assert.match(openingTag('recentSignins'), /\sopen(?:\s|=|>)/u);
  assert.match(openingTag('staffTimeSection'), /\sopen(?:\s|=|>)/u);
  assert.match(
    admin,
    /<section class="admin-overview"[^>]*>[\s\S]*?<\/section>\s*<section class="admin-actions-block"/u,
    'Instructor ordinary actions must sit directly below Status summary'
  );
  assert.match(
    admin,
    /<section class="admin-actions-block"[^>]*>[\s\S]*?<\/section>\s*<\/div>\s*<details id="recentSignins"[^>]*\bopen\b[^>]*>/u,
    'Recent instructor sign-ins must sit directly below the instructor tools'
  );
  assert.match(
    admin,
    /<details id="recentSignins"[^>]*\bopen\b[^>]*>[\s\S]*?<\/details>\s*<details id="staffTimeSection"[^>]*\bopen\b[^>]*>/u,
    'Staff time must sit directly below Recent instructor sign-ins'
  );

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

  assert.match(
    admin,
    /id="dailyReviewLink"[^>]*class="[^"]*\bbrand\b[^"]*\badmin-daily-review\b[^"]*"[^>]*>Forgotten sign-in \/ Daily Review<\/a>/u,
    'Forgotten sign-in / Daily Review must remain the prominent instructor action'
  );
  assert.match(admin, /id="recentSigninsLink"[^>]*href="#recentSignins"[^>]*>View recent sign-ins<\/a>/u);
  for (const [id, label] of [
    ['btnSyncNow', /Sync now/u],
    ['btnExport', /Export backup CSV/u],
    ['btnVoidLast', /Void last sign[^<]*in/u]
  ]) {
    assert.match(kiosk, new RegExp(`<button[^>]*\\bid="${id}"[^>]*>[^<]*${label.source}[^<]*<\\/button>`, 'u'), id);
  }

  const organizeSource = kioskFunctionSource('organizeAdminView');
  assert.match(organizeSource, /\['btnSyncNow', 'btnExport', 'btnVoidLast'\]/u);
  assert.match(organizeSource, /primaryActions\.insertBefore\(action, recentSigninsLink\)/u);
  for (const [id, handler] of [
    ['btnSyncNow', 'syncNow'],
    ['btnExport', 'exportCSV'],
    ['btnVoidLast', 'voidLastSignin']
  ]) {
    assert.match(kiosk, new RegExp(`\\$\\('#${id}'\\)\\.addEventListener\\('click', ${handler}\\);`, 'u'), id);
  }

  assert.match(kiosk, /Clocked in now/u);
  assert.match(kiosk, /Today(?:'s|’s) punches/u);
  assert.match(kiosk, /Needs attention/u);
  assert.match(kiosk, /missing clock-out/iu);
  assert.match(kiosk, /No staff punches yet today\./u);
  assert.match(kiosk, /Fix missed punch — planned for the operational build/u);
  assert.equal(admin.includes('adminSummaryStaff'), false);
  assert.doesNotMatch(openingTag('advancedSettings'), /\sopen(?:\s|=|>)/u);
  assert.doesNotMatch(openingTag('dangerZone'), /\sopen(?:\s|=|>)/u);
  assert.doesNotMatch(kiosk, /\$\('#staffTimeSection'\)\.addEventListener\(['"]toggle['"]/u);
  assert.doesNotMatch(
    kiosk,
    /gib_[^'"\s]*staff[^'"\s]*(?:open|closed|collapsed|expanded)/iu,
    'manual disclosure state must not create a saved preference'
  );

  const showAdminSource = sourceBetween(kiosk, 'function showAdmin()', 'function openAdminWithGate()');
  for (const id of ['recentSignins', 'staffTimeSection']) {
    assert.equal(
      showAdminSource.includes(id),
      false,
      `reopening Admin must not override a manual ${id} close or reopen`
    );
  }

  const renderStart = kiosk.indexOf('function renderStaffTimeAdmin(');
  const nextFunction = kiosk.indexOf('\n  function ', renderStart + 12);
  assert.ok(renderStart >= 0);
  const renderSource = kiosk.slice(renderStart, nextFunction === -1 ? kiosk.length : nextFunction);
  assert.doesNotMatch(renderSource, /localStorage\.(?:setItem|removeItem|clear)|saveStaffClockState|fetch\s*\(|requestAcknowledgements|syncNow\s*\(/u);
  assert.doesNotMatch(admin, /\b(?:Delete|Correct|Approve payroll|Export payroll|Save changes)\b/iu);
});
