import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttendanceDigest, defaultDigestConfiguration, datesThrough } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { makeDigestBinding } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, enqueueAttendanceWorkflow, executeAttendanceWorkflowJob, workflowMessages, workflowDispatchSignature, WORKFLOW_DISPATCH_HEADER, WORKFLOW_DISPATCH_PATH } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';
import { handleAttendanceDeliveryBackground } from '../netlify/functions/m1-attendance-delivery-background.mjs';
import { handleAttendanceWorkflow } from '../netlify/functions/m1-attendance-workflow.mjs';
import { handleAttendanceWorkflowBackground } from '../netlify/functions/m1-attendance-workflow-background.mjs';
import { handleAttendanceWarning } from '../netlify/functions/m1-attendance-warning.mjs';
import { runtimeConfig, createAdminSession, ADMIN_COOKIE, ADMIN_REQUEST_HEADER } from '../netlify/functions/_lib/m1-common.mjs';
const ORIGIN = 'https://gib-richmond-test.netlify.app', NOW = Date.parse('2026-09-29T01:00:00Z'), DATE = '2026-09-28';
const ID = '00000000-0000-4000-8000-000000000031';
const scope = { target: 'test', profile: { installationId: 'richmond', environment: 'test', gymName: 'Richmond BJJ' } };
const env = { GIB_M1_ENVIRONMENT: 'test', GIB_RICHMOND_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND/exec',
  GIB_RICHMOND_TEST_WEBHOOK_TOKEN: 'synthetic-richmond-receiver-1234567890', GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN: 'synthetic-richmond-admin-1234567890123' };
const runtime = runtimeConfig(env, { admin: true, requestUrl: ORIGIN, installationId: 'richmond', environment: 'test' });
function fixture() {
  let serial = 0;
  const entries = new Map(), dispatches = [], calls = [];
  const store = { async getWithMetadata(key) { return structuredClone(entries.get(key) || null); }, async set(key, raw, options) {
    const before = entries.get(key); if (options.onlyIfNew && before || options.onlyIfMatch && before?.etag !== options.onlyIfMatch) return { modified: false };
    const etag = String(++serial); entries.set(key, { data: JSON.parse(raw), etag }); return { modified: true, etag };
  } };
  const configuration = defaultDigestConfiguration(scope, {}), binding = makeDigestBinding(ID, 'scheduled', NOW);
  const days = datesThrough(DATE), snapshots = [{ gym: 'richmond', attendance: { ok: true, ledger: { ok: true, complete: true, target: 'test', schema: 'm1-manager-review/v1', gym: 'richmond', from: '2026-09-07', to: DATE,
    days: days.map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) } } }];
  const schedules = [{ gym: 'richmond', timezone: 'America/New_York', days: days.map(date => ({ date, status: 'complete', observedAt: date + 'T12:00:00.000Z', sourceVersion: 'test-fixture',
    occurrences: date === DATE ? [{ label: '6:00 PM TEST class', startAt: date + 'T22:00:00.000Z', endAt: date + 'T23:00:00.000Z', cancelled: false }] : [] })) }];
  const input = { configuration, binding, due: 'due', digest: buildAttendanceDigest({ jobDate: DATE, snapshots, schedules, configuration, now: NOW }) };
  const deps = { scope, env, enabled: true, target: 'test', installationId: 'richmond', environment: 'test', workflowStore: store, clock: () => NOW,
    context: { site: { id: '42736c77-e3c8-40aa-ba97-4f935d0999ad', name: 'gib-richmond-test' }, deploy: { context: 'production', published: true } },
    backgroundFetch: async (url, init) => { dispatches.push({ url, init }); return new Response(null, { status: 202 }); },
    fetch: async (...args) => { calls.push(args); throw new Error('No real network permitted'); } };
  return { input, deps, store, entries, dispatches, calls };
}
function request(path, body, { authenticated = true, origin = ORIGIN } = {}) {
  const token = 'r'.repeat(43), session = createAdminSession('Andrew Smith', runtime.sessionSecret, NOW, token, runtime);
  return new Request(origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json',
    ...(authenticated ? { Cookie: ADMIN_COOKIE + '=' + encodeURIComponent(session), [ADMIN_REQUEST_HEADER]: token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
test('Richmond real-data workflow uses its own daily identity, recipient and links with Staff Clock and sending disabled', async () => {
  const h = fixture(); const result = await processAttendanceWorkflow(h.input, h.deps);
  assert.equal(h.input.digest.syntheticRehearsal, undefined); assert.equal(h.input.configuration.gyms[0].staffClockEnabled, false);
  assert.deepEqual(h.input.digest.groups.map(group => group.gym), ['richmond']); assert.equal(h.input.digest.readFailures.length, 0);
  assert.equal(h.calls.length, 0); assert.ok(result.codes.includes('CONFIGURATION_REQUIRED'));
  const { messages } = await workflowMessages(scope, h.deps); assert.equal(messages.length, 1);
  const value = messages[0]; assert.equal(value.messageId, 'm1-test-scheduled-richmond-' + DATE); assert.equal(value.message.synthetic, false);
  assert.deepEqual(value.message.to, ['info@richmondbjj.com']); assert.match(value.message.text, /gib-richmond-test/);
  assert.doesNotMatch(value.message.text, /deploy-preview-89|forgotten staff|Staff Clock/); assert.equal(value.firstAttemptAt, null);
  assert.equal(value.code, 'SCHEDULED_SENDING_DISABLED');
});
test('Richmond background uses exact local HMAC/runtime and rejects cross-gym jobs before storage mutation', async () => {
  const h = fixture(); await enqueueAttendanceWorkflow(h.input, runtime, h.deps);
  assert.equal(h.dispatches.length, 1); const sent = h.dispatches[0]; assert.equal(sent.url, ORIGIN + WORKFLOW_DISPATCH_PATH);
  const signed = new Request(sent.url, { method: 'POST', headers: sent.init.headers, body: sent.init.body });
  assert.equal((await handleAttendanceDeliveryBackground(signed, h.deps)).status, 200);
  assert.equal(h.calls.length, 0); assert.equal(h.entries.get('workflow/jobs/' + ID).data.state, 'complete');
  const other = fixture(), revScope = { target: 'test', profile: { installationId: 'rev', gymName: 'Revolution BJJ' } };
  for (const run of [() => processAttendanceWorkflow(other.input, { ...other.deps, scope: revScope }),
    () => enqueueAttendanceWorkflow(other.input, runtime, { ...other.deps, scope: revScope })]) await assert.rejects(run, /WORKFLOW_TEST_SCOPE_REQUIRED/);
  assert.equal(other.entries.size, 0);
  const raw = JSON.stringify({ jobId: ID });
  const bad = new Request(ORIGIN + WORKFLOW_DISPATCH_PATH, { method: 'POST', headers: { [WORKFLOW_DISPATCH_HEADER]: workflowDispatchSignature(raw, 'other-gym-secret') }, body: raw });
  assert.equal((await handleAttendanceDeliveryBackground(bad, h.deps)).status, 403);
});
test('Richmond Admin reads actual own history, excludes synthetic suites, and public failures cannot claim clear', async () => {
  const h = fixture(); await processAttendanceWorkflow(h.input, h.deps);
  h.deps.readExamples = () => { throw new Error('Richmond must not read Revolution synthetic examples'); };
  const response = await handleAttendanceWorkflow(request('/api/m1-attendance-workflow'), h.deps); assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.latestRun, null); assert.equal(value.current.messages.messages[0].gym, 'richmond');
  assert.equal(value.setup.richmondTo, 'info@richmondbjj.com');
  assert.equal((await handleAttendanceWorkflow(request('/api/m1-attendance-workflow', null, { authenticated: false }), h.deps)).status, 401);
  for (const handler of [handleAttendanceWorkflow, handleAttendanceWorkflowBackground]) {
    const path = handler === handleAttendanceWorkflow ? '/api/m1-attendance-workflow' : '/api/m1-attendance-workflow-background';
    assert.equal((await handler(request(path, { action: 'runExamples', requestId: ID }), h.deps)).status, 403);
  }
  const publicResponse = await handleAttendanceWarning(request('/api/m1-attendance-warning', null, { authenticated: false }), h.deps);
  const warning = await publicResponse.json(); assert.equal(warning.gym, 'richmond'); assert.notEqual(warning.status, 'clear'); assert.ok(warning.warnings.some(value => value.code === 'CONFIGURATION_REQUIRED'));
  assert.doesNotMatch(JSON.stringify(warning), /info@|Andrew|class|messageId|receipts/);
  const failed = await handleAttendanceWarning(request('/api/m1-attendance-warning'), { ...h.deps, readHealth: async () => { throw new Error('Read unavailable'); } });
  assert.equal(failed.status, 503); assert.equal((await failed.json()).gym, 'richmond');
  const fresh = { ok: true, target: 'test', state: 'clear', codes: [], pendingCount: 0, failedCount: 0, unconfirmedCount: 0, checkedAt: new Date(NOW).toISOString() };
  assert.equal((await handleAttendanceWarning(request('/api/m1-attendance-warning'), { ...h.deps, readHealth: async () => fresh })).status, 200);
});

test('Richmond MailApp preflight uses only its bound receiver and outer installation fields; a disabled Google reply never sends', async () => {
  const h = fixture(), bodies = [];
  h.deps.env = { ...env, GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_ATTENDANCE_DIGEST_VERIFIED_SENDER: 'revbjjops@gmail.com',
    GIB_M1_ATTENDANCE_DIGEST_VERIFIED_RECIPIENTS: 'info@richmondbjj.com,andrew@revolutionbjj.com' };
  h.deps.fetch = async (url, init) => {
    assert.equal(url, env.GIB_RICHMOND_TEST_WEBHOOK_URL); const body = JSON.parse(init.body); bodies.push(body);
    assert.equal(body.action, 'attendanceMailStatus');
    return new Response(JSON.stringify({ ok: false, target: 'test', gym: 'richmond', messageId: body.message.messageId, hash: body.message.hash,
      state: 'not-attempted', code: 'MAILAPP_DISABLED', attemptedAt: null, completedAt: null, retrySafe: true }), { status: 200 });
  };
  await processAttendanceWorkflow(h.input, h.deps); assert.ok(bodies.length > 0);
  for (const body of bodies) { assert.equal(body.gym, 'richmond'); assert.equal(body.installation, 'richmond'); assert.equal(body.environment, 'test');
    assert.equal(body.target, 'test'); assert.equal(body.token, env.GIB_RICHMOND_TEST_WEBHOOK_TOKEN); assert.match(body.message.messageId, /^m1-test-scheduled-richmond-/); }
  assert.equal([...h.entries.keys()].some(key => key.startsWith('workflow/delivery/mailapp/messages/')), false);
});
