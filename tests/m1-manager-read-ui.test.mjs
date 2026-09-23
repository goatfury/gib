import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const result = count => ({ ok: true, test: true, pendingDays: count, period: { start: '2026-09-21', end: '2026-10-04' }, cleanupStart: '2026-09-07', days: [{ date: '2026-09-21', period: { start: '2026-09-21', end: '2026-10-04' }, complete: false, classes: [], blockers: [] }] });
function manager() {
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
  }
  const document = { createElement: tag => { const n = new Element(tag); made.push(n); return n; }, getElementById: () => new Element('parent'), body: { classList: { add() {} } } };
  let unauthorized = 0;
  const ctx = vm.createContext({ document, Date, console, sessionStorage: { getItem: () => null }, M1_MANAGER_REVIEW_CONFIG: { enabled: true } });
  vm.runInContext(source('m1/admin/manager-review.js'), ctx);
  const ui = ctx.GIBM1ManagerReview.create({ request: (...args) => { const d = deferred(); calls.push({ ...d, args }); return d.promise; }, site: 'Rev', onUnauthorized: () => unauthorized++, openLegacy() {} });
  const root = made[0];
  return { ui, calls, made, nodes, root, unauthorized: () => unauthorized, click: action => root.events.click({ target: { closest: () => ({ dataset: { action } }) } }) };
}
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
function badge() {
  const link = { style: {} }, calls = [], events = {}, timers = [];
  const document = { hidden: false, readyState: 'complete', getElementById: () => link, addEventListener: (k, fn) => { events[k] = fn; } };
  const ctx = vm.createContext({ document, Date, AbortSignal, M1_MANAGER_REVIEW_CONFIG: { enabled: true }, clearTimeout() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, fetch: () => { const d = deferred(); calls.push(d); return d.promise; } });
  vm.runInContext(source('m1/manager-review-badge.js'), ctx);
  return { link, calls, events, timers, document };
}
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
