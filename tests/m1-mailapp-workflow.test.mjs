import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { prepareAttendanceWorkflowMailAppExamples, runAttendanceWorkflowMailAppExamples,
  prepareAttendanceWorkflowDailyExamples, readAttendanceWorkflowExamples } from '../netlify/functions/_lib/m1-attendance-workflow-examples.mjs';
import { handleAttendanceWorkflow } from '../netlify/functions/m1-attendance-workflow.mjs';
import { handleAttendanceWorkflowBackground } from '../netlify/functions/m1-attendance-workflow-background.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { digestHash, DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';

const ID = '123e4567-e89b-42d3-a456-426614174001', OTHER = '123e4567-e89b-42d3-a456-426614174002';
const NOW = Date.parse('2026-09-28T16:00:00Z'), KEY = 'm1-attendance-workflow-test-rev-pending-v1';
class Store {
  entries = new Map(); serial = 0;
  async getWithMetadata(key, options) { assert.equal(options.consistency, 'strong'); return structuredClone(this.entries.get(key) || null); }
  async set(key, raw, options = {}) {
    const before = this.entries.get(key);
    if (options.onlyIfNew && before || options.onlyIfMatch && options.onlyIfMatch !== before?.etag) return { modified: false };
    const etag = String(++this.serial); this.entries.set(key, { data: JSON.parse(raw), etag }); return { modified: true, etag };
  }
  async *list({ prefix = '' } = {}) { yield { blobs: [...this.entries.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; }
  async delete(key) { this.entries.delete(key); }
}
const fixture = () => { const store = new Store(); return { store, deps: { examplesStore: store, clock: () => NOW } }; };
const simulations = store => [...store.entries].filter(([key]) => key.includes('/simulation/')).map(([key, value]) => [key, value.data]);

test('five persisted MailApp examples prove recovery and isolation through the actual workflow', async () => {
  const { store, deps } = fixture(); let network = 0, environment = 0;
  deps.fetch = () => { network++; throw new Error('Caller network forbidden'); };
  Object.defineProperty(deps, 'env', { get: () => { environment++; throw new Error('Caller credentials forbidden'); } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { network++; throw new Error('Global network forbidden'); };
  let result;
  try { result = await runAttendanceWorkflowMailAppExamples(ID, deps); } finally { globalThis.fetch = originalFetch; }
  assert.equal(result.scenarios.length, 5);
  assert.deepEqual(result.scenarios.filter(item => !item.passed).map(item => [item.key, item.summary]), []);
  assert.ok(result.scenarios.every(item => item.key.startsWith('mailapp-')));
  assert.equal(network, 0); assert.equal(environment, 0);
  assert.ok([...store.entries.keys()].every(key => key === 'latestRun' || key.startsWith('examples/' + ID + '/')));
  const original = store.entries.get('examples/' + ID + '/original').data;
  assert.equal(original.kind, 'mailapp'); assert.equal(original.fixtureVersion, 4);
  for (const [, value] of simulations(store)) assert.equal(value.calls, 1, 'each simulated message reaches the actual mail-sending call once');
  const quota = simulations(store).find(([key]) => key.includes('/mailapp-quota-before-call/'))[1];
  assert.equal(quota.sendRequests, 2); assert.equal(quota.calls, 1, 'the first Send request proved no MailApp call occurred');
  for (const [key, value] of simulations(store).filter(([key]) => /\/mailapp-original-(unknown|lost-reply)\//.test(key)))
    assert.equal(value.sendRequests, 1, key + ' must never repeat its uncertain Send request');
  const messages = [...store.entries].filter(([key]) => /\/workflow\/messages\//.test(key)).map(([, item]) => item.data);
  const google = messages.filter(item => item.delivery?.provider === 'mailapp');
  assert.ok(google.some(item => item.state === 'submitted')); assert.ok(google.some(item => item.state === 'unconfirmed'));
  assert.ok(google.every(item => item.state !== 'delivered' && item.delivery.deliveryConfirmed === false && !item.delivery.providerId));
  for (const scenario of result.scenarios) for (const message of scenario.messages) {
    assert.equal(message.gym, 'rev'); assert.deepEqual(message.to, ['stu@example.invalid']); assert.deepEqual(message.cc, []);
    assert.equal(message.adminUrl, DIGEST_ORIGIN + '/m1/admin/');
  }
});

test('MailApp examples retain the original run across reopening and reject reusing its ID for another suite', async () => {
  const { store, deps } = fixture();
  await prepareAttendanceWorkflowMailAppExamples(ID, deps);
  const original = structuredClone(store.entries.get('examples/' + ID + '/original').data);
  const result = await runAttendanceWorkflowMailAppExamples(ID, { ...deps, requirePrepared: true });
  const before = digestHash(simulations(store));
  assert.deepEqual(await readAttendanceWorkflowExamples(ID, deps), result);
  assert.deepEqual(await runAttendanceWorkflowMailAppExamples(ID, { ...deps, clock: () => NOW + 60000 }), result);
  assert.equal(digestHash(simulations(store)), before);
  assert.deepEqual(store.entries.get('examples/' + ID + '/original').data, original);
  await assert.rejects(prepareAttendanceWorkflowDailyExamples(ID, deps), /WORKFLOW_EXAMPLES_KIND_MISMATCH/);
  await assert.rejects(runAttendanceWorkflowMailAppExamples(OTHER, { ...deps, requirePrepared: true }), /WORKFLOW_EXAMPLES_ORIGINAL_REQUIRED/);
});

test('an interrupted example result save resumes its original checkpoints without new sending calls', async () => {
  const { store, deps } = fixture(), set = store.set.bind(store); let stopped = false;
  store.set = async (key, raw, options) => {
    if (!stopped && key.endsWith('/completed/mailapp-original-recovery')) { stopped = true; throw new Error('Synthetic result write interruption'); }
    return set(key, raw, options);
  };
  await assert.rejects(runAttendanceWorkflowMailAppExamples(ID, deps), /Synthetic result write interruption/);
  const originals = simulations(store).map(([key, data]) => [key, digestHash(data)]);
  store.set = set;
  const result = await runAttendanceWorkflowMailAppExamples(ID, { ...deps, clock: () => NOW + 60000 });
  assert.ok(result.scenarios.every(item => item.passed));
  for (const [key, hash] of originals) assert.equal(digestHash(store.entries.get(key).data), hash);
});

const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-transport-secret-1234567890', GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-12345678901234567890' };
const apiDeps = () => ({ enabled: true, target: 'test', env, clock: () => NOW,
  context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } } });
function apiRequest(path, body, options = {}) {
  const runtime = runtimeConfig(env, { admin: true, requestUrl: DIGEST_ORIGIN }), token = 'x'.repeat(43);
  const cookie = createAdminSession('Andrew Smith', runtime.sessionSecret, NOW, token);
  return new Request((options.origin || DIGEST_ORIGIN) + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Origin: options.origin || DIGEST_ORIGIN, ...(options.cookie === false ? {} : { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}` }),
    ...(options.token === false ? {} : { [ADMIN_REQUEST_HEADER]: token }) }, body: JSON.stringify(body) });
}
test('new action uses the same authenticated persisted background handoff and accepts no send configuration', async () => {
  const deps = apiDeps(), order = [], body = { action: 'runMailApp', requestId: ID };
  deps.prepareMailApp = async id => { assert.equal(id, ID); order.push('persist'); };
  deps.readExamples = async () => { order.push('read'); return null; };
  deps.dispatchExamples = async (id, action) => { assert.equal(id, ID); assert.equal(action, 'runMailApp'); order.push('dispatch'); };
  const response = await handleAttendanceWorkflow(apiRequest('/api/m1-attendance-workflow', body), deps), value = await response.json();
  assert.equal(response.status, 202); assert.deepEqual(order, ['persist', 'read', 'dispatch']);
  assert.equal(value.latestRun, null); assert.deepEqual(value.request, { runId: ID, action: 'runMailApp', state: 'pending' });
  let runs = 0;
  deps.runMailApp = async (id, options) => { assert.equal(id, ID); assert.equal(options.requirePrepared, true); runs++; };
  assert.equal((await handleAttendanceWorkflowBackground(apiRequest('/api/m1-attendance-workflow-background', body), deps)).status, 200);
  assert.equal(runs, 1);
  for (const [path, handler] of [['/api/m1-attendance-workflow', handleAttendanceWorkflow], ['/api/m1-attendance-workflow-background', handleAttendanceWorkflowBackground]]) {
    for (const options of [{ cookie: false }, { token: false }, { origin: 'https://gib-live.netlify.app' }, { origin: 'https://gib-richmond-test.netlify.app' }])
      assert.ok([401, 403].includes((await handler(apiRequest(path, body, options), deps)).status));
    assert.equal((await handler(apiRequest(path, { ...body, sendingEnabled: true }), deps)).status, 400);
  }
  assert.equal(runs, 1);
});

const uiSource = readFileSync(new URL('../m1/admin/attendance-workflow.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const uiResponse = latestRun => ({ ok: true, target: 'test', sendingEnabled: false, recurringEnabled: false, latestRun });
function uiHarness(storage = new Map()) {
  const nodes = [], calls = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.events = {}; this.hidden = true; this.ownText = ''; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(' '); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.ownText = ''; this.children = []; this.append(...children); }
    setAttribute() {} addEventListener(name, handler) { this.events[name] = handler; }
    closest() { return this.dataset.workflowAction ? this : this.parent?.closest(); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  }
  const document = { hidden: false, createElement: tag => { const node = new Element(tag); nodes.push(node); return node; } }, root = new Element('section');
  root.ownerDocument = document;
  const context = vm.createContext({ document, location: { origin: DIGEST_ORIGIN, protocol: 'https:', port: '' },
    M1_MANAGER_REVIEW_CONFIG: { enabled: true, target: 'test' }, M1_INSTALLATION_PROFILE: { installationId: 'rev' },
    crypto: { randomUUID: () => ID }, sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: () => 1, clearTimeout: () => {} });
  vm.runInContext(uiSource, context);
  const ui = context.GIBM1AttendanceWorkflow.create({ root, enabled: true, target: 'test', site: 'Rev', getAdmin: () => 'Andrew Smith', getSession: () => 'same-session',
    request: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject, journal: storage.get(KEY) })) });
  return { ui, root, calls, storage, find: action => nodes.findLast(node => root.contains(node) && node.dataset.workflowAction === action),
    click(action) { root.events.click({ target: this.find(action) }); } };
}
test('MailApp button journals original action before dispatch and reload checks it without starting another run', async () => {
  const h = uiHarness(); h.storage.set('unrelated-preserved-queue', 'unchanged');
  const opened = h.ui.open(); await flush(); h.calls[0].resolve(uiResponse(null)); await opened;
  assert.equal(h.find('mailapp').disabled, false); assert.match(h.root.textContent, /not confirmed delivery to an inbox/);
  h.click('mailapp'); await flush();
  assert.deepEqual(JSON.parse(h.calls[1].journal), { requestId: ID, adminName: 'Andrew Smith', action: 'runMailApp' });
  assert.equal(h.calls[1].args[1].action, 'runMailApp'); h.calls[1].reject(new Error('Lost browser response')); await flush();
  h.ui.clear(); const reopened = uiHarness(h.storage), load = reopened.ui.open(); await flush();
  assert.match(reopened.calls[0].args[0], new RegExp('runId=' + ID)); assert.equal(reopened.calls[0].args[2].method, 'GET');
  const run = { runId: ID, complete: true, synthetic: true, scenarios: [{ key: 'mailapp-original-recovery', title: 'Original Google recovery', passed: true,
    summary: 'Google call completed, delivery unconfirmed.', warnings: [], messages: [], checks: ['One simulated send.'] }] };
  reopened.calls[0].resolve(uiResponse(run)); await load;
  assert.equal(reopened.storage.has(KEY), false); assert.equal(reopened.storage.get('unrelated-preserved-queue'), 'unchanged');
  assert.match(reopened.root.textContent, /This saved run checks the Google MailApp policy/);
  assert.equal(reopened.calls.length, 1);
});
