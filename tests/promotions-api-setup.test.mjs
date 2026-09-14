import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../m1/promotions-api-setup.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../m1/promotions-api-setup.html', import.meta.url), 'utf8');
const ORIGIN = 'https://deploy-preview-86--gib-live.netlify.app';
const PRIVATE = 'PRIVATE_OAUTH_TOKEN_OR_ERROR_MUST_NOT_APPEAR';
const ready = { configured:true, connected:false, setupEnabled:true };
const flush = async () => { for (let step = 0; step < 10; step += 1) await Promise.resolve(); };

function harness(t, { origin = ORIGIN, search = '', pathname = '/m1/promotions-api-setup.html' } = {}) {
  const elements = Object.fromEntries(['status', 'connect', 'check'].map(id => [id, {
    textContent:'', disabled:id === 'connect', handlers:new Map(),
    addEventListener(type, handler) { this.handlers.set(type, handler); }
  }]));
  const calls = []; const assignments = []; const replacements = []; const events = []; const timers = new Map(); let timerId = 0;
  const context = {
    document:{ getElementById:id => elements[id] },
    location:{ origin, search, pathname, assign:value => assignments.push(value) },
    history:{ replaceState(...args) { events.push('replace'); replacements.push(args); } },
    AbortController, URL,
    fetch(url, options) {
      events.push('fetch');
      return new Promise((resolve, reject) => {
        const call = { url, options, operation:JSON.parse(options.body).operation, done:false,
          resolve(value) { this.done = true; resolve(value); }, reject(error) { this.done = true; reject(error); } };
        options.signal.addEventListener('abort', () => call.reject(new Error(PRIVATE)), { once:true });
        calls.push(call);
      });
    },
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { assert.fail('Owner setup must not poll.'); },
    console:new Proxy({}, { get:() => () => assert.fail('Owner setup must not log authorization data.') })
  };
  for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(context, key, {
    get() { assert.fail('Owner setup must not read or persist browser credentials.'); }
  });
  vm.runInNewContext(source, context, { filename:'promotions-api-setup.mjs' });
  const click = async id => { elements[id].handlers.get('click')(); await flush(); };
  const respond = async (index, data, { status = 200, ok = true, envelope = true } = {}) => {
    calls[index].resolve({ ok:status >= 200 && status < 300, status, json:async () => envelope ? { ok, data } : data });
    await flush();
  };
  t.after(async () => { for (const call of calls) if (!call.done) call.reject(new Error('Test cleanup')); await flush(); });
  return { elements, calls, assignments, replacements, events, timers, click, respond,
    async expire() { for (const timer of [...timers.values()]) timer.callback(); await flush(); },
    assertPrivate() { assert.equal(JSON.stringify(elements).includes(PRIVATE), false); }
  };
}

test('setup markup offers no credential fields, starts Connect disabled and keeps the Sign-In return link', () => {
  assert.match(html, /<meta name="referrer" content="no-referrer">/u);
  assert.match(html, /<button id="connect" disabled>Connect Google<\/button>/u);
  assert.match(html, /<a href="\.\/">Return to Sign-In<\/a>/u);
  assert.match(html, /<script type="module" src="\.\/promotions-api-setup\.mjs\?v=[^"]+"><\/script>/u);
  assert.match(html, /authorization can expire after seven days/u);
  assert.doesNotMatch(html, /<(?:input|textarea|form)\b|\bonclick\s*=|https:\/\/(?!accounts\.google\.com)/iu);
});

test('only the exact approved origin can check or start setup, including manually dispatched events', async t => {
  for (const origin of ['https://gib-live.netlify.app', 'https://gib-richmond-live.netlify.app',
    'https://deploy-preview-85--gib-live.netlify.app', 'http://deploy-preview-86--gib-live.netlify.app',
    ORIGIN + '.evil.invalid', ORIGIN + ':443', '', 'null']) {
    const h = harness(t, { origin });
    await h.click('connect'); await h.click('check');
    assert.equal(h.calls.length, 0, origin); assert.equal(h.assignments.length, 0);
    assert.equal(h.elements.connect.disabled, true); assert.equal(h.elements.check.disabled, true);
    assert.match(h.elements.status.textContent, /only on the approved PR86 TEST origin/u);
  }
});

test('callback query claims are scrubbed before one authenticated status read and never prove a connection', async t => {
  const h = harness(t, { search:'?connected=true&result=success&code=' + PRIVATE });
  assert.deepEqual(h.events, ['replace', 'fetch']);
  assert.deepEqual(h.replacements[0], [null, '', '/m1/promotions-api-setup.html']);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].operation, 'status');
  assert.equal(h.elements.connect.disabled, true); assert.equal(h.assignments.length, 0);
  await h.respond(0, { configured:false, connected:false, setupEnabled:false, private:PRIVATE });
  assert.match(h.elements.status.textContent, /still being prepared/u);
  assert.equal(h.elements.connect.disabled, true); h.assertPrivate();
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 1);
});

test('ready status alone never redirects; one explicit Connect action uses a bounded same-origin request', async t => {
  const h = harness(t); await h.respond(0, ready);
  assert.equal(h.elements.connect.disabled, false); assert.equal(h.assignments.length, 0);
  assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0, 'no background polling remains after status');
  await h.click('connect'); await h.click('connect'); await h.click('check');
  assert.equal(h.calls.length, 2, 'busy state prevents duplicate authorization and polling');
  const call = h.calls[1]; const { signal, ...options } = call.options;
  assert.equal(call.url, '/api/m1-promotions-api-oauth');
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error',
    headers:{ 'Content-Type':'application/json', Accept:'application/json' }, body:'{"operation":"start"}' });
  assert.equal(signal.aborted, false); assert.equal([...h.timers.values()][0].ms, 15000);
  const destination = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=public-id&state=opaque-state';
  await h.respond(1, { authorizationUrl:destination });
  assert.deepEqual(h.assignments, [destination]); assert.equal(h.calls.length, 2);
});

test('unconfigured, connected and disabled setup cannot start even if its disabled button receives an event', async t => {
  for (const data of [
    { configured:false, connected:false, setupEnabled:false },
    { configured:false, connected:false, setupEnabled:true },
    { configured:true, connected:false, setupEnabled:false },
    { configured:true, connected:true, setupEnabled:true },
    { configured:true, connected:true, setupEnabled:false }
  ]) {
    const h = harness(t); await h.respond(0, data); await h.click('connect');
    assert.equal(h.elements.connect.disabled, true); assert.equal(h.calls.length, 1); assert.equal(h.assignments.length, 0);
  }
});

test('unauthorized, setup failures and malformed status replies remain closed and do not expose server text', async t => {
  for (const [data, responseOptions] of [
    [ready, { status:401 }], [ready, { status:403 }], [ready, { status:503 }],
    [ready, { ok:false }], [null, {}], [[], {}], [{ configured:true }, {}],
    [{ configured:true, connected:'yes', setupEnabled:true, error:PRIVATE }, {}],
    [{ ok:false, error:{ message:PRIVATE } }, { envelope:false }]
  ]) {
    const h = harness(t); await h.respond(0, data, responseOptions); await h.click('connect');
    assert.equal(h.elements.connect.disabled, true); assert.equal(h.elements.check.disabled, false);
    assert.equal(h.calls.length, 1); assert.equal(h.assignments.length, 0);
    assert.match(h.elements.status.textContent, /No successful connection is being claimed/u); h.assertPrivate();
  }
});

test('authorization redirect rejects other origins, paths, credentials and fragments without exposing the returned URL', async t => {
  for (const destination of [
    'https://evil.invalid/' + PRIVATE,
    'https://accounts.google.com.evil.invalid/o/oauth2/v2/auth',
    'http://accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com:444/o/oauth2/v2/auth',
    'https://' + PRIVATE + '@accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com/o/oauth2/v2/auth/' + PRIVATE,
    'https://accounts.google.com/o/oauth2/v2/auth#' + PRIVATE,
    'https://accounts.google.com/o/oauth2/auth', '/relative/' + PRIVATE, PRIVATE
  ]) {
    const h = harness(t); await h.respond(0, ready); await h.click('connect');
    await h.respond(1, { authorizationUrl:destination });
    assert.equal(h.assignments.length, 0); assert.equal(h.elements.connect.disabled, true);
    assert.match(h.elements.status.textContent, /No successful connection is being claimed/u); h.assertPrivate();
  }
});

test('a failed start never enables another Connect until a fresh explicit status check confirms it', async t => {
  const h = harness(t); await h.respond(0, ready); await h.click('connect');
  await h.respond(1, { authorizationUrl:'https://evil.invalid/' + PRIVATE });
  await h.click('connect'); assert.equal(h.calls.length, 2);
  await h.click('check'); assert.equal(h.calls.length, 3); assert.equal(h.calls[2].operation, 'status');
  await h.respond(2, ready); assert.equal(h.elements.connect.disabled, false); h.assertPrivate();
});

test('the fifteen-second request deadline fails closed without retry or background polling', async t => {
  for (const duringStart of [false, true]) {
    const h = harness(t);
    if (duringStart) { await h.respond(0, ready); await h.click('connect'); }
    const expectedCalls = duringStart ? 2 : 1;
    await h.expire();
    assert.equal(h.calls.at(-1).options.signal.aborted, true);
    assert.equal(h.elements.connect.disabled, true); assert.equal(h.elements.check.disabled, false);
    assert.equal(h.calls.length, expectedCalls); assert.equal(h.timers.size, 0);
    assert.equal(h.assignments.length, 0); h.assertPrivate();
    await h.click('connect'); assert.equal(h.calls.length, expectedCalls);
  }
});
