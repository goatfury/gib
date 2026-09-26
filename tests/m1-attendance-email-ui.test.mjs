import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildTestDigestEmail } from '../netlify/functions/_lib/m1-attendance-digest-email-proposal.mjs';

const source = readFileSync(new URL('../m1/admin/attendance-email.js', import.meta.url), 'utf8');
const adminCss = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const sharedMessageDisplay = /\bdisplay:\s*([^;]+);/.exec(/\.message\s*\{([^}]*)\}/.exec(adminCss)[1])[1].trim();
const SIGNINS = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/?reviewDate=2026-09-26#sign-ins';
const STAFF = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/#staff-time';
const response = (state = 'not-started') => ({ ok: true, target: 'test', sendingEnabled: false, recurringEnabled: false,
  message: { messageId: 'm1-test-email-andrew-20260926-v1', hash: 'a'.repeat(64), from: 'TEST Digest <test@example.com>', to: ['andrew@example.com'],
    subject: 'TEST attendance email', html: `<h1>TEST example</h1><a href="${SIGNINS}">Example sign-ins</a><a href="${STAFF}">Example Staff Clock</a>`,
    text: `Synthetic example\n${SIGNINS}\n${STAFF}`, synthetic: true, target: 'test' },
  delivery: { state }, recipientSettings: { andrew: { address: 'andrew@example.com', source: 'existing Netlify account' }, stu: { address: null } }, provider: 'resend' });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(options = {}) {
  const calls = [], nodes = [];
  let admin = 'Andrew Smith', unauthorized = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.attributes = {}; this.ownText = ''; }
    set innerHTML(_) { throw new Error('Untrusted markup must not enter the Admin DOM'); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(node => node.textContent).join(' '); }
    append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); }
    replaceChildren(...nodes) { this.ownText = ''; this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, action) { this.events[key] = action; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    closest() { return this.dataset.emailAction ? this : this.parent?.closest(); }
  }
  const document = { createElement: tag => { const node = new Element(tag); nodes.push(node); return node; } };
  const root = new Element('section'); root.ownerDocument = document;
  const context = vm.createContext({ document });
  for (const key of ['localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'crypto']) {
    Object.defineProperty(context, key, { get() { throw new Error('Preview must not access ' + key); } });
  }
  vm.runInContext(source, context);
  const ui = context.GIBM1AttendanceEmail.create({ root, enabled: true, target: 'test', site: 'Rev', getAdmin: () => admin,
    request: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })), onUnauthorized: () => unauthorized++, ...options });
  const current = tag => nodes.filter(node => node.tag === tag && root.contains(node));
  return { ui, root, calls, nodes, current, setAdmin: value => { admin = value; }, unauthorized: () => unauthorized,
    click() { const target = current('button').find(node => node.dataset.emailAction === 'refresh'); root.events.click({ target }); },
    status() { const node = nodes.findLast(node => node.attributes.role === 'status' && root.contains(node)); assert.ok(node);
      assert.equal(node.style.display || sharedMessageDisplay, 'block', 'status must override the actual Admin display:none default'); return node.textContent; } };
}
async function open(h, value = response()) { const opening = h.ui.open(); h.calls.at(-1).resolve(value); await opening; }

test('email preview requires explicit Revolution TEST gate and current Admin access', async () => {
  for (const config of [{ enabled: false }, { enabled: 'true' }, { target: 'production' }, { site: 'Richmond' }, { getAdmin: null }, { request: null }]) {
    const h = harness(config); assert.equal(h.ui, null); assert.equal(h.calls.length, 0);
  }
  const h = harness(); h.setAdmin(''); await h.ui.open(); assert.equal(h.calls.length, 0); assert.equal(h.root.hidden, true);
});

test('normal preview is GET only, identifies the exact recipient and offers no sending, editing or storage operation', async () => {
  const h = harness(); await open(h);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args[0], '/api/m1-attendance-digest-email');
  assert.equal(h.calls[0].args[1], undefined); assert.equal(h.calls[0].args[2].method, 'GET'); assert.equal(h.calls[0].args[2].timeoutMs, 12000);
  assert.match(h.root.textContent, /Proposed single TEST email/); assert.match(h.root.textContent, /No send has been started/);
  assert.match(h.root.textContent, /Sending is off\. Recurring sending is off/);
  assert.match(h.root.textContent, /To: andrew@example.com/); assert.match(h.root.textContent, /From: TEST Digest <test@example.com>/);
  assert.match(h.root.textContent, /Subject: TEST attendance email/); assert.match(h.root.textContent, /Stu: address not configured/);
  assert.deepEqual(h.current('button').map(node => node.textContent), ['Refresh preview']);
  for (const tag of ['input', 'form', 'textarea', 'select']) assert.equal(h.current(tag).length, 0);
  assert.match(h.status(), /Preview loaded/);
});

test('the actual immutable server proposal renders without changing its subject, body or fixed review links', async () => {
  const h = harness(), value = response();
  value.message = buildTestDigestEmail(value.recipientSettings.andrew.address);
  await open(h, value);
  assert.match(h.status(), /Preview loaded/);
  assert.equal(h.current('iframe')[0].srcdoc.includes(value.message.html), true);
  assert.equal(h.current('pre')[0].textContent, value.message.text);
  assert.match(h.root.textContent, /Subject: \[TEST — SYNTHETIC\]/);
  assert.deepEqual(h.current('a').map(node => node.href), [SIGNINS, STAFF]);
  assert.match(h.root.textContent, /cannot be inferred from one sign-in/);
  assert.match(h.root.textContent, /Attendance coverage is incomplete; this is not an all-clear/);
});

test('a reported single-message enablement is truthful while this preview still has no send control', async () => {
  const h = harness(), value = response('disabled'); value.sendingEnabled = true;
  await open(h, value);
  assert.match(h.status(), /Preview loaded/);
  assert.match(h.root.textContent, /Only the separately approved single TEST message can be sent\. Recurring sending is off/);
  assert.doesNotMatch(h.root.textContent, /Sending is off\./);
  assert.deepEqual(h.current('button').map(node => node.textContent), ['Refresh preview']);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args[2].method, 'GET');
});

test('all delivery states are explicit and accepted never claims delivery', async () => {
  const states = { disabled: /Sending is disabled\. Check the retained status; delivery is not confirmed/, pending: /send request is pending/, unknown: /Send outcome unknown/,
    accepted: /Accepted by Resend\. Delivery to the inbox is not confirmed/, rejected: /Rejected by Resend\. No delivery is confirmed/,
    blocked: /Sending is blocked\. No delivery is confirmed/ };
  for (const [state, expected] of Object.entries(states)) {
    const h = harness(); await open(h, response(state)); assert.match(h.root.textContent, expected);
    assert.doesNotMatch(h.root.textContent, /Not sent\.|No send has been started\.|successfully delivered/i);
  }
});

test('unsafe markup stays in an inert opaque sandbox with no resource, form, script or top-navigation permissions', async () => {
  const h = harness(), value = response();
  value.message.html = '<script>unsafe()</script><img src="https://untrusted.example/pixel"><form action="https://untrusted.example"><input></form><a href="javascript:unsafe()">unsafe</a>';
  value.message.subject = '<img src=x onerror=unsafe()> TEST'; value.message.text = '<b>plain text only</b>';
  await open(h, value);
  assert.match(h.root.textContent, /<img src=x onerror=unsafe\(\)> TEST/); assert.match(h.root.textContent, /<b>plain text only<\/b>/);
  for (const tag of ['script', 'img', 'form', 'input']) assert.equal(h.current(tag).length, 0);
  const frame = h.current('iframe')[0]; assert.equal(frame.attributes.sandbox, ''); assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
  assert.match(frame.attributes.csp, /default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  assert.match(frame.attributes.csp, /base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'/);
  assert.equal(Object.keys(frame.attributes).some(key => key.startsWith('allow')), false); assert.equal(frame.src, undefined);
  assert.match(frame.srcdoc, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
  assert.match(frame.srcdoc, /<body inert>/); assert.equal(frame.srcdoc.includes(value.message.html), true);
});

test('only the two fixed example links may appear outside the sandbox', async () => {
  const h = harness(), value = response(); value.message.html += '<a href="https://untrusted.example">external</a>';
  value.message.text += '\nhttps://gib-live.netlify.app/m1/admin/'; await open(h, value);
  assert.deepEqual(h.current('a').map(node => node.href), [SIGNINS, STAFF]);
  assert.match(h.root.textContent, /Synthetic examples only.*do not describe actual recorded work/);
  const noLinks = harness(), missing = response(); missing.message.html = '<p>Example without links</p>'; missing.message.text = 'No links';
  await open(noLinks, missing); assert.equal(noLinks.current('a').length, 0);
});

test('failed first read stays unavailable and manual refresh recovers without retrying automatically', async () => {
  const h = harness(); const opening = h.ui.open(); assert.match(h.status(), /Loading email preview/);
  h.calls[0].reject(new Error('offline')); await opening;
  assert.match(h.status(), /status unavailable/); assert.doesNotMatch(h.root.textContent, /Not sent|No send has been started|Preview loaded/);
  assert.equal(h.current('iframe').length, 0); assert.equal(h.calls.length, 1);
  h.click(); assert.equal(h.calls.length, 2); h.calls[1].resolve(response()); await flush();
  assert.match(h.status(), /Preview loaded/); assert.equal(h.current('iframe').length, 1);
  assert.equal(h.calls.every(call => call.args[1] === undefined && call.args[2].method === 'GET'), true);
});

test('failed refresh labels the retained message stale and never represents old disabled status as current', async () => {
  const h = harness(); await open(h, response('disabled'));
  h.click(); assert.match(h.root.textContent, /Stale preview/); assert.doesNotMatch(h.root.textContent, /Not sent\./);
  h.calls[1].reject(new Error('offline')); await flush();
  assert.match(h.status(), /Current send status could not be confirmed/); assert.match(h.root.textContent, /Current send status is unknown/);
  assert.match(h.root.textContent, /Subject: TEST attendance email/); assert.equal(h.current('iframe').length, 1);
  assert.equal(h.current('a').length, 0); assert.doesNotMatch(h.root.textContent, /Not sent\.|No send has been started\.|Preview loaded/);
});

test('overlapping opens and refresh clicks share one request', async () => {
  const h = harness(); const first = h.ui.open(), second = h.ui.open(); h.click();
  assert.equal(first, second); assert.equal(h.calls.length, 1); h.calls[0].resolve(response()); await first;
  h.click(); h.click(); assert.equal(h.calls.length, 2); h.calls[1].resolve(response()); await flush();
});

test('logout or explicit clear removes private preview and late completion cannot restore it', async () => {
  for (const change of [h => h.setAdmin(''), h => h.ui.clear()]) {
    const h = harness(); const opening = h.ui.open(); change(h); h.calls[0].resolve(response()); await opening;
    assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, ''); assert.equal(h.current('iframe').length, 0);
  }
  const h = harness(); await open(h); h.ui.clear(); assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, '');
});

test('reviewer change discards old data and old responses cannot overwrite the new session', async () => {
  const h = harness(); await open(h); const old = h.ui.open(); h.setAdmin('Stu'); const next = h.ui.open();
  assert.equal(h.calls.length, 3); assert.doesNotMatch(h.root.textContent, /andrew@example.com|TEST attendance email/);
  h.calls[2].resolve(response('unknown')); await next;
  h.calls[1].resolve(response('disabled')); await old;
  assert.match(h.root.textContent, /Send outcome unknown/); assert.doesNotMatch(h.root.textContent, /Not sent\./);
});

test('a response received after an unannounced reviewer change is discarded and cleared', async () => {
  const h = harness(); const opening = h.ui.open(); h.setAdmin('Stu'); h.calls[0].resolve(response()); await opening;
  assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, '');
});

test('authorization failure clears the message and invokes the existing access handler only for the active request', async () => {
  const h = harness(); await open(h); const refresh = h.ui.open(); h.calls[1].reject(Object.assign(new Error('private error'), { status: 401 })); await refresh;
  assert.equal(h.unauthorized(), 1); assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, '');
  const stale = h.ui.open(); h.ui.clear(); h.calls[2].reject(Object.assign(new Error('private error'), { status: 401 })); await stale;
  assert.equal(h.unauthorized(), 1);
});

test('foreign, unsafe or incomplete responses cannot become a current preview', async () => {
  const mutations = [
    value => { value.target = 'production'; }, value => { value.sendingEnabled = 'true'; }, value => { value.recurringEnabled = true; },
    value => { value.provider = 'other'; }, value => { value.message.target = 'production'; }, value => { value.message.synthetic = false; },
    value => { value.message.messageId = 'another-message'; }, value => { value.message.hash = 'not-a-hash'; },
    value => { value.message.to.push('stu@example.com'); }, value => { value.message.to[0] = 'not-an-address'; },
    value => { value.recipientSettings.andrew.address = 'different@example.com'; }, value => { value.recipientSettings.andrew.source = 'invented'; },
    value => { value.recipientSettings.stu.address = 'stu@example.com'; }, value => { value.message.subject = 'bad\r\nsubject'; },
    value => { value.message.from = 'bad\r\nfrom'; }, value => { value.message.html = ''; }, value => { value.message.text = ''; },
    value => { value.delivery.state = 'delivered'; }, value => { delete value.recipientSettings; }
  ];
  for (const mutate of mutations) {
    const h = harness(), value = response(); mutate(value); await open(h, value);
    assert.match(h.status(), /status unavailable/); assert.equal(h.current('iframe').length, 0);
    assert.doesNotMatch(h.root.textContent, /Preview loaded|Not sent|No send has been started/);
  }
});
