import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const adminHtml = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8')
  .replace(/\r\n?/gu, '\n');

const REQUEST_ID = 'gib-m1-staff-request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

function validatorRuntime() {
  const source = sourceBetween(
    adminHtml,
    'function validStaffId(',
    'function validStaffRecord('
  );
  const context = vm.createContext({ Object, Set, String });
  new vm.Script(`
    const STAFF_REQUEST_ID_PATTERN = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const STAFF_TIMESTAMP_PATTERN = /^\\d{4}-\\d{2}-\\d{2}T/;
    let currentAdminName = 'Andrew Smith';
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
    globalThis.hooks = { validStaffRosterResponse, validStaffRosterMutationResponse };
  `, { filename: 'staff-roster-admin-validators.js' }).runInContext(context);
  return context.hooks;
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
    const document = { createElement };
    function $(selector) { return nodes[selector]; }
    function makeElement(tagName, className = '', text = '') {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    }
    function staffEmpty(text) { return makeElement('div', 'empty', text); }
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

function loadHarness({ responses, currentRoster = null } = {}) {
  const panel = new FakeElement('details');
  const summary = new FakeElement('span');
  summary.textContent = currentRoster ? '1 active · 1 inactive' : 'Not loaded';
  const message = new FakeElement('div');
  const appPanel = new FakeElement('section');
  const nodes = {
    '#staff-roster': panel,
    '#staffRosterSummary': summary,
    '#staffRosterMessage': message,
    '#appPanel': appPanel
  };
  const calls = [];
  const rendered = [];
  const disabledStates = [];
  const logoutMessages = [];
  const queue = [...(responses || [])];
  const context = vm.createContext({
    API: { staffRoster: '/.netlify/functions/m1-admin-staff-roster' },
    testMode: true,
    staffRosterLoadGeneration: 0,
    staffRosterMutationInFlight: false,
    currentStaffRoster: currentRoster,
    $: selector => nodes[selector],
    setStaffRosterControlsDisabled: value => disabledStates.push(value),
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
    validStaffRosterResponse: () => true,
    renderStaffRoster: value => rendered.push(JSON.parse(JSON.stringify(value))),
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
  return { context, panel, summary, message, calls, rendered, disabledStates, logoutMessages };
}

function addHarness({ staff = [ACTIVE, INACTIVE], response, failure = null } = {}) {
  const input = new FakeElement('input');
  input.value = '  QA   Test   New Staff  ';
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
  const appPanel = new FakeElement('section');
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
  let clearedIdentities = 0;
  const context = vm.createContext({
    testMode: true,
    staffRosterMutationInFlight: false,
    currentStaffRoster: staff.map(person => ({ ...person })),
    $: selector => nodes[selector],
    clean: value => String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/gu, ' '),
    normalize: value => String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'),
    validStaffName: value => typeof value === 'string' && value.length >= 1 && value.length <= 100,
    validStaffRosterName: value => typeof value === 'string' && value.length >= 1 && value.length <= 100,
    staffRosterNameKey: value => String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'),
    staffRosterAddRequestIdFor: () => REQUEST_ID,
    clearStaffRosterAddIdentity: () => { clearedIdentities += 1; },
    requestFailure: failure,
    recordRequest: body => calls.push(JSON.parse(JSON.stringify(body))),
    responseProvider: () => (typeof response === 'function' ? response() : response),
    setStaffRosterControlsDisabled: disabled => {
      form.setAttribute('aria-busy', disabled ? 'true' : 'false');
      controls.forEach(control => { control.disabled = disabled; });
    },
    showMessage(element, value, tone = 'error') {
      element.textContent = value;
      element.tone = tone;
    },
    API: { staffRoster: '/.netlify/functions/m1-admin-staff-roster' },
    validStaffRosterMutationResponse: () => true,
    toast: value => toasts.push(value),
    loadStaffRoster: async () => { refreshes.push('roster'); return true; },
    loadStaffTime: async () => { refreshes.push('time'); return true; },
    setLoggedOut: value => logoutMessages.push(value)
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
      return responseProvider();
    }
    ${source}
    globalThis.submitStaffRosterAdd = submitStaffRosterAdd;
  `, {
    filename: 'staff-roster-admin-add.js'
  }).runInContext(context);
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
    get resetCalls() { return resetCalls; },
    get clearedIdentities() { return clearedIdentities; }
  };
}

function statusHarness({ person, operation, confirmResult = true, response } = {}) {
  const button = new FakeElement('button');
  button.dataset.staffRosterOperation = operation;
  button.dataset.staffId = person.staffId;
  button.textContent = operation === 'deactivate' ? 'Deactivate' : 'Reactivate';
  const focusTarget = new FakeElement('button');
  const panel = new FakeElement('details');
  const appPanel = new FakeElement('section');
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
  const context = vm.createContext({
    testMode: true,
    staffRosterMutationInFlight: false,
    currentStaffRoster: [{ ...person }],
    $: selector => nodes[selector],
    window: {
      confirm(value) {
        confirmations.push(value);
        return confirmResult;
      }
    },
    staffRosterActionRequestIdFor: () => REQUEST_ID,
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
      return typeof response === 'function' ? response() : response;
    },
    API: { staffRoster: '/.netlify/functions/m1-admin-staff-roster' },
    validStaffRosterMutationResponse: () => true,
    toast() {},
    loadStaffRoster: async () => { refreshes.push('roster'); return true; },
    loadStaffTime: async () => { refreshes.push('time'); return true; },
    setLoggedOut() {},
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
  return {
    context,
    button,
    focusTarget,
    panel,
    status,
    calls,
    confirmations,
    refreshes,
    disabledStates
  };
}

test('Staff Roster is one compact TEST-only section with accessible native controls', () => {
  const markup = sourceBetween(
    adminHtml,
    '<details id="staff-roster"',
    '<details id="staff-time"'
  );
  assert.equal(idCount('staff-roster'), 1);
  assert.match(markup, /\bhidden\b[^>]*aria-busy="false"/u);
  assert.match(markup, /<span>Staff Roster<\/span>/u);
  assert.match(markup, /<label for="staffRosterName">Display name<\/label>/u);
  assert.match(markup, /id="staffRosterName"[^>]*name="staffName"[^>]*maxlength="100"[^>]*required/u);
  assert.match(markup, /id="staffRosterSubmit"[^>]*type="submit"/u);
  assert.match(markup, /id="staffRosterStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
  assert.match(markup, /aria-labelledby="staffRosterActiveHeading"[\s\S]*id="staffRosterActiveList"[^>]*role="list"/u);
  assert.match(markup, /aria-labelledby="staffRosterInactiveHeading"[\s\S]*id="staffRosterInactiveList"[^>]*role="list"/u);
  assert.doesNotMatch(markup, /passphrase|password|PIN|token|Staff ID|rename|delete/iu);
});

test('Staff Roster reuses the existing Admin token path and loads only in authenticated TEST sessions', () => {
  assert.match(adminHtml, /staffRoster:\s*'\/\.netlify\/functions\/m1-admin-staff-roster'/u);
  const requestSource = sourceBetween(adminHtml, 'async function requestJson(', 'function setLoggedOut(');
  assert.match(requestSource, /credentials:\s*'same-origin'/u);
  assert.match(requestSource, /cache:\s*'no-store'/u);
  assert.match(requestSource, /headers\[ADMIN_REQUEST_HEADER\] = adminRequestToken/u);

  const loginSource = sourceBetween(adminHtml, 'async function login(', 'async function logout(');
  const tokenPosition = loginSource.indexOf('adminRequestToken = data.requestToken');
  const rosterPosition = loginSource.indexOf('if (testMode) await loadStaffRoster()');
  assert.ok(tokenPosition >= 0 && rosterPosition > tokenPosition);
  assert.match(loginSource, /setLoggedIn\(data\)[\s\S]*if \(testMode\) await loadStaffRoster\(\)/u);

  const loggedInSource = sourceBetween(adminHtml, 'function setLoggedIn(', 'async function login(');
  assert.match(loggedInSource, /testMode = data\.test === true/u);
  assert.match(loggedInSource, /\$\('#staff-roster'\)\.hidden = !testMode/u);

  const initializeSource = sourceBetween(adminHtml, 'async function initialize()', "$('#loginButton')");
  assert.match(initializeSource, /setLoggedOut\(\)/u);
  assert.doesNotMatch(initializeSource, /loadStaffRoster|API\.staffRoster/u);
  assert.match(adminHtml, /pageshow[\s\S]*if \(testMode\) loadStaffRoster\(\)/u);
  assert.doesNotMatch(adminHtml, /localStorage|sessionStorage/u);
});

test('Staff Roster list and mutation validators reject drift and normalized duplicates', () => {
  const { validStaffRosterResponse, validStaffRosterMutationResponse } = validatorRuntime();
  const validList = rosterResponse();
  assert.equal(validStaffRosterResponse(validList), true);
  assert.equal(validStaffRosterResponse({ ...validList, extra: true }), false);
  assert.equal(validStaffRosterResponse(rosterResponse([
    ACTIVE,
    { ...INACTIVE, staffId: ACTIVE.staffId }
  ])), false);
  assert.equal(validStaffRosterResponse(rosterResponse([
    ACTIVE,
    { ...INACTIVE, staffName: ' qa   TEST staff ' }
  ])), false);
  assert.equal(validStaffRosterResponse(rosterResponse([
    { ...ACTIVE, active: 'TRUE' }
  ])), false);

  const addExpected = { operation: 'add', requestId: REQUEST_ID, staffName: ACTIVE.staffName };
  const addReply = mutationResponse('add', ACTIVE);
  assert.equal(validStaffRosterMutationResponse(addReply, addExpected), true);
  assert.equal(validStaffRosterMutationResponse({
    ...addReply,
    confirmation: { ...addReply.confirmation, previousActive: false }
  }, addExpected), false);

  const deactivateExpected = {
    operation: 'deactivate',
    requestId: REQUEST_ID,
    staffId: ACTIVE.staffId,
    staffName: ACTIVE.staffName
  };
  const deactivateReply = mutationResponse('deactivate', ACTIVE);
  assert.equal(validStaffRosterMutationResponse(deactivateReply, deactivateExpected), true);
  assert.equal(validStaffRosterMutationResponse({
    ...deactivateReply,
    confirmation: { ...deactivateReply.confirmation, staffId: 'qa-test-other' }
  }, deactivateExpected), false);
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
  newer.resolve(rosterResponse([INACTIVE]));
  assert.equal(await secondLoad, true);
  older.resolve(rosterResponse([ACTIVE]));
  assert.equal(await firstLoad, false);
  assert.equal(harness.rendered.length, 1);
  assert.deepEqual(harness.rendered[0].staff, [{ ...INACTIVE }]);
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
  assert.equal(failed.disabledStates.at(-1), false);

  const authError = new Error('expired');
  authError.status = 401;
  const unauthorized = loadHarness({ responses: [() => Promise.reject(authError)] });
  assert.equal(await unauthorized.context.loadStaffRoster(), false);
  assert.deepEqual(unauthorized.logoutMessages, ['Admin login required.']);
  assert.equal(unauthorized.rendered.length, 0);
});

test('add normalizes the display name, sends no Staff ID, and locks repeat submits', async () => {
  const pending = deferredPromise();
  const harness = addHarness({ response: () => pending.promise });
  const addition = harness.context.submitStaffRosterAdd(harness.form);
  assert.deepEqual(harness.calls, [{
    operation: 'add',
    requestId: REQUEST_ID,
    staffName: 'QA Test New Staff'
  }]);
  assert.equal(Object.hasOwn(harness.calls[0], 'staffId'), false);
  assert.equal(harness.input.value, 'QA Test New Staff');
  assert.equal(harness.form.getAttribute('aria-busy'), 'true');
  assert.equal(harness.panel.getAttribute('aria-busy'), 'true');
  assert.equal(harness.submit.textContent, 'Adding…');
  assert.equal(harness.status.textContent, 'Adding QA Test New Staff…');
  assert.equal(harness.status.tone, 'working');

  await harness.context.submitStaffRosterAdd(harness.form);
  assert.equal(harness.calls.length, 1, 'A pending add must block a duplicate submit.');

  pending.resolve(mutationResponse('add', {
    staffId: 'qa-test-new-staff',
    staffName: 'QA Test New Staff',
    active: true
  }));
  await addition;
  assert.equal(harness.resetCalls, 1);
  assert.equal(harness.clearedIdentities, 1);
  assert.deepEqual(harness.refreshes.sort(), ['roster', 'time']);
  assert.equal(harness.status.textContent, 'QA Test New Staff added and active.');
  assert.equal(harness.status.tone, 'success');
  assert.equal(harness.form.getAttribute('aria-busy'), 'false');
  assert.equal(harness.input.focusCalls, 1);
});

test('duplicate add errors preserve the form and direct inactive matches to Reactivate', async () => {
  for (const person of [ACTIVE, INACTIVE]) {
    const duplicate = {
      message: 'duplicate',
      status: 409,
      data: { code: person.active ? 'duplicate_active' : 'reactivate_required' }
    };
    const harness = addHarness({
      staff: [person],
      failure: duplicate
    });
    harness.input.value = `  ${person.staffName.toUpperCase()}  `;
    await harness.context.submitStaffRosterAdd(harness.form);
    assert.equal(harness.resetCalls, 0);
    assert.equal(harness.input.value, person.staffName.toUpperCase());
    assert.equal(harness.refreshes.length, 0);
    assert.equal(harness.form.getAttribute('aria-busy'), 'false');
    if (person.active) {
      assert.equal(harness.status.textContent, `${person.staffName} is already active on the roster.`);
    } else {
      assert.equal(
        harness.status.textContent,
        `${person.staffName} already exists but is inactive. Reactivate the existing record below.`
      );
    }
  }
});

test('deactivation requires a named history-preserving confirmation and cancel sends nothing', async () => {
  const cancelled = statusHarness({
    person: ACTIVE,
    operation: 'deactivate',
    confirmResult: false,
    response: mutationResponse('deactivate', ACTIVE)
  });
  await cancelled.context.submitStaffRosterStatusChange(cancelled.button);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.confirmations.length, 1);
  assert.match(cancelled.confirmations[0], /Deactivate QA Test Staff\?/u);
  assert.match(cancelled.confirmations[0], /disappear from Staff Clock choices immediately/u);
  assert.match(cancelled.confirmations[0], /punches, history, and pay-period totals will remain/u);
  assert.equal(cancelled.panel.getAttribute('aria-busy'), null);

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
