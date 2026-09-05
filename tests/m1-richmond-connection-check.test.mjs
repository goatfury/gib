import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkConnection, readTabletSummary, resultText } from '../m1/connection-check.mjs';

const origin = 'https://gib-richmond-live.netlify.app';
const prefix = 'gib_m1_richmond_production_';
const active = { authorized: true, writesEnabled: true, activation: 'active' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('connection check sends only the existing read-only status request and requires all Richmond gates', async () => {
  const calls = [];
  const result = await checkConnection({ origin, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json(active);
  } });
  assert.equal(result.kind, 'connected');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/m1-tablet-status');
  assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.mode, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.redirect, 'error');
  for (const [reply, expected] of [
    [json({ ...active, authorized: false }), 'not-authorized'],
    [json({ authorized: true, writesEnabled: false, activation: 'pending' }), 'sheet-unconfirmed'],
    [json({ authorized: true, writesEnabled: false, activation: 'pending' }, 503), 'sheet-unconfirmed'],
    [json({ authorized: true }), 'service-unavailable'],
    [json({ ...active, unexpected: true }), 'service-unavailable'],
    [json({ ...active, writesEnabled: 'true' }), 'service-unavailable'],
    [json({ ...active, activation: 'pending' }), 'service-unavailable'],
    [json(active, 403), 'service-unavailable'],
    [new Response('<html>Sign into Wi-Fi</html>'), 'unexpected-response']
  ]) {
    assert.equal((await checkConnection({ origin, fetchImpl: async () => reply })).kind, expected);
  }
});

test('unreachable service and stalled response body finish without a false success', async () => {
  const failed = await checkConnection({ origin, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(failed.kind, 'no-response');
  const stalled = await checkConnection({ origin, timeoutMs: 5, fetchImpl: async (_url, { signal }) => ({
    status: 200,
    text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))))
  }) });
  assert.equal(stalled.kind, 'incomplete-response');
});

test('other origins cannot send checks', async () => {
  for (const value of ['https://gib-live.netlify.app', 'https://example.com']) {
    let sent = false;
    const result = await checkConnection({ origin: value, fetchImpl: () => { sent = true; } });
    assert.equal(result.kind, 'wrong-device-site');
    assert.equal(sent, false);
  }
});

test('local summary is counts-only, reads Richmond state, and never changes it', () => {
  const values = new Map([
    [`${prefix}local_state_v2`, JSON.stringify({ version: 2, ledger: [{ Instructor: 'PRIVATE PERSON' }], queue: [] })],
    [`${prefix}sync_auto_v1`, 'true'],
    [`${prefix}sync_last`, '2026-09-05T18:08:00.000Z']
  ]);
  const before = JSON.stringify([...values]);
  const reads = [];
  const result = readTabletSummary({
    getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem() { assert.fail('diagnostic must never write'); },
    removeItem() { assert.fail('diagnostic must never delete'); }
  });
  assert.deepEqual(result, { waiting: 0, saved: 1, automatic: true, last: '2026-09-05T18:08:00.000Z' });
  assert.equal(JSON.stringify([...values]), before);
  assert.equal(JSON.stringify(result).includes('PRIVATE PERSON'), false);
  assert.ok(reads.every(key => key.startsWith(prefix)));
  assert.equal(reads.some(key => /token|pin|credential|sync_url/.test(key)), false);
  assert.equal(readTabletSummary({ getItem() { throw new Error('storage denied'); } }).waiting, null);
  assert.equal(readTabletSummary({ getItem: key => key.endsWith('local_state_v2') ? '{broken' : null }).waiting, null);
  assert.equal(readTabletSummary({ getItem: key => key.endsWith('local_state_v2') ? '{"version":2}' : null }).waiting, null);
});

test('a successful connection is never labeled as new sign-in delivery or gym readiness', () => {
  const good = resultText({ kind: 'connected' }, { automatic: true, waiting: 0 });
  assert.equal(good.headline, 'Connection to sheet confirmed now');
  assert.equal(good.tone, 'good');
  for (const local of [{ automatic: false, waiting: 0 }, { automatic: true, waiting: 3 }, { automatic: true, waiting: null }]) {
    assert.equal(resultText({ kind: 'connected' }, local).tone, 'attention');
  }
  for (const kind of ['not-authorized', 'sheet-unconfirmed', 'no-response', 'incomplete-response', 'unexpected-response', 'rate-limited']) {
    assert.equal(resultText({ kind }, { automatic: true, waiting: 0 }).tone, 'attention');
  }
  const html = readFileSync(new URL('../m1/connection.html', import.meta.url), 'utf8');
  assert.match(html, /new sign-in appearing in the sheet is still the proof of delivery/);
  assert.match(html, /does not send sign-ins or change settings/);
});

test('the connection screen receives a safe failure code without accepting untrusted details', async () => {
  const value = { authorized: true, writesEnabled: false, activation: 'pending' };
  for (const [header, expected] of [['RECEIVER_REJECTED', 'RECEIVER_REJECTED'], ['PRIVATE ERROR', ''], ['constructor', ''], ['CONFIRMED', '']]) {
    const result = await checkConnection({ origin, fetchImpl: async (_url, options) => {
      assert.equal(options.headers['X-GIB-M1-Connection-Check'], 'details-v1');
      return new Response(JSON.stringify(value), { status: 503, headers: { 'X-GIB-M1-Check-Code': header } });
    } });
    assert.equal(result.kind, 'sheet-unconfirmed');
    assert.equal(result.code, expected);
    assert.equal(resultText(result, { automatic: true, waiting: 0 }).tone, 'attention');
  }
});
