import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import {
  brandingForInstallation,
  MAX_NAME_SUGGESTIONS,
  normalizedNameSearchText,
  usefulNameSuggestions
} from '../m1/kiosk-enhancements-core.mjs';
import {
  installationProfile,
  scopedStorageKey
} from '../m1/installation-profile-core.mjs';

const moduleSource = await readFile(new URL('../m1/kiosk-enhancements.mjs', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../m1/kiosk-enhancements.css', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../m1/service-worker.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(
  new URL('../m1/assets/logo-sources.json', import.meta.url),
  'utf8'
));

test('name suggestions remain closed until a person types', () => {
  assert.deepEqual(usefulNameSuggestions(['Marvin', 'Mandy'], ''), []);
  assert.match(moduleSource, /input\.addEventListener\('input', renderSuggestions\)/u);
  assert.doesNotMatch(moduleSource, /input\.addEventListener\('focus'/u);
  assert.match(moduleSource, /input\.removeAttribute\('list'\)/u);
  assert.match(moduleSource, /Start typing your name/u);
  assert.match(moduleSource, /Don’t see your name\? Just type it\./u);
});

test('name suggestions are useful, touch-sized, and capped at six', () => {
  const roster = [
    'Marvin Ellis',
    'Marvin Jones',
    'Marvin Smith',
    'Marvin Taylor',
    'Marvin Turner',
    'Marvin White',
    'Marvin Young',
    'Mandy Brown'
  ];
  const matches = usefulNameSuggestions(roster, 'Mar');
  assert.equal(MAX_NAME_SUGGESTIONS, 6);
  assert.equal(matches.length, 6);
  assert.ok(matches.every(name => name.startsWith('Marvin')));
  assert.match(cssSource, /\.m1-name-suggestion[\s\S]*min-height: 50px/u);
});

test('name matching supports exact, partial, similar, punctuation, and spacing input', () => {
  const roster = [
    'Caroline O’Hara',
    'Cara O’Hara',
    'Mary-Jane Smith',
    'Mary Jones'
  ];
  assert.deepEqual(usefulNameSuggestions(roster, "Caroline O'Hara"), ['Caroline O’Hara']);
  assert.deepEqual(usefulNameSuggestions(roster, 'Cara'), ['Cara O’Hara']);
  assert.deepEqual(usefulNameSuggestions(roster, 'O’H'), ['Cara O’Hara', 'Caroline O’Hara']);
  assert.deepEqual(usefulNameSuggestions(roster, 'Mary - Jane'), []);
  assert.deepEqual(usefulNameSuggestions(roster, 'Completely New'), []);
  assert.equal(normalizedNameSearchText('  Caroline   O’Hara  '), "caroline o'hara");
});

test('free-form names remain allowed and kiosk save/sync code is not replaced', () => {
  assert.doesNotMatch(moduleSource, /localStorage|sessionStorage|fetch\s*\(/u);
  assert.doesNotMatch(moduleSource, /preventDefault\(\).*btnSignIn/su);
  assert.match(moduleSource, /document\.getElementById\(buttonId\)\?\.addEventListener\('click', closeSuggestions, \{ capture: true \}\)/u);
  assert.match(moduleSource, /event\.key === 'Escape'/u);
  assert.match(moduleSource, /pointerdown/u);
});

test('Revolution and Richmond keep independent rosters and correct branding', () => {
  const rev = installationProfile('rev');
  const richmond = installationProfile('richmond', 'production', 'active');
  assert.notEqual(
    scopedStorageKey(rev, 'gib_m1_instructor_names_v1'),
    scopedStorageKey(richmond, 'gib_m1_instructor_names_v1')
  );
  assert.deepEqual(brandingForInstallation(rev), {
    src: './assets/revolution-bjj-logo.webp',
    alt: 'Revolution BJJ logo',
    className: 'm1-kiosk-brand-rev'
  });
  assert.deepEqual(brandingForInstallation(richmond), {
    src: './assets/richmond-bjj-logo.webp',
    alt: 'Richmond Brazilian Jiu-Jitsu and Self-Defense Academy logo',
    className: 'm1-kiosk-brand-richmond'
  });
  assert.equal(richmond.featureFlags.staffClock, false);
  assert.equal(rev.featureFlags.staffClock, true);
});

test('official logo assets are local, optimized, attributable, and offline-cached', async () => {
  assert.equal(manifest.assets.length, 2);
  for (const asset of manifest.assets) {
    assert.match(asset.file, /^m1\/assets\/[a-z-]+\.webp$/u);
    assert.match(asset.officialSource, /^https:\/(?:\/revolutionbjj\.com\/|\/images\.squarespace-cdn\.com\/)/u);
    assert.ok(asset.alt.length > 8);
    assert.ok(asset.assetBytes > 0 && asset.assetBytes < 100_000);
    const file = await stat(new URL(`../${asset.file}`, import.meta.url));
    assert.equal(file.size, asset.assetBytes);
    assert.match(workerSource, new RegExp(asset.file.replace('m1/', '').replaceAll('/', '\\/'), 'u'));
  }
  assert.doesNotMatch(moduleSource, /https?:\/\//u);
  assert.match(moduleSource, /image\.alt = branding\.alt/u);
});

test('Fire portrait layout keeps the form primary and suggestions compact', () => {
  assert.match(cssSource, /@media \(max-width: 899px\)/u);
  assert.match(cssSource, /max-height: 300px/u);
  assert.match(cssSource, /body\.kiosk-mode #kiosk/u);
  assert.match(cssSource, /max-height: 58px/u);
  assert.match(cssSource, /touch-action: manipulation/u);
});

test('shared kiosk enhancement assets are loaded and cached', () => {
  assert.match(workerSource, /kiosk-enhancements\.css/u);
  assert.match(workerSource, /kiosk-enhancements\.mjs/u);
  assert.match(workerSource, /kiosk-enhancements-core\.mjs/u);
  assert.match(workerSource, /revolution-bjj-logo\.webp/u);
  assert.match(workerSource, /richmond-bjj-logo\.webp/u);
});
