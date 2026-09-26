import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildTestDigestEmail } from '../netlify/functions/_lib/m1-attendance-digest-email-proposal.mjs';
import { deliverTestDigestEmail, readTestDigestEmailDelivery } from '../netlify/functions/_lib/m1-attendance-digest-email-delivery.mjs';

const source = readFileSync(new URL('../m1/admin/attendance-email.js', import.meta.url), 'utf8');
const adminCss = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const sharedMessageDisplay = /\bdisplay:\s*([^;]+);/.exec(/\.message\s*\{([^}]*)\}/.exec(adminCss)[1])[1].trim();
const SIGNINS = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/?reviewDate=2026-09-26#sign-ins';
const STAFF = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/#staff-time';
const MESSAGE_ID = 'm1-test-email-andrew-20260926-v1';
const HASH = 'a'.repeat(64);
const delivery = (state, options = {}) => ({ state, messageId: MESSAGE_ID, hash: HASH, code: 'TEST_OUTCOME', deliveryConfirmed: false,
  attemptCount: ['pending', 'unknown', 'accepted', 'rejected'].includes(state) ? 1 : 0, retryAllowed: false,
  ...(state === 'accepted' ? { providerId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794', acceptedAt: 100000 } : {}), ...options });
const response = (state = 'not-started') => ({ ok: true, target: 'test', sendingEnabled: false, recurringEnabled: false,
  message: { messageId: 'm1-test-email-andrew-20260926-v1', hash: 'a'.repeat(64), from: 'TEST Digest <test@example.com>', to: ['andrew@example.com'],
    subject: 'TEST attendance email', html: `<h1>TEST example</h1><a href="${SIGNINS}">Example sign-ins</a><a href="${STAFF}">Example Staff Clock</a>`,
    text: `Synthetic example\n${SIGNINS}\n${STAFF}`, synthetic: true, target: 'test' },
  delivery: delivery(state), recipientSettings: { andrew: { address: 'andrew@example.com', source: 'existing Netlify account' }, stu: { address: null } }, provider: 'resend' });
const sendReply = (state, options) => ({ ok: state === 'accepted', target: 'test', recurringEnabled: false, delivery: delivery(state, options) });
const enabled = (state = 'not-started', retryAllowed = false) => {
  const value = response(state); value.sendingEnabled = true;
  if (retryAllowed) Object.assign(value.delivery, { retryAllowed: true, retryBefore: 10000000 });
  return value;
};
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
    click(action = 'refresh') { const target = current('button').find(node => node.dataset.emailAction === action); if (target) root.events.click({ target }); },
    button(action) { return current('button').find(node => node.dataset.emailAction === action); },
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
  value.delivery.hash = value.message.hash;
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
    value => { value.delivery.state = 'delivered'; }, value => { delete value.recipientSettings; },
    value => { value.delivery.hash = 'b'.repeat(64); }, value => { value.delivery.messageId = 'another-message'; },
    value => { value.delivery.deliveryConfirmed = true; }, value => { value.delivery.retryAllowed = 'true'; },
    value => { value.delivery.attemptCount = -1; }, value => { value.delivery = delivery('accepted', { providerId: null }); },
    value => { value.delivery = delivery('unknown', { retryAllowed: true }); }
  ];
  for (const mutate of mutations) {
    const h = harness(), value = response(); mutate(value); await open(h, value);
    assert.match(h.status(), /status unavailable/); assert.equal(h.current('iframe').length, 0);
    assert.doesNotMatch(h.root.textContent, /Preview loaded|Not sent|No send has been started/);
  }
});

test('enabled first send posts only the immutable approved identity once, then reads its retained acceptance', async () => {
  const h = harness(); await open(h, enabled());
  assert.equal(h.button('send').textContent, 'Send approved TEST email');
  h.click('send'); h.click('send'); h.click('refresh'); const overlapping = h.ui.open();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args[0], '/api/m1-attendance-digest-email'); assert.equal(h.calls[1].args[2].method, 'POST');
  assert.equal(h.calls[1].args[2].timeoutMs, 30000);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].args[1])), { action: 'sendApprovedTest', messageId: MESSAGE_ID, hash: HASH });
  assert.equal(Object.isFrozen(h.calls[1].args[1]), true);
  h.calls[1].resolve(sendReply('accepted')); await flush();
  assert.equal(h.calls.length, 3); assert.equal(h.calls[2].args[2].method, 'GET'); assert.equal(h.calls[2].args[1], undefined);
  h.calls[2].resolve(enabled('accepted')); await overlapping;
  assert.match(h.status(), /Accepted by Resend\. Delivery to the inbox is not confirmed/);
  assert.equal(h.button('send'), undefined); h.click('send'); assert.equal(h.calls.length, 3);
  assert.equal(h.calls.filter(call => call.args[2].method === 'POST').length, 1);
});

test('switching sending off preserves accepted history and never offers another send', async () => {
  const h = harness(); await open(h, response('accepted'));
  assert.match(h.root.textContent, /Accepted by Resend\. Delivery to the inbox is not confirmed/);
  assert.match(h.root.textContent, /Sending is off/); assert.equal(h.button('send'), undefined);
  assert.equal(h.calls.length, 1);
});

test('rejected, unknown and pending replies use preserved adapter error data and a single read without automatic retry', async () => {
  for (const state of ['rejected', 'unknown', 'pending']) {
    const h = harness(); await open(h, enabled()); h.click('send');
    h.calls[1].reject(Object.assign(new Error('The request did not complete.'), { status: 200, data: sendReply(state) })); await flush();
    assert.match(h.status(), state === 'rejected' ? /Rejected by Resend/ : state === 'unknown' ? /Send outcome unknown/ : /send request is pending/);
    assert.equal(h.calls.length, 3); h.calls[2].resolve(enabled(state)); await flush();
    assert.equal(h.calls.length, 3); assert.equal(h.button('send'), undefined);
    assert.equal(h.calls.filter(call => call.args[2].method === 'POST').length, 1);
  }
});

test('explicit server-authorized recovery reuses the exact original identity and never creates a replacement', async () => {
  for (const state of ['unknown', 'rejected']) {
    const h = harness(); await open(h, enabled()); h.click('send');
    const original = h.calls[1].args[1]; h.calls[1].reject(new Error('Lost response')); await flush();
    h.calls[2].resolve(enabled(state, true)); await flush();
    assert.equal(h.calls.length, 3); assert.equal(h.button('send').textContent, 'Retry this same TEST email');
    h.click('send'); h.click('send'); assert.equal(h.calls.length, 4);
    assert.equal(h.calls[3].args[1], original, 'the same immutable object is reused');
    h.calls[3].resolve(sendReply('accepted')); await flush(); h.calls[4].resolve(enabled('accepted')); await flush();
    assert.equal(h.calls.filter(call => call.args[2].method === 'POST').length, 2); assert.equal(h.button('send'), undefined);
  }
});

test('reload reads retained uncertainty and needs an explicit permitted same-ID recovery click', async () => {
  const h = harness(); await open(h, enabled('unknown', true));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args[2].method, 'GET');
  assert.equal(h.button('send').textContent, 'Retry this same TEST email');
  h.click('send'); assert.equal(h.calls[1].args[1].messageId, MESSAGE_ID); assert.equal(h.calls[1].args[1].hash, HASH);
  h.calls[1].reject(new Error('offline')); await flush(); h.calls[2].reject(new Error('offline')); await flush();
  assert.match(h.status(), /Send outcome unknown/); assert.equal(h.button('send'), undefined); assert.equal(h.calls.length, 3);
});

test('lost reply and unavailable retained read leave the original pending until manual read recovery', async () => {
  const h = harness(); await open(h, enabled()); h.click('send');
  h.calls[1].reject(new Error('Lost response')); await flush(); h.calls[2].reject(new Error('Offline')); await flush();
  assert.match(h.status(), /Send outcome unknown.*no automatic retry/i); assert.equal(h.button('send'), undefined);
  assert.equal(h.calls.length, 3); h.click('refresh'); assert.equal(h.calls[3].args[2].method, 'GET');
  h.calls[3].resolve(enabled('accepted')); await flush(); assert.match(h.root.textContent, /Accepted by Resend/);
  assert.equal(h.calls.filter(call => call.args[2].method === 'POST').length, 1); assert.equal(h.button('send'), undefined);
});

test('no retained attempt after uncertain dispatch does not silently become a new first send', async () => {
  const h = harness(); await open(h, enabled()); h.click('send'); h.calls[1].reject(new Error('Lost response')); await flush();
  h.calls[2].resolve(enabled()); await flush();
  assert.equal(h.button('send'), undefined); assert.match(h.root.textContent, /Send outcome unknown\. No retained attempt was found/);
  assert.doesNotMatch(h.root.textContent, /No send has been started/);
});

test('accepted receipt remains send-blocking when status read fails or later contradicts it', async () => {
  const h = harness(); await open(h, enabled()); h.click('send'); h.calls[1].resolve(sendReply('accepted')); await flush();
  h.calls[2].reject(new Error('Offline')); await flush();
  assert.match(h.status(), /Accepted by Resend\. Delivery to the inbox is not confirmed/); assert.equal(h.button('send'), undefined);
  h.click('refresh'); h.calls[3].resolve(enabled('unknown', true)); await flush();
  assert.equal(h.button('send'), undefined); assert.match(h.status(), /status unavailable/);
  assert.equal(h.calls.filter(call => call.args[2].method === 'POST').length, 1);
});

test('changed message hash or an unrelated send receipt cannot release the retained original', async () => {
  const h = harness(); await open(h, enabled()); h.click('send');
  h.calls[1].resolve(sendReply('accepted', { hash: 'b'.repeat(64) })); await flush();
  assert.doesNotMatch(h.status(), /Accepted by Resend/);
  const changed = enabled('unknown', true); changed.message.hash = changed.delivery.hash = 'b'.repeat(64);
  h.calls[2].resolve(changed); await flush();
  assert.match(h.status(), /Send outcome unknown/); assert.equal(h.button('send'), undefined);
  h.click('refresh'); h.calls[3].resolve(changed); await flush();
  assert.equal(h.button('send'), undefined); assert.equal(h.calls.filter(call => call.args[2].method === 'POST').length, 1);
});

test('late send completion cannot apply after logout or reviewer change and never dispatches a follow-up read in that session', async () => {
  for (const leave of [h => h.setAdmin(''), h => h.ui.clear(), h => h.setAdmin('Stu')]) {
    const h = harness(); await open(h, enabled()); h.click('send'); leave(h);
    h.calls[1].resolve(sendReply('accepted')); await flush();
    assert.equal(h.calls.length, 2); assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, '');
  }
});

test('send or readback authentication failures use the existing handler without retrying', async () => {
  for (const stage of ['send', 'read']) {
    const h = harness(); await open(h, enabled()); h.click('send');
    if (stage === 'read') { h.calls[1].resolve(sendReply('accepted')); await flush(); }
    h.calls.at(-1).reject(Object.assign(new Error('Authentication required'), { status: 401 })); await flush();
    assert.equal(h.unauthorized(), 1); assert.equal(h.root.hidden, true); assert.equal(h.root.textContent, '');
    assert.equal(h.calls.filter(call => call.args[2].method === 'POST').length, 1);
  }
});

test('server switch and pending, accepted, disabled, blocked or retry-disallowed states never offer a send', async () => {
  for (const value of [response(), response('unknown'), enabled('pending'), enabled('accepted'), enabled('disabled'), enabled('blocked'), enabled('unknown'), enabled('rejected')]) {
    const h = harness(); await open(h, value); assert.equal(h.button('send'), undefined); h.click('send'); assert.equal(h.calls.length, 1);
  }
});

test('normal UI interoperates with the real durable delivery/read contract, including explicit recovery after a lost provider reply', async () => {
  for (const loseReply of [false, true]) {
    const message = buildTestDigestEmail('andrew@example.com'), entries = new Map(), providerCalls = [];
    let version = 0, sequence = 0;
    const env = { GIB_M1_DIGEST_TEST_SEND_ENABLED: 'true', GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_ID: message.messageId,
      GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_HASH: message.hash, GIB_M1_DIGEST_TEST_APPROVED_RECIPIENT: message.to[0],
      GIB_M1_DIGEST_TEST_RESEND_API_KEY: 'synthetic-unit-test-key' };
    const deps = { env, scope: { target: 'test', profile: { installationId: 'rev' } }, now: () => 100000,
      uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      deliveryStore: {
        async getWithMetadata(key) { return structuredClone(entries.get(key) || null); },
        async set(key, raw, options) {
          const previous = entries.get(key);
          if (options.onlyIfNew && previous || options.onlyIfMatch && options.onlyIfMatch !== previous?.etag) return { modified: false };
          entries.set(key, { etag: 'v' + ++version, data: JSON.parse(raw) }); return { modified: true };
        }
      },
      fetch: async (url, options) => {
        providerCalls.push({ url, body: options.body, id: options.headers['Idempotency-Key'] });
        if (loseReply && providerCalls.length === 1) throw new Error('Synthetic response loss');
        return new Response(JSON.stringify({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }), { status: 200 });
      }
    };
    const read = async () => ({ ...enabled(), sendingEnabled: env.GIB_M1_DIGEST_TEST_SEND_ENABLED === 'true', message,
      delivery: await readTestDigestEmailDelivery(message, deps) });
    const h = harness(); await open(h, await read());
    const attempt = async () => {
      h.click('send'); const call = h.calls.at(-1);
      assert.deepEqual(JSON.parse(JSON.stringify(call.args[1])), { action: 'sendApprovedTest', messageId: message.messageId, hash: message.hash });
      const result = await deliverTestDigestEmail(message, deps);
      const reply = { ok: result.state === 'accepted', target: 'test', recurringEnabled: false, delivery: result };
      if (reply.ok) call.resolve(reply); else call.reject(Object.assign(new Error('Non-accepted result'), { status: 200, data: reply }));
      await flush(); assert.equal(h.calls.at(-1).args[2].method, 'GET'); h.calls.at(-1).resolve(await read()); await flush();
    };
    await attempt();
    if (loseReply) {
      assert.match(h.root.textContent, /Send outcome unknown/); assert.equal(providerCalls.length, 1);
      assert.equal(h.button('send').textContent, 'Retry this same TEST email'); await attempt();
      assert.equal(providerCalls[1].id, providerCalls[0].id); assert.equal(providerCalls[1].body, providerCalls[0].body);
    }
    assert.match(h.root.textContent, /Accepted by Resend\. Delivery to the inbox is not confirmed/);
    assert.equal(h.button('send'), undefined);
    env.GIB_M1_DIGEST_TEST_SEND_ENABLED = 'false'; await open(h, await read());
    assert.match(h.root.textContent, /Accepted by Resend/); assert.match(h.root.textContent, /Sending is off/);
    assert.equal(providerCalls.length, loseReply ? 2 : 1); assert.equal(h.button('send'), undefined);
  }
});
