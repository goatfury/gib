import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const data = JSON.parse(await readFile(new URL('../refined/refined-data.json', import.meta.url), 'utf8'));
const monthKey = (value) => value.slice(0, 7);
const approx = (actual, expected, tolerance = 0.0002) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test('refined data uses one fixed ten-month comparison window', () => {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.world.months.length, 10);
  assert.equal(data.gulf.months.length, 10);
  assert.deepEqual(
    data.world.months.map(({ month }) => monthKey(month)),
    data.gulf.months.map(({ month }) => monthKey(month)),
  );
  assert.equal(monthKey(data.world.months[0].month), '2025-09');
  assert.equal(monthKey(data.world.months.at(-1).month), '2026-06');
  assert.equal(data.world.months.filter(({ latest }) => latest).length, 1);
  assert.equal(data.gulf.months.filter(({ latest }) => latest).length, 1);
  assert.equal(data.world.months.at(-1).latest, true);
  assert.equal(data.gulf.months.at(-1).latest, true);
});

test('world refinery-output cohort is fixed and each total reconciles to its regions', () => {
  assert.equal(data.world.cohort.countryCount, 47);
  assert.equal(data.world.cohort.codes.length, 47);
  assert.equal(new Set(data.world.cohort.codes).size, 47);
  for (const month of data.world.months) {
    approx(Object.values(month.regions).reduce((sum, value) => sum + value, 0), month.value);
  }
  approx(data.world.baseline, data.world.months[0].value);
  approx(data.world.months.at(-1).value, 63.3139);
});

test('Gulf refined-products view is an explicit three-state reported cohort', () => {
  assert.deepEqual(data.gulf.cohort.codes, ['BH', 'KW', 'SA']);
  assert.equal(data.gulf.cohort.countryCount, 3);
  assert.deepEqual(data.gulf.cohort.missingGulfCodes, ['AE', 'IR', 'IQ', 'OM', 'QA']);
  for (const month of data.gulf.months) {
    approx(Object.values(month.countries).reduce((sum, value) => sum + value, 0), month.value);
  }
  approx(data.gulf.baseline, 3.08);
  approx(data.gulf.months.at(-1).value, 1.608);
});

test('source language does not mislabel JODI assessment colours as preliminary data', async () => {
  const wrapper = await readFile(new URL('../apply-refined-toggle.mjs', import.meta.url), 'utf8');
  const partsUrl = new URL('../refined/apply-toggle-parts/', import.meta.url);
  const partNames = (await readdir(partsUrl)).filter((name) => /^part-\d+\.txt$/.test(name)).sort();
  let source = wrapper;
  for (const name of partNames) source += await readFile(new URL(name, partsUrl), 'utf8');
  const dataText = await readFile(new URL('../refined/refined-data.json', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /June preliminary|preliminary release/i);
  assert.doesNotMatch(dataText, /preliminary/i);
  assert.match(source, /latest monthly release; subject to revision/i);
});
