import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const result = (count, target = 'test') => ({ ok: true, test: target === 'test', target, pendingDays: count, period: { start: '2026-09-21', end: '2026-10-04' }, cleanupStart: '2026-09-07', days: [{ date: '2026-09-21', period: { start: '2026-09-21', end: '2026-10-04' }, complete: false, classes: [], blockers: [] }] });
const additionReview = (original, receipt) => {
  const view = { ...result(2), gym: 'rev', site: 'Rev' };
  Object.assign(view.days[0], { date: original.date, warnings: [], revision: 1, changed: true,
    classes: [{ label: original.classLabel, records: [{ ...original, recordId: receipt.linkedRecordId,
      displayId: receipt.linkedDisplayId, source: 'Admin-added', reviewRequired: false,
      notes: `Admin-added | Admin: ${receipt.confirmation?.adminName} | Reason: ${original.reason}${original.notes ? ` | Notes: ${original.notes}` : ''}` }] }] });
  return view;
};
function manager(target = 'test', options = {}) {
  const made = [], calls = [], nodes = new Map();
  class Element {
    constructor(tag) { this.tag = tag; this.events = {}; this.children = []; this.open = false; this.attributes = {}; this.html = ''; }
    set innerHTML(value) { this.html = value; this.children = []; }
    get innerHTML() { return this.html; }
    setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener(k, fn) { this.events[k] = fn; }
    append(node) { this.children.push(node); }
    prepend(node) { this.children.unshift(node); }
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element(selector)); return nodes.get(selector); }
    querySelectorAll() { return []; }
    replaceChildren() { this.innerHTML = ''; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.removed = true; }
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolled = true; }
  }
  const bodyClasses = new Set(), legacyCalls = [];
  const legacySection = new Element('section');
  const document = { createElement: tag => { const n = new Element(tag); made.push(n); return n; }, getElementById: id => id === 'reviewSection' ? legacySection : new Element('parent'), body: { classList: { add: name => bodyClasses.add(name), remove: name => bodyClasses.delete(name) } } };
  let unauthorized = 0;
  const remembered = new Map(), additionDates = [];
  const ctx = vm.createContext({ document, Date, console, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, FormData: class { constructor(form) { return Object.entries(form.fields); } }, sessionStorage: { getItem: key => remembered.get(key) || null, setItem: (key, value) => remembered.set(key, value), removeItem: key => remembered.delete(key) }, M1_MANAGER_REVIEW_CONFIG: { enabled: true, target } });
  vm.runInContext(source('m1/admin/manager-review.js'), ctx);
  const ui = ctx.GIBM1ManagerReview.create({ request: (...args) => { const d = deferred(); calls.push({ ...d, args }); return d.promise; }, site: 'Rev', onUnauthorized: () => unauthorized++, openLegacy: date => { legacyCalls.push(date); return options.legacyResult ?? true; }, additionRequestId: date => { additionDates.push(date); return `m1-${date}-${'a'.repeat(24)}`; }, ...options });
  const root = made[0];
  return { ui, calls, made, nodes, root, bodyClasses, legacyCalls, legacySection, remembered, additionDates, unauthorized: () => unauthorized, click: (action, detail = {}) => root.events.click({ target: { closest: () => ({ dataset: { action, ...detail } }) } }) };
}

test('first-load and refresh failures leave independent Daily Review reachable without claiming completion', async () => {
  for (const initial of [true, false]) {
    const h = manager('test', { legacyResult: false }), open = h.ui.open();
    if (initial) { h.calls[0].reject(new Error('offline')); await open; }
    else { h.calls[0].resolve(result(2)); await open; const read = h.ui.refresh(); h.calls[1].reject(new Error('offline')); await read; }
    assert.match(initial ? h.root.innerHTML : h.nodes.get('.manager-summary strong').textContent, /Review status unavailable/);
    const controls = initial ? h.root.innerHTML : h.nodes.get('.manager-summary').children[0].innerHTML;
    assert.match(controls, /data-action="legacy"\s*>Existing Daily Review tools/);
    h.click('legacy'); await flush();
    assert.deepEqual(h.legacyCalls, [initial ? '' : '2026-09-21']);
    assert.equal(h.bodyClasses.has('manager-legacy-open'), true);
    assert.match(h.nodes.get('.manager-status').textContent, /Neither review could load fresh records.*Unfinished days still need review/);
    assert.equal(h.legacySection.focused, true);
    const read = h.ui.refresh(); h.calls.at(-1).resolve(result(2)); await read;
    assert.match(h.root.innerHTML, /2 days need/);
  }
});

test('an unresolved Daily Review addition survives failed manager reads and retries only its original request', async () => {
  const original = { requestId: 'original-daily-save', date: '2026-09-21', instructor: 'QA TEST Original', classLabel: '9:00 AM BJJ', duration: 1, reason: 'Forgotten sign-in' };
  const h = manager('test', { validateAdditionResult: r => r.confirmedOriginal === true });
  const open = h.ui.open(); h.calls[0].reject(new Error('offline')); await open;
  h.click('legacy'); await flush();
  assert.equal(h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', original), true);
  assert.equal(h.ui.hasPendingSave(), true);
  assert.equal(h.bodyClasses.has('manager-legacy-open'), false);
  h.click('legacy'); h.click('retry'); assert.equal(h.calls.length, 1);
  h.ui.finishExternalSave({ ...original, requestId: 'wrong' }, true);
  assert.equal(h.ui.hasPendingSave(), true);
  h.ui.finishExternalSave(original, false);
  h.ui.clear(); const reopened = h.ui.open(); h.calls[1].reject(new Error('offline')); await reopened;
  assert.match(h.root.innerHTML, /Check original save/);
  h.click('legacy'); assert.equal(h.legacyCalls.length, 1);
  h.click('retry'); assert.deepEqual(JSON.parse(JSON.stringify(h.calls[2].args[1])), original);
  assert.equal(h.calls[2].args[0], '/api/m1-admin-add-check');
  h.calls[2].resolve({ ok: true, linkedRecordId: 'incomplete-receipt' }); await flush();
  assert.equal(h.ui.hasPendingSave(), true);
  const read = h.ui.refresh(); h.calls[3].resolve(result(2)); await read;
  assert.equal(h.ui.hasPendingSave(), true, 'check:null read cannot reconcile the save');
  h.click('retry'); assert.deepEqual(JSON.parse(JSON.stringify(h.calls[4].args[1])), original);
  const receipt = { ok: true, test: true, linkedRecordId: 'authoritative-original-id', linkedDisplayId: 'sheet-row-79', confirmedOriginal: true, confirmation: { adminName: 'Stuart Turner' } };
  h.calls[4].resolve(receipt); await flush();
  assert.equal(h.ui.hasPendingSave(), true, 'receipt alone must not unlock editing');
  h.calls[5].resolve(additionReview(original, receipt)); await flush();
  assert.equal(h.ui.hasPendingSave(), false);
  assert.equal(h.remembered.has('m1-manager-pending-v1'), false);
  h.click('legacy'); await flush(); assert.equal(h.legacyCalls.length, 2);
});

test('read-only original-save checks keep failures and changed review evidence pending across reopening', async () => {
  const original = { requestId: 'm1-2026-09-21-' + 'a'.repeat(24), date: '2026-09-21', instructor: 'QA TEST Original', classLabel: '9:00 AM BJJ', duration: 1, site: 'Rev', reason: 'Forgotten sign-in' };
  const receipt = { ok: true, test: true, linkedRecordId: 'gib-admin-' + original.requestId, linkedDisplayId: 'sheet-row-79', confirmedOriginal: true, confirmation: { adminName: 'Stuart Turner' } };
  for (const failure of ['missing', 'conflict', 'incomplete', 'manager-read', 'warning', 'duplicate', 'mismatch', 'notes', 'false-complete', 'other-gym']) {
    const h = manager('test', { validateAdditionResult: r => r.confirmedOriginal === true });
    const opened = h.ui.open(); h.calls[0].resolve(result(2)); await opened;
    h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', original); h.ui.finishExternalSave(original, false);
    h.ui.clear(); const reopened = h.ui.open(); h.calls[1].resolve(result(2)); await reopened;
    h.click('retry');
    assert.equal(h.calls[2].args[0], '/api/m1-admin-add-check');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[2].args[1])), original);
    if (failure === 'missing' || failure === 'conflict') h.calls[2].reject(Object.assign(new Error('Original save not confirmed'), { status: failure === 'conflict' ? 409 : 503 }));
    else if (failure === 'incomplete') h.calls[2].resolve({ ok: true, test: true, linkedRecordId: receipt.linkedRecordId });
    else {
      h.calls[2].resolve(receipt); await flush();
      assert.equal(h.ui.hasPendingSave(), true);
      h.click('legacy'); assert.equal(h.legacyCalls.length, 0);
      if (failure === 'manager-read') h.calls[3].reject(new Error('No fresh central read'));
      else {
        const view = additionReview(original, receipt), day = view.days[0];
        if (failure === 'warning') day.warnings.push({ code: 'RECORD_ID_CONFLICT' });
        if (failure === 'duplicate') day.classes[0].records.push({ ...day.classes[0].records[0] });
        if (failure === 'mismatch') day.classes[0].records[0].duration = 2;
        if (failure === 'notes') day.classes[0].records[0].notes += ' changed after receipt read';
        if (failure === 'false-complete') day.complete = true;
        if (failure === 'other-gym') view.gym = 'richmond';
        h.calls[3].resolve(view);
      }
    }
    await flush();
    assert.equal(h.ui.hasPendingSave(), true, failure);
    assert.deepEqual(JSON.parse(h.remembered.get('m1-manager-pending-v1')).body, original);
    assert.equal(h.calls.some(call => /m1-admin-add$/.test(call.args[0])), false, 'recovery never resends a write');
    h.click('legacy'); assert.equal(h.legacyCalls.length, 0);
    h.ui.clear(); const again = h.ui.open(); h.calls.at(-1).resolve(result(2)); await again;
    assert.equal(h.ui.hasPendingSave(), true, 'ordinary reload/read never clears the original');
  }
});

test('logout and reopening at either recovery await preserve the original and release the old busy guard', async () => {
  for (const boundary of ['receipt', 'review']) {
    const original = { requestId: 'original', date: '2026-09-21', reason: 'Missed sign-in' };
    const receipt = { ok: true, test: true, confirmedOriginal: true, confirmation: { adminName: 'Stuart Turner' } };
    const h = manager('test', { validateAdditionResult: r => r.confirmedOriginal === true });
    const open = h.ui.open(); h.calls[0].resolve(result(2)); await open;
    h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', original); h.ui.finishExternalSave(original, false);
    h.click('retry');
    if (boundary === 'review') { h.calls[1].resolve(receipt); await flush(); }
    const old = h.calls.at(-1);
    h.ui.clear(); const reopened = h.ui.open(); h.calls.at(-1).resolve(result(2)); await reopened;
    old.resolve(boundary === 'receipt' ? receipt : additionReview(original, receipt)); await flush();
    assert.equal(h.ui.hasPendingSave(), true);
    assert.match(h.root.innerHTML, /Check original save/);
    const count = h.calls.length;
    h.click('retry'); assert.equal(h.calls.length, count + 1, 'old in-flight request cannot strand a reopened session');
    assert.equal(h.calls.at(-1).args[0], '/api/m1-admin-add-check');
    assert.equal(h.calls.filter(c => c.args[0] === '/api/m1-manager-review').length, boundary === 'receipt' ? 2 : 3, 'old receipt cannot dispatch an extra read into a new session');
  }
});

test('Richmond TEST and production keep their existing original-save path', async () => {
  for (const [target, site] of [['test', 'Richmond'], ['production', 'Rev']]) {
    const h = manager(target, { site });
    const opened = h.ui.open(); h.calls[0].resolve(result(2, target)); await opened;
    const original = { requestId: 'original', date: '2026-09-21' };
    h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', original); h.ui.finishExternalSave(original, false);
    h.click('retry'); assert.equal(h.calls[1].args[0], '/.netlify/functions/m1-admin-add');
    h.calls[1].reject(Object.assign(new Error('Unknown addition'), { status: 409 })); await flush();
    assert.equal(h.ui.hasPendingSave(), true, 'addition conflicts cannot clear the save journal');
  }
});

test('only an explicit original retry resends a retained addition, once, with unchanged identity', async () => {
  const h = manager('test', { validateAdditionResult: r => r.confirmedOriginal === true });
  const opened = h.ui.open(); h.calls[0].resolve(result(2)); await opened;
  const original = { requestId: 'original-unchanged', date: '2026-09-21', instructor: 'QA TEST Offline' };
  h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', original); h.ui.finishExternalSave(original, false);
  h.click('retry'); h.calls[1].reject(Object.assign(new Error('No complete original evidence'), { status: 409 })); await flush();
  assert.equal(h.calls.some(c => /m1-admin-add$/.test(c.args[0])), false);
  h.click('retry-original'); h.click('retry-original'); h.click('retry');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].args[0], '/.netlify/functions/m1-admin-add');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[2].args[1])), original);
  h.calls[2].resolve({ ok: true, linkedRecordId: 'insufficient' }); await flush();
  assert.equal(h.ui.hasPendingSave(), true);
  assert.deepEqual(JSON.parse(h.remembered.get('m1-manager-pending-v1')).body, original);
});

test('existing legacy removal or in-flight save blocks new manager writes but not read recovery', async () => {
  const h = manager('test', { legacyWritePending: () => true }), open = h.ui.open();
  h.calls[0].resolve(result(2)); await open;
  h.click('partial'); h.click('unlisted'); assert.equal(h.calls.length, 1);
  assert.equal(h.made.some(n => n.tag === 'dialog'), false);
  const read = h.ui.refresh(); h.calls[1].resolve(result(2)); await read;
  assert.equal(h.calls.length, 2);
});
test('manager view fails closed on a response from the other environment or missing target', async () => {
  for (const target of ['test', 'production']) for (const mismatch of [undefined, target === 'test' ? 'production' : 'test']) {
    const h = manager(target), open = h.ui.open();
    h.calls[0].resolve({ ...result(0, target), target: mismatch }); await open;
    assert.match(h.root.innerHTML, /Review status unavailable/);
    assert.doesNotMatch(h.root.innerHTML, /0 days need/);
  }
  assert.equal(manager('disabled').ui, null);
});
test('production correction opens existing Daily Review for the exact day without a removal request', async () => {
  const h = manager('production'), open = h.ui.open();
  const view = result(1, 'production');
  view.days[0].classes = [{ label: '9:00 AM BJJ', records: [{ recordId: 'original-id', instructor: 'Existing Instructor', duration: 1, correctable: true }] }];
  h.calls[0].resolve(view); await open;
  assert.match(h.root.innerHTML, /Open correction tools/);
  assert.doesNotMatch(h.root.innerHTML, /· TEST/);
  h.click('correct', { class: '0', record: '0' });
  await flush();
  assert.deepEqual(h.legacyCalls, ['2026-09-21']);
  assert.equal(h.bodyClasses.has('manager-legacy-open'), true);
  assert.equal(h.legacySection.focused, true);
  assert.equal(h.legacySection.scrolled, true);
  assert.equal(h.legacySection.attributes.tabindex, '-1');
  assert.equal(h.calls.length, 1);
  assert.equal(h.made.some(node => node.tag === 'dialog'), false);
  h.click('unlisted');
  assert.match(h.made.find(node => node.tag === 'dialog').innerHTML, /Instructor name/);
  assert.doesNotMatch(h.made.find(node => node.tag === 'dialog').innerHTML, /TEST|fake/);
});
test('a closed manager session cannot move focus when correction tools finish loading', async () => {
  const h = manager('production'), open = h.ui.open();
  h.calls[0].resolve(result(1, 'production')); await open;
  h.click('correct'); h.ui.clear(); await flush();
  assert.equal(h.legacySection.focused, undefined);
  assert.equal(h.legacySection.scrolled, undefined);
});
test('production additions reuse existing correction-compatible IDs and retry the same original ID', async () => {
  for (const target of ['production', 'test']) {
    const h = manager(target), open = h.ui.open();
    h.calls[0].resolve(result(1, target)); await open;
    h.click('unlisted');
    h.nodes.get('form').events.submit({ preventDefault() {}, target: { fields: { instructor: target === 'test' ? 'QA TEST Instructor' : 'Existing Instructor', classLabel: '9:00 AM BJJ', duration: '1', reason: 'Forgotten instructor' } } });
    assert.equal(h.calls[1].args[0], '/.netlify/functions/m1-admin-add');
    const id = h.calls[1].args[1].requestId;
    assert.equal(id, target === 'test' ? 'manager-add-00000000-0000-4000-8000-000000000001' : `m1-2026-09-21-${'a'.repeat(24)}`);
    assert.deepEqual(h.additionDates, target === 'test' ? [] : ['2026-09-21']);
    h.calls[1].reject(new Error('Response unavailable')); await flush();
    assert.equal(JSON.parse(h.remembered.get('m1-manager-pending-v1')).body.requestId, id);
    h.click('retry');
    assert.equal(h.calls[2].args[1].requestId, id);
    assert.deepEqual(h.calls[2].args[1], h.calls[1].args[1]);
  }
  const html = source('m1/admin/index.html');
  assert.match(html, /additionRequestId: uniqueRequestId/);
});
test('manager coalesces reads, ignores an old session response, and loads the reopened session once', async () => {
  const h = manager();
  const open = h.ui.open(); void h.ui.refresh(); void h.ui.refresh();
  assert.equal(h.calls.length, 1);
  h.ui.clear(); void h.ui.open(); assert.equal(h.calls.length, 1);
  h.calls[0].reject(Object.assign(new Error('old session'), { status: 401 }));
  await open; await flush();
  assert.equal(h.unauthorized(), 0); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(result(2)); await flush();
  assert.match(h.root.innerHTML, /2 days need/);
});
test('failed refresh cannot leave a zero-day all-clear or export stale data', async () => {
  const h = manager(); const open = h.ui.open(); h.calls[0].resolve(result(0)); await open;
  const refresh = h.ui.refresh(); h.calls[1].reject(new Error('transport')); await refresh;
  assert.equal(h.nodes.get('.manager-summary strong').textContent, 'Review status unavailable');
  assert.match(h.nodes.get('.manager-status').textContent, /unavailable/);
  h.click('export'); assert.equal(h.calls.length, 2);
});
test('refresh preserves an unfinished instructor form and Cancel leaves the records unchanged', async () => {
  const h = manager(); const open = h.ui.open(); h.calls[0].resolve(result(2)); await open;
  h.click('unlisted'); const form = h.made.find(n => n.tag === 'dialog');
  assert.equal(form.open, true); const markup = h.root.innerHTML;
  await h.ui.refresh();
  assert.equal(h.calls.length, 1); assert.equal(form.open, true); assert.equal(h.root.innerHTML, markup);
  h.nodes.get('[data-cancel]').events.click();
  assert.equal(form.open, false); assert.equal(h.calls.length, 1);
});
function badge(traced = false) {
  const link = { style: {} }, calls = [], events = {}, timers = [], logs = [];
  const document = { hidden: false, readyState: 'complete', getElementById: () => link, addEventListener: (k, fn) => { events[k] = fn; } };
  const ctx = vm.createContext({ document, Date, AbortSignal,
    location: { origin: traced ? 'https://deploy-preview-89--gib-live.netlify.app' : 'https://gib-richmond-test.netlify.app' },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, console: { info: (_, json) => logs.push(JSON.parse(json)) },
    M1_MANAGER_REVIEW_CONFIG: { enabled: true }, clearTimeout() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, fetch: (...args) => { const d = deferred(); calls.push({ ...d, args }); return d.promise; } });
  vm.runInContext(source('m1/manager-review-badge.js'), ctx);
  return { link, calls, events, timers, document, logs };
}

test('badge delivery evidence correlates a real HTTP failure without logging response contents or changing Richmond', async () => {
  for (const traced of [true, false]) {
    const h = badge(traced);
    assert.equal(Boolean(h.calls[0].args[1].headers?.['X-GIB-M1-Read-ID']), traced);
    h.calls[0].resolve(Response.json({ ok: false, message: 'private response content' }, { status: 503, headers: { 'X-GIB-M1-Read-ID': '00000000-0000-4000-8000-000000000002' } }));
    await flush();
    assert.equal(h.link.textContent, 'Admin · Review status unavailable');
    assert.equal(h.logs.length, traced ? 2 : 0);
    if (traced) assert.deepEqual([h.logs[1].state, h.logs[1].status, h.logs[1].requestId], ['failed', 503, '00000000-0000-4000-8000-000000000002']);
    assert.doesNotMatch(JSON.stringify(h.logs), /private response/);
  }
});

test('Admin delivery tracing is confined to Revolution TEST display reads and excludes credentials, contents and saves', async () => {
  const code = source('m1/admin/index.html').split('      async function requestJson(')[1].split('      function requestedManagerMode()')[0];
  assert.ok(code);
  const logs = [], calls = [];
  const ctx = vm.createContext({ adminRequestToken: 'PRIVATE_SESSION_TOKEN', ADMIN_REQUEST_HEADER: 'X-Admin-Token', Date, AbortController,
    clean: s => s, window: { setTimeout, clearTimeout }, location: { origin: 'https://deploy-preview-89--gib-live.netlify.app' },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, console: { info: (_, json) => logs.push(JSON.parse(json)) },
    fetch: async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true, private: 'PRIVATE_ATTENDANCE' }, { headers: { 'X-GIB-M1-Read-ID': '00000000-0000-4000-8000-000000000002' } }); }
  });
  vm.runInContext('async function requestJson(' + code, ctx);
  await ctx.requestJson('/api/m1-manager-review', { action: 'read' });
  assert.equal(logs.length, 2); assert.equal(logs[1].state, 'received'); assert.equal(logs[1].status, 200);
  assert.ok(calls[0].options.headers['X-GIB-M1-Read-ID']);
  await ctx.requestJson('/api/m1-manager-review', { action: 'partial', requestId: 'original-save-id' });
  ctx.location.origin = 'https://gib-richmond-test.netlify.app';
  await ctx.requestJson('/api/m1-manager-review', { action: 'read' });
  assert.equal(logs.length, 2);
  assert.ok(calls.slice(1).every(c => !c.options.headers['X-GIB-M1-Read-ID']));
  assert.deepEqual(JSON.parse(calls[1].options.body), { action: 'partial', requestId: 'original-save-id' });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|original-save/);
});
test('tablet badge permits one read at a time and schedules the next only after settlement', async () => {
  const h = badge(); h.events.visibilitychange(); h.events.visibilitychange();
  assert.equal(h.calls.length, 1); assert.equal(h.timers.length, 0);
  h.calls[0].resolve(Response.json({ ok: true, pendingDays: 2, asOf: new Date().toISOString() })); await flush();
  assert.equal(h.link.textContent, 'Admin · 2 days need review'); assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 120000);
});
test('tablet badge treats a missing, failed or stale zero-count read as unavailable and recovers', async () => {
  const h = badge();
  h.calls[0].resolve(Response.json({ ok: true, pendingDays: 0, asOf: new Date(Date.now() - 60001).toISOString() })); await flush();
  assert.equal(h.link.textContent, 'Admin · Review status unavailable');
  h.events.visibilitychange(); h.calls[1].reject(new Error('missing callback')); await flush();
  assert.equal(h.link.textContent, 'Admin · Review status unavailable');
  h.events.visibilitychange(); h.calls[2].resolve(Response.json({ ok: true, pendingDays: 2, asOf: new Date().toISOString() })); await flush();
  assert.equal(h.link.textContent, 'Admin · 2 days need review');
});
