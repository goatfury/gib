import test from 'node:test';
import assert from 'node:assert/strict';
import { postGoogle } from '../netlify/functions/_lib/m1-common.mjs';

test('TEST transport diagnostics distinguish failures without exposing request or error secrets', async () => {
  const messages = [];
  const original = console.info;
  console.info = (...args) => messages.push(args.join(' '));
  try {
    const config = { target: 'test', installationId: 'rev', webhookUrl: 'https://secret.invalid', webhookToken: 'secret-token' };
    const broken = async () => { throw new Error('secret-response', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT', address: 'secret-address' } }); };
    const result = await postGoogle(config, 'managerReviewRead', { instructor: 'secret-name' }, broken);
    assert.equal(result.failureClass, 'UNREACHABLE');
    assert.equal(result.transportCode, 'UND_ERR_CONNECT_TIMEOUT');
    await postGoogle(config, 'dailyReview', {}, async () => new Response('<html>secret-page</html>'));
    await postGoogle({ ...config, target: 'production' }, 'dailyReview', {}, broken);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /managerReviewRead.*elapsedMs.*UNREACHABLE.*UND_ERR_CONNECT_TIMEOUT/);
    assert.match(messages[1], /dailyReview.*HTML/);
    assert.doesNotMatch(messages.join('\n'), /secret-/);
    assert.doesNotMatch(JSON.stringify(result), /secret-/);
  } finally { console.info = original; }
});

test('bounded pilot retry is restricted to unreadable pure TEST reads', async () => {
  const config = { target: 'test', testReadRetry: true, installationId: 'rev', webhookUrl: 'https://example.invalid' };
  for (const action of ['dailyReview', 'managerReviewRead']) {
    let calls = 0;
    const result = await postGoogle(config, action, {}, async () => ++calls === 1
      ? new Response('Unavailable', { status: 404 }) : Response.json({ ok: true }));
    assert.equal(calls, 2);
    assert.equal(result.value.ok, true);
  }
  for (const action of ['managerReviewSave', 'managerReviewVoid', 'adminAdd', 'kioskSync']) {
    let calls = 0;
    await postGoogle(config, action, {}, async () => { calls++; throw new Error('offline'); });
    assert.equal(calls, 1, action);
  }
  for (const body of ['{"ok":false,"conflict":true}', '{"ok":false,"result":"rejected"}', '[]', '{']) {
    let calls = 0;
    await postGoogle(config, 'dailyReview', {}, async () => { calls++; return new Response(body); });
    assert.equal(calls, 1, body);
  }
  for (const overrides of [{ target: 'production' }, { testReadRetry: false }]) {
    let calls = 0;
    await postGoogle({ ...config, ...overrides }, 'dailyReview', {}, async () => { calls++; throw new Error('offline'); });
    assert.equal(calls, 1);
  }
  let attempts = 0;
  const failed = await postGoogle(config, 'managerReviewRead', {}, async () => { attempts++; return new Response('<html>Unavailable</html>'); });
  assert.equal(attempts, 2);
  assert.equal(failed.readable, false);
  assert.equal(failed.failureClass, 'HTML');
});

test('native repair is limited to opted-in Revolution TEST reads and never retries a failure', async () => {
  const config = { target: 'test', installationId: 'rev', testNativeHttps: true, testReadRetry: true, webhookUrl: 'https://script.google.com/synthetic' };
  for (const action of ['dailyReview', 'managerReviewRead']) {
    let calls = 0;
    const result = await postGoogle(config, action, {}, () => { throw new Error('fetch must not run'); }, async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).action, action);
      assert.equal(init.redirect, 'follow');
      assert.ok(init.signal instanceof AbortSignal);
      throw new Error('Synthetic failure');
    });
    assert.equal(calls, 1);
    assert.equal(result.readable, false);
    assert.equal(result.failureClass, 'UNREACHABLE');
  }
  for (const [overrides, action] of [
    [{ target: 'production' }, 'dailyReview'], [{ installationId: 'richmond' }, 'managerReviewRead'],
    [{ testNativeHttps: false }, 'dailyReview'], [{ installationId: undefined }, 'dailyReview'],
    [{}, 'managerReviewSave'], [{}, 'managerReviewVoid'], [{}, 'adminAdd'], [{}, 'kioskSync']
  ]) {
    let fetchCalls = 0, nativeCalls = 0;
    const result = await postGoogle({ ...config, ...overrides }, action, {}, async () => { fetchCalls++; return Response.json({ ok: true }); }, async () => { nativeCalls++; return Response.json({ ok: true }); });
    assert.equal(result.value.ok, true);
    assert.equal(fetchCalls, 1);
    assert.equal(nativeCalls, 0);
  }
  for (const body of ['<html>Unavailable</html>', '[]', '{"ok":false}', '{']) {
    let calls = 0;
    const result = await postGoogle(config, 'dailyReview', {}, () => { throw new Error('fetch must not run'); }, async () => { calls++; return new Response(body); });
    assert.equal(calls, 1);
    assert.notEqual(result.value?.ok, true);
  }
});
