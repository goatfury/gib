import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import core from '../m1/temporary-classes-core.js';
import { installationProfile } from '../m1/installation-profile-core.mjs';
import { mutateAddedClasses, publicAddedClasses } from '../netlify/functions/_lib/m1-added-classes.mjs';

const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const kioskSource = readFileSync(new URL('../m1/added-classes-kiosk.js', import.meta.url), 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const now = Date.parse('2026-09-07T22:00:00Z');
const legacy = { id: 'local-old-series', label: 'QA TEST Advanced  Clinic', time: '18:00',
  days: ['Monday'], startDate: '2026-09-07', endDate: '2026-09-28', enabled: true };

test('importing a legacy label preserves the real kiosk duration match after the local choice is suppressed', async () => {
  const originalRules = [{ match: legacy.label, duration: 0.5 }];
  const runtime = vm.createContext({ loadDurationRules: () => originalRules,
    getSeriesTimeDisplay(time) { assert.equal(time, '18:00'); return { label: '6:00 PM' }; } });
  new vm.Script(`${between('function seriesLabel(', 'function seriesDaysLabel(')}
    ${between('function getDurationForClass(', '// Admin schedule editor state')}
    globalThis.hooks = { seriesLabel, getDurationForClass };`).runInContext(runtime);
  const before = runtime.hooks.seriesLabel(legacy);
  assert.equal(before, '6:00 PM QA TEST Advanced  Clinic');
  assert.equal(runtime.hooks.getDurationForClass(before), 0.5);

  for (const gymId of ['rev', 'richmond']) {
    const stored = new Map();
    const store = {
      async getWithMetadata(key) { const value = stored.get(key); return value ? { data: value, etag: 'v1' } : null; },
      async set(key, data, options) { assert.equal(options.onlyIfNew, true); stored.set(key, JSON.parse(data)); return { modified: true }; }
    };
    const imported = await mutateAddedClasses(store, gymId, { action: 'import', requestId: 'legacy-exact-duration-import',
      expectedVersion: 0, series: [legacy] }, now, 'Stuart Turner', 'production');
    const document = publicAddedClasses(imported.value, now);
    const profile = installationProfile(gymId, 'production', 'active');
    const root = { location: { href: profile.allowedOrigin + '/m1/' } };
    Function('globalThis', kioskSource)(root);
    const client = root.GIBM1AddedClassesKiosk.create({ core, profile, now: () => new Date(now),
      storage: { getItem: () => null, setItem() {} },
      fetch: async () => new Response(JSON.stringify(document), { headers: { 'Content-Type': 'application/json' } }),
      legacySeries: () => [legacy], legacyActive: () => true, legacyLabel: runtime.hooks.seriesLabel });
    assert.deepEqual(client.classesForDate('2026-09-07'), [before]);
    assert.equal(await client.refresh(), true);
    assert.deepEqual(client.unsharedLegacy(), [], 'The centrally imported identity suppresses its local duplicate');
    const after = client.classesForDate('2026-09-07');
    assert.deepEqual(after, [before], 'The central replacement must keep the exact former display label');
    assert.equal(runtime.hooks.getDurationForClass(after[0]), 0.5, 'Sharing cannot change a half-hour duration into one hour');
    assert.deepEqual(originalRules, [{ match: legacy.label, duration: 0.5 }]);
  }
});

test('preserving display labels keeps compatibility characters and spacing without relaxing normalized safety guards', () => {
  const label = 'QA TEST Ａdvanced  Clinic';
  assert.equal(core.normalizeSeries({ ...legacy, label }).label, label);
  assert.notEqual(core.seriesIdentity(legacy), core.seriesIdentity({ ...legacy, label: 'QA TEST Advanced Clinic' }),
    'Different existing duration-match labels must not suppress one another');
  for (const label of ['＝formula', '＋formula', '＠formula', '－formula', '＜svg onload=x＞', '<img src=x>',
    'QA TEST\nClinic', 'QA TEST\tClinic', 'QA TEST\u007fClinic']) {
    assert.equal(core.normalizeSeries({ ...legacy, label }), null, JSON.stringify(label));
  }
});
