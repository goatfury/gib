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
const setup = () => ({ revolutionReviewer: 'Stu', richmondReviewer: 'Trey', senderAddress: 'revbjjops@gmail.com',
  revolutionTo: 'info@revolutionbjj.com', richmondTo: 'info@richmondbjj.com', cc: [], bcc: ['andrew@revolutionbjj.com'],
  dailyLocalTime: '20:00', timezone: 'America/New_York', reminderTimeConfirmed: true, classFinishCutoffConfirmed: false, richmondReviewerAccessVerified: false });
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

test('current selected recipient setup distinguishes confirmed reminder time from class ending and access', async () => {
  const h = harness(); await h.open(response(fixture(), { setup: setup() }));
  assert.match(h.root.textContent, /Proposed sender: revbjjops@gmail.com/);
  assert.match(h.root.textContent, /Revolution: Stu at info@revolutionbjj.com\. Richmond: Trey at info@richmondbjj.com\. CC: none\. Hidden BCC copy: andrew@revolutionbjj.com/);
  assert.match(h.root.textContent, /Daily reminder: 20:00 America\/New_York \(confirmed\)/);
  assert.match(h.root.textContent, /follows daylight saving time/); assert.match(h.root.textContent, /does not confirm class finishing times/);
  assert.match(h.root.textContent, /Trey still needs existing Admin access/);
  assert.doesNotMatch(h.root.textContent, /email addresses are not configured|actual closing cutoff/);
  for (const frame of h.nodes.filter(node => h.root.contains(node) && node.tag === 'iframe')) assert.doesNotMatch(frame.srcdoc, /andrew@revolutionbjj.com/);
  const off = harness(); await off.open(response(null, { setup: { ...setup(), bcc: [] } }));
  assert.match(off.root.textContent, /Hidden BCC copy: off/);
  const refresh = h.ui.refresh(); await flush(); h.calls[1].reject(new Error('offline')); await refresh;
  assert.match(h.root.textContent, /Current reminder and recipient configuration has not been loaded/);
  assert.doesNotMatch(h.root.textContent, /Daily reminder: 20:00/);
});

test('new invalid setup cannot become current while old saved examples retain their historical content', async () => {
  for (const change of [{ senderAddress: 'unsafe\naddress' }, { cc: ['andrew@revolutionbjj.com'] }, { cc: null },
    { bcc: ['bad'] }, { dailyLocalTime: '25:00' }, { timezone: 'UTC' }, { classFinishCutoffConfirmed: true }, { richmondReviewerAccessVerified: true }]) {
    const h = harness(); await h.open(response(fixture(), { setup: { ...setup(), ...change } }));
    assert.match(h.root.textContent, /status unavailable/); assert.doesNotMatch(h.root.textContent, /Example passed/);
  }
  const legacy = harness(); await legacy.open(response(fixture(), { setup: { copyAndrewDefault: false, recipientAddressesVerified: false } }));
  assert.match(legacy.root.textContent, /Example passed/);
  assert.equal(legacy.nodes.find(node => legacy.root.contains(node) && node.tag === 'iframe').srcdoc.includes(fixture().scenarios[0].messages[0].html), true);
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

test('historical unknown send results remain visible separately when a newer current check is healthy', async () => {
  const health = { ok: true, target: 'test', state: 'clear', codes: [], checkedAt: new Date(100000).toISOString(), expiresAt: new Date(1900000).toISOString(),
    pendingCount: 0, failedCount: 0, unconfirmedCount: 0, historicalUnconfirmedCount: 2, historicalFailedCount: 0, opportunityDate: '2026-09-27' };
  const h = harness(); await h.open(response(null, { current: { health } }));
  assert.match(h.root.textContent, /Current attendance check completed/); assert.match(h.root.textContent, /Current reminder date: 2026-09-27/);
  assert.match(h.root.textContent, /Past reminder history: 2 earlier reminders still have an unknown send result/);
  assert.match(h.root.textContent, /a newer check does not mean those emails were delivered/);
  assert.doesNotMatch(h.root.textContent, /Current status:.*unconfirmed/);
  const refresh = h.ui.refresh(); await flush(); h.calls[1].reject(new Error('Offline')); await refresh;
  assert.match(h.root.textContent, /Current attendance check status unavailable/); assert.match(h.root.textContent, /Past reminder history is currently unavailable/);
  assert.doesNotMatch(h.root.textContent, /Current attendance check completed/);
});

test('historical uncertainty never hides active delivery or configuration failures, and malformed history cannot show current success', async () => {
  const health = { ok: true, target: 'test', state: 'clear', codes: [], checkedAt: new Date(100000).toISOString(), expiresAt: new Date(1900000).toISOString(),
    pendingCount: 0, failedCount: 0, unconfirmedCount: 0, historicalUnconfirmedCount: 1, historicalFailedCount: 0, opportunityDate: '2026-09-27' };
  for (const change of [{ state: 'delivery-failed', codes: ['DELIVERY_FAILED'], failedCount: 1 },
    { state: 'delivery-unconfirmed', codes: ['DELIVERY_UNCONFIRMED'], unconfirmedCount: 1 },
    { state: 'not-configured', codes: ['CONFIGURATION_REQUIRED'] }, { state: 'check-incomplete', codes: ['CHECK_INCOMPLETE'] }]) {
    const h = harness(); await h.open(response(null, { current: { health: { ...health, ...change } } }));
    assert.match(h.root.textContent, /Current status:/); assert.match(h.root.textContent, /Past reminder history: 1 earlier reminder still has an unknown send result/);
    assert.doesNotMatch(h.root.textContent, /Current attendance check completed/);
  }
  for (const change of [{ historicalUnconfirmedCount: -1 }, { historicalUnconfirmedCount: '1' }, { historicalUnconfirmedCount: undefined },
    { historicalFailedCount: -1 }, { historicalFailedCount: '1' }, { historicalFailedCount: undefined },
    { opportunityDate: '2026-02-31' }, { opportunityDate: undefined }]) {
    const h = harness(); await h.open(response(null, { current: { health: { ...health, ...change } } }));
    assert.match(h.root.textContent, /Current attendance check status unavailable/); assert.match(h.root.textContent, /Past reminder history is currently unavailable/);
    assert.doesNotMatch(h.root.textContent, /Current attendance check completed/);
  }
});

test('older email failures are retained as history without becoming current failures after a clean check', async () => {
  const health = { ok: true, target: 'test', state: 'clear', codes: [], checkedAt: new Date(100000).toISOString(), expiresAt: new Date(1900000).toISOString(),
    pendingCount: 0, failedCount: 0, unconfirmedCount: 0, historicalUnconfirmedCount: 0, historicalFailedCount: 2, opportunityDate: '2026-09-27' };
  const h = harness(); await h.open(response(null, { current: { health } }));
  assert.match(h.root.textContent, /Current attendance check completed/);
  assert.match(h.root.textContent, /Past reminder history: 2 earlier reminders have a recorded email failure/);
  assert.match(h.root.textContent, /This failure history is retained/); assert.doesNotMatch(h.root.textContent, /Current status:/);
  const active = harness(); await active.open(response(null, { current: { health: { ...health, state: 'delivery-failed', codes: ['DELIVERY_FAILED'], failedCount: 1 } } }));
  assert.match(active.root.textContent, /Current status:/); assert.match(active.root.textContent, /2 earlier reminders have a recorded email failure/);
  assert.doesNotMatch(active.root.textContent, /Current attendance check completed/);
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
  assert.deepEqual(JSON.parse(first.calls[1].journalAtDispatch), { requestId: ID, adminName: 'Andrew Smith', action: 'runExamples' });
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
  h.click('retry'); await flush(); assert.deepEqual(h.calls[2].args[1], h.calls[1].args[1]);
  h.calls[2].resolve(response(fixture())); await flush(); assert.equal(h.storage.size, 0);
});

test('focused history checks retain their action before dispatch and prevent either new run from replacing a pending request', async () => {
  const h = harness(); await h.open(); assert.equal(h.find('history').textContent, 'Run synthetic history checks');
  h.click('history'); h.click('history'); h.click('run'); await flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(JSON.parse(h.calls[1].journalAtDispatch), { requestId: ID, adminName: 'Andrew Smith', action: 'runHistory' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].args[1])), { action: 'runHistory', requestId: ID });
  h.calls[1].resolve(response(null, { request: { runId: ID, action: 'runHistory', state: 'pending' } })); await flush();
  assert.equal(h.find('run').disabled, true); assert.equal(h.find('history').disabled, true); assert.equal(h.find('retry').disabled, false);
  h.click('run'); h.click('history'); await flush(); assert.equal(h.calls.length, 2);
  h.click('retry'); h.click('retry'); await flush(); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[2].args[1], h.calls[1].args[1]);
  const result = fixture(); result.scenarios[0].key = 'retained-history'; result.scenarios[0].title = 'More than 256 retained history entries';
  h.calls[2].resolve(response(result)); await flush();
  assert.equal(h.storage.size, 0); assert.match(h.root.textContent, /More than 256 retained history entries/);
  assert.equal(h.find('run').disabled, false); assert.equal(h.find('history').disabled, false);
});

test('lost history reply reloads the original run and retries its original action; saved history also reopens without a journal', async () => {
  const storage = new Map(), first = harness({ storage }); await first.open(); first.click('history'); await flush();
  first.calls[1].reject(new Error('Lost reply')); await flush(); first.ui.clear();
  const reopened = harness({ storage }); await reopened.open();
  assert.equal(reopened.calls[0].args[0], '/api/m1-attendance-workflow?runId=' + ID);
  assert.equal(JSON.parse(storage.get(KEY)).action, 'runHistory');
  reopened.click('retry'); await flush(); assert.equal(reopened.calls[1].args[1].action, 'runHistory');
  assert.equal(reopened.calls[1].args[1].requestId, ID);
  const result = fixture(); result.scenarios[0].key = 'retained-history'; result.scenarios[0].title = 'Retained history checks';
  reopened.calls[1].resolve(response(result)); await flush(); reopened.ui.clear();
  const latest = harness({ storage }); await latest.open(response(result));
  assert.equal(latest.calls[0].args[0], '/api/m1-attendance-workflow');
  assert.equal(latest.calls[0].args[2].method, 'GET'); assert.match(latest.root.textContent, /Retained history checks/);
  assert.equal(storage.size, 0); assert.equal(latest.calls.length, 1);
});

test('legacy pending journals retry the original workflow suite without migration or replacing it with history checks', async () => {
  const raw = JSON.stringify({ requestId: ID, adminName: 'Andrew Smith' }), storage = new Map([[KEY, raw]]), h = harness({ storage });
  await h.open(); assert.equal(storage.get(KEY), raw); h.click('history'); h.click('daily'); h.click('run'); await flush(); assert.equal(h.calls.length, 1);
  h.click('retry'); await flush(); assert.equal(h.calls[1].args[1].action, 'runExamples'); assert.equal(h.calls[1].args[1].requestId, ID);
  assert.equal(h.calls[1].journalAtDispatch, raw);
  h.calls[1].resolve(response(null, { request: { runId: ID, action: 'runExamples', state: 'pending' } })); await flush();
  assert.equal(storage.get(KEY), raw); assert.match(h.root.textContent, /still waiting for confirmation/);
});

test('daily reminder checks retain the original action and ID through lost confirmation, reload and explicit retry', async () => {
  const storage = new Map(), first = harness({ storage }); await first.open();
  assert.equal(first.find('daily').textContent, 'Run synthetic daily reminder checks');
  first.click('daily'); first.click('daily'); first.click('history'); first.click('run'); await flush();
  assert.equal(first.calls.length, 2);
  assert.deepEqual(JSON.parse(first.calls[1].journalAtDispatch), { requestId: ID, adminName: 'Andrew Smith', action: 'runDaily' });
  assert.deepEqual(JSON.parse(JSON.stringify(first.calls[1].args[1])), { action: 'runDaily', requestId: ID });
  first.calls[1].reject(new Error('Lost response')); await flush(); first.ui.clear();
  const reopened = harness({ storage }); await reopened.open(response(null, { request: { runId: ID, action: 'runDaily', state: 'pending' } }));
  assert.equal(reopened.calls[0].args[0], '/api/m1-attendance-workflow?runId=' + ID);
  for (const action of ['run', 'history', 'daily']) { assert.equal(reopened.find(action).disabled, true); reopened.click(action); }
  await flush(); assert.equal(reopened.calls.length, 1);
  reopened.click('retry'); reopened.click('retry'); await flush(); assert.equal(reopened.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.calls[1].args[1])), { action: 'runDaily', requestId: ID });
  const result = fixture(); result.scenarios[0].key = 'daily-next-day'; result.scenarios[0].title = 'Next eligible day';
  reopened.calls[1].resolve(response(result)); await flush(); assert.equal(storage.size, 0);
  assert.match(reopened.root.textContent, /Next eligible day/); assert.equal(reopened.find('daily').disabled, false);
  reopened.ui.clear(); const latest = harness({ storage }); await latest.open(response(result));
  assert.equal(latest.calls[0].args[2].method, 'GET'); assert.match(latest.root.textContent, /Next eligible day/);
  assert.equal(latest.calls.length, 1);
});

test('daily requests retain reviewer and session protections and cannot replace pending historical runs', async () => {
  for (const action of ['runHistory', 'runDaily']) {
    const raw = JSON.stringify({ requestId: ID, adminName: 'Stuart Turner', action }), h = harness({ storage: new Map([[KEY, raw]]) });
    await h.open(); for (const control of ['run', 'history', 'daily', 'retry']) { assert.equal(h.find(control).disabled, true); h.click(control); }
    await flush(); assert.equal(h.calls.length, 1); assert.equal(h.storage.get(KEY), raw);
  }
  const changed = harness(); await changed.open(); changed.setSession('session-two'); changed.click('daily'); await flush();
  assert.equal(changed.calls.length, 1); assert.equal(changed.storage.size, 0);
  const pending = harness({ storage: new Map([[KEY, JSON.stringify({ requestId: ID, adminName: 'Andrew Smith', action: 'runHistory' })]]) });
  await pending.open(); pending.click('daily'); await flush(); assert.equal(pending.calls.length, 1);
  pending.click('retry'); await flush(); assert.equal(pending.calls[1].args[1].action, 'runHistory');
  pending.calls[1].resolve(response(fixture())); await flush();
});

test('pending action mismatches and invalid retained actions never clear the original run or dispatch a replacement', async () => {
  const h = harness(); await h.open(); h.click('history'); await flush();
  h.calls[1].resolve(response(null, { request: { runId: ID, action: 'runExamples', state: 'pending' } })); await flush();
  assert.match(h.root.textContent, /not confirmed/); assert.equal(JSON.parse(h.storage.get(KEY)).action, 'runHistory');
  h.click('run'); h.click('history'); await flush(); assert.equal(h.calls.length, 2);
  h.click('retry'); await flush(); assert.equal(h.calls[2].args[1].action, 'runHistory');
  h.calls[2].resolve(response(fixture())); await flush(); assert.equal(h.storage.size, 0);
  const invalid = JSON.stringify({ requestId: ID, adminName: 'Andrew Smith', action: 'sendEmail' });
  const bad = harness({ storage: new Map([[KEY, invalid]]) }); await bad.open();
  bad.click('run'); bad.click('history'); bad.click('retry'); await flush();
  assert.equal(bad.calls.length, 1); assert.equal(bad.storage.get(KEY), invalid); assert.match(bad.root.textContent, /retained safely/);
});

test('another reviewer, expired session, logout and late requests cannot show stale completion', async () => {
  const storage = new Map([[KEY, JSON.stringify({ requestId: ID, adminName: 'Stuart Turner' })]]), h = harness({ storage });
  await h.open(); assert.equal(h.find('run').disabled, true); assert.equal(h.find('history').disabled, true); assert.equal(h.find('retry').disabled, true);
  h.click('run'); h.click('history'); h.click('retry'); assert.equal(h.calls.length, 1); assert.equal(storage.size, 1);
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
