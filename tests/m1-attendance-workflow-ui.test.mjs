import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../m1/admin/attendance-workflow.js', import.meta.url), 'utf8');
const warningSource = readFileSync(new URL('../m1/attendance-warning.js', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app', ID = '00000000-0000-4000-8000-000000000001';
const KEY = 'm1-attendance-workflow-test-rev-pending-v1';
const flush = async () => { for (let n = 0; n < 25; n++) await Promise.resolve(); };
const fixture = (runId = ID) => ({ runId, complete: true, synthetic: true, scenarios: [{ key: 'second-instructor', title: 'Second instructor example', passed: true,
  summary: 'The recorded first instructor does not hide the missing second instructor.', warnings: [{ code: 'DELIVERY_UNCONFIRMED', message: 'Email unconfirmed' }],
  checks: ['Original records are unchanged.'], messages: [{ gym: 'rev', name: 'Revolution', to: ['stu@example.invalid'], cc: [],
    subject: 'Synthetic attendance needs attention', html: '<p>Second instructor requires review.</p>', text: 'Second instructor requires review.', adminUrl: ORIGIN + '/m1/admin/' }] }] });
const response = (latestRun = null, extra = {}) => ({ ok: true, target: 'test', sendingEnabled: false, recurringEnabled: false, latestRun, ...extra });
function harness(options = {}) {
  let now = 100000, sequence = 0, owner = 'Andrew Smith', session = 'session-one', unauthorized = 0;
  const nodes = [], calls = [], timers = new Map(), storage = options.storage || new Map();
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.attributes = {}; this.ownText = ''; this.hidden = true; }
    set innerHTML(_) { throw new Error('Remote HTML must stay inside sandboxed srcdoc'); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(' '); }
    append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
    replaceChildren(...children) { this.ownText = ''; this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, handler) { this.events[name] = handler; }
    closest() { return this.dataset.workflowAction ? this : this.parent?.closest(); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  }
  const document = { readyState: 'complete', hidden: false, createElement: tag => { const node = new Element(tag); nodes.push(node); return node; }, getElementById: () => null };
  const root = new Element('section'); root.ownerDocument = document;
  const context = vm.createContext({ document, location: { origin: ORIGIN, protocol: 'https:', port: '', ...options.location },
    M1_MANAGER_REVIEW_CONFIG: { enabled: true, target: 'test', ...options.config }, M1_INSTALLATION_PROFILE: { installationId: options.gym || 'rev' },
    Date: class extends Date { static now() { return now; } }, crypto: { randomUUID: () => ID },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (options.brokenStorage) throw new Error('Storage failed'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(warningSource, context); vm.runInContext(source, context);
  const ui = context.GIBM1AttendanceWorkflow.create({ root, enabled: true, target: 'test', site: 'Rev', getAdmin: () => owner, getSession: () => session,
    request: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject, journalAtDispatch: storage.get(KEY) })),
    onUnauthorized: () => { unauthorized++; ui.clear(); }, ...options.create });
  const find = action => nodes.findLast(node => root.contains(node) && node.dataset.workflowAction === action);
  return { ui, root, calls, nodes, storage, timers, document, find, context, unauthorized: () => unauthorized,
    setAdmin: value => { owner = value; }, setSession: value => { session = value; },
    click(action) { root.events.click({ target: find(action) }); },
    async open(value = response()) { const opened = ui.open(); await flush(); calls.at(-1).resolve(value); await opened; },
    async tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); }
  };
}

test('workflow UI is inert outside exact enabled Revolution TEST origin', () => {
  for (const options of [{ config: { enabled: false } }, { config: { target: 'production' } }, { gym: 'richmond' },
    { location: { origin: 'https://gib-live.netlify.app' } }, { location: { port: '443' } }, { create: { enabled: false } }, { create: { getSession: null } }]) {
    const h = harness(options); assert.equal(h.ui, null); assert.equal(h.root.hidden, true); assert.equal(h.calls.length, 0);
  }
});

test('authenticated examples label simulation, preserve coverage, and render only fixed per-gym correction links', async () => {
  const h = harness(), result = fixture(); result.scenarios[0].messages.push({ ...result.scenarios[0].messages[0], gym: 'richmond', name: 'Richmond', to: ['trey@example.invalid'], adminUrl: 'https://gib-richmond-test.netlify.app/m1/admin/' });
  await h.open(response(result));
  assert.match(h.root.textContent, /No emails are sent/); assert.match(h.root.textContent, /Trey still needs existing Admin access/);
  assert.match(h.root.textContent, /unreviewed day does not prove a missing sign-in/); assert.match(h.root.textContent, /Staff Clock finish corrections remain separate/);
  assert.match(h.root.textContent, /simulated email/); assert.match(h.root.textContent, /delivery is unconfirmed/);
  assert.doesNotMatch(h.root.textContent, /DELIVERY_UNCONFIRMED/);
  assert.deepEqual(h.nodes.filter(node => h.root.contains(node) && node.tag === 'a').map(node => node.href), [ORIGIN + '/m1/admin/', 'https://gib-richmond-test.netlify.app/m1/admin/']);
  for (const frame of h.nodes.filter(node => h.root.contains(node) && node.tag === 'iframe')) {
    assert.equal(frame.attributes.sandbox, ''); assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
    assert.match(frame.srcdoc, /<body inert>/); assert.match(frame.attributes.csp, /script-src 'none'/); assert.equal(frame.style.width, '100%');
  }
  assert.equal(h.calls[0].args[2].method, 'GET'); assert.equal(h.storage.size, 0);
});

test('only the two-gym routing example starts expanded; other examples expose compact pass/failure summaries', async () => {
  const h = harness(), run = fixture();
  run.scenarios = [{ ...run.scenarios[0], key: 'routing', title: 'Two gym routing' }, ...Array.from({ length: 11 }, (_, index) =>
    ({ ...run.scenarios[0], key: 'case-' + index, title: 'Case ' + index, passed: index !== 3 }))];
  await h.open(response(run));
  const scenarios = h.nodes.filter(node => h.root.contains(node) && node.className === 'manager-class');
  assert.equal(scenarios.length, 12); assert.equal(scenarios[0].open, true); assert.ok(scenarios.slice(1).every(node => node.open === false));
  assert.match(scenarios[4].children[0].textContent, /Needs attention/);
});

test('current health stays separate from synthetic passes and unknown or stale health never becomes clear', async () => {
  const health = { ok: true, target: 'test', state: 'clear', codes: [], checkedAt: new Date(100000).toISOString(), expiresAt: new Date(1900000).toISOString(),
    pendingCount: 0, failedCount: 0, unconfirmedCount: 0 };
  for (const change of [{ state: 'unknown' }, { checkedAt: 'invalid' }, { checkedAt: new Date(-1800000).toISOString() }, { failedCount: 1 }, { expiresAt: new Date(99999).toISOString() }]) {
    const h = harness(); await h.open(response(fixture(), { current: { health: { ...health, ...change }, messages: [] } }));
    assert.match(h.root.textContent, /Current attendance check status unavailable/); assert.doesNotMatch(h.root.textContent, /Current attendance check completed/);
    assert.match(h.root.textContent, /Example passed/, 'valid synthetic evidence stays readable independently');
  }
  const attention = harness(); await attention.open(response(fixture(), { current: { health: { ...health, state: 'attention' }, messages: [] } }));
  assert.match(attention.root.textContent, /Attendance still needs review/);
});

test('a failed or incomplete read never presents fresh success or enables stale correction links', async () => {
  const h = harness(); await h.open(response(fixture())); const read = h.ui.refresh(); await flush(); h.calls[1].reject(new Error('Offline')); await read;
  assert.match(h.root.textContent, /status unavailable/); assert.match(h.root.textContent, /Previously loaded examples/);
  assert.equal(h.nodes.filter(node => h.root.contains(node) && node.tag === 'a').length, 0);
  const invalid = structuredClone(fixture()); invalid.scenarios[0].messages[0].adminUrl = 'https://gib-live.netlify.app/m1/admin/';
  const retry = h.ui.refresh(); await flush(); h.calls[2].resolve(response(invalid)); await retry;
  assert.match(h.root.textContent, /status unavailable/);
  const recovery = h.ui.refresh(); await flush(); h.calls[3].resolve(response(fixture())); await recovery;
  assert.match(h.root.textContent, /Saved synthetic examples loaded/); assert.equal(h.nodes.filter(node => h.root.contains(node) && node.tag === 'a').length, 1);
});

test('a run is retained before POST, duplicate clicks share one request, and a lost reply recovers by original GET after reload', async () => {
  const storage = new Map(), first = harness({ storage }); await first.open(); first.click('run'); first.click('run'); await flush();
  assert.equal(first.calls.length, 2); assert.deepEqual(JSON.parse(JSON.stringify(first.calls[1].args[1])), { action: 'runExamples', requestId: ID });
  assert.deepEqual(JSON.parse(first.calls[1].journalAtDispatch), { requestId: ID, adminName: 'Andrew Smith' });
  first.calls[1].reject(new Error('Lost reply')); await flush(); assert.match(first.root.textContent, /request ID is retained/); first.ui.clear();
  const reopened = harness({ storage }); const opened = reopened.ui.open(); await flush();
  assert.equal(reopened.calls[0].args[0], '/api/m1-attendance-workflow?runId=' + ID); assert.equal(reopened.calls[0].args[2].method, 'GET');
  reopened.calls[0].resolve(response(fixture())); await opened;
  assert.equal(storage.size, 0); assert.match(reopened.root.textContent, /original synthetic run is confirmed centrally/); assert.equal(reopened.calls.length, 1);
});

test('202 and pending GETs poll sequentially with one original ID; polling is bounded with a clear recovery control', async () => {
  const h = harness(); await h.open(); h.click('run'); await flush();
  h.calls[1].resolve(response(null, { request: { runId: ID, state: 'pending' } })); await flush();
  assert.equal(h.storage.size, 1); assert.equal(h.timers.size, 1); await h.tick(1000); assert.equal(h.calls.length, 3);
  await h.tick(5000); assert.equal(h.calls.length, 3, 'pending read cannot overlap itself');
  h.calls[2].resolve(response()); await flush(); await h.tick(120000);
  assert.equal(h.calls.length, 3);
  assert.equal(h.timers.size, 0); assert.match(h.root.textContent, /Use Check original example run/); assert.equal(h.storage.size, 1);
  h.click('refresh'); await flush(); h.calls[3].resolve(response(fixture())); await flush();
  assert.equal(h.storage.size, 0); assert.equal(h.timers.size, 0); assert.equal(h.calls.filter(call => call.args[1]?.action === 'runExamples').length, 1);
});

test('unconfirmed and mismatched outcomes retain original requests; explicit retry reuses identity', async () => {
  const h = harness(); await h.open(); h.click('run'); await flush();
  h.calls[1].resolve(response(fixture('00000000-0000-4000-8000-000000000099'))); await flush();
  assert.equal(h.storage.size, 1); assert.match(h.root.textContent, /not confirmed/);
  h.click('run'); await flush(); assert.deepEqual(h.calls[2].args[1], h.calls[1].args[1]);
  h.calls[2].resolve(response(fixture())); await flush(); assert.equal(h.storage.size, 0);
});

test('another reviewer, expired session, logout and late requests cannot show stale completion', async () => {
  const storage = new Map([[KEY, JSON.stringify({ requestId: ID, adminName: 'Stuart Turner' })]]), h = harness({ storage });
  await h.open(); assert.equal(h.find('run').disabled, true); h.click('run'); assert.equal(h.calls.length, 1); assert.equal(storage.size, 1);
  for (const change of ['session', 'logout']) {
    const own = harness(); const first = own.ui.open(); await flush();
    if (change === 'session') own.setSession('session-two'); else own.ui.clear();
    own.calls[0].resolve(response(fixture())); await first;
    assert.doesNotMatch(own.root.textContent, /Example passed/);
  }
  const expired = harness(); const opening = expired.ui.open(); await flush(); expired.calls[0].reject(Object.assign(new Error('Expired'), { status: 401 })); await opening;
  assert.equal(expired.unauthorized(), 1); assert.equal(expired.root.hidden, true);
});

test('broken storage preserves unrelated queues and prevents dispatch; malformed journal is never discarded', async () => {
  const storage = new Map([['original-queue', 'keep'], ['pending-save', 'keep']]), h = harness({ storage, brokenStorage: true }); await h.open();
  h.click('run'); await flush(); assert.equal(h.calls.length, 1); assert.match(h.root.textContent, /retained safely/); assert.equal(storage.size, 2);
  const corrupt = new Map([[KEY, '{retained original']]), bad = harness({ storage: corrupt }); await bad.open(); bad.click('run');
  assert.equal(bad.calls.length, 1); assert.equal(corrupt.get(KEY), '{retained original');
});

test('real Admin wiring preserves authenticated GET and lifecycle clearing', () => {
  assert.match(admin, /<section id="attendanceWorkflow"/); assert.match(admin, /src="\.\/attendance-workflow\.js"/);
  assert.match(admin, /digest\(\?:-email\)\?\|workflow/); assert.match(admin, /attendanceWorkflow\.clear\(\)/);
  assert.match(admin, /GIBM1AttendanceWorkflow\?\.create\([\s\S]*?getSession:\s*\(\)\s*=>\s*adminRequestToken/);
});
