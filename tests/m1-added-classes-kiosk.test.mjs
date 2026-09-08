import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { installationProfile } from '../m1/installation-profile-core.mjs';
const require = createRequire(import.meta.url);
const core = require('../m1/temporary-classes-core.js');
const clientSource = readFileSync(new URL('../m1/added-classes-kiosk.js', import.meta.url), 'utf8');
const raw = { id: 'test-class', label: 'TEST Intro', time: '06:00', days: ['Monday'], startDate: '2026-09-07', endDate: '2026-09-28', enabled: true };
function documentFor(gymId = 'rev', version = 1, enabled = true, target = 'test') {
  const series = core.normalizeSeries({ ...raw, enabled });
  return { schema: core.SCHEMA, ok: true, target, gymId, timezone: core.TIME_ZONE, version,
    updatedAt: '2026-09-07T15:00:00Z', servedAt: '2026-09-07T15:00:00Z', current: true,
    series: [series], history: [{ seriesId: series.id, revision: version, fromDate: series.startDate, toDate: null, series }],
    importedIdentities: [core.seriesIdentity(raw)] };
}
function harness({ gymId = 'rev', target = 'test', href, cached, legacy = [], response = documentFor(gymId, 1, true, target), failure = false, storageFailure = false } = {}) {
  const profile = installationProfile(gymId, gymId === 'richmond' ? target : undefined, target === 'production' ? 'active' : undefined);
  const root = { location: { href: href ?? (gymId === 'rev'
    ? target === 'production' ? 'https://gib-live.netlify.app/m1/' : 'https://deploy-preview-83--gib-live.netlify.app/m1/'
    : target === 'production' ? 'https://gib-richmond-live.netlify.app/m1/' : 'https://gib-richmond-test.netlify.app/m1/') },
    setInterval: () => {}, addEventListener: () => {}, document: { addEventListener: () => {} } };
  Function('globalThis', clientSource)(root);
  const { create } = root.GIBM1AddedClassesKiosk;
  const key = `${profile.storagePrefix}added_classes_cache_v1`;
  const protectedValues = [[`${profile.storagePrefix}series_v1`, JSON.stringify(legacy)], [`${profile.storagePrefix}local_state_v2`, 'protected ledger and queue'], [`${profile.storagePrefix}duration_rules_v1`, 'protected lesson hours']];
  const values = new Map(protectedValues);
  if (cached) values.set(key, JSON.stringify({ document: cached, receivedAt: '2026-09-07T15:00:00Z' }));
  const reads = [], writes = [], calls = [], changes = [];
  const client = create({ core, profile, now: () => new Date('2026-09-07T16:00:00Z'),
    storage: { getItem: key => { reads.push(key); return values.get(key) || null; }, setItem(key, value) { if (storageFailure) throw new Error('full'); writes.push(key); values.set(key, value); } },
    fetch: async (url, options) => { calls.push({ url, options }); if (failure) throw new Error('offline'); return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }); },
    legacySeries: () => legacy,
    legacyActive: (series, day, date) => series.enabled !== false && series.days.includes(day) && date >= series.startDate && date <= series.endDate,
    legacyLabel: core.classLabel, onChange: value => changes.push(value)
  });
  return { client, key, values, protectedValues, reads, writes, calls, changes };
}
for (const gymId of ['rev', 'richmond']) for (const target of ['test', 'production']) {
  test(`${gymId} ${target}: central addition reaches independent cached client, survives reload, and creates no attendance`, async () => {
    const h = harness({ gymId, target });
    assert.equal(await h.client.refresh(), true);
    assert.deepEqual(h.client.classesForDate('2026-09-07'), ['6:00 AM TEST Intro']);
    assert.deepEqual(h.client.classesForDate('2026-09-08'), []);
    assert.deepEqual(h.client.classesForDate('2026-10-05'), []);
    assert.deepEqual(h.writes, [h.key]);
    assert.equal(h.calls[0].options.method, 'GET');
    for (const [key, value] of h.protectedValues) assert.equal(h.values.get(key), value);
    const offline = harness({ gymId, target, cached: h.client.state().document, failure: true });
    assert.deepEqual(offline.client.classesForDate('2026-09-28'), ['6:00 AM TEST Intro']);
    assert.equal(await offline.client.refresh(), false);
    assert.match(offline.client.state().message, /may be out of date.*Last checked/);
    assert.deepEqual(offline.writes, []);
  });
}
test('immutable verified TEST preview hosts fetch only TEST documents', async () => {
  for (const [gymId, href] of [
    ['rev', 'https://6a9f47b1a3ba58000842fb26--gib-live.netlify.app/m1/'],
    ['richmond', 'https://6a9f4818343c6eb16fd0d45f--gib-richmond-test.netlify.app/m1/']
  ]) {
    const h = harness({ gymId, href });
    assert.equal(await h.client.refresh(), true);
    assert.equal(h.client.state().document.target, 'test');
    assert.equal(h.calls.length, 1);
  }
});
test('unshared legacy survives failure; imported cancelled series never resurrects from preserved local data', async () => {
  const local = { ...raw, id: 'another-browser-random-id' };
  const h = harness({ legacy: [local], failure: true });
  assert.equal(await h.client.refresh(), false);
  assert.deepEqual(h.client.classesForDate('2026-09-07'), ['6:00 AM TEST Intro']);
  assert.match(h.client.state().message, /saved only on this browser/);
  const shared = harness({ legacy: [local], response: documentFor('rev', 2, false) });
  assert.equal(await shared.client.refresh(), true);
  assert.deepEqual(shared.client.classesForDate('2026-09-07'), []);
  assert.equal(shared.values.get('gib_m1_series_v1'), JSON.stringify([local]));
});
test('cross-gym, stale, malformed, and equal-version conflicting responses retain known-good cache', async () => {
  const current = documentFor('rev', 2);
  const conflict = documentFor('rev', 2, false);
  for (const response of [documentFor('richmond', 3), documentFor('rev', 1), { ok: true }, conflict]) {
    const h = harness({ cached: current, response });
    assert.equal(await h.client.refresh(), false);
    assert.equal(h.client.state().document.version, 2);
    assert.deepEqual(h.client.classesForDate('2026-09-07'), ['6:00 AM TEST Intro']);
    assert.deepEqual(h.writes, []);
  }
});
for (const gymId of ['rev', 'richmond']) for (const target of ['test', 'production']) {
  test(`${gymId} ${target}: wrong-gym and wrong-target documents cannot populate cache or replace known-good classes`, async () => {
    const current = documentFor(gymId, 2, true, target);
    const wrongTarget = target === 'test' ? 'production' : 'test';
    const wrongGym = gymId === 'rev' ? 'richmond' : 'rev';
    for (const rejected of [documentFor(gymId, 3, false, wrongTarget), documentFor(wrongGym, 3, false, target)]) {
      const fromInvalidCache = harness({ gymId, target, cached: rejected, response: rejected });
      assert.equal(fromInvalidCache.client.state().document, null);
      assert.deepEqual(fromInvalidCache.client.classesForDate('2026-09-07'), []);
      assert.equal(await fromInvalidCache.client.refresh(), false);
      assert.equal(fromInvalidCache.client.state().document, null);
      assert.deepEqual(fromInvalidCache.writes, []);
      const fromValidCache = harness({ gymId, target, cached: current, response: rejected });
      assert.equal(await fromValidCache.client.refresh(), false);
      assert.equal(fromValidCache.client.state().document.version, 2);
      assert.equal(fromValidCache.client.state().document.target, target);
      assert.equal(fromValidCache.client.state().document.gymId, gymId);
      assert.deepEqual(fromValidCache.client.classesForDate('2026-09-07'), ['6:00 AM TEST Intro']);
      assert.deepEqual(fromValidCache.writes, []);
      for (const [key, value] of fromValidCache.protectedValues) assert.equal(fromValidCache.values.get(key), value);
    }
  });
}
test('unknown or mismatched actual hosts never read shared cache or contact the service; local recovery remains available', async () => {
  const cases = [
    { href: '' },
    { href: 'https://gib-live.netlify.app.example.org/m1/' },
    { href: 'http://gib-live.netlify.app/m1/', target: 'production' },
    { href: 'https://gib-live.netlify.app:444/m1/', target: 'production' },
    { href: 'https://gib-richmond-test.netlify.app/m1/' },
    { href: 'https://gib-richmond-live.netlify.app/m1/', gymId: 'richmond', target: 'test' },
    { href: 'https://6a9f4818343c6eb16fd0d45f--gib-richmond-live.netlify.app/m1/', gymId: 'richmond', target: 'production' }
  ];
  for (const options of cases) {
    const document = documentFor(options.gymId || 'rev', 1, true, options.target || 'test');
    const h = harness({ ...options, cached: document, response: document, legacy: [raw] });
    h.client.start();
    assert.equal(await h.client.refresh(), false);
    assert.equal(h.client.state().document, null);
    assert.equal(h.reads.includes(h.key), false);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.client.classesForDate('2026-09-07'), ['6:00 AM TEST Intro']);
    assert.match(h.client.state().message, /could not be checked.*saved only on this browser/);
    for (const [key, value] of h.protectedValues) assert.equal(h.values.get(key), value);
  }
});
test('failed offline caching is visible without claiming the saved update will survive reload', async () => {
  const h = harness({ storageFailure: true });
  assert.equal(await h.client.refresh(), true);
  assert.match(h.client.state().message, /could not be saved for offline use/);
  assert.equal(h.client.state().cacheFailed, true);
});
test('kiosk uses existing deferred rollover to protect a sign-in in progress during class refresh', () => {
  const source = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
  assert.match(source, /legacySeries: loadSeries/);
  assert.match(source, /onChange\(state\)[\s\S]*?refreshScheduleViews\(\);/);
  assert.match(source, /function refreshScheduleViews\(\)[\s\S]*?dayRolloverController\.requestRefresh\(\)/);
  assert.match(source, /addedClassesClient\.classesForDate\(dateStr\)/);
});
