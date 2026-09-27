import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAttendanceWorkflow } from '../netlify/functions/m1-attendance-workflow.mjs';
import { handleAttendanceWorkflowBackground } from '../netlify/functions/m1-attendance-workflow-background.mjs';
import { handleAttendanceWarning } from '../netlify/functions/m1-attendance-warning.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';

const now = Date.parse('2026-09-27T12:00:00Z'), id = 'ca1d0000-0000-4000-8000-000000000001';
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-transport-secret-1234567890', GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-12345678901234567890' };
const health = () => ({ ok: true, target: 'test', state: 'not-configured', codes: ['CONFIGURATION_REQUIRED'], checkedAt: null, expiresAt: null,
  pendingCount: 0, failedCount: 0, unconfirmedCount: 0 });
const dependencies = () => ({ enabled: true, target: 'test', env, clock: () => now,
  context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } },
  readExamples: async () => null, readHealth: async () => health(), readMessages: async () => [] });
function request(path, body, options = {}) {
  const runtime = runtimeConfig(env, { admin: true, requestUrl: DIGEST_ORIGIN });
  const token = 'x'.repeat(43), session = createAdminSession('Andrew Smith', runtime.sessionSecret, now, token);
  return new Request((options.origin || DIGEST_ORIGIN) + path, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Origin: options.requestOrigin || options.origin || DIGEST_ORIGIN,
      ...(options.cookie === false ? {} : { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session)}` }),
      ...(options.token === false ? {} : { [ADMIN_REQUEST_HEADER]: token }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('all full workflow data and simulation starts remain behind the existing Admin and exact TEST boundary', async () => {
  const deps = dependencies(); let touched = 0;
  deps.readExamples = deps.prepareExamples = deps.runExamples = async () => { touched++; };
  for (const options of [{ cookie: false }, { token: false }, { origin: 'https://gib-live.netlify.app' },
    { origin: 'https://gib-richmond-test.netlify.app' }, { requestOrigin: 'https://other.example' }]) {
    for (const [path, handler] of [['/api/m1-attendance-workflow', handleAttendanceWorkflow],
      ['/api/m1-attendance-workflow-background', handleAttendanceWorkflowBackground]]) {
      const res = await handler(request(path, { action: 'runExamples', requestId: id }, options), deps);
      assert.ok([401, 403].includes(res.status));
    }
  }
  assert.equal(touched, 0);
});

test('original example identity is persisted before supported dispatch; 202 is pending, not a test pass', async () => {
  const deps = dependencies(), order = [];
  deps.prepareExamples = async runId => { assert.equal(runId, id); order.push('persist'); };
  deps.readExamples = async () => { order.push('read'); return null; };
  deps.dispatchExamples = async runId => { assert.equal(runId, id); order.push('dispatch'); };
  const result = await handleAttendanceWorkflow(request('/api/m1-attendance-workflow', { action: 'runExamples', requestId: id }), deps);
  assert.equal(result.status, 202);
  const data = await result.json();
  assert.deepEqual(order, ['persist', 'read', 'dispatch']);
  assert.equal(data.latestRun, null); assert.equal(data.request.runId, id); assert.equal(data.request.state, 'pending');
  assert.equal(data.sendingEnabled, false); assert.equal(data.recurringEnabled, false);
  deps.prepareExamples = async () => { throw new Error('Lost storage'); };
  const failed = await handleAttendanceWorkflow(request('/api/m1-attendance-workflow', { action: 'runExamples', requestId: id }), deps);
  assert.equal(failed.status, 503); assert.equal(order.filter(x => x === 'dispatch').length, 1);
});

test('completed original run reopens without another dispatch and no client can select recipients or real delivery', async () => {
  const deps = dependencies(); let dispatches = 0, starts = 0;
  const run = { runId: id, complete: true, synthetic: true, scenarios: [] };
  deps.readExamples = async runId => { assert.equal(runId, id); return run; };
  deps.prepareExamples = async () => { starts++; };
  deps.dispatchExamples = async () => { dispatches++; };
  const reopened = await handleAttendanceWorkflow(request('/api/m1-attendance-workflow?runId=' + id), deps);
  assert.equal(reopened.status, 200); assert.deepEqual((await reopened.json()).latestRun, run);
  const repeat = await handleAttendanceWorkflow(request('/api/m1-attendance-workflow', { action: 'runExamples', requestId: id }), deps);
  assert.equal(repeat.status, 200); assert.equal(dispatches, 0); assert.equal(starts, 1);
  for (const input of [{ action: 'send', requestId: id }, { action: 'runExamples', requestId: id, recipient: 'private@example.test' },
    { action: 'runExamples', requestId: id, realSending: true }, { action: 'runExamples', requestId: 'new-message' }]) {
    assert.equal((await handleAttendanceWorkflow(request('/api/m1-attendance-workflow', input), deps)).status, 400);
  }
  assert.equal(starts, 1);
});

test('background execution awaits one fixed original run and does not call a user-selected provider', async () => {
  const deps = dependencies(); let completed = false;
  deps.runExamples = async (runId, received) => { assert.equal(runId, id); assert.equal(received.scope.target, 'test'); await Promise.resolve(); completed = true; };
  const result = await handleAttendanceWorkflowBackground(request('/api/m1-attendance-workflow-background', { action: 'runExamples', requestId: id }), deps);
  assert.equal(result.status, 200); assert.equal(completed, true);
  deps.runExamples = async () => { throw Object.assign(new Error('Lease held'), { code: 'WORKFLOW_EXAMPLES_IN_PROGRESS' }); };
  deps.traceLog = () => {};
  const busy = await handleAttendanceWorkflowBackground(request('/api/m1-attendance-workflow-background', { action: 'runExamples', requestId: id }), deps);
  assert.equal(busy.status, 409);
});

test('public warning is fixed aggregate-only text even if private fields appear in underlying status', async () => {
  const deps = dependencies();
  deps.readHealth = async () => ({ ...health(), state: 'attention', codes: ['CHECK_INCOMPLETE', 'DELIVERY_UNCONFIRMED'],
    checkedAt: new Date(now).toISOString(), privateNames: ['PRIVATE STAFF'], recipient: 'private@example.test', records: [{ id: 'record-secret' }] });
  const result = await handleAttendanceWarning(request('/api/m1-attendance-warning', null, { cookie: false, token: false }), deps);
  assert.equal(result.status, 200); const data = await result.json();
  assert.deepEqual(Object.keys(data).sort(), ['checkedAt', 'gym', 'ok', 'status', 'target', 'warnings']);
  assert.equal(data.status, 'attention'); assert.equal(data.gym, 'rev');
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE STAFF|private@example|record-secret/);
  assert.match(data.warnings[0].message, /could not be fully checked/);
});

test('unavailable or malformed public status never becomes a clean check and stays absent outside Revolution TEST', async () => {
  const deps = dependencies();
  for (const read of [async () => { throw new Error('Storage'); }, async () => null,
    async () => ({ ...health(), codes: ['PRIVATE ARBITRARY TEXT'] }), async () => ({ ...health(), checkedAt: 'invalid' })]) {
    deps.readHealth = read;
    const result = await handleAttendanceWarning(request('/api/m1-attendance-warning'), deps);
    assert.equal(result.status, 503); assert.match((await result.json()).message, /unavailable/);
  }
  deps.readHealth = async () => health();
  for (const origin of ['https://gib-live.netlify.app', 'https://gib-richmond-test.netlify.app', 'https://gib-richmond-live.netlify.app'])
    assert.equal((await handleAttendanceWarning(request('/api/m1-attendance-warning', null, { origin }), deps)).status, 403);
  assert.equal((await handleAttendanceWarning(request('/api/m1-attendance-warning?show=records'), deps)).status, 404);
});

test('public status cannot erase a warning using missing, future or stale clear evidence', async () => {
  const deps = dependencies();
  for (const checkedAt of [null, new Date(now + 60000).toISOString()]) {
    deps.readHealth = async () => ({ ...health(), state: 'clear', codes: [], checkedAt });
    assert.equal((await handleAttendanceWarning(request('/api/m1-attendance-warning'), deps)).status, 503);
  }
  deps.readHealth = async () => ({ ...health(), state: 'clear', codes: [], checkedAt: new Date(now - 30 * 60000).toISOString() });
  const stale = await (await handleAttendanceWarning(request('/api/m1-attendance-warning'), deps)).json();
  assert.equal(stale.status, 'attention'); assert.equal(stale.warnings[0].code, 'CHECK_OVERDUE');
});

test('incomplete or contradictory health never hides a tablet warning', async () => {
  const deps = dependencies(), fresh = { ...health(), state: 'clear', codes: [], checkedAt: new Date(now).toISOString() };
  for (const patch of [{ state: 'delivery-failed', failedCount: 1 }, { state: 'unknown' },
    { failedCount: undefined, pendingCount: undefined, unconfirmedCount: undefined },
    { unconfirmedCount: 1 }, { pendingCount: 1 }, { failedCount: -1 }]) {
    deps.readHealth = async () => ({ ...fresh, ...patch });
    const result = await handleAttendanceWarning(request('/api/m1-attendance-warning'), deps);
    assert.equal(result.status, 503);
    assert.match((await result.json()).message, /unavailable/);
  }
});
