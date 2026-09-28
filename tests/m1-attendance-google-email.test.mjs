import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAttendanceGoogleEmail } from '../netlify/functions/m1-attendance-google-email.mjs';
import { handleAttendanceWorkflowBackground } from '../netlify/functions/m1-attendance-workflow-background.mjs';
import { googleEmailTestState, queueGoogleEmailTest, runGoogleEmailTest, checkGoogleEmailOriginal, disableGoogleEmailTest,
  GOOGLE_EMAIL_TEST_ID, GOOGLE_EMAIL_TEST_REQUEST_ID } from '../netlify/functions/_lib/m1-attendance-google-email-test.mjs';
import { processAttendanceWorkflow } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';
import { changeHistoryMessage } from '../netlify/functions/_lib/m1-attendance-workflow-history.mjs';
import { digestHash, DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';

const START = Date.parse('2026-09-28T18:00:00.000Z'), ROOT = 'google-email-test/2026-09-28/';
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-transport-secret-1234567890', GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-12345678901234567890',
  GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'false' };
function harness() {
  let now = START, version = 0, google = null, failSendReply = false;
  const entries = new Map(), calls = [], dispatches = [];
  const store = {
    async getWithMetadata(key, options) { assert.equal(options.consistency, 'strong'); return structuredClone(entries.get(key) || null); },
    async set(key, raw, options) {
      assert.ok(options.onlyIfNew === true || typeof options.onlyIfMatch === 'string');
      const old = entries.get(key); if (options.onlyIfNew && old || options.onlyIfMatch && old?.etag !== options.onlyIfMatch) return { modified: false };
      const etag = 'opaque-' + ++version; entries.set(key, { etag, data: JSON.parse(raw) }); return { modified: true, etag };
    }
  };
  const runtime = runtimeConfig(env, { admin: true, requestUrl: DIGEST_ORIGIN, installationId: 'rev' });
  const deps = { env: { ...env }, runtime, scope: { target: 'test', profile: { installationId: 'rev', gymName: 'Revolution TEST' } },
    enabled: true, target: 'test', workflowStore: store, clock: () => now,
    context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } },
    async fetch(url, options) {
      assert.equal(url, env.GIB_TEST_WEBHOOK_URL); const body = JSON.parse(options.body); calls.push(body);
      assert.ok(['attendanceMailStatus', 'attendanceMailSend'].includes(body.action));
      if (body.action === 'attendanceMailSend') {
        assert.equal(entries.get(ROOT + 'authorization').data.state, 'consumed');
        const delivery = entries.get('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID);
        assert.ok(delivery, 'shared durable MailApp claim precedes network');
        google ||= { attemptedAt: new Date(now).toISOString(), completedAt: new Date(now + 1).toISOString() };
        if (failSendReply) throw new Error('synthetic lost reply');
      }
      const state = google ? 'submitted' : 'not-attempted';
      return new Response(JSON.stringify({ ok: true, target: 'test', gym: 'rev', messageId: body.message.messageId, hash: body.message.hash,
        state, code: google ? 'MAILAPP_SUBMITTED' : 'MAILAPP_READY', attemptedAt: google?.attemptedAt || null, completedAt: google?.completedAt || null, retrySafe: !google }), { status: 200 });
    }, async dispatchGoogleEmail(requestId) { dispatches.push(requestId); }
  };
  return { deps, entries, calls, dispatches, store, at(value) { now = value; }, loseReply() { failSendReply = true; },
    sends() { return calls.filter(value => value.action === 'attendanceMailSend'); },
    request(body, opts = {}) {
      const token = 'x'.repeat(43), session = createAdminSession('Andrew Smith', runtime.sessionSecret, now, token);
      return new Request((opts.origin || DIGEST_ORIGIN) + (opts.path || '/api/m1-attendance-google-email') + (opts.query || ''), {
        method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: opts.requestOrigin || opts.origin || DIGEST_ORIGIN,
          ...(opts.cookie === false ? {} : { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session)}` }), ...(opts.token === false ? {} : { [ADMIN_REQUEST_HEADER]: token }) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } };
}
const sendBody = value => ({ action: 'sendApprovedTest', messageId: value.message.messageId, hash: value.message.hash });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('authenticated preparation persists one exact fictional message with no Google call or recurring setting change', async () => {
  const h = harness(), response = await handleAttendanceGoogleEmail(h.request(), h.deps), value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.message.messageId, GOOGLE_EMAIL_TEST_ID); assert.equal(value.requestId, GOOGLE_EMAIL_TEST_REQUEST_ID);
  assert.equal(value.message.from, 'revbjjops@gmail.com'); assert.deepEqual(value.message.to, ['revbjjops@gmail.com']); assert.deepEqual(value.message.cc, []);
  assert.equal(value.message.synthetic, true); assert.equal(value.recurringEnabled, false); assert.equal(value.readiness.generalSendingEnabled, false);
  assert.equal(value.sendingEnabled, true); assert.equal(value.readiness.ready, true); assert.equal(value.delivery.state, 'not-started');
  assert.match(value.message.text, /Prepared 2026-09-28T18:00:00.000Z/); assert.match(value.message.text, /FICTIONAL instructor class/); assert.match(value.message.text, /FICTIONAL Staff Clock/);
  assert.match(value.message.text, /https:\/\/deploy-preview-89--gib-live.netlify.app\/m1\/admin/);
  assert.doesNotMatch(value.message.text + value.message.html, /TEST CAPTURE|sending disabled|capture preview/);
  assert.equal(h.calls.length, 0); const original = structuredClone(h.entries.get(ROOT + 'original').data);
  h.at(START + 5 * 60000); assert.deepEqual((await googleEmailTestState(h.deps)).message, value.message);
  assert.deepEqual(h.entries.get(ROOT + 'original').data, original); assert.equal(h.deps.env.GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED, 'false');
  h.deps.env.GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED = 'true'; const enabled = await googleEmailTestState(h.deps);
  assert.equal(enabled.readiness.generalSendingEnabled, true); assert.equal(enabled.sendingEnabled, false);
});

test('the approved background run traverses the real workflow/history/MailApp once and closes its single authorization', async () => {
  const h = harness(), value = await googleEmailTestState(h.deps);
  const response = await handleAttendanceGoogleEmail(h.request(sendBody(value)), h.deps), queued = await response.json();
  assert.equal(response.status, 202); assert.equal(queued.request.state, 'pending'); assert.equal(queued.sendingEnabled, false);
  assert.deepEqual(h.dispatches, [value.requestId]); assert.equal(h.sends().length, 0);
  const background = await handleAttendanceWorkflowBackground(h.request({ action: 'runGoogleEmail', requestId: value.requestId }, { path: '/api/m1-attendance-workflow-background' }), h.deps);
  assert.equal(background.status, 200); const result = await googleEmailTestState(h.deps);
  assert.equal(result.delivery.state, 'submitted'); assert.equal(result.delivery.deliveryConfirmed, false); assert.equal(result.request.state, 'complete');
  assert.equal(result.sendingEnabled, false); assert.equal(h.sends().length, 1); assert.deepEqual(h.sends()[0].message, value.message);
  assert.equal(h.entries.get(ROOT + 'authorization').data.state, 'closed');
  assert.ok(h.entries.has(ROOT + 'engine/workflow/history/root')); assert.ok(h.entries.has('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID));
  assert.equal(h.entries.has('workflow/messages/' + GOOGLE_EMAIL_TEST_ID), false); assert.equal(h.entries.has('workflow/health'), false);
  assert.equal(h.deps.env.GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED, 'false');
  await Promise.all([runGoogleEmailTest(value.requestId, h.deps), runGoogleEmailTest(value.requestId, h.deps)]);
  assert.equal((await queueGoogleEmailTest(value.message.messageId, value.message.hash, h.deps)).dispatch, false); assert.equal(h.sends().length, 1);
});

test('wrong auth, gym, origin, hash or extra recipient cannot prepare or dispatch the fixed message', async () => {
  for (const opts of [{ cookie: false }, { token: false }, { origin: 'https://gib-live.netlify.app' }, { origin: 'https://gib-richmond-test.netlify.app' }, { requestOrigin: 'https://other.invalid' }]) {
    const h = harness(), response = await handleAttendanceGoogleEmail(h.request(undefined, opts), h.deps);
    assert.ok([401, 403].includes(response.status)); assert.equal(h.entries.size, 0); assert.equal(h.calls.length, 0);
  }
  const h = harness(), value = await googleEmailTestState(h.deps);
  for (const body of [{ ...sendBody(value), hash: '0'.repeat(64) }, { ...sendBody(value), messageId: 'm1-test-email-andrew-20260926-v1' }, { ...sendBody(value), to: ['other@example.invalid'] }]) {
    assert.ok([400, 409].includes((await handleAttendanceGoogleEmail(h.request(body), h.deps)).status));
  }
  assert.equal(h.dispatches.length, 0); assert.equal(h.sends().length, 0);
  await assert.rejects(runGoogleEmailTest('00000000-0000-4000-8000-000000000099', h.deps), /ORIGINAL_REQUIRED/);
});

test('shared same-day workflow/provider history blocks fictional replacement without altering retained originals', async () => {
  for (const key of ['workflow/messages/' + GOOGLE_EMAIL_TEST_ID, 'workflow/delivery/messages/' + GOOGLE_EMAIL_TEST_ID,
    'workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID]) {
    const h = harness(), old = { permanentId: 'retained-original', message: { hash: 'another-original' } };
    h.entries.set(key, { etag: 'untouched', data: structuredClone(old) });
    const value = await googleEmailTestState(h.deps); assert.equal(value.sendingEnabled, false); assert.equal(value.readiness.ready, false);
    await assert.rejects(queueGoogleEmailTest(value.message.messageId, value.message.hash, h.deps), /NOT_READY/);
    assert.deepEqual(h.entries.get(key), { etag: 'untouched', data: old }); assert.equal(h.calls.length, 0);
  }
});

test('global prior recipient, route, and unsafe-storage holds remain authoritative and are never copied or cleared', async () => {
  for (const group of ['unsafe/rev', 'bounce/rev/' + digestHash(['revbjjops@gmail.com']),
    'reject/rev/' + digestHash(['revbjjops@gmail.com', ['revbjjops@gmail.com'], [], digestHash('m1-mailapp-business/v1\nrevbjjops@gmail.com')])]) {
    const h = harness(), id = 'm1-test-scheduled-rev-2026-09-27';
    const record = { messageId: id, date: '2026-09-27', checkAt: START - 86400000 };
    await changeHistoryMessage(h.store, id, { etag: null, value: record }, async entry => ({ messageId: id, gym: 'rev', date: record.date,
      sourceEtag: entry.etag, groups: [group], unattempted: false, checkAt: record.checkAt, counts: { failed: 1, unconfirmed: 0, pending: 0, configuration: 0 } }));
    const before = structuredClone([...h.entries]); const state = await googleEmailTestState(h.deps);
    assert.equal(state.sendingEnabled, false); assert.ok(state.readiness.codes.includes('GOOGLE_EMAIL_EXISTING_DELIVERY_HOLD'));
    await assert.rejects(queueGoogleEmailTest(state.message.messageId, state.message.hash, h.deps), /NOT_READY/);
    for (const [key, value] of before) assert.deepEqual(h.entries.get(key), value);
    assert.equal(h.calls.length, 0);
  }
});

test('checkOriginal has status-only transport even before a send and never creates a claim or changes reviewed content', async () => {
  const h = harness(), value = await googleEmailTestState(h.deps), original = structuredClone(h.entries.get(ROOT + 'original').data);
  const response = await handleAttendanceGoogleEmail(h.request({ ...sendBody(value), action: 'checkOriginal' }), h.deps), checked = await response.json();
  assert.equal(response.status, 200); assert.equal(checked.delivery.state, 'not-started'); assert.equal(h.sends().length, 0);
  assert.deepEqual(h.calls.map(call => call.action), ['attendanceMailStatus']); assert.equal(h.entries.has('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID), false);
  assert.deepEqual(h.entries.get(ROOT + 'original').data, original);
});

test('status-only recovery cannot retry a proven no-call claim or confirm an original whose local claim is missing', async () => {
  const h = harness(), value = await googleEmailTestState(h.deps), ordinaryFetch = h.deps.fetch;
  h.deps.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action !== 'attendanceMailSend') return ordinaryFetch(url, options);
    h.calls.push(body); return new Response(JSON.stringify({ ok: false, target: 'test', gym: 'rev', messageId: body.message.messageId, hash: body.message.hash,
      state: 'not-attempted', code: 'MAILAPP_QUOTA_UNAVAILABLE', attemptedAt: null, completedAt: null, retrySafe: true }), { status: 200 });
  };
  await queueGoogleEmailTest(value.message.messageId, value.message.hash, h.deps); await runGoogleEmailTest(value.requestId, h.deps);
  h.at(START + 16 * 60000); const claim = structuredClone(h.entries.get('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID).data);
  await checkGoogleEmailOriginal(h.deps); assert.equal(h.sends().length, 1);
  assert.deepEqual(h.entries.get('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID).data, claim);
  const missing = harness(), prepared = await googleEmailTestState(missing.deps);
  missing.deps.fetch = async () => new Response(JSON.stringify({ ok: true, target: 'test', gym: 'rev', messageId: GOOGLE_EMAIL_TEST_ID, hash: prepared.message.hash,
    state: 'submitted', code: 'MAILAPP_SUBMITTED', attemptedAt: new Date(START).toISOString(), completedAt: new Date(START + 1).toISOString(), retrySafe: false }), { status: 200 });
  const result = await checkGoogleEmailOriginal(missing.deps); assert.equal(result.delivery.state, 'unknown'); assert.equal(result.delivery.durableAttempt, undefined);
  assert.equal(result.delivery.code, 'MAILAPP_ORIGINAL_LOCAL_CLAIM_MISSING'); assert.equal(missing.entries.has('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID), false);
});

test('a lost send reply closes authorization and later status recovery preserves the original without another send', async () => {
  const h = harness(), value = await googleEmailTestState(h.deps); h.loseReply(); await queueGoogleEmailTest(value.message.messageId, value.message.hash, h.deps);
  await runGoogleEmailTest(value.requestId, h.deps); assert.equal(h.sends().length, 1);
  const before = structuredClone(h.entries.get('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID).data);
  const recovered = await checkGoogleEmailOriginal(h.deps); assert.equal(recovered.delivery.state, 'submitted'); assert.equal(recovered.sendingEnabled, false);
  assert.deepEqual(h.entries.get('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID).data, before);
  await runGoogleEmailTest(value.requestId, h.deps); assert.equal(h.sends().length, 1);
});

test('concurrent background calls consume exactly one grant and expiry/explicit stop cannot rearm it', async () => {
  const h = harness(), value = await googleEmailTestState(h.deps); await queueGoogleEmailTest(value.message.messageId, value.message.hash, h.deps);
  await Promise.all([runGoogleEmailTest(value.requestId, h.deps), runGoogleEmailTest(value.requestId, h.deps)]); assert.equal(h.sends().length, 1);
  const stopped = harness(), original = await googleEmailTestState(stopped.deps); await queueGoogleEmailTest(original.message.messageId, original.message.hash, stopped.deps);
  await disableGoogleEmailTest(stopped.deps); await runGoogleEmailTest(original.requestId, stopped.deps); assert.equal(stopped.sends().length, 0);
  const expired = harness(), prepared = await googleEmailTestState(expired.deps); expired.at(START + 30 * 60000);
  assert.equal((await googleEmailTestState(expired.deps)).sendingEnabled, false);
  await assert.rejects(queueGoogleEmailTest(prepared.message.messageId, prepared.message.hash, expired.deps), /NOT_READY/);
  assert.equal(expired.sends().length, 0);
});

test('expiry or explicit stop during the final global-hold read prevents the actual Google Send call', async () => {
  for (const mode of ['expiry', 'stop']) {
    const h = harness(), value = await googleEmailTestState(h.deps); await queueGoogleEmailTest(value.message.messageId, value.message.hash, h.deps);
    h.at(START + 290000); const paused = deferred(), entered = deferred(), get = h.store.getWithMetadata; let pausedOnce = false;
    h.store.getWithMetadata = async (key, options) => {
      if (!pausedOnce && key === 'workflow/messages/' + GOOGLE_EMAIL_TEST_ID && h.entries.has('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID)) {
        pausedOnce = true; entered.resolve(); await paused.promise;
      }
      return get(key, options);
    };
    const work = runGoogleEmailTest(value.requestId, h.deps); await entered.promise;
    if (mode === 'expiry') h.at(START + 300000); else await disableGoogleEmailTest(h.deps);
    paused.resolve(); await work;
    assert.equal(h.sends().length, 0); assert.ok(h.entries.has('workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID));
    assert.equal((await googleEmailTestState(h.deps)).sendingEnabled, false);
  }
});

test('unreadable authorization fails closed and a workflow exception still consumes and disables the original', async () => {
  const h = harness(), value = await googleEmailTestState(h.deps); await queueGoogleEmailTest(value.message.messageId, value.message.hash, h.deps);
  h.deps.processWorkflow = async () => { throw new Error('synthetic workflow failure'); };
  await assert.rejects(runGoogleEmailTest(value.requestId, h.deps), /synthetic workflow failure/);
  assert.equal(h.entries.get(ROOT + 'authorization').data.state, 'closed'); assert.equal((await googleEmailTestState(h.deps)).sendingEnabled, false); assert.equal(h.sends().length, 0);
  h.store.getWithMetadata = async () => { throw new Error('private storage detail'); };
  const response = await handleAttendanceGoogleEmail(h.request(), h.deps), body = await response.json();
  assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(body), /private storage detail/);
});

test('the server transform rejects changed recipients and preserves ordinary workflow validation', async () => {
  const captured = harness(), value = await googleEmailTestState(captured.deps); let input;
  captured.deps.processWorkflow = async current => { input = structuredClone(current); };
  await queueGoogleEmailTest(value.message.messageId, value.message.hash, captured.deps); await runGoogleEmailTest(value.requestId, captured.deps);
  const h = harness();
  await assert.rejects(processAttendanceWorkflow(input, { ...h.deps, transformMessage: message => ({ ...message, to: ['different@example.invalid'] }) }), /WORKFLOW_MESSAGE_TRANSFORM_INVALID/);
  assert.equal(h.sends().length, 0);
});
