import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../m1/admin/attendance-digest.js', import.meta.url), 'utf8');
const adminCss = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const sharedMessageDisplay = /\bdisplay:\s*([^;]+);/.exec(/\.message\s*\{([^}]*)\}/.exec(adminCss)[1])[1].trim();
function visibleStatus(h) {
  const status = h.nodes.findLast(node => node.attributes.role === 'status' && h.root.contains(node));
  assert.ok(status, 'the rendered digest must have a live status node');
  assert.equal(status.style.display || sharedMessageDisplay, 'block', 'status must override the real Admin .message display:none rule');
  return status;
}
const ID = '00000000-0000-4000-8000-000000000001';
const KEY = 'm1-attendance-digest-test-rev-pending-v1';
const REHEARSAL_KEY = 'm1-attendance-digest-test-rev-rehearsal-v1';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const preview = (state = 'captured', overrides = {}) => ({ messageId: 'digest-one', date: '2026-09-25', state,
  subject: 'Attendance needs attention', html: '<html><script>unsafe()</script><body>Test</body></html>',
  text: '<b>Plain text only</b>', groups: [{ gym: 'rev', name: 'Revolution BJJ', items: [{ summary: '<img src=x onerror=unsafe()> Missing instructor' }] }],
  readFailures: [], ...overrides });
const response = (latest = null, request = null, overrides = {}) => ({ ok: true, target: 'test', sendingEnabled: false,
  configuration: { dailyLocalTime: '22:00', cutoffConfirmed: false, timezone: 'America/New_York',
    recipients: [{ key: 'andrew', name: 'Andrew', address: null }, { key: 'stu', name: 'Stu', address: null }], gyms: [{ id: 'rev', name: 'Revolution BJJ' }] }, latest, request, ...overrides });
const pendingStatus = () => ({ requestId: ID, state: 'pending', expiresAt: 160000, messageId: null });
const capturedStatus = () => ({ requestId: ID, state: 'captured', expiresAt: 160000, messageId: 'digest-one' });

function harness(options = {}) {
  const calls = [], nodes = [], clicked = [], blobs = [], revoked = [], timers = new Map(), historyChanges = [];
  const location = options.location || (options.href ? { href: options.href } : undefined);
  let now = 100000, timerId = 0, unauthorized = 0, uuidCalls = 0, admin = 'Andrew';
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.attributes = {}; this.ownText = ''; }
    set innerHTML(_) { throw new Error('Response HTML must never enter the DOM'); }
    set textContent(text) { this.ownText = String(text); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(' '); }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.ownText = ''; this.children = []; this.append(...children); }
    addEventListener(name, handler) { this.events[name] = handler; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    closest() { return this.dataset.digestAction ? this : this.parent?.closest(); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    click() { clicked.push(this); }
  }
  const document = { createElement: tag => { const node = new Element(tag); nodes.push(node); return node; } };
  const root = new Element('section'); root.ownerDocument = document;
  const storage = options.storage || new Map();
  const context = vm.createContext({ document, Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => { uuidCalls++; return ID; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (options.brokenStorage) throw new Error('blocked'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), Blob: class { constructor(parts, options) { blobs.push({ parts, options }); } },
    URL: Object.assign(class extends URL {}, { createObjectURL: () => 'blob:preview', revokeObjectURL: url => revoked.push(url) }),
    location, M1_INSTALLATION_PROFILE: options.profile, M1_MANAGER_REVIEW_CONFIG: options.config,
    history: { state: { retained: true }, replaceState: (state, title, href) => { historyChanges.push({ state, title, href }); location.href = href; } }
  });
  vm.runInContext(source, context);
  const ui = context.GIBM1AttendanceDigest.create({ root, enabled: true, target: 'test', site: 'Rev',
    request: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
    getAdmin: () => admin, onUnauthorized: () => unauthorized++, ...options.create });
  const all = () => { const found = []; const visit = node => { found.push(node); node.children.forEach(visit); }; visit(root); return found; };
  const control = action => all().find(node => node.dataset.digestAction === action);
  return { ui, calls, root, nodes, storage, clicked, blobs, revoked, timers, control, element: id => all().find(node => node.id === id),
    unauthorized: () => unauthorized, uuidCalls: () => uuidCalls, location, historyChanges, logout: () => { admin = ''; }, setAdmin: value => { admin = value; },
    click: action => { const target = control(action); if (target) root.events.click({ target }); },
    tick: async ms => {
      const end = now + ms;
      for (;;) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
      }
      now = end; await flush();
    }
  };
}
async function open(h, value = response()) { const opening = h.ui.open(); h.calls.at(-1).resolve(value); await opening; }

test('digest panel requires explicit TEST Revolution gate and authentication', async () => {
  for (const create of [{ enabled: false }, { enabled: 'true' }, { target: 'production' }, { site: 'Richmond' }]) {
    const h = harness({ create }); assert.equal(h.ui, null); assert.equal(h.calls.length, 0);
  }
  const h = harness(); h.logout(); await h.ui.open();
  assert.equal(h.calls.length, 0); assert.equal(h.root.hidden, true);
});

test('rendered digest loading and failure status override the actual Admin CSS hidden default', async () => {
  assert.equal(sharedMessageDisplay, 'none', 'exercise the real shared CSS that caused the hosted defect');
  const h = harness(); const opening = h.ui.open();
  assert.match(visibleStatus(h).textContent, /Checking capture status/);
  h.calls[0].reject(new Error('offline')); await opening;
  assert.match(visibleStatus(h).textContent, /Capture status unavailable/);
});

test('open only reads configuration, shows unconfigured addresses, and isolates HTML from the Admin document', async () => {
  const h = harness(); await open(h, response(preview()));
  assert.equal(h.calls[0].args[0], '/api/m1-attendance-digest');
  assert.equal(h.calls[0].args[1], undefined); assert.equal(h.calls[0].args[2].method, 'GET');
  assert.match(h.root.textContent, /Capture only\. No email will be sent/);
  assert.match(h.root.textContent, /22:00 America\/New_York \(not confirmed\)/);
  assert.match(h.root.textContent, /Andrew: address not configured; Stu: address not configured/);
  assert.match(h.root.textContent, /<img src=x onerror=unsafe\(\)> Missing instructor/);
  assert.equal(h.nodes.some(node => node.tag === 'script'), false);
  const frame = h.nodes.find(node => node.tag === 'iframe');
  assert.equal(frame.attributes.sandbox, '');
  assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
  assert.equal(Object.keys(frame.attributes).some(key => key.startsWith('allow')), false);
  assert.match(frame.attributes.csp, /default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  assert.match(frame.attributes.csp, /base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'/);
  assert.match(frame.srcdoc, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
  assert.match(frame.srcdoc, /<body inert>/);
  assert.equal(frame.srcdoc.includes(preview().html), true, 'the captured email markup is retained inside the isolated frame');
  assert.equal(frame.src, undefined);
  h.click('html'); assert.equal(h.blobs.length, 1);
  assert.equal(h.blobs[0].parts[0], preview().html);
  assert.equal(h.clicked[0].href, 'blob:preview'); assert.equal(h.clicked[0].download, 'attendance-digest-test-2026-09-25.html');
  h.click('text'); assert.equal(h.blobs[1].parts[0], preview().text);
  h.ui.clear(); assert.equal(h.root.textContent, ''); assert.equal(h.revoked.includes('blob:preview'), true);
});

test('historical per-gym routing remains readable without inventing a hidden copy', async () => {
  const value = response(); value.configuration.routing = { rev: { reviewer: { key: 'stu', name: 'Stu', address: null }, cc: [] },
    richmond: { reviewer: { key: 'trey', name: 'Trey', address: null }, cc: [] } };
  value.configuration.recipients = [value.configuration.routing.rev.reviewer];
  const h = harness(); await open(h, value);
  assert.match(h.root.textContent, /Revolution: Stu — address not configured\. CC: none\. Hidden BCC copy: off/);
  assert.match(h.root.textContent, /Richmond \(setup only\): Trey — address not configured\. CC: none\. Hidden BCC copy: off/);
  assert.match(h.root.textContent, /grants no access and enables no delivery/); assert.equal(h.calls.length, 1);
  assert.doesNotMatch(h.root.textContent, /Recipients: Andrew/);
  value.configuration.routing.rev.cc = [{ key: 'andrew', name: 'Andrew', address: 'andrew@example.invalid' }];
  const copied = harness(); await open(copied, value); assert.match(copied.root.textContent, /CC: andrew@example.invalid\. Hidden BCC copy: off/);
});

test('malformed new routing never becomes confirmed configuration while legacy captures remain compatible', async () => {
  const value = response(); value.configuration.routing = { rev: { reviewer: { key: 'stu', name: 'Stu', address: null }, cc: [] } };
  const h = harness(); await open(h, value); assert.match(h.root.textContent, /Capture status unavailable/);
  assert.doesNotMatch(h.root.textContent, /Daily cutoff:/); assert.equal(h.control('capture').disabled, true);
});

test('capture journals its exact ID before the one POST and polls only that original request', async () => {
  const h = harness(); await open(h);
  h.click('capture'); h.click('capture'); h.click('refresh');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(JSON.parse(h.storage.get(KEY)), { requestId: ID, startedAt: 100000 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].args[1])), { action: 'capture', requestId: ID });
  assert.equal(h.calls[1].args[2].method, 'POST');
  h.calls[1].resolve({ ok: true, request: pendingStatus() }); await flush();
  assert.equal(h.calls[2].args[0], `/api/m1-attendance-digest?requestId=${ID}`);
  h.calls[2].resolve(response(null, pendingStatus())); await flush(); await h.tick(3000);
  h.calls[3].resolve(response(preview(), capturedStatus())); await flush();
  assert.equal(h.calls.filter(call => call.args[1]).length, 1);
  assert.equal(h.storage.has(KEY), false);
  assert.match(h.root.textContent, /Preview captured\. No email was sent/);
  assert.equal(h.control('capture').disabled, false);
});

test('lost reply survives reload without automatically resending or replacing its identity', async () => {
  const first = harness(); await open(first); first.click('capture');
  first.calls[1].reject(new Error('reply lost')); await flush();
  first.calls[2].reject(new Error('offline')); await flush();
  assert.match(first.root.textContent, /original capture is not confirmed/);
  assert.equal(first.control('capture').disabled, true); first.ui.clear();
  const h = harness({ storage: first.storage }); const opening = h.ui.open();
  assert.equal(h.calls[0].args[0], `/api/m1-attendance-digest?requestId=${ID}`);
  assert.equal(h.calls[0].args[1], undefined);
  h.calls[0].resolve(response(preview(), capturedStatus())); await opening;
  assert.equal(h.calls.length, 1); assert.equal(h.storage.has(KEY), false);
});

test('foreign target, enabled sending and unrelated final captures cannot release pending identity', async () => {
  for (const value of [response(preview(), capturedStatus(), { target: 'production' }),
    response(preview(), capturedStatus(), { sendingEnabled: true }),
    response(preview(), { ...capturedStatus(), requestId: 'another-request' }),
    response(preview(), { ...capturedStatus(), messageId: 'another-preview' }),
    response(preview('failed'), capturedStatus())]) {
    const h = harness({ storage: new Map([[KEY, JSON.stringify({ requestId: ID, startedAt: 90000 })]]) });
    await open(h, value);
    assert.equal(h.storage.has(KEY), true); assert.equal(h.control('capture').disabled, true);
    assert.match(h.root.textContent, /not confirmed/); assert.equal(h.calls.length, 1);
  }
});

test('pending check is bounded and a later manual check remains read-only', async () => {
  const h = harness({ storage: new Map([[KEY, JSON.stringify({ requestId: ID, startedAt: 90000 })]]) });
  const opening = h.ui.open();
  for (let i = 0; i < 12; i++) {
    assert.equal(h.calls.length, i + 1); h.calls[i].resolve(response(null, pendingStatus())); await flush();
    if (i < 11) await h.tick(3000);
  }
  await opening;
  assert.equal(h.calls.length, 12); assert.equal(h.timers.size, 0);
  assert.match(h.root.textContent, /Automatic checking has stopped/);
  assert.match(visibleStatus(h).textContent, /Automatic checking has stopped/);
  assert.equal(h.control('capture').disabled, true);
  h.click('refresh'); assert.equal(h.calls.length, 13); assert.equal(h.calls[12].args[1], undefined);
  h.calls[12].reject(new Error('offline')); await flush();
  assert.match(visibleStatus(h).textContent, /not.*confirmed|unavailable/i);
  assert.equal(h.storage.has(KEY), true);
});

test('a stalled read times out, late replies cannot produce a success, and logout clears private previews', async () => {
  const h = harness(); const opening = h.ui.open(); await h.tick(12000); await opening;
  assert.match(h.root.textContent, /Capture status unavailable/);
  h.calls[0].resolve(response(preview())); await flush(); assert.doesNotMatch(h.root.textContent, /Latest preview/);
  const reopened = h.ui.open(); h.calls[1].resolve(response(preview())); await reopened;
  h.click('capture'); h.ui.clear();
  h.calls[2].resolve(response(preview(), capturedStatus())); await flush();
  assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, ''); assert.equal(h.storage.has(KEY), true);
  const checked = h.ui.open(); h.calls[3].reject(Object.assign(new Error('Auth required'), { status: 401 })); await checked;
  assert.equal(h.unauthorized(), 1); assert.equal(h.root.textContent, ''); assert.equal(h.storage.has(KEY), true);
});

test('failed reads and previews never report an all-clear or invent recipient addresses', async () => {
  const h = harness(); await open(h, response(preview('failed', { groups: [], readFailures: [{ gym: 'rev', component: 'attendance', message: 'Attendance read unavailable.' }] })));
  assert.match(h.root.textContent, /Some records could not be checked/);
  assert.match(h.root.textContent, /Attendance read unavailable/);
  assert.doesNotMatch(h.root.textContent, /no unresolved items|@|everything is resolved\.$/);
  h.click('refresh'); h.calls[1].reject(new Error('offline')); await flush();
  assert.match(h.root.textContent, /Current records could not be checked/);
  assert.equal(h.control('html').disabled, true);
});

test('unavailable journal prevents capture dispatch and corrupt pending data cannot become a new request', async () => {
  const h = harness({ brokenStorage: true }); await open(h); h.click('capture'); await flush();
  assert.equal(h.calls.length, 1); assert.match(h.root.textContent, /No capture was sent/);
  assert.equal(h.control('capture').disabled, true);
  const bad = harness({ storage: new Map([[KEY, '{broken']]) }); await open(bad);
  bad.click('capture'); assert.equal(bad.calls.length, 1);
  assert.match(bad.root.textContent, /previous capture or rehearsal could not be verified/);
});

function chooseTime(h, time, confirmed = true) {
  const input = h.element('attendanceDigestTime'); input.value = time; input.events.input();
  const checkbox = h.element('attendanceDigestConfirm'); checkbox.checked = confirmed; checkbox.events.change();
}
const configured = (time, overrides = {}) => ({ ok: true, target: 'test', sendingEnabled: false,
  configuration: { ...response().configuration, dailyLocalTime: time, cutoffConfirmed: true }, ...overrides });

test('time configuration requires a new explicit checked confirmation and posts only the exact supported body', async () => {
  const h = harness(); await open(h);
  assert.equal(h.element('attendanceDigestTime').value, '22:00');
  assert.equal(h.element('attendanceDigestConfirm').checked, false);
  assert.equal(h.control('configure').disabled, true);
  h.click('configure'); chooseTime(h, '22:30', false); h.click('configure');
  assert.equal(h.calls.length, 1, 'opening and editing the proposal cannot confirm or save it');
  chooseTime(h, '25:00'); h.click('configure'); assert.equal(h.calls.length, 1);
  chooseTime(h, '22:30'); assert.equal(h.control('configure').disabled, false);
  h.click('configure'); h.click('configure');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args[0], '/api/m1-attendance-digest');
  assert.equal(h.calls[1].args[2].method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].args[1])), { action: 'configure', dailyLocalTime: '22:30' });
  h.calls[1].resolve(configured('22:30')); await flush();
  assert.match(h.root.textContent, /Daily time saved: 22:30 America\/New_York\. Sending remains off\. No email was sent/);
  assert.equal(h.element('attendanceDigestConfirm').checked, false);
  assert.equal(h.control('configure').disabled, true);
  assert.equal(h.storage.has(KEY), false, 'configuration never starts or journals an attendance capture');
});

test('time edits, refresh and failed or foreign configuration reads clear the confirmation', async () => {
  for (const wrong of [configured('22:30', { target: 'production' }), configured('22:30', { sendingEnabled: true }),
    configured('22:30', { configuration: { ...response().configuration, dailyLocalTime: '22:30', cutoffConfirmed: false } }),
    configured('23:00')]) {
    const h = harness(); await open(h); chooseTime(h, '22:30');
    const time = h.element('attendanceDigestTime'); time.value = '23:00'; time.events.input();
    assert.equal(h.element('attendanceDigestConfirm').checked, false); assert.equal(h.control('configure').disabled, true);
    chooseTime(h, '22:30'); h.click('configure'); h.calls[1].resolve(wrong); await flush();
    assert.match(h.root.textContent, /time save is not confirmed/);
    assert.equal(h.element('attendanceDigestConfirm').checked, false); assert.equal(h.control('configure').disabled, true);
    assert.equal(h.calls.length, 2, 'no automatic configure retry follows an uncertain receipt');
    h.click('refresh');
    h.calls[2].resolve(response(null, null, { configuration: configured('22:30').configuration })); await flush();
    assert.equal(h.element('attendanceDigestTime').value, '22:30');
    assert.equal(h.element('attendanceDigestConfirm').checked, false); assert.equal(h.control('configure').disabled, true);
    chooseTime(h, '23:00'); h.click('refresh'); assert.equal(h.element('attendanceDigestConfirm').checked, false);
    h.calls[3].reject(new Error('offline')); await flush();
    assert.equal(h.element('attendanceDigestConfirm').checked, false); assert.equal(h.control('configure').disabled, true);
  }
});

test('lost or stale configuration replies never restore checkbox confirmation or repeat the write', async () => {
  const h = harness(); await open(h); chooseTime(h, '22:30'); h.click('configure');
  await h.tick(12000);
  assert.match(h.root.textContent, /time save is not confirmed/); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(configured('22:30')); await flush();
  assert.doesNotMatch(h.root.textContent, /Daily time saved/);
  assert.equal(h.element('attendanceDigestConfirm').checked, false);
  h.click('refresh'); h.calls[2].resolve(response(null, null, { configuration: configured('22:30').configuration })); await flush();
  chooseTime(h, '23:00'); h.click('configure'); h.ui.clear();
  const reopened = h.ui.open(); h.calls[4].resolve(response()); await reopened;
  h.calls[3].resolve(configured('23:00')); await flush();
  assert.equal(h.element('attendanceDigestTime').value, '22:00');
  assert.equal(h.element('attendanceDigestConfirm').checked, false);
  assert.doesNotMatch(h.root.textContent, /Daily time saved/);
  assert.deepEqual(h.calls.filter(call => call.args[1]).map(call => call.args[1].action), ['configure', 'configure']);
});

test('confirmation is never restored from saved cutoff state or sent while a capture needs confirmation', async () => {
  const h = harness(); await open(h, response(null, null, { configuration: configured('22:30').configuration }));
  assert.equal(h.element('attendanceDigestConfirm').checked, false); assert.equal(h.control('configure').disabled, true);
  chooseTime(h, '23:00'); h.click('capture');
  assert.equal(h.element('attendanceDigestConfirm').checked, false); assert.equal(h.control('configure').disabled, true);
  h.calls[1].reject(new Error('lost')); await flush(); h.calls[2].reject(new Error('offline')); await flush();
  h.control('configure').disabled = false; h.click('configure');
  assert.equal(h.calls.length, 3, 'the operation guard also rejects configuration while the original capture is unresolved');
});

const lease = (overrides = {}) => ({ rehearsalId: ID, createdAt: 100000, cutoffAt: 240000, expiresAt: 1900000,
  jobDate: '2026-09-25', state: 'armed', synthetic: true, ...overrides });
const armed = (overrides = {}) => ({ ok: true, target: 'test', sendingEnabled: false, rehearsal: lease(), ...overrides });
const syntheticPreview = (overrides = {}) => preview('captured', { messageId: `m1-test-rehearsal-${ID}-2026-09-25`, subject: 'SYNTHETIC REHEARSAL · TEST attendance attention', ...overrides });
const rehearsalResponse = (latest = null, overrides = {}) => response(latest, null, { rehearsal: lease(), ...overrides });
const proposedMessages = () => ['rev', 'richmond'].map((gym, index) => ({
  messageId: `m1-test-scheduled-${gym}-2026-09-25`, hash: (index ? 'b' : 'a').repeat(64), gym,
  name: index ? 'Richmond BJJ' : 'Revolution BJJ', from: 'revbjjops@gmail.com',
  to: [index ? 'info@richmondbjj.com' : 'info@revolutionbjj.com'], cc: [], bcc: ['andrew@revolutionbjj.com'],
  subject: `SYNTHETIC ${gym} TEST reminder`, html: `<p>${gym} isolated example</p>`, text: `${gym} isolated example`,
  adminUrl: index ? 'https://gib-richmond-test.netlify.app/m1/admin/' : 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/',
  state: 'captured', synthetic: true
}));
const gymLink = gym => `https://deploy-preview-89--gib-live.netlify.app/m1/admin/?digestRehearsal=${ID}&digestGym=${gym}#attendanceDigest`;

test('temporary TEST timer setup exposes only the exact seven public armed-lease fields in collapsed read-only text', async () => {
  const h = harness({ href: gymLink('rev') });
  const original = lease({ reviewer: 'private reviewer', session: 'private session', token: 'private token' });
  await open(h, rehearsalResponse(null, { rehearsal: original, proposedMessages: [] }));
  const details = h.nodes.find(node => h.root.contains(node) && node.tag === 'details'
    && node.children[0]?.textContent === 'Temporary TEST timer setup');
  assert.ok(details); assert.equal(details.open, false);
  const pre = details.children.find(node => node.tag === 'pre');
  assert.equal(pre.contentEditable, 'false');
  const expected = lease();
  assert.deepEqual(JSON.parse(pre.textContent), expected);
  assert.deepEqual(Object.keys(JSON.parse(pre.textContent)).sort(), ['createdAt', 'cutoffAt', 'expiresAt', 'jobDate', 'rehearsalId', 'state', 'synthetic']);
  assert.doesNotMatch(pre.textContent, /private|startedAt/);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args[2].method, 'GET');
  assert.deepEqual([...h.storage.keys()], [REHEARSAL_KEY]);
});

test('timer setup stays hidden for missing, invalid, expired, refreshing or unconfirmed leases', async () => {
  const setupVisible = h => h.nodes.some(node => h.root.contains(node) && node.tag === 'details'
    && node.children[0]?.textContent === 'Temporary TEST timer setup');
  for (const original of [null, lease({ state: 'expired' }), lease({ state: 'unrecognized' }), lease({ synthetic: false }),
    lease({ expiresAt: 1900001 }), lease({ rehearsalId: 'wrong' })]) {
    const h = harness({ href: gymLink('rev') });
    await open(h, rehearsalResponse(null, { rehearsal: original, proposedMessages: [] }));
    assert.equal(setupVisible(h), false);
  }
  const h = harness({ href: gymLink('rev') });
  await open(h, rehearsalResponse(null, { proposedMessages: [] }));
  assert.equal(setupVisible(h), true);
  h.click('refresh'); assert.equal(setupVisible(h), false);
  h.calls[1].reject(new Error('offline')); await flush(); assert.equal(setupVisible(h), false);
  h.click('refresh'); h.calls[2].resolve(rehearsalResponse(null, { proposedMessages: [] })); await flush();
  await h.tick(1800000); h.click('refresh'); h.calls[3].resolve(rehearsalResponse(null, { proposedMessages: [] })); await flush();
  assert.equal(setupVisible(h), false, 'an expired timestamp cannot become usable merely because a response still says armed');
});

test('confirmed reminder configuration exposes hidden-copy settings without treating20:00 as class closing', async () => {
  const value = response(preview());
  Object.assign(value.configuration, { senderAddress: 'revbjjops@gmail.com', dailyLocalTime: '20:00', cutoffConfirmed: true, classFinishCutoffConfirmed: false,
    routing: { rev: { reviewer: { key: 'stu', name: 'Stu', address: 'info@revolutionbjj.com' }, cc: [], bcc: [{ key: 'andrew', name: 'Andrew', address: 'andrew@revolutionbjj.com' }] },
      richmond: { reviewer: { key: 'trey', name: 'Trey', address: 'info@richmondbjj.com' }, cc: [], bcc: [] } } });
  const h = harness(); await open(h, value);
  assert.match(h.root.textContent, /Daily reminder: 20:00 America\/New_York \(confirmed\)/);
  assert.match(h.root.textContent, /follows daylight saving time/);
  assert.match(h.root.textContent, /Class finishing times are not confirmed/);
  assert.match(h.root.textContent, /Confirm this daily reminder time/);
  assert.match(h.root.textContent, /Revolution: Stu — info@revolutionbjj.com\. CC: none\. Hidden BCC copy: andrew@revolutionbjj.com/);
  assert.match(h.root.textContent, /Richmond \(setup only\): Trey — info@richmondbjj.com\. CC: none\. Hidden BCC copy: off/);
  assert.doesNotMatch(h.root.textContent, /after the final class/);
  assert.equal(h.nodes.find(node => node.tag === 'iframe').srcdoc.includes(preview().html), true, 'saved legacy body remains unchanged');
});

test('two private per-gym proposals keep BCC outside each email and direct links select only the requested gym using one GET', async () => {
  for (const gym of ['rev', 'richmond']) {
    const h = harness({ href: gymLink(gym) }), messages = proposedMessages();
    await open(h, rehearsalResponse(syntheticPreview(), { proposedMessages: messages }));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args[0], `/api/m1-attendance-digest?rehearsalId=${ID}`);
    assert.equal(h.calls[0].args[2].method, 'GET');
    const frames = h.nodes.filter(node => node.tag === 'iframe' && h.root.contains(node));
    assert.equal(frames.length, 1); assert.ok(frames[0].srcdoc.includes(`${gym} isolated example`));
    assert.doesNotMatch(frames[0].srcdoc, /andrew@revolutionbjj.com/); assert.equal(frames[0].attributes.sandbox, '');
    assert.match(frames[0].srcdoc, /<body inert>/); assert.match(frames[0].attributes.csp, /script-src 'none'/);
    const shown = messages.find(message => message.gym === gym);
    const lines = h.nodes.filter(node => h.root.contains(node) && node.tag === 'p').map(node => node.textContent);
    assert.ok(lines.includes('To: ' + shown.to[0])); assert.ok(lines.includes('CC: none'));
    assert.ok(lines.some(line => line.startsWith('Private delivery configuration: hidden BCC copy')));
    assert.deepEqual(h.nodes.filter(node => h.root.contains(node) && node.tag === 'a').map(node => node.href), [shown.adminUrl]);
    assert.equal(h.control('html'), undefined, 'selected proposal cannot download the other historical combined email');
    assert.equal(JSON.parse(h.storage.get(REHEARSAL_KEY)).rehearsalId, ID);
  }
  const h = harness({ href: gymLink('rev').replace('&digestGym=rev', '') });
  await open(h, rehearsalResponse(null, { proposedMessages: proposedMessages() }));
  assert.equal(h.nodes.filter(node => node.tag === 'iframe' && h.root.contains(node)).length, 2);
});

test('partial, malformed, stale and foreign proposal evidence never enables a current correction link', async () => {
  const changes = [messages => messages.pop(), messages => { messages[1] = { ...messages[0] }; },
    messages => { messages[0].messageId = 'm1-test-scheduled-rev-2026-09-24'; },
    messages => { messages[0].hash = 'x'.repeat(64); }, messages => { messages[0].bcc = []; },
    messages => { messages[0].to = ['info@richmondbjj.com']; }, messages => { messages[0].cc = ['andrew@revolutionbjj.com']; },
    messages => { messages[0].adminUrl = 'https://gib-live.netlify.app/m1/admin/'; },
    messages => { messages[0].synthetic = false; }, messages => { messages[0].state = 'sent'; },
    messages => { messages[0].html = '<p>andrew@revolutionbjj.com</p>'; }, messages => { messages[0].text = 'andrew@revolutionbjj.com'; },
    messages => { messages[0].html = 'x'.repeat(200001); }, messages => { messages[0].unexpected = true; }];
  for (const change of changes) {
    const h = harness({ href: gymLink('rev') }), messages = proposedMessages(); change(messages);
    await open(h, rehearsalResponse(syntheticPreview(), { proposedMessages: messages }));
    assert.match(visibleStatus(h).textContent, /not confirmed/);
    assert.equal(h.nodes.some(node => h.root.contains(node) && ['iframe', 'a'].includes(node.tag)), false);
    assert.equal(h.storage.has(REHEARSAL_KEY), true); assert.equal(h.calls.length, 1);
  }
  const h = harness({ href: gymLink('rev') });
  await open(h, rehearsalResponse(null, { proposedMessages: [] }));
  assert.match(h.root.textContent, /requested gym preview is not yet confirmed/);
  assert.equal(h.nodes.some(node => h.root.contains(node) && node.tag === 'a'), false);
  h.click('refresh'); h.calls[1].resolve(rehearsalResponse(null, { proposedMessages: proposedMessages() })); await flush();
  h.click('refresh'); h.calls[2].reject(new Error('offline')); await flush();
  assert.match(h.root.textContent, /previously loaded proposals/);
  assert.equal(h.nodes.some(node => h.root.contains(node) && node.tag === 'a'), false);
});

test('unsafe gym links and conflicting rehearsal identities fail closed without replacing original storage', async () => {
  const saved = JSON.stringify({ rehearsalId: ID, startedAt: 100000 });
  for (const query of [`digestGym=rev`, `digestRehearsal=${ID}&digestGym=other`, `digestRehearsal=${ID}&digestGym=rev&digestGym=richmond`,
    'digestRehearsal=00000000-0000-4000-8000-000000000002&digestGym=rev']) {
    const h = harness({ storage: new Map([[REHEARSAL_KEY, saved]]), href: `https://deploy-preview-89--gib-live.netlify.app/m1/admin/?${query}#attendanceDigest` });
    await open(h, rehearsalResponse(null, { proposedMessages: proposedMessages() }));
    assert.equal(h.storage.get(REHEARSAL_KEY), saved); assert.equal(h.control('capture').disabled, true);
    assert.equal(h.nodes.some(node => h.root.contains(node) && ['iframe', 'a'].includes(node.tag)), false);
    assert.equal(h.calls.filter(call => call.args[1]).length, 0);
  }
});

test('late proposed messages cannot cross a reviewer change and failed reload preserves the original rehearsal', async () => {
  const h = harness({ href: gymLink('rev') }), opening = h.ui.open();
  h.setAdmin('Stuart Turner'); h.calls[0].resolve(rehearsalResponse(null, { proposedMessages: proposedMessages() })); await opening;
  assert.equal(h.nodes.some(node => h.root.contains(node) && node.tag === 'iframe'), false);
  const reopened = h.ui.open(); h.calls[1].reject(new Error('offline')); await reopened;
  assert.equal(JSON.parse(h.storage.get(REHEARSAL_KEY)).rehearsalId, ID);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args[2].method, 'GET');
  assert.match(visibleStatus(h).textContent, /not confirmed/);
});

test('explicit rehearsal arm preserves the original UUID before its only POST and never changes the real cutoff', async () => {
  const h = harness(); await open(h, response(preview()));
  assert.match(h.root.textContent, /isolated fixtures only/);
  h.click('rehearsal'); h.click('rehearsal'); h.click('capture');
  assert.deepEqual(JSON.parse(h.storage.get(REHEARSAL_KEY)), { rehearsalId: ID, startedAt: 100000 });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].args[1])), { action: 'armRehearsal', rehearsalId: ID });
  assert.equal(h.calls[1].args[2].method, 'POST');
  assert.doesNotMatch(h.root.textContent, /Attendance needs attention/, 'ordinary preview is removed when the rehearsal scope starts');
  h.calls[1].resolve(armed()); await flush();
  assert.match(visibleStatus(h).textContent, /Synthetic rehearsal armed/);
  assert.match(h.root.textContent, /Synthetic cutoff:.*Expires:.*Status: armed/);
  assert.match(h.root.textContent, /22:00 America\/New_York \(not confirmed\)/);
  assert.equal(h.control('capture').disabled, true); assert.equal(h.control('configure').disabled, true);
  assert.equal(h.control('rehearsal').disabled, true); assert.equal(h.calls.length, 2);
  h.click('refresh');
  assert.equal(h.calls[2].args[0], `/api/m1-attendance-digest?rehearsalId=${ID}`);
  assert.equal(h.calls[2].args[1], undefined);
  h.calls[2].resolve(rehearsalResponse(syntheticPreview())); await flush();
  assert.match(h.root.textContent, /Synthetic rehearsal preview captured/);
  h.click('html'); assert.match(h.clicked[0].download, /synthetic-rehearsal/);
  assert.equal(h.calls.filter(call => call.args[1]).length, 1);
});

test('uncertain rehearsal arm survives reload and only reads the original identity', async () => {
  const first = harness(); await open(first); first.click('rehearsal');
  first.calls[1].reject(new Error('reply lost')); await flush();
  assert.match(visibleStatus(first).textContent, /original synthetic rehearsal is not confirmed/);
  assert.equal(first.calls.length, 2); first.ui.clear();
  const h = harness({ storage: first.storage });
  const opening = h.ui.open();
  assert.equal(h.calls[0].args[0], `/api/m1-attendance-digest?rehearsalId=${ID}`);
  assert.equal(h.calls[0].args[1], undefined);
  h.calls[0].resolve(rehearsalResponse(syntheticPreview())); await opening;
  h.click('rehearsal'); assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.storage.get(REHEARSAL_KEY)).rehearsalId, ID);
});

test('direct rehearsal link is authenticated and GET-only, showing the matching synthetic preview', async () => {
  const href = `https://deploy-preview-89--gib-live.netlify.app/m1/admin/?digestRehearsal=${ID}#attendanceDigest`;
  const loggedOut = harness({ href }); loggedOut.logout(); await loggedOut.ui.open();
  assert.equal(loggedOut.calls.length, 0); assert.equal(loggedOut.root.hidden, true);
  const h = harness({ href }); await open(h, rehearsalResponse(syntheticPreview()));
  assert.equal(h.calls[0].args[0], `/api/m1-attendance-digest?rehearsalId=${ID}`);
  assert.equal(h.calls[0].args[1], undefined); assert.equal(h.calls[0].args[2].method, 'GET');
  assert.equal(h.control('rehearsal').disabled, true);
  assert.match(h.root.textContent, /Synthetic rehearsal preview/);
  assert.equal(h.nodes.filter(node => node.tag === 'iframe' && h.root.contains(node)).length, 1);
  assert.equal(JSON.parse(h.storage.get(REHEARSAL_KEY)).rehearsalId, ID);
});

test('wrong-environment, unrelated or non-synthetic rehearsal results cannot become a confirmed preview', async () => {
  for (const value of [rehearsalResponse(syntheticPreview(), { target: 'production' }),
    rehearsalResponse(syntheticPreview(), { sendingEnabled: true }),
    rehearsalResponse(syntheticPreview(), { rehearsal: lease({ rehearsalId: 'foreign' }) }),
    rehearsalResponse(syntheticPreview(), { rehearsal: lease({ synthetic: false }) }),
    rehearsalResponse(preview()), rehearsalResponse(syntheticPreview({ date: '2026-09-24' }))]) {
    const h = harness({ storage: new Map([[REHEARSAL_KEY, JSON.stringify({ rehearsalId: ID, startedAt: 100000 })]]) });
    await open(h, value);
    assert.match(visibleStatus(h).textContent, /original synthetic rehearsal is not confirmed/);
    assert.equal(h.control('capture').disabled, true); assert.equal(h.control('rehearsal').disabled, true);
    assert.equal(h.nodes.filter(node => node.tag === 'iframe' && h.root.contains(node)).length, 0);
    assert.equal(h.storage.has(REHEARSAL_KEY), true); assert.equal(h.calls.length, 1);
  }
});

test('expiry, prepared state and failed reads never imply a completed rehearsal or re-arm one', async () => {
  const h = harness({ storage: new Map([[REHEARSAL_KEY, JSON.stringify({ rehearsalId: ID, startedAt: 100000 })]]) });
  await open(h, rehearsalResponse(syntheticPreview({ state: 'prepared' })));
  assert.match(h.root.textContent, /capture has not been confirmed/);
  assert.doesNotMatch(visibleStatus(h).textContent, /preview captured/);
  h.click('refresh'); h.calls[1].resolve(rehearsalResponse(null, { rehearsal: lease({ state: 'expired' }) })); await flush();
  assert.match(visibleStatus(h).textContent, /synthetic rehearsal has expired/);
  assert.equal(h.control('rehearsal').disabled, true);
  h.click('refresh'); h.calls[2].reject(new Error('offline')); await flush();
  assert.match(visibleStatus(h).textContent, /not confirmed/);
  assert.equal(h.calls.filter(call => call.args[1]).length, 0);
});

test('invalid links and unavailable rehearsal storage cannot arm or automatically replace an identity', async () => {
  for (const query of ['digestRehearsal=bad', `digestRehearsal=${ID}&digestRehearsal=${ID}`]) {
    const h = harness({ href: `https://deploy-preview-89--gib-live.netlify.app/m1/admin/?${query}` });
    await open(h); h.click('rehearsal'); h.click('capture');
    assert.equal(h.calls.length, 1); assert.equal(h.control('rehearsal').disabled, true);
  }
  const broken = harness({ brokenStorage: true }); await open(broken); broken.click('rehearsal'); await flush();
  assert.equal(broken.calls.length, 1); assert.match(visibleStatus(broken).textContent, /No rehearsal was started/);
});

const missingRehearsal = () => Object.assign(new Error('Missing'), { status: 404, data: { code: 'DIGEST_REHEARSAL_MISSING' } });

test('return to normal requires matching final proof, removes only the local rehearsal pointer and clears the direct link', async () => {
  for (const [state, artifact] of [['expired', null], ['armed', syntheticPreview()],
    ['armed', syntheticPreview({ state: 'suppressed' })], ['armed', syntheticPreview({ state: 'failed' })]]) {
    const h = harness({ href: `https://deploy-preview-89--gib-live.netlify.app/m1/admin/?keep=1&digestRehearsal=${ID}#attendanceDigest` });
    await open(h, rehearsalResponse(artifact, { rehearsal: lease({ state }) }));
    assert.equal(h.control('rehearsal-return').disabled, false);
    h.click('rehearsal-return');
    assert.equal(h.storage.has(REHEARSAL_KEY), false);
    assert.equal(h.calls[1].args[0], '/api/m1-attendance-digest'); assert.equal(h.calls[1].args[1], undefined);
    assert.equal(h.historyChanges.length, 1); assert.deepEqual(h.historyChanges[0].state, { retained: true });
    assert.equal(h.location.href, 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/?keep=1#attendanceDigest');
    assert.equal(h.nodes.some(node => node.tag === 'iframe' && h.root.contains(node)), false, 'the old synthetic preview is removed before reading ordinary state');
    h.calls[1].resolve(response()); await flush();
    assert.equal(h.control('capture').disabled, false);
    chooseTime(h, '23:00'); assert.equal(h.control('configure').disabled, false);
    assert.equal(h.calls.filter(call => call.args[1]).length, 0, 'returning never writes central data or history');
    h.ui.clear(); const reopened = h.ui.open();
    assert.equal(h.calls[2].args[0], '/api/m1-attendance-digest');
    h.calls[2].resolve(response()); await reopened;
    assert.equal(h.control('capture').disabled, false);
    assert.equal(h.control('rehearsal-return'), undefined, 'reopening cannot reactivate the exited rehearsal');
  }
});

test('viewing and exiting a completed rehearsal preserves the independent original normal-capture journal', async () => {
  const ordinary = JSON.stringify({ requestId: ID, startedAt: 90000 });
  const h = harness({ storage: new Map([[KEY, ordinary], [REHEARSAL_KEY, JSON.stringify({ rehearsalId: ID, startedAt: 100000 })]]),
    href: `https://deploy-preview-89--gib-live.netlify.app/m1/admin/?digestRehearsal=${ID}#attendanceDigest` });
  await open(h, rehearsalResponse(syntheticPreview()));
  assert.equal(h.calls[0].args[0], `/api/m1-attendance-digest?rehearsalId=${ID}`, 'ordinary identity never enters the synthetic scope');
  assert.equal(h.storage.get(KEY), ordinary);
  h.click('rehearsal-return');
  assert.equal(h.storage.get(KEY), ordinary);
  assert.equal(h.calls[1].args[0], `/api/m1-attendance-digest?requestId=${ID}`);
  h.calls[1].reject(new Error('ordinary read offline')); await flush();
  assert.equal(h.storage.get(KEY), ordinary); assert.equal(h.control('capture').disabled, true);
  assert.equal(h.storage.has(REHEARSAL_KEY), false);
  assert.equal(h.calls.filter(call => call.args[1]).length, 0);
});

test('unknown, still-armed and stale rehearsal state cannot release the active pointer', async () => {
  const h = harness({ storage: new Map([[REHEARSAL_KEY, JSON.stringify({ rehearsalId: ID, startedAt: 100000 })]]) });
  await open(h, rehearsalResponse());
  assert.equal(h.control('rehearsal-return').disabled, true);
  h.click('rehearsal-return'); assert.equal(h.calls.length, 1);
  h.click('refresh'); h.calls[1].resolve(rehearsalResponse(null, { rehearsal: lease({ state: 'expired' }) })); await flush();
  assert.equal(h.control('rehearsal-return').disabled, false);
  h.click('refresh'); h.calls[2].reject(new Error('read lost')); await flush();
  assert.equal(h.control('rehearsal-return').disabled, true);
  h.control('rehearsal-return').disabled = false; h.click('rehearsal-return');
  assert.equal(h.calls.length, 3); assert.equal(h.storage.has(REHEARSAL_KEY), true);
});

test('explicit retry checks first and retries only the original arm identity after a precise missing response', async () => {
  const h = harness(); await open(h); h.click('rehearsal');
  const saved = h.storage.get(REHEARSAL_KEY), originalBody = JSON.stringify(h.calls[1].args[1]);
  h.calls[1].reject(new Error('arm was not delivered')); await flush();
  assert.equal(h.control('rehearsal-retry').disabled, false);
  h.click('rehearsal-retry'); h.click('rehearsal-retry');
  assert.equal(h.calls.length, 3); assert.equal(h.calls[2].args[0], `/api/m1-attendance-digest?rehearsalId=${ID}`);
  assert.equal(h.calls[2].args[1], undefined);
  h.calls[2].reject(missingRehearsal()); await flush();
  assert.equal(h.calls.length, 4); assert.equal(JSON.stringify(h.calls[3].args[1]), originalBody);
  assert.equal(h.storage.get(REHEARSAL_KEY), saved); assert.equal(h.uuidCalls(), 1);
  h.calls[3].resolve(armed()); await flush();
  assert.match(visibleStatus(h).textContent, /Synthetic rehearsal armed/);
  assert.equal(h.control('rehearsal-retry'), undefined);
});

test('same-ID arm retry also recovers after reload when no configuration was loaded', async () => {
  const saved = JSON.stringify({ rehearsalId: ID, startedAt: 90000 });
  const h = harness({ storage: new Map([[REHEARSAL_KEY, saved]]) });
  const opening = h.ui.open(); h.calls[0].reject(missingRehearsal()); await opening;
  h.click('rehearsal-retry'); h.calls[1].reject(missingRehearsal()); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[2].args[1])), { action: 'armRehearsal', rehearsalId: ID });
  assert.equal(h.uuidCalls(), 0); assert.equal(h.storage.get(REHEARSAL_KEY), saved);
  h.calls[2].resolve(armed()); await flush();
  assert.equal(h.calls[3].args[0], `/api/m1-attendance-digest?rehearsalId=${ID}`);
  h.calls[3].resolve(rehearsalResponse()); await flush();
  assert.match(visibleStatus(h).textContent, /Synthetic rehearsal armed/);
  assert.match(h.root.textContent, /22:00 America\/New_York \(not confirmed\)/);
});

test('retry finds an already-persisted arm without another POST and never writes after an ambiguous status read', async () => {
  for (const outcome of [rehearsalResponse(), new Error('offline'),
    Object.assign(new Error('wrong 404'), { status: 404, data: { code: 'OTHER_MISSING' } }),
    rehearsalResponse(null, { target: 'production' })]) {
    const h = harness({ storage: new Map([[REHEARSAL_KEY, JSON.stringify({ rehearsalId: ID, startedAt: 90000 })]]) });
    const opening = h.ui.open(); h.calls[0].reject(new Error('lost read')); await opening;
    h.click('rehearsal-retry');
    if (outcome instanceof Error) h.calls[1].reject(outcome); else h.calls[1].resolve(outcome);
    await flush();
    assert.equal(h.calls.length, 2); assert.equal(h.calls.filter(call => call.args[1]).length, 0);
    assert.equal(h.uuidCalls(), 0); assert.equal(h.storage.has(REHEARSAL_KEY), true);
  }
});

test('Richmond capture panel uses its own central capture and journal without synthetic rehearsal controls', async () => {
  const options = { location: { href: 'https://gib-richmond-test.netlify.app/m1/admin/', origin: 'https://gib-richmond-test.netlify.app', protocol: 'https:', port: '' },
    profile: { installationId: 'richmond', environment: 'test' }, config: { enabled: true, target: 'test' }, create: { site: 'Richmond' } };
  const h = harness(options), config = { ...response().configuration, gyms: [{ id: 'richmond', name: 'Richmond BJJ', staffClockEnabled: false }] };
  const own = response(preview('captured', { groups: [{ gym: 'richmond', name: 'Richmond BJJ', items: [{ summary: 'A Richmond instructor needs review' }] }] }), null, { configuration: config });
  await open(h, own); assert.match(h.root.textContent, /Richmond instructor/); assert.match(h.root.textContent, /Richmond TEST records only/);
  assert.equal(h.control('rehearsal'), undefined); assert.ok(h.control('capture'));
  const read = h.ui.open(); h.calls.at(-1).resolve(response(preview(), null, { configuration: config })); await read;
  assert.match(visibleStatus(h).textContent, /unavailable/);
  const recover = h.ui.open(); h.calls.at(-1).resolve(own); await recover; assert.match(visibleStatus(h).textContent, /Ready to capture/);
  h.click('capture'); await flush(); assert.ok(h.storage.has('m1-attendance-digest-test-richmond-pending-v1')); assert.equal(h.storage.has(KEY), false);
  const sent = h.calls.find(call => call.args[1]?.action === 'capture'); assert.equal(sent.args[1].requestId, ID);
  sent.reject(new Error('Lost reply')); await flush(); h.ui.clear();
});
