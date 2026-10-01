import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAttendanceDigest } from '../netlify/functions/m1-attendance-digest.mjs';
import { handleAttendanceDigestJob } from '../netlify/functions/m1-attendance-digest-job.mjs';
import { DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { digestSignature, makeDigestBinding, DIGEST_SIGNATURE_HEADER } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';

const start = Date.parse('2026-09-25T18:00:15Z');
const id = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const rehearsalId = id(1);
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec', GIB_TEST_WEBHOOK_TOKEN: 'synthetic-transport-secret-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-12345678901234567890' };
function harness() {
  let now = start, serial = 0;
  const entries = new Map(), writes = [];
  const store = { async getWithMetadata(key) { return structuredClone(entries.get(key) || null); },
    async set(key, raw, options) {
      const prior = entries.get(key);
      if ((options.onlyIfNew && prior) || (options.onlyIfMatch && prior?.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = String(++serial); entries.set(key, { data: JSON.parse(raw), etag }); writes.push(key); return { modified: true, etag };
    } };
  const dependencies = { enabled: true, target: 'test', env, digestStore: store, clock: () => now,
    context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } },
    fetch: async () => { throw new Error('Rehearsal cannot read Google or send email.'); },
    loadSchedules: async () => { throw new Error('Rehearsal cannot read real schedules.'); } };
  function admin(body, query = '', options = {}) {
    const runtime = runtimeConfig(env, { admin: true, requestUrl: DIGEST_ORIGIN });
    const session = createAdminSession(options.reviewer || 'Andrew Smith', runtime.sessionSecret, now, 'x'.repeat(43));
    return new Request((options.origin || DIGEST_ORIGIN) + '/api/m1-attendance-digest' + query, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Origin: options.origin || DIGEST_ORIGIN,
        ...(options.noAuth ? {} : { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session)}`, [ADMIN_REQUEST_HEADER]: 'x'.repeat(43) }) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const arm = async (value = rehearsalId, options) => handleAttendanceDigest(admin({ action: 'armRehearsal', rehearsalId: value }, '', options), dependencies);
  const read = async (value = rehearsalId, requestId, options) => handleAttendanceDigest(admin(undefined, '?rehearsalId=' + value + (requestId ? '&requestId=' + requestId : ''), options), dependencies);
  async function tick(number, patch = {}, options = {}) {
    const body = { ...makeDigestBinding(id(number), 'rehearsal', now), rehearsalId, gyms: [], ...patch }, raw = JSON.stringify(body);
    return handleAttendanceDigestJob(new Request((options.origin || DIGEST_ORIGIN) + '/api/m1-attendance-digest-job', { method: 'POST',
      headers: { 'Content-Type': 'application/json', [DIGEST_SIGNATURE_HEADER]: options.badSignature ? '0'.repeat(64) : digestSignature(raw, env.GIB_TEST_ADMIN_ACTION_TOKEN) }, body: raw }), dependencies);
  }
  return { entries, store, writes, dependencies, arm, read, tick, admin, at: value => { now = value; } };
}

test('rehearsal arming is authenticated and persists a bounded synthetic lease without changing normal configuration', async () => {
  const h = harness();
  assert.equal((await h.arm(rehearsalId, { noAuth: true })).status, 401);
  assert.equal((await h.arm(rehearsalId, { origin: 'https://gib-live.netlify.app' })).status, 403);
  assert.equal(h.entries.size, 0);
  const response = await h.arm(), first = await response.json();
  assert.equal(response.status, 200); assert.equal(first.rehearsal.synthetic, true);
  assert.equal(first.rehearsal.expiresAt - first.rehearsal.createdAt, 1800000);
  assert.ok(first.rehearsal.cutoffAt >= start + 120000 && first.rehearsal.cutoffAt < start + 180000);
  assert.equal(h.entries.has('configuration'), false);
  h.at(start + 5000);
  const retry = await (await h.arm()).json(); assert.deepEqual(retry.rehearsal, first.rehearsal);
  assert.equal((await h.arm(id(2))).status, 409, 'a second active rehearsal cannot accumulate requests');
});

test('a lost lease-write reply recovers the exact persisted claim without extending its cutoff or expiry', async () => {
  const h = harness(), set = h.store.set; let failed = false;
  h.store.set = async (key, ...args) => { if (key.endsWith('/lease') && !failed) { failed = true; throw new Error('isolated failure'); } return set(key, ...args); };
  assert.equal((await h.arm()).status, 503);
  const original = structuredClone(h.entries.get('rehearsal-active').data);
  h.at(start + 2000);
  const recovered = await (await h.arm()).json();
  assert.equal(recovered.rehearsal.createdAt, original.createdAt); assert.equal(recovered.rehearsal.expiresAt, original.expiresAt);
});

test('concurrent different arming requests can claim only one active synthetic scope', async () => {
  const h = harness(), responses = await Promise.all([h.arm(id(1)), h.arm(id(2))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal([...h.entries.keys()].filter(key => key.endsWith('/lease')).length, 1);
  assert.equal(h.entries.has('configuration'), false);
});

test('normal scheduled processor guards the synthetic cutoff then captures two private gym proposals without browser or real-read dependencies', async () => {
  const h = harness(), armed = await (await h.arm()).json();
  const early = await (await h.tick(10)).json(); assert.equal(early.state, 'not-due'); assert.equal(early.messageId, null);
  assert.equal([...h.entries.keys()].some(key => key.includes('/captures/')), false);
  assert.deepEqual((await (await h.read()).json()).proposedMessages, []);
  assert.equal([...h.entries.keys()].some(key => key.includes('/workflow-data/')), false);
  h.at(armed.rehearsal.cutoffAt);
  const first = await (await h.tick(11)).json(); assert.equal(first.state, 'captured');
  assert.equal(first.messageId, 'm1-test-rehearsal-' + rehearsalId + '-' + armed.rehearsal.jobDate);
  h.at(armed.rehearsal.cutoffAt + 60000);
  const repeated = await Promise.all([h.tick(12), h.tick(13)]);
  for (const result of repeated) assert.equal((await result.json()).messageId, first.messageId);
  assert.equal([...h.entries.keys()].filter(key => key.includes('/data/captures/')).length, 1, 'legacy combined capture is preserved separately');
  assert.equal([...h.entries.keys()].filter(key => key.includes('/workflow-data/captures/')).length, 2);
  assert.equal(h.entries.has('latest'), false); assert.equal(h.entries.has('configuration'), false);
  assert.ok(h.writes.every(key => key === 'rehearsal-active' || key.startsWith('rehearsals/' + rehearsalId + '/')));
  const state = await (await h.read(rehearsalId, id(11))).json();
  assert.equal(state.configuration.cutoffConfirmed, true); assert.equal(state.configuration.dailyLocalTime, '20:00'); assert.equal(state.latest.itemCount, 1);
  assert.match(state.latest.subject, /SYNTHETIC REHEARSAL/); assert.match(state.latest.html, /not real attendance/);
  assert.match(state.latest.text, /synthetic|Synthetic/);
  assert.doesNotMatch(state.latest.html, /href=/, 'synthetic fixtures cannot invite correction of real records');
  assert.equal((await h.read(rehearsalId, undefined, { noAuth: true })).status, 401);
  const otherReviewer = await (await h.read(rehearsalId, id(11), { reviewer: 'Stuart Turner' })).json();
  assert.deepEqual(otherReviewer.latest, state.latest);
  assert.deepEqual(otherReviewer.proposedMessages, state.proposedMessages);
  assert.equal(state.proposedMessages.length, 2);
  for (const message of state.proposedMessages) {
    const to = message.gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com';
    assert.deepEqual(message.to, [to]); assert.deepEqual(message.cc, []); assert.deepEqual(message.bcc, ['andrew@revolutionbjj.com']);
    assert.equal(message.from, 'revbjjops@gmail.com'); assert.equal(message.synthetic, true); assert.equal(message.state, 'captured');
    assert.match(message.hash, /^[a-f0-9]{64}$/); assert.match(message.subject, /SYNTHETIC REHEARSAL/);
    assert.doesNotMatch(message.html + message.text, /andrew@revolutionbjj\.com/);
    assert.ok(message.html.includes(message.adminUrl));
    assert.doesNotMatch(message.html + message.text, message.gym === 'rev' ? /Richmond BJJ|gib-richmond-test/ : /Revolution BJJ|deploy-preview-89--gib-live/);
  }
  assert.match(state.proposedMessages[0].text, /Previous finish time is unknown/); assert.match(state.proposedMessages[0].text, /No hours were guessed/);
  assert.doesNotMatch(state.proposedMessages[1].text + state.proposedMessages[1].html, /#staff-time|SYNTHETIC employee|Previous finish time|Staff Clock/);
  h.entries.set('latest', { etag: 'ordinary-sentinel', data: { messageId: 'unrelated-ordinary-capture' } });
  assert.equal((await h.read()).status, 200, 'an unrelated ordinary capture cannot block isolated proof readback');
});

test('caller sending flags and provider hooks cannot turn the synthetic two-gym capture into a send', async () => {
  const h = harness(); let externalCalls = 0;
  h.dependencies.env = { ...env, GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_MAILAPP_TEST_SEND_ENABLED: 'true', GIB_M1_DIGEST_TEST_SEND_ENABLED: 'true' };
  h.dependencies.fetch = h.dependencies.onDigestCheck = async () => { externalCalls++; throw new Error('Unexpected real action'); };
  h.dependencies.captureTransport = async () => { externalCalls++; throw new Error('Caller capture hook must never run'); };
  h.dependencies.simulatedProvider = { kind: 'mailapp', identity: 'caller-must-be-ignored', send: h.dependencies.fetch };
  h.dependencies.workflowStore = { set: h.dependencies.fetch, getWithMetadata: h.dependencies.fetch };
  const armed = await (await h.arm()).json(); h.at(armed.rehearsal.cutoffAt);
  assert.equal((await h.tick(10)).status, 200); assert.equal(externalCalls, 0);
  const state = await (await h.read()).json(); assert.equal(state.proposedMessages.length, 2);
  assert.equal([...h.entries.keys()].some(key => key.includes('/workflow/delivery/')), false, 'no provider request or attempt was created');
  const records = [...h.entries.values()].map(entry => entry.data).filter(value => value.schema === 'm1-digest-workflow/v1');
  assert.equal(records.length, 2); assert.ok(records.every(record => record.firstAttemptAt === null && record.code === 'SCHEDULED_SENDING_DISABLED'));
});

test('concurrent original timer jobs capture each gym once and later jobs retain the exact proposed message bodies', async () => {
  const h = harness(), armed = await (await h.arm()).json(); h.at(armed.rehearsal.cutoffAt);
  const simultaneous = await Promise.all([h.tick(10), h.tick(11)]); assert.ok(simultaneous.every(response => response.status === 200));
  const initial = (await (await h.read()).json()).proposedMessages; assert.equal(initial.length, 2);
  h.at(armed.rehearsal.cutoffAt + 60000); assert.equal((await h.tick(12)).status, 200);
  assert.deepEqual((await (await h.read()).json()).proposedMessages, initial);
  assert.equal([...h.entries.keys()].filter(key => key.includes('/workflow-data/proposals/')).length, 2);
  assert.equal([...h.entries.keys()].filter(key => key.includes('/workflow-data/captures/')).length, 2);
});

test('a partial proposal capture fails visibly, then the existing next timer tick finishes it without replacing history', async () => {
  const h = harness(), armed = await (await h.arm()).json(); h.at(armed.rehearsal.cutoffAt);
  const set = h.store.set; let failed = false;
  h.store.set = async (key, ...args) => { if (key.includes('/workflow-data/captures/m1-test-scheduled-richmond-') && !failed) { failed = true; throw new Error('Capture unavailable'); } return set(key, ...args); };
  assert.equal((await h.tick(10)).status, 503);
  const originalKey = [...h.entries.keys()].find(key => key.includes('/workflow-data/captures/m1-test-scheduled-rev-'));
  const original = structuredClone(h.entries.get(originalKey)); assert.ok(original);
  assert.deepEqual((await (await h.read()).json()).proposedMessages, []);
  h.at(armed.rehearsal.cutoffAt + 60000); assert.equal((await h.tick(11)).status, 200);
  assert.equal((await (await h.read()).json()).proposedMessages.length, 2); assert.deepEqual(h.entries.get(originalKey), original);
  h.at(armed.rehearsal.expiresAt); assert.equal((await h.tick(12)).status, 410);
  assert.equal((await (await h.read()).json()).proposedMessages.length, 2, 'lease expiration preserves immutable captures');
  const saved = structuredClone([...h.entries.entries()]); await h.arm(id(2));
  for (const [key, value] of saved.filter(([key]) => key.startsWith('rehearsals/'))) assert.deepEqual(h.entries.get(key), value);
});

test('incomplete or conflicting private proposal evidence never appears as a verified capture', async () => {
  const h = harness(), armed = await (await h.arm()).json(); h.at(armed.rehearsal.cutoffAt); assert.equal((await h.tick(10)).status, 200);
  const key = [...h.entries.keys()].find(key => key.endsWith('/workflow-data/proposals/rev'));
  h.entries.get(key).data.message.hash = '0'.repeat(64);
  assert.equal((await h.read()).status, 503);
});

test('capture failure retains an immutable receipt and a later tick recovers the same rendered message', async () => {
  const h = harness(), armed = await (await h.arm()).json(); h.at(armed.rehearsal.cutoffAt);
  const set = h.store.set; let failedOnce = false;
  h.store.set = async (key, ...args) => {
    if (key.includes('/data/captures/') && !failedOnce) { failedOnce = true; throw new Error('isolated capture storage unavailable'); }
    return set(key, ...args);
  };
  const failed = await (await h.tick(10)).json(); assert.equal(failed.state, 'failed');
  const failureKey = [...h.entries.keys()].find(key => key.includes('/failures/')), receipt = structuredClone(h.entries.get(failureKey));
  const original = (await (await h.read()).json()).latest;
  h.at(armed.rehearsal.cutoffAt + 60000);
  const recovered = await (await h.tick(11)).json(); assert.equal(recovered.state, 'captured'); assert.equal(recovered.messageId, failed.messageId);
  assert.deepEqual(h.entries.get(failureKey), receipt);
  const after = (await (await h.read()).json()).latest;
  assert.equal(after.contentHash, original.contentHash); assert.equal(after.html, original.html);
});

test('mismatched, expired, forged and record-bearing rehearsal requests fail closed without touching ordinary data', async () => {
  const h = harness();
  assert.equal((await h.tick(10)).status, 404);
  const armed = await (await h.arm()).json();
  for (const [patch, options, expected] of [
    [{ gyms: [{ gym: 'rev' }] }, {}, 409], [{ rehearsalId: id(2) }, {}, 404], [{ rehearsalId: 'not-an-id' }, {}, 409],
    [{}, { badSignature: true }, 403], [{}, { origin: 'https://gib-live.netlify.app' }, 403],
    [{ mode: 'scheduled' }, {}, 400], [{ target: 'production' }, {}, 409]
  ]) assert.equal((await h.tick(11, patch, options)).status, expected);
  h.at(armed.rehearsal.expiresAt);
  assert.equal((await h.tick(12)).status, 410);
  const expired = await (await h.read()).json(); assert.equal(expired.rehearsal.state, 'expired');
  assert.equal([...h.entries.keys()].some(key => key.includes('/captures/')), false);
  const rearm = await (await h.arm()).json(); assert.equal(rearm.rehearsal.state, 'expired', 'the original ID cannot extend expiry');
  const replacement = await h.arm(id(2)); assert.equal(replacement.status, 200, 'an expired active pointer is replaced safely');
  assert.ok(h.entries.has('rehearsals/' + rehearsalId + '/lease'), 'expiry preserves proof history');
});
