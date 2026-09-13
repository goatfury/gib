import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { installationProfile } from '../m1/installation-profile-core.mjs';
import { mountPromotionsLog } from '../m1/promotions-client.mjs';

// Drive the shipped mounted module through its actual controls. The DOM and
// fetch boundaries are simulated; real browser timing/layout remain release QA.
const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const config = { enabled: true, testOnly: true, endpoint: '/api/m1-promotions' };
const student = (id, revision = 1, marks = 1) => ({
  studentId: `fixture-student-${id}`, displayName: `TEST Person ${id}`, distinguishingLabel: `Group ${id}`,
  status: 'active', rankKnown: true, belt: 'White Belt', marks, markType: 'stripes',
  revision, lastEventId: `fixture-event-${id}-${revision}`, legacyRefs: '', historyNote: 'Historical date unknown'
});

class EventTarget {
  events = new Map();
  addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(handler); }
  removeEventListener(type, handler) { this.events.set(type, (this.events.get(type) || []).filter(value => value !== handler)); }
  emit(type, options = {}) {
    const event = { type, target: this, key: '', preventDefault() { this.defaultPrevented = true; }, ...options };
    let current = this;
    const results = [];
    do { for (const handler of current.events.get(type) || []) results.push(handler(event)); current = current.parent; } while (current);
    return results;
  }
}

function makeDocument() {
  const document = new EventTarget();
  const ids = new Map();
  class Element extends EventTarget {
    constructor(tag = 'div') {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.value = '';
      this.hidden = false; this.disabled = false; this.checked = false; this.open = false; this.style = {}; this.attributes = new Map(); this.dataset = {}; this.text = '';
      const classes = new Set();
      this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle(value, on) { if (on ?? !classes.has(value)) classes.add(value); else classes.delete(value); } };
    }
    set textContent(text) { this.text = String(text); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(markup) { this.text = ''; this.children = []; parse(markup, this); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
    get firstElementChild() { return this.children[0]; }
    setAttribute(name, value) {
      value = String(value); this.attributes.set(name, value);
      if (name === 'id') { this.id = value; ids.set(value, this); }
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())] = value;
      if (name === 'class') value.split(/\s+/u).forEach(item => this.classList.add(item));
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
      if (name === 'value') this.value = value;
      if (name === 'type') this.type = value;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    querySelectorAll(selector) {
      const descendants = [];
      const walk = node => { for (const child of node.children) { descendants.push(child); walk(child); } };
      walk(this);
      const parts = selector.split(',').map(value => value.trim());
      return descendants.filter(node => parts.some(part => {
        const data = part.match(/^\[data-promo-id="([^"]+)"\]$/u);
        if (data) return node.getAttribute('data-promo-id') === data[1];
        if (/^(input|textarea|select|button)$/u.test(part)) return node.tagName === part.toUpperCase();
        if (part.startsWith('#classListWrap ')) return node.type === 'checkbox' && (!part.endsWith(':checked') || node.checked);
        if (part.startsWith('#')) return node.id === part.slice(1);
        return false;
      }));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  function parse(markup, parent) {
    const stack = [parent];
    const voidTags = new Set(['INPUT', 'BR', 'HR', 'LINK', 'META', 'IMG']);
    for (const token of markup.matchAll(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+/gu)) {
      const raw = token[0];
      if (raw.startsWith('<!--')) continue;
      if (raw.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!raw.startsWith('<')) { stack.at(-1).text += raw; continue; }
      const name = raw.match(/^<([A-Za-z][\w-]*)/u)[1];
      const element = new Element(name);
      for (const attr of raw.slice(name.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/gu)) element.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1).append(element);
      if (!voidTags.has(element.tagName)) stack.push(element);
    }
  }
  document.body = new Element('body'); document.body.parent = document;
  document.createElement = tag => new Element(tag);
  document.getElementById = id => ids.get(id) || null;
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.visibilityState = 'visible'; document.activeElement = null;
  // Parse the actual static body before its inline application script.
  const bodyStart = html.indexOf('<body');
  const bodyContent = html.indexOf('>', bodyStart) + 1;
  parse(html.slice(bodyContent, html.indexOf('<script', bodyContent)), document.body);
  return document;
}

function installActualKioskGuard(document) {
  const helper = name => html.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}`, 'u'))?.[0];
  const guard = html.match(/globalThis\.M1_KIOSK_NAVIGATION = Object\.freeze\(\{[\s\S]*?\n  \}\);/u)?.[0];
  assert.ok(guard);
  const context = vm.createContext({ document, $: selector => document.getElementById(selector.slice(1)) });
  vm.runInContext(`let signInLocked = false; let lastSigninBatchId = null;\n${helper('selectedClasses')}\n${helper('kioskFormInProgress')}\n${guard}`, context);
  return { value: context.M1_KIOSK_NAVIGATION, set({ locked = false, batch = null } = {}) { vm.runInContext(`signInLocked = ${JSON.stringify(locked)}; lastSigninBatchId = ${JSON.stringify(batch)}`, context); } };
}

async function flush() { for (let count = 0; count < 8; count += 1) await Promise.resolve(); }

function mountedHarness(t, { profile = installationProfile('rev'), stored = new Map() } = {}) {
  const document = makeDocument();
  const clock = { now: Date.parse('2026-09-13T16:00:00Z') };
  const windowTarget = new EventTarget();
  const intervals = new Map(); let timerId = 0;
  windowTarget.setInterval = callback => { intervals.set(++timerId, callback); return timerId; };
  windowTarget.clearInterval = id => intervals.delete(id);
  const calls = [];
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) };
  const guard = installActualKioskGuard(document);
  const oldGuard = globalThis.M1_KIOSK_NAVIGATION;
  globalThis.M1_KIOSK_NAVIGATION = guard.value;
  const fetcher = (url, options) => new Promise((resolve, reject) => calls.push({ url, options, payload: JSON.parse(options.body), resolve, reject, settled: false, taken: false }));
  const mounted = mountPromotionsLog({ document, profile, config, fetcher, storage, now: () => clock.now, windowTarget });
  const el = id => document.getElementById(id.startsWith('promotions-') ? id : `promotions-${id}`);
  const take = (operation, studentId) => {
    const call = calls.find(item => !item.taken && item.payload.operation === operation && (!studentId || item.payload.studentId === studentId));
    assert.ok(call, `Missing ${operation} request`); call.taken = true; return call;
  };
  const respond = async (call, body, status = 200) => { call.settled = true; call.resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); await flush(); };
  const success = (call, data) => respond(call, { ok: true, data });
  const bootstrap = async (students = [student('A'), student('B')]) => {
    const opening = mounted.open(); await flush();
    await success(take('bootstrap'), { testOnly: true, todayNY: '2026-09-13', recorderLabel: 'Authorized TEST tablet', approvers: [{ id: 'TEST-COACH-A', label: 'TEST Coach Avery' }], students });
    await opening;
  };
  const choose = async (id, fresh = student(id)) => {
    el('studentSearch').value = `TEST Person ${id}`; el('studentSearch').emit('input');
    el('searchResults').children[0].emit('click'); await flush();
    const call = take('readStudent', fresh.studentId);
    await success(call, { student: fresh, history: [] });
  };
  t.after(async () => {
    for (const call of calls) if (!call.settled) { call.settled = true; call.reject(new Error('Test cleanup')); }
    await flush(); mounted?.destroy();
    globalThis.M1_KIOSK_NAVIGATION = oldGuard;
  });
  return {
    document, clock, windowTarget, intervals, calls, stored, guard, mounted, el, take, respond, success, bootstrap, choose,
    tick(ms) { clock.now += ms; for (const callback of intervals.values()) callback(); },
    async beginStripe() {
      el('addStripe').emit('click'); el('approverChoice').value = 'TEST-COACH-A'; el('approverChoice').emit('change');
      el('entryForm').emit('submit'); await flush(); return take('recordPromotion');
    },
    saved(call, id = 'A') {
      const after = student(id, 2, 2);
      return { student: after, viewPending: false, receipt: { requestId: call.payload.requestId, studentId: after.studentId, eventId: `evt-${id}-2`, revision: 2, eventKind: 'STRIPE', eventDateNY: '2026-09-13', before: student(id), after, approverLabel: 'TEST Coach Avery' } };
    },
    neutral() {
      assert.equal(document.getElementById('promotionsPanel').hidden, true);
      assert.equal(document.body.classList.contains('promotions-view'), false);
      for (const id of ['studentSearch', 'approverChoice', 'entryReason', 'newName', 'newIdentity', 'newHistoryNote']) assert.equal(el(id).value, '');
      for (const id of ['studentName', 'studentIdentity', 'studentRank', 'studentDate', 'legacyNotes', 'historyList', 'message']) assert.equal(el(id).textContent, '');
    }
  };
}

test('mounted navigation preserves active instructor input, Undo and Staff Clock before opening the optional log', async t => {
  const h = mountedHarness(t);
  const name = h.document.getElementById('nameInput');
  const notes = h.document.getElementById('notesInput');
  name.value = 'TEST Instructor still typing'; notes.value = 'Keep this note';
  assert.equal(await h.mounted.open(), false);
  assert.equal(name.value, 'TEST Instructor still typing'); assert.equal(notes.value, 'Keep this note');
  name.value = ''; notes.value = ''; h.guard.set({ locked: true, batch: 'current-undo-batch' });
  assert.equal(await h.mounted.open(), false, 'the released Undo batch remains protected');
  assert.equal(h.guard.value.canLeaveSignIn(), false);
  h.guard.set();
  h.document.getElementById('staffClockName').value = 'TEST Staff selection';
  assert.equal(await h.mounted.open(), false);
  h.document.getElementById('staffClockName').value = '';
  h.document.getElementById('staffClockConfirmation').hidden = false;
  assert.equal(await h.mounted.open(), false);
  assert.equal(h.calls.length, 0, 'blocked navigation starts no promotions request');
});

test('Richmond never mounts a promotions entry or sends even a lookup request', async t => {
  const h = mountedHarness(t, { profile: installationProfile('richmond', 'test') });
  assert.equal(h.mounted, null);
  assert.equal(h.document.getElementById('promotionsNavigation').hidden, true);
  assert.equal(h.document.getElementById('promotionsPanel').hidden, true);
  assert.equal(h.calls.length, 0);
});

test('lookup uses bounded suggestions, requires no instructor and does not treat an unrefreshed cached rank as current', async t => {
  const h = mountedHarness(t); await h.bootstrap(Array.from({ length: 12 }, (_, index) => student(String(index))));
  assert.equal(h.el('approverChoice').value, '');
  h.el('studentSearch').value = 'TEST Person'; h.el('studentSearch').emit('input');
  assert.equal(h.el('searchResults').children.length, 8);
  h.el('searchResults').children[0].emit('click'); await flush();
  assert.match(h.el('studentRank').textContent, /not yet verified/u);
  assert.equal(h.el('promotionActions').hidden, true);
  await h.success(h.take('readStudent'), { student: student('0'), history: [] });
  assert.match(h.el('studentRank').textContent, /White Belt.*1 stripe/u);
  assert.equal(h.el('historyDisclosure').open, false);
  assert.equal(h.el('approverChoice').value, '');
  assert.ok(h.calls.every(call => ['bootstrap', 'readStudent'].includes(call.payload.operation)));
});

test('actual typing extends lookup privacy and the mounted panel clears all personal details at expiry', async t => {
  const h = mountedHarness(t); await h.bootstrap(); await h.choose('A');
  h.tick(59_000); h.el('studentSearch').value = 'Next TEST lookup'; h.el('studentSearch').emit('input');
  h.tick(59_999); assert.equal(h.mounted.snapshot().active, true);
  h.tick(1); h.neutral();
  assert.equal(h.calls.length, 2, 'privacy expiry causes no promotion mutation');
});

test('confirmed save locks duplicate submits and returns to clean Sign-In after three seconds without Done', async t => {
  const h = mountedHarness(t); await h.bootstrap(); await h.choose('A');
  const call = await h.beginStripe();
  h.el('entryForm').emit('submit'); await flush();
  assert.equal(h.calls.filter(item => item.payload.operation === 'recordPromotion').length, 1);
  assert.equal(call.payload.approverId, 'TEST-COACH-A');
  await h.success(call, h.saved(call));
  h.tick(2_999); assert.equal(h.mounted.snapshot().active, true);
  h.tick(1); h.neutral();
  assert.equal(h.stored.size, 0, 'confirmed intent is durably retired');
});

test('Back and a late read cannot resurrect old personal details or overwrite the next instructor input', async t => {
  const h = mountedHarness(t); await h.bootstrap();
  h.el('studentSearch').value = 'TEST Person A'; h.el('studentSearch').emit('input'); h.el('searchResults').children[0].emit('click'); await flush();
  const old = h.take('readStudent');
  h.el('clearBack').emit('click'); h.neutral();
  const nextName = h.document.getElementById('nameInput'); nextName.value = 'TEST Next instructor'; nextName.focus();
  await h.success(old, { student: student('A'), history: [] });
  h.neutral(); assert.equal(nextName.value, 'TEST Next instructor'); assert.equal(h.document.activeElement, nextName);
});

test('a late pending failure after Back and reopen leaves Check save usable and ordinary Sign-In untouched', async t => {
  const h = mountedHarness(t); await h.bootstrap(); await h.choose('A'); const save = await h.beginStripe();
  const original = [...h.stored.values()][0];
  h.el('clearBack').emit('click'); h.neutral(); await h.bootstrap();
  await h.respond(save, { ok: false, error: { code: 'UNAVAILABLE', message: 'Lost confirmation', retryable: true } }, 503);
  assert.equal(h.el('checkSave').disabled, false);
  assert.equal(h.el('retrySave').disabled, false);
  assert.equal([...h.stored.values()][0], original);
  assert.equal(h.el('studentSearch').value, '');
  h.el('clearBack').emit('click'); h.neutral();
  assert.equal(h.document.getElementById('btnSignIn').disabled, false);
});

test('an old student save cannot clear the next lookup after three seconds or carry the previous instructor selection', async t => {
  const h = mountedHarness(t); await h.bootstrap(); await h.choose('A'); const save = await h.beginStripe();
  await h.choose('B'); h.el('studentSearch').value = 'TEST Person B lookup'; h.el('studentSearch').emit('input');
  await h.success(save, h.saved(save)); h.tick(3_100);
  assert.equal(h.mounted.snapshot().active, true);
  assert.equal(h.mounted.snapshot().selectedId, student('B').studentId);
  assert.equal(h.el('studentSearch').value, 'TEST Person B lookup');
  h.el('addStripe').emit('click'); assert.equal(h.el('approverChoice').value, '');
});

for (const event of ['resume', 'visibilitychange', 'pageshow', 'popstate']) {
  test(`mounted ${event} clears an expired lookup after suspended timers`, async t => {
    const h = mountedHarness(t); await h.bootstrap(); await h.choose('A');
    h.clock.now += 120_000;
    (['resume', 'visibilitychange'].includes(event) ? h.document : h.windowTarget).emit(event);
    h.neutral();
  });
}

test('every personal promotion input opts out of native Back form restoration', t => {
  const h = mountedHarness(t);
  for (const control of h.document.getElementById('promotionsPanel').querySelectorAll('input,textarea,select')) {
    assert.equal(control.getAttribute('autocomplete'), 'off', `${control.id} must not restore the previous interaction through native form history`);
  }
});

test('history distinguishes actual tablet entries from earlier records without exposing recorder identities or inventing dates', async t => {
  const h = mountedHarness(t); await h.bootstrap(); await h.choose('A');
  h.el('refreshStudent').emit('click'); await flush();
  const record = student('A', 4);
  const history = [
    { revision:1, eventKind:'REGISTER', eventDateNY:'', recorderIdentity:'SYNTHETIC FIXTURE', before:null, after:record },
    { revision:2, eventKind:'STRIPE', eventDateNY:'2026-09-12', recorderIdentity:'earlier-owner@example.invalid', before:record, after:record, approverLabel:'TEST Coach Avery' },
    { revision:3, eventKind:'STRIPE', eventDateNY:'2026-09-13', recorderIdentity:'m1-test-device-0123456789abcdef01234567', before:record, after:record, approverLabel:'TEST Coach Avery' },
    { revision:4, eventKind:'CORRECTION', eventDateNY:'2026-09-13', recorderIdentity:'m1-test-device-short', before:record, after:record, approverLabel:'TEST Coach Blake' }
  ];
  await h.success(h.take('readStudent'), { student:record, history });
  const rows = h.el('historyList').children.map(row => row.textContent);
  assert.equal(rows.filter(text => text.includes('Recorded through: Authorized TEST tablet')).length, 1);
  assert.equal(rows.filter(text => text.includes('Recorded through: Earlier log')).length, 3);
  assert.match(rows.at(-1), /Date not recorded · Student registered/u);
  assert.doesNotMatch(rows.join('\n'), /earlier-owner@example\.invalid|m1-test-device-|SYNTHETIC FIXTURE/u);
  h.el('correctLatest').emit('click');
  assert.match(h.el('previewNote').textContent, /original event and its selected instructor/u);
  assert.doesNotMatch(h.el('previewNote').textContent, /approval/u);
});

test('registration and current-rank confirmation explain identity and verified baseline instead of correction or a new award', async t => {
  const h = mountedHarness(t);
  const unknown = { ...student('A'), rankKnown:false, belt:'', marks:null, markType:'' };
  await h.bootstrap([unknown]);
  h.el('addStudent').emit('click');
  assert.equal(h.el('saveEntry').textContent, 'Confirm student identity');
  assert.match(h.el('previewNote').textContent, /separate student with an unknown rank/u);
  assert.match(h.el('previewNote').textContent, /Confirm their verified current rank next/u);
  assert.doesNotMatch(h.el('previewNote').textContent, /correction|original event/u);

  await h.choose('A', unknown);
  h.el('confirmRank').emit('click');
  assert.equal(h.el('saveEntry').textContent, 'Confirm verified rank');
  assert.match(h.el('previewNote').textContent, /Records the verified current rank today/u);
  assert.match(h.el('previewNote').textContent, /not a new promotion.*does not invent a historical date/u);
  assert.doesNotMatch(h.el('previewNote').textContent, /correction|original event/u);
  assert.equal(h.calls.filter(call => ['registerStudent','confirmRank','correctLatest'].includes(call.payload.operation)).length, 0, 'opening these previews must not write anything');
});
