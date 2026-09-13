import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { browserInstallationProfileSource, installationProfile } from '../m1/installation-profile-core.mjs';
import {
  PROMOTIONS_IDLE_MS,
  PROMOTIONS_SUCCESS_MS,
  createPromotionsLifecycle,
  promotionsEnabled
} from '../m1/promotions-core.mjs';

const KEY = 'test-promotion-pending';
const CONFIG = Object.freeze({ enabled: true, testOnly: true, endpoint: '/api/m1-promotions' });
const REQUEST = Object.freeze({
  operation: 'recordPromotion', requestId: 'req-tablet-stable-0001', studentId: 'fixture-student-001',
  expectedRevision: 1, action: 'stripe', approverId: 'TEST-COACH-A'
});
const clone = value => JSON.parse(JSON.stringify(value));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  const faults = {};
  return {
    data, writes, faults,
    getItem(key) {
      if (faults.read) throw new Error('Injected storage read failure');
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (faults.write) throw new Error('Injected storage write failure');
      if (!faults.dropWrite) data.set(key, String(value));
      writes.push(['set', key, String(value)]);
    },
    removeItem(key) {
      if (faults.remove) throw new Error('Injected storage removal failure');
      if (!faults.dropRemove) data.delete(key);
      writes.push(['remove', key]);
    }
  };
}

function lifecycleHarness({ storage = memoryStorage(), now = Date.parse('2026-09-13T16:00:00Z') } = {}) {
  const clock = { now };
  const clears = [];
  const lifecycle = createPromotionsLifecycle({ now: () => clock.now, storage, key: KEY, onClear: reason => clears.push(reason) });
  return {
    lifecycle, storage, clock, clears,
    advance(ms) { clock.now += ms; return lifecycle.check(); }
  };
}

test('the promotions pilot requires explicit TEST configuration and never enables any Richmond profile', () => {
  const rev = installationProfile('rev');
  assert.equal(promotionsEnabled(rev, CONFIG), true);
  for (const profile of [null, {}, installationProfile('richmond', 'test'),
    installationProfile('richmond', 'production', 'pending'), installationProfile('richmond', 'production', 'active')]) {
    assert.equal(promotionsEnabled(profile, CONFIG), false);
  }
  for (const config of [undefined, {}, { ...CONFIG, enabled: false }, { ...CONFIG, testOnly: false },
    { ...CONFIG, endpoint: 'https://unrelated.example/api/m1-promotions' }, { ...CONFIG, endpoint: '/api/m1-kiosk-sync' }]) {
    assert.equal(promotionsEnabled(rev, config), false);
  }
  assert.equal(promotionsEnabled({ ...rev, backend: { enabled: false } }, CONFIG), false);
});

test('lookup privacy deadline is sixty seconds of inactivity and uses elapsed wall time', () => {
  const h = lifecycleHarness();
  assert.equal(PROMOTIONS_IDLE_MS, 60_000);
  const token = h.lifecycle.open();
  assert.equal(h.lifecycle.isCurrent(token), true);
  h.advance(59_999);
  assert.equal(h.clears.length, 0);
  assert.equal(h.lifecycle.snapshot().active, true);
  h.advance(1);
  assert.equal(h.clears.length, 1);
  assert.equal(h.lifecycle.snapshot().active, false);
  assert.equal(h.lifecycle.isCurrent(token), false);
});

test('typing and intentional interaction extend lookup inactivity without creating an unrelated form timeout', () => {
  const h = lifecycleHarness();
  const token = h.lifecycle.open();
  h.advance(59_000); h.lifecycle.touch();
  h.advance(59_000); h.lifecycle.touch();
  h.advance(59_999);
  assert.equal(h.clears.length, 0);
  assert.equal(h.lifecycle.isCurrent(token), true);
  h.advance(1);
  assert.equal(h.clears.length, 1);
  h.lifecycle.touch(); h.advance(120_000);
  assert.equal(h.clears.length, 1, 'touching a closed log does not create a new reset deadline');
});

test('clear/back invalidates old lookup callbacks immediately and does not disturb the next person', () => {
  const h = lifecycleHarness();
  const first = h.lifecycle.open();
  h.lifecycle.leave('back');
  assert.equal(h.clears.length, 1);
  assert.equal(h.lifecycle.isCurrent(first), false);
  const next = h.lifecycle.open();
  assert.equal(h.lifecycle.isCurrent(next), true);
  assert.equal(h.lifecycle.isCurrent(first), false);
  h.advance(10_000); h.lifecycle.touch(); h.advance(49_999);
  assert.equal(h.lifecycle.isCurrent(next), true);
  assert.equal(h.clears.length, 1);
});

test('blocked navigation neither opens promotions nor mutates the existing kiosk transaction', () => {
  const h = lifecycleHarness();
  const untouched = h.lifecycle.snapshot();
  assert.equal(h.lifecycle.open({ blocked: true }), null);
  assert.deepEqual(h.lifecycle.snapshot(), untouched);
  assert.deepEqual(h.clears, []);
  assert.deepEqual(h.storage.writes, []);
});

test('confirmed save returns to sign-in after three seconds and later touches do not prolong its result', () => {
  const h = lifecycleHarness();
  assert.equal(PROMOTIONS_SUCCESS_MS, 3_000);
  h.lifecycle.open();
  h.lifecycle.begin(clone(REQUEST));
  h.lifecycle.reconcile(REQUEST.requestId);
  assert.equal(h.lifecycle.pending(), null);
  h.advance(2_900); h.lifecycle.touch(); h.advance(99);
  assert.equal(h.clears.length, 0);
  h.advance(1);
  assert.equal(h.clears.length, 1);
  assert.equal(h.lifecycle.snapshot().active, false);
});

test('begin durably retains one immutable request before dispatch and refuses duplicate or replacement saves', () => {
  const h = lifecycleHarness();
  h.lifecycle.open();
  const caller = clone(REQUEST);
  h.lifecycle.begin(caller);
  const durable = h.storage.data.get(KEY);
  assert.ok(durable);
  caller.approverId = 'TEST-COACH-B'; caller.studentId = 'different-student';
  assert.deepEqual(h.lifecycle.pending(), REQUEST);
  assert.throws(() => h.lifecycle.begin({ ...REQUEST, requestId: 'req-replacement-0002' }));
  assert.equal(h.storage.data.get(KEY), durable);
  assert.deepEqual(h.lifecycle.pending(), REQUEST);
});

test('unconfirmed save remains durable across back, sleep and reload without occupying sign-in', () => {
  const storage = memoryStorage({ 'gib_m1_auth': 'preserve', 'gib_m1_signin_queue': 'preserve', 'gib_m1b_staff_clock_state_v1': 'preserve' });
  const h = lifecycleHarness({ storage });
  h.lifecycle.open(); h.lifecycle.begin(clone(REQUEST));
  const original = storage.data.get(KEY);
  h.lifecycle.leave('back'); h.advance(10 * 60_000);
  assert.equal(h.lifecycle.snapshot().active, false);
  assert.deepEqual(h.lifecycle.pending(), REQUEST);
  assert.equal(storage.data.get(KEY), original);
  const reopened = lifecycleHarness({ storage, now: h.clock.now });
  assert.deepEqual(reopened.lifecycle.pending(), REQUEST);
  assert.equal(reopened.lifecycle.snapshot().active, false);
  for (const key of ['gib_m1_auth', 'gib_m1_signin_queue', 'gib_m1b_staff_clock_state_v1']) assert.equal(storage.data.get(key), 'preserve');
  assert.ok(storage.writes.every(([, key]) => key === KEY));
});

test('late confirmation may retire its durable request but cannot arm a reset for a newly opened interaction', () => {
  const h = lifecycleHarness();
  h.lifecycle.open(); h.lifecycle.begin(clone(REQUEST));
  h.lifecycle.leave('back');
  const next = h.lifecycle.open(); h.lifecycle.touch();
  const nextSnapshot = h.lifecycle.snapshot();
  h.lifecycle.reconcile(REQUEST.requestId);
  assert.equal(h.lifecycle.pending(), null);
  assert.equal(h.lifecycle.isCurrent(next), true);
  assert.equal(h.lifecycle.snapshot().deadline, nextSnapshot.deadline);
  h.advance(3_000);
  assert.equal(h.lifecycle.snapshot().active, true);
  assert.equal(h.clears.length, 1, 'only the explicit earlier Back cleared the screen');
});

test('an unrelated or repeated acknowledgment cannot clear a different pending request or reset a next-user view', () => {
  const h = lifecycleHarness();
  h.lifecycle.open(); h.lifecycle.begin(clone(REQUEST));
  const raw = h.storage.data.get(KEY);
  h.lifecycle.reconcile('req-unrelated-0009');
  assert.equal(h.storage.data.get(KEY), raw);
  assert.deepEqual(h.lifecycle.pending(), REQUEST);
  h.lifecycle.reconcile(REQUEST.requestId); h.lifecycle.leave('back');
  const next = h.lifecycle.open();
  h.lifecycle.reconcile(REQUEST.requestId);
  h.advance(3_001);
  assert.equal(h.lifecycle.isCurrent(next), true);
});

test('suspended timers clear expired lookup and save results on the next lifecycle check', () => {
  for (const phase of ['lookup', 'success']) {
    const h = lifecycleHarness();
    const token = h.lifecycle.open();
    if (phase === 'success') { h.lifecycle.begin(clone(REQUEST)); h.lifecycle.reconcile(REQUEST.requestId); }
    h.clock.now += 120_000; // No interval callback ran during browser suspension.
    assert.equal(h.lifecycle.snapshot().active, true);
    h.lifecycle.check();
    assert.equal(h.lifecycle.snapshot().active, false);
    assert.equal(h.lifecycle.isCurrent(token), false);
    assert.equal(h.clears.length, 1);
  }
});

test('failed or silently dropped local writes cannot permit a save to leave an unprotected request', () => {
  for (const fault of ['write', 'dropWrite']) {
    const storage = memoryStorage();
    const h = lifecycleHarness({ storage });
    h.lifecycle.open(); storage.faults[fault] = true;
    assert.throws(() => h.lifecycle.begin(clone(REQUEST)));
    assert.equal(h.lifecycle.snapshot().active, true);
    assert.equal(h.clears.length, 0);
    assert.equal(storage.data.has(KEY), false);
  }
});

test('unreadable or malformed pending state is preserved and cannot be overwritten with a fresh request', () => {
  for (const raw of ['not JSON', '{"version":999,"intent":{"requestId":"req-old-0001"}}', '{"version":1}']) {
    const storage = memoryStorage({ [KEY]: raw });
    const h = lifecycleHarness({ storage });
    h.lifecycle.open();
    assert.throws(() => h.lifecycle.begin(clone(REQUEST)));
    assert.equal(storage.data.get(KEY), raw);
    h.lifecycle.leave('back');
    assert.equal(storage.data.get(KEY), raw);
  }
  const storage = memoryStorage(); const h = lifecycleHarness({ storage });
  h.lifecycle.open(); storage.faults.read = true;
  assert.throws(() => h.lifecycle.begin(clone(REQUEST)));
  assert.equal(storage.writes.length, 0);
});

test('failed pending removal remains unconfirmed locally and does not start a false success reset', () => {
  for (const fault of ['remove', 'dropRemove']) {
    const storage = memoryStorage(); const h = lifecycleHarness({ storage });
    h.lifecycle.open(); h.lifecycle.begin(clone(REQUEST));
    const raw = storage.data.get(KEY); storage.faults[fault] = true;
    assert.throws(() => h.lifecycle.reconcile(REQUEST.requestId));
    assert.equal(storage.data.get(KEY), raw);
    assert.deepEqual(h.lifecycle.pending(), REQUEST);
    assert.notEqual(h.lifecycle.snapshot().phase, 'success');
    h.advance(3_001);
    assert.equal(h.lifecycle.snapshot().active, true);
  }
});

test('a late lookup callback cannot remain current after the wall-clock deadline when timers were suspended', () => {
  const h = lifecycleHarness();
  const old = h.lifecycle.open();
  h.clock.now += 60_001;
  assert.equal(h.lifecycle.isCurrent(old), false);
  assert.equal(h.clears.length, 1);
  assert.equal(h.lifecycle.snapshot().active, false);
});

test('an explicitly checked restored request can confirm in the current interaction without inheriting its old session', () => {
  const storage = memoryStorage(); const first = lifecycleHarness({ storage });
  first.lifecycle.open(); first.lifecycle.begin(clone(REQUEST)); first.lifecycle.leave('back');
  const resumed = lifecycleHarness({ storage });
  const token = resumed.lifecycle.open();
  resumed.lifecycle.reconcile(REQUEST.requestId, { token });
  assert.equal(resumed.lifecycle.snapshot().phase, 'success');
  resumed.advance(3_000);
  assert.equal(resumed.lifecycle.snapshot().active, false);
  assert.equal(storage.data.has(KEY), false);
});

test('known rejected requests release only their matching intent without showing success or resetting an active form', () => {
  const h = lifecycleHarness(); h.lifecycle.open(); h.lifecycle.begin(clone(REQUEST));
  h.advance(10_000); h.lifecycle.touch();
  const deadline = h.lifecycle.snapshot().deadline;
  assert.equal(h.lifecycle.settleRejected('req-other-0001'), false);
  assert.deepEqual(h.lifecycle.pending(), REQUEST);
  assert.equal(h.lifecycle.settleRejected(REQUEST.requestId), true);
  assert.equal(h.lifecycle.pending(), null);
  assert.equal(h.lifecycle.snapshot().phase, 'active');
  assert.equal(h.lifecycle.snapshot().deadline, deadline);
  h.advance(3_001);
  assert.equal(h.lifecycle.snapshot().active, true);
  assert.equal(h.clears.length, 0);
});

test('another session changing pending storage cannot be overwritten or removed by a stale page', () => {
  const storage = memoryStorage(); const stale = lifecycleHarness({ storage });
  stale.lifecycle.open();
  const current = lifecycleHarness({ storage }); current.lifecycle.open(); current.lifecycle.begin(clone(REQUEST));
  const raw = storage.data.get(KEY);
  assert.throws(() => stale.lifecycle.begin({ ...REQUEST, requestId: 'req-other-tab-0002' }));
  assert.equal(storage.data.get(KEY), raw);
  storage.data.set(KEY, JSON.stringify({ version: 1, intent: { ...REQUEST, requestId: 'req-recovered-tab-0003' } }));
  const changed = storage.data.get(KEY);
  assert.throws(() => current.lifecycle.reconcile(REQUEST.requestId));
  assert.equal(storage.data.get(KEY), changed);
});

async function installationBuild(env) {
  const buildUrl = new URL('../tools/build-m1-installation-profile.mjs', import.meta.url).href;
  const buildSource = readFileSync(new URL(buildUrl), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gmu, '')
    .replaceAll('import.meta.url', 'buildUrl');
  const writes = new Map();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('process', 'writeFile', 'installationProfile', 'browserInstallationProfileSource', 'buildUrl', buildSource);
  await run({ env }, async (url, contents) => writes.set(new URL(url).pathname.split('/').at(-1), contents), installationProfile, browserInstallationProfileSource, buildUrl);
  return writes;
}

test('real build configuration keeps promotions disabled by default and cannot enable it in Richmond or production', async () => {
  for (const env of [{}, { GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'test' },
    { GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'production' }]) {
    const writes = await installationBuild(env);
    const context = vm.createContext({});
    vm.runInContext(writes.get('promotions-config.generated.js'), context);
    assert.equal(context.M1_PROMOTIONS_TEST_CONFIG.enabled, false);
  }
  for (const env of [
    { GIB_M1_INSTALLATION: 'richmond', CONTEXT: 'deploy-preview' },
    { GIB_M1_INSTALLATION: 'rev', CONTEXT: 'production' },
    { GIB_M1_INSTALLATION: 'rev' }
  ]) await assert.rejects(installationBuild({ ...env, GIB_PROMOTIONS_TEST_ENABLED: 'true' }), /Revolution TEST build/u);
});

test('the explicit Revolution TEST build exposes only a fixed public endpoint and no private integration settings', async () => {
  const writes = await installationBuild({
    GIB_M1_INSTALLATION: 'rev', CONTEXT: 'deploy-preview', GIB_PROMOTIONS_TEST_ENABLED: 'true',
    GIB_PROMOTIONS_TEST_BRIDGE_URL: 'https://example.invalid/private-test-script',
    GIB_PROMOTIONS_TEST_BRIDGE_SECRET: 'synthetic-secret-not-public',
    GIB_PROMOTIONS_TEST_WORKBOOK_ID: 'synthetic-workbook-not-public'
  });
  const publicSource = writes.get('promotions-config.generated.js');
  const context = vm.createContext({}); vm.runInContext(publicSource, context);
  assert.deepEqual(clone(context.M1_PROMOTIONS_TEST_CONFIG), { enabled: true, endpoint: '/api/m1-promotions', testOnly: true });
  assert.equal(Object.isFrozen(context.M1_PROMOTIONS_TEST_CONFIG), true);
  assert.doesNotMatch(publicSource, /private-test-script|synthetic-secret-not-public|synthetic-workbook-not-public/u);
});
