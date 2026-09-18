import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handleAdminVoid } from '../netlify/functions/m1-admin-void.mjs';
import { handleAdminReview } from '../netlify/functions/m1-admin-review.mjs';
import { handleAdminSearch } from '../netlify/functions/m1-admin-search.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { REMOVAL_VERSION, sanitizeRemovalReceipt } from '../netlify/functions/_lib/m1-revolution-removal.mjs';

const origin = 'https://deploy-preview-99--gib-live.netlify.app';
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-receiver-secret-distinct-1234567890',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-admin-secret-distinct-1234567890' };
const now = Date.parse('2026-09-18T18:00:00Z');
const token = 'synthetic-request-token-1234567890abcdefgh';
const config = runtimeConfig(env, { admin: true, requestUrl: origin + '/m1/admin/', installationId: 'rev' });
const cookie = ADMIN_COOKIE + '=' + encodeURIComponent(createAdminSession('Stuart Turner', config.sessionSecret, now, token));
const rowId = 'gib-m1-12345678-1234-4123-8123-123456789abc';
const requestValue = { removalVersion: REMOVAL_VERSION, operation: 'remove', requestId: 'gib-m1-admin-void-' + rowId,
  rowId, fingerprint: 'a'.repeat(64), reason: 'Incorrect class selected' };
const record = { timestamp: '2026-09-17 17:25:00', date: '2026-09-17', classLabel: '5:30 PM BJJ (Level 2)',
  duration: 1, instructor: 'QA Removal Instructor', site: 'Rev', device: 'Front Desk Tablet (Rev)', build: 'Synthetic TEST', notes: '', status: 'VOID' };
const receipt = { ok: true, removalVersion: REMOVAL_VERSION, requestId: requestValue.requestId, rowId,
  fingerprint: requestValue.fingerprint, state: 'removed', record,
  operationRecord: { adminName: 'Stuart Turner', reason: requestValue.reason },
  audit: { actionNumber: 12, adminName: 'Stuart Turner', actionTime: '2026-09-18 14:00:00', reason: requestValue.reason } };
function request(body = requestValue, headers = {}, url = origin + '/.netlify/functions/m1-admin-void') {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
    Cookie: cookie, [ADMIN_REQUEST_HEADER]: token, ...headers }, body: JSON.stringify(body) });
}
const response = value => new Response(JSON.stringify(value), { status: 200 });
const dependencies = { installationId: 'rev', env, now, dateNow: new Date(now) };

test('Revolution endpoint derives actor from verified session and forwards exact TEST scope', async () => {
  let sent;
  const result = await handleAdminVoid(request(), { ...dependencies, fetch: async (_url, options) => {
    sent = JSON.parse(options.body); return response(receipt);
  } });
  assert.equal(result.status, 200);
  assert.equal(sent.adminName, 'Stuart Turner');
  assert.equal(sent.action, 'revolutionSigninRemoval');
  assert.equal(sent.installation, 'rev');
  assert.equal(sent.environment, 'test');
  assert.equal(sent.target, 'test');
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal((await result.json()).state, 'removed');
});

test('missing session/request proof, actor injection, foreign origins and altered paths fail before Google', async () => {
  for (const candidate of [request(requestValue, { Cookie: '' }), request(requestValue, { [ADMIN_REQUEST_HEADER]: '' }),
    request({ ...requestValue, adminName: 'Andrew Smith' }), request(requestValue, { Origin: 'https://gib-richmond-live.netlify.app' }),
    request(requestValue, {}, 'https://gib-richmond-live.netlify.app/.netlify/functions/m1-admin-void'),
    request(requestValue, {}, origin + '/.netlify/functions/m1-admin-void?target=production'),
    request(requestValue, { 'Sec-Fetch-Site': 'cross-site' }),
    request({ ...requestValue, rowId: 'sheet-row-2' }), request({ ...requestValue, reason: '=unsafe' })]) {
    let calls = 0;
    const result = await handleAdminVoid(candidate, { ...dependencies, fetch: async () => { calls++; throw new Error('Must not call'); } });
    assert.ok(result.status >= 400);
    assert.equal(calls, 0);
  }
});

test('receiver receipts require exact record identity and agreement between operation, status and audit', () => {
  assert.ok(sanitizeRemovalReceipt(receipt, requestValue, true));
  for (const changed of [{ fingerprint: 'b'.repeat(64) }, { rowId: 'another-id' }, { audit: null },
    { operationRecord: null }, { operationRecord: { adminName: 'Andrew Smith', reason: requestValue.reason } },
    { record: { ...record, site: 'Richmond' } }, { record: { ...record, status: 'OK' } },
    { record: { ...record, instructor: 'Real Instructor' } }, { extra: true }]) {
    assert.equal(sanitizeRemovalReceipt({ ...receipt, ...changed }, requestValue, true), null);
  }
  assert.ok(sanitizeRemovalReceipt({ ...receipt, state: 'pending', record: { ...record, status: 'OK' }, audit: null }, requestValue, true));
});

test('unreadable or timed-out write acknowledgement never claims that nothing changed', async () => {
  for (const fetch of [async () => { throw new Error('Lost response'); }, async () => response({ ok: true })]) {
    const result = await handleAdminVoid(request(), { ...dependencies, fetch });
    const value = await result.json();
    assert.equal(value.ok, false);
    assert.equal(value.code, 'REMOVAL_UNCONFIRMED');
    assert.match(value.message, /not confirmed/);
    assert.doesNotMatch(value.message, /Nothing changed/);
  }
});

const publicRecord = { displayId: 'sheet-row-2', recordId: rowId, timestamp: record.timestamp, date: record.date,
  classLabel: record.classLabel, duration: 1, instructor: record.instructor, site: 'Rev', notes: '', source: 'Kiosk',
  reviewRequired: false, reviewMessage: '', removal: { eligible: true, fingerprint: requestValue.fingerprint, explanation: '', pending: null } };

test('Daily Review and instructor search use the same versioned record and pending-recovery contract', async () => {
  for (const pending of [null, { requestId: requestValue.requestId, adminName: 'Stuart Turner', reason: requestValue.reason }]) {
    const item = { ...publicRecord, removal: { ...publicRecord.removal, eligible: !pending,
      explanation: pending ? 'A saved removal needs confirmation.' : '', pending } };
    for (const search of [false, true]) {
      const body = { date: record.date, removalVersion: REMOVAL_VERSION, ...(search ? { instructor: record.instructor } : {}) };
      const handler = search ? handleAdminSearch : handleAdminReview;
      const result = await handler(request(body), { ...dependencies, fetch: async (_url, options) => {
        const sent = JSON.parse(options.body);
        assert.equal(sent.removalVersion, REMOVAL_VERSION);
        assert.equal(sent.installation, 'rev'); assert.equal(sent.environment, 'test');
        return response(search ? { ok: true, date: record.date, instructor: record.instructor, selectedDateRecords: [item], recentRecords: [item] }
          : { ok: true, date: record.date, records: [item], warnings: [], auditHistory: [] });
      } });
      assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
    }
  }
});

test('browser journal retains only the exact attendance operation and cannot store an authentication field', () => {
  const values = new Map();
  const context = vm.createContext({ window: {}, sessionStorage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)
  } });
  vm.runInContext(readFileSync(new URL('../m1/admin/removal-journal.js', import.meta.url), 'utf8'), context);
  const journal = context.window.M1RemovalJournal;
  const value = { request: requestValue, record: publicRecord, adminName: 'Stuart Turner' };
  journal.save(value);
  assert.deepEqual(JSON.parse(journal.read()), value);
  assert.throws(() => journal.save({ ...value, requestToken: 'must-never-be-stored' }));
  assert.throws(() => journal.save({ ...value, request: { ...requestValue, cookie: 'must-never-be-stored' } }));
  journal.clear();
  assert.equal(journal.read(), null);
});
