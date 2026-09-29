import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { staffRecoveryEnabled } from '../m1/staff-recovery-client.mjs';
const live = readFileSync(new URL('../m1/admin/attendance-live.js', import.meta.url), 'utf8');
const warning = readFileSync(new URL('../m1/attendance-warning.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-30T00:05:00Z');
const ORIGINS = { rev: 'https://gib-live.netlify.app', richmond: 'https://gib-richmond-live.netlify.app' };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
class Element {
  children = []; hidden = true; dataset = {}; style = {}; listeners = {};
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  get text() { return this.textContent + this.children.map(child => child.text).join(' '); }
}
function harness(gym, overrides = {}) {
  const document = { readyState: 'complete', hidden: false, getElementById: () => null, createElement: tag => new Element(tag, document) };
  const root = new Element('section', document), calls = []; let admin = gym === 'rev' ? 'Stuart Turner' : 'Trey Martin', session = 'original-session', unauthorized = 0;
  const origin = ORIGINS[gym], context = vm.createContext({ document, location: { origin, protocol: 'https:', port: '', ...overrides.location },
    M1_MANAGER_REVIEW_CONFIG: { enabled: false, target: 'disabled', reminders: true, ...overrides.config },
    M1_INSTALLATION_PROFILE: { installationId: gym, allowedOrigin: origin, environment: 'production', activation: 'active', ...overrides.profile },
    Date: class extends Date { static now() { return NOW; } }, setTimeout: () => 1, clearTimeout() {}, AbortSignal: { timeout: ms => ({ ms }) } });
  vm.runInContext(warning, context); vm.runInContext(live, context);
  const request = (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject }));
  const ui = context.GIBM1AttendanceLive.create({ root, request, getAdmin: () => admin, getSession: () => session, onUnauthorized: () => unauthorized++ });
  return { root, ui, calls, context, setSession(value) { session = value; }, setAdmin(value) { admin = value; }, get unauthorized() { return unauthorized; } };
}
function status(gym, code = 'CHECK_INCOMPLETE') {
  return { ok: true, target: 'production', latestRun: null, current: {
    health: { ok: true, target: 'production', state: code ? 'check-incomplete' : 'clear', codes: code ? [code] : [], pendingCount: 0, failedCount: 0, unconfirmedCount: 0,
      historicalUnconfirmedCount: 1, historicalFailedCount: 0, checkedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 100000).toISOString() },
    messages: { ok: true, target: 'production', historyComplete: true, messages: [{ gym, date: '2026-09-29', messageId: 'm1-production-scheduled-' + gym + '-2026-09-29', state: 'suppressed', message: null }] }
  } };
}
test('enabled production reminder screen uses the real adapter GET signature; failures recover and historical uncertainty stays separate', async () => {
  for (const gym of ['rev', 'richmond']) {
    const h = harness(gym); assert.ok(h.ui); const first = h.ui.open(); h.ui.open(); await flush(); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args[0], '/api/m1-attendance-workflow'); assert.equal(h.calls[0].args[1], undefined);
    assert.equal(h.calls[0].args[2].method, 'GET', 'actual adapter second argument is a request body, not options');
    h.calls[0].reject(new Error('isolated offline')); await first; assert.match(h.root.text, /status unavailable/); assert.doesNotMatch(h.root.text, /nothing outstanding/);
    const recover = h.ui.open(); await flush(); h.calls[1].resolve(status(gym)); await recover;
    assert.match(h.root.text, /could not be fully checked/); assert.match(h.root.text, /1 send results unknown/);
    const clean = h.ui.open(); await flush(); h.calls[2].resolve(status(gym, null)); await clean; assert.match(h.root.text, /latest attendance check found nothing/); assert.match(h.root.text, /Past reminders/);
    const foreign = h.ui.open(); await flush(); h.calls[3].resolve(status(gym === 'rev' ? 'richmond' : 'rev')); await foreign;
    assert.match(h.root.text, /status unavailable/);
    const incomplete = h.ui.open(); await flush(); const missingWarnings = status(gym); missingWarnings.current.health.codes = [];
    h.calls[4].resolve(missingWarnings); await incomplete; assert.match(h.root.text, /status unavailable/);
  }
});
test('late live reads cannot overwrite logout/session changes, and unauthorized status clears private history', async () => {
  const h = harness('rev'); const old = h.ui.open(); await flush(); h.ui.clear(); h.calls[0].resolve(status('rev')); await old;
  assert.equal(h.root.children.length, 0); assert.equal(h.root.hidden, true);
  const changed = h.ui.open(); await flush(); h.setSession('new-session'); h.calls[1].resolve(status('rev')); await changed;
  assert.doesNotMatch(h.root.text, /Past reminders/);
  const denied = h.ui.open(); await flush(); h.calls[2].reject({ status: 401 }); await denied;
  assert.equal(h.unauthorized, 1); assert.equal(h.root.hidden, true); assert.equal(h.root.children.length, 0);
});
test('missing/invalid/off feature flags, preview origins and pending Richmond activation never mount live controls', () => {
  for (const gym of ['rev', 'richmond']) {
    for (const value of [undefined, false, 'true', 'TRUE']) assert.equal(harness(gym, { config: { reminders: value } }).ui, null);
    assert.equal(harness(gym, { location: { origin: 'https://deploy-preview-89--gib-live.netlify.app' } }).ui, null);
  }
  assert.equal(harness('richmond', { profile: { activation: 'pending' } }).ui, null);
  assert.equal(staffRecoveryEnabled({ installationId: 'richmond', allowedOrigin: ORIGINS.richmond }, { staffRecovery: true }, { origin: ORIGINS.richmond, protocol: 'https:', port: '' }), false);
  assert.equal(staffRecoveryEnabled({ installationId: 'rev', allowedOrigin: ORIGINS.rev }, { enabled: false, target: 'disabled', staffRecovery: true }, { origin: ORIGINS.rev, protocol: 'https:', port: '' }), true);
});
test('production tablet warning is aggregate-only, independent of sign-in and never clears after a failed or wrong-gym read', async () => {
  for (const gym of ['rev', 'richmond']) {
    const h = harness(gym), calls = [], root = new Element('p', h.root.ownerDocument);
    const ui = h.context.GIBM1AttendanceWarning.create({ root, fetch: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })) }); assert.ok(ui);
    const first = ui.refresh(); await flush(); assert.equal(calls[0].args[1].credentials, 'omit');
    calls[0].resolve({ ok: true, json: async () => ({ ok: true, target: 'production', gym, status: 'attention', checkedAt: new Date(NOW).toISOString(), warnings: [{ code: 'DELIVERY_UNCONFIRMED', message: 'Private fixture@example.invalid' }] }) }); await first;
    assert.match(root.text, /unconfirmed/); assert.doesNotMatch(root.text, /fixture@/);
    const bad = ui.refresh(); await flush(); calls[1].reject(new Error('offline')); await bad; assert.equal(root.hidden, false); assert.match(root.text, /unavailable/);
    const clean = ui.refresh(); await flush(); calls[2].resolve({ ok: true, json: async () => ({ ok: true, target: 'production', gym, status: 'clear', checkedAt: new Date(NOW).toISOString(), warnings: [] }) }); await clean;
    assert.equal(root.hidden, true); ui.clear();
  }
  assert.doesNotMatch(warning, /localStorage|sessionStorage|disabled\s*=/);
});
