import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createNativeHttpsControl } from '../netlify/functions/_lib/m1-google-native-control.mjs';
import { postGoogle } from '../netlify/functions/_lib/m1-google-pre-pr-control.mjs';
import { traceGoogle } from '../netlify/functions/_lib/m1-google-trace.mjs';

test('native control preserves pre-PR POST bytes, follows fresh redirects as GET, decodes gzip, and keeps diagnostics private', async () => {
  const received = [], logs = [], signals = [];
  let next = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    received.push({ method: req.method, body, path: req.url, contentType: req.headers['content-type'], accept: req.headers.accept });
    if (req.url === '/private-start') res.writeHead(302, { Location: `/fresh-private-redirect-${++next}` }).end();
    else { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); res.end(gzipSync('{"ok":true,"private":"private-response"}')); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = `http://127.0.0.1:${server.address().port}`;
  const native = createNativeHttpsControl((url, init, callback) => { signals.push(init.signal); return httpRequest(new URL(url.pathname, local), init, callback); });
  const fetchControl = (url, init) => fetch(new URL(new URL(url).pathname, local), init);
  const cfg = { webhookUrl: 'https://script.google.com/private-start', target: 'test', preview: true, webhookToken: 'private-token', adminActionToken: 'private-admin' };
  const previous = console.info; console.info = (...args) => logs.push(args.join(' '));
  try {
    const baseline = await postGoogle(cfg, 'managerReviewRead', { gym: 'rev' }, fetchControl);
    const run = () => traceGoogle({ enabled: true, target: 'test', action: 'managerReviewRead', variant: 'native-https' }, () => postGoogle(cfg, 'managerReviewRead', { gym: 'rev' }, native));
    assert.deepEqual(await run(), baseline); assert.deepEqual(await run(), baseline);
    assert.deepEqual(received.map(x => x.method), ['POST', 'GET', 'POST', 'GET', 'POST', 'GET']);
    assert.equal(new Set(received.filter(x => x.method === 'POST').map(x => x.body)).size, 1);
    assert.ok(received.filter(x => x.method === 'GET').every(x => x.body === '' && !x.contentType));
    assert.equal(new Set(received.filter(x => x.method === 'GET').map(x => x.path)).size, 3);
    assert.equal(signals[0], signals[1]); assert.equal(signals[2], signals[3]); assert.notEqual(signals[0], signals[2]);
    assert.ok(received.every(x => x.accept === 'application/json'));
    const events = logs.map(x => JSON.parse(x.slice(12)));
    assert.equal(events.filter(x => x.event === 'headers' && x.status === 302).length, 2);
    assert.equal(events.filter(x => x.event === 'headers' && x.status === 200).length, 2);
    assert.ok(events.every(x => x.variant === 'native-https'));
    assert.doesNotMatch(logs.join('\n'), /private-|Location|adminActionToken|webhookToken|127\.0\.0\.1/);
  } finally { console.info = previous; server.closeAllConnections(); server.close(); await once(server, 'close'); }
});

test('native control uses one abort signal, does not retry, and rejects unexpected redirect destinations', async () => {
  let calls = 0;
  const server = createServer((req, res) => { calls++; if (req.url === '/redirect') res.writeHead(302, { Location: 'https://unapproved.invalid/private' }).end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const native = createNativeHttpsControl((url, init, callback) => httpRequest(new URL(url.pathname, `http://127.0.0.1:${server.address().port}`), init, callback));
  const init = signal => ({ method: 'POST', body: '{}', headers: { Accept: 'application/json' }, redirect: 'follow', signal });
  try {
    await assert.rejects(native('https://script.google.com/redirect', init(AbortSignal.timeout(2000))), /redirect rejected/);
    assert.equal(calls, 1);
    await assert.rejects(native('https://script.google.com/stall', init(AbortSignal.timeout(30))));
    assert.equal(calls, 2);
    await assert.rejects(native('https://unapproved.invalid/start', init(AbortSignal.timeout(2000))));
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});
