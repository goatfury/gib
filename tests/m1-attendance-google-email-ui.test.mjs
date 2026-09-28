import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildGoogleEmailTestMessage, GOOGLE_EMAIL_TEST_REQUEST_ID } from '../netlify/functions/_lib/m1-attendance-google-email-test.mjs';

const source = readFileSync(new URL('../m1/admin/attendance-google-email.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const KEY = 'm1-attendance-google-email-test-rev-original-v1';
const ID = 'm1-test-scheduled-rev-2026-09-28', HASH = 'a'.repeat(64), REQUEST = 'd6421f42-4a99-4d1e-a93b-60a08fe36d96';
const ADDRESS = 'revbjjops@gmail.com';
const message = { messageId: ID, hash: HASH, from: ADDRESS, to: [ADDRESS], cc: [], subject: '[TEST — SYNTHETIC] Google test',
  html: '<p>Exact synthetic email body</p>', text: 'Exact synthetic email body', synthetic: true, target: 'test' };
const googleResult = { ok: true, target: 'test', gym: 'rev', messageId: ID, hash: HASH, state: 'submitted', code: 'MAILAPP_SUBMITTED',
  attemptedAt: '2026-09-28T14:00:00.000Z', completedAt: '2026-09-28T14:00:01.000Z', retrySafe: false };
function response(state = 'not-started', requestState = state === 'not-started' ? 'prepared' : 'complete') {
  return { ok: true, target: 'test', provider: 'mailapp', recurringEnabled: false, sendingEnabled: state === 'not-started', message: structuredClone(message),
    delivery: { provider: 'mailapp', messageId: ID, hash: HASH, state, code: state === 'submitted' ? 'MAILAPP_SUBMITTED' : 'NO_RETAINED_DELIVERY',
      deliveryConfirmed: false, attemptCount: state === 'not-started' ? 0 : 1, retryAllowed: false,
      ...(state === 'submitted' ? { durableAttempt: true, googleResult: structuredClone(googleResult) } : {}) },
    requestId: REQUEST, request: { requestId: REQUEST, state: requestState }, readiness: { ready: state === 'not-started', oneMessageOnly: true,
      exactRecipientApproved: true, generalSendingEnabled: false, expiresAt: 1790629200000, codes: state === 'not-started' ? [] : ['GOOGLE_EMAIL_AUTHORIZATION_CONSUMED'] } };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness(options = {}) {
  const calls = [], nodes = [], timers = new Map(), storage = options.storage || new Map([['untouched-queue', 'original-punch'], ['untouched-save', 'original-save']]);
  let admin = 'Andrew Smith', session = 'existing-session', unauthorized = 0, nextTimer = 0, now = 1000;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.attributes = {}; this.ownText = ''; }
    set innerHTML(_) { throw new Error('Email markup cannot enter the Admin DOM'); }
    set textContent(v) { this.ownText = String(v); this.children = []; }
    get textContent() { return this.ownText + this.children.map(n => n.textContent).join(' '); }
    append(...nodes) { nodes.forEach(n => { n.parent = this; this.children.push(n); }); }
    replaceChildren(...nodes) { this.ownText = ''; this.children = []; this.append(...nodes); }
    setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener(k, v) { this.events[k] = v; }
    contains(n) { return this === n || this.children.some(child => child.contains(n)); }
    closest() { return this.dataset.googleEmailAction ? this : this.parent?.closest(); }
  }
  const document = { hidden: false, createElement: tag => { const n = new Element(tag); nodes.push(n); return n; } };
  const root = new Element('section'); root.ownerDocument = document;
  const context = vm.createContext({ document, URLSearchParams, Date: class extends Date { static now() { return now; } },
    location: { origin: 'https://deploy-preview-89--gib-live.netlify.app', protocol: 'https:', port: '', search: '?emailTest=google-v1', hash: '#attendanceGoogleEmail', ...options.location },
    M1_INSTALLATION_PROFILE: { installationId: 'rev', ...options.profile }, M1_MANAGER_REVIEW_CONFIG: { enabled: true, target: 'test', ...options.config },
    sessionStorage: { getItem: key => { if (options.storageBroken) throw new Error('unavailable'); return storage.get(key) ?? null; },
      setItem: (key, value) => { assert.equal(key, KEY); if (options.storageBroken) throw new Error('unavailable'); storage.set(key, value); },
      removeItem() { throw new Error('No original journal may be removed'); }, clear() { throw new Error('Storage must be preserved'); } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  for (const key of ['localStorage', 'indexedDB', 'fetch', 'crypto']) Object.defineProperty(context, key, { get() { throw new Error('Unexpected ' + key); } });
  vm.runInContext(source, context);
  const ui = context.GIBM1AttendanceGoogleEmail.create({ root, enabled: true, target: 'test', site: 'Rev', getAdmin: () => admin,
    getSession: () => session, request: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject, journal: storage.get(KEY) })),
    onUnauthorized: () => unauthorized++, ...options.create });
  const current = tag => nodes.filter(n => n.tag === tag && root.contains(n));
  return { ui, calls, root, storage, current, timers, document, setAdmin: v => { admin = v; }, setSession: v => { session = v; }, unauthorized: () => unauthorized,
    button: action => current('button').find(n => n.dataset.googleEmailAction === action),
    click(action) { const target = this.button(action); if (target) root.events.click({ target }); },
    status() { const n = current('p').find(n => n.attributes.role === 'status'); assert.equal(n?.style.display, 'block'); return n.textContent; },
    async tick(ms = 3000) { now += ms; const timer = [...timers.entries()][0]; if (timer) { timers.delete(timer[0]); timer[1].fn(); await flush(); } } };
}
async function open(h, value = response()) { const p = h.ui.open(); h.calls.at(-1).resolve(value); await p; }
function original(submitted = false) { return JSON.stringify({ messageId: ID, hash: HASH, requestId: REQUEST, submitted }); }

test('one-shot Google preview is isolated to the exact TEST handoff and authenticated session', async () => {
  for (const options of [{ create: { enabled: false } }, { create: { target: 'production' } }, { create: { site: 'Richmond' } },
    { location: { origin: 'https://gib-live.netlify.app' } }, { location: { search: '' } }, { location: { hash: '#attendanceEmail' } },
    { config: { enabled: false } }, { profile: { installationId: 'richmond' } }, { create: { getSession: null } }]) {
    const h = harness(options); assert.equal(h.ui, null); assert.equal(h.calls.length, 0);
  }
  for (const change of [h => h.setAdmin(''), h => h.setSession('')]) { const h = harness(); change(h); await h.ui.open(); assert.equal(h.calls.length, 0); assert.equal(h.root.hidden, true); }
});

test('fresh GET renders the exact private synthetic body safely and offers only one approved send', async () => {
  const h = harness(); await open(h);
  assert.equal(h.calls[0].args[0], '/api/m1-attendance-google-email'); assert.equal(h.calls[0].args[1], undefined); assert.equal(h.calls[0].args[2].method, 'GET');
  assert.equal(h.calls[0].args[2].timeoutMs, 12000); assert.match(h.status(), /status checked/);
  assert.match(h.root.textContent, /From: revbjjops@gmail.com.*To: revbjjops@gmail.com.*CC: none/);
  assert.match(h.root.textContent, /Recurring sending stays off/); assert.ok(h.button('send')); assert.equal(h.button('check'), undefined);
  const iframe = h.current('iframe')[0]; assert.equal(iframe.attributes.sandbox, ''); assert.equal(iframe.attributes.referrerpolicy, 'no-referrer');
  assert.match(iframe.attributes.csp, /script-src 'none'.*form-action 'none'/); assert.ok(iframe.srcdoc.includes(message.html));
  assert.equal(h.current('pre')[0].textContent, message.text); assert.equal(h.current('a').length, 0);
  assert.equal(h.storage.has(KEY), false); assert.equal(h.storage.get('untouched-queue'), 'original-punch');
});

test('send is journaled before dispatch; overlaps do not send twice and lost reply allows only original check', async () => {
  const h = harness(); await open(h); h.click('send'); h.click('send'); h.click('refresh');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].journal, original());
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].args[1])), { action: 'sendApprovedTest', messageId: ID, hash: HASH });
  assert.equal(h.calls[1].args[2].method, 'POST'); h.calls[1].reject(new Error('lost reply')); await flush();
  assert.equal(h.button('send'), undefined); assert.ok(h.button('check')); assert.match(h.status(), /No second send/);
  h.click('check'); assert.deepEqual(JSON.parse(JSON.stringify(h.calls[2].args[1])), { action: 'checkOriginal', messageId: ID, hash: HASH });
  h.calls[2].resolve(response('submitted')); await flush();
  assert.match(h.root.textContent, /Submitted to Google: the Google mail call completed/); assert.match(h.root.textContent, /Arrival in the inbox has not been verified/);
  assert.equal(h.button('send'), undefined); assert.equal(h.button('check'), undefined); assert.equal(h.storage.get(KEY), original(true));
  assert.equal(h.storage.get('untouched-queue'), 'original-punch'); assert.equal(h.storage.get('untouched-save'), 'original-save');
});

test('actual Google message builder renders unchanged with the actual server request identity and truthful test label', async () => {
  const value = response(); value.message = buildGoogleEmailTestMessage(Date.parse('2026-09-28T14:00:00.000Z'));
  value.delivery.hash = value.message.hash; value.requestId = value.request.requestId = GOOGLE_EMAIL_TEST_REQUEST_ID;
  const h = harness(); await open(h, value); assert.ok(h.button('send')); assert.ok(h.current('iframe')[0].srcdoc.includes(value.message.html));
  assert.equal(h.current('pre')[0].textContent, value.message.text); assert.match(h.root.textContent, /ONE AUTHORIZED TEST EMAIL/);
  assert.doesNotMatch(value.message.text, /sending disabled|actual email sending is disabled/);
  h.click('send'); assert.equal(JSON.parse(h.calls[1].journal).requestId, GOOGLE_EMAIL_TEST_REQUEST_ID);
  assert.equal(h.calls[1].args[1].hash, value.message.hash); h.calls[1].reject(new Error('fixture stops before any network')); await flush();
});

test('reload restores the exact original latch, uses GET only and never turns no-ledger into permission to resend', async () => {
  const storage = new Map([[KEY, original()], ['untouched-queue', 'original-punch']]); const h = harness({ storage }); await open(h);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args[2].method, 'GET'); assert.equal(h.button('send'), undefined); assert.ok(h.button('check'));
  assert.match(h.root.textContent, /original send result is unconfirmed/); assert.equal(storage.get(KEY), original());
  h.ui.clear(); assert.equal(h.root.hidden, true); assert.equal(storage.get(KEY), original()); await open(h, response('unknown')); assert.ok(h.button('check'));
});

test('central attempts latch a fresh browser; submitted results require complete matching Google evidence', async () => {
  const h = harness(); await open(h, response('unknown')); assert.equal(h.storage.get(KEY), original()); assert.equal(h.button('send'), undefined);
  for (const mutate of [v => delete v.delivery.googleResult.completedAt, v => { v.delivery.googleResult.hash = 'b'.repeat(64); },
    v => { v.delivery.googleResult.gym = 'richmond'; }, v => { v.delivery.durableAttempt = false; }]) {
    const candidate = response('submitted'); mutate(candidate); const broken = harness(); await open(broken, candidate);
    assert.match(broken.status(), /unavailable/); assert.equal(broken.button('send'), undefined); assert.doesNotMatch(broken.root.textContent, /Submitted to Google:/);
  }
});

test('missing, mismatched or stale responses cannot enable a send or erase a confirmed result', async () => {
  for (const mutate of [v => { v.message.to = ['stu@example.com']; }, v => { v.message.cc = ['other@example.com']; },
    v => { v.message.target = 'production'; }, v => { v.recurringEnabled = true; }, v => { v.delivery.hash = 'b'.repeat(64); },
    v => { v.requestId = 'wrong'; }, v => { delete v.request; }, v => { v.readiness.generalSendingEnabled = true; }, v => { delete v.readiness; }]) {
    const value = response(); mutate(value); const h = harness(); await open(h, value); assert.equal(h.button('send'), undefined); assert.match(h.status(), /unavailable/);
  }
  const h = harness(); await open(h, response('submitted')); h.click('refresh'); h.calls[1].resolve(response('unknown')); await flush();
  assert.match(h.status(), /unavailable/); assert.match(h.root.textContent, /Google mail call completed/); assert.equal(h.storage.get(KEY), original(true)); assert.equal(h.button('send'), undefined);
  const mismatch = harness({ storage: new Map([[KEY, original()]]) }); const value = response(); value.requestId = value.request.requestId = 'c6aaf535-68a7-4d0a-a6fe-fd235e2cbd48';
  await open(mismatch, value); assert.match(mismatch.status(), /unavailable/); assert.equal(mismatch.storage.get(KEY), original());
});

test('failed reads recover with a fresh GET, while unavailable or malformed journal blocks all sending', async () => {
  const h = harness(); const first = h.ui.open(); h.calls[0].reject(new Error('offline')); await first;
  assert.match(h.status(), /unavailable/); assert.equal(h.button('send'), undefined); h.click('refresh'); h.calls[1].resolve(response()); await flush(); assert.ok(h.button('send'));
  for (const options of [{ storageBroken: true }, { storage: new Map([[KEY, 'null']]) }, { storage: new Map([[KEY, '{}']]) }]) {
    const blocked = harness(options); await open(blocked); assert.equal(blocked.button('send'), undefined); assert.match(blocked.status(), /could not be retained safely/);
  }
  const storage = new Map(); const cannotSave = harness({ storage }); await open(cannotSave);
  storage.set = () => { throw new Error('quota full after preview'); };
  cannotSave.click('send'); await flush(); assert.equal(cannotSave.calls.length, 1);
  assert.equal(cannotSave.button('send'), undefined); assert.match(cannotSave.status(), /could not be retained safely/);
});

test('pending polls are GET-only, never overlap, stop within two minutes, and leave a safe original check', async () => {
  const h = harness(); await open(h, response('unknown', 'pending')); assert.equal(h.timers.size, 1);
  await h.tick(); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args[2].method, 'GET'); assert.equal(h.timers.size, 0);
  h.click('refresh'); assert.equal(h.calls.length, 2); h.calls[1].resolve(response('unknown', 'pending')); await flush();
  await h.tick(120000); assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0); assert.match(h.status(), /Automatic checking has stopped/); assert.ok(h.button('check')); assert.equal(h.button('send'), undefined);
  assert.ok(h.calls.every(call => call.args[2].method === 'GET'));
});

test('logout, session changes and hidden pages cannot reveal stale private results or create polling overlap', async () => {
  for (const change of [h => h.setAdmin(''), h => h.setSession('new-session'), h => h.ui.clear()]) {
    const h = harness(); const first = h.ui.open(); change(h); h.calls[0].resolve(response()); await first; assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, '');
  }
  const h = harness(); await open(h, response('unknown', 'pending')); h.document.hidden = true; await h.tick(); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  const auth = harness({ storage: new Map([[KEY, original()]]) }); const p = auth.ui.open(); auth.calls[0].reject({ status: 401 }); await p;
  assert.equal(auth.unauthorized(), 1); assert.equal(auth.root.hidden, true); assert.equal(auth.storage.get(KEY), original());
});

test('actual Admin wiring preserves authenticated GET routing and directly surfaces only the new handoff', () => {
  assert.match(index, /id="attendanceGoogleEmail"[^>]+hidden/); assert.match(index, /src="\.\/attendance-google-email\.js"/);
  const readPattern = /const readDigest = options\.method === 'GET' && (\/.*\/).test\(url\)/.exec(index)[1];
  const allowed = vm.runInNewContext(readPattern); assert.equal(allowed.test('/api/m1-attendance-google-email'), true);
  assert.equal(allowed.test('/api/m1-attendance-google-email-unsafe'), false);
  assert.match(index, /attendanceGoogleEmail\.clear\(\)/); assert.match(index, /attendanceGoogleEmail = globalThis\.GIBM1AttendanceGoogleEmail\?\.create/);
  assert.match(index, /firstEntry && !googleEmailHandoff/); assert.match(index, /getSession: \(\) => adminRequestToken/);
});
