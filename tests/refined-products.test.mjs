import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const data = JSON.parse(await readFile(new URL('../refined/refined-data.json', import.meta.url), 'utf8'));
const nearlyEqual = (actual, expected, tolerance = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

const expectedMonths = [
  '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01',
  '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01',
];

test('refined layer uses one fixed ten-month reporting window', () => {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.source.name, 'JODI-Oil World Database');
  assert.match(data.source.overviewUrl, /^https:\/\/www\.jodidata\.org\//);
  assert.equal(data.source.reportedThrough, '2026-06-30');

  for (const view of [data.gulf, data.world]) {
    assert.deepEqual(view.months.map(({ month }) => month), expectedMonths);
    assert.equal(view.baselineMonth, expectedMonths[0]);
    nearlyEqual(view.baseline, view.months[0].value);
    assert.equal(view.months.filter(({ latest }) => latest).length, 1);
    assert.equal(view.months.at(-1).latest, true);
    assert.ok(view.months.every(({ value }) => Number.isFinite(value) && value >= 0));
  }
});

test('Gulf refined-product totals are reported values for the same three states every month', () => {
  assert.equal(data.gulf.metric, 'total oil product exports');
  assert.equal(data.gulf.cohort.countryCount, 3);
  assert.deepEqual(data.gulf.cohort.codes, ['BH', 'KW', 'SA']);
  assert.deepEqual(data.gulf.cohort.missingGulfCodes, ['AE', 'IR', 'IQ', 'OM', 'QA']);

  for (const month of data.gulf.months) {
    assert.deepEqual(Object.keys(month.countries).sort(), data.gulf.cohort.codes);
    nearlyEqual(
      Object.values(month.countries).reduce((sum, value) => sum + value, 0),
      month.value,
    );
  }

  const byMonth = Object.fromEntries(data.gulf.months.map((row) => [row.month, row.value]));
  nearlyEqual(byMonth['2025-09-01'], 3.08);
  nearlyEqual(byMonth['2025-10-01'], 2.62);
  nearlyEqual(byMonth['2026-02-01'], 3.346);
  nearlyEqual(byMonth['2026-04-01'], 1.231);
  nearlyEqual(byMonth['2026-06-01'], 1.608);
});

test('world refinery-output view keeps a fixed 47-country denominator', () => {
  assert.equal(data.world.metric, 'refinery output');
  assert.equal(data.world.cohort.countryCount, 47);
  assert.equal(data.world.cohort.codes.length, 47);
  assert.equal(new Set(data.world.cohort.codes).size, 47);
  assert.equal(data.world.cohort.countries.length, 47);
  assert.equal(
    Object.values(data.world.cohort.regionReporterCounts).reduce((sum, count) => sum + count, 0),
    47,
  );
  assert.equal(data.world.cohort.regionReporterCounts.russia, 0);
  assert.equal(data.world.cohort.regionReporterCounts.latam, 0);
  assert.equal(data.world.cohort.globalThroughputBenchmark2025, 86.89);
  assert.equal(data.world.cohort.approxBenchmarkCoveragePct, 74.2);

  for (const month of data.world.months) {
    nearlyEqual(
      Object.values(month.regions).reduce((sum, value) => sum + value, 0),
      month.value,
    );
  }

  const byMonth = Object.fromEntries(data.world.months.map((row) => [row.month, row.value]));
  nearlyEqual(byMonth['2025-09-01'], 64.4549);
  nearlyEqual(byMonth['2025-12-01'], 67.6124);
  nearlyEqual(byMonth['2026-05-01'], 58.2664);
  nearlyEqual(byMonth['2026-06-01'], 63.3139);
});

test('generated atlas contains the two-stream switch and explicit coverage caveats', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/refined-toggle.css', import.meta.url), 'utf8');
  const copiedData = JSON.parse(await readFile(new URL('../public/data/refined-products.json', import.meta.url), 'utf8'));

  assert.match(html, /Crude &amp; liquids/);
  assert.match(html, /Refined products/);
  assert.match(html, /data-stream="refined"/);
  assert.match(html, /(?:Unknown, not zero|Unreported is not zero)/);
  assert.match(html, /47-country/);
  assert.match(css, /html\.refined-products/);
  assert.deepEqual(copiedData, data);
});
