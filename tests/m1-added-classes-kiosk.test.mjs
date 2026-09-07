import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { installationProfile } from '../m1/installation-profile-core.mjs';
const require = createRequire(import.meta.url);
const core = require('../m1/temporary-classes-core.js');
const { create } = require('../m1/added-classes-kiosk.js');
const raw = { id: 'test-class', label: 'TEST Intro', time: '06:00', days: ['Monday'], startDate: '2026-09-07', endDate: '2026-09-28', enabled: true };
function documentFor(gymId = 'rev', version = 1, enabled = true) {
  const series = core.normalizeSeries({ ...raw, enabled });
  return { schema: core.SCHEMA, ok: true, target: 'test', gymId, timezone: core.TIME_ZONE, version,
    updatedAt: '2026-09-07T15:00:00Z', servedAt: '2026-09-07T15:00:00Z', current: true,
    series: [series], history: [{ seriesId: series.id, revision: version, fromDate: series.startDate, toDate: null, series }],
    importedIdentities: [core.seriesIdentity(raw)] };
}
function harness({ gymId = 'rev', cached, legacy = [], response = documentFor(gymId), failure = false, storageFailure = false } = {}) {
  const profile = installationProfile(gymId, gymId === 'richmond' ? 'test' : undefined);
  const key = `${profile.storagePrefix}added_classes_cache_v1`;
  const protectedValues = [['gib_m1_series_v1', JSON.stringify(legacy)], ['gib_m1_state_v1', 'protected ledger and queue'], ['gib_m1_duration_rules_v1', 'protected lesson hours']];
  const values = new Map(protectedValues);
  if (cached) values.set(key, JSON.stringify({ document: cached, receivedAt: '2026-09-07T15:00:00Z' }));
  const writes = [], calls = [], changes = [];
  const client = create({ core, profile, now: () => new Date('2026-09-07T16:00:00Z'),
    storage: { getItem: key => values.get(key) || null, setItem(key, value) { if (storageFailure) throw new Error('full'); writes.push(key); values.set(key, value); } },
    fetch: async (url, options) => { calls.push({ url, options }); if (failure) throw new Error('offline'); return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }); },
    legacySeries: () => legacy,
    legacyActive: (series, day, date) => series.enabled !== false && series.days.includes(day) && date >= series.startDate && date <= series.endDate,
    legacyLabel: core.classLabel, onChange: value => changes.push(value)
  });
  return { client, key, values, protectedValues, writes, calls, changes };
}
for (const gymId of ['rev', 'richmond']) {
  test(`${gymId}: central addition reaches independent cached client, survives reload, and creates no attendance`, async () => {
    const h = harness({ gymId });
    assert.equal(await h.client.refresh(), true);
    assert.deepEqual(h.client.classesForDate('2026-09-07'), ['6:00 AM TEST Intro']);
    assert.deepEqual(h.client.classesForDate('2026-09-08'), []);
    assert.deepEqual(h.client.classesForDate('2026-10-05'), []);
    assert.deepEqual(h.writes, [h.key]);
    assert.equal(h.calls[0].options.method, 'GET');
    for (const [key, value] of h.protectedValues) assert.equal(h.values.get(key), value);
    const offline = harness({ gymId, cached: h.client.state().document, failure: true });
    assert.deepEqual(offline.client.classesForDate('2026-09-28'), ['6:00 AM TEST Intro']);
    assert.equal(await offline.client.refresh(), false);
    assert.match(offline.client.state().message, /may be out of date.*Last checked/);
    assert.deepEqual(offline.writes, []);
  });
}
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
