import assert from 'node:assert/strict';
import test from 'node:test';
import core from '../m1/temporary-classes-core.js';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { ADDED_CLASSES_STORE, addedClassesKey, mutateAddedClasses, publicAddedClasses, readAddedClasses } from '../netlify/functions/_lib/m1-added-classes.mjs';
import { ADDED_CLASSES_PATH, handleM1AddedClasses } from '../netlify/functions/m1-added-classes.mjs';

const NOW = Date.parse('2026-09-07T23:00:00Z');
const ORIGIN = 'https://deploy-preview-901--gib-live.netlify.app';
const ENV = {
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_CLASSES/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-test-webhook-0123456789',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-test-admin-action-0123456789abcdef',
  GIB_M1_ENVIRONMENT: 'test',
  GIB_RICHMOND_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_TEST_CLASSES/exec',
  GIB_RICHMOND_TEST_WEBHOOK_TOKEN: 'synthetic-richmond-test-webhook-0123456789abcdef',
  GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN: 'synthetic-richmond-test-admin-action-0123456789abcdef'
};
const TOKEN = 'synthetic_admin_request_token_0123456789';
const context = { site: { id: 'synthetic-rev-site', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } };
const series = (extra = {}) => ({ id: '', label: 'TEST Intro', time: '18:00', days: ['Monday'], startDate: '2026-09-07', endDate: '2026-09-28', enabled: true, ...extra });
const mutation = (extra = {}) => ({ action: 'create', requestId: 'synthetic-create-0001', expectedVersion: 0, series: series(), ...extra });
class StrongStore {
  constructor() { this.data = new Map(); this.calls = []; this.sequence = 0; }
  async getWithMetadata(key, options) {
    assert.deepEqual(options, { type: 'json', consistency: 'strong' });
    this.calls.push(['read', key]);
    const stored = this.data.get(key);
    return stored ? { data: structuredClone(stored.value), etag: stored.etag } : null;
  }
  async set(key, serialized, options) {
    this.calls.push(['write', key]);
    const current = this.data.get(key);
    if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
    this.data.set(key, { value: JSON.parse(serialized), etag: `etag-${++this.sequence}` });
    return { modified: true };
  }
}
function request(body, { origin = ORIGIN, auth = true, requestToken = TOKEN, originHeader = origin, installationId = 'rev', environment } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: originHeader, 'Sec-Fetch-Site': 'same-origin' };
  if (body && auth) {
    const runtime = runtimeConfig(ENV, { requestUrl: `${origin}${ADDED_CLASSES_PATH}`, admin: true, installationId, environment });
    headers.Cookie = `${ADMIN_COOKIE}=${createAdminSession('Stuart Turner', runtime.sessionSecret, NOW, TOKEN)}`;
    headers[ADMIN_REQUEST_HEADER] = requestToken;
  }
  return new Request(`${origin}${ADDED_CLASSES_PATH}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const deps = store => ({ store, env: ENV, now: NOW, context, installationId: 'rev' });
async function create(store, extra = {}) { return mutateAddedClasses(store, 'rev', mutation(extra), NOW, 'Stuart Turner'); }

test('one-off uses the series mechanism, includes its only date, and allows a late same-day addition', async () => {
  const store = new StrongStore();
  const response = await handleM1AddedClasses(request(mutation({ series: series({ endDate: '2026-09-07' }) })), deps(store));
  assert.equal(response.status, 200);
  const doc = await response.json();
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-07'), ['6:00 PM TEST Intro']);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-08'), []);
  assert.ok(core.validateDocument(doc, 'rev'));
  assert.equal(store.calls.filter(call => call[0] === 'write').length, 1);
});
test('limited weekday dates cross months and include the end date exactly', () => {
  const value = series({ days: ['Tuesday', 'Thursday'], startDate: '2026-09-29', endDate: '2026-10-08' });
  assert.deepEqual(core.datesForSeries(value), ['2026-09-29', '2026-10-01', '2026-10-06', '2026-10-08']);
  assert.deepEqual(core.datesForSeries(value, { from: '2026-10-01', to: '2026-10-06' }), ['2026-10-01', '2026-10-06']);
});
test('New York date boundaries survive spring and fall daylight-saving changes', () => {
  assert.equal(core.todayInGym('2026-03-08T04:59:59Z'), '2026-03-07');
  assert.equal(core.todayInGym('2026-03-08T05:00:00Z'), '2026-03-08');
  assert.equal(core.todayInGym('2026-03-09T03:59:59Z'), '2026-03-08');
  assert.equal(core.todayInGym('2026-11-01T03:59:59Z'), '2026-10-31');
  assert.equal(core.todayInGym('2026-11-01T04:00:00Z'), '2026-11-01');
  assert.deepEqual(core.datesForSeries(series({ days: ['Sunday'], startDate: '2026-03-01', endDate: '2026-03-15' })), ['2026-03-01', '2026-03-08', '2026-03-15']);
  assert.deepEqual(core.datesForSeries(series({ days: ['Sunday'], startDate: '2026-10-25', endDate: '2026-11-08' })), ['2026-10-25', '2026-11-01', '2026-11-08']);
});
test('invalid dates, time, weekdays, control characters and non-occurring series are rejected', () => {
  for (const change of [{ startDate: '2026-02-30' }, { endDate: '2026-09-06' }, { time: '24:00' }, { time: '' }, { days: ['Mo'] }, { days: [] }, { label: '=formula' }, { label: 'bad\nlabel' }, { label: '<img src=x onerror=alert(1)>' }, { label: '＜svg onload=alert(1)＞' }, { enabled: 'true' }, { startDate: '2026-09-08', endDate: '2026-09-08' }, { cancelledDates: ['2026-09-08'] }]) assert.equal(core.normalizeSeries(series(change)), null);
});
test('normal weekly schedule is merged and remains present alongside added classes', () => {
  assert.deepEqual(core.classesForDate({ Monday: ['7:00 PM Regular', '6:00 PM TEST Intro', '9:00 AM Regular'] }, [series()], '2026-09-07'), ['9:00 AM Regular', '6:00 PM TEST Intro', '7:00 PM Regular']);
});
test('expiry keeps historical classes queryable and cancellation never changes earlier revisions', async () => {
  const store = new StrongStore();
  const created = await create(store);
  const historical = structuredClone(created.value.history[0]);
  const cancelled = await mutateAddedClasses(store, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-0001', expectedVersion: 1, seriesId: created.seriesIds[0], effectiveDate: '2026-09-14' }, NOW, 'Stuart Turner');
  const doc = publicAddedClasses(cancelled.value, NOW);
  assert.deepEqual(cancelled.value.history[0], historical);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-07'), ['6:00 PM TEST Intro']);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-14'), []);
  assert.deepEqual(core.classesForDate({}, doc, '2026-10-05'), []);
});
test('a today correction preserves previous dates and has no attendance/payroll store access', async () => {
  const store = new StrongStore();
  const original = series({ startDate: '2026-08-31' });
  const created = await create(store, { series: original });
  const corrected = await mutateAddedClasses(store, 'rev', { action: 'update', requestId: 'synthetic-update-0001', expectedVersion: 1, seriesId: created.seriesIds[0], series: { ...original, time: '19:00' } }, NOW, 'Stuart Turner');
  const doc = publicAddedClasses(corrected.value, NOW);
  assert.deepEqual(core.classesForDate({}, doc, '2026-08-31'), ['6:00 PM TEST Intro']);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-07'), ['7:00 PM TEST Intro']);
  assert.ok(store.calls.every(call => call[1] === 'test/rev/classes-v1'));
  assert.match(ADDED_CLASSES_STORE, /test/u);
});
test('single occurrence cancellation preserves all other dates', async () => {
  const store = new StrongStore();
  const created = await create(store);
  const changed = await mutateAddedClasses(store, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-0001', expectedVersion: 1, seriesId: created.seriesIds[0], date: '2026-09-14' }, NOW, 'Stuart Turner');
  const doc = publicAddedClasses(changed.value, NOW);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-07'), ['6:00 PM TEST Intro']);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-14'), []);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-21'), ['6:00 PM TEST Intro']);
});
test('editing an upcoming series cannot silently restore a cancelled occurrence', async () => {
  const store = new StrongStore();
  const created = await create(store);
  const cancelled = await mutateAddedClasses(store, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-one-date', expectedVersion: 1, seriesId: created.seriesIds[0], date: '2026-09-14' }, NOW, 'Stuart Turner');
  const changed = await mutateAddedClasses(store, 'rev', { action: 'update', requestId: 'synthetic-edit-after-cancel', expectedVersion: cancelled.value.version, seriesId: created.seriesIds[0], effectiveDate: '2026-09-14', series: series({ time: '19:00', cancelledDates: [] }) }, NOW, 'Stuart Turner');
  const doc = publicAddedClasses(changed.value, NOW);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-07'), ['6:00 PM TEST Intro']);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-14'), []);
  assert.deepEqual(core.classesForDate({}, doc, '2026-09-21'), ['7:00 PM TEST Intro']);
});
test('a future occurrence cancellation does not block a today rename of its remaining series', async () => {
  const store = new StrongStore();
  const original = series({ days: ['Tuesday', 'Thursday'], startDate: '2026-09-29', endDate: '2026-10-08' });
  const created = await create(store, { series: original });
  const cancelled = await mutateAddedClasses(store, 'rev', {
    action: 'cancel', requestId: 'future-series-cancel-oct01', expectedVersion: created.value.version,
    seriesId: created.seriesIds[0], date: '2026-10-01'
  }, NOW, 'Stuart Turner');
  const immutableHistory = structuredClone(cancelled.value.history);
  const renamed = await mutateAddedClasses(store, 'rev', {
    action: 'update', requestId: 'future-series-rename-today', expectedVersion: cancelled.value.version,
    seriesId: created.seriesIds[0], effectiveDate: '2026-09-07', series: { ...original, label: 'TEST Updated Month Series' }
  }, NOW, 'Stuart Turner');
  assert.equal(renamed.result, 'updated');
  assert.deepEqual(renamed.value.history.slice(0, immutableHistory.length), immutableHistory);
  assert.deepEqual(core.datesForSeries(renamed.value.series[0]), ['2026-09-29', '2026-10-06', '2026-10-08']);
  const doc = publicAddedClasses(renamed.value, NOW);
  for (const date of ['2026-09-29', '2026-10-06', '2026-10-08']) assert.deepEqual(core.classesForDate({}, doc, date), ['6:00 PM TEST Updated Month Series']);
  for (const date of ['2026-09-28', '2026-09-30', '2026-10-01', '2026-10-09']) assert.deepEqual(core.classesForDate({}, doc, date), []);
  assert.ok(core.validateDocument(doc, 'rev'));
});
test('cancel all remaining dates today works after cancelling one future occurrence', async () => {
  const store = new StrongStore();
  const original = series({ days: ['Tuesday', 'Thursday'], startDate: '2026-09-29', endDate: '2026-10-08' });
  const created = await create(store, { series: original });
  const single = await mutateAddedClasses(store, 'rev', {
    action: 'cancel', requestId: 'future-series-single-oct01', expectedVersion: created.value.version,
    seriesId: created.seriesIds[0], date: '2026-10-01'
  }, NOW, 'Stuart Turner');
  const immutableHistory = structuredClone(single.value.history);
  const cancelled = await mutateAddedClasses(store, 'rev', {
    action: 'cancel', requestId: 'future-series-cancel-all-now', expectedVersion: single.value.version,
    seriesId: created.seriesIds[0], effectiveDate: '2026-09-07'
  }, NOW, 'Stuart Turner');
  assert.equal(cancelled.result, 'cancelled');
  assert.deepEqual(cancelled.value.history.slice(0, immutableHistory.length), immutableHistory);
  assert.deepEqual(cancelled.value.series[0].cancelledDates, ['2026-10-01']);
  const doc = publicAddedClasses(cancelled.value, NOW);
  for (const date of ['2026-09-29', '2026-10-01', '2026-10-06', '2026-10-08']) assert.deepEqual(core.classesForDate({}, doc, date), []);
  assert.ok(core.validateDocument(doc, 'rev'));
});
test('a today correction supersedes a future API definition while keeping every past date and snapshot intact', async () => {
  const store = new StrongStore();
  const original = series({ startDate: '2026-08-31' });
  const created = await create(store, { series: original });
  const planned = await mutateAddedClasses(store, 'rev', {
    action: 'update', requestId: 'planned-future-name-change', expectedVersion: created.value.version,
    seriesId: created.seriesIds[0], effectiveDate: '2026-09-21', series: { ...original, label: 'TEST Planned Name' }
  }, NOW, 'Stuart Turner');
  const plannedDoc = publicAddedClasses(planned.value, NOW);
  assert.deepEqual(core.classesForDate({}, plannedDoc, '2026-09-14'), ['6:00 PM TEST Intro']);
  assert.deepEqual(core.classesForDate({}, plannedDoc, '2026-09-21'), ['6:00 PM TEST Planned Name']);
  const immutableHistory = structuredClone(planned.value.history);
  const changed = await mutateAddedClasses(store, 'rev', {
    action: 'update', requestId: 'today-replaces-future-name', expectedVersion: planned.value.version,
    seriesId: created.seriesIds[0], effectiveDate: '2026-09-07', series: { ...original, label: 'TEST Corrected Name' }
  }, NOW, 'Stuart Turner');
  const doc = publicAddedClasses(changed.value, NOW);
  assert.deepEqual(changed.value.history.slice(0, immutableHistory.length), immutableHistory);
  assert.deepEqual(core.classesForDate({}, doc, '2026-08-31'), ['6:00 PM TEST Intro']);
  for (const date of ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']) assert.deepEqual(core.classesForDate({}, doc, date), ['6:00 PM TEST Corrected Name']);
  assert.ok(core.validateDocument(doc, 'rev'));
});
test('upcoming original series can be cancelled today and past mutations are rejected', async () => {
  const store = new StrongStore();
  const created = await create(store, { series: series({ startDate: '2026-09-14' }) });
  await assert.rejects(mutateAddedClasses(store, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-past', expectedVersion: 1, seriesId: created.seriesIds[0], effectiveDate: '2026-09-06' }, NOW, 'Stuart Turner'), error => error.status === 400);
  const changed = await mutateAddedClasses(store, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-next', expectedVersion: 1, seriesId: created.seriesIds[0] }, NOW, 'Stuart Turner');
  assert.deepEqual(core.classesForDate({}, publicAddedClasses(changed.value, NOW), '2026-09-14'), []);
});
test('a retry is idempotent and a request ID cannot be reused for different content', async () => {
  const store = new StrongStore();
  const first = await create(store);
  const retry = await create(store);
  assert.equal(retry.retry, true);
  assert.equal(retry.value.version, 1);
  assert.deepEqual(retry.seriesIds, first.seriesIds);
  assert.equal(store.data.get(addedClassesKey('rev')).value.audit.length, 1);
  await assert.rejects(create(store, { series: series({ label: 'Another TEST class' }) }), error => error.status === 409);
});
test('independent imports deduplicate content despite local random IDs and preserve aliases after cancellation', async () => {
  const store = new StrongStore();
  const first = await create(store, { action: 'import', series: [series({ id: 'tablet_A' }), series({ id: 'tablet_B' })] });
  assert.equal(first.value.series.length, 1);
  const cancelled = await mutateAddedClasses(store, 'rev', { action: 'cancel', requestId: 'synthetic-cancel-0001', expectedVersion: first.value.version, seriesId: first.seriesIds[0] }, NOW, 'Stuart Turner');
  const imported = await create(store, { action: 'import', requestId: 'synthetic-import-two', expectedVersion: cancelled.value.version, series: [series({ id: 'tablet_C' })] });
  assert.equal(imported.result, 'duplicate');
  assert.equal(imported.value.series.length, 1);
  assert.equal(imported.value.series[0].enabled, false);
  assert.ok(publicAddedClasses(imported.value, NOW).importedIdentities.includes(core.seriesIdentity(series())));
});
test('simultaneous creates use compare-and-swap and never overwrite the winning change', async () => {
  const store = new StrongStore();
  const results = await Promise.allSettled([create(store), create(store, { requestId: 'synthetic-create-two', series: series({ label: 'Different TEST Class' }) })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const saved = await readAddedClasses(store, 'rev', NOW);
  assert.equal(saved.value.series.length, 1);
  assert.equal(saved.value.audit.length, 1);
});
test('simultaneous identical retries return one durable mutation', async () => {
  const store = new StrongStore();
  const results = await Promise.all([create(store), create(store)]);
  assert.equal(results.filter(result => result.retry).length, 1);
  assert.equal(store.data.get(addedClassesKey('rev')).value.audit.length, 1);
});
test('mutation retries across midnight keep their original date and do not repeat the write', async () => {
  for (const explicitDate of [false, true]) {
    const store = new StrongStore();
    const created = await create(store);
    const change = { action: 'cancel', requestId: 'synthetic-midnight-cancel', expectedVersion: 1, seriesId: created.seriesIds[0], ...(explicitDate ? { effectiveDate: '2026-09-07' } : {}) };
    const first = await mutateAddedClasses(store, 'rev', change, NOW, 'Stuart Turner');
    const retry = await mutateAddedClasses(store, 'rev', change, NOW + 86400000, 'Stuart Turner');
    assert.equal(retry.retry, true);
    assert.deepEqual(retry.value, first.value);
  }
});
test('gym namespaces do not share data even with the same synthetic store', async () => {
  const store = new StrongStore();
  await create(store);
  const richmond = await readAddedClasses(store, 'richmond', NOW);
  assert.equal(richmond.value.series.length, 0);
  const saved = await mutateAddedClasses(store, 'richmond', mutation(), NOW, 'Stuart Turner');
  assert.notEqual(saved.seriesIds[0], store.data.get(addedClassesKey('rev')).value.series[0].id);
});
test('public GET exposes class history but no audit names, request IDs, or auth data', async () => {
  const store = new StrongStore();
  await create(store);
  const response = await handleM1AddedClasses(request(), deps(store));
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(!raw.includes('Stuart Turner') && !raw.includes('synthetic-create') && !raw.includes('fingerprint') && !raw.includes('audit'));
  assert.ok(core.validateDocument(JSON.parse(raw), 'rev'));
  assert.match(response.headers.get('cache-control'), /no-store/u);
});
test('writes require an existing admin session and its request token', async () => {
  const store = new StrongStore();
  assert.equal((await handleM1AddedClasses(request(mutation(), { auth: false }), deps(store))).status, 401);
  assert.equal((await handleM1AddedClasses(request(mutation(), { requestToken: 'wrong' }), deps(store))).status, 403);
  assert.equal((await handleM1AddedClasses(request(mutation(), { originHeader: 'https://foreign.example' }), deps(store))).status, 403);
  assert.equal(store.calls.length, 0);
});
test('invalid action and request ID types reject before any class storage read/write', async () => {
  for (const change of [{ action: 'toString' }, { action: '__proto__' }, { action: ['create'] }, { requestId: 12345678 }]) {
    const store = new StrongStore();
    const response = await handleM1AddedClasses(request(mutation(change)), deps(store));
    assert.equal(response.status, 400);
    assert.equal(store.calls.length, 0);
  }
});
test('production host, published production context, unknown site and unproven contexts never open storage', async () => {
  const store = new StrongStore();
  for (const overrides of [
    { request: request(null, { origin: 'https://gib-live.netlify.app' }) },
    { context: { ...context, deploy: { context: 'production', published: true } } },
    { context: { ...context, deploy: { context: 'production', published: false } } },
    { context: { ...context, site: { id: 'other-site', name: 'other' } } },
    { context: {} }
  ]) {
    const response = await handleM1AddedClasses(overrides.request || request(), { ...deps(store), ...(overrides.context ? { context: overrides.context } : {}) });
    assert.equal(response.status, 403);
  }
  assert.equal(store.calls.length, 0);
});
test('Richmond TEST profile works; Richmond production profile cannot open the class store', async () => {
  const store = new StrongStore();
  const richContext = { site: { id: 'synthetic-rich-site', name: 'gib-richmond-test' }, deploy: { context: 'production', published: true } };
  const options = { origin: 'https://gib-richmond-test.netlify.app', installationId: 'richmond', environment: 'test' };
  const response = await handleM1AddedClasses(request(mutation(), options), { ...deps(store), context: richContext, installationId: 'richmond', environment: 'test' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).gymId, 'richmond');
  const count = store.calls.length;
  const rejected = await handleM1AddedClasses(request(null, { origin: 'https://gib-richmond-live.netlify.app' }), { ...deps(store), context: richContext, installationId: 'richmond', environment: 'production' });
  assert.equal(rejected.status, 403);
  assert.equal(store.calls.length, count);
});
test('storage failure and unconfirmed writes never report central success', async () => {
  const store = new StrongStore();
  store.set = async () => undefined;
  assert.equal((await handleM1AddedClasses(request(mutation()), deps(store))).status, 503);
  store.getWithMetadata = async () => { throw new Error('Synthetic storage failure'); };
  assert.equal((await handleM1AddedClasses(request(), deps(store))).status, 503);
});
test('client validation rejects the wrong gym, broken history and malformed dates', async () => {
  const store = new StrongStore();
  const saved = await create(store);
  const doc = publicAddedClasses(saved.value, NOW);
  assert.equal(core.validateDocument(doc, 'richmond'), null);
  const broken = structuredClone(doc);
  broken.history[0].series.startDate = '2026-02-30';
  assert.equal(core.validateDocument(broken, 'rev'), null);
  const missing = structuredClone(doc);
  missing.history = [];
  assert.equal(core.validateDocument(missing, 'rev'), null);
});
