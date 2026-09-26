import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { handleAttendanceDigestEmail } from '../netlify/functions/m1-attendance-digest-email.mjs';
import { buildTestDigestEmail } from '../netlify/functions/_lib/m1-attendance-digest-email-proposal.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { DIGEST_ORIGIN } from '../netlify/functions/_lib/m1-attendance-digest.mjs';

const now = Date.parse('2026-09-26T19:00:00Z');
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-transport-secret-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-12345678901234567890',
  GIB_M1_DIGEST_TEST_EMAIL_RECIPIENT: 'andrew@example.test' };
function setup() {
  let writes = 0, sends = 0;
  const deps = { enabled: true, target: 'test', env, clock: () => now, now: () => now,
    context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } },
    deliveryStore: { async getWithMetadata() { return null; }, async set() { writes++; throw new Error('Unexpected write'); } },
    fetch: async () => { sends++; throw new Error('Unexpected provider call'); } };
  return { deps, writes: () => writes, sends: () => sends };
}
function request(body, options = {}) {
  const runtime = runtimeConfig(env, { admin: true, requestUrl: DIGEST_ORIGIN });
  const token = 'x'.repeat(43), session = createAdminSession('Andrew Smith', runtime.sessionSecret, now, token);
  return new Request((options.origin || DIGEST_ORIGIN) + '/api/m1-attendance-digest-email' + (options.query || ''), {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: options.requestOrigin || options.origin || DIGEST_ORIGIN,
      ...(options.cookie === false ? {} : { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session)}` }),
      ...(options.token === false ? {} : { [ADMIN_REQUEST_HEADER]: token }) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('authenticated preview is exactly the proposed synthetic payload without changing captures or starting delivery', async () => {
  const h = setup(), response = await handleAttendanceDigestEmail(request(), h.deps), data = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(data.message, buildTestDigestEmail(env.GIB_M1_DIGEST_TEST_EMAIL_RECIPIENT));
  assert.equal(data.sendingEnabled, false); assert.equal(data.recurringEnabled, false);
  assert.equal(data.delivery.state, 'not-started'); assert.equal(data.recipientSettings.stu.address, null);
  assert.equal(h.writes(), 0); assert.equal(h.sends(), 0);
});

test('email preview retains existing authentication and exact Revolution TEST isolation', async () => {
  for (const options of [{ cookie: false }, { token: false }, { origin: 'https://gib-live.netlify.app' },
    { origin: 'https://gib-richmond-test.netlify.app' }, { requestOrigin: 'https://foreign.example' }]) {
    const h = setup(), response = await handleAttendanceDigestEmail(request(undefined, options), h.deps);
    assert.ok([401, 403].includes(response.status)); assert.equal(h.writes(), 0); assert.equal(h.sends(), 0);
  }
  const h = setup();
  assert.equal((await handleAttendanceDigestEmail(request(), { ...h.deps, target: 'production' })).status, 403);
  assert.equal((await handleAttendanceDigestEmail(request(undefined, { query: '?email=other@example.test' }), h.deps)).status, 404);
});

test('exact POST remains disabled; mismatched content and arbitrary recipients cannot enter transport', async () => {
  const h = setup(), message = buildTestDigestEmail(env.GIB_M1_DIGEST_TEST_EMAIL_RECIPIENT);
  const input = { action: 'sendApprovedTest', messageId: message.messageId, hash: message.hash };
  assert.equal((await handleAttendanceDigestEmail(request(input), h.deps)).status, 403);
  for (const changed of [{ ...input, hash: 'a'.repeat(64) }, { ...input, messageId: 'm1-test-daily-2026-09-26' },
    { ...input, recipient: 'other@example.test' }]) {
    assert.equal((await handleAttendanceDigestEmail(request(changed), h.deps)).status, 409);
  }
  assert.equal(h.writes(), 0); assert.equal(h.sends(), 0);
});

test('failed retained-status read never reports not sent, accepted or all clear', async () => {
  const h = setup(); h.deps.deliveryStore.getWithMetadata = async () => { throw new Error('Storage unavailable'); };
  const response = await handleAttendanceDigestEmail(request(), h.deps), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.delivery.state, 'unknown');
  assert.equal(data.delivery.deliveryConfirmed, false); assert.equal(h.sends(), 0);
});

test('the actual shared Admin request helper sends authenticated email and capture GETs and preserves existing POSTs', async () => {
  const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('      async function requestJson('), html.indexOf('      function requestedManagerMode('));
  const calls = [];
  const context = vm.createContext({ adminRequestToken: 'synthetic-request-token', ADMIN_REQUEST_HEADER,
    clean: value => String(value || '').trim(), AbortController, window: { setTimeout, clearTimeout },
    fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } });
  vm.runInContext(source + '\nthis.call = requestJson;', context);
  for (const url of ['/api/m1-attendance-digest-email', '/api/m1-attendance-digest?requestId=retained']) {
    await context.call(url, undefined, { method: 'GET', timeoutMs: 12000 });
    assert.equal(calls.at(-1).init.method, 'GET'); assert.equal('body' in calls.at(-1).init, false);
    assert.equal(calls.at(-1).init.headers[ADMIN_REQUEST_HEADER], 'synthetic-request-token');
    assert.equal(calls.at(-1).init.credentials, 'same-origin');
  }
  await context.call('/api/m1-manager-review', { action: 'read' }, { method: 'GET' });
  assert.equal(calls.at(-1).init.method, 'POST'); assert.equal(calls.at(-1).init.body, '{"action":"read"}');
});
