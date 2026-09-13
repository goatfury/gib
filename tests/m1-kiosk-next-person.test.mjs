import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  appendBatchToState,
  applyAcknowledgements,
  blankLocalState,
  removeBatchFromState
} from '../m1/sync-core.mjs';
import { evaluateStaffState, formatStaffElapsed, sameStaffRecord } from '../m1/staff-clock-core.mjs';

// Execute the application's actual functions with controlled browser primitives.
// These deterministic regressions supplement the real elapsed-time hosted gate
// in docs/m1-release-checklist.md; they do not claim physical-device browser QA.
const instructorSource = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const staffSource = readFileSync(new URL('../m1/staff-clock-client.mjs', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function functionSource(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} must exist`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6 : functionStart;
  let parameters = 0;
  let body = -1;
  for (let index = source.indexOf('(', functionStart); index < source.length; index += 1) {
    if (source[index] === '(') parameters += 1;
    if (source[index] === ')') {
      parameters -= 1;
      if (!parameters) { body = source.indexOf('{', index + 1); break; }
    }
  }
  let braces = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') braces += 1;
    if (source[index] === '}' && --braces === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Incomplete function ${name}`);
}

class EventTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type });
  }
}

class Clock {
  now = Date.parse('2026-09-13T14:00:00Z');
  nextId = 1;
  timers = new Map();
  set(callback, delay = 0, interval = false) {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.now + delay, interval: interval ? delay : 0 });
    return id;
  }
  clear(id) { this.timers.delete(id); }
  advance(milliseconds) {
    const end = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else this.timers.delete(id);
      timer.callback();
    }
    this.now = end;
  }
  sleep(milliseconds) { this.now += milliseconds; }
}

function browserHarness() {
  const clock = new Clock();
  const document = new EventTarget();
  const window = new EventTarget();
  const elements = new Map();
  const checkboxes = ['TEST Fundamentals', 'TEST Judo'].map(value => ({ value, checked: false }));
  const makeElement = () => {
    const element = new EventTarget();
    const classes = new Set();
    Object.assign(element, {
      value: '', hidden: false, disabled: false, checked: false, dataset: {}, style: {},
      textContent: '', children: [], attributes: {},
      classList: {
        add: (...values) => values.forEach(value => classes.add(value)),
        remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value),
        toggle(value, force = !classes.has(value)) {
          if (force) classes.add(value); else classes.delete(value);
        }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; this.textContent = ''; },
      hasChildNodes() { return this.children.length > 0; },
      contains(child) { return child === this || this.children.includes(child); },
      focus() { document.activeElement = this; }
    });
    Object.defineProperty(element, 'innerHTML', {
      get() { return this.children.map(child => child.textContent || '').join(''); },
      set(value) { this.children = []; this.textContent = value; }
    });
    return element;
  };
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  };
  document.visibilityState = 'visible';
  document.activeElement = null;
  document.querySelector = $;
  document.getElementById = id => $(`#${id}`);
  document.querySelectorAll = selector => selector.endsWith(':checked')
    ? checkboxes.filter(checkbox => checkbox.checked) : checkboxes;
  document.createElement = makeElement;
  document.body = makeElement();
  for (const target of [window]) {
    target.setTimeout = (callback, delay) => clock.set(callback, delay);
    target.clearTimeout = id => clock.clear(id);
    target.setInterval = (callback, delay) => clock.set(callback, delay, true);
    target.clearInterval = id => clock.clear(id);
  }
  class ControlledDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const storage = new Map([['syncAuto', 'false'], ['auth', 'preserve-auth'], ['device', 'preserve-device']]);
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const alerts = [];
  const context = vm.createContext({
    $, window, document, localStorage, navigator: { onLine: false },
    Date: ControlledDate, console, Set, Map, Promise, AbortController,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    setInterval: window.setInterval, clearInterval: window.clearInterval,
    alert: text => alerts.push(text),
    showToast: () => {}
  });
  const run = code => vm.runInContext(code, context);
  return { clock, document, window, $, checkboxes, storage, alerts, context, run };
}

function instructorHarness({ richmond = false } = {}) {
  const harness = browserHarness();
  let state = blankLocalState();
  let failure = false;
  let identity = 1;
  const requests = [];
  Object.assign(harness.context, {
    appendBatchToState, removeBatchFromState, applyAcknowledgements,
    loadLocalState: () => clone(state),
    loadSyncQueue: () => clone(state.queue),
    persistLocalState: next => { if (failure) throw new Error('disk full'); state = clone(next); },
    createPermanentRowId: () => `gib-m1-${String(identity++).padStart(8, '0')}-0000-4000-8000-000000000001`,
    fmtTS: date => date.toISOString().slice(0, 19).replace('T', ' '),
    fmtDate: date => date.toISOString().slice(0, 10),
    getSiteCode: () => richmond ? 'Richmond TEST' : 'Rev TEST',
    getDurationForClass: label => label === 'TEST Judo' ? 1.5 : 1,
    upsertName() {}, refreshNameDatalist() {}, renderAdminTable() {}, updateSyncStatus() {},
    applyPendingScheduleViewIfSafe() {}, populateClassesForToday() {}, recordSyncEvent() {},
    syncFailureCode: () => 'INJECTED_FAILURE',
    requestAcknowledgements: async rows => {
      requests.push(clone(rows));
      return { ok: true, test: true, results: rows.map(row => ({
        rowId: row.RowID, linkedRecordId: row.RowID, result: 'added'
      })) };
    },
    IS_RICHMOND: richmond, IS_RICHMOND_PRODUCTION: false, RICHMOND_WRITES_ENABLED: false,
    IS_RICHMOND_PRODUCTION_ORIGIN: false, IS_PRODUCTION_SYNC_ORIGIN: false,
    INSTALLATION: { deviceLabel: 'TEST browser' }, DEVICE_LABEL_KEY: 'device', BUILD: 'TEST next-person',
    BACKEND_ENABLED: true, SYNC_AUTO_KEY: 'syncAuto', SYNC_ERROR_KEY: 'syncError', SYNC_LAST_KEY: 'syncLast',
    INSTRUCTOR_SYNC_BATCH_SIZE: 50
  });
  const stateStart = instructorSource.indexOf('  // Sign-in confirmation modal state');
  const stateEnd = instructorSource.indexOf('  function kioskFormInProgress()', stateStart);
  harness.run(instructorSource.slice(stateStart, stateEnd));
  const functions = [
    'kioskFormInProgress', 'clearSignInCountdown', 'updateSignInUndoLabel', 'toggleSignInModal',
    'resetKioskForm', 'restoreKioskForm', 'openSignInModal', 'closeSignInModal',
    'checkSignInConfirmationDeadline', 'undoLastSigninBatch', 'confirmSigninDone', 'selectedClasses',
    'signIn', 'syncNow'
  ];
  harness.run(`let syncInFlight = false;\n${functions.map(name => functionSource(instructorSource, name)).join('\n')}`);
  const lifecycleStart = instructorSource.indexOf("  ['focus', 'pageshow', 'popstate'].forEach", stateEnd);
  harness.run(instructorSource.slice(lifecycleStart, instructorSource.indexOf('  // Admin PIN', lifecycleStart)));
  harness.fill = (name = 'TEST Person A', notes = 'TEST notes A', classes = ['TEST Fundamentals']) => {
    harness.$('#nameInput').value = name;
    harness.$('#notesInput').value = notes;
    harness.checkboxes.forEach(checkbox => { checkbox.checked = classes.includes(checkbox.value); });
    harness.$('#classListWrap').style.display = 'block';
  };
  return Object.assign(harness, {
    state: () => clone(state), requests,
    failPersistence(value = true) { failure = value; },
    assertNeutral() {
      assert.equal(harness.$('#signInModal').classList.contains('show'), false);
      assert.equal(harness.$('#signInModalName').textContent, '');
      assert.equal(harness.$('#signInModalClasses').children.length, 0);
      assert.equal(harness.$('#nameInput').value, '');
      assert.equal(harness.$('#notesInput').value, '');
      assert.ok(harness.checkboxes.every(checkbox => !checkbox.checked));
      assert.equal(harness.$('#btnSignIn').disabled, false);
      assert.equal(harness.run('lastSigninFormSnapshot'), null);
      assert.equal(harness.storage.get('auth'), 'preserve-auth');
      assert.equal(harness.storage.get('device'), 'preserve-device');
    }
  });
}

for (const richmond of [false, true]) {
  test(`next-person gate: ${richmond ? 'Richmond' : 'Revolution'} instructor walks away, then the next person saves`, () => {
    const h = instructorHarness({ richmond });
    h.fill('TEST Person A', 'TEST notes A', ['TEST Fundamentals', 'TEST Judo']);
    h.run('signIn()');
    const original = h.state();
    assert.equal(original.ledger.length, 2);
    assert.equal(original.queue.length, 2);
    h.clock.advance(14_999);
    assert.equal(h.$('#signInModal').classList.contains('show'), true);
    h.clock.advance(1);
    h.assertNeutral();
    assert.deepEqual(h.state(), original, 'privacy reset must not mutate durable records, IDs, queue or durations');
    h.fill('TEST Person B', 'TEST notes B');
    h.run('signIn(); signIn()');
    assert.equal(h.state().ledger.length, 3, 'duplicate tap does not add another transaction');
    assert.equal(h.state().ledger[2].Instructor, 'TEST Person B');
    h.clock.advance(15_000);
    h.assertNeutral();
    assert.equal(new Set(h.state().ledger.map(row => row.RowID)).size, 3);
  });
}

test('instructor Done clears its private text and cannot erase the next active form at the old deadline', () => {
  const h = instructorHarness();
  h.fill(); h.run('signIn()');
  const original = h.state();
  h.clock.advance(1_000); h.run('confirmSigninDone()');
  h.assertNeutral();
  h.fill('TEST Person B', 'Still writing', ['TEST Judo']);
  h.$('#notesInput').focus();
  h.clock.advance(60_000);
  assert.equal(h.$('#nameInput').value, 'TEST Person B');
  assert.equal(h.$('#notesInput').value, 'Still writing');
  assert.equal(h.document.activeElement, h.$('#notesInput'));
  assert.deepEqual(h.state(), original);
});

test('instructor Undo removes only its durable batch and restores its exact input', () => {
  const h = instructorHarness();
  h.fill('TEST Prior Person'); h.run('signIn(); confirmSigninDone()');
  const prior = h.state();
  h.fill('TEST Person A', 'Two classes, keep notes', ['TEST Fundamentals', 'TEST Judo']);
  h.run('signIn()'); h.clock.advance(14_000); h.run('undoLastSigninBatch()');
  assert.deepEqual(h.state(), prior);
  assert.equal(h.$('#nameInput').value, 'TEST Person A');
  assert.equal(h.$('#notesInput').value, 'Two classes, keep notes');
  assert.ok(h.checkboxes.every(checkbox => checkbox.checked));
  h.clock.advance(30_000);
  assert.equal(h.$('#nameInput').value, 'TEST Person A', 'Undo restored an active form, not an expiring confirmation');
});

test('instructor queue barrier holds for the Undo window and releases at the original deadline', async () => {
  const h = instructorHarness();
  h.context.navigator.onLine = true;
  h.fill(); h.run('signIn()');
  const original = h.state();
  h.clock.advance(14_999);
  await h.run("syncNow({ type: 'click' })");
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.state(), original);
  h.clock.sleep(1); // No interval callback: sync must independently enforce the wall-clock deadline.
  await h.run("syncNow({ type: 'click' })");
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().queue.length, 0);
  assert.equal(h.state().ledger[0].RowID, original.ledger[0].RowID);
  h.assertNeutral();
});

test('expired instructor Undo cannot delete a record when browser countdown callbacks were suspended', () => {
  const h = instructorHarness();
  h.fill(); h.run('signIn()');
  const original = h.state();
  h.clock.sleep(20_000);
  h.run('undoLastSigninBatch()');
  assert.deepEqual(h.state(), original);
  h.assertNeutral();
});

test('failed instructor local save keeps all input and never starts a success deadline', () => {
  const h = instructorHarness();
  h.fill(); h.failPersistence(); h.run('signIn()');
  h.clock.advance(30_000);
  assert.equal(h.$('#nameInput').value, 'TEST Person A');
  assert.equal(h.$('#notesInput').value, 'TEST notes A');
  assert.equal(h.checkboxes[0].checked, true);
  assert.equal(h.state().ledger.length, 0);
  assert.equal(h.state().queue.length, 0);
  assert.equal(h.$('#signInModal').classList.contains('show'), false);
  assert.equal(h.run('signInLocked'), false);
  assert.match(h.alerts.join(' '), /could not be saved/u);
});

test('failed instructor Undo persistence retains the original durable batch and usable confirmation', () => {
  const h = instructorHarness();
  h.fill(); h.run('signIn()');
  const original = h.state();
  h.failPersistence(); h.run('undoLastSigninBatch()');
  assert.deepEqual(h.state(), original);
  assert.equal(h.$('#signInModal').classList.contains('show'), true);
  assert.equal(h.$('#btnConfirmSignInUndo').disabled, false);
  assert.equal(h.$('#nameInput').value, 'TEST Person A');
  assert.ok(h.alerts.length > 0, 'the failed Undo must be explained');
  h.failPersistence(false); h.run('undoLastSigninBatch()');
  assert.equal(h.state().ledger.length, 0);
  assert.equal(h.$('#nameInput').value, 'TEST Person A');
});

test('a delayed instructor acknowledgment preserves the next person and acknowledges only submitted IDs', async () => {
  const h = instructorHarness();
  let reply;
  h.context.navigator.onLine = true;
  h.context.requestAcknowledgements = rows => new Promise(resolve => {
    reply = () => resolve({ ok: true, test: true, results: rows.map(row => ({
      rowId: row.RowID, linkedRecordId: row.RowID, result: 'added'
    })) });
  });
  h.fill(); h.run('signIn(); confirmSigninDone()');
  const originalId = h.state().ledger[0].RowID;
  const sync = h.run("syncNow({ type: 'click' })");
  h.fill('TEST Person B', 'Next person is writing', ['TEST Judo']);
  h.$('#notesInput').focus();
  h.clock.sleep(20_000); reply(); await sync;
  assert.equal(h.state().queue.length, 0);
  assert.equal(h.state().ledger[0].RowID, originalId);
  assert.equal(h.$('#nameInput').value, 'TEST Person B');
  assert.equal(h.$('#notesInput').value, 'Next person is writing');
  assert.equal(h.document.activeElement, h.$('#notesInput'));
  assert.equal(h.$('#signInModal').classList.contains('show'), false);
});

const STAFF = [
  { staffId: 'test-person-a', staffName: 'TEST Person A' },
  { staffId: 'test-person-b', staffName: 'TEST Person B' }
];

function staffHarness() {
  const h = browserHarness();
  let state = { version: 2, baseline: null, overlay: [], queue: [] };
  let failure = false;
  let identity = 1;
  const requests = [];
  Object.assign(h.context, {
    TZ: 'America/New_York', BUILD: 'TEST next-person', IS_PRODUCTION_ORIGIN: false,
    installationProfile: { siteCode: 'Rev' },
    loadStaffClockState: () => clone(state),
    saveStaffClockState: next => { if (failure) throw new Error('disk full'); state = clone(next); },
    normalizeStaffClockRecord: value => value,
    createStaffClockPunchId: () => `gib-m1-staff-${String(identity++).padStart(8, '0')}-0000-4000-8000-000000000001`,
    staffClockStatusFor: (id, current = state) => evaluateStaffState(id, current.overlay, { now: new Date(h.clock.now) }),
    formatStaffElapsed, sameStaffClockRecord: sameStaffRecord,
    renderStaffTimeAdmin() {}, refreshStaffClockSnapshot: async () => {},
    resumeStaffClockPairing() {}, showStaffClockAuthorizationRequired() {},
    setStaffClockAvailability: value => h.run(`staffClockAvailability = ${JSON.stringify(value)}`),
    postStaffClock: async body => {
      requests.push(clone(body));
      return { ok: true, target: 'test', results: body.punches.map(punch => ({
        punchId: punch.punchId, linkedPunchId: punch.punchId, result: 'added'
      })) };
    }
  });
  const stateStart = staffSource.indexOf('  const STAFF_SYNC_BATCH_SIZE');
  h.run(staffSource.slice(stateStart, staffSource.indexOf('  function exactStaffClockKeys', stateStart)));
  const functions = [
    'exactStaffClockKeys', 'selectedStaffClockPerson', 'formatStaffClockTime', 'formatStaffClockShift',
    'newYorkStaffTimestamp', 'showStaffClockConfirmation', 'scheduleStaffClockConfirmationDeadline',
    'checkStaffClockConfirmationDeadline', 'updateStaffClockDelivery', 'markStaffClockConfirmationConfirmed',
    'renderStaffClock', 'performStaffClockAction', 'resetStaffClockCard', 'clearStaffClockConfirmation',
    'acceptedStaffClockSyncIds', 'staffClockSyncPunch', 'syncStaffClockQueue'
  ];
  h.run(functions.map(name => functionSource(staffSource, name)).join('\n'));
  h.context.testPeople = clone(STAFF);
  h.run("staffClockPeople = testPeople; staffClockAvailability = 'ready'");
  const lifecycleStart = staffSource.indexOf("  ['focus', 'pageshow', 'popstate'].forEach");
  const lifecycleEnd = staffSource.indexOf('  refreshStaffAdminWhenVisible();', lifecycleStart);
  h.run(staffSource.slice(lifecycleStart, lifecycleEnd));
  h.$('#staffClockConfirmation').hidden = true;
  return Object.assign(h, {
    state: () => clone(state), requests,
    failPersistence(value = true) { failure = value; },
    select(id = STAFF[0].staffId) { h.$('#staffClockName').value = id; h.run('renderStaffClock()'); },
    assertNeutral() {
      assert.equal(h.$('#staffClockConfirmation').hidden, true);
      assert.equal(h.$('#staffClockConfirmationTitle').textContent, '');
      assert.equal(h.$('#staffClockConfirmationDetail').textContent, '');
      assert.equal(h.$('#staffClockName').value, '');
      assert.equal(h.$('#staffClockControls').hidden, false);
      assert.equal(h.run('staffClockConfirmationContext'), null);
      assert.equal(h.run('staffClockActionLocked'), false);
      assert.equal(h.storage.get('auth'), 'preserve-auth');
      assert.equal(h.storage.get('device'), 'preserve-device');
    }
  });
}

test('next-person gate: Revolution Staff Clock in and out reset after five seconds and retain exact punches', () => {
  const h = staffHarness();
  h.select(); h.run('performStaffClockAction(); performStaffClockAction()');
  assert.equal(h.state().overlay.length, 1, 'duplicate taps are locked');
  const savedIn = h.state();
  assert.match(h.$('#staffClockConfirmationTitle').textContent, /Saved on this tablet/u);
  h.clock.advance(4_999);
  assert.equal(h.$('#staffClockConfirmation').hidden, false);
  h.clock.advance(1); h.assertNeutral();
  assert.deepEqual(h.state(), savedIn);
  assert.match(h.$('#staffClockDelivery').textContent, /1 staff punch.*waiting to sync/u);
  assert.doesNotMatch(h.$('#staffClockDelivery').textContent, /TEST Person|10:|Shift/u);

  h.select(STAFF[1].staffId); h.run('performStaffClockAction()');
  h.clock.advance(5_000); h.assertNeutral();
  h.clock.advance(3_590_000);
  h.select();
  assert.equal(h.$('#btnStaffClockAction').dataset.action, 'clockOut');
  h.run('performStaffClockAction()');
  assert.match(h.$('#staffClockConfirmationDetail').textContent, /Shift: 1 hr 0 min/u);
  const savedOut = h.state();
  h.clock.advance(5_000); h.assertNeutral();
  assert.deepEqual(h.state(), savedOut);
  assert.deepEqual(h.state().overlay.map(punch => punch.punchAction), ['clockIn', 'clockIn', 'clockOut']);
  assert.equal(new Set(h.state().overlay.map(punch => punch.punchId)).size, 3);
});

test('Staff Clock acknowledgment changes delivery text without restarting the original five-second deadline', () => {
  const h = staffHarness();
  h.select(); h.run('performStaffClockAction()');
  const originalDeadline = h.run('staffClockConfirmationContext.expiresAt');
  const id = h.state().overlay[0].punchId;
  h.$('#notesInput').value = 'Instructor still writing';
  h.$('#notesInput').focus();
  h.clock.advance(4_900);
  h.run(`markStaffClockConfirmationConfirmed(${JSON.stringify(id)})`);
  assert.equal(h.$('#staffClockConfirmationTitle').textContent, 'Clocked in');
  assert.equal(h.run('staffClockConfirmationContext.expiresAt'), originalDeadline);
  assert.equal(h.document.activeElement, h.$('#notesInput'));
  h.clock.advance(100); h.assertNeutral();
  assert.equal(h.$('#notesInput').value, 'Instructor still writing');
  assert.equal(h.document.activeElement, h.$('#notesInput'));
});

test('Staff Clock Done and an old scheduled callback or acknowledgment cannot erase the next interaction', () => {
  const h = staffHarness();
  h.select(); h.run('performStaffClockAction()');
  const oldContext = h.run('staffClockConfirmationContext');
  const oldCallback = [...h.clock.timers.values()].find(timer => timer.at === oldContext.expiresAt).callback;
  h.run('resetStaffClockCard()');
  assert.equal(h.$('#staffClockConfirmation').hidden, false, '800ms accidental Done guard remains');
  h.clock.advance(800); h.run('resetStaffClockCard()'); h.assertNeutral();
  h.select(STAFF[1].staffId); h.run('performStaffClockAction()');
  const currentContext = h.run('staffClockConfirmationContext');
  h.$('#nameInput').value = 'Another instructor'; h.$('#nameInput').focus();
  oldCallback();
  h.context.oldContext = oldContext;
  h.run('clearStaffClockConfirmation(oldContext); markStaffClockConfirmationConfirmed(oldContext.punch.punchId)');
  assert.equal(h.run('staffClockConfirmationContext'), currentContext);
  assert.match(h.$('#staffClockConfirmationDetail').textContent, /TEST Person B/u);
  assert.equal(h.$('#nameInput').value, 'Another instructor');
  assert.equal(h.document.activeElement, h.$('#nameInput'));
  h.clock.advance(5_000); h.assertNeutral();
});

test('a late Staff Clock acknowledgment clears an expired result without reopening it or moving focus', () => {
  const h = staffHarness();
  h.select(); h.run('performStaffClockAction()');
  const id = h.state().overlay[0].punchId;
  h.$('#notesInput').value = 'Unrelated instructor form'; h.$('#notesInput').focus();
  h.clock.sleep(20_000);
  h.run(`markStaffClockConfirmationConfirmed(${JSON.stringify(id)})`);
  h.assertNeutral();
  assert.equal(h.$('#notesInput').value, 'Unrelated instructor form');
  assert.equal(h.document.activeElement, h.$('#notesInput'));
  h.select(STAFF[1].staffId);
  h.run(`markStaffClockConfirmationConfirmed(${JSON.stringify(id)})`);
  assert.equal(h.$('#staffClockName').value, STAFF[1].staffId);
  assert.equal(h.$('#staffClockConfirmation').hidden, true);
});

test('failed Staff Clock local persistence keeps the selection, allows retry, and starts no success timer', () => {
  const h = staffHarness();
  h.select(); h.failPersistence(); h.run('performStaffClockAction()');
  h.clock.advance(30_000);
  assert.equal(h.state().overlay.length, 0);
  assert.equal(h.state().queue.length, 0);
  assert.equal(h.$('#staffClockName').value, STAFF[0].staffId);
  assert.equal(h.$('#staffClockConfirmation').hidden, true);
  assert.match(h.$('#staffClockStatus').textContent, /could not be saved/u);
  assert.equal(h.$('#btnStaffClockAction').disabled, false);
  h.failPersistence(false); h.run('performStaffClockAction()');
  assert.equal(h.state().overlay.length, 1);
});

test('offline Staff Clock recovery acknowledges only the original IDs and preserves the next active selection', async () => {
  const h = staffHarness();
  h.select(); h.run('performStaffClockAction()'); h.clock.advance(5_000); h.assertNeutral();
  const original = h.state().overlay[0];
  h.select(STAFF[1].staffId); h.$('#staffClockName').focus();
  h.context.navigator.onLine = true;
  await h.run('syncStaffClockQueue()');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].punches[0].punchId, original.punchId);
  assert.equal(h.state().queue.length, 0);
  assert.deepEqual(h.state().overlay, [original]);
  assert.equal(h.$('#staffClockName').value, STAFF[1].staffId);
  assert.equal(h.$('#staffClockConfirmation').hidden, true);
  assert.equal(h.$('#staffClockDelivery').hidden, true);
  assert.equal(h.document.activeElement, h.$('#staffClockName'));
});

for (const flow of ['instructor', 'staff']) {
  for (const event of ['focus', 'pageshow', 'popstate', 'visibilitychange', 'resume']) {
    test(`${flow} confirmation expires on ${event} after suspended timers, preserving saved rows`, () => {
      const h = flow === 'instructor' ? instructorHarness() : staffHarness();
      if (flow === 'instructor') { h.fill(); h.run('signIn()'); }
      else { h.select(); h.run('performStaffClockAction()'); }
      const original = h.state();
      h.clock.sleep(30_000);
      const target = ['visibilitychange', 'resume'].includes(event) ? h.document : h.window;
      target.dispatch(event);
      h.assertNeutral();
      assert.deepEqual(h.state(), original);
      if (flow === 'instructor') h.fill('TEST Active Person', 'Keep unfinished form');
      else h.select(STAFF[1].staffId);
      h.clock.sleep(60_000); target.dispatch(event);
      assert.equal(flow === 'instructor' ? h.$('#nameInput').value : h.$('#staffClockName').value,
        flow === 'instructor' ? 'TEST Active Person' : STAFF[1].staffId);
    });
  }
}
