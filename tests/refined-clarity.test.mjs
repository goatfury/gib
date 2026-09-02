import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/clarity.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/clarity.js', import.meta.url), 'utf8');

test('refined mode carries explicit measurement labels and headline caveats', () => {
  assert.match(html, /id="refinedHeadlineCaveat"/);
  assert.match(html, /oil-atlas-clarity-2026-09-02/);
  assert.match(js, /Gulf reported exports/);
  assert.match(js, /Global refinery output/);
  assert.match(js, /not a Gulf total/);
  assert.match(js, /not a world total/);
});

test('reported and unreported Gulf states receive distinct map treatment', () => {
  assert.match(js, /refined-reported-land/);
  assert.match(js, /refined-unreported-land/);
  assert.match(js, /refinedMissingLandHatch/);
  assert.match(css, /regional-country\.refined-reported-land/);
  assert.match(css, /regional-country\.refined-unreported-land/);
});

test('refined takeaway is data-driven rather than a static caption', () => {
  assert.match(js, /relativePhrase/);
  assert.match(js, /gulfTakeaway/);
  assert.match(js, /worldTakeaway/);
  assert.match(js, /September 2025/);
});
