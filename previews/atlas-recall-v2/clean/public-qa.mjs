import { chromium } from '/tmp/atlas-browser/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const url = process.env.TARGET_URL || 'https://atlas-recall-v2-review-019fb86e.netlify.app/';
const expected = process.env.EXPECTED_BUILD;
const dir = process.env.EVIDENCE_DIR || 'atlas-public-evidence';
fs.mkdirSync(dir, { recursive: true });
const report = { url, expectedBuild: expected, checkedAt: new Date().toISOString(), browser: 'Chromium / Playwright 1.55.0', tests: [], screenshots: [] };
const browser = await chromium.launch({ headless: true });
const errors = [];
let page;
const check = name => { report.tests.push({ name, passed: true }); console.log('PASS ' + name); };
async function screenshot(name) { await page.screenshot({ path: path.join(dir, name + '.png'), fullPage: true }); report.screenshots.push(name + '.png'); }
async function counts(c, k) { await page.waitForFunction(([c, k]) => document.querySelector('#countryCount')?.textContent === c + ' / 197' && document.querySelector('#capitalCount')?.textContent === k + ' / 197', [c, k], { timeout: 7000 }); }
async function enter(text, c, k, press = false) { await page.locator('#answerInput').fill(text); if (press) await page.locator('#answerInput').press('Enter'); await counts(c, k); }
async function shown(fragment) { await page.waitForFunction(fragment => document.querySelector('#feedback')?.textContent.includes(fragment), fragment, { timeout: 9000 }); }
async function fresh(viewport = { width: 1366, height: 768 }, mobile = false, clock = false) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  if (clock) { page = await context.newPage(); await page.clock.install({ time: new Date('2026-08-30T12:00:00Z') }); } else page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  assert.equal(page.url(), url, 'The tested page must be the exact public root, with no redirect to an alternate preview.');
  await page.waitForFunction(() => window.__ATLAS_READY === true, null, { timeout: 20000 });
  if (expected) assert.equal(await page.locator('body').getAttribute('data-build'), expected);
  return context;
}
try {
  // Wait for the actual public site to serve this exact fingerprint.
  let ready = false;
  for (let i = 0; i < 48; i++) {
    try { const response = await fetch(url + 'build.json', { cache: 'no-store' }); const build = await response.json(); if (!expected || build.buildId === expected) { ready = true; break; } } catch (_) { }
    await new Promise(r => setTimeout(r, 5000));
  }
  assert.ok(ready, 'The exact public URL did not publish the requested build.');
  let context = await fresh();
  const field = page.locator('#answerInput');
  assert.equal(await page.locator('input:visible').count(), 1);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('#zoomReadout').innerText(), '100%');
  assert.equal(await page.locator('#worldMap').getAttribute('viewBox'), '0 38 1200 534');
  assert.equal(await page.locator('#autoZoomBtn').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#hintBtn').innerText(), 'Hint');
  assert.equal(await page.getByText('Another hint', { exact: true }).count(), 0);
  assert.equal(await page.locator('#oddHintCard').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  const mapBox = await page.locator('.map-card').boundingBox();
  assert.ok(mapBox.height >= 540 && mapBox.width >= 1300);
  await screenshot('01-public-initial-1366x768');
  check('1366×768: fixed whole-world map at 100%, one input, visible Hint, no old hint card, no page scrolling');

  await field.pressSequentially('C', { delay: 70 });
  assert.match(await page.locator('#roundStatus').innerText(), /Round live/);
  await field.pressSequentially('anada', { delay: 70 });
  await counts(1, 0);
  assert.equal(await field.getAttribute('placeholder'), 'Capital of Canada?');
  assert.equal(await page.locator('#inputLabel').innerText(), 'Capital of Canada?');
  await screenshot('02-public-capital-of-canada');
  check('Typing the first letter starts the round; Canada counts and the same field asks for its capital');

  await enter('Ottawa', 1, 1);
  await shown('Ottawa');
  assert.match(await page.locator('#feedback').innerText(), /Spelling confirmed:[\s\S]*Ottawa/);
  await screenshot('03-public-ottawa-spelling-confirmed');
  await page.waitForTimeout(1500);
  assert.match(await page.locator('#feedback').innerText(), /Ottawa/);
  await page.waitForTimeout(850);
  check('Ottawa counts and its standard spelling remains prominent for approximately two seconds');

  await enter('South Africa', 2, 1);
  await field.fill('Pretora');
  await page.waitForTimeout(750);
  await counts(2, 1);
  assert.match(await page.locator('#matchCue').innerText(), /press Enter/);
  await field.press('Enter');
  await counts(2, 2);
  await shown('Pretoria');
  const correction = await page.locator('#feedback').innerText();
  assert.match(correction, /Correct spelling:[\s\S]*Pretoria/);
  assert.match(correction, /Pretora/);
  await screenshot('04-public-pretora-corrected-to-pretoria');
  await page.waitForTimeout(2300);
  check('Pretora does not auto-count; Enter accepts it and visibly shows both Pretoria and the typed misspelling');

  await field.pressSequentially('Niger', { delay: 45 });
  await page.waitForTimeout(600);
  await counts(2, 2);
  await field.pressSequentially('ia', { delay: 45 });
  await counts(3, 2);
  assert.equal(await field.getAttribute('placeholder'), 'Capital of Nigeria?');
  await enter('France', 4, 2);
  await shown('Abuja');
  assert.match(await page.locator('#feedback').innerText(), /Shown, not counted:[\s\S]*Abuja/);
  assert.equal(await field.getAttribute('placeholder'), 'Capital of France?');
  await screenshot('05-public-skipped-abuja-not-counted');
  assert.equal(await page.locator('#zoomReadout').innerText(), '100%');
  await page.waitForTimeout(2300);
  check('Nigeria is not accidentally consumed as Niger; the next country reveals Abuja without a capital point or map movement');

  await enter('Tokyo', 4, 3);
  await shown('Tokyo');
  assert.equal(await field.getAttribute('placeholder'), 'Capital of France?');
  assert.equal(await page.locator('#countryPercent').innerText(), '2%');
  assert.equal(await page.locator('#capitalPercent').innerText(), '2%');
  await screenshot('06-public-out-of-order-tokyo');
  check('An unrelated capital, Tokyo, counts out of order without crediting Japan as a recalled country');

  await page.locator('#hintBtn').click();
  assert.equal(await page.locator('#hintBadge').innerText(), 'Capital: P…');
  assert.equal(await page.locator('#hintBtn').innerText(), '2nd letter');
  await counts(4, 3);
  await screenshot('07-public-capital-first-letter');
  await page.locator('#hintBtn').click();
  assert.equal(await page.locator('#hintBadge').innerText(), 'Capital: Pa…');
  assert.equal(await page.locator('#hintBtn').isDisabled(), true);
  await counts(4, 3);
  await screenshot('08-public-capital-second-letter');
  check('Capital Hint reveals only P, then Pa; neither click changes progress');

  await field.press('Tab');
  assert.equal(await page.locator('#showBtn').isVisible(), false);
  await counts(4, 3);
  await shown('Paris');
  await page.waitForTimeout(2300);
  await page.locator('#hintBtn').click();
  assert.equal(await page.locator('#hintBadge').innerText(), 'Country: A…');
  assert.ok(await page.locator('[data-id="afghanistan"].hinted').count() > 0);
  assert.equal(await page.locator('.hinted.recalled').count(), 0);
  await screenshot('09-public-country-first-letter');
  await page.locator('#hintBtn').click();
  assert.equal(await page.locator('#hintBadge').innerText(), 'Country: Af…');
  await counts(4, 3);
  assert.equal(await page.locator('#zoomReadout').innerText(), '100%');
  await screenshot('10-public-country-second-letter');
  check('Blank Tab reveals without points; country Hint highlights unrecalled Afghanistan and reveals A then Af without zooming');

  await page.locator('#finishBtn').click();
  assert.equal(await page.locator('#answerKey').evaluate(e => e.open), true);
  assert.equal(await page.locator('#answerKeyTitle').innerText(), 'Complete answer key');
  assert.equal(await page.locator('#missedCountries li[data-country-id]').count(), 193);
  assert.equal(await page.locator('#missedCapitals li[data-country-id]').count(), 194);
  assert.equal(await page.locator('#fullReference .reference-row').count(), 197);
  assert.equal(await page.locator('#missedCountries [data-country-id="japan"]').count(), 1);
  assert.equal(await page.locator('#missedCapitals [data-country-id="japan"]').count(), 0);
  assert.equal(await page.locator('#missedCapitals [data-country-id="nigeria"]').count(), 1);
  assert.match(await page.locator('#missedCapitals [data-country-id="nigeria"]').innerText(), /Abuja/);
  await counts(4, 3);
  assert.match(await page.locator('#recordSummary').innerText(), /First capital baseline: 3 \/ 197.*Best: 3 \/ 197/);
  await screenshot('11-public-complete-answer-key');
  await page.locator('.reference summary').click();
  await page.locator('#fullReference .reference-row').last().scrollIntoViewIfNeeded();
  assert.match(await page.locator('#fullReference .reference-row').last().innerText(), /Zimbabwe[\s\S]*Harare/);
  await screenshot('12-public-full-reference-through-zimbabwe');
  check('Finish automatically opens 193 missed countries and 194 missed capitals separately, plus all 197 reference pairs; reveals add no points');

  await page.locator('#newRoundBtn').click();
  await counts(0, 0);
  assert.equal(await page.locator('#answerKey').evaluate(e => e.open), false);
  assert.equal(await page.locator('#timer').innerText(), '15:00');
  assert.equal(await page.locator('#hintBtn').innerText(), 'Hint');
  assert.equal(await page.locator('#hintBadge').isVisible(), false);
  assert.equal(await page.locator('#showBtn').isVisible(), false);
  assert.equal(await page.locator('#answerInput').inputValue(), '');
  assert.equal(await page.locator('#zoomReadout').innerText(), '100%');
  assert.equal(await page.locator('#autoZoomBtn').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.recalled,.hinted,.missed').count(), 0);
  assert.equal(await page.locator('#answerInput').isEnabled(), true);
  await screenshot('13-public-new-round-reset');
  check('New round resets both totals, pending capital, hints, map markings, timer, input and zoom while retaining the first baseline');

  await enter('Tokyo', 0, 1);
  await field.fill('qzxvblorp'); await field.press('Enter'); await page.waitForTimeout(450); await counts(0, 1);
  assert.match(await page.locator('#matchCue').innerText(), /Not recognized/);
  await enter('UK', 1, 1, true);
  await field.press('Enter'); await counts(1, 1); assert.equal(await page.locator('#showBtn').isVisible(), false);
  await enter('Canada', 2, 1); await page.locator('#showBtn').click(); await counts(2, 1);
  await enter('Ottawa', 2, 1, true); await page.waitForTimeout(400); await counts(2, 1);
  await enter('Kyrgistan', 3, 1, true);
  await enter('DRC', 4, 1, true);
  await page.locator('#zoomInBtn').click(); assert.notEqual(await page.locator('#zoomReadout').innerText(), '100%');
  await page.reload({ waitUntil: 'networkidle' }); await counts(0, 0);
  assert.equal(await page.locator('#zoomReadout').innerText(), '100%');
  assert.equal(await page.locator('#autoZoomBtn').getAttribute('aria-pressed'), 'false');
  check('Extra checks: capital-first entry, rejection of nonsense, UK/DRC/Kyrgistan aliases, blank Enter and Show skips, no points for previously shown answers, and no stale zoom on reload');
  await context.close();

  context = await fresh({ width: 1366, height: 768 }, false, true);
  await page.locator('#answerInput').fill('Canada'); await page.clock.fastForward(500); await counts(1, 0);
  await page.clock.fastForward(15 * 60 * 1000);
  assert.equal(await page.locator('#answerKey').evaluate(e => e.open), true);
  assert.equal(await page.locator('#endReason').innerText(), 'TIME IS UP');
  assert.equal(await page.locator('#missedCountries li[data-country-id]').count(), 196);
  assert.equal(await page.locator('#missedCapitals li[data-country-id]').count(), 197);
  assert.equal(await page.locator('#fullReference .reference-row').count(), 197);
  await counts(1, 0);
  await screenshot('14-public-timeout-answer-key');
  check('The actual 15-minute timer, advanced with browser virtual time, automatically opens a complete unscored answer key');
  await context.close();

  context = await fresh({ width: 390, height: 844 }, true);
  assert.equal(await page.locator('input:visible').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0);
  assert.equal(await page.locator('#hintBtn').isVisible(), true);
  assert.equal(await page.locator('#zoomReadout').innerText(), '100%');
  await screenshot('15-public-mobile-390x844');
  await enter('Canada', 1, 0);
  await page.locator('#hintBtn').click();
  assert.equal(await page.locator('#hintBadge').innerText(), 'Capital: O…');
  await screenshot('16-public-mobile-capital-hint');
  await page.setViewportSize({ width: 390, height: 480 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0);
  const inputBox = await page.locator('#answerInput').boundingBox();
  assert.ok(inputBox.y >= 0 && inputBox.y + inputBox.height <= 480);
  await screenshot('17-public-mobile-short-viewport');
  check('390px mobile: no horizontal or page overflow, usable map/input/Hint; shortened 480px viewport retains the input');
  await context.close();
  assert.deepEqual(errors, [], 'No browser script or console errors');
  check('No browser JavaScript or console errors across desktop, timeout and mobile flows');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack || String(error);
  if (page && !page.isClosed()) { try { await screenshot('FAILED-current-state'); report.visibleText = (await page.locator('body').innerText()).slice(0, 18000); } catch (_) {} }
  throw error;
} finally {
  report.consoleErrors = errors;
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
