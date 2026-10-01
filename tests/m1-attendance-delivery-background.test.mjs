import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttendanceDigest, defaultDigestConfiguration, datesThrough, DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { makeDigestBinding } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { enqueueAttendanceWorkflow, executeAttendanceWorkflowJob, workflowHealth, workflowDispatchSignature, WORKFLOW_DISPATCH_HEADER, WORKFLOW_DISPATCH_PATH } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';
import { handleAttendanceDeliveryBackground } from '../netlify/functions/m1-attendance-delivery-background.mjs';

const now = Date.parse('2026-09-25T02:30:00Z'), date = '2026-09-24', id = '00000000-0000-4000-8000-000000000011';
const scope = { target: 'test', syntheticRehearsal: true, profile: { installationId: 'rev', gymName: 'Synthetic Revolution' } };
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec', GIB_TEST_WEBHOOK_TOKEN: 'synthetic-transport-secret-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-12345678901234567890', GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true', GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: 'stu@example.invalid' };
const runtime = { target: 'test', adminActionToken: env.GIB_TEST_ADMIN_ACTION_TOKEN };
function fixture(issue = true) {
  let stamp = now, serial = 0;
  const entries = new Map(), dispatches = [], sends = [];
  const store = { async getWithMetadata(key) { return structuredClone(entries.get(key) || null); }, async set(key, raw, options) {
    const old = entries.get(key);
    if (options.onlyIfNew && old || options.onlyIfMatch && old?.etag !== options.onlyIfMatch) return { modified: false };
    const etag = String(++serial); entries.set(key, { data: JSON.parse(raw), etag }); return { modified: true, etag };
  } };
  const configuration = defaultDigestConfiguration(scope, env), binding = makeDigestBinding(id, 'scheduled', now);
  const snapshots = [{ gym: 'rev', attendance: { ok: true, ledger: { ok: true, complete: true, target: 'test', schema: 'm1-manager-review/v1', gym: 'rev', from: '2026-09-07', to: date,
    days: datesThrough(date).map(day => ({ date: day, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) } }, staff: { ok: true, complete: true, items: [] } }];
  const schedules = [{ gym: 'rev', timezone: 'America/New_York', days: datesThrough(date).map(day => ({ date: day, status: 'complete', observedAt: day + 'T12:00:00.000Z', sourceVersion: 'synthetic',
    occurrences: issue && day === date ? [{ label: 'SYNTHETIC class', startAt: day + 'T22:00:00.000Z', endAt: day + 'T23:00:00.000Z', cancelled: false }] : [] })) }];
  const input = { configuration, binding, due: 'due', digest: buildAttendanceDigest({ jobDate: date, snapshots, schedules, configuration, now }) };
  const deps = { scope, env, enabled: true, target: 'test', workflowStore: store, clock: () => stamp,
    context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } },
    backgroundFetch: async (url, init) => { dispatches.push({ url, init }); assert.ok(entries.has('workflow/jobs/' + id)); assert.equal(sends.length, 0); return new Response(null, { status: 202 }); },
    simulatedProvider: { identity: 'fixed-synthetic', send: async message => { sends.push(message); return new Response(JSON.stringify({ id: '00000000-0000-4000-8000-000000000001' }), { status: 200 }); } } };
  return { input, deps, entries, store, dispatches, sends, at: value => { stamp = value; } };
}
function request(body = { jobId: id }, signature) {
  const raw = JSON.stringify(body);
  return new Request(DIGEST_ORIGIN + WORKFLOW_DISPATCH_PATH, { method: 'POST', headers: { [WORKFLOW_DISPATCH_HEADER]: signature || workflowDispatchSignature(raw, runtime.adminActionToken) }, body: raw });
}

test('ordinary callback persists an exact job before one awaited signed 202 dispatch and performs no provider work', async () => {
  const h = fixture();
  await Promise.all([enqueueAttendanceWorkflow(h.input, runtime, h.deps), enqueueAttendanceWorkflow(h.input, runtime, h.deps)]);
  assert.equal(h.dispatches.length, 1); assert.equal(h.sends.length, 0);
  const { url, init } = h.dispatches[0]; assert.equal(url, DIGEST_ORIGIN + WORKFLOW_DISPATCH_PATH);
  assert.deepEqual(JSON.parse(init.body), { jobId: id }); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.headers[WORKFLOW_DISPATCH_HEADER], workflowDispatchSignature(init.body, runtime.adminActionToken));
  assert.deepEqual(h.entries.get('workflow/jobs/' + id).data.input, h.input);
  const changed = structuredClone(h.input); changed.due = 'not-due';
  await assert.rejects(() => enqueueAttendanceWorkflow(changed, runtime, h.deps), /JOB_CONFLICT/);
  assert.ok((await workflowHealth(scope, h.deps)).codes.includes('DELIVERY_UNCONFIRMED'));
});

test('background worker requires exact signed TEST job ID, owns awaited work, and duplicate completion does not send twice', async () => {
  const h = fixture(); await enqueueAttendanceWorkflow(h.input, runtime, h.deps);
  assert.equal((await handleAttendanceDeliveryBackground(request({ jobId: id }, '0'.repeat(64)), h.deps)).status, 403);
  assert.equal((await handleAttendanceDeliveryBackground(request({ jobId: id, injected: true }), h.deps)).status, 400);
  const first = await handleAttendanceDeliveryBackground(request(), h.deps); assert.equal(first.status, 200); assert.equal((await first.json()).complete, true);
  assert.equal(h.sends.length, 1);
  assert.equal((await handleAttendanceDeliveryBackground(request(), h.deps)).status, 200); assert.equal(h.sends.length, 1);
  const live = new Request('https://gib-live.netlify.app' + WORKFLOW_DISPATCH_PATH, { method: 'POST', body: JSON.stringify({ jobId: id }) });
  assert.equal((await handleAttendanceDeliveryBackground(live, h.deps)).status, 403);
});

test('busy processor leaves durable job queued; expired job cannot start an old message', async () => {
  const h = fixture(); await enqueueAttendanceWorkflow(h.input, runtime, h.deps);
  await h.store.set('workflow/processor', JSON.stringify({ owner: 'other', expiresAt: now + 60000 }), { onlyIfNew: true });
  assert.equal((await executeAttendanceWorkflowJob(id, scope, h.deps)).pending, true);
  assert.equal(h.entries.get('workflow/jobs/' + id).data.state, 'queued'); assert.equal(h.sends.length, 0);
  h.at(h.input.binding.expiresAt);
  assert.equal((await executeAttendanceWorkflowJob(id, scope, h.deps)).needsFreshCheck, true);
  assert.equal(h.sends.length, 0); assert.ok((await workflowHealth(scope, h.deps)).codes.includes('CHECK_INCOMPLETE'));
});

test('a worker failure after publishing clean health cannot become a false all-clear', async () => {
  const h = fixture(false); await enqueueAttendanceWorkflow(h.input, runtime, h.deps);
  const original = h.store.set;
  h.store.set = async (key, ...args) => { if (key.startsWith('workflow/messages/')) throw new Error('synthetic write failure'); return original(key, ...args); };
  await assert.rejects(() => executeAttendanceWorkflowJob(id, scope, h.deps), /JOB_UNCONFIRMED/);
  assert.equal(h.entries.get('workflow/health').data.complete, true);
  assert.equal(h.entries.get('workflow/job-head').data.state, 'needs-fresh-check');
  const health = await workflowHealth(scope, h.deps); assert.ok(health.codes.includes('CHECK_INCOMPLETE')); assert.notEqual(health.state, 'clear');
});

test('unconfirmed platform dispatch remains durable and visibly unconfirmed without any provider call', async () => {
  const h = fixture(); h.deps.backgroundFetch = async () => { throw new Error('synthetic response lost'); };
  await assert.rejects(() => enqueueAttendanceWorkflow(h.input, runtime, h.deps), /DISPATCH_UNCONFIRMED/);
  assert.equal(h.entries.get('workflow/jobs/' + id).data.state, 'dispatch-unconfirmed'); assert.equal(h.sends.length, 0);
  assert.ok((await workflowHealth(scope, h.deps)).codes.includes('DELIVERY_UNCONFIRMED'));
});
