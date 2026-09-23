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
