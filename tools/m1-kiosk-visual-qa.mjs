import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUTPUT_DIR = path.resolve('artifacts/m1-kiosk-qa');
const SILK_USER_AGENT = 'Mozilla/5.0 (Linux; U; en-US; KFTRWI Build/JDQ39) AppleWebKit/537.36 (KHTML, like Gecko) Silk/127.6.3 like Chrome/127.0.0.0 Safari/537.36';
const FIRE_VIEWPORT = Object.freeze({ width: 800, height: 1280, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const DESKTOP_VIEWPORT = Object.freeze({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const urls = Object.freeze({
  revBefore: process.env.REV_BEFORE_URL,
  revAfter: process.env.REV_AFTER_URL,
  richmondBefore: process.env.RICHMOND_BEFORE_URL,
  richmondAfter: process.env.RICHMOND_AFTER_URL
});

for (const [name, value] of Object.entries(urls)) {
  assert.match(value || '', /^https:\/\/[a-z0-9.-]+\.netlify\.app\/m1\/$/u, `${name} URL must be an exact Netlify M1 URL.`);
}
assert.ok(process.env.CHROME_PATH, 'CHROME_PATH is required.');

await mkdir(OUTPUT_DIR, { recursive: true });
const results = [];
const pageErrors = [];

function record(check, installation, detail = '') {
  results.push({ check, installation, detail, ok: true });
}

function storageKeys(installation) {
  const prefix = installation === 'richmond' ? 'gib_m1_richmond_' : 'gib_m1_';
  return Object.freeze({
    roster: `${prefix}instructor_names_v1`,
    signins: `${prefix}signins_v1`,
    queue: `${prefix}sync_queue_v1`,
    autoSync: `${prefix}sync_auto_v1`,
    deviceLabel: `${prefix}device_label_v1`
  });
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check'
  ]
});

async function newPage(viewport, silk = false) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  if (silk) await page.setUserAgent(SILK_USER_AGENT);
  page.on('pageerror', error => pageErrors.push(String(error && error.stack || error)));
  return { context, page };
}

async function openPage(page, url) {
  const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  assert.ok(response, `No document response for ${url}`);
  assert.equal(response.status(), 200, `Unexpected document status for ${url}`);
  await page.waitForSelector('#nameInput', { visible: true, timeout: 30_000 });
  await page.waitForSelector('.m1-kiosk-brand img', { visible: true, timeout: 30_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector('.m1-kiosk-brand img');
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }, { timeout: 30_000 });
}

async function capture(url, filename, viewport, silk = false) {
  const { context, page } = await newPage(viewport, silk);
  const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  assert.ok(response && response.status() === 200, `Could not capture ${url}`);
  await page.screenshot({ path: path.join(OUTPUT_DIR, filename), fullPage: true });
  await context.close();
}

async function setName(page, value) {
  await page.$eval('#nameInput', input => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (value) await page.type('#nameInput', value, { delay: 12 });
}

async function suggestionTexts(page) {
  return page.$$eval('.m1-name-suggestion', elements => elements.map(element => element.textContent.trim()));
}

async function waitForSuggestions(page) {
  await page.waitForFunction(() => {
    const list = document.getElementById('m1NameSuggestions');
    return Boolean(list && !list.hidden && list.children.length > 0);
  }, { timeout: 10_000 });
}

async function assertSuggestionsClosed(page) {
  const state = await page.$eval('#m1NameSuggestions', list => ({ hidden: list.hidden, count: list.children.length }));
  assert.equal(state.hidden, true);
  assert.equal(state.count, 0);
}

async function verifyBrandAndFold(page, installation) {
  const state = await page.evaluate(() => {
    const logo = document.querySelector('.m1-kiosk-brand img');
    const input = document.getElementById('nameInput');
    const classes = document.getElementById('toggleClasses');
    const signIn = document.getElementById('btnSignIn');
    const helper = document.getElementById('m1NameHelp');
    const staffClock = document.getElementById('staffClock');
    return {
      installation: document.documentElement.dataset.m1Installation,
      staffClockFlag: document.documentElement.dataset.m1StaffClock,
      logoOrigin: new URL(logo.src).origin,
      pageOrigin: location.origin,
      logoPath: new URL(logo.src).pathname,
      logoAlt: logo.alt,
      logoWidth: logo.naturalWidth,
      logoHeight: logo.naturalHeight,
      inputTop: input.getBoundingClientRect().top,
      classesTop: classes.getBoundingClientRect().top,
      signInBottom: signIn.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
      nativeList: input.getAttribute('list'),
      placeholder: input.placeholder,
      helper: helper && helper.textContent,
      staffClockDisplay: staffClock ? getComputedStyle(staffClock).display : 'missing'
    };
  });
  assert.equal(state.installation, installation);
  assert.equal(state.logoOrigin, state.pageOrigin);
  assert.match(state.logoPath, /^\/m1\/assets\/(?:revolution|richmond)-bjj-logo\.webp$/u);
  assert.ok(state.logoAlt.length > 8);
  assert.ok(state.logoWidth > 0 && state.logoHeight > 0);
  assert.equal(state.nativeList, null);
  assert.equal(state.placeholder, 'Start typing your name');
  assert.equal(state.helper, 'Don’t see your name? Just type it.');
  assert.ok(state.inputTop >= 0);
  assert.ok(state.classesTop < state.viewportHeight);
  assert.ok(state.signInBottom <= state.viewportHeight, `Sign-in button fell below the Fire portrait fold: ${state.signInBottom}/${state.viewportHeight}`);
  if (installation === 'richmond') {
    assert.equal(state.staffClockFlag, 'false');
    assert.equal(state.staffClockDisplay, 'none');
  } else {
    assert.equal(state.staffClockFlag, 'true');
  }
  record('official local logo and Fire portrait form hierarchy', installation, state.logoPath);
}

async function seedRoster(page, installation) {
  const keys = storageKeys(installation);
  const names = [
    'TEST Marvin Ellis',
    'TEST Marvin Jones',
    'TEST Marvin Smith',
    'TEST Marvin Taylor',
    'TEST Marvin Turner',
    'TEST Marvin White',
    'TEST Marvin Young',
    'TEST Mandy Brown',
    'TEST Mary-Jane Smith',
    'TEST Cara O’Hara',
    'TEST Caroline O’Hara'
  ];
  await page.evaluate(({ keys: browserKeys, names: browserNames, installation: browserInstallation }) => {
    localStorage.setItem(browserKeys.roster, JSON.stringify(browserNames));
    localStorage.setItem(browserKeys.autoSync, browserInstallation === 'rev' ? 'true' : 'false');
    localStorage.setItem(browserKeys.deviceLabel, 'TEST browser QA');
  }, { keys, names, installation });
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('#m1NameSuggestions', { timeout: 30_000 });
  return keys;
}

async function verifyNameInteraction(page, installation) {
  const input = await page.$('#nameInput');
  assert.ok(input);
  await input.focus();
  await assertSuggestionsClosed(page);
  record('focus opens no native or custom list', installation);

  await setName(page, 'Mar');
  await waitForSuggestions(page);
  const partial = await suggestionTexts(page);
  assert.ok(partial.length > 0 && partial.length <= 6);
  assert.ok(partial.every(name => name.includes('Marvin')));
  record('partial roster match capped at six', installation, `${partial.length} suggestions`);

  await page.click('.m1-name-suggestion');
  const selected = await page.$eval('#nameInput', inputElement => inputElement.value);
  assert.match(selected, /^TEST Marvin/u);
  await assertSuggestionsClosed(page);
  record('touch selection fills field and closes list', installation, selected);

  await setName(page, "TEST Zelda O'Rourke");
  await new Promise(resolve => setTimeout(resolve, 150));
  await assertSuggestionsClosed(page);
  assert.equal(await page.$eval('#nameInput', inputElement => inputElement.value), "TEST Zelda O'Rourke");
  record('unknown free-form name remains allowed', installation);

  await setName(page, 'Mary - Jane');
  await waitForSuggestions(page);
  assert.deepEqual(await suggestionTexts(page), ['TEST Mary-Jane Smith']);
  record('ordinary punctuation and spacing match', installation);

  await setName(page, 'OHara');
  await waitForSuggestions(page);
  const punctuationMatches = await suggestionTexts(page);
  assert.deepEqual(punctuationMatches, ['TEST Cara O’Hara', 'TEST Caroline O’Hara']);
  record('apostrophe variant match', installation);

  await page.keyboard.press('Escape');
  await assertSuggestionsClosed(page);
  record('Escape closes suggestions', installation);

  await setName(page, 'Mar');
  await waitForSuggestions(page);
  await page.click('.kiosk-heading');
  await assertSuggestionsClosed(page);
  record('outside tap closes suggestions', installation);

  await setName(page, 'Car');
  await waitForSuggestions(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.match(await page.$eval('#nameInput', inputElement => inputElement.value), /^TEST Car/u);
  await assertSuggestionsClosed(page);
  record('keyboard selection fills field and closes list', installation);
}

async function signInOnce(page, installation, keys, requireSync) {
  await setName(page, 'Marvin');
  await waitForSuggestions(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await page.click('#toggleClasses');
  await page.waitForSelector('#classListWrap input[type="checkbox"]', { visible: true, timeout: 30_000 });
  await page.click('#classListWrap input[type="checkbox"]');

  const before = await page.evaluate(browserKeys => ({
    signins: JSON.parse(localStorage.getItem(browserKeys.signins) || '[]').length,
    queue: JSON.parse(localStorage.getItem(browserKeys.queue) || '[]').length
  }), keys);

  let syncRequests = 0;
  const onRequest = request => {
    if (request.method() === 'POST' && request.url().includes('/api/m1-sync')) syncRequests += 1;
  };
  page.on('request', onRequest);
  const responsePromise = requireSync
    ? page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/m1-sync'), { timeout: 25_000 }).catch(() => null)
    : Promise.resolve(null);

  await page.click('#btnSignIn');
  await page.waitForSelector('#signInModal.show', { visible: true, timeout: 10_000 });
  await assertSuggestionsClosed(page);

  const after = await page.evaluate(browserKeys => ({
    signins: JSON.parse(localStorage.getItem(browserKeys.signins) || '[]').length,
    queue: JSON.parse(localStorage.getItem(browserKeys.queue) || '[]').length
  }), keys);
  assert.equal(after.signins, before.signins + 1);
  assert.equal(after.queue, before.queue + 1);
  await page.click('#btnConfirmSignInDone');

  if (requireSync) {
    const response = await responsePromise;
    assert.ok(response, 'Expected exactly one automatic sync request.');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(syncRequests, 1);
  } else {
    assert.equal(syncRequests, 0);
  }

  const finalCount = await page.evaluate(browserKeys => JSON.parse(localStorage.getItem(browserKeys.signins) || '[]').length, keys);
  assert.equal(finalCount, before.signins + 1);
  page.off('request', onRequest);
  record('one instructor action saves exactly one ledger and queue row', installation);
  if (requireSync) record('automatic sync fires exactly once', installation);
}

async function qaKiosk({ installation, url, cleanScreenshot, suggestionScreenshot, signIn = false }) {
  const { context, page } = await newPage(FIRE_VIEWPORT, true);
  await openPage(page, url);
  await verifyBrandAndFold(page, installation);
  await page.screenshot({ path: path.join(OUTPUT_DIR, cleanScreenshot), fullPage: true });
  const keys = await seedRoster(page, installation);
  await verifyNameInteraction(page, installation);

  await setName(page, 'Mar');
  await waitForSuggestions(page);
  await page.screenshot({ path: path.join(OUTPUT_DIR, suggestionScreenshot), fullPage: true });
  await page.keyboard.press('Escape');

  await signInOnce(page, installation, keys, signIn);
  await context.close();
}

async function qaAdmin(url) {
  const { context, page } = await newPage(DESKTOP_VIEWPORT, false);
  const response = await page.goto(new URL('admin/', url).href, { waitUntil: 'networkidle2', timeout: 60_000 });
  assert.ok(response && response.status() === 200);
  await page.waitForSelector('#testLoginButton', { visible: true, timeout: 30_000 });
  await page.select('#loginAdminName', 'Andrew Smith');
  await page.click('#testLoginButton');
  await page.waitForFunction(() => {
    const panel = document.getElementById('appPanel');
    return Boolean(panel && !panel.hidden);
  }, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const summary = document.getElementById('staffTimeSummary');
    return Boolean(summary && summary.textContent.trim() && summary.textContent.trim() !== 'Loading…');
  }, { timeout: 30_000 });
  assert.equal(await page.$eval('#staff-time', element => element.hidden), false);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'after-revolution-admin-desktop.png'), fullPage: true });
  record('authenticated Deploy Preview Admin loads Daily Review and Revolution Staff time', 'rev');
  await context.close();
}

try {
  await capture(urls.revBefore, 'before-revolution-fire.png', FIRE_VIEWPORT, true);
  await capture(urls.richmondBefore, 'before-richmond-fire.png', FIRE_VIEWPORT, true);
  await capture(urls.revBefore, 'before-revolution-desktop.png', DESKTOP_VIEWPORT, false);
  await capture(urls.richmondBefore, 'before-richmond-desktop.png', DESKTOP_VIEWPORT, false);

  await qaKiosk({
    installation: 'rev',
    url: urls.revAfter,
    cleanScreenshot: 'after-revolution-fire.png',
    suggestionScreenshot: 'after-revolution-fire-suggestions.png',
    signIn: true
  });
  await qaKiosk({
    installation: 'richmond',
    url: urls.richmondAfter,
    cleanScreenshot: 'after-richmond-fire.png',
    suggestionScreenshot: 'after-richmond-fire-suggestions.png',
    signIn: false
  });

  await capture(urls.revAfter, 'after-revolution-desktop.png', DESKTOP_VIEWPORT, false);
  await capture(urls.richmondAfter, 'after-richmond-desktop.png', DESKTOP_VIEWPORT, false);
  await qaAdmin(urls.revAfter);

  assert.deepEqual(pageErrors, [], `Browser page errors: ${pageErrors.join('\n')}`);
  await writeFile(path.join(OUTPUT_DIR, 'qa-report.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    urls,
    viewport: { firePortrait: FIRE_VIEWPORT, desktop: DESKTOP_VIEWPORT },
    checks: results,
    pageErrors
  }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, checks: results.length, pageErrors: pageErrors.length }, null, 2));
} finally {
  await browser.close();
}
