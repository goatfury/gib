import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const code = 'async function requestJson(' + html.split('      async function requestJson(')[1].split('      function requestedManagerMode()')[0];
const endpoint = '/.netlify/functions/m1-admin-staff-time';
const id = '00000000-0000-4000-8000-000000000001';
function harness() {
  const calls = [], logs = [];
  const ctx = vm.createContext({ adminRequestToken: 'PRIVATE_TOKEN', ADMIN_REQUEST_HEADER: 'X-Admin-Token', Date, AbortController,
    clean: s => s, window: { setTimeout, clearTimeout }, location: { origin: 'https://deploy-preview-89--gib-live.netlify.app' },
    crypto: { randomUUID: () => id }, console: { info: (_, json) => logs.push(JSON.parse(json)) },
    fetch: async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true, private: 'PRIVATE_RECORD' }, { headers: { 'X-GIB-M1-Read-ID': id } }); }
  });
  vm.runInContext(code, ctx);
  return { ctx, calls, logs };
}
test('Staff diagnostic UUID follows only exact Revolution TEST read calls without altering their bodies', async () => {
  const h = harness();
  for (const operation of ['review', 'reviewPage', 'historyPage', 'shiftLookup', 'recoveryReview']) {
    await h.ctx.requestJson(endpoint, { operation });
    const call = h.calls.at(-1);
    assert.equal(call.options.headers['X-GIB-M1-Read-ID'], id);
    assert.deepEqual(JSON.parse(call.options.body), { operation });
    assert.deepEqual(h.logs.slice(-2).map(x => x.state), ['start', 'received']);
    assert.equal(h.logs.at(-1).operation, operation);
    assert.equal(h.logs.at(-1).requestId, id);
  }
  const count = h.logs.length;
  for (const operation of ['adjust', 'correct', 'void', 'recoveryDecide']) await h.ctx.requestJson(endpoint, { operation, requestId: 'original-save' });
  for (const origin of ['https://gib-live.netlify.app', 'https://gib-richmond-test.netlify.app']) {
    h.ctx.location.origin = origin;
    await h.ctx.requestJson(endpoint, { operation: 'review' });
  }
  assert.equal(h.logs.length, count);
  assert.ok(h.calls.slice(5).every(x => !x.options.headers['X-GIB-M1-Read-ID']));
  assert.doesNotMatch(JSON.stringify(h.logs), /PRIVATE_|original-save/);
});
test('Staff trace distinguishes response failure from client cutoff and cannot make logging failure affect reads', async () => {
  const h = harness();
  h.ctx.fetch = async () => Response.json({ ok: false, code: 'STAFF_TIME_REVIEW_HTML', message: 'PRIVATE_BODY' }, { status: 502, headers: { 'X-GIB-M1-Read-ID': id } });
  await assert.rejects(h.ctx.requestJson(endpoint, { operation: 'review' }));
  assert.equal(h.logs.at(-1).category, 'STAFF_TIME_REVIEW_HTML');
  assert.equal(h.logs.at(-1).status, 502);
  h.ctx.fetch = async (_url, options) => new Promise((_yes, no) => options.signal.addEventListener('abort', () => no(new Error('PRIVATE_ERROR'))));
  await assert.rejects(h.ctx.requestJson(endpoint, { operation: 'review' }, { timeoutMs: 1 }), { code: 'REQUEST_TIMEOUT' });
  assert.equal(h.logs.at(-1).state, 'timeout');
  h.ctx.console.info = () => { throw new Error('logging unavailable'); };
  h.ctx.fetch = async () => Response.json({ ok: true });
  assert.equal((await h.ctx.requestJson(endpoint, { operation: 'review' })).ok, true);
  assert.doesNotMatch(JSON.stringify(h.logs), /PRIVATE_/);
});
