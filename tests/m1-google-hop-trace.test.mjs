import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { traceGoogle } from '../netlify/functions/_lib/m1-google-trace.mjs';
import { postGoogle as baseline } from '../netlify/functions/_lib/m1-google-pre-pr-control.mjs';
import { postGoogle as current } from '../netlify/functions/_lib/m1-common.mjs';

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
