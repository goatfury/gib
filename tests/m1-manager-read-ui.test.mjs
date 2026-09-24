import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const result = (count, target = 'test') => ({ ok: true, test: target === 'test', target, pendingDays: count, period: { start: '2026-09-21', end: '2026-10-04' }, cleanupStart: '2026-09-07', days: [{ date: '2026-09-21', period: { start: '2026-09-21', end: '2026-10-04' }, complete: false, classes: [], blockers: [] }] });
const additionReview = (original, receipt, target = 'test') => {
  const view = { ...result(2, target), gym: 'rev', site: 'Rev' };
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
  const bodyClasses = new Set(), legacyCalls = [], events = {}, warnings = [];
  const legacySection = new Element('section');
  const document = { addEventListener: (name, fn) => { events[name] = fn; }, createElement: tag => { const n = new Element(tag); made.push(n); return n; }, getElementById: id => id === 'reviewSection' ? legacySection : new Element('parent'), body: { classList: { add: name => bodyClasses.add(name), remove: name => bodyClasses.delete(name) } } };
  let unauthorized = 0;
  const remembered = options.storage || new Map(), additionDates = [];
  let ticketSequence = 0;
  const clockNow = () => options.clock?.now ?? Date.now();
  // Component tests control each completed read. The real short-poll lifecycle
  // is separately exercised with a deterministic clock in the client suite.
  const readClient = {
    reusable: ticket => Boolean(ticket && ticket.deadlineAt > clockNow()),
    createTicket: () => ({ requestId: `00000000-0000-4000-8000-${String(++ticketSequence).padStart(12, '0')}`, startedAt: clockNow(), deadlineAt: clockNow() + 50000, expiresAt: clockNow() + 60000, dispatched: false }),
    run: ({ ticket, send, retain = () => {} }) => { retain({ ...ticket, dispatched: true }); return send({ operation: ticket.dispatched ? 'status' : 'start', requestId: ticket.requestId }, { timeoutMs: 25000 }); }
  };
  const ctx = vm.createContext({ document, Date, console: { ...console, warn: (...args) => warnings.push(args) }, GIBM1ReadClient: readClient, addEventListener: (name, fn) => { events[name] = fn; }, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, FormData: class { constructor(form) { return Object.entries(form.fields); } }, sessionStorage: { getItem: key => remembered.get(key) || null, setItem: (key, value) => remembered.set(key, value), removeItem: key => remembered.delete(key) }, M1_MANAGER_REVIEW_CONFIG: { enabled: options.enabled ?? true, target } });
  vm.runInContext(source('m1/admin/manager-review.js'), ctx);
  const ui = ctx.GIBM1ManagerReview.create({ request: (...args) => { const d = deferred(); calls.push({ ...d, args }); return d.promise; }, site: 'Rev', onUnauthorized: () => unauthorized++, openLegacy: date => { legacyCalls.push(date); return options.legacyResult ?? true; }, additionRequestId: date => { additionDates.push(date); return `m1-${date}-${'a'.repeat(24)}`; }, ...options });
  const root = made[0];
  return { ui, calls, made, nodes, root, bodyClasses, legacyCalls, legacySection, remembered, additionDates, events, document, warnings, unauthorized: () => unauthorized, click: (action, detail = {}) => root.events.click({ target: { closest: () => ({ dataset: { action, ...detail } }) } }) };
}

const reviewView = (target = 'test') => {
  const value = result(2, target);
  Object.assign(value.days[0], { revision: 2, attendanceHash: 'a'.repeat(64), scheduleHash: 'b'.repeat(64), decisions: [],
    canComplete: true, historyKnown: true, warnings: [], changed: false,
    classes: [{ label: '9:00 AM BJJ', scheduled: true, outcome: '', records: [] }] });
  return value;
};
const reviewReceipt = (original, target = 'test') => ({ ok: true, target, test: target === 'test',
  receipt: { saved: true, requestId: original.requestId, revision: original.revision + 1 } });

test('unconfirmed review-save logging accepts only fixed diagnostic stages and excludes private payloads', async () => {
  for (const stage of ['review.pre-save-read', 'review.pre-save-validation', 'review.save-dispatch', 'review.checked-receipt', 'review.save-receipt', 'private credential or attendance']) {
    const h = manager(), opened = h.ui.open(); h.calls[0].resolve(reviewView()); await opened;
    h.click('partial');
    h.calls[1].reject(Object.assign(new Error('Private response message'), { status: 503, data: { code: 'FAILED', stage, request: { credential: 'SECRET' } } }));
    await flush();
    assert.deepEqual(h.warnings, [['M1 review save unconfirmed', 503, 'FAILED', stage.startsWith('review.') ? stage : 'unknown-stage']]);
    assert.doesNotMatch(JSON.stringify(h.warnings), /private|Private|SECRET|credential/);
  }
});

test('class decisions and day completion retain their exact request until a matching central receipt', async () => {
  for (const target of ['test', 'production']) for (const action of ['partial', 'complete']) {
    const h = manager(target), opened = h.ui.open();
    h.calls[0].resolve(reviewView(target)); await opened;
    if (action === 'partial') h.root.events.change({ target: { hasAttribute: key => key === 'data-outcome', dataset: { outcome: '0' }, value: 'unknown' } });
    else { h.click('complete'); h.nodes.get('[data-confirm]').events.click(); }
    const original = JSON.parse(JSON.stringify(h.calls[1].args[1]));
    assert.equal(original.action, action); assert.equal(original.revision, 2);
    assert.deepEqual(original.decisions, action === 'partial' ? [{ label: '9:00 AM BJJ', outcome: 'unknown' }] : []);
    assert.deepEqual(JSON.parse(h.remembered.get('m1-manager-pending-v1')).body, original);
    h.click('partial'); h.click('complete'); assert.equal(h.calls.length, 2);
    const confirmation = reviewReceipt(original, target); confirmation.receipt.ok = true;
    h.calls[1].resolve(confirmation); await flush();
    assert.equal(h.remembered.has('m1-manager-pending-v1'), false);
    assert.equal(h.calls[2].args[1].action, 'read');
    const fresh = reviewView(target); fresh.days[0].revision = 3; fresh.days[0].complete = action === 'complete';
    h.calls[2].resolve(fresh); await flush();
    assert.equal(h.ui.hasPendingSave(), false);
    assert.match(h.nodes.get('.manager-status').textContent, action === 'complete' ? /saved complete centrally/ : /Unresolved items keep this day pending/);
  }
});

test('partial and complete saves reject incomplete, conflicting or foreign-environment receipts without clearing the journal', async () => {
  const changes = [
    value => { value.receipt = {}; },
    value => { value.receipt = true; },
    value => { value.receipt = []; },
    value => { value.receipt.saved = false; },
    value => { delete value.receipt.saved; },
    value => { value.receipt.requestId = 'manager-other-original-1234567890'; },
    value => { value.receipt.revision = 2; },
    value => { value.receipt.revision = 4; },
    value => { value.receipt.revision = 3.5; },
    value => { value.receipt.revision = '3'; },
    value => { value.receipt.ok = false; },
    value => { value.receipt.retry = true; },
    value => { value.receipt.ok = true; value.receipt.retry = false; },
    value => { value.receipt.extra = true; },
    value => { value.target = 'production'; value.test = false; },
    value => { delete value.target; },
    value => { value.test = false; }
  ];
  for (const action of ['partial', 'complete']) for (const change of changes) {
    const h = manager(), opened = h.ui.open(); h.calls[0].resolve(reviewView()); await opened;
    if (action === 'partial') h.click('partial');
    else { h.click('complete'); h.nodes.get('[data-confirm]').events.click(); }
    const original = JSON.parse(JSON.stringify(h.calls[1].args[1])), response = reviewReceipt(original);
    change(response); h.calls[1].resolve(response); await flush();
    assert.equal(h.ui.hasPendingSave(), true);
    assert.deepEqual(JSON.parse(h.remembered.get('m1-manager-pending-v1')).body, original);
    assert.equal(h.calls.length, 2, 'unconfirmed receipt cannot trigger a success read');
    assert.match(h.nodes.get('.manager-status').textContent, /not confirmed/);
    h.click('legacy'); assert.equal(h.legacyCalls.length, 0);
  }
});

test('a lost review-save response survives reload and retries only the same original revision and identity', async () => {
  for (const action of ['partial', 'complete']) for (const retryReceipt of [false, true]) {
    const storage = new Map(), first = manager('test', { storage }), opened = first.ui.open();
    first.calls[0].resolve(reviewView()); await opened;
    if (action === 'partial') first.click('partial');
    else { first.click('complete'); first.nodes.get('[data-confirm]').events.click(); }
    const original = JSON.parse(JSON.stringify(first.calls[1].args[1]));
    first.calls[1].reject(new Error('Original reply lost')); await flush(); first.ui.clear();
    const h = manager('test', { storage }), reopened = h.ui.open();
    assert.equal(h.calls[0].args[1].action, 'read', 'reopening does not resend a review write');
    const latest = reviewView(); latest.days[0].revision = 7;
    h.calls[0].resolve(latest); await reopened;
    assert.equal(h.ui.hasPendingSave(), true, 'ordinary read is not original-save evidence');
    h.click('retry'); h.click('retry');
    assert.equal(h.calls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].args[1])), original);
    const response = { ...latest, ...reviewReceipt(original) };
    if (retryReceipt) Object.assign(response.receipt, { ok: true, retry: true });
    h.calls[1].resolve(response); await flush();
    assert.equal(h.ui.hasPendingSave(), false);
    assert.equal(storage.has('m1-manager-pending-v1'), false);
    assert.equal(h.calls.length, 2, 'valid recovery view needs no extra read or write');
  }
});

test('malformed original revision and late review-save replies cannot release a newer pending request', async () => {
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER, '2']) {
    const original = { action: 'partial', requestId: 'manager-original-1234567890123456', date: '2026-09-21', revision };
    const storage = new Map([['m1-manager-pending-v1', JSON.stringify({ url: '/api/m1-manager-review', body: original })]]);
    const h = manager('test', { storage }), opened = h.ui.open(); h.calls[0].resolve(reviewView()); await opened;
    h.click('retry'); h.calls[1].resolve(reviewReceipt(original)); await flush();
    assert.equal(h.ui.hasPendingSave(), true); assert.equal(storage.has('m1-manager-pending-v1'), true);
  }
  const h = manager(), opened = h.ui.open(); h.calls[0].resolve(reviewView()); await opened;
  h.click('partial'); const original = JSON.parse(JSON.stringify(h.calls[1].args[1]));
  h.ui.clear(); const reopened = h.ui.open(); h.calls[2].resolve(reviewView()); await reopened;
  h.click('retry');
  h.calls[1].resolve(reviewReceipt(original)); await flush();
  assert.equal(h.ui.hasPendingSave(), true, 'old session receipt cannot clear the reopened request');
  h.calls[3].resolve({ ...reviewView(), ...reviewReceipt(original) }); await flush();
  assert.equal(h.ui.hasPendingSave(), false); assert.equal(h.calls.length, 4);
});

test('both release targets keep independent Daily Review reachable after first-load and refresh failures', async () => {
  for (const target of ['test', 'production']) for (const initial of [true, false]) {
    const h = manager(target, { legacyResult: false }), open = h.ui.open();
    if (initial) { h.calls[0].reject(new Error('offline')); await open; }
    else { h.calls[0].resolve(result(2, target)); await open; const read = h.ui.refresh(); h.calls[1].reject(new Error('offline')); await read; }
    assert.match(initial ? h.root.innerHTML : h.nodes.get('.manager-summary strong').textContent, /Review status unavailable/);
    const controls = initial ? h.root.innerHTML : h.nodes.get('.manager-summary').children[0].innerHTML;
    assert.match(controls, /data-action="legacy"\s*>Existing Daily Review tools/);
    h.click('legacy'); await flush();
    assert.deepEqual(h.legacyCalls, [initial ? '' : '2026-09-21']);
    assert.equal(h.bodyClasses.has('manager-legacy-open'), true);
    assert.match(h.nodes.get('.manager-status').textContent, /Neither review could load fresh records.*Unfinished days still need review/);
    assert.equal(h.legacySection.focused, true);
    const read = h.ui.refresh(); h.calls.at(-1).resolve(result(2, target)); await read;
    assert.match(h.root.innerHTML, /2 days need/);
  }
});

const originalAddition = { requestId: 'm1-2026-09-21-' + 'a'.repeat(24), date: '2026-09-21', instructor: 'QA TEST Original', classLabel: '9:00 AM BJJ', duration: 1, site: 'Rev', notes: '', reason: 'Forgotten sign-in' };
const originalReceipt = (original = originalAddition, target = 'test') => ({ ok: true, test: target === 'test', requestId: original.requestId, linkedRecordId: 'gib-admin-' + original.requestId, linkedDisplayId: 'sheet-row-79', confirmedOriginal: true, confirmation: { adminName: 'Stuart Turner' } });
const proof = (original = originalAddition, target = 'test') => { const receipt = originalReceipt(original, target); return { ...receipt, review: additionReview(original, receipt, target) }; };
const validateOriginal = receipt => receipt.confirmedOriginal === true && !('review' in receipt);

test('uncertain external addition automatically checks one persisted ticket and coalesces every trigger', async () => {
  const h = manager('test', { validateAdditionResult: validateOriginal });
  const opened = h.ui.open(); h.calls[0].resolve(result(2)); await opened;
  assert.equal(h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', originalAddition), true);
  h.ui.finishExternalSave(originalAddition, false);
  assert.equal(h.calls[1].args[0], '/api/m1-admin-add-check');
  const stored = JSON.parse(h.remembered.get('m1-manager-pending-v1'));
  assert.deepEqual(stored.body, originalAddition);
  assert.equal(stored.readTicket.dispatched, true);
  assert.equal(stored.readTicket.requestId, h.calls[1].args[1].readRequest.requestId);
  assert.equal(h.calls[1].args[1].readRequest.operation, 'start');
  h.click('retry'); h.events.online(); h.events.visibilitychange(); void h.ui.refresh(); h.click('legacy');
  assert.equal(h.calls.length, 2); assert.equal(h.legacyCalls.length, 0);
  h.calls[1].resolve(proof()); await flush();
  assert.equal(h.ui.hasPendingSave(), false);
  assert.equal(h.remembered.has('m1-manager-pending-v1'), false);
  assert.equal(h.calls.length, 2, 'same full proof includes current review; no second Google read');
  h.click('legacy'); await flush(); assert.deepEqual(h.legacyCalls, ['2026-09-21']);
});

test('incomplete full proof or mismatched review never clears the original save', async () => {
  for (const target of ['test', 'production']) for (const failure of ['receipt', 'no-review', 'receipt-target', 'warning', 'duplicate', 'mismatch', 'notes', 'false-complete', 'other-gym', 'review-target']) {
    const h = manager(target, { validateAdditionResult: validateOriginal });
    const opened = h.ui.open(); h.calls[0].resolve(result(2, target)); await opened;
    h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', originalAddition); h.ui.finishExternalSave(originalAddition, false);
    const response = proof(originalAddition, target), day = response.review.days[0];
    if (failure === 'receipt') delete response.confirmedOriginal;
    if (failure === 'no-review') delete response.review;
    if (failure === 'receipt-target') response.test = target !== 'test';
    if (failure === 'warning') day.warnings.push({ code: 'RECORD_ID_CONFLICT' });
    if (failure === 'duplicate') day.classes[0].records.push({ ...day.classes[0].records[0] });
    if (failure === 'mismatch') day.classes[0].records[0].duration = 2;
    if (failure === 'notes') day.classes[0].records[0].notes += ' changed';
    if (failure === 'false-complete') day.complete = true;
    if (failure === 'other-gym') response.review.gym = 'richmond';
    if (failure === 'review-target') { response.review.target = target === 'test' ? 'production' : 'test'; response.review.test = target !== 'test'; }
    h.calls[1].resolve(response); await flush();
    assert.equal(h.ui.hasPendingSave(), true, failure);
    assert.deepEqual(JSON.parse(h.remembered.get('m1-manager-pending-v1')).body, originalAddition);
    h.click('legacy'); assert.equal(h.legacyCalls.length, 0);
    assert.equal(h.calls.some(call => /m1-admin-add$/.test(call.args[0])), false);
  }
});

test('reload resumes the retained ticket automatically without an initial ordinary read or another write', async () => {
  const storage = new Map(), options = { storage, validateAdditionResult: validateOriginal };
  const first = manager('production', options), opened = first.ui.open();
  first.calls[0].resolve(result(2, 'production')); await opened;
  first.click('unlisted');
  first.nodes.get('form').events.submit({ preventDefault() {}, target: { fields: { instructor: 'Isolated Fake Instructor', classLabel: '9:00 AM BJJ', duration: '1', reason: 'Isolated recovery test' } } });
  const original = JSON.parse(JSON.stringify(first.calls[1].args[1]));
  first.calls[1].reject(new Error('Lost confirmation')); await flush();
  assert.equal(first.calls[2].args[0], '/api/m1-admin-add-check');
  const ticket = first.calls[2].args[1].readRequest.requestId;
  first.ui.clear();
  const h = manager('production', options), reopened = h.ui.open();
  assert.equal(h.calls[0].args[0], '/api/m1-admin-add-check');
  assert.equal(h.calls[0].args[1].readRequest.requestId, ticket);
  assert.equal(h.calls[0].args[1].readRequest.operation, 'status');
  h.calls[0].resolve(proof(original, 'production')); await reopened;
  assert.equal(h.ui.hasPendingSave(), false);
  assert.equal(storage.has('m1-manager-pending-v1'), false);
  first.calls[2].resolve(proof(original, 'production')); await flush();
  assert.equal(storage.has('m1-manager-pending-v1'), false, 'old session cannot reinsert pending state');
  assert.equal(h.calls.some(c => /m1-admin-add$/.test(c.args[0])), false);
});

test('logout during recovery ignores old proof and keeps reopened recovery usable', async () => {
  const h = manager('test', { validateAdditionResult: validateOriginal });
  const open = h.ui.open(); h.calls[0].resolve(result(2)); await open;
  h.ui.beginExternalSave('/.netlify/functions/m1-admin-add', originalAddition); h.ui.finishExternalSave(originalAddition, false);
  const old = h.calls[1]; h.ui.clear(); const reopened = h.ui.open();
  assert.equal(h.calls[2].args[1].readRequest.operation, 'status');
  old.resolve(proof()); await flush(); assert.equal(h.ui.hasPendingSave(), true);
  h.calls[2].resolve(proof()); await reopened;
  assert.equal(h.ui.hasPendingSave(), false); assert.equal(h.calls.length, 3);
});

test('late write acknowledgment from a closed session cannot erase the resumed check', async () => {
  const h = manager('production', { validateAdditionResult: validateOriginal }), opened = h.ui.open();
  h.calls[0].resolve(result(2, 'production')); await opened;
  h.click('unlisted');
  h.nodes.get('form').events.submit({ preventDefault() {}, target: { fields: { instructor: 'Isolated Fake Instructor', classLabel: '9:00 AM BJJ', duration: '1', reason: 'Isolated recovery test' } } });
  const original = JSON.parse(JSON.stringify(h.calls[1].args[1]));
  h.ui.clear(); const reopened = h.ui.open();
  assert.equal(h.calls[2].args[0], '/api/m1-admin-add-check');
  h.calls[1].resolve(originalReceipt(original, 'production')); await flush();
  assert.equal(h.ui.hasPendingSave(), true);
  assert.deepEqual(JSON.parse(h.remembered.get('m1-manager-pending-v1')).body, original);
  h.calls[2].resolve(proof(original, 'production')); await reopened;
  assert.equal(h.ui.hasPendingSave(), false);
  assert.equal(h.calls.length, 3);
});

test('expired recovery is retained; only reopening or explicit retry can start one fresh ticket', async () => {
  const storage = new Map(), oldTicket = { requestId: '00000000-0000-4000-8000-000000000099', startedAt: Date.now()-61000, deadlineAt: Date.now()-11000, expiresAt: Date.now()-1000, dispatched: true };
  storage.set('m1-manager-pending-v1', JSON.stringify({ url: '/api/m1-admin-add', body: originalAddition, readTicket: oldTicket }));
  const h = manager('test', { storage, validateAdditionResult: validateOriginal }), open = h.ui.open();
  const fresh = h.calls[0].args[1].readRequest;
  assert.equal(fresh.operation, 'start'); assert.notEqual(fresh.requestId, oldTicket.requestId);
  h.events.online(); h.events.visibilitychange(); h.click('retry'); assert.equal(h.calls.length, 1);
  h.calls[0].reject(Object.assign(new Error('Expired read'), { status: 410 })); await open;
  const stored = JSON.parse(storage.get('m1-manager-pending-v1')); stored.readTicket.deadlineAt = Date.now()-1; storage.set('m1-manager-pending-v1', JSON.stringify(stored));
  h.ui.clear(); const reopened = h.ui.open(); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args[1].readRequest.operation, 'start');
  h.calls[1].resolve(proof()); await reopened; assert.equal(h.ui.hasPendingSave(), false);
});

test('one real offline-to-online transition after the deadline automatically recovers the unchanged save', async () => {
  const clock = { now: Date.now() }, h = manager('test', { clock, validateAdditionResult: validateOriginal });
  const opened = h.ui.open(); h.calls[0].resolve(result(2)); await opened;
  h.ui.beginExternalSave('/api/m1-admin-add', originalAddition); h.ui.finishExternalSave(originalAddition, false);
  const firstTicket = h.calls[1].args[1].readRequest.requestId;
  h.events.offline(); clock.now += 51000;
  h.calls[1].reject(Object.assign(new Error('Expired read'), { status: 410 })); await flush();
  h.events.visibilitychange(); assert.equal(h.calls.length, 2, 'visibility alone cannot renew an expired ticket');
  h.events.online(); h.events.online(); h.events.visibilitychange(); h.click('retry');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].args[0], '/api/m1-admin-add-check');
  assert.equal(h.calls[2].args[1].readRequest.operation, 'start');
  assert.notEqual(h.calls[2].args[1].readRequest.requestId, firstTicket);
  const { readRequest, ...original } = h.calls[2].args[1];
  assert.deepEqual(original, originalAddition);
  h.calls[2].resolve(proof()); await flush();
  assert.equal(h.ui.hasPendingSave(), false);
  assert.equal(h.calls.some(call => /m1-admin-add$/.test(call.args[0])), false);
});

test('connection recovery while hidden is retained until the original review becomes visible', async () => {
  const clock = { now: Date.now() }, h = manager('test', { clock, validateAdditionResult: validateOriginal });
  const opened = h.ui.open(); h.calls[0].resolve(result(2)); await opened;
  h.ui.beginExternalSave('/api/m1-admin-add', originalAddition); h.ui.finishExternalSave(originalAddition, false);
  const expiredId = h.calls[1].args[1].readRequest.requestId;
  h.events.offline(); clock.now += 51000;
  h.calls[1].reject(Object.assign(new Error('Expired read'), { status: 410 })); await flush();
  h.document.hidden = true; h.events.online(); h.events.online(); h.events.visibilitychange();
  assert.equal(h.calls.length, 2);
  h.document.hidden = false; h.events.visibilitychange(); h.events.visibilitychange(); h.events.online();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].args[1].readRequest.operation, 'start');
  assert.notEqual(h.calls[2].args[1].readRequest.requestId, expiredId);
  h.calls[2].resolve(proof()); await flush();
  assert.equal(h.ui.hasPendingSave(), false);
});

test('Richmond TEST keeps its existing original-save path', async () => {
  for (const [target, site] of [['test', 'Richmond']]) {
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
    assert.equal(h.calls[2].args[0], '/api/m1-admin-add-check');
    const { readRequest, ...retainedOriginal } = h.calls[2].args[1];
    assert.equal(readRequest.operation, 'start');
    assert.deepEqual(retainedOriginal, JSON.parse(JSON.stringify(h.calls[1].args[1])));
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
function badge(traced = false, realClient = false) {
  const link = { style: {} }, calls = [], events = {}, timers = [], logs = [];
  const document = { hidden: false, readyState: 'complete', getElementById: () => link, addEventListener: (k, fn) => { events[k] = fn; } };
  const ctx = vm.createContext({ document, Date, AbortSignal, M1_INSTALLATION_PROFILE: { installationId: traced ? 'rev' : 'richmond' },
    location: { origin: traced ? 'https://deploy-preview-89--gib-live.netlify.app' : 'https://gib-richmond-test.netlify.app' },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, console: { info: (_, json) => logs.push(JSON.parse(json)) },
    M1_MANAGER_REVIEW_CONFIG: { enabled: true }, clearTimeout() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, fetch: (...args) => { const d = deferred(); calls.push({ ...d, args }); return d.promise; } });
  if (realClient) vm.runInContext(source('m1/manager-read-client.js'), ctx);
  else ctx.GIBM1ReadClient = { createTicket: () => ({ requestId: '00000000-0000-4000-8000-000000000001' }), run: ({ ticket, send }) => send({ operation: 'start', requestId: ticket.requestId }, { timeoutMs: 25000 }) };
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
  const ticketId = '00000000-0000-4000-8000-000000000003';
  await ctx.requestJson('/api/m1-manager-review', { action: 'read', readRequest: { operation: 'status', requestId: ticketId } });
  assert.equal(calls[1].options.headers['X-GIB-M1-Read-ID'], ticketId);
  assert.equal(logs[2].clientId, ticketId);
  await ctx.requestJson('/api/m1-manager-review', { action: 'partial', requestId: 'original-save-id' });
  ctx.location.origin = 'https://gib-richmond-test.netlify.app';
  await ctx.requestJson('/api/m1-manager-review', { action: 'read' });
  assert.equal(logs.length, 4);
  assert.ok(calls.slice(2).every(c => !c.options.headers['X-GIB-M1-Read-ID']));
  assert.deepEqual(JSON.parse(calls[2].options.body), { action: 'partial', requestId: 'original-save-id' });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|original-save/);
});
test('tablet badge permits one read at a time and schedules the next only after settlement', async () => {
  const h = badge(); h.events.visibilitychange(); h.events.visibilitychange();
  assert.equal(h.calls.length, 1); assert.equal(h.timers.length, 0);
  h.calls[0].resolve(Response.json({ ok: true, pendingDays: 2, asOf: new Date().toISOString() })); await flush();
  assert.equal(h.link.textContent, 'Admin · 2 days need review'); assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 120000);
});
test('Revolution badge keeps one ticket across pending delivery and overlapping visibility events', async () => {
  const h = badge(true, true), requestId = h.calls[0].args[1].headers['X-GIB-M1-Read-ID'];
  assert.equal(h.calls[0].args[1].headers['X-GIB-M1-Read-Operation'], 'start');
  h.calls[0].resolve(Response.json({ ok: true, state: 'pending', requestId, deadlineAt: Date.now() + 50000, expiresAt: Date.now() + 60000 }, { status: 202 })); await flush();
  h.events.visibilitychange(); h.events.visibilitychange();
  assert.equal(h.calls.length, 1); assert.equal(h.link.textContent, 'Admin · Review status loading');
  assert.equal(h.timers[0].ms, 2000); h.timers[0].fn(); await flush();
  assert.equal(h.calls[1].args[1].headers['X-GIB-M1-Read-ID'], requestId);
  assert.equal(h.calls[1].args[1].headers['X-GIB-M1-Read-Operation'], 'status');
  h.calls[1].resolve(Response.json({ ok: true, pendingDays: 2, asOf: new Date().toISOString() })); await flush();
  assert.equal(h.link.textContent, 'Admin · 2 days need review');
  assert.equal(h.timers.at(-1).ms, 120000);
});

test('read client is packaged before both manager consumers without initializing the kiosk', () => {
  const kiosk = source('m1/index.html'), admin = source('m1/admin/index.html'), build = source('tools/build-public.mjs');
  assert.ok(kiosk.indexOf('src="./manager-read-client.js') < kiosk.indexOf('src="./manager-review-badge.js'));
  assert.ok(admin.indexOf('src="../manager-read-client.js') < admin.indexOf('src="./manager-review.js'));
  assert.match(build, /'m1\/manager-read-client.js'/);
  assert.doesNotMatch(source('m1/manager-read-client.js'), /localStorage|sessionStorage|document\.|fetch\(|addEventListener/);
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
