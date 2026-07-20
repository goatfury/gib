import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGET = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/';
const OUT = path.resolve('qa-public');
await mkdir(OUT, { recursive: true });

const report = { target: TARGET, acts: {}, mobile: {}, source: {}, errors: [] };
const browser = await chromium.launch({ headless: true });

const normalize = value => String(value)
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

const stringify = value => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
};

async function makePage(viewport = { width: 1440, height: 900 }, mobile = false) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('pageerror', error => errors.push(`page:${String(error?.stack || error)}`));
  const response = await page.goto(`${TARGET}?qa`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => typeof window.__tecmoBoSnapshot === 'function', null, { timeout: 30000 });
  await page.locator('#startButton').click();
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.waitForTimeout(180);
  return { context, page, errors, status: response?.status() ?? null };
}

async function snapshot(page) {
  return page.evaluate(() => window.__tecmoBoSnapshot());
}

async function descriptors(page) {
  return page.evaluate(() => {
    const qa = window.__tecmoBoQA || {};
    return Object.keys(qa)
      .filter(key => typeof qa[key] === 'function')
      .map(key => ({ key, arity: qa[key].length, source: String(qa[key]).slice(0, 350) }));
  });
}

async function invoke(page, key, args) {
  return page.evaluate(({ key, args }) => {
    const qa = window.__tecmoBoQA || {};
    try { return { ok: true, value: qa[key](...args) }; }
    catch (error) { return { ok: false, error: String(error?.stack || error) }; }
  }, { key, args });
}

function joinedSnapshot(snapshot) {
  return [
    snapshot.storyAct, snapshot.storyEvent, snapshot.storyPhase, snapshot.storyBeatIndex,
    snapshot.storyIntroBeat, snapshot.storyIntroTitle, snapshot.storyIntroObjective,
    snapshot.persistentActHud, snapshot.worldEvent, snapshot.banner, snapshot.eventBossId,
    snapshot.quarterPresentationKind, snapshot.gameplayPhaseLabel
  ].map(stringify).join(' ').toLowerCase();
}

function actMatch(act, snapshot) {
  const joined = joinedSnapshot(snapshot);
  const quarterMatch = Number(snapshot.quarter) === act.number || String(snapshot.storyAct ?? '').includes(String(act.number));
  const wordMatch = act.identity.some(word => joined.includes(word));
  const introSignal = snapshot.storyIntroActive === true || Boolean(snapshot.storyIntroBeat) || Boolean(snapshot.storyIntroTitle) || Boolean(snapshot.persistentActHud);
  return { matched: (quarterMatch || wordMatch) && introSignal, joined, quarterMatch, wordMatch, introSignal };
}

async function triggerAct(page, act) {
  const list = await descriptors(page);
  const ranked = list.map(item => {
    const words = normalize(item.key);
    const identityHits = act.helperIdentity.filter(word => words.includes(word)).length;
    const actionHits = ['intro','story','force','begin','start','trigger','quarter','act'].filter(word => words.includes(word)).length;
    return { ...item, words, score: identityHits * 20 + actionHits * 4 };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const attempts = [];
  for (const item of ranked.slice(0, 12)) {
    const wordSet = new Set(item.words);
    const argumentSets = [];
    if (act.helperIdentity.some(word => wordSet.has(word))) argumentSets.push([]);
    if (wordSet.has('quarter') || wordSet.has('act') || wordSet.has('story')) {
      argumentSets.push([act.number]);
      argumentSets.push([`q${act.number}`]);
      argumentSets.push([act.event]);
      if (wordSet.has('clock') || wordSet.has('time')) argumentSets.push([act.number, 120]);
    }
    if (!argumentSets.length) argumentSets.push([]);
    const deduped = [...new Map(argumentSets.map(args => [JSON.stringify(args), args])).values()];
    for (const args of deduped) {
      const invocation = await invoke(page, item.key, args);
      await page.waitForTimeout(180);
      const snap = await snapshot(page);
      const match = actMatch(act, snap);
      attempts.push({ key: item.key, args, invocation, match: { ...match, joined: match.joined.slice(0, 800) } });
      if (invocation.ok && match.matched) return { success: true, key: item.key, args, attempts, snapshot: snap, match };
    }
  }
  return { success: false, attempts, available: list.map(item => item.key) };
}

try {
  const sourceResponse = await fetch(TARGET, { redirect: 'follow' });
  const source = await sourceResponse.text();
  const lower = source.toLowerCase();
  report.source = {
    status: sourceResponse.status,
    q2: lower.includes('alien') && lower.includes('mothership') && (lower.includes('invade') || lower.includes('invasion')),
    q3: lower.includes('olympus') && lower.includes('zeus') && lower.includes('god'),
    q4: lower.includes('nuclear') && lower.includes('surviv') && lower.includes('machine'),
    introTelemetry: lower.includes('storyintroactive') && lower.includes('persistentacthud'),
  };

  const acts = [
    { id: 'q2', number: 2, event: 'alien', helperIdentity: ['q2','alien','invasion'], identity: ['alien','mothership','invasion'] },
    { id: 'q3', number: 3, event: 'olympus', helperIdentity: ['q3','olympus','god'], identity: ['olympus','zeus','god'] },
    { id: 'q4', number: 4, event: 'nuclear', helperIdentity: ['q4','nuclear','apocalypse'], identity: ['nuclear','surviv','machine','last game'] },
  ];

  const hashes = new Set();
  let allPassed = sourceResponse.ok && report.source.q2 && report.source.q3 && report.source.q4 && report.source.introTelemetry;

  for (const act of acts) {
    const { context, page, errors, status } = await makePage();
    const triggered = await triggerAct(page, act);
    const intro = triggered.snapshot || await snapshot(page);
    const introMatch = actMatch(act, intro);
    const introBuffer = await page.locator('#game').screenshot({ path: path.join(OUT, `${act.id}-story-intro.png`) });
    const introHash = createHash('sha256').update(introBuffer).digest('hex');
    await page.waitForTimeout(1200);
    const active = await snapshot(page);
    const activeMatch = actMatch(act, active);
    const activeBuffer = await page.locator('#game').screenshot({ path: path.join(OUT, `${act.id}-story-active.png`) });
    const activeHash = createHash('sha256').update(activeBuffer).digest('hex');
    hashes.add(activeHash);

    const timeScale = Number(intro.storyTimeScale);
    const timeScaleOkay = !Number.isFinite(timeScale) || (timeScale > 0 && timeScale <= 1);
    const carrierOkay = intro.activeCarrierVisible !== false && active.activeCarrierVisible !== false;
    const hudOkay = Boolean(intro.persistentActHud) || Boolean(active.persistentActHud) || Boolean(intro.storyIntroTitle) || Boolean(intro.storyIntroBeat);
    const actPassed = status === 200 && triggered.success && introMatch.matched && (activeMatch.wordMatch || activeMatch.quarterMatch) && hudOkay && carrierOkay && timeScaleOkay && errors.length === 0;
    report.acts[act.id] = {
      status,
      triggered: { success: triggered.success, key: triggered.key, args: triggered.args, attempts: triggered.attempts?.slice(-8), available: triggered.available },
      intro: { match: { ...introMatch, joined: introMatch.joined.slice(0, 1200) }, storyIntroActive: intro.storyIntroActive, storyIntroBeat: intro.storyIntroBeat, storyIntroTitle: intro.storyIntroTitle, storyIntroObjective: intro.storyIntroObjective, persistentActHud: intro.persistentActHud, storyTimeScale: intro.storyTimeScale, activeCarrierVisible: intro.activeCarrierVisible },
      active: { match: { ...activeMatch, joined: activeMatch.joined.slice(0, 1200) }, persistentActHud: active.persistentActHud, activeCarrierVisible: active.activeCarrierVisible },
      screenshots: { introHash, activeHash },
      checks: { hudOkay, carrierOkay, timeScaleOkay },
      errors,
      passed: actPassed,
    };
    if (!actPassed) allPassed = false;
    await context.close();
  }

  const visualDistinct = hashes.size === 3;
  report.visualDistinct = { passed: visualDistinct, hashes: [...hashes] };
  if (!visualDistinct) allPassed = false;

  const mobile = await makePage({ width: 390, height: 844 }, true);
  const mobileAct = { id: 'q2', number: 2, event: 'alien', helperIdentity: ['q2','alien','invasion'], identity: ['alien','mothership','invasion'] };
  const mobileTriggered = await triggerAct(mobile.page, mobileAct);
  await mobile.page.waitForTimeout(750);
  const mobileSnapshot = await snapshot(mobile.page);
  const touchVisible = await mobile.page.locator('.touch-controls').isVisible().catch(() => false);
  await mobile.page.screenshot({ path: path.join(OUT, 'mobile-q2-story.png'), fullPage: true });
  const mobileMatch = actMatch(mobileAct, mobileSnapshot);
  const mobilePassed = mobile.status === 200 && mobileTriggered.success && mobileMatch.matched && touchVisible && mobileSnapshot.activeCarrierVisible !== false && mobile.errors.length === 0;
  report.mobile = { status: mobile.status, triggered: { success: mobileTriggered.success, key: mobileTriggered.key, args: mobileTriggered.args }, match: { ...mobileMatch, joined: mobileMatch.joined.slice(0, 1000) }, touchVisible, activeCarrierVisible: mobileSnapshot.activeCarrierVisible, errors: mobile.errors, passed: mobilePassed };
  if (!mobilePassed) allPassed = false;

  report.passed = allPassed;
} catch (error) {
  report.failure = String(error?.stack || error);
  report.passed = false;
} finally {
  await browser.close();
  await writeFile(path.join(OUT, 'story-probe.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, source: report.source, acts: Object.fromEntries(Object.entries(report.acts).map(([key, value]) => [key, value.passed])), mobile: report.mobile.passed, visualDistinct: report.visualDistinct?.passed, failure: report.failure || null }));
  if (!report.passed) process.exitCode = 1;
}
