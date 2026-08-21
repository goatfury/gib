import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const adminHtml = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');

const REQUEST_ID = 'gib-m1-staff-request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PENDING_HISTORY_KEY = '__gibM1StaffRosterPendingV1';
const PENDING_MAX_AGE_MS = 30 * 60 * 1_000;
const ACTIVE = Object.freeze({
  staffId: 'qa-test-staff',
  staffName: 'QA Test Staff',
  active: true
});
const INACTIVE = Object.freeze({
  staffId: 'qa-test-former-staff',
  staffName: 'QA Test Former Staff',
  active: false
});
const TEST_OTHER_ACTIVE = Object.freeze({
  staffId: 'qa-test-supervisor',
  staffName: 'QA Test Supervisor',
  active: true
});
const PRODUCTION_ACTIVE = Object.freeze({
  staffId: 'mandy',
  staffName: 'Mandy',
  active: true
});
const PRODUCTION_INACTIVE = Object.freeze({
  staffId: 'former-coach',
  staffName: 'Former Coach',
  active: false
});
const PRODUCTION_OTHER_ACTIVE = Object.freeze({
  staffId: 'marvin',
  staffName: 'Marvin',
  active: true
});

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function idCount(id) {
  return (adminHtml.match(new RegExp(`\\bid="${id}"`, 'gu')) || []).length;
}

function rosterResponse(staff = [ACTIVE, INACTIVE], overrides = {}) {
  return {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    staff: staff.map(person => ({ ...person })),
    ...overrides
  };
}

function mutationResponse(operation, person, overrides = {}) {
  const transitions = {
    add: { result: 'added', previousActive: null, newActive: true },
    deactivate: { result: 'deactivated', previousActive: true, newActive: false },
    reactivate: { result: 'reactivated', previousActive: false, newActive: true }
  };
  const transition = transitions[operation];
  return {
    ok: true,
    test: true,
    adminName: 'Andrew Smith',
    operation,
    requestId: REQUEST_ID,
    result: transition.result,
    confirmation: {
      adminName: 'Andrew Smith',
      staffId: person.staffId,
      staffName: person.staffName,
      action: operation,
      previousActive: transition.previousActive,
      newActive: transition.newActive
    },
    ...overrides
  };
}

function validatorRuntime(testMode = true) {
  const source = sourceBetween(
    adminHtml,
    'function validStaffId(',
    'function validStaffRecord('
  );
  const context = vm.createContext({ Object, Set, String });
  new vm.Script(`
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_TIMESTAMP_PATTERN = /^\\d{4}-\\d{2}-\\d{2}T/;
    const STAFF_ROSTER_CAPACITY = 100;
    let currentAdminName = 'Andrew Smith';
    let currentStaffRoster = null;
    let testMode = ${JSON.stringify(testMode)};
    function clean(value) {
      return String(value == null ? '' : value).normalize('NFKC').trim().replace(/\\s+/g, ' ');
    }
    function normalize(value) {
      return clean(value).toLocaleLowerCase('en-US');
    }
    function exactObjectKeys(value, expectedKeys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const actual = Object.keys(value).sort();
      const expected = [...expectedKeys].sort();
      return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
    }
    ${source}
    globalThis.hooks = {
      validStaffRosterResponse,
      validStaffRosterMutationResponse,
      staffRosterNameKey,
      validStaffRosterId,
      validStaffRosterNameForMode,
      staffRosterNameRejectionMessage,
      staffRosterCapacityMessage,
      staffRosterAddHintText
    };
  `, { filename: 'staff-roster-admin-validators.js' }).runInContext(context);
  return context.hooks;
}

function fakeHistory(initialState = {}) {
  let currentState = structuredClone(initialState);
  const calls = [];
  return {
    get state() {
      return currentState;
    },
    replaceState(nextState, unused, url) {
      currentState = structuredClone(nextState);
      calls.push({ state: structuredClone(currentState), unused, url });
    },
    calls
  };
}

function pendingRosterRuntime({
  history = fakeHistory(),
  testMode = true,
  adminName = 'Andrew Smith',
  now = Date.UTC(2026, 7, 21, 12),
  roster = [],
  uuidSeed = 1
} = {}) {
  const validators = validatorRuntime(testMode);
  const addInput = new FakeElement('input');
  const addForm = new FakeElement('form');
  addForm.elements = [addInput];
  addForm.elements.staffName = addInput;
  const status = new FakeElement('div');
  const nodes = {
    '#staffRosterAddForm': addForm,
    '#staffRosterStatus': status
  };
  const source = sourceBetween(
    adminHtml,
    'function newStaffUuid(',
    'function staffTimestampForInputs('
  );
  let uuidCounter = uuidSeed;
  const context = vm.createContext({
    initialAdminName: adminName,
    initialRoster: structuredClone(roster),
    initialTestMode: testMode,
    history,
    Date: { now: () => now },
    crypto: {
      randomUUID() {
        const tail = (uuidCounter++).toString(16).padStart(12, '0');
        return `00000000-0000-4000-8000-${tail}`;
      }
    },
    exactObjectKeys(value, expectedKeys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const actual = Object.keys(value).sort();
      const expected = [...expectedKeys].sort();
      return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
    },
    validStaffRosterNameForMode: validators.validStaffRosterNameForMode,
    staffRosterNameKey: validators.staffRosterNameKey,
    validStaffRosterId: validators.validStaffRosterId,
    $: selector => nodes[selector],
    clearStaffRosterAddIdentity(form) {
      delete form.dataset.staffRosterFingerprint;
      delete form.dataset.staffRosterRequestId;
    },
    showMessage(element, message, tone = 'error') {
      element.textContent = message;
      element.tone = tone;
    }
  });
  new vm.Script(`
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_ROSTER_PENDING_HISTORY_KEY = ${JSON.stringify(PENDING_HISTORY_KEY)};
    const STAFF_ROSTER_PENDING_VERSION = 1;
    const STAFF_ROSTER_PENDING_MAX_AGE_MS = ${PENDING_MAX_AGE_MS};
    let currentAdminName = initialAdminName;
    let testMode = initialTestMode;
    let currentStaffRoster = initialRoster;
    let pendingStaffRosterMutation = null;
    ${source}
    globalThis.hooks = {
      restore: restorePendingStaffRosterMutation,
      persist: persistPendingStaffRosterMutation,
      reconcile: reconcilePendingStaffRosterMutation,
      present: presentPendingStaffRosterMutation,
      clear: clearPendingStaffRosterMutation,
      addRequestId: staffRosterAddRequestIdFor,
      actionRequestId: staffRosterActionRequestIdFor,
      getPending: () => pendingStaffRosterMutation,
      setRoster: value => { currentStaffRoster = value; }
    };
  `, { filename: 'staff-roster-pending-runtime.js' }).runInContext(context);
  return { context, hooks: context.hooks, history, addForm, addInput, status };
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.style = {};
    this.type = '';
    this.value = '';
    this.focusCalls = 0;
    this.ownText = '';
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle: (value, force) => {
        if (force === true) classes.add(value);
        else if (force === false) classes.delete(value);
        else if (classes.has(value)) classes.delete(value);
        else classes.add(value);
      }
    };
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = node => {
      if (
        selector === '[data-staff-roster-operation]'
        && node.dataset?.staffRosterOperation
      ) matches.push(node);
      for (const child of node.children || []) visit(child);
    };
    visit(this);
    return matches;
  }

  focus() {
    this.focusCalls += 1;
  }

  get textContent() {
    return this.ownText + this.children.map(child => child.textContent || '').join('');
  }

  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
}

function elementText(element) {
  return [
    element.ownText,
    ...(element.children || []).map(elementText)
  ].filter(Boolean).join(' ');
}

function runAuthenticatedSetLoggedOut(clearPendingStaffRosterMutation) {
  const selectors = [
    '#appPanel',
    '#loginPanel',
    '#classList',
    '#unmatchedList',
    '#unmatchedSection',
    '#warningList',
    '#warningSection',
    '#auditList',
    '#searchResults',
    '#staff-roster',
    '#staffRosterSummary',
    '#staffRosterActiveList',
    '#staffRosterInactiveList',
    '#staffRosterAddForm',
    '#staffRosterSubmit',
    '#staffRosterAddHint',
    '#staffRosterMessage',
    '#staffRosterStatus',
    '#staffTimeSummary',
    '#staffClockedInNow',
    '#staffTodayPunches',
    '#staffNeedsAttention',
    '#staffNeedsAttentionSection',
    '#staffPeriodTotals',
    '#staffTimeRecords',
    '#staffTimeAudit',
    '#staffCorrectionName',
    '#staffCorrectionForm',
    '#staffTimeMessage',
    '#staffCorrectionStatus',
    '#loginMessage'
  ];
  const nodes = Object.fromEntries(selectors.map(selector => [selector, new FakeElement()]));
  nodes['#staffRosterAddForm'].reset = () => {};
  const context = vm.createContext({
    currentAdminName: 'Andrew Smith',
    adminRequestToken: 'memory-only-admin-token',
    testMode: true,
    reviewLoadGeneration: 0,
    staffRosterLoadGeneration: 0,
    staffRosterSessionGeneration: 0,
    staffRosterMutationGeneration: 0,
    staffTimeLoadGeneration: 0,
    currentRecords: [{}],
    currentWarnings: [{}],
    currentAuditHistory: [{}],
    persistentReviewOutcome: {},
    currentStaffRoster: [{ ...ACTIVE }],
    staffRosterMutationInFlight: true,
    staffRosterStateFresh: true,
    currentStaffTime: {},
    $: selector => nodes[selector],
    clearPendingStaffRosterMutation,
    clearDiagnosticRun() {},
    clearStaffRosterAddIdentity() {},
    clearStaffCorrectionIdentity() {},
    setStaffRosterControlsDisabled() {},
    makeElement: (tagName, className = '', text = '') => {
      const element = new FakeElement(tagName);
      element.className = className;
      element.textContent = text;
      return element;
    },
    showMessage(element, message) { element.textContent = message; }
  });
  const source = sourceBetween(adminHtml, 'function setLoggedOut(', 'function setLoggedIn(');
  new vm.Script(`${source}\nglobalThis.setLoggedOut = setLoggedOut;`, {
    filename: 'staff-roster-set-logged-out.js'
  }).runInContext(context);
  context.setLoggedOut('You are logged out.');
}

function renderRoster(data) {
  const source = sourceBetween(
    adminHtml,
    'function staffRosterActionButton(',
    'function staffActionLabel('
  );
  const nodes = {
    '#staff-roster': new FakeElement('details'),
    '#staffRosterAddForm': new FakeElement('form'),
    '#staffRosterSummary': new FakeElement('span'),
    '#staffRosterActiveList': new FakeElement('div'),
    '#staffRosterInactiveList': new FakeElement('div')
  };
  nodes['#staffRosterAddForm'].elements = [];
  nodes['#staff-roster'].append(
    nodes['#staffRosterActiveList'],
    nodes['#staffRosterInactiveList']
  );
  const context = vm.createContext({
    data: structuredClone(data),
    nodes,
    createElement: tagName => new FakeElement(tagName)
  });
  new vm.Script(`
    let currentStaffRoster = null;
    let staffRosterMutationInFlight = false;
    let staffRosterStateFresh = false;
    const document = { createElement };
    function $(selector) { return nodes[selector]; }
    function makeElement(tagName, className = '', text = '') {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    }
    function staffEmpty(text) { return makeElement('div', 'empty', text); }
    function updateStaffRosterAddHint() {}
    ${source}
    renderStaffRoster(data);
  `, { filename: 'staff-roster-admin-render.js' }).runInContext(context);
  return nodes;
}

function deferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadHarness({ responses, currentRoster = null, testMode = true, visible = true } = {}) {
  const validators = validatorRuntime(testMode);
  const panel = new FakeElement('details');
  panel.hidden = !visible;
  const summary = new FakeElement('span');
  summary.textContent = currentRoster ? '1 active · 1 inactive' : 'Not loaded';
  const message = new FakeElement('div');
  const appPanel = new FakeElement('section');
  appPanel.hidden = !visible;
  const nodes = {
    '#staff-roster': panel,
    '#staffRosterSummary': summary,
    '#staffRosterMessage': message,
    '#appPanel': appPanel
  };
  const calls = [];
  const rendered = [];
  const disabledStates = [];
  const busyStates = [];
  const logoutMessages = [];
  const queue = [...(responses || [])];
  let context;
  context = vm.createContext({
    API: { staffRoster: '/.netlify/functions/m1-admin-staff-roster' },
    currentAdminName: visible ? 'Andrew Smith' : '',
    testMode,
    staffRosterLoadGeneration: 0,
    staffRosterMutationInFlight: false,
    staffRosterStateFresh: currentRoster !== null,
    currentStaffRoster: currentRoster,
    $: selector => nodes[selector],
    setStaffRosterControlsDisabled(value, busy = value) {
      disabledStates.push(value);
      busyStates.push(busy);
    },
    showMessage(element, value, tone = 'error') {
      element.textContent = value;
      element.tone = tone;
    },
    async requestJson(_url, body) {
      calls.push(JSON.parse(JSON.stringify(body)));
      const next = queue.shift();
      if (!next) throw new Error('Unexpected Staff Roster request.');
      return typeof next === 'function' ? next() : next;
    },
    validStaffRosterResponse: validators.validStaffRosterResponse,
    renderStaffRoster(value) {
      const snapshot = JSON.parse(JSON.stringify(value));
      rendered.push(snapshot);
      context.currentStaffRoster = snapshot.staff;
      context.staffRosterStateFresh = true;
    },
    reconcilePendingStaffRosterMutation() {},
    setLoggedOut: value => logoutMessages.push(value)
  });
  const source = sourceBetween(
    adminHtml,
    'async function loadStaffRoster(',
    'async function submitStaffRosterAdd('
  );
  new vm.Script(`${source}\nglobalThis.loadStaffRoster = loadStaffRoster;`, {
    filename: 'staff-roster-admin-load.js'
  }).runInContext(context);
  return {
    context,
    panel,
    summary,
    message,
    calls,
    rendered,
    disabledStates,
    busyStates,
    logoutMessages
  };
}

function addHarness({
  testMode = true,
  inputValue = testMode ? '  QA   Test   New Staff  ' : '  Jamie   Rivera  ',
  staff = testMode ? [ACTIVE, INACTIVE] : [PRODUCTION_ACTIVE, PRODUCTION_INACTIVE],
  response,
  failure = null,
  visible = true,
  fresh = visible,
  rosterRefresh = true,
  rosterAfterRefresh = null,
  timeRefresh = true
} = {}) {
  const validators = validatorRuntime(testMode);
  const input = new FakeElement('input');
  input.value = inputValue;
  const submit = new FakeElement('button');
  submit.textContent = 'Add staff member';
  const controls = [input, submit];
  controls.staffName = input;
  const form = new FakeElement('form');
  form.elements = controls;
  form.dataset = {};
  let resetCalls = 0;
  form.reset = () => {
    resetCalls += 1;
    input.value = '';
  };
  const panel = new FakeElement('details');
  panel.hidden = !visible;
  const appPanel = new FakeElement('section');
  appPanel.hidden = !visible;
  const status = new FakeElement('div');
  const nodes = {
    '#staff-roster': panel,
    '#staffRosterSubmit': submit,
    '#staffRosterStatus': status,
    '#appPanel': appPanel
  };
  const calls = [];
  const refreshes = [];
  const toasts = [];
  const logoutMessages = [];
  const persistedMutations = [];
  let clearedIdentities = 0;
  let clearedPendingMutations = 0;
  let hasPendingMutation = false;
  let lastResponse = null;
  let context;
  context = vm.createContext({
    currentAdminName: visible ? 'Andrew Smith' : '',
    testMode,
    STAFF_ROSTER_CAPACITY: 100,
    staffRosterSessionGeneration: 1,
    staffRosterMutationGeneration: 1,
    staffRosterMutationInFlight: false,
    staffRosterStateFresh: fresh,
    currentStaffRoster: staff.map(person => ({ ...person })),
    $: selector => nodes[selector],
    clean: value => String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/gu, ' '),
    validStaffRosterNameForMode: validators.validStaffRosterNameForMode,
    staffRosterNameRejectionMessage: validators.staffRosterNameRejectionMessage,
    staffRosterCapacityMessage: validators.staffRosterCapacityMessage,
    staffRosterNameKey: validators.staffRosterNameKey,
    staffRosterAddRequestIdFor: () => REQUEST_ID,
    clearStaffRosterAddIdentity: () => { clearedIdentities += 1; },
    persistPendingStaffRosterMutation(operation, requestId, identity, staffName) {
      hasPendingMutation = true;
      persistedMutations.push({ operation, requestId, identity, staffName });
    },
    clearPendingStaffRosterMutation() {
      hasPendingMutation = false;
      clearedPendingMutations += 1;
    },
    definitiveStaffRosterMutationFailure: error => error?.status === 400 || error?.status === 409,
    requestFailure: failure,
    recordRequest: body => calls.push(JSON.parse(JSON.stringify(body))),
    responseProvider: () => (typeof response === 'function' ? response() : response),
    recordResponse: value => { lastResponse = value; },
    setStaffRosterControlsDisabled: (disabled, busy = disabled) => {
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
      controls.forEach(control => { control.disabled = disabled; });
    },
    showMessage(element, value, tone = 'error') {
      element.textContent = value;
      element.tone = tone;
    },
    API: { staffRoster: '/.netlify/functions/m1-admin-staff-roster' },
    validStaffRosterMutationResponse: validators.validStaffRosterMutationResponse,
    toast: value => toasts.push(value),
    async loadStaffRoster() {
      refreshes.push('roster');
      const refreshed = typeof rosterRefresh === 'function' ? await rosterRefresh() : rosterRefresh;
      if (refreshed !== true) return false;
      let nextRoster = typeof rosterAfterRefresh === 'function'
        ? rosterAfterRefresh(lastResponse, context.currentStaffRoster)
        : rosterAfterRefresh;
      if (nextRoster == null && lastResponse?.confirmation) {
        const confirmation = lastResponse.confirmation;
        nextRoster = [
          ...context.currentStaffRoster.filter(person => person.staffId !== confirmation.staffId),
          {
            staffId: confirmation.staffId,
            staffName: confirmation.staffName,
            active: confirmation.newActive
          }
        ];
      }
      if (nextRoster != null) {
        context.currentStaffRoster = JSON.parse(JSON.stringify(nextRoster));
      }
      context.staffRosterStateFresh = true;
      return true;
    },
    async loadStaffTime() {
      refreshes.push('time');
      return typeof timeRefresh === 'function' ? timeRefresh() : timeRefresh;
    },
    setLoggedOut(value) {
      logoutMessages.push(value);
      context.staffRosterSessionGeneration += 1;
      context.staffRosterMutationGeneration += 1;
      context.staffRosterMutationInFlight = false;
      context.staffRosterStateFresh = false;
      context.currentAdminName = '';
      appPanel.hidden = true;
      panel.hidden = true;
      context.setStaffRosterControlsDisabled(true, false);
    }
  });
  const source = sourceBetween(
    adminHtml,
    'async function submitStaffRosterAdd(',
    'async function submitStaffRosterStatusChange('
  );
  new vm.Script(`
    async function requestJson(_url, body) {
      recordRequest(body);
      if (requestFailure) {
        const error = new Error(requestFailure.message);
        error.status = requestFailure.status;
        error.data = requestFailure.data;
        throw error;
      }
      const result = await responseProvider();
      recordResponse(result);
      return result;
    }
    ${source}
    globalThis.submitStaffRosterAdd = submitStaffRosterAdd;
  `, {
    filename: 'staff-roster-admin-add.js'
  }).runInContext(context);
  if (!fresh) context.setStaffRosterControlsDisabled(true, false);
  const logoutAndRelogin = () => {
    context.staffRosterSessionGeneration += 2;
    context.staffRosterMutationGeneration += 2;
    context.staffRosterMutationInFlight = false;
    context.staffRosterStateFresh = true;
    context.currentAdminName = 'Andrew Smith';
    appPanel.hidden = false;
    panel.hidden = false;
    context.setStaffRosterControlsDisabled(false, false);
    panel.setAttribute('aria-busy', 'false');
    submit.textContent = 'Add staff member';
  };
  return {
    context,
    form,
    input,
    submit,
    panel,
    status,
    calls,
    refreshes,
    toasts,
    logoutMessages,
    persistedMutations,
    logoutAndRelogin,
    get resetCalls() { return resetCalls; },
    get clearedIdentities() { return clearedIdentities; },
    get clearedPendingMutations() { return clearedPendingMutations; },
    get hasPendingMutation() { return hasPendingMutation; }
  };
}

function statusHarness({
  person,
  operation,
  confirmResult = true,
  response,
  failure = null,
  testMode = true,
  visible = true,
  fresh = visible,
  staff = [person, testMode ? TEST_OTHER_ACTIVE : PRODUCTION_OTHER_ACTIVE],
  rosterRefresh = true,
  rosterAfterRefresh = null,
  timeRefresh = true
} = {}) {
  const validators = validatorRuntime(testMode);
  const button = new FakeElement('button');
  button.dataset.staffRosterOperation = operation;
  button.dataset.staffId = person.staffId;
  button.textContent = operation === 'deactivate' ? 'Deactivate' : 'Reactivate';
  const focusTarget = new FakeElement('button');
  const panel = new FakeElement('details');
  panel.hidden = !visible;
  const appPanel = new FakeElement('section');
  appPanel.hidden = !visible;
  const status = new FakeElement('div');
  const nodes = {
    '#staff-roster': panel,
    '#appPanel': appPanel,
    '#staffRosterStatus': status
  };
  const calls = [];
  const confirmations = [];
  const refreshes = [];
  const disabledStates = [];
  const persistedMutations = [];
  let clearedPendingMutations = 0;
  let clearedActionIdentities = 0;
  let hasPendingMutation = false;
  let lastResponse = null;
  let context;
  context = vm.createContext({
    currentAdminName: visible ? 'Andrew Smith' : '',
    testMode,
    staffRosterSessionGeneration: 1,
    staffRosterMutationGeneration: 1,
    staffRosterMutationInFlight: false,
    staffRosterStateFresh: fresh,
    currentStaffRoster: staff.map(item => ({ ...item })),
    $: selector => nodes[selector],
    window: {
      confirm(value) {
        confirmations.push(value);
        return confirmResult;
      }
    },
    staffRosterActionRequestIdFor: () => REQUEST_ID,
    persistPendingStaffRosterMutation(operationValue, requestId, identity, staffName) {
      hasPendingMutation = true;
      persistedMutations.push({ operation: operationValue, requestId, identity, staffName });
    },
    clearPendingStaffRosterMutation() {
      hasPendingMutation = false;
      clearedPendingMutations += 1;
    },
    clearStaffRosterActionIdentity() { clearedActionIdentities += 1; },
    definitiveStaffRosterMutationFailure: error => error?.status === 400 || error?.status === 409,
    setStaffRosterControlsDisabled: disabled => {
      disabledStates.push(disabled);
      button.disabled = disabled;
    },
    showMessage(element, value, tone = 'error') {
      element.textContent = value;
      element.tone = tone;
    },
    async requestJson(_url, body) {
      calls.push(JSON.parse(JSON.stringify(body)));
      if (failure) {
        const error = new Error(failure.message);
        error.status = failure.status;
        error.data = failure.data;
        throw error;
      }
      const result = await (typeof response === 'function' ? response() : response);
      lastResponse = result;
      return result;
    },
    API: { staffRoster: '/.netlify/functions/m1-admin-staff-roster' },
    validStaffRosterMutationResponse: validators.validStaffRosterMutationResponse,
    toast() {},
    async loadStaffRoster() {
      refreshes.push('roster');
      const refreshed = typeof rosterRefresh === 'function' ? await rosterRefresh() : rosterRefresh;
      if (refreshed !== true) return false;
      let nextRoster = typeof rosterAfterRefresh === 'function'
        ? rosterAfterRefresh(lastResponse, context.currentStaffRoster)
        : rosterAfterRefresh;
      if (nextRoster == null && lastResponse?.confirmation) {
        const confirmation = lastResponse.confirmation;
        nextRoster = context.currentStaffRoster.map(item => (
          item.staffId === confirmation.staffId
            ? {
                staffId: confirmation.staffId,
                staffName: confirmation.staffName,
                active: confirmation.newActive
              }
            : item
        ));
      }
      if (nextRoster != null) {
        context.currentStaffRoster = JSON.parse(JSON.stringify(nextRoster));
      }
      context.staffRosterStateFresh = true;
      return true;
    },
    async loadStaffTime() {
      refreshes.push('time');
      return typeof timeRefresh === 'function' ? timeRefresh() : timeRefresh;
    },
    setLoggedOut() {
      context.staffRosterSessionGeneration += 1;
      context.staffRosterMutationGeneration += 1;
      context.staffRosterMutationInFlight = false;
      context.staffRosterStateFresh = false;
      context.currentAdminName = '';
      appPanel.hidden = true;
      panel.hidden = true;
    },
    staffRosterActionButton: () => focusTarget
  });
  const source = sourceBetween(
    adminHtml,
    'async function submitStaffRosterStatusChange(',
    'async function loadStaffTime('
  );
  new vm.Script(`${source}\nglobalThis.submitStaffRosterStatusChange = submitStaffRosterStatusChange;`, {
    filename: 'staff-roster-admin-status.js'
  }).runInContext(context);
  if (!fresh) context.setStaffRosterControlsDisabled(true, false);
  return {
    context,
    button,
    focusTarget,
    panel,
    status,
    calls,
    confirmations,
    refreshes,
    disabledStates,
    persistedMutations,
    get clearedPendingMutations() { return clearedPendingMutations; },
    get clearedActionIdentities() { return clearedActionIdentities; },
    get hasPendingMutation() { return hasPendingMutation; }
  };
}

function reviewNavigationHarness({ testMode = true } = {}) {
  const setLoggedInSource = sourceBetween(
    adminHtml,
    'function setLoggedIn(',
    'async function login('
  );
  const loadReviewSource = sourceBetween(
    adminHtml,
    'async function loadReview(',
    'function setStaffCorrectionDefaults('
  );
  const rosterPanel = new FakeElement('details');
  rosterPanel.open = false;
  const rosterForm = new FakeElement('form');
  rosterForm.elements = [];
  const nodes = {
    '#loginPanel': new FakeElement('section'),
    '#appPanel': new FakeElement('section'),
    '#staff-roster': rosterPanel,
    '#staffRosterSummary': new FakeElement('span'),
    '#staffRosterAddForm': rosterForm,
    '#sessionLabel': new FakeElement('span'),
    '#calendarDate': new FakeElement('input'),
    '#searchDate': new FakeElement('input'),
    '#dateHeading': new FakeElement('strong'),
    '#dateMeta': new FakeElement('span'),
    '#nextDay': new FakeElement('button'),
    '#reviewMessage': new FakeElement('div'),
    '#reviewSection': new FakeElement('section')
  };
  nodes['#loginPanel'].hidden = true;
  nodes['#appPanel'].hidden = false;
  rosterPanel.hidden = false;
  const roster = (testMode
    ? [ACTIVE, INACTIVE]
    : [PRODUCTION_ACTIVE, PRODUCTION_INACTIVE]
  ).map(person => ({ ...person }));
  const reviewRequests = [];
  const rosterControlChanges = [];
  let rosterHintUpdates = 0;
  let reviewRenders = 0;
  const context = vm.createContext({
    API: { review: '/.netlify/functions/m1-admin-review' },
    schedule: { version: 'test-schedule' },
    persistentReviewOutcome: null,
    additionInteractionGeneration: 0,
    reviewLoadGeneration: 0,
    currentDate: '2026-08-20',
    currentRecords: [],
    currentWarnings: [],
    currentAuditHistory: [],
    currentAdminName: 'Andrew Smith',
    testMode,
    currentStaffRoster: roster,
    staffRosterLoadGeneration: 7,
    staffRosterSessionGeneration: 11,
    staffRosterMutationGeneration: 13,
    staffRosterMutationInFlight: true,
    staffRosterStateFresh: true,
    $: selector => nodes[selector],
    nyDate: () => '2026-08-21',
    defaultYesterday: () => '2026-08-20',
    formatDateHeading: value => `Date ${value}`,
    showMessage(element, value, tone = 'error') {
      element.textContent = value;
      element.tone = tone;
    },
    async requestJson(_url, body) {
      reviewRequests.push(JSON.parse(JSON.stringify(body)));
      return {
        adminName: 'Andrew Smith',
        test: testMode,
        date: body.date,
        records: [],
        warnings: [],
        auditHistory: []
      };
    },
    validDailyReviewResponse: (data, date) => (
      data?.adminName === 'Andrew Smith'
      && data.test === testMode
      && data.date === date
      && Array.isArray(data.records)
      && Array.isArray(data.warnings)
      && Array.isArray(data.auditHistory)
    ),
    setStaffRosterControlsDisabled(disabled, busy = disabled) {
      rosterControlChanges.push({ disabled, busy });
    },
    updateStaffRosterAddHint() {
      rosterHintUpdates += 1;
    },
    renderReview() {
      reviewRenders += 1;
    },
    setLoggedOut() {
      throw new Error('Same-session date navigation must not log out.');
    },
    renderRecordList() {},
    auditElement() {}
  });
  new vm.Script(`
    ${setLoggedInSource}
    ${loadReviewSource}
    globalThis.loadReview = loadReview;
  `, { filename: 'staff-roster-review-navigation.js' }).runInContext(context);
  return {
    context,
    nodes,
    rosterPanel,
    reviewRequests,
    rosterControlChanges,
    get rosterHintUpdates() { return rosterHintUpdates; },
    get reviewRenders() { return reviewRenders; }
  };
}

function initializationLoginRaceHarness({ pendingRuntime, scheduleGate }) {
  const loginControlsSource = sourceBetween(
    adminHtml,
    'function setLoginControlsDisabled(',
    'async function login('
  );
  const loginSource = sourceBetween(adminHtml, 'async function login(', 'async function logout(');
  const loadReviewSource = sourceBetween(
    adminHtml,
    'async function loadReview(',
    'function setStaffCorrectionDefaults('
  );
  const initializeSource = sourceBetween(
    adminHtml,
    'async function initialize()',
    "$('#loginButton').addEventListener"
  );
  const nodes = {
    '#loginMessage': new FakeElement('div'),
    '#loginAdminName': new FakeElement('select'),
    '#loginPassphrase': new FakeElement('input'),
    '#loginButton': new FakeElement('button'),
    '#testLoginButton': new FakeElement('button'),
    '#calendarDate': new FakeElement('input'),
    '#searchDate': new FakeElement('input'),
    '#testEntry': new FakeElement('section'),
    '#installSyncSettingsButton': new FakeElement('button'),
    '#tabletDiagnosticButton': new FakeElement('button'),
    '#tabletDiagnosticOriginMessage': new FakeElement('div'),
    '#scheduleSource': new FakeElement('div'),
    '#dateHeading': new FakeElement('strong'),
    '#dateMeta': new FakeElement('span'),
    '#nextDay': new FakeElement('button'),
    '#reviewMessage': new FakeElement('div'),
    '#reviewSection': new FakeElement('section'),
    '#classList': new FakeElement('div'),
    '#unmatchedList': new FakeElement('div'),
    '#unmatchedSection': new FakeElement('section'),
    '#warningList': new FakeElement('div'),
    '#warningSection': new FakeElement('section'),
    '#auditList': new FakeElement('div')
  };
  nodes['#loginAdminName'].value = 'Andrew Smith';
  nodes['#loginPassphrase'].value = 'not-inspected-by-this-test';
  const context = vm.createContext({
    nodes,
    loginReply: {
      ok: true,
      adminName: 'Andrew Smith',
      test: true,
      requestToken: 'a'.repeat(32)
    },
    location: { hostname: 'example.netlify.app' },
    awaitScheduleRefresh: () => scheduleGate.promise,
    restorePending: pendingRuntime.hooks.restore,
    clearPending: pendingRuntime.hooks.clear,
    requestCalls: [],
    loaderCalls: []
  });
  new vm.Script(`
    const API = {
      login: '/.netlify/functions/m1-admin-login',
      review: '/.netlify/functions/m1-admin-review'
    };
    const TEST_ADMIN_HOST_PATTERN = /netlify\.app$/u;
    let currentAdminName = '';
    let adminRequestToken = '';
    let testMode = false;
    let schedule = null;
    let initializationPromise = null;
    let loginAttemptInFlight = false;
    let loggedOutCalls = 0;
    let reviewRenderCalls = 0;
    let persistentReviewOutcome = null;
    let reviewLoadGeneration = 0;
    let additionInteractionGeneration = 0;
    let currentDate = '';
    let currentRecords = [];
    let currentWarnings = [];
    let currentAuditHistory = [];
    function $(selector) { return nodes[selector]; }
    function showMessage(element, message, tone = 'error') {
      element.textContent = message;
      element.tone = tone;
    }
    async function requestJson(url, body) {
      requestCalls.push({ url, body });
      if (url === API.login) return loginReply;
      if (url === API.review) {
        return {
          ok: true,
          adminName: 'Andrew Smith',
          test: true,
          date: body.date,
          records: [],
          warnings: [],
          auditHistory: []
        };
      }
      throw new Error('Unexpected request.');
    }
    function setLoggedIn(data) {
      currentAdminName = data.adminName;
      testMode = data.test === true;
      restorePending();
    }
    function setLoggedOut(message = '') {
      const hadAuthenticatedAdminSession = Boolean(currentAdminName || adminRequestToken);
      if (hadAuthenticatedAdminSession) clearPending();
      loggedOutCalls += 1;
      currentAdminName = '';
      adminRequestToken = '';
      testMode = false;
      showMessage($('#loginMessage'), message);
    }
    function defaultYesterday() { return '2026-08-20'; }
    function formatDateHeading(value) { return value; }
    function validDailyReviewResponse(data, date) {
      return data && data.ok === true
        && data.adminName === currentAdminName
        && data.test === testMode
        && data.date === date
        && Array.isArray(data.records)
        && Array.isArray(data.warnings)
        && Array.isArray(data.auditHistory);
    }
    function renderReview() {
      if (!schedule) throw new Error('Daily Review rendered without a schedule.');
      reviewRenderCalls += 1;
    }
    function renderRecordList() {}
    function auditElement() {}
    async function loadStaffTime() {
      if (!schedule) throw new Error('Staff time loaded without initialization.');
      loaderCalls.push('staffTime');
      return true;
    }
    async function loadStaffRoster() {
      if (!schedule) throw new Error('Staff Roster loaded without initialization.');
      loaderCalls.push('staffRoster');
      return true;
    }
    function focusStaffTimeHash() {}
    function nyDate() { return '2026-08-21'; }
    function validTabletDiagnosticOrigin() { return true; }
    async function refreshCanonicalSchedule() {
      const available = await awaitScheduleRefresh();
      if (available) schedule = { days: { Thursday: ['Class'] } };
      return available;
    }
    function startCanonicalScheduleRefresh() {}
    ${loginControlsSource}
    ${loginSource}
    ${loadReviewSource}
    ${initializeSource}
    globalThis.hooks = {
      startInitialization: () => {
        initializationPromise = initialize();
        return initializationPromise;
      },
      login,
      getAdminName: () => currentAdminName,
      getLoggedOutCalls: () => loggedOutCalls,
      getCurrentDate: () => currentDate,
      getReviewRenderCalls: () => reviewRenderCalls,
      getLoginAttemptInFlight: () => loginAttemptInFlight
    };
  `, { filename: 'staff-roster-initialize-login-race.js' }).runInContext(context);
  return { context, hooks: context.hooks, nodes };
}

test('ambiguous audit-first add survives a full reload and retries the exact request ID and staff name', () => {
  const history = fakeHistory({ reviewDate: '2026-08-20', unrelated: { keep: true } });
  const now = Date.UTC(2026, 7, 21, 12);
  const staffName = "QA Test O'Neil";
  const identity = validatorRuntime(true).staffRosterNameKey(staffName);
  const first = pendingRosterRuntime({ history, now, uuidSeed: 41 });
  const firstForm = new FakeElement('form');
  const requestId = first.hooks.addRequestId(firstForm, staffName);
  first.hooks.persist('add', requestId, identity, staffName);

  const stored = history.state[PENDING_HISTORY_KEY];
  assert.deepEqual(Object.keys(stored).sort(), [
    'adminName',
    'createdAt',
    'identity',
    'operation',
    'requestId',
    'staffName',
    'test',
    'version'
  ]);
  assert.equal(stored.requestId, requestId);
  assert.equal(stored.staffName, staffName);
  assert.equal(stored.identity, identity);
  assert.doesNotMatch(
    JSON.stringify(stored),
    /adminRequestToken|passphrase|memory-only-admin-token/iu
  );
  assert.deepEqual(history.state.unrelated, { keep: true });
  assert.equal(history.state.reviewDate, '2026-08-20');

  const reloaded = pendingRosterRuntime({
    history,
    now: now + 1_000,
    roster: [ACTIVE, INACTIVE],
    uuidSeed: 99
  });
  assert.equal(reloaded.hooks.restore().requestId, requestId);
  reloaded.hooks.reconcile();
  assert.equal(reloaded.addInput.value, staffName);
  assert.match(reloaded.status.textContent, /uncertain outcome/u);
  assert.match(reloaded.status.textContent, /exact saved name[\s\S]*QA Test O'Neil/u);
  const retryForm = new FakeElement('form');
  assert.equal(reloaded.hooks.addRequestId(retryForm, staffName), requestId);
  assert.equal(retryForm.dataset.staffRosterRequestId, requestId);
  assert.equal(Object.hasOwn(history.state, PENDING_HISTORY_KEY), true);
  assert.deepEqual(history.state.unrelated, { keep: true });
});

test('one unresolved roster journal blocks unrelated or non-exact retries without overwriting it', () => {
  const history = fakeHistory({ unrelated: 'preserved' });
  const staffName = 'QA Test Case-Sensitive';
  const identity = validatorRuntime(true).staffRosterNameKey(staffName);
  const runtime = pendingRosterRuntime({ history, uuidSeed: 121 });
  const requestId = runtime.hooks.addRequestId(new FakeElement('form'), staffName);
  runtime.hooks.persist('add', requestId, identity, staffName);
  const original = structuredClone(history.state);

  assert.throws(
    () => runtime.hooks.addRequestId(new FakeElement('form'), 'QA Test case-sensitive'),
    /First confirm or retry the unresolved add for QA Test Case-Sensitive/u
  );
  assert.throws(
    () => runtime.hooks.actionRequestId(
      new FakeElement('button'),
      'deactivate',
      ACTIVE.staffId,
      ACTIVE.staffName
    ),
    /First confirm or retry the unresolved add for QA Test Case-Sensitive/u
  );
  assert.deepEqual(history.state, original);
  assert.equal(
    runtime.hooks.addRequestId(new FakeElement('form'), staffName),
    requestId,
    'Only the exact operation, comparison identity, and canonical name may reuse the journal.'
  );
});

test('a canonical reload clears every pending operation once the exact desired roster state is proven', () => {
  const now = Date.UTC(2026, 7, 21, 12);
  const cases = [
    {
      operation: 'add',
      identity: validatorRuntime(true).staffRosterNameKey('QA Test Added'),
      staffName: 'QA Test Added',
      roster: [{ staffId: 'qa-test-added', staffName: 'QA Test Added', active: true }]
    },
    {
      operation: 'deactivate',
      identity: ACTIVE.staffId,
      staffName: ACTIVE.staffName,
      roster: [{ ...ACTIVE, active: false }]
    },
    {
      operation: 'reactivate',
      identity: INACTIVE.staffId,
      staffName: INACTIVE.staffName,
      roster: [{ ...INACTIVE, active: true }]
    }
  ];

  for (const item of cases) {
    const history = fakeHistory({ unrelated: item.operation });
    const first = pendingRosterRuntime({ history, now });
    first.hooks.persist(item.operation, REQUEST_ID, item.identity, item.staffName);
    const reloaded = pendingRosterRuntime({ history, now: now + 1_000, roster: item.roster });
    assert.equal(reloaded.hooks.restore().requestId, REQUEST_ID);
    reloaded.hooks.present();
    reloaded.hooks.reconcile();
    assert.equal(Object.hasOwn(history.state, PENDING_HISTORY_KEY), false, item.operation);
    assert.equal(history.state.unrelated, item.operation);
    assert.equal(reloaded.hooks.getPending(), null, item.operation);
    assert.match(reloaded.status.textContent, /pending retry was cleared/u);
  }
});

test('malformed, stale, cross-mode, and mismatched pending data is never reused', () => {
  const now = Date.UTC(2026, 7, 21, 12);
  const staffName = 'QA Test Pending';
  const identity = validatorRuntime(true).staffRosterNameKey(staffName);

  const crossModeHistory = fakeHistory({ unrelated: 'cross-mode' });
  pendingRosterRuntime({ history: crossModeHistory, now }).hooks.persist(
    'add', REQUEST_ID, identity, staffName
  );
  const production = pendingRosterRuntime({
    history: crossModeHistory,
    testMode: false,
    now: now + 1_000,
    uuidSeed: 201
  });
  assert.equal(production.hooks.restore(), null);
  assert.equal(Object.hasOwn(crossModeHistory.state, PENDING_HISTORY_KEY), false);
  assert.equal(crossModeHistory.state.unrelated, 'cross-mode');
  assert.notEqual(
    production.hooks.addRequestId(new FakeElement('form'), 'Jamie Rivera'),
    REQUEST_ID
  );

  const staleHistory = fakeHistory({ unrelated: 'stale' });
  pendingRosterRuntime({ history: staleHistory, now }).hooks.persist(
    'add', REQUEST_ID, identity, staffName
  );
  const stale = pendingRosterRuntime({
    history: staleHistory,
    now: now + PENDING_MAX_AGE_MS + 1,
    uuidSeed: 301
  });
  assert.equal(stale.hooks.restore(), null);
  assert.equal(Object.hasOwn(staleHistory.state, PENDING_HISTORY_KEY), false);
  assert.equal(staleHistory.state.unrelated, 'stale');
  assert.notEqual(stale.hooks.addRequestId(new FakeElement('form'), staffName), REQUEST_ID);

  const malformedHistory = fakeHistory({ unrelated: 'malformed' });
  const validSeed = pendingRosterRuntime({ history: malformedHistory, now });
  validSeed.hooks.persist('add', REQUEST_ID, identity, staffName);
  const malformed = structuredClone(malformedHistory.state[PENDING_HISTORY_KEY]);
  malformed.extra = 'not allowed';
  malformedHistory.replaceState({
    ...malformedHistory.state,
    [PENDING_HISTORY_KEY]: malformed
  }, '');
  const strictReload = pendingRosterRuntime({ history: malformedHistory, now: now + 1_000 });
  assert.equal(strictReload.hooks.restore(), null);
  assert.equal(Object.hasOwn(malformedHistory.state, PENDING_HISTORY_KEY), false);
  assert.equal(malformedHistory.state.unrelated, 'malformed');
});

test('authenticated logout clears the same-tab pending roster journal', () => {
  const history = fakeHistory({ unrelated: { keep: true } });
  const runtime = pendingRosterRuntime({ history });
  runtime.hooks.persist('deactivate', REQUEST_ID, ACTIVE.staffId, ACTIVE.staffName);
  assert.equal(Object.hasOwn(history.state, PENDING_HISTORY_KEY), true);
  runAuthenticatedSetLoggedOut(runtime.hooks.clear);
  assert.equal(Object.hasOwn(history.state, PENDING_HISTORY_KEY), false);
  assert.deepEqual(history.state.unrelated, { keep: true });
  assert.equal(runtime.hooks.getPending(), null);
});

test('login waits once for delayed initialization, then performs every authenticated load and exact replay', async () => {
  const now = Date.UTC(2026, 7, 21, 12);
  const staffName = 'QA Test Startup Replay';
  const identity = validatorRuntime(true).staffRosterNameKey(staffName);
  const history = fakeHistory({ unrelated: 'success' });
  const seed = pendingRosterRuntime({ history, now, uuidSeed: 401 });
  const requestId = seed.hooks.addRequestId(new FakeElement('form'), staffName);
  seed.hooks.persist('add', requestId, identity, staffName);

  const reloadedPending = pendingRosterRuntime({
    history,
    now: now + 1_000,
    uuidSeed: 501
  });
  const scheduleGate = deferredPromise();
  const race = initializationLoginRaceHarness({ pendingRuntime: reloadedPending, scheduleGate });
  const initialization = race.hooks.startInitialization();
  const loginAttempt = race.hooks.login(false);
  await Promise.resolve();

  assert.deepEqual(race.context.requestCalls, []);
  assert.equal(race.hooks.getLoginAttemptInFlight(), true);
  assert.equal(race.nodes['#loginAdminName'].disabled, true);
  assert.equal(race.nodes['#loginPassphrase'].disabled, true);
  assert.equal(race.nodes['#loginButton'].disabled, true);
  assert.equal(race.nodes['#testLoginButton'].disabled, true);
  assert.equal(await race.hooks.login(false), false, 'A second login must not start while waiting.');
  assert.deepEqual(race.context.requestCalls, []);

  scheduleGate.resolve(true);
  assert.equal(await initialization, true);
  assert.equal(await loginAttempt, true);
  assert.deepEqual(
    race.context.requestCalls.map(call => call.url),
    [
      '/.netlify/functions/m1-admin-login',
      '/.netlify/functions/m1-admin-review'
    ]
  );
  assert.deepEqual(race.context.loaderCalls, ['staffTime', 'staffRoster']);
  assert.equal(race.hooks.getCurrentDate(), '2026-08-20');
  assert.equal(race.hooks.getReviewRenderCalls(), 1);
  assert.equal(race.hooks.getLoggedOutCalls(), 1, 'Initialization performs only its initial logged-out render.');
  assert.equal(race.hooks.getAdminName(), 'Andrew Smith');
  assert.equal(reloadedPending.hooks.getPending().requestId, requestId);
  assert.equal(reloadedPending.hooks.addRequestId(new FakeElement('form'), staffName), requestId);
  assert.equal(Object.hasOwn(history.state, PENDING_HISTORY_KEY), true);
  assert.equal(history.state.unrelated, 'success');
  assert.equal(race.nodes['#loginButton'].disabled, false);
  assert.equal(race.nodes['#testLoginButton'].disabled, false);
});

test('failed initialization makes no login request, stays logged out, and preserves the pending replay', async () => {
  const now = Date.UTC(2026, 7, 21, 12);
  const staffName = 'QA Test Startup Failure';
  const identity = validatorRuntime(true).staffRosterNameKey(staffName);
  const history = fakeHistory({ unrelated: 'failure' });
  const seed = pendingRosterRuntime({ history, now, uuidSeed: 601 });
  const requestId = seed.hooks.addRequestId(new FakeElement('form'), staffName);
  seed.hooks.persist('add', requestId, identity, staffName);
  const reloadedPending = pendingRosterRuntime({ history, now: now + 1_000, uuidSeed: 701 });
  const scheduleGate = deferredPromise();
  const race = initializationLoginRaceHarness({ pendingRuntime: reloadedPending, scheduleGate });
  const initialization = race.hooks.startInitialization();
  const loginAttempt = race.hooks.login(false);
  await Promise.resolve();

  assert.deepEqual(race.context.requestCalls, []);
  assert.equal(race.nodes['#loginButton'].disabled, true);
  scheduleGate.resolve(false);
  assert.equal(await initialization, false);
  assert.equal(await loginAttempt, false);
  assert.deepEqual(race.context.requestCalls, []);
  assert.deepEqual(race.context.loaderCalls, []);
  assert.equal(race.hooks.getAdminName(), '');
  assert.equal(race.hooks.getCurrentDate(), '');
  assert.equal(race.hooks.getReviewRenderCalls(), 0);
  assert.equal(race.hooks.getLoggedOutCalls(), 1);
  assert.match(race.nodes['#loginMessage'].textContent, /schedule could not be loaded[\s\S]*login is unavailable/u);
  assert.equal(race.nodes['#loginMessage'].tone, 'error');
  assert.equal(race.nodes['#loginButton'].disabled, false);
  assert.equal(race.nodes['#testLoginButton'].disabled, false);
  assert.equal(Object.hasOwn(history.state, PENDING_HISTORY_KEY), true);
  assert.equal(history.state.unrelated, 'failure');

  const laterReload = pendingRosterRuntime({ history, now: now + 2_000, uuidSeed: 801 });
  assert.equal(laterReload.hooks.restore().requestId, requestId);
  assert.equal(laterReload.hooks.addRequestId(new FakeElement('form'), staffName), requestId);
});

test('Staff Roster is one compact authenticated Admin section with accessible native controls', () => {
  const markup = sourceBetween(
    adminHtml,
    '<details id="staff-roster"',
    '<details id="staff-time"'
  );
  assert.equal(idCount('staff-roster'), 1);
  assert.match(markup, /\bhidden\b[^>]*aria-busy="false"/u);
  assert.match(markup, /<span>Staff Roster<\/span>/u);
  assert.match(markup, /id="staffRosterMessage"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
  assert.match(markup, /id="staffRosterAddHint"[^>]*aria-live="polite"/u);
  assert.match(markup, /<label for="staffRosterName">Display name<\/label>/u);
  assert.match(markup, /id="staffRosterName"[^>]*name="staffName"[^>]*maxlength="100"[^>]*required[^>]*aria-describedby="staffRosterAddHint"/u);
  assert.match(markup, /id="staffRosterSubmit"[^>]*type="submit"/u);
  assert.match(markup, /id="staffRosterStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
  assert.match(markup, /aria-labelledby="staffRosterActiveHeading"[\s\S]*id="staffRosterActiveList"[^>]*role="list"/u);
  assert.match(markup, /aria-labelledby="staffRosterInactiveHeading"[\s\S]*id="staffRosterInactiveList"[^>]*role="list"/u);
  assert.doesNotMatch(markup, /passphrase|password|PIN|token|Staff ID|rename|delete/iu);
  assert.doesNotMatch(markup, /name="(?:target|sheetId|webhookUrl|deploymentId|token|environment)"/iu);
});

test('Staff Roster reuses the existing Admin token path and loads for authenticated TEST and production sessions', () => {
  assert.match(adminHtml, /staffRoster:\s*'\/\.netlify\/functions\/m1-admin-staff-roster'/u);
  const requestSource = sourceBetween(adminHtml, 'async function requestJson(', 'function setLoggedOut(');
  assert.match(requestSource, /credentials:\s*'same-origin'/u);
  assert.match(requestSource, /cache:\s*'no-store'/u);
  assert.match(requestSource, /headers\[ADMIN_REQUEST_HEADER\] = adminRequestToken/u);

  const loginSource = sourceBetween(adminHtml, 'async function login(', 'async function logout(');
  const initializationWaitPosition = loginSource.indexOf('await initializationPromise');
  const loginRequestPosition = loginSource.indexOf('await requestJson(API.login');
  const tokenPosition = loginSource.indexOf('adminRequestToken = data.requestToken');
  const rosterPosition = loginSource.indexOf('await loadStaffRoster()');
  assert.ok(
    initializationWaitPosition >= 0
    && loginRequestPosition > initializationWaitPosition
    && tokenPosition > loginRequestPosition
    && rosterPosition > tokenPosition
  );
  assert.match(loginSource, /if \(loginAttemptInFlight\) return false/u);
  assert.match(loginSource, /setLoginControlsDisabled\(true\)/u);
  assert.match(loginSource, /finally[\s\S]*setLoginControlsDisabled\(false\)/u);
  assert.match(loginSource, /setLoggedIn\(data\)[\s\S]*await loadStaffRoster\(\)/u);

  const loggedInSource = sourceBetween(adminHtml, 'function setLoggedIn(', 'async function login(');
  assert.match(loggedInSource, /const nextTestMode = data\.test === true/u);
  assert.match(loggedInSource, /const rosterSessionTransition =/u);
  assert.match(loggedInSource, /if \(rosterSessionTransition\)[\s\S]*staffRosterSessionGeneration \+= 1/u);
  assert.match(loggedInSource, /\$\('#staff-roster'\)\.hidden = false/u);
  assert.match(loggedInSource, /\$\('#staff-roster'\)\.open = true/u);
  assert.match(loggedInSource, /staffRosterStateFresh = false/u);
  assert.match(loggedInSource, /setStaffRosterControlsDisabled\(true, false\)/u);

  const loggedOutSource = sourceBetween(adminHtml, 'function setLoggedOut(', 'function setLoggedIn(');
  assert.match(loggedOutSource, /staffRosterSessionGeneration \+= 1/u);
  assert.match(loggedOutSource, /staffRosterMutationGeneration \+= 1/u);
  assert.match(loggedOutSource, /hadAuthenticatedAdminSession[\s\S]*clearPendingStaffRosterMutation\(\)/u);
  assert.match(loggedOutSource, /setStaffRosterControlsDisabled\(true, false\)/u);
  const logoutSource = sourceBetween(adminHtml, 'async function logout(', 'function defaultYesterday(');
  assert.match(logoutSource, /history\.replaceState\(history\.state, '', location\.pathname\)/u);

  const initializeSource = sourceBetween(adminHtml, 'async function initialize()', "$('#loginButton')");
  assert.match(initializeSource, /setLoggedOut\(\)/u);
  assert.match(initializeSource, /startCanonicalScheduleRefresh\(\);\s*return true/u);
  assert.match(initializeSource, /Admin login is unavailable[\s\S]*return false/u);
  assert.doesNotMatch(initializeSource, /loadStaffRoster|API\.staffRoster/u);
  assert.doesNotMatch(adminHtml, /adminLoginAttemptGeneration/u);
  assert.match(adminHtml, /initializationPromise = initialize\(\)/u);
  assert.match(adminHtml, /pageshow[\s\S]*loadStaffRoster\(\)/u);
  const loadSource = sourceBetween(adminHtml, 'async function loadStaffRoster(', 'async function submitStaffRosterAdd(');
  const addSource = sourceBetween(adminHtml, 'async function submitStaffRosterAdd(', 'async function submitStaffRosterStatusChange(');
  const statusSource = sourceBetween(adminHtml, 'async function submitStaffRosterStatusChange(', 'async function loadStaffTime(');
  for (const operationSource of [loadSource, addSource, statusSource]) {
    assert.match(operationSource, /!currentAdminName[\s\S]*\$\('#appPanel'\)\.hidden[\s\S]*\$\('#staff-roster'\)\.hidden/u);
    assert.doesNotMatch(operationSource, /if \(\s*!testMode|if \(testMode/u);
  }
  for (const mutationSource of [addSource, statusSource]) {
    assert.match(mutationSource, /const sessionGeneration = staffRosterSessionGeneration/u);
    assert.match(mutationSource, /const mutationGeneration = \+\+staffRosterMutationGeneration/u);
    assert.match(mutationSource, /mutationIsCurrent/u);
    assert.match(mutationSource, /setStaffRosterControlsDisabled\(!staffRosterStateFresh, false\)/u);
    const stalePosition = mutationSource.indexOf('staffRosterStateFresh = false;');
    const dispatchPosition = mutationSource.indexOf('await requestJson(API.staffRoster');
    const persistPosition = mutationSource.indexOf('persistPendingStaffRosterMutation(');
    const validationPosition = mutationSource.indexOf('if (!validStaffRosterMutationResponse(');
    const clearPosition = mutationSource.indexOf(
      'clearPendingStaffRosterMutation();',
      validationPosition
    );
    const refreshPosition = mutationSource.indexOf('await Promise.allSettled(', validationPosition);
    assert.ok(persistPosition >= 0 && stalePosition > persistPosition && dispatchPosition > stalePosition);
    assert.ok(
      validationPosition >= 0
      && clearPosition > validationPosition
      && refreshPosition > clearPosition,
      'An exact success envelope must clear the retry journal before canonical refresh.'
    );
  }
  assert.doesNotMatch(adminHtml, /localStorage|sessionStorage/u);
  assert.match(adminHtml, /next\[STAFF_ROSTER_PENDING_HISTORY_KEY\] = candidate/u);
  assert.match(adminHtml, /history\.replaceState\(next, ''\)/u);
  assert.doesNotMatch(
    sourceBetween(adminHtml, 'function persistPendingStaffRosterMutation(', 'function pendingStaffRosterMutationMatches('),
    /adminRequestToken|passphrase|token:/u
  );
});

test('same-session Daily Review date navigation preserves roster freshness and in-flight mutation generations', async () => {
  for (const testMode of [true, false]) {
    const harness = reviewNavigationHarness({ testMode });
    const rosterBefore = JSON.parse(JSON.stringify(harness.context.currentStaffRoster));
    const generationsBefore = {
      load: harness.context.staffRosterLoadGeneration,
      session: harness.context.staffRosterSessionGeneration,
      mutation: harness.context.staffRosterMutationGeneration
    };

    assert.equal(await harness.context.loadReview('2026-08-19'), true);
    assert.equal(await harness.context.loadReview('2026-08-18'), true);
    assert.deepEqual(harness.reviewRequests, [{ date: '2026-08-19' }, { date: '2026-08-18' }]);
    assert.equal(harness.context.currentDate, '2026-08-18');
    assert.deepEqual(harness.context.currentStaffRoster, rosterBefore);
    assert.equal(harness.context.staffRosterStateFresh, true);
    assert.equal(harness.context.staffRosterMutationInFlight, true);
    assert.deepEqual({
      load: harness.context.staffRosterLoadGeneration,
      session: harness.context.staffRosterSessionGeneration,
      mutation: harness.context.staffRosterMutationGeneration
    }, generationsBefore);
    assert.deepEqual(harness.rosterControlChanges, []);
    assert.equal(harness.rosterPanel.open, false);
    assert.equal(harness.rosterHintUpdates, 2);
    assert.equal(harness.reviewRenders, 2);
  }
});

test('Staff Roster validators pin replies to session mode and enforce mode-appropriate names', () => {
  const cases = [
    { testMode: true, active: ACTIVE, inactive: INACTIVE },
    { testMode: false, active: PRODUCTION_ACTIVE, inactive: PRODUCTION_INACTIVE }
  ];

  for (const { testMode, active, inactive } of cases) {
    const hooks = validatorRuntime(testMode);
    const validList = rosterResponse([active, inactive], { test: testMode });
    assert.equal(hooks.validStaffRosterResponse(validList), true);
    assert.equal(hooks.validStaffRosterResponse({ ...validList, test: !testMode }), false);
    assert.equal(hooks.validStaffRosterResponse({ ...validList, extra: true }), false);
    assert.equal(hooks.validStaffRosterResponse(rosterResponse([
      active,
      { ...inactive, staffId: active.staffId }
    ], { test: testMode })), false);
    assert.equal(hooks.validStaffRosterResponse(rosterResponse([
      active,
      { ...inactive, staffName: `  ${active.staffName.toUpperCase()}  ` }
    ], { test: testMode })), false);
    assert.equal(hooks.validStaffRosterResponse(rosterResponse([
      { ...active, active: 'TRUE' }
    ], { test: testMode })), false);

    const addExpected = { operation: 'add', requestId: REQUEST_ID, staffName: active.staffName };
    const addReply = mutationResponse('add', active, { test: testMode });
    assert.equal(hooks.validStaffRosterMutationResponse(addReply, addExpected), true);
    assert.equal(hooks.validStaffRosterMutationResponse({ ...addReply, test: !testMode }, addExpected), false);
    assert.equal(hooks.validStaffRosterMutationResponse({
      ...addReply,
      confirmation: { ...addReply.confirmation, previousActive: false }
    }, addExpected), false);

    const deactivateExpected = {
      operation: 'deactivate',
      requestId: REQUEST_ID,
      staffId: active.staffId,
      staffName: active.staffName
    };
    const deactivateReply = mutationResponse('deactivate', active, { test: testMode });
    assert.equal(hooks.validStaffRosterMutationResponse(deactivateReply, deactivateExpected), true);
    assert.equal(hooks.validStaffRosterMutationResponse({
      ...deactivateReply,
      confirmation: { ...deactivateReply.confirmation, staffId: 'other-staff' }
    }, deactivateExpected), false);
  }

  const testHooks = validatorRuntime(true);
  assert.equal(testHooks.validStaffRosterNameForMode('QA Test Staff'), true);
  assert.equal(testHooks.validStaffRosterNameForMode('Jamie Rivera'), false);
  assert.equal(testHooks.validStaffRosterNameForMode('Do Not Pay Staff'), true);
  assert.equal(testHooks.validStaffRosterNameForMode('Do-Not-Pay Demo'), true);
  assert.equal(testHooks.validStaffRosterNameForMode('Do-Not-Pay Staff'), false);
  assert.match(testHooks.staffRosterNameRejectionMessage(), /obvious TEST name/u);
  assert.match(testHooks.staffRosterAddHintText(2), /98 of 100 roster spots remaining/u);
  assert.match(testHooks.staffRosterCapacityMessage(), /TEST Staff Roster/u);

  const productionHooks = validatorRuntime(false);
  assert.equal(productionHooks.validStaffRosterNameForMode('Jamie Rivera'), true);
  assert.equal(productionHooks.validStaffRosterNameForMode('QA Test Staff'), false);
  assert.equal(productionHooks.validStaffRosterNameForMode('Do-Not-Pay Demo'), false);
  assert.equal(productionHooks.validStaffRosterNameForMode('Do-Not-Pay Staff'), false);
  assert.match(productionHooks.staffRosterNameRejectionMessage(), /not allowed in production/u);
  assert.match(productionHooks.staffRosterAddHintText(2), /real display name[\s\S]*98 of 100 roster spots remaining/u);
  assert.match(productionHooks.staffRosterAddHintText(100), /production Staff Roster[\s\S]*100-record limit/u);
});

test('rendering separates active and inactive names with literal text and named actions', () => {
  const payload = '<img src=x onerror="window.__GIB_XSS_EXECUTED__=true">';
  const nodes = renderRoster(rosterResponse([
    INACTIVE,
    { ...ACTIVE, staffName: payload }
  ]));
  assert.equal(nodes['#staffRosterSummary'].textContent, '1 active · 1 inactive');

  const activeRow = nodes['#staffRosterActiveList'].children[0];
  const inactiveRow = nodes['#staffRosterInactiveList'].children[0];
  assert.equal(activeRow.getAttribute('role'), 'listitem');
  assert.equal(inactiveRow.getAttribute('role'), 'listitem');
  assert.equal(elementText(activeRow).includes(payload), true);
  assert.equal(elementText(activeRow).includes(ACTIVE.staffId), false);
  assert.equal(activeRow.children[1].getAttribute('aria-label'), `Deactivate ${payload}`);
  assert.equal(inactiveRow.children[1].getAttribute('aria-label'), `Reactivate ${INACTIVE.staffName}`);
  assert.equal(activeRow.children.some(child => child.tagName === 'IMG'), false);
});

test('authenticated TEST and production reloads render the next source-backed roster without target selectors', async () => {
  for (const { testMode, active, inactive, otherActive } of [
    { testMode: true, active: ACTIVE, inactive: INACTIVE, otherActive: TEST_OTHER_ACTIVE },
    {
      testMode: false,
      active: PRODUCTION_ACTIVE,
      inactive: PRODUCTION_INACTIVE,
      otherActive: PRODUCTION_OTHER_ACTIVE
    }
  ]) {
    const firstState = rosterResponse([active], { test: testMode });
    const reloadedState = rosterResponse([otherActive, inactive], { test: testMode });
    const harness = loadHarness({ testMode, responses: [firstState, reloadedState] });
    assert.equal(await harness.context.loadStaffRoster(), true);
    assert.equal(await harness.context.loadStaffRoster(), true);
    assert.deepEqual(harness.calls, [{ operation: 'list' }, { operation: 'list' }]);
    assert.deepEqual(
      harness.rendered.map(result => result.staff),
      [[{ ...active }], [{ ...otherActive }, { ...inactive }]]
    );
    assert.deepEqual(harness.context.currentStaffRoster, [{ ...otherActive }, { ...inactive }]);
    for (const request of harness.calls) {
      for (const forbidden of ['target', 'sheetId', 'webhookUrl', 'deploymentId', 'token', 'environment']) {
        assert.equal(Object.hasOwn(request, forbidden), false);
      }
    }
  }
});

test('loading is announced, stale reads cannot overwrite newer data, and controls unlock', async () => {
  const older = deferredPromise();
  const newer = deferredPromise();
  const harness = loadHarness({ responses: [() => older.promise, () => newer.promise] });
  const firstLoad = harness.context.loadStaffRoster();
  assert.equal(harness.panel.classList.contains('loading'), true);
  assert.equal(harness.panel.getAttribute('aria-busy'), 'true');
  assert.equal(harness.summary.textContent, 'Loading…');
  assert.equal(harness.message.textContent, 'Loading Staff Roster…');
  assert.equal(harness.message.tone, 'working');
  assert.deepEqual(harness.calls, [{ operation: 'list' }]);

  const secondLoad = harness.context.loadStaffRoster();
  newer.resolve(rosterResponse([TEST_OTHER_ACTIVE, INACTIVE]));
  assert.equal(await secondLoad, true);
  older.resolve(rosterResponse([ACTIVE]));
  assert.equal(await firstLoad, false);
  assert.equal(harness.rendered.length, 1);
  assert.deepEqual(harness.rendered[0].staff, [{ ...TEST_OTHER_ACTIVE }, { ...INACTIVE }]);
  assert.equal(harness.panel.classList.contains('loading'), false);
  assert.equal(harness.panel.getAttribute('aria-busy'), 'false');
  assert.equal(harness.disabledStates.at(-1), false);
});

test('Staff Roster load errors fail closed and authorization failures end the Admin session', async () => {
  const networkError = new Error('TEST roster unavailable.');
  const failed = loadHarness({ responses: [() => Promise.reject(networkError)] });
  assert.equal(await failed.context.loadStaffRoster(), false);
  assert.equal(failed.summary.textContent, 'Unavailable');
  assert.equal(failed.message.textContent, networkError.message);
  assert.equal(failed.rendered.length, 0);
  assert.equal(failed.disabledStates.at(-1), true);
  assert.equal(failed.busyStates.at(-1), false);
  assert.equal(failed.context.staffRosterStateFresh, false);

  const notYetLoaded = addHarness({ fresh: false });
  assert.equal(notYetLoaded.input.disabled, true);
  assert.equal(notYetLoaded.submit.disabled, true);
  assert.equal(notYetLoaded.form.getAttribute('aria-busy'), 'false');
  await notYetLoaded.context.submitStaffRosterAdd(notYetLoaded.form);
  assert.equal(notYetLoaded.calls.length, 0);

  const authError = new Error('expired');
  authError.status = 401;
  const unauthorized = loadHarness({ responses: [() => Promise.reject(authError)] });
  assert.equal(await unauthorized.context.loadStaffRoster(), false);
  assert.deepEqual(unauthorized.logoutMessages, ['Admin login required.']);
  assert.equal(unauthorized.rendered.length, 0);
});

test('TEST and production adds normalize names, send only the exact mutation contract, and lock repeats', async () => {
  for (const { testMode, staffName, staffId } of [
    { testMode: true, staffName: 'QA Test New Staff', staffId: 'qa-test-new-staff' },
    { testMode: false, staffName: 'Jamie Rivera', staffId: 'jamie-rivera' }
  ]) {
    const pending = deferredPromise();
    const harness = addHarness({ testMode, response: () => pending.promise });
    const addition = harness.context.submitStaffRosterAdd(harness.form);
    assert.deepEqual(harness.calls, [{
      operation: 'add',
      requestId: REQUEST_ID,
      staffName
    }]);
    assert.deepEqual(Object.keys(harness.calls[0]).sort(), ['operation', 'requestId', 'staffName']);
    assert.equal(harness.input.value, staffName);
    assert.equal(harness.form.getAttribute('aria-busy'), 'true');
    assert.equal(harness.panel.getAttribute('aria-busy'), 'true');
    assert.equal(harness.submit.textContent, 'Adding…');
    assert.equal(harness.status.textContent, `Adding ${staffName}…`);
    assert.equal(harness.status.tone, 'working');

    await harness.context.submitStaffRosterAdd(harness.form);
    assert.equal(harness.calls.length, 1, 'A pending add must block a duplicate submit.');

    pending.resolve(mutationResponse('add', { staffId, staffName, active: true }, { test: testMode }));
    await addition;
    assert.equal(harness.resetCalls, 1);
    assert.equal(harness.clearedIdentities, 1);
    assert.deepEqual(harness.refreshes.sort(), ['roster', 'time']);
    assert.equal(harness.status.textContent, `${staffName} added and active.`);
    assert.equal(harness.status.tone, 'success');
    assert.equal(harness.form.getAttribute('aria-busy'), 'false');
    assert.equal(harness.input.focusCalls, 1);
  }
});

test('confirmed add and status mutations stay disabled when the source-backed roster refresh fails', async () => {
  const addedPerson = {
    staffId: 'qa-test-refresh-failure',
    staffName: 'QA Test Refresh Failure',
    active: true
  };
  const add = addHarness({
    inputValue: addedPerson.staffName,
    response: mutationResponse('add', addedPerson),
    rosterRefresh: false
  });
  await add.context.submitStaffRosterAdd(add.form);
  assert.deepEqual(add.refreshes.sort(), ['roster', 'time']);
  assert.match(add.status.textContent, /add for QA Test Refresh Failure was saved/u);
  assert.match(add.status.textContent, /refreshed Staff Roster could not be confirmed/u);
  assert.match(add.status.textContent, /actions remain disabled/u);
  assert.equal(add.status.tone, 'error');
  assert.equal(add.context.staffRosterStateFresh, false);
  assert.equal(add.hasPendingMutation, false);
  assert.equal(add.clearedPendingMutations, 1);
  assert.equal(add.input.disabled, true);
  assert.equal(add.submit.disabled, true);
  assert.equal(add.form.getAttribute('aria-busy'), 'false');
  assert.equal(add.panel.getAttribute('aria-busy'), 'false');
  assert.equal(add.toasts.length, 0);
  await add.context.submitStaffRosterAdd(add.form);
  assert.equal(add.calls.length, 1);

  const status = statusHarness({
    person: ACTIVE,
    operation: 'deactivate',
    response: mutationResponse('deactivate', ACTIVE),
    rosterRefresh: false
  });
  await status.context.submitStaffRosterStatusChange(status.button);
  assert.deepEqual(status.refreshes.sort(), ['roster', 'time']);
  assert.match(status.status.textContent, /deactivation for QA Test Staff was saved/u);
  assert.match(status.status.textContent, /refreshed Staff Roster could not be confirmed/u);
  assert.match(status.status.textContent, /actions remain disabled/u);
  assert.equal(status.status.tone, 'error');
  assert.equal(status.context.staffRosterStateFresh, false);
  assert.equal(status.hasPendingMutation, false);
  assert.equal(status.clearedPendingMutations, 1);
  assert.equal(status.clearedActionIdentities, 1);
  assert.equal(status.button.disabled, true);
  assert.equal(status.panel.getAttribute('aria-busy'), 'false');
  assert.equal(status.focusTarget.focusCalls, 0);
  await status.context.submitStaffRosterStatusChange(status.button);
  assert.equal(status.calls.length, 1);
});

test('ambiguous network, 5xx, and malformed-success outcomes keep roster actions uncertain and disabled', async () => {
  const networkFailure = addHarness({
    failure: { message: 'Network request failed.' }
  });
  await networkFailure.context.submitStaffRosterAdd(networkFailure.form);
  assert.equal(networkFailure.calls.length, 1);
  assert.equal(networkFailure.context.staffRosterStateFresh, false);
  assert.equal(networkFailure.hasPendingMutation, true);
  assert.equal(networkFailure.clearedPendingMutations, 0);
  assert.deepEqual(networkFailure.persistedMutations, [{
    operation: 'add',
    requestId: REQUEST_ID,
    identity: 'qa test new staff',
    staffName: 'QA Test New Staff'
  }]);
  assert.equal(networkFailure.input.disabled, true);
  assert.equal(networkFailure.submit.disabled, true);
  assert.equal(networkFailure.form.getAttribute('aria-busy'), 'false');
  assert.match(networkFailure.status.textContent, /add outcome[\s\S]*is uncertain/u);
  assert.match(networkFailure.status.textContent, /Network request failed/u);
  assert.match(networkFailure.status.textContent, /actions remain disabled/u);

  const serverFailure = statusHarness({
    person: ACTIVE,
    operation: 'deactivate',
    failure: {
      message: 'The Staff Roster request did not complete.',
      status: 502,
      data: { ok: false }
    }
  });
  await serverFailure.context.submitStaffRosterStatusChange(serverFailure.button);
  assert.equal(serverFailure.calls.length, 1);
  assert.equal(serverFailure.context.staffRosterStateFresh, false);
  assert.equal(serverFailure.hasPendingMutation, true);
  assert.equal(serverFailure.clearedPendingMutations, 0);
  assert.equal(serverFailure.button.disabled, true);
  assert.equal(serverFailure.panel.getAttribute('aria-busy'), 'false');
  assert.match(serverFailure.status.textContent, /deactivation outcome[\s\S]*is uncertain/u);
  assert.match(serverFailure.status.textContent, /request did not complete/u);
  assert.match(serverFailure.status.textContent, /actions remain disabled/u);

  const validReactivation = mutationResponse('reactivate', INACTIVE);
  const malformedSuccess = statusHarness({
    person: INACTIVE,
    operation: 'reactivate',
    response: {
      ...validReactivation,
      confirmation: {
        ...validReactivation.confirmation,
        previousActive: true
      }
    }
  });
  await malformedSuccess.context.submitStaffRosterStatusChange(malformedSuccess.button);
  assert.equal(malformedSuccess.calls.length, 1);
  assert.equal(malformedSuccess.context.staffRosterStateFresh, false);
  assert.equal(malformedSuccess.hasPendingMutation, true);
  assert.equal(malformedSuccess.clearedPendingMutations, 0);
  assert.equal(malformedSuccess.button.disabled, true);
  assert.equal(malformedSuccess.refreshes.length, 0);
  assert.match(malformedSuccess.status.textContent, /reactivation outcome[\s\S]*is uncertain/u);
  assert.match(malformedSuccess.status.textContent, /did not confirm the exact reactivate/u);
  assert.match(malformedSuccess.status.textContent, /actions remain disabled/u);
});

test('logout and relogin invalidate an older mutation so its finally cannot unlock the newer one', async () => {
  const olderResponse = deferredPromise();
  const newerResponse = deferredPromise();
  let responseNumber = 0;
  const harness = addHarness({
    response: () => (responseNumber++ === 0 ? olderResponse.promise : newerResponse.promise)
  });

  const olderMutation = harness.context.submitStaffRosterAdd(harness.form);
  assert.equal(harness.calls.length, 1);
  harness.logoutAndRelogin();
  harness.input.value = 'QA Test Relogin Staff';
  const newerMutation = harness.context.submitStaffRosterAdd(harness.form);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.context.staffRosterMutationInFlight, true);
  assert.equal(harness.form.getAttribute('aria-busy'), 'true');

  olderResponse.resolve(mutationResponse('add', {
    staffId: 'qa-test-new-staff',
    staffName: 'QA Test New Staff',
    active: true
  }));
  await olderMutation;
  assert.equal(harness.context.staffRosterMutationInFlight, true);
  assert.equal(harness.input.disabled, true);
  assert.equal(harness.submit.disabled, true);
  assert.equal(harness.form.getAttribute('aria-busy'), 'true');
  assert.equal(harness.status.textContent, 'Adding QA Test Relogin Staff…');
  assert.equal(harness.refreshes.length, 0);

  newerResponse.resolve(mutationResponse('add', {
    staffId: 'qa-test-relogin-staff',
    staffName: 'QA Test Relogin Staff',
    active: true
  }));
  await newerMutation;
  assert.equal(harness.context.staffRosterMutationInFlight, false);
  assert.equal(harness.context.staffRosterStateFresh, true);
  assert.equal(harness.form.getAttribute('aria-busy'), 'false');
  assert.equal(harness.input.disabled, false);
  assert.equal(harness.submit.disabled, false);
  assert.equal(harness.status.textContent, 'QA Test Relogin Staff added and active.');
  assert.deepEqual(harness.refreshes.sort(), ['roster', 'time']);
  assert.equal(harness.resetCalls, 1);
});

test('add rejects cross-mode names and reports mode-appropriate capacity without a request', async () => {
  for (const { testMode, inputValue, expectedMessage } of [
    { testMode: true, inputValue: 'Jamie Rivera', expectedMessage: /obvious TEST name/u },
    { testMode: false, inputValue: 'QA Test Staff', expectedMessage: /not allowed in production/u },
    { testMode: false, inputValue: 'Do-Not-Pay Demo', expectedMessage: /not allowed in production/u }
  ]) {
    const harness = addHarness({ testMode, inputValue });
    await harness.context.submitStaffRosterAdd(harness.form);
    assert.equal(harness.calls.length, 0);
    assert.match(harness.status.textContent, expectedMessage);
    assert.equal(harness.input.focusCalls, 1);
  }

  for (const testMode of [true, false]) {
    const fullRoster = Array.from({ length: 100 }, (_, index) => ({
      staffId: `staff-${index}`,
      staffName: testMode ? `QA Test Staff ${index}` : `Staff Member ${index}`,
      active: index === 0
    }));
    const harness = addHarness({ testMode, staff: fullRoster });
    await harness.context.submitStaffRosterAdd(harness.form);
    assert.equal(harness.calls.length, 0);
    assert.match(harness.status.textContent, new RegExp(`${testMode ? 'TEST' : 'production'} Staff Roster`));
    assert.match(harness.status.textContent, /100-record limit/u);
  }

  const concurrentCapacity = addHarness({
    testMode: false,
    failure: {
      message: 'The Staff Roster has reached its safe staff limit.',
      status: 409,
      data: { code: 'capacity' }
    }
  });
  await concurrentCapacity.context.submitStaffRosterAdd(concurrentCapacity.form);
  assert.equal(concurrentCapacity.calls.length, 1);
  assert.match(concurrentCapacity.status.textContent, /add outcome for Jamie Rivera is uncertain/u);
  assert.match(concurrentCapacity.status.textContent, /production Staff Roster[\s\S]*100-record limit/u);
  assert.match(concurrentCapacity.status.textContent, /actions remain disabled/u);
  assert.equal(concurrentCapacity.context.staffRosterStateFresh, false);
  assert.equal(concurrentCapacity.hasPendingMutation, false);
  assert.equal(concurrentCapacity.clearedPendingMutations, 1);
  assert.equal(concurrentCapacity.clearedIdentities, 1);
  assert.equal(concurrentCapacity.submit.disabled, true);
});

test('hidden or logged-out Staff Roster state blocks loads and mutations in both modes', async () => {
  for (const testMode of [true, false]) {
    const load = loadHarness({
      testMode,
      visible: false,
      responses: [rosterResponse(testMode ? [ACTIVE] : [PRODUCTION_ACTIVE], { test: testMode })]
    });
    assert.equal(await load.context.loadStaffRoster(), false);
    assert.equal(load.calls.length, 0);

    const add = addHarness({ testMode, visible: false });
    await add.context.submitStaffRosterAdd(add.form);
    assert.equal(add.calls.length, 0);

    const person = testMode ? ACTIVE : PRODUCTION_ACTIVE;
    const status = statusHarness({ person, operation: 'deactivate', testMode, visible: false });
    await status.context.submitStaffRosterStatusChange(status.button);
    assert.equal(status.confirmations.length, 0);
    assert.equal(status.calls.length, 0);
  }
});

test('duplicate add errors preserve the form and direct inactive matches to Reactivate', async () => {
  for (const person of [ACTIVE, INACTIVE]) {
    const duplicate = {
      message: 'duplicate',
      status: 409,
      data: { code: person.active ? 'duplicate_active' : 'reactivate_required' }
    };
    const harness = addHarness({
      staff: person.active ? [person] : [TEST_OTHER_ACTIVE, person],
      failure: duplicate
    });
    harness.input.value = `  ${person.staffName.toUpperCase()}  `;
    await harness.context.submitStaffRosterAdd(harness.form);
    assert.equal(harness.resetCalls, 0);
    assert.equal(harness.input.value, person.staffName.toUpperCase());
    assert.equal(harness.refreshes.length, 0);
    assert.equal(harness.form.getAttribute('aria-busy'), 'false');
    assert.equal(harness.context.staffRosterStateFresh, false);
    assert.equal(harness.hasPendingMutation, false);
    assert.equal(harness.clearedPendingMutations, 1);
    assert.equal(harness.clearedIdentities, 1);
    assert.equal(harness.submit.disabled, true);
    assert.match(harness.status.textContent, /add outcome[\s\S]*is uncertain/u);
    assert.match(harness.status.textContent, /actions remain disabled/u);
    if (person.active) {
      assert.match(harness.status.textContent, new RegExp(`${person.staffName} is already active on the roster\\.`));
    } else {
      assert.match(
        harness.status.textContent,
        new RegExp(`${person.staffName} already exists but is inactive\\. Reactivate the existing record below\\.`)
      );
    }
  }
});

test('deactivation in either mode requires named history-preserving confirmation and cancel sends nothing', async () => {
  for (const { testMode, person } of [
    { testMode: true, person: ACTIVE },
    { testMode: false, person: PRODUCTION_ACTIVE }
  ]) {
    const cancelled = statusHarness({
      person,
      operation: 'deactivate',
      confirmResult: false,
      testMode,
      response: mutationResponse('deactivate', person, { test: testMode })
    });
    await cancelled.context.submitStaffRosterStatusChange(cancelled.button);
    assert.equal(cancelled.calls.length, 0);
    assert.equal(cancelled.confirmations.length, 1);
    assert.match(cancelled.confirmations[0], new RegExp(`Deactivate ${person.staffName}\\?`));
    assert.match(cancelled.confirmations[0], /disappear from Staff Clock choices immediately/u);
    assert.match(cancelled.confirmations[0], /punches, history, and pay-period totals will remain/u);
    assert.equal(cancelled.panel.getAttribute('aria-busy'), null);
  }

  const confirmed = statusHarness({
    person: ACTIVE,
    operation: 'deactivate',
    response: mutationResponse('deactivate', ACTIVE)
  });
  await confirmed.context.submitStaffRosterStatusChange(confirmed.button);
  assert.deepEqual(confirmed.calls, [{
    operation: 'deactivate',
    requestId: REQUEST_ID,
    staffId: ACTIVE.staffId
  }]);
  assert.deepEqual(confirmed.refreshes.sort(), ['roster', 'time']);
  assert.equal(confirmed.status.textContent, 'QA Test Staff deactivated and removed from Staff Clock choices.');
  assert.equal(confirmed.status.tone, 'success');
  assert.equal(confirmed.focusTarget.focusCalls, 1);
});

test('reactivation uses the same server-backed mutation path without a deactivation prompt', async () => {
  const harness = statusHarness({
    person: INACTIVE,
    operation: 'reactivate',
    response: mutationResponse('reactivate', INACTIVE)
  });
  await harness.context.submitStaffRosterStatusChange(harness.button);
  assert.equal(harness.confirmations.length, 0);
  assert.deepEqual(harness.calls, [{
    operation: 'reactivate',
    requestId: REQUEST_ID,
    staffId: INACTIVE.staffId
  }]);
  assert.deepEqual(harness.refreshes.sort(), ['roster', 'time']);
  assert.equal(harness.status.textContent, 'QA Test Former Staff reactivated and available in Staff Clock.');
  assert.equal(harness.status.tone, 'success');
  assert.equal(harness.focusTarget.focusCalls, 1);
});
