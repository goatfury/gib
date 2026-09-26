import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { traceGoogle, safeAdditionTraceId } from '../netlify/functions/_lib/m1-google-trace.mjs';
import { postGoogle as baseline } from '../netlify/functions/_lib/m1-google-pre-pr-control.mjs';
import { postGoogle as current } from '../netlify/functions/_lib/m1-common.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { handleAdminAdd } from '../netlify/functions/m1-admin-add.mjs';

test('control transport is byte-for-byte the pre-PR function, not the current helper', () => {
  const source = readFileSync(new URL('../netlify/functions/_lib/m1-google-pre-pr-control.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // Exclude only the separator blank line after the original function.
  const body = source.slice(source.indexOf('export async function postGoogle(')).trimEnd() + '\n';
  assert.equal(createHash('sha256').update(body).digest('hex'), '270341855e0e6664225da32e1506adec8b62c06a89b553af3a8c2ea688412d9c');
});

test('actual fetch redirects are observed without changing baseline/current methods, bodies or privacy', async () => {
  const received = [], logs = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    received.push({ method: req.method, body });
    res.setHeader('Connection', 'close');
    if (req.url === '/initial-secret-path') {
      res.writeHead(302, { Location: '/signed-secret-path?token=secret-query' }).end();
    } else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"private":"secret-response"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const original = console.info;
  console.info = (...values) => logs.push(values.join(' '));
  try {
    const config = { target: 'test', preview: true, installationId: 'rev', webhookUrl: `http://127.0.0.1:${server.address().port}/initial-secret-path`, webhookToken: 'secret-credential', adminActionToken: 'secret-admin', testTrace: true };
    const data = { from: '2026-09-07', to: '2026-09-23', gym: 'rev' };
    const old = await traceGoogle({ target: 'test', enabled: true, action: 'managerReviewRead', variant: 'pre-pr' }, () => baseline(config, 'managerReviewRead', data));
    const next = await current(config, 'managerReviewRead', data);
    assert.deepEqual(old, next);
    assert.deepEqual(received.map(r => r.method), ['POST', 'GET', 'POST', 'GET']);
    assert.equal(received[0].body, received[2].body);
    assert.equal(received[1].body, ''); assert.equal(received[3].body, '');
    const events = logs.filter(line => line.startsWith('M1_TEST_HOP ')).map(line => JSON.parse(line.slice(12)));
    for (const variant of ['pre-pr', 'current']) {
      const chain = events.filter(e => e.variant === variant);
      assert.equal(new Set(chain.map(e => e.trace)).size, 1);
      assert.deepEqual(chain.filter(e => e.event === 'headers').map(e => [e.hop, e.method, e.status]), [[1, 'POST', 302], [2, 'GET', 200]]);
      assert.ok(chain.every(e => e.at && (!('elapsedMs' in e) || e.elapsedMs >= 0)));
    }
    assert.doesNotMatch(logs.join('\n'), /secret-|127\.0\.0\.1|Location|webhookToken|adminActionToken/);
    const before = logs.length;
    await traceGoogle({ target: 'production', enabled: true, action: 'managerReviewRead' }, () => baseline(config, 'managerReviewRead', data));
    await traceGoogle({ target: 'test', enabled: false, action: 'managerReviewRead' }, () => baseline(config, 'managerReviewRead', data));
    assert.equal(logs.length, before);
  } finally { console.info = original; server.close(); await once(server, 'close'); }
});

test('Revolution TEST addition traces correlate exact safe IDs across actual redirects and final non-success status without retrying', async () => {
  const received = [], logs = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    received.push({ method: req.method, body });
    res.setHeader('Connection', 'close');
    if (req.url === '/private-addition-path') res.writeHead(302, { Location: '/private-signed-response?secret=query' }).end();
    else res.writeHead(503, { 'Content-Type': 'text/html' }).end('<html>private-response-with-identities</html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const original = console.info;
  console.info = (...values) => logs.push(values.join(' '));
  const ids = ['m1-2026-09-24-111111112222222233333333', 'manager-add-11111111-2222-4333-8444-555555555555'];
  try {
    const config = { target: 'test', preview: true, installationId: 'rev', testTrace: true,
      testReadRetry: true, testNativeHttps: true,
      webhookUrl: `http://127.0.0.1:${server.address().port}/private-addition-path`,
      webhookToken: 'private-receiver-token', adminActionToken: 'private-admin-token' };
    for (const requestId of ids) {
      const result = await current(config, 'addMissedInstructor', { requestId, instructor: 'private-instructor', notes: 'private-notes' },
        fetch, () => { throw new Error('Addition must retain fetch'); });
      assert.deepEqual(result, { readable: false, status: 503, failureClass: 'HTTP_FAILURE' });
    }
    assert.deepEqual(received.map(item => item.method), ['POST', 'GET', 'POST', 'GET']);
    for (const [index, id] of ids.entries()) {
      assert.equal(JSON.parse(received[index * 2].body).requestId, id);
      const events = logs.filter(line => line.startsWith('M1_TEST_HOP ')).map(line => JSON.parse(line.slice(12))).filter(item => item.requestId === id);
      assert.equal(new Set(events.map(item => item.trace)).size, 1);
      assert.equal(events.filter(item => item.event === 'start').length, 1);
      assert.deepEqual(events.filter(item => item.event === 'headers').map(item => [item.hop, item.method, item.status]), [[1, 'POST', 302], [2, 'GET', 503]]);
      assert.ok(events.every(item => item.gym === 'rev' && item.attempt === 1 && (!('elapsedMs' in item) || item.elapsedMs >= 0)));
      const outcome = logs.filter(line => line.startsWith('M1_TEST_GOOGLE ')).map(line => JSON.parse(line.slice(15))).find(item => item.requestId === id);
      assert.equal(outcome.status, 503); assert.equal(outcome.result, 'HTTP_FAILURE');
    }
    assert.doesNotMatch(logs.join('\n'), /private-|127\.0\.0\.1|secret=query|Location|webhookToken|adminActionToken/);
  } finally { console.info = original; server.close(); await once(server, 'close'); }
});

test('addition correlation rejects arbitrary identifiers and stays disabled outside enabled Revolution TEST', async () => {
  for (const value of [undefined, {}, 'private-instructor', 'm1-2026-09-24-111111112222222233333333\nsecret', 'manager-add-11111111-2222-3333-8444-555555555555']) {
    assert.equal(safeAdditionTraceId(value), undefined);
  }
  const logs = [], original = console.info;
  console.info = (...values) => logs.push(values.join(' '));
  try {
    for (const overrides of [{ target: 'production' }, { installationId: 'richmond' }, { testTrace: false }]) {
      const config = { target: 'test', installationId: 'rev', testTrace: true, ...overrides };
      await current(config, 'addMissedInstructor', { requestId: 'm1-2026-09-24-111111112222222233333333' }, async () => new Response('{"ok":true}'));
    }
    assert.equal(logs.length, 0);
    await current({ target: 'test', installationId: 'rev', testTrace: true }, 'addMissedInstructor', { requestId: 'private-unsanitized-input' }, async () => new Response('{"ok":true}'));
    assert.doesNotMatch(logs.join('\n'), /private-unsanitized-input|requestId/);
  } finally { console.info = original; }
});

test('authenticated Revolution TEST addition enables diagnostics without environment changes and logging failure cannot affect its result', async () => {
  const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/TEST_ID/exec',
    GIB_TEST_WEBHOOK_TOKEN: 'test-receiver-token-long-enough', GIB_TEST_ADMIN_ACTION_TOKEN: 'test-admin-action-token-long-enough' };
  const url = 'https://deploy-preview-89--gib-live.netlify.app/.netlify/functions/m1-admin-add';
  const now = Date.parse('2026-09-24T15:00:00Z'), requestToken = Buffer.alloc(32, 9).toString('base64url');
  const config = runtimeConfig(env, { admin: true, requestUrl: url });
  const body = { requestId: 'm1-2026-09-23-111111112222222233333333', date: '2026-09-23', classLabel: '6 PM TEST', duration: 1,
    instructor: 'TEST synthetic instructor', site: 'Rev', notes: 'DO NOT PAY', reason: 'TEST existing original request' };
  const request = () => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(createAdminSession('Stuart Turner', config.sessionSecret, now, requestToken))}`,
    [ADMIN_REQUEST_HEADER]: requestToken }, body: JSON.stringify(body) });
  const logs = [], original = console.info;
  let dispatches = 0;
  const deps = { env, now, dateNow: new Date(now), fetch: async () => { dispatches++; return new Response('private-failed-response', { status: 503 }); } };
  try {
    console.info = (...values) => logs.push(values.join(' '));
    const response = await handleAdminAdd(request(), deps);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'ADMIN_ADD_HTTP_FAILURE');
    assert.equal(dispatches, 1);
    assert.ok(logs.some(line => line.startsWith('M1_TEST_HOP ') && line.includes(body.requestId)));
    assert.ok(logs.some(line => line.startsWith('M1_TEST_GOOGLE ') && line.includes(body.requestId)));
    assert.doesNotMatch(logs.join('\n'), /private-failed-response|synthetic instructor|DO NOT PAY|test-receiver-token|test-admin-action-token/);
    console.info = () => { throw new Error('Diagnostic sink unavailable'); };
    const unchanged = await handleAdminAdd(request(), deps);
    assert.equal(unchanged.status, 502);
    assert.equal((await unchanged.json()).code, 'ADMIN_ADD_HTTP_FAILURE');
    assert.equal(dispatches, 2);
  } finally { console.info = original; }
});
