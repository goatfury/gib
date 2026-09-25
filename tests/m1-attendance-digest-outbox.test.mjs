import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAttendanceDigest } from '../netlify/functions/m1-attendance-digest.mjs';
import { handleAttendanceDigestJob } from '../netlify/functions/m1-attendance-digest-job.mjs';
import { DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { digestSignature, makeDigestBinding, DIGEST_SIGNATURE_HEADER, captureDigestMessage } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';

const now = Date.parse('2026-09-25T02:30:00Z'), date = '2026-09-24';
const id = '00000000-0000-4000-8000-000000000001', id2 = '00000000-0000-4000-8000-000000000002';
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec', GIB_TEST_WEBHOOK_TOKEN: 'synthetic-transport-secret-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-12345678901234567890', GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true' };
function memory() {
  const entries = new Map(); let serial = 0;
  return { entries, async getWithMetadata(key) { const value = entries.get(key); return value ? structuredClone(value) : null; },
    async set(key, raw, options) { const prior = entries.get(key);
      if ((options.onlyIfNew && prior) || (options.onlyIfMatch && prior?.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = String(++serial); entries.set(key, { data: JSON.parse(raw), etag }); return { modified: true, etag };
    }, async *list({ prefix = '' } = {}) { yield { blobs: [...entries.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
    async delete(key) { entries.delete(key); } };
}
const gyms = () => [{ gym: 'rev', attendance: { ok: true, ledger: { ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true, gym: 'rev', from: '2026-09-07', to: date,
  days: datesThrough(date).map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) } }, staff: { ok: true, complete: true, items: [] } }];
function harness() {
  const store = memory(), tasks = [], calls = [], scheduleCalls = []; let stamp = now;
  const deps = { enabled: true, target: 'test', env, digestStore: store, clock: () => stamp,
    context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false }, waitUntil: p => tasks.push(p) },
    loadSchedules: async input => { scheduleCalls.push(input); return { gym: input.gym, timezone: 'America/New_York', days: input.dates.map(day => ({ date: day, status: 'complete', observedAt: day + 'T12:00:00.000Z', sourceVersion: 'confirmed-date-snapshot',
      occurrences: day === date ? [{ label: '6:00 PM TEST BJJ', startAt: date + 'T22:00:00.000Z', endAt: date + 'T23:00:00.000Z', cancelled: false }] : [] })) }; },
    fetch: async (_url, init) => { calls.push(JSON.parse(init.body)); return new Response(null, { status: 302 }); } };
  return { deps, store, tasks, calls, scheduleCalls, advance: ms => { stamp = now + ms; } };
}
function admin(body, { query = '', reviewer = 'Andrew Smith', origin = DIGEST_ORIGIN, token = 'x'.repeat(43), cookie = true } = {}) {
  const runtime = runtimeConfig(env, { admin: true, requestUrl: DIGEST_ORIGIN });
  const session = createAdminSession(reviewer, runtime.sessionSecret, now, 'x'.repeat(43));
  return new Request(origin + '/api/m1-attendance-digest' + query, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: origin,
    ...(cookie ? { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session)}` } : {}), [ADMIN_REQUEST_HEADER]: token }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function job(body, options = {}) {
  const raw = JSON.stringify(body);
  return new Request((options.origin || DIGEST_ORIGIN) + '/api/m1-attendance-digest-job', { method: 'POST', headers: { 'Content-Type': 'application/json',
    [DIGEST_SIGNATURE_HEADER]: options.signature || digestSignature(raw, env.GIB_TEST_ADMIN_ACTION_TOKEN) }, body: raw });
}
const body = (requestId = id, mode = 'scheduled') => ({ ...makeDigestBinding(requestId, mode, now), gyms: gyms() });

test('manual capture persists before its one supported dispatch; repeat and concurrent starts preserve the same original', async () => {
  const h = harness();
  h.deps.fetch = async (_url, init) => {
    const value = JSON.parse(init.body); h.calls.push(value);
    assert.ok(h.store.entries.has('requests/' + id)); assert.equal(value.action, 'attendanceDigestCapture');
    assert.equal(init.redirect, 'manual'); assert.ok(init.signal instanceof AbortSignal);
    return new Response(null, { status: 302 });
  };
  const requests = await Promise.all([handleAttendanceDigest(admin({ action: 'capture', requestId: id }), h.deps), handleAttendanceDigest(admin({ action: 'capture', requestId: id }), h.deps)]);
  assert.deepEqual(requests.map(r => r.status), [202, 202]); await Promise.all(h.tasks);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].adminName, 'Andrew Smith');
  assert.equal((await handleAttendanceDigest(admin({ action: 'capture', requestId: id }, { reviewer: 'Stuart Turner' }), h.deps)).status, 202);
  assert.equal(h.calls.length, 1);
});

test('scheduled repeated and concurrent invocations produce exactly one durable capture and stable message ID', async () => {
  const h = harness();
  const results = await Promise.all([handleAttendanceDigestJob(job(body()), h.deps), handleAttendanceDigestJob(job(body(id2)), h.deps)]);
  for (const response of results) { assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.state, 'captured'); assert.equal(value.messageId, 'm1-test-daily-' + date); }
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 1);
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('outbox/')).length, 1);
  assert.equal((await handleAttendanceDigestJob(job(body()), h.deps)).status, 200);
  const state = await (await handleAttendanceDigest(admin(), h.deps)).json();
  assert.equal(state.sendingEnabled, false); assert.equal(state.latest.state, 'captured'); assert.equal(state.latest.itemCount, 1);
  assert.equal(state.configuration.recipients.every(r => r.address === null), true);
  assert.equal(h.calls.length, 0, 'no mail provider or Google redispatch is used to capture');
});

test('capture failure remains durable and same daily message recovers without duplicate capture or erasing failure evidence', async () => {
  const h = harness(); h.deps.captureTransport = async () => { throw new Error('synthetic unavailable'); };
  const first = await (await handleAttendanceDigestJob(job(body()), h.deps)).json();
  assert.equal(first.state, 'failed');
  const failureKeys = [...h.store.entries.keys()].filter(key => key.startsWith('failures/'));
  assert.equal(failureKeys.length, 1);
  const failure = structuredClone(h.store.entries.get(failureKeys[0]));
  h.deps.captureTransport = captureDigestMessage;
  const recovered = await (await handleAttendanceDigestJob(job(body(id2)), h.deps)).json();
  assert.equal(recovered.state, 'captured'); assert.equal(recovered.messageId, first.messageId);
  assert.deepEqual(h.store.entries.get(failureKeys[0]), failure);
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 1);
});

test('a capture receipt with the wrong message ID is unconfirmed and cannot claim delivery', async () => {
  const h = harness(); h.deps.captureTransport = async () => ({ captured: true, messageId: 'different', contentHash: 'wrong' });
  const response = await handleAttendanceDigestJob(job(body()), h.deps);
  assert.equal(response.status, 200); assert.equal((await response.json()).state, 'failed');
  const latest = await (await handleAttendanceDigest(admin(), h.deps)).json(); assert.equal(latest.latest.state, 'failed');
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 0);
});

test('bad signatures, expiry, mismatched gym/scope and conflicting duplicate payloads are rejected before capture', async () => {
  const h = harness();
  for (const [value, options, status] of [[body(), { signature: '0'.repeat(64) }, 403], [{ ...body(), target: 'production' }, {}, 409],
    [{ ...body(), gyms: [{ ...gyms()[0], gym: 'richmond' }] }, {}, 409], [body(), { origin: 'https://gib-live.netlify.app' }, 403],
    [{ ...body(), createdAt: now - 60000, expiresAt: now }, {}, 410]]) {
    assert.equal((await handleAttendanceDigestJob(job(value, options), h.deps)).status, status);
  }
  assert.equal(h.store.entries.size, 0);
  assert.equal((await handleAttendanceDigestJob(job(body()), h.deps)).status, 200);
  const changed = body(); changed.gyms[0].staff.items.push({ id: 'new', kind: 'staff-conflict', staffName: 'TEST Staff', date, status: 'pending', summary: 'A different result.' });
  assert.equal((await handleAttendanceDigestJob(job(changed), h.deps)).status, 409);
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 1);
});

test('manual callback requires its persisted binding and both authorized reviewers see the same captured content', async () => {
  const h = harness(), value = body(id, 'manual');
  assert.equal((await handleAttendanceDigestJob(job(value), h.deps)).status, 404);
  await handleAttendanceDigest(admin({ action: 'capture', requestId: id }), h.deps); await Promise.all(h.tasks);
  assert.equal((await handleAttendanceDigestJob(job({ ...value, createdAt: now - 1, expiresAt: now + 59999 }), h.deps)).status, 409);
  assert.equal((await handleAttendanceDigestJob(job(value), h.deps)).status, 200);
  const one = await (await handleAttendanceDigest(admin(undefined, { query: '?requestId=' + id }), h.deps)).json();
  const two = await (await handleAttendanceDigest(admin(undefined, { query: '?requestId=' + id, reviewer: 'Stuart Turner' }), h.deps)).json();
  assert.deepEqual(one.latest, two.latest); assert.deepEqual(one.request, two.request);
  assert.equal(one.request.requestId, id); assert.equal(one.latest.messageId, one.request.messageId);
  assert.equal((await handleAttendanceDigest(admin(undefined, { cookie: false }), h.deps)).status, 401);
  assert.equal((await handleAttendanceDigest(admin(undefined, { token: 'wrong' }), h.deps)).status, 403);
});

test('before-due and unconfirmed cutoff ticks observe schedules without capturing messages', async () => {
  for (const confirmed of [true, false]) {
    const h = harness(); h.deps.env = { ...env, GIB_M1_DIGEST_CUTOFF_CONFIRMED: String(confirmed), GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME: '23:00' };
    const response = await handleAttendanceDigestJob(job(body()), h.deps);
    assert.equal(response.status, 200); assert.equal((await response.json()).state, confirmed ? 'not-due' : 'awaiting-configuration');
    assert.equal(h.scheduleCalls.length, 1); assert.equal(h.scheduleCalls[0].cutoffConfirmed, confirmed);
    assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('outbox/')).length, 0);
  }
});

test('failed attendance and schedule reads remain an explicit capture failure section, never empty all-clear', async () => {
  const h = harness(), value = body(); value.gyms[0].attendance = { ok: false, code: 'READ_FAILED' };
  value.gyms[0].staff = { ok: false, code: 'READ_FAILED' };
  h.deps.loadSchedules = async () => { throw new Error('unavailable'); };
  assert.equal((await handleAttendanceDigestJob(job(value), h.deps)).status, 200);
  const { latest } = await (await handleAttendanceDigest(admin(), h.deps)).json();
  assert.equal(latest.state, 'captured'); assert.equal(latest.itemCount, 0); assert.equal(latest.readFailures.length, 2);
  assert.match(latest.text, /could not be checked/); assert.doesNotMatch(latest.text, /No outstanding items were found/);
});

test('complete clean checks suppress daily email and unavailable persistence cannot falsely confirm capture', async () => {
  const h = harness(); h.deps.loadSchedules = async input => ({ gym: input.gym, timezone: 'America/New_York', days: input.dates.map(day => ({ date: day, status: 'complete', observedAt: day + 'T12:00:00.000Z', sourceVersion: 'known-empty', occurrences: [] })) });
  const response = await handleAttendanceDigestJob(job(body()), h.deps);
  assert.equal((await response.json()).state, 'suppressed'); assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 0);
  const broken = harness(); broken.store.set = async () => { throw new Error('storage unavailable'); };
  assert.equal((await handleAttendanceDigestJob(job(body()), broken.deps)).status, 503);
  assert.equal((await handleAttendanceDigest(admin({ action: 'capture', requestId: id }), broken.deps)).status, 503);
  assert.equal(broken.calls.length, 0);
});

test('manual request expiry remains unavailable and configuration cannot enable mail or add recipients/gyms', async () => {
  const h = harness(); await handleAttendanceDigest(admin({ action: 'capture', requestId: id }), h.deps); await Promise.all(h.tasks);
  h.advance(60000);
  const state = await (await handleAttendanceDigest(admin(undefined, { query: '?requestId=' + id }), h.deps)).json();
  assert.equal(state.request.state, 'expired'); assert.equal(state.latest, null);
  assert.equal((await handleAttendanceDigest(admin({ action: 'configure', dailyLocalTime: '22:15', sendingEnabled: true }), h.deps)).status, 400);
  assert.equal((await handleAttendanceDigest(admin({ action: 'configure', dailyLocalTime: '22:15', recipients: [] }), h.deps)).status, 400);
  const updated = await (await handleAttendanceDigest(admin({ action: 'configure', dailyLocalTime: '22:15' }), h.deps)).json();
  assert.equal(updated.sendingEnabled, false); assert.equal(updated.configuration.cutoffConfirmed, true); assert.equal(updated.configuration.dailyLocalTime, '22:15');
});

test('a callback that expires while loading schedule cannot capture a stale result', async () => {
  const h = harness(), loader = h.deps.loadSchedules;
  h.deps.loadSchedules = async input => { const value = await loader(input); h.advance(60000); return value; };
  const response = await handleAttendanceDigestJob(job(body()), h.deps);
  assert.equal(response.status, 410); assert.equal((await response.json()).code, 'DIGEST_REQUEST_EXPIRED');
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/') || key.startsWith('outbox/')).length, 0);
});

test('corrupt captured content cannot be presented as a confirmed exact email', async () => {
  const h = harness(); await handleAttendanceDigestJob(job(body()), h.deps);
  h.store.entries.get('outbox/m1-test-daily-' + date).data.html += 'changed';
  const response = await handleAttendanceDigest(admin(), h.deps);
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'DIGEST_OUTBOX_INCOMPLETE');
});

test('lost final job confirmation recovers the same durable capture exactly once', async () => {
  const h = harness(), set = h.store.set; let failFinal = true;
  h.store.set = async (key, raw, options) => {
    if (failFinal && key === 'requests/' + id && JSON.parse(raw).state === 'captured') { failFinal = false; throw new Error('Final status connection lost'); }
    return set(key, raw, options);
  };
  assert.equal((await handleAttendanceDigestJob(job(body()), h.deps)).status, 503);
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 1);
  const recovered = await (await handleAttendanceDigestJob(job(body()), h.deps)).json();
  assert.equal(recovered.state, 'captured'); assert.equal(recovered.messageId, 'm1-test-daily-' + date);
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 1);
});

test('manual delivery failure recovers the original captured artifact without a new Google request or changed message ID', async () => {
  const h = harness(); await handleAttendanceDigest(admin({ action: 'capture', requestId: id }), h.deps); await Promise.all(h.tasks);
  h.deps.captureTransport = async () => { throw new Error('Capture unavailable'); };
  const first = await (await handleAttendanceDigestJob(job(body(id, 'manual')), h.deps)).json();
  assert.equal(first.state, 'failed');
  h.advance(61000); h.deps.captureTransport = captureDigestMessage;
  const response = await handleAttendanceDigest(admin({ action: 'capture', requestId: id }, { reviewer: 'Stuart Turner' }), h.deps);
  assert.equal(response.status, 200);
  const recovered = await response.json(); assert.equal(recovered.state, 'captured'); assert.equal(recovered.messageId, first.messageId);
  assert.equal(h.calls.length, 1); assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('captures/')).length, 1);
  assert.equal([...h.store.entries.keys()].filter(key => key.startsWith('failures/')).length, 1);
});

test('scope, unavailable runtime and signature rejection have distinct sanitized categories without touching capture storage', async () => {
  for (const [mode, status, code, stage] of [['scope', 403, 'DIGEST_SCOPE_REQUIRED', 'job.scope'],
    ['runtime', 503, 'DIGEST_RUNTIME_UNAVAILABLE', 'job.runtime'],
    ['signature', 403, 'DIGEST_AUTHENTICATION_FAILED', 'job.authentication']]) {
    const h = harness(), logs = [];
    h.deps.traceLog = (prefix, raw) => logs.push([prefix, JSON.parse(raw)]);
    h.deps.context.requestId = 'sanitized-invocation-123';
    if (mode === 'scope') h.deps.context.site.id = 'wrong-site';
    if (mode === 'runtime') h.deps.env = { ...env, GIB_TEST_ADMIN_ACTION_TOKEN: '' };
    const response = await handleAttendanceDigestJob(job(body(), mode === 'signature' ? { signature: '0'.repeat(64) } : {}), h.deps);
    assert.equal(response.status, status, mode); assert.deepEqual(await response.json(), { ok: false, code }, mode);
    assert.equal(h.store.entries.size, 0); assert.equal(h.scheduleCalls.length, 0);
    assert.equal(logs.length, 1); assert.equal(logs[0][0], 'M1_TEST_DIGEST_JOB_STAGE');
    assert.deepEqual(logs[0][1], { requestId: mode === 'signature' ? id : null, invocation: 'sanitized-invocation-123', stage, status, code, elapsedMs: 0 });
    assert.doesNotMatch(JSON.stringify(logs), /synthetic-admin-secret|synthetic-transport-secret|attendanceHash|gyms|staffName|6:00|http/);
  }
});

test('diagnostic logging failures cannot change capture or expose unallowlisted error contents', async () => {
  const h = harness(); h.deps.traceLog = () => { throw new Error('logging unavailable'); };
  assert.equal((await handleAttendanceDigestJob(job(body()), h.deps)).status, 200);
  const broken = harness(), logs = [];
  broken.deps.traceLog = (prefix, raw) => logs.push([prefix, JSON.parse(raw)]);
  broken.store.getWithMetadata = async () => { throw Object.assign(new Error('PRIVATE payload'), { code: 'PRIVATE_ERROR_CONTENT' }); };
  const response = await handleAttendanceDigestJob(job(body()), broken.deps);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, code: 'DIGEST_JOB_UNAVAILABLE' });
  assert.equal(logs[0][1].stage, 'job.capture'); assert.equal(logs[0][1].requestId, id);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
});
