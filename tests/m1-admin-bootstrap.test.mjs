import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const through = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && through > from);
  return html.slice(from, through);
}

function bootstrapRuntime() {
  let resolveSchedule, rejectSchedule;
  const pendingSchedule = new Promise((resolve, reject) => {
    resolveSchedule = resolve;
    rejectSchedule = reject;
  });
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      disabled: false, hidden: false, value: '', textContent: '', listeners: {},
      classList: { add() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; }
    });
    return nodes.get(selector);
  };
  $('#loginAdminName').value = 'Andrew Smith';
  const calls = { login: 0, loggedIn: 0, loggedOut: 0, review: 0, active: false, refresh: 0 };
  const context = vm.createContext({ $, calls, document: {}, pendingSchedule });
  new vm.Script(`
    const IS_RICHMOND = true;
    const IS_RICHMOND_PRODUCTION = false;
    const ADMIN_MUTATIONS_ENABLED = true;
    const TABLET_PAIRING_AVAILABLE = false;
    const STAFF_CLOCK_ENABLED = false;
    const INSTALLATION = { gymName: 'Richmond BJJ' };
    const API = { login: '/test-login' };
    let schedule = null, adminRequestToken = '';
    const addedClasses = {
      setActive(value) { calls.active = value; }, refresh() {}
    };
    function nyDate() { return '2026-09-07'; }
    function configureAdminLoginEntry() {}
    function showMessage(node, message) { node.textContent = message; }
    function refreshCanonicalSchedule() { return pendingSchedule; }
    function setLoggedOut(message = '') {
      calls.loggedOut += 1; calls.active = false;
      showMessage($('#loginMessage'), message);
    }
    function startCanonicalScheduleRefresh() { calls.refresh += 1; }
    function setLoggedIn() { calls.loggedIn += 1; }
    async function requestJson() {
      calls.login += 1; return { requestToken: 'a'.repeat(32) };
    }
    function requestedManagerMode() { return 'sign-ins'; }
    function defaultYesterday() { return '2026-09-06'; }
    async function loadReview() { calls.review += 1; }
    function openWorkspaceTask() {}
    ${sourceBetween('async function login(', 'async function logout(')}
    ${sourceBetween('async function initialize(', "$('#loginButton').addEventListener('click'")}
    ${sourceBetween("$('#loginButton').addEventListener('click'", "$('#logoutButton').addEventListener('click'")}
    globalThis.hooks = { initialize, login };
  `, { filename: 'admin-bootstrap-race.js' }).runInContext(context);
  return { $, calls, resolveSchedule, rejectSchedule, ...context.hooks };
}

test('pending schedule initialization blocks TEST clicks, ordinary login and Enter before a session can start', async () => {
  const runtime = bootstrapRuntime();
  const initializing = runtime.initialize();
  await runtime.$('#testLoginButton').listeners.click();
  await runtime.$('#loginButton').listeners.click();
  runtime.$('#loginPassphrase').listeners.keydown({ key: 'Enter' });
  await Promise.resolve();
  assert.equal(runtime.calls.login, 0, 'No login request may race the schedule bootstrap');
  assert.equal(runtime.calls.loggedIn, 0);
  assert.equal(runtime.calls.loggedOut, 0);
  for (const selector of ['#loginAdminName', '#loginPassphrase', '#loginButton', '#testLoginButton']) {
    assert.equal(runtime.$(selector).disabled, true);
  }
  runtime.resolveSchedule(true);
  await initializing;
  assert.equal(runtime.calls.loggedOut, 1);
  assert.equal(runtime.calls.refresh, 1);
  for (const selector of ['#loginAdminName', '#loginPassphrase', '#loginButton', '#testLoginButton']) {
    assert.equal(runtime.$(selector).disabled, false);
  }
  await runtime.$('#testLoginButton').listeners.click();
  assert.equal(runtime.calls.login, 1);
  assert.equal(runtime.calls.loggedIn, 1);
  assert.equal(runtime.calls.review, 1);
  assert.equal(runtime.calls.active, true, 'Late initialization cannot deactivate added-class editing');
  assert.equal(runtime.calls.loggedOut, 1);
});

test('failed schedule initialization retains its visible error and releases the login controls', async () => {
  const runtime = bootstrapRuntime();
  const initializing = runtime.initialize();
  await runtime.login(true);
  assert.equal(runtime.calls.login, 0);
  runtime.rejectSchedule(new Error('Delayed schedule request failed'));
  await initializing;
  assert.equal(runtime.calls.loggedOut, 1);
  assert.equal(runtime.calls.refresh, 0);
  assert.equal(runtime.$('#scheduleProblem').hidden, false);
  assert.equal(runtime.$('#scheduleProblem').textContent, 'The class schedule could not be loaded.');
  assert.equal(runtime.$('#loginMessage').textContent, 'The Richmond BJJ schedule could not be loaded.');
  for (const selector of ['#loginAdminName', '#loginPassphrase', '#loginButton', '#testLoginButton']) {
    assert.equal(runtime.$(selector).disabled, false);
  }
});
