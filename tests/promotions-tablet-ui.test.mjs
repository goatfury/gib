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
const liveConfig = { enabled: true, testOnly: false, target: 'live', endpoint: '/api/m1-promotions' };
const liveOrigin = 'https://gib-live.netlify.app';
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

function mountedHarness(t, { profile = installationProfile('rev'), stored = new Map(), logConfig = config, origin = liveOrigin } = {}) {
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
  const mounted = mountPromotionsLog({ document, profile, config: logConfig, origin, fetcher, storage, now: () => clock.now, windowTarget });
  const el = id => document.getElementById(id.startsWith('promotions-') ? id : `promotions-${id}`);
  const take = (operation, studentId) => {
    const call = calls.find(item => !item.taken && item.payload.operation === operation && (!studentId || item.payload.studentId === studentId));
    assert.ok(call, `Missing ${operation} request`); call.taken = true; return call;
  };
  const respond = async (call, body, status = 200) => { call.settled = true; call.resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); await flush(); };
  const success = (call, data) => respond(call, { ok: true, data });
  const bootstrap = async (students = [student('A'), student('B')], approvers = [{ id: 'TEST-COACH-A', label: 'TEST Coach Avery' }], overrides = {}) => {
    const opening = mounted.open(); await flush();
    await success(take('bootstrap'), { testOnly: true, todayNY: '2026-09-13', recorderLabel: 'Authorized TEST tablet', approvers, students, ...overrides });
    await opening;
  };
  const choose = async (id, fresh = student(id), history = []) => {
    el('studentSearch').value = fresh.displayName; el('studentSearch').emit('input');
    el('searchResults').children[0].emit('click'); await flush();
    const call = take('readStudent', fresh.studentId);
    await success(call, { student: fresh, history });
  };
  t.after(async () => {
    for (const call of calls) if (!call.settled) { call.settled = true; call.reject(new Error('Test cleanup')); }
    await flush(); mounted?.destroy();
    globalThis.M1_KIOSK_NAVIGATION = oldGuard;
  });
  return {
    document, clock, windowTarget, intervals, calls, stored, guard, mounted, el, take, respond, success, bootstrap, choose,
    tick(ms) { clock.now += ms; for (const callback of intervals.values()) callback(); },
    async beginStripe(approverName = 'TEST Coach Avery') {
      el('addStripe').emit('click'); el('approverChoice').value = approverName; el('approverChoice').emit('input');
      el('entryForm').emit('submit'); await flush(); return take('recordPromotion');
    },
    saved(call, id = 'A') {
      const after = student(id, 2, 2);
      return { student: after, viewPending: false, receipt: { requestId: call.payload.requestId, studentId: after.studentId, eventId: `evt-${id}-2`, revision: 2, eventKind: 'STRIPE', eventDateNY: '2026-09-13', before: student(id), after, approverLabel: call.payload.approverName || 'TEST Coach Avery' } };
    },
    neutral() {
      assert.equal(document.getElementById('promotionsPanel').hidden, true);
      assert.equal(document.body.classList.contains('promotions-view'), false);
      for (const id of ['studentSearch', 'approverChoice', 'entryReason', 'newName', 'newIdentity', 'newHistoryNote']) assert.equal(el(id).value, '');
      for (const id of ['studentName', 'studentIdentity', 'studentRank', 'studentDate', 'legacyNotes', 'historyList', 'message']) assert.equal(el(id).textContent, '');
      assert.equal(el('approverSuggestions').hidden, true);
      assert.equal(el('approverSuggestions').children.length, 0);
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
  assert.equal(call.payload.approverName, 'TEST Coach Avery');
  assert.equal(Object.hasOwn(call.payload, 'approverId'), false);
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

test('instructor suggestions appear only after typing and remain optional free-text attribution', async t => {
  const h = mountedHarness(t);
  const approvers = Array.from({ length: 10 }, (_, index) => ({ id: `legacy-coach-${index}`, label: `TEST Coach ${index}` }));
  await h.bootstrap(undefined, approvers); await h.choose('A'); h.el('addStripe').emit('click');
  const input = h.el('approverChoice'); const suggestions = h.el('approverSuggestions');
  assert.equal(input.value, '');
  assert.equal(suggestions.hidden, true);
  assert.equal(suggestions.children.length, 0, 'opening an entry must not offer or select a previous instructor');
  input.value = 'TEST Coach'; input.emit('input');
  assert.equal(suggestions.hidden, false, 'suggestions are visible application controls, independent of native browser popups');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.ok(suggestions.children.length > 0 && suggestions.children.length <= 4, 'typing offers a bounded set of suggestions');
  assert.equal(input.value, 'TEST Coach', 'a matching prefix must not automatically become an instructor selection');
  assert.ok(suggestions.children.every(option => option.getAttribute('aria-selected') !== 'true'));
  const suggestion = suggestions.children[0];
  const staleOtherSuggestion = suggestions.children[1];
  const suggestedName = suggestion.textContent;
  assert.ok(approvers.some(approver => approver.label === suggestedName));
  assert.equal(suggestion.type, 'button');
  input.focus();
  let pointerDefaultPrevented = false;
  suggestion.emit('pointerdown', { preventDefault() { pointerDefaultPrevented = true; } });
  assert.equal(pointerDefaultPrevented, true, 'pointer selection keeps input focus until the click completes');
  assert.equal(h.document.activeElement, input);
  suggestion.emit('click');
  assert.equal(input.value, suggestedName);
  assert.equal(h.el('previewApprover').textContent, suggestedName);
  assert.equal(suggestions.hidden, true);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, input);
  assert.ok(h.calls.every(call => ['bootstrap', 'readStudent'].includes(call.payload.operation)), 'choosing a name must not save');
  h.el('entryForm').emit('submit'); await flush();
  const save = h.take('recordPromotion');
  assert.equal(save.payload.approverName, suggestedName);
  assert.equal(Object.hasOwn(save.payload, 'approverId'), false, 'suggestions cannot reinstate a roster-ID requirement');
  staleOtherSuggestion.emit('click');
  assert.equal(input.value, suggestedName, 'a stale suggestion cannot alter the attribution while its exact request is pending');
  assert.equal(h.mounted.lifecycle.pending().approverName, suggestedName);
  assert.equal(suggestions.hidden, true);
});

test('visible instructor suggestions support explicit keyboard selection and Escape without submitting the form', async t => {
  const h = mountedHarness(t);
  await h.bootstrap(undefined, ['Avery', 'Blake', 'Casey'].map(name => ({ id: `old-${name}`, label: `TEST Coach ${name}` })));
  await h.choose('A'); h.el('addStripe').emit('click');
  const input = h.el('approverChoice'); const suggestions = h.el('approverSuggestions');
  const key = value => {
    let prevented = false;
    input.emit('keydown', { key: value, preventDefault() { prevented = true; } });
    return prevented;
  };
  input.value = 'TEST Coach'; input.emit('input');
  assert.equal(key('Enter'), true, 'Enter in the instructor field cannot implicitly submit a promotion');
  assert.equal(input.value, 'TEST Coach', 'Enter without a highlighted choice preserves freely typed text');
  assert.equal(key('ArrowDown'), true);
  assert.equal(suggestions.children[0].getAttribute('aria-selected'), 'true');
  assert.equal(input.getAttribute('aria-activedescendant'), suggestions.children[0].id);
  assert.equal(input.value, 'TEST Coach', 'highlighting does not silently select a name');
  key('ArrowDown'); assert.equal(suggestions.children[1].getAttribute('aria-selected'), 'true');
  key('ArrowUp'); assert.equal(suggestions.children[0].getAttribute('aria-selected'), 'true');
  assert.equal(key('Enter'), true);
  assert.equal(input.value, 'TEST Coach Avery');
  assert.equal(h.el('previewApprover').textContent, 'TEST Coach Avery');
  assert.equal(suggestions.hidden, true);
  input.value = 'TEST Coach'; input.emit('input'); key('ArrowUp');
  assert.equal(suggestions.children.at(-1).getAttribute('aria-selected'), 'true', 'Arrow Up from no highlight selects the last matching name');
  key('Escape');
  assert.equal(input.value, 'TEST Coach');
  assert.equal(suggestions.hidden, true);
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  input.value = 'Unlisted Instructor'; input.emit('input');
  assert.equal(suggestions.hidden, true);
  assert.equal(key('Enter'), true);
  assert.equal(input.value, 'Unlisted Instructor');
  assert.ok(h.calls.every(call => ['bootstrap', 'readStudent'].includes(call.payload.operation)));
  h.el('entryForm').emit('submit'); await flush();
  assert.equal(h.take('recordPromotion').payload.approverName, 'Unlisted Instructor');
});

test('an unlisted typed instructor works without a suggestion roster and preserves the name in preview, request and history', async t => {
  const h = mountedHarness(t); await h.bootstrap(undefined, []); await h.choose('A');
  const name = "Élodie  O'Neil-佐藤";
  const save = await h.beginStripe(`  ${name}  `);
  assert.equal(h.el('previewApprover').textContent, name);
  assert.equal(save.payload.approverName, name, 'only outside whitespace may be trimmed');
  assert.equal(Object.hasOwn(save.payload, 'approverId'), false);
  assert.equal(h.el('approverSuggestions').children.length, 0);
  await h.success(save, h.saved(save));
  assert.ok(h.el('historyList').textContent.includes(`Promoted by: ${name}`));
  h.tick(3_000); h.neutral();
});

for (const action of ['stripe', 'belt', 'confirm', 'correct', 'register']) {
  test(`${action} rejects a blank typed instructor without blocking read-only student lookup`, async t => {
    const h = mountedHarness(t);
    const record = action === 'confirm' ? { ...student('A'), rankKnown: false, belt: '', marks: null, markType: '' } : student('A');
    await h.bootstrap([record], []);
    await h.choose('A', record, [{ eventId: 'evt-existing', revision: 1, eventKind: 'STRIPE', before: record, after: record, approverId: 'TEST-COACH-A', approverLabel: 'TEST Coach Avery' }]);
    assert.equal(h.mounted.snapshot().selectedFresh, true, 'lookup needs no Promoted by value');
    h.el({ stripe: 'addStripe', belt: 'changeBelt', confirm: 'confirmRank', correct: 'correctLatest', register: 'addStudent' }[action]).emit('click');
    h.el('newName').value = 'TEST New Student'; h.el('newIdentity').value = 'Distinct group';
    h.el('beltChoice').value = action === 'belt' ? 'Blue Belt' : 'White Belt'; h.el('marksChoice').value = '0';
    h.el('entryReason').value = 'Verified with the instructor';
    h.el('approverChoice').value = '   '; h.el('entryForm').emit('input');
    h.el('entryForm').emit('submit'); await flush();
    assert.equal(h.el('formError').hidden, false);
    assert.match(h.el('formError').textContent, /instructor.*name|name.*instructor/iu);
    assert.ok(h.calls.every(call => ['bootstrap', 'readStudent'].includes(call.payload.operation)), 'blank attribution cannot dispatch a mutation');
    assert.equal(h.stored.size, 0, 'an invalid draft does not become a pending transaction');
  });
}

test('typed pending attribution survives Clear and a fresh mount, then retries the exact original request', async t => {
  const stored = new Map(); const first = mountedHarness(t, { stored });
  await first.bootstrap(); await first.choose('A');
  const original = await first.beginStripe("TEST Renée  D'Angelo-Sato");
  await first.respond(original, { ok: false, error: { code: 'UNAVAILABLE', message: 'Confirmation unavailable', retryable: true } }, 503);
  const originalRaw = [...stored.values()][0];
  first.el('clearBack').emit('click'); first.neutral();
  assert.equal([...stored.values()][0], originalRaw);
  const reopened = mountedHarness(t, { stored });
  await reopened.bootstrap(undefined, [{ id: 'different-coach', label: 'TEST A Different Instructor' }]);
  assert.equal(reopened.el('approverChoice').value, '', 'recovery must not prefill the previous instructor into a new form');
  reopened.el('checkSave').emit('click'); await flush();
  const check = reopened.take('checkSave');
  assert.deepEqual(check.payload, { operation: 'checkSave', requestId: original.payload.requestId });
  await reopened.success(check, { status: 'not_found' });
  reopened.el('retrySave').emit('click'); await flush();
  const retry = reopened.take('recordPromotion');
  assert.deepEqual(retry.payload, original.payload);
  assert.equal([...stored.values()][0], originalRaw, 'retrying cannot rewrite its recorded attribution');
  await reopened.success(retry, reopened.saved(retry)); reopened.tick(3_000); reopened.neutral();
  assert.equal(stored.size, 0);
});

test('a legacy pending instructor-ID request remains exact after the free-text field ships', async t => {
  const intent = { operation: 'recordPromotion', requestId: 'legacy-pending-attribution', studentId: student('A').studentId, expectedRevision: 1, action: 'stripe', approverId: 'TEST-COACH-A' };
  const stored = new Map([['gib_m1_promotions_pending_v1', JSON.stringify({ version: 1, intent })]]);
  const h = mountedHarness(t, { stored }); await h.bootstrap(undefined, []);
  assert.equal(h.el('approverChoice').value, '');
  h.el('retrySave').emit('click'); await flush();
  const retry = h.take('recordPromotion');
  assert.deepEqual(retry.payload, intent);
  assert.equal(Object.hasOwn(retry.payload, 'approverName'), false, 'recovery cannot translate or augment a legacy fingerprint');
  await h.success(retry, h.saved(retry)); h.tick(3_000); h.neutral();
  assert.equal(stored.size, 0);
});

test('opening another entry or lookup starts with blank instructor attribution and privacy clearing removes suggestions too', async t => {
  const h = mountedHarness(t); await h.bootstrap(); await h.choose('A'); h.el('addStripe').emit('click');
  h.el('approverChoice').value = 'TEST Coach Avery'; h.el('approverChoice').emit('input');
  h.el('closeEditor').emit('click'); h.el('addStripe').emit('click');
  assert.equal(h.el('approverChoice').value, '', 'reopening an entry requires fresh attribution');
  h.el('approverChoice').value = 'TEST Previous Instructor'; h.el('approverChoice').emit('input');
  await h.choose('B'); h.el('addStripe').emit('click');
  assert.equal(h.el('approverChoice').value, '', 'a different student does not inherit the prior instructor');
  h.el('approverChoice').value = 'TEST Coach'; h.el('approverChoice').emit('input');
  assert.ok(h.el('approverSuggestions').children.length > 0);
  h.tick(60_000); h.neutral();
  assert.equal(h.el('approverSuggestions').children.length, 0);
  await h.bootstrap(); await h.choose('A'); h.el('addStripe').emit('click');
  assert.equal(h.el('approverChoice').value, '');
  assert.equal(h.el('approverSuggestions').children.length, 0);
});

for (const origin of [
  'https://deploy-preview-88--gib-live.netlify.app',
  'https://0123456789abcdef01234567--gib-live.netlify.app',
  'http://gib-live.netlify.app',
  'https://gib-richmond-live.netlify.app',
  'https://gib-live.netlify.app.example.invalid',
  ''
]) {
  test(`live mounted log refuses origin ${origin || '(missing)' } without rendering or requesting records`, t => {
    const h = mountedHarness(t, { logConfig: liveConfig, origin });
    assert.equal(h.mounted, null);
    assert.equal(h.document.getElementById('promotionsNavigation').hidden, true);
    assert.equal(h.document.getElementById('promotionsPanel').hidden, true);
    assert.equal(h.document.getElementById('promotionsPanel').children.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.stored.size, 0);
  });
}

for (const [name, logConfig, reply] of [
  ['TEST UI with live bootstrap', config, { testOnly: false, target: 'live' }],
  ['live UI with TEST bootstrap', liveConfig, { testOnly: true, target: 'test' }],
  ['TEST UI with mismatched optional target', config, { testOnly: true, target: 'live' }],
  ['live UI with mismatched optional target', liveConfig, { testOnly: false, target: 'test' }]
]) {
  test(`${name} fails before any roster or recorder details are exposed`, async t => {
    const h = mountedHarness(t, { logConfig });
    const rejectedStudent = { ...student('wrong-target'), displayName: 'Fictional Wrong-Destination Person' };
    await h.bootstrap([rejectedStudent], [], { ...reply, recorderLabel: 'Fictional wrong-destination recorder' });
    assert.equal(h.el('app').hidden, true);
    assert.equal(h.el('recorder').hidden, true);
    assert.equal(h.el('accessStatus').hidden, false);
    assert.equal(h.el('retryAccess').hidden, false);
    h.el('studentSearch').value = rejectedStudent.displayName;
    h.el('studentSearch').emit('input');
    assert.equal(h.el('searchResults').children.length, 0);
    assert.equal(h.mounted.snapshot().selectedId, null);
    assert.doesNotMatch(h.document.getElementById('promotionsPanel').textContent, /Fictional Wrong-Destination Person|Fictional wrong-destination recorder/u);
    assert.deepEqual(h.calls.map(call => call.payload.operation), ['bootstrap']);
    assert.equal(h.stored.size, 0);
  });
}

test('live mounted labels use generic tablet provenance without TEST chrome or private recorder identities', async t => {
  const h = mountedHarness(t, { logConfig: liveConfig });
  const record = { ...student('A', 3), displayName: 'Fictional Avery Rowan' };
  await h.bootstrap([record], [], { testOnly: false, target: 'live', recorderLabel: '' });
  assert.equal(h.el('app').hidden, false);
  assert.equal(h.el('recorder').textContent, 'Access: Authorized Revolution tablet');
  assert.ok(h.el('modeBadge'), 'the mode badge remains a shared template hook');
  assert.doesNotMatch(h.el('modeBadge').textContent, /TEST/u);
  assert.ok(h.el('privacyNote'), 'the privacy note remains a shared template hook');
  assert.doesNotMatch(h.el('privacyNote').textContent, /TEST data only/u);
  assert.match(h.el('privacyNote').textContent, /60 seconds.*3 seconds/u);
  const liveDevice = 'm1-live-device-0123456789abcdef01234567';
  const testDevice = 'm1-test-device-89abcdef0123456701234567';
  const earlierIdentity = 'earlier-owner@example.invalid';
  const history = [liveDevice, testDevice, earlierIdentity].map((recorderIdentity, index) => ({
    eventId: `fictional-provenance-${index}`, revision: index + 1, eventKind: 'STRIPE',
    eventDateNY: '2026-09-13', recorderIdentity, before: record, after: record, approverLabel: 'Fictional Coach Rowan'
  }));
  await h.choose('A', record, history);
  const rows = h.el('historyList').children.map(row => row.textContent);
  assert.equal(rows.filter(text => text.includes('Recorded through: Authorized Revolution tablet')).length, 1);
  assert.equal(rows.filter(text => text.includes('Recorded through: Authorized TEST tablet')).length, 1);
  assert.equal(rows.filter(text => text.includes('Recorded through: Earlier log')).length, 1);
  assert.doesNotMatch(h.document.getElementById('promotionsPanel').textContent, /m1-live-device-|m1-test-device-|earlier-owner@example\.invalid/u);
  assert.deepEqual(h.calls.map(call => call.payload.operation), ['bootstrap', 'readStudent']);
});

test('matched live mounted lookup and typed promotion preserve the existing confirmation and three-second clearing flow', async t => {
  const h = mountedHarness(t, { logConfig: liveConfig });
  const record = { ...student('A'), displayName: 'Fictional Avery Rowan' };
  // target is optional; matching testOnly is still mandatory.
  await h.bootstrap([record], [], { testOnly: false, recorderLabel: '' });
  await h.choose('A', record);
  assert.equal(h.mounted.snapshot().selectedFresh, true);
  assert.equal(h.el('studentName').textContent, record.displayName);
  assert.equal(h.el('approverChoice').value, '');
  const save = await h.beginStripe('Fictional Coach Rowan');
  assert.equal(save.url, '/api/m1-promotions');
  assert.equal(save.payload.studentId, record.studentId);
  assert.equal(save.payload.expectedRevision, 1);
  assert.equal(save.payload.action, 'stripe');
  assert.equal(save.payload.approverName, 'Fictional Coach Rowan');
  assert.equal(Object.hasOwn(save.payload, 'approverId'), false);
  assert.deepEqual(JSON.parse(h.stored.get('gib_m1_promotions_pending_v1')), { version: 1, intent: save.payload });
  h.el('entryForm').emit('submit'); await flush();
  assert.equal(h.calls.filter(call => call.payload.operation === 'recordPromotion').length, 1);
  const after = { ...record, marks: 2, revision: 2 };
  const saved = h.saved(save);
  await h.success(save, { ...saved, student: after, receipt: { ...saved.receipt, before: record, after, recorderIdentity: 'm1-live-device-0123456789abcdef01234567' } });
  assert.match(h.el('studentRank').textContent, /White Belt.*2 stripes/u);
  assert.match(h.el('historyList').textContent, /Promoted by: Fictional Coach Rowan.*Recorded through: Authorized Revolution tablet/u);
  assert.equal(h.stored.size, 0);
  h.tick(2_999); assert.equal(h.mounted.snapshot().active, true);
  h.tick(1); h.neutral();
  assert.deepEqual(h.calls.map(call => call.payload.operation), ['bootstrap', 'readStudent', 'recordPromotion']);
});

for (const [name, attribution] of [
  ['legacy synthetic instructor ID', { approverId: 'TEST-COACH-A' }],
  ['live typed instructor', { approverName: "Fictional Renée  D'Angelo-Sato" }]
]) {
  test(`live mounted recovery preserves ${name} in the unchanged pending key and exact retry payload`, async t => {
    const intent = { operation: 'recordPromotion', requestId: `pending-${name.replaceAll(' ', '-')}`, studentId: student('A').studentId, expectedRevision: 1, action: 'stripe', ...attribution };
    const raw = JSON.stringify({ version: 1, intent });
    const stored = new Map([['gib_m1_promotions_pending_v1', raw]]);
    const h = mountedHarness(t, { stored, logConfig: liveConfig });
    await h.bootstrap([], [], { testOnly: false, target: 'live', recorderLabel: '' });
    assert.equal(h.el('approverChoice').value, '');
    assert.deepEqual(h.calls.map(call => call.payload.operation), ['bootstrap'], 'opening recovery cannot dispatch a mutation');
    assert.equal(stored.get('gib_m1_promotions_pending_v1'), raw);
    h.el('checkSave').emit('click'); await flush();
    const check = h.take('checkSave');
    assert.deepEqual(check.payload, { operation: 'checkSave', requestId: intent.requestId });
    await h.success(check, { status: 'not_found' });
    h.el('retrySave').emit('click'); await flush();
    const retry = h.take('recordPromotion');
    assert.deepEqual(retry.payload, intent);
    await h.respond(retry, { ok: false, error: { code: 'UNAVAILABLE', message: 'Fictional dropped confirmation', retryable: true } }, 503);
    assert.equal(stored.get('gib_m1_promotions_pending_v1'), raw);
    assert.equal(stored.size, 1, 'live mode cannot move or rewrite the durable pending entry');
    h.el('clearBack').emit('click'); h.neutral();
    assert.equal(stored.get('gib_m1_promotions_pending_v1'), raw);
  });
}
