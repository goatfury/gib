import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../m1/attendance-warning.js', import.meta.url), 'utf8');
const tablet = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app', NOW = Date.parse('2026-09-27T20:00:00Z');
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const response = (status = 'attention', code = 'DELIVERY_FAILED') => ({ ok: true, target: 'test', gym: 'rev', status,
  checkedAt: status === 'not-configured' ? null : new Date(NOW).toISOString(), warnings: status === 'clear' ? [] : [{ code, message: 'Never echo public private content: QA Name reader@example.com' }] });
function harness(options = {}) {
  const root = { hidden: true, textContent: '', dataset: {} }, calls = [], timers = new Map(); let sequence = 0;
  const document = { readyState: 'complete', hidden: false, getElementById: () => null };
  root.ownerDocument = document;
  const context = vm.createContext({ document, location: { origin: ORIGIN, protocol: 'https:', port: '', ...options.location },
    M1_MANAGER_REVIEW_CONFIG: { enabled: true, target: 'test', ...options.config }, M1_INSTALLATION_PROFILE: { installationId: options.gym || 'rev', environment: options.environment },
    Date: class extends Date { static now() { return NOW; } }, AbortSignal: { timeout: ms => ({ timeout: ms }) },
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const ui = context.GIBM1AttendanceWarning.create({ root, fetch: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })) });
  return { root, calls, timers, context, document, ui,
    async read(value, ok = true) { const pending = ui.refresh(); await flush(); calls.at(-1).resolve({ ok, json: async () => value }); await pending; } };
}

test('tablet warning is inert for production, Richmond, wrong origin and disabled feature', () => {
  for (const options of [{ config: { enabled: false } }, { config: { target: 'production' } }, { gym: 'richmond' }, { location: { origin: 'https://gib-live.netlify.app' } }, { location: { protocol: 'http:' } }]) {
    const h = harness(options); assert.equal(h.ui, null); assert.equal(h.root.hidden, true); assert.equal(h.calls.length, 0);
  }
});
test('public status uses only fixed aggregate text and keeps requests away from sign-in credentials/storage', async () => {
  const h = harness(); await h.read(response());
  assert.equal(h.root.textContent, 'Attendance email could not be sent. Open Admin.'); assert.doesNotMatch(h.root.textContent, /QA Name|reader@example/);
  assert.equal(h.calls[0].args[0], '/api/m1-attendance-warning'); assert.equal(h.calls[0].args[1].credentials, 'omit');
  assert.equal(h.calls[0].args[1].cache, 'no-store'); assert.equal(h.calls[0].args[1].signal.timeout, 10000);
  await h.read(response('not-configured', 'CONFIGURATION_REQUIRED')); assert.match(h.root.textContent, /not configured/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|disabled\s*=/); assert.match(tablet, /<p id="attendanceWarning"[^>]*hidden/);
});
test('failed and incomplete reads cannot erase warnings or claim clear; a validated fresh read recovers', async () => {
  const h = harness(); await h.read(response());
  const failed = h.ui.refresh(); await flush(); assert.match(h.root.textContent, /could not be sent/);
  h.calls.at(-1).reject(new Error('Offline')); await failed; assert.equal(h.root.textContent, 'Attendance check status unavailable');
  for (const invalid of [{ ...response('clear'), checkedAt: null }, { ...response('clear'), gym: 'richmond' }, { ...response('clear'), extra: 'private' }, { ...response('clear'), warnings: [{ code: 'DELIVERY_FAILED', message: 'failure' }] }]) {
    await h.read(invalid); assert.equal(h.root.textContent, 'Attendance check status unavailable');
  }
  await h.read({ ...response('clear'), checkedAt: new Date(NOW - 1800001).toISOString() });
  assert.equal(h.root.hidden, false); assert.equal(h.root.textContent, 'Attendance check status unavailable');
  await h.read(response('clear')); assert.equal(h.root.textContent, ''); assert.equal(h.root.hidden, true);
});
test('polls never overlap, and late results cannot overwrite a cleared or hidden view', async () => {
  const h = harness(); const first = h.ui.refresh(); h.ui.refresh(); h.ui.refresh(); await flush(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ ok: true, json: async () => response() }); await first; await flush();
  assert.equal(h.calls.length, 2, 'at most one requested follow-up, after the first completed');
  h.document.hidden = true; const before = h.root.textContent; h.calls[1].resolve({ ok: true, json: async () => response('clear') }); await flush(); assert.equal(h.root.textContent, before);
  h.document.hidden = false; const late = h.ui.refresh(); await flush(); h.ui.clear();
  h.calls[2].resolve({ ok: true, json: async () => response('clear') }); await late; assert.equal(h.root.textContent, before); assert.equal(h.timers.size, 0);
});

test('Richmond aggregate warning is same-gym only and recovers visibly from failed reads', async () => {
  const h = harness({ gym: 'richmond', environment: 'test', location: { origin: 'https://gib-richmond-test.netlify.app' } }); assert.ok(h.ui);
  await h.read({ ...response(), gym: 'richmond' }); assert.match(h.root.textContent, /could not be sent/);
  await h.read(response('clear')); assert.match(h.root.textContent, /unavailable/); assert.equal(h.root.hidden, false);
  const failed = h.ui.refresh(); await flush(); h.calls.at(-1).reject(new Error('Offline')); await failed; assert.match(h.root.textContent, /unavailable/);
  await h.read({ ...response('clear'), gym: 'richmond' }); assert.equal(h.root.hidden, true);
});
