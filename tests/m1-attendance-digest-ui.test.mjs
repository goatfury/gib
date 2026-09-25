import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../m1/admin/attendance-digest.js', import.meta.url), 'utf8');
const ID = '00000000-0000-4000-8000-000000000001';
const KEY = 'm1-attendance-digest-test-rev-pending-v1';
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
  const calls = [], nodes = [], clicked = [], blobs = [], revoked = [], timers = new Map();
  let now = 100000, timerId = 0, unauthorized = 0, admin = 'Andrew';
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
    crypto: { randomUUID: () => ID },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (options.brokenStorage) throw new Error('blocked'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), Blob: class { constructor(parts, options) { blobs.push({ parts, options }); } },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL: url => revoked.push(url) }
  });
  vm.runInContext(source, context);
  const ui = context.GIBM1AttendanceDigest.create({ root, enabled: true, target: 'test', site: 'Rev',
    request: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
    getAdmin: () => admin, onUnauthorized: () => unauthorized++, ...options.create });
  const all = () => { const found = []; const visit = node => { found.push(node); node.children.forEach(visit); }; visit(root); return found; };
  const control = action => all().find(node => node.dataset.digestAction === action);
  return { ui, calls, root, nodes, storage, clicked, blobs, revoked, timers, control, element: id => all().find(node => node.id === id),
    unauthorized: () => unauthorized, logout: () => { admin = ''; },
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
  assert.equal(h.control('capture').disabled, true);
  h.click('refresh'); assert.equal(h.calls.length, 13); assert.equal(h.calls[12].args[1], undefined);
  h.calls[12].reject(new Error('offline')); await flush();
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
  assert.match(bad.root.textContent, /previous capture could not be verified/);
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
