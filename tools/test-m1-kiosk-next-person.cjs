#!/usr/bin/env node
'use strict';

/*
 * Hosted kiosk regression gate. This writes conspicuously synthetic TEST data.
 * Run only against the exact immutable deployment that is being reviewed:
 *
 * node tools/test-m1-kiosk-next-person.cjs <https-origin> <rev|richmond> \
 *   <instructor|instructor-external|staff|recover> <private-work-directory> [checkpoint.json]
 *
 * GIB_PLAYWRIGHT_MODULE: existing Playwright module name or absolute module path.
 *   Defaults to "playwright". This runner never installs packages or browsers.
 * GIB_CHROMIUM_EXECUTABLE: optional path to an already installed Chromium binary.
 * GIB_HEADLESS=false: show the disposable browser; default is headless.
 *
 * Output is a private JSON checkpoint in the caller's work directory. Never put
 * that directory in a deployment. No screenshots, browser profiles, traces,
 * cookies, authentication state, or response bodies are saved. Only the native
 * TEST-manager dropdown login is used; no PIN or passphrase is entered.
 *
 * CSV browser-export coverage stays in the separate scratch QA workflow. The
 * permanent CSV checks are in m1-admin-cleanup.test.mjs,
 * m1-elegant-regression.test.mjs, and m1-kiosk-client.test.mjs. This runner does
 * not claim to cover the browser's CSV download or save-file picker.
 * instructor-external runs the instructor UI suite but exits 2 with
 * UI_PASS_READBACK_PENDING. Separate independent receiver reconciliation is
 * required; this option is never a completed regression pass.
 *
 * Recovery retries ONLY exact checkpointed queue identities and payloads, on
 * the SAME immutable origin and gym. It never creates substitute rows, closes
 * an unmatched shift, or deletes TEST records. If an interrupted staff run left
 * an open shift, exact replay alone cannot close it; reconciliation is separate.
 * Do not run two staff suites against the shared QA Test Staff concurrently.
 * Touch, viewport, lifecycle suspension, and offline controls are browser
 * emulation, not a physical touchscreen/device-sleep/hardware pass.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const [base, gym, mode, outputDirectory, recoveryFile] = process.argv.slice(2);
const ORIGINS = Object.freeze({
  rev: /^https:\/\/[0-9a-f]{24}--gib-live\.netlify\.app$/u,
  richmond: /^https:\/\/[0-9a-f]{24}--gib-richmond-test\.netlify\.app$/u
});
assert.ok(Object.hasOwn(ORIGINS, gym), 'Gym must be rev or richmond');
assert.ok(ORIGINS[gym].test(base || ''), 'Only the gym-aligned immutable TEST origin is allowed');
assert.ok(['instructor', 'instructor-external', 'staff', 'recover'].includes(mode), 'Choose instructor, instructor-external, staff, or recover');
assert.ok(outputDirectory, 'Supply a private work directory for checkpoints');
assert.equal(Boolean(recoveryFile), mode === 'recover', 'Only recover mode takes a checkpoint file');

const original = mode === 'recover' ? JSON.parse(fs.readFileSync(recoveryFile, 'utf8')) : null;
const selectedSuite = original ? (original.suite || original.mode) : mode;
const suite = selectedSuite === 'instructor-external' ? 'instructor' : selectedSuite;
assert.ok(['instructor', 'staff'].includes(suite), 'Checkpoint must identify its original suite');
assert.ok(suite !== 'staff' || gym === 'rev', 'Staff Clock is enabled only for Revolution');

const repoRoot = path.resolve(__dirname, '..');
const out = path.resolve(outputDirectory);
const within = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
assert.ok(out.split(path.sep).some(part => part.toLowerCase() === 'work'), 'Checkpoints must live under a work directory');
assert.ok(!out.split(path.sep).some(part => part.toLowerCase() === 'desktop'), 'Desktop is not an output location');
assert.ok(!within(out, repoRoot), 'Private checkpoints must stay outside the repository and its deployable tree');
// Reject symlink/junction redirection into a served directory before creating it.
for (let ancestor = out; ; ancestor = path.dirname(ancestor)) {
  if (fs.existsSync(ancestor)) {
    assert.equal(fs.lstatSync(ancestor).isSymbolicLink(), false, 'Output ancestors cannot be symlinks or junctions');
  }
  if (ancestor === path.dirname(ancestor)) break;
}
fs.mkdirSync(out, { recursive: true });

const startedAt = Date.now();
const run = `${gym}-${mode}-${startedAt.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const marker = original?.marker || `QA TEST Kiosk ${run}`;
const checkpointFile = path.join(out, `${run}.json`);
const endpoint = '/api/m1-kiosk-sync';
const staffEndpoint = '/api/m1-staff-clock';
const owned = new Map();
// Instructor ledger rows and queue rows share IDs but have different exact fields.
const queuedRecords = new Map();
const undone = new Set();
let remainingQueue = [];
let browser, context, page;
let verifiedTest = false;
let mayAdoptNewRows = false;
let recoveryRestored = mode !== 'recover';
let expectedDialog = null;
let routeFatal = null;
let fault = null;
const pendingHandlers = new Set();
const receipt = {
  schema: 'gib-hosted-kiosk-checkpoint/v1', base, gym, mode, suite, marker,
  started: new Date(startedAt).toISOString(), status: 'RUNNING',
  scope: 'Synthetic TEST records only; DO NOT PAY. Disposable browser contexts. Real elapsed timers and real TEST receiver writes/readback. Network and lifecycle injection are supplemental browser emulation, not physical hardware coverage.',
  excluded: ['Physical touchscreen or device sleep', 'Browser CSV export/download', 'Production or real-account authentication'],
  checks: [], timings: [], faults: [], attempts: [], errors: []
};

const clone = value => JSON.parse(JSON.stringify(value));
const idOf = row => suite === 'staff' ? row.punchId : row.RowID;
const rowsOwned = () => [...owned.values()];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function save() {
  receipt.syntheticExpected = rowsOwned();
  receipt.syntheticQueueRecords = [...queuedRecords.values()];
  receipt.syntheticUndoneIds = [...undone];
  receipt.syntheticRemainingQueue = remainingQueue;
  const temporary = checkpointFile + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n');
  fs.renameSync(temporary, checkpointFile);
}

function check(name, detail = {}) {
  assert.equal(routeFatal, null, 'A guarded network operation failed: ' + routeFatal);
  receipt.checks.push({ name, ...detail });
  save();
  console.log(JSON.stringify({ pass: name, ...detail }));
}

function validateSynthetic(row) {
  assert.ok(row && typeof row === 'object', 'A complete synthetic row is required');
  if (suite === 'staff') {
    assert.match(row.punchId, /^gib-m1-staff-[0-9a-f-]{36}$/u);
    assert.equal(row.staffId, 'qa-test-staff');
    assert.equal(row.staffName, 'QA Test Staff');
    assert.equal(row.source, 'Tablet');
    assert.equal(row.status, 'ACTIVE');
    assert.ok(['clockIn', 'clockOut'].includes(row.punchAction));
  } else {
    assert.match(row.RowID, /^gib-m1-[0-9a-f-]{36}$/u);
    assert.ok(row.Instructor.startsWith(marker + ' '), 'Only this run\'s marked synthetic instructor is allowed');
    assert.ok(row.Notes.includes('DO NOT PAY'), 'Synthetic notes must exclude payroll use');
  }
}

function savedLedgerPayload(row) {
  if (suite !== 'instructor') return row;
  const hasResult = Object.hasOwn(row, '__syncResult');
  const hasTime = Object.hasOwn(row, '__syncedAt');
  assert.equal(hasResult, hasTime, 'Ledger acknowledgment metadata must be complete');
  if (hasResult) {
    assert.ok(['added', 'already exists'].includes(row.__syncResult), 'Synthetic ledger acknowledgment must confirm receipt');
    assert.equal(typeof row.__syncedAt, 'string', 'Ledger acknowledgment time must be an ISO timestamp');
    const time = Date.parse(row.__syncedAt);
    assert.ok(Number.isFinite(time), 'Ledger acknowledgment time must be valid');
    assert.equal(new Date(time).toISOString(), row.__syncedAt, 'Ledger acknowledgment time must be an exact ISO timestamp');
  }
  // applyAcknowledgements adds only these receipt fields to the local ledger.
  // Keep every other saved field, and every queued/uploaded field, exact.
  const { __syncResult, __syncedAt, ...payload } = row;
  return payload;
}

function adopt(row) {
  validateSynthetic(row);
  const id = idOf(row);
  const payload = savedLedgerPayload(row);
  if (owned.has(id)) assert.deepEqual(payload, savedLedgerPayload(owned.get(id)), 'A saved identity must keep its exact payload');
  else {
    assert.ok(mayAdoptNewRows, 'An unexpected new row appeared outside the test action');
    assert.ok(mode !== 'recover', 'Recovery must never adopt replacement rows');
    owned.set(id, clone(row));
  }
}

function rememberQueuedRow(row, fromCheckpoint = false) {
  validateSynthetic(row);
  const id = idOf(row);
  assert.ok(owned.has(id), 'Queued identity must belong to a saved synthetic ledger row');
  if (suite === 'staff') assert.deepEqual(row, owned.get(id), 'Staff queue must match its saved overlay record');
  else {
    for (const key of ['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Notes', '__batchId']) {
      assert.deepEqual(row[key], owned.get(id)[key], 'Queue and ledger must share the exact original ' + key);
    }
  }
  if (queuedRecords.has(id)) assert.deepEqual(row, queuedRecords.get(id), 'An existing queue identity must keep its entire original payload');
  else {
    assert.ok(mode !== 'recover' || fromCheckpoint, 'Recovery cannot adopt a newly constructed queue record');
    queuedRecords.set(id, clone(row));
  }
}

async function localState(target = page) {
  return target.evaluate(kind => {
    if (kind === 'staff') {
      return JSON.parse(localStorage.getItem('gib_m1b_staff_clock_state_v1') || 'null') || { overlay: [], queue: [] };
    }
    const keys = Object.keys(localStorage).filter(key => key.endsWith('local_state_v2'));
    if (keys.length > 1) throw new Error('Multiple instructor state keys in the disposable context');
    return keys.length ? JSON.parse(localStorage.getItem(keys[0])) : { ledger: [], queue: [] };
  }, suite);
}

async function checkpoint(reason) {
  assert.ok(recoveryRestored, 'Original recovery queue is not restored; retain the original exact checkpoint');
  const state = await localState();
  assert.ok(Array.isArray(state.queue), 'Device queue must be readable');
  for (const row of (suite === 'staff' ? state.overlay : state.ledger)) adopt(row);
  for (const row of state.queue) {
    rememberQueuedRow(row);
    assert.equal(undone.has(idOf(row)), false, 'An undone row must never remain queued');
  }
  remainingQueue = clone(state.queue);
  receipt.queueCheckpoint = { reason, at: new Date().toISOString(), exact: true };
  save();
  return state;
}

async function checkpointFailure(reason) {
  try { await checkpoint(reason); }
  catch (error) {
    // Keep the last exact queue, never replace an unreadable queue with [].
    receipt.queueCaptureFailure = { reason, message: error.message, retainedLastExactQueue: true };
    save();
  }
}

function loadRecovery() {
  assert.equal(original.base, base, 'Recovery must use the exact original immutable origin');
  assert.equal(original.gym, gym);
  assert.ok(marker.startsWith('QA TEST Kiosk '));
  assert.ok(Array.isArray(original.syntheticExpected), 'Original complete row identities are required');
  const queue = original.syntheticRemainingQueue ?? original.latestSyntheticQueue;
  assert.ok(Array.isArray(queue), 'Exact saved queue is required; do not construct replacement rows');
  for (const row of original.syntheticExpected) {
    validateSynthetic(row);
    assert.equal(owned.has(idOf(row)), false, 'Duplicate identity in checkpoint');
    owned.set(idOf(row), clone(row));
  }
  for (const id of original.syntheticUndoneIds || []) {
    assert.ok(owned.has(id), 'Undone identity must belong to the original run');
    undone.add(id);
  }
  for (const row of original.syntheticQueueRecords || []) rememberQueuedRow(row, true);
  for (const row of queue) {
    validateSynthetic(row);
    assert.ok(owned.has(idOf(row)), 'Queue cannot include an uncheckpointed identity');
    rememberQueuedRow(row, true);
    assert.equal(undone.has(idOf(row)), false, 'Recovery cannot replay an undone identity');
  }
  assert.equal(new Set(queue.map(idOf)).size, queue.length, 'Recovery queue cannot duplicate identities');
  remainingQueue = clone(queue);
  receipt.recovery = { checkpoint: path.basename(recoveryFile), pending: queue.length, originalMarker: marker };
  save();
}

async function verifyTest(target) {
  const response = await target.request.get(base + '/api/m1-added-classes', { maxRedirects: 0 });
  const data = await response.json();
  assert.equal(response.status(), 200);
  assert.equal(new URL(response.url()).origin, base);
  assert.equal(data.target, 'test', 'Live response must confirm TEST before any synthetic write');
  assert.equal(data.gymId, gym, 'Live response must confirm the requested gym');
  const profile = await target.evaluate(() => ({
    id: M1_INSTALLATION_PROFILE.installationId,
    target: GIBM1TemporaryClasses.resolveAddedClassesTarget(M1_INSTALLATION_PROFILE, location.href)
  }));
  assert.deepEqual(profile, { id: gym, target: 'test' });
  verifiedTest = true;
  receipt.destinationVerified = { target: 'test', gymId: gym, origin: base, at: new Date().toISOString() };
  save();
}

function submittedPayload(row) {
  const fields = suite === 'staff'
    ? ['punchId', 'timestamp', 'date', 'staffId', 'staffName', 'punchAction', 'site', 'device', 'build', 'note']
    : ['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Device', 'Build', 'Notes'];
  // Mirror only the transport field selection; replay still restores the full
  // saved queue verbatim and lets the deployed application perform its upload.
  return clone(Object.fromEntries(fields.map(key => [key, row[key]])));
}

async function handleRoute(route) {
  let syntheticWrite = false;
  try {
    const request = route.request();
    const url = new URL(request.url());
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/functions/');
    if (isApi || !['GET', 'HEAD'].includes(request.method())) {
      assert.equal(url.origin, base, 'API requests cannot leave the approved immutable TEST origin');
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return await route.continue();
    assert.equal(request.method(), 'POST', 'Unexpected mutation method blocked');
    const body = request.postDataJSON();
    syntheticWrite = url.pathname === endpoint || (url.pathname === staffEndpoint && body.operation === 'sync');
    if (!syntheticWrite) {
      const nativeTestLogin = url.pathname === '/.netlify/functions/m1-admin-login' && body.testShortcut === true;
      const permittedRead = url.pathname === '/.netlify/functions/m1-admin-review'
        || (url.pathname === staffEndpoint && ['snapshot', 'snapshotPage'].includes(body.operation))
        || (url.pathname === '/.netlify/functions/m1-admin-staff-time' && ['review', 'reviewPage', 'shiftLookup'].includes(body.operation));
      assert.ok(nativeTestLogin || permittedRead, 'Unexpected API write blocked: ' + url.pathname);
      if (nativeTestLogin) assert.ok(verifiedTest, 'Verify TEST before native TEST-manager login');
      return await route.continue();
    }

    assert.ok(verifiedTest, 'Synthetic upload blocked until the live target and gym are verified');
    assert.equal(url.pathname, suite === 'staff' ? staffEndpoint : endpoint, 'Wrong suite attempted a synthetic write');
    // Routing holds the request until exact identities AND the full queue are on disk.
    await checkpoint('before synthetic network attempt');
    const payload = suite === 'staff' ? body.punches : body.rows;
    assert.ok(Array.isArray(payload) && payload.length > 0, 'Synthetic request requires rows');
    assert.equal(new Set(payload.map(idOf)).size, payload.length);
    for (const row of payload) {
      const saved = remainingQueue.find(queued => idOf(queued) === idOf(row));
      assert.ok(saved, 'Every upload identity must already be in the checkpointed queue');
      assert.deepEqual(row, submittedPayload(saved), 'Upload payload must match the exact saved row');
    }
    const attempt = { at: Date.now(), endpoint: url.pathname, ids: payload.map(idOf), payload: clone(payload) };
    receipt.attempts.push(attempt);
    save();

    // Disable hidden retry/redirect behavior: every network attempt needs its own checkpoint.
    const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 30000 });
    attempt.status = response.status();
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (result?.test === true || result?.target === 'test') {
      if (result.gymId !== undefined) assert.equal(result.gymId, gym);
      attempt.confirmedTest = true;
      attempt.results = result.results?.map(item => item.result);
    } else if (response.ok()) {
      throw new Error('Successful sync response did not confirm TEST');
    }
    save();

    const successfulAck = response.status() === 200 && attempt.confirmedTest
      && Array.isArray(result?.results) && result.results.length === payload.length
      && result.results.every(item => ['added', 'already exists'].includes(item.result));
    if (fault?.type === 'lost-ack' && !fault.applied && successfulAck) {
      fault.applied = true;
      receipt.faults.push({ type: 'Lost acknowledgment after real successful TEST receiver response', ids: attempt.ids, status: response.status(), results: attempt.results, deliberatelyDropped: true });
      save();
      await route.abort('failed');
    } else {
      if (fault?.type === 'delayed-ack' && !fault.applied && successfulAck) {
        fault.applied = true;
        receipt.faults.push({ type: 'Delayed real TEST acknowledgment', delayMs: 8000, ids: attempt.ids });
        save();
        await delay(8000);
      }
      await route.fulfill({ response });
    }
  } catch (error) {
    const transportFailure = syntheticWrite && /timeout|timed out|ECONN|net::|socket|connection|fetch failed|requestfailed|Target.*closed|aborted/iu.test(error.message);
    receipt.faults.push({ type: transportFailure ? 'Route transport error' : 'Guarded route failure', message: error.message });
    if (!transportFailure) routeFatal ||= error.message;
    await checkpointFailure('network route failure');
    await route.abort('failed').catch(() => {});
  }
}

async function installRoutes(targetContext) {
  await targetContext.route('**/*', route => {
    // Event handlers must never leave rejected promises outside the main catch.
    const task = handleRoute(route).catch(error => {
      routeFatal ||= error.message;
      receipt.errors.push('Route checkpoint failure: ' + error.message);
      try { save(); } catch { /* The previous atomic checkpoint remains intact. */ }
      return route.abort('failed').catch(() => {});
    });
    pendingHandlers.add(task);
    return task.finally(() => pendingHandlers.delete(task));
  });
}

async function neutral() {
  assert.equal(await page.locator('#signInModal').getAttribute('aria-hidden'), 'true');
  for (const selector of ['#nameInput', '#notesInput']) assert.equal(await page.locator(selector).inputValue(), '');
  assert.equal(await page.locator('#classListWrap input:checked').count(), 0);
  const hiddenName = await page.locator('#signInModalName').textContent();
  assert.ok(hiddenName === '' || hiddenName === 'Instructor', 'Only the static nonpersonal placeholder may remain in the hidden modal');
  assert.equal(await page.locator('#signInModalClasses').textContent(), '');
  assert.equal(await page.locator('#btnSignIn').isEnabled(), true);
}

async function staffNeutral() {
  assert.equal(await page.locator('#staffClockConfirmation').isVisible(), false);
  assert.equal(await page.locator('#staffClockName').inputValue(), '');
  for (const selector of ['#staffClockConfirmationTitle', '#staffClockConfirmationDetail']) assert.equal(await page.locator(selector).textContent(), '');
  assert.equal(await page.locator('#staffClockControls').isVisible(), true);
}

async function fill(label, input = 'keyboard') {
  const name = marker + ' ' + label;
  await page.locator('#nameInput').fill(name);
  await page.locator('#notesInput').fill('DO NOT PAY — synthetic TEST ' + label);
  if (!await page.locator('#classListWrap').isVisible()) await page.locator('#toggleClasses')[input === 'touch' ? 'tap' : 'click']();
  await page.locator('#classListWrap input[type=checkbox]').first().check();
  return name;
}

async function submit(label, input = 'keyboard') {
  const name = await fill(label, input);
  const beforeIds = new Set(owned.keys());
  const started = Date.now();
  mayAdoptNewRows = true;
  try {
    if (input === 'touch') await page.locator('#btnSignIn').tap();
    else await page.locator('#btnSignIn').press('Enter');
    await page.locator('#signInModal[aria-hidden=false]').waitFor();
    const state = await checkpoint('synthetic instructor saved locally');
    const rows = rowsOwned().filter(row => !beforeIds.has(idOf(row)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Instructor, name);
    assert.equal(new Set(state.ledger.map(idOf)).size, state.ledger.length);
    return { name, rows, started };
  } finally {
    await checkpointFailure('after attempted instructor action, including UI failure');
    mayAdoptNewRows = false;
  }
}

async function waitExpired(transaction) {
  const duration = suite === 'staff' ? 5000 : 15000;
  const selector = suite === 'staff' ? '#staffClockConfirmation' : '#signInModal';
  await delay(Math.max(0, transaction.started + duration - 650 - Date.now()));
  assert.equal(await page.locator(selector).isVisible(), true, 'Confirmation must stay visible briefly before its original deadline');
  if (suite === 'instructor') {
    assert.equal(receipt.attempts.some(attempt => attempt.at < transaction.started + 14500
      && attempt.ids.some(id => transaction.rows.some(row => idOf(row) === id))), false, 'Undoable row must not upload');
  }
  await page.waitForFunction(sel => {
    const element = document.querySelector(sel);
    return element && (element.hidden || element.getAttribute('aria-hidden') === 'true');
  }, selector, { timeout: 6000 });
  const elapsedMs = Date.now() - transaction.started;
  assert.ok(elapsedMs >= duration - 500 && elapsedMs <= duration + 2200, `Actual confirmation expiry: ${elapsedMs} ms`);
  receipt.timings.push({ suite, elapsedMs });
  await (suite === 'staff' ? staffNeutral() : neutral());
  await checkpoint('confirmation deadline elapsed');
}

async function waitDrained() {
  await page.waitForFunction(kind => {
    const key = kind === 'staff' ? 'gib_m1b_staff_clock_state_v1'
      : Object.keys(localStorage).find(item => item.endsWith('local_state_v2'));
    return key && JSON.parse(localStorage.getItem(key)).queue.length === 0;
  }, suite, { timeout: 90000 });
  await checkpoint('device queue drained');
}

async function loginAdmin() {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await installRoutes(adminContext);
  const admin = await adminContext.newPage();
  await admin.goto(base + '/m1/admin/', { waitUntil: 'domcontentloaded' });
  await verifyTest(admin);
  const responsePromise = admin.waitForResponse(response => response.url().endsWith('/m1-admin-login') && response.request().method() === 'POST');
  await admin.locator('#loginAdminName').selectOption({ label: 'Andrew Smith' });
  await admin.locator('#testLoginButton').click();
  const response = await responsePromise;
  const data = await response.json();
  assert.equal(response.status(), 200);
  assert.equal(data.test, true);
  await admin.locator('#appPanel').waitFor();
  return { adminContext, admin };
}

async function readbackInstructor() {
  const { adminContext, admin } = await loginAdmin();
  try {
    for (const date of new Set(rowsOwned().map(row => row.Date))) {
      // Changing the real date control also supports recovery on a later day.
      if (await admin.locator('#calendarDate').inputValue() === date) {
        const previousResponse = admin.waitForResponse(response => response.url().endsWith('/m1-admin-review'));
        await admin.locator('#previousDay').click();
        await previousResponse;
      }
      const responsePromise = admin.waitForResponse(response => response.url().endsWith('/m1-admin-review') && response.request().postDataJSON()?.date === date);
      await admin.locator('#calendarDate').fill(date);
      await admin.locator('#calendarDate').press('Tab');
      const response = await responsePromise;
      const data = await response.json();
      assert.equal(response.status(), 200);
      assert.equal(data.test, true);
      for (const row of rowsOwned().filter(item => item.Date === date)) {
        const matches = data.records.filter(item => item.recordId === row.RowID);
        assert.equal(matches.length, undone.has(row.RowID) ? 0 : 1, 'Independent receiver exact identity count');
        if (matches.length) {
          assert.equal(matches[0].instructor, row.Instructor);
          assert.equal(Number(matches[0].duration), Number(row['Duration (hr)']));
        }
      }
    }
    const active = rowsOwned().filter(row => !undone.has(row.RowID));
    receipt.readback = { freshAdmin: true, activeCount: active.length, undoneAbsent: undone.size,
      identityHash: hash(JSON.stringify(active.map(idOf).sort())), teachingHours: active.reduce((sum, row) => sum + Number(row['Duration (hr)']), 0) };
    check('Fresh TEST Admin receiver confirms exact instructor identities, hours, counts, and Undo absence', receipt.readback);
  } finally { await adminContext.close(); }
}

async function readbackStaff() {
  const { adminContext, admin } = await loginAdmin();
  try {
    const receiverById = new Map();
    await admin.locator('#staffModeControl').click();
    await admin.locator('#staffOlderShiftOpen').click();
    await admin.locator('#staffOlderShiftStaff').selectOption('qa-test-staff');
    for (const date of new Set(rowsOwned().map(row => row.date))) {
      await admin.locator('#staffOlderShiftDate').fill(date);
      const responsePromise = admin.waitForResponse(response => response.url().endsWith('/m1-admin-staff-time') && response.request().postDataJSON()?.operation === 'shiftLookup');
      await admin.locator('#staffOlderShiftSubmit').click();
      const response = await responsePromise;
      const data = await response.json();
      assert.equal(response.status(), 200);
      assert.equal(data.test, true);
      const actual = data.items.flatMap(item => [item.clockIn, item.clockOut]).filter(Boolean);
      for (const row of rowsOwned().filter(item => item.date === date)) {
        const matches = actual.filter(item => item.punchId === row.punchId);
        assert.equal(matches.length, 1, 'Independent receiver exact staff punch count');
        for (const field of ['timestamp', 'punchAction', 'staffId']) assert.equal(matches[0][field], row[field]);
        receiverById.set(row.punchId, matches[0]);
      }
    }
    const sorted = rowsOwned().sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    const pairs = [];
    for (let index = 0; index + 1 < sorted.length; index += 2) {
      const first = sorted[index], second = sorted[index + 1];
      assert.equal(first.punchAction, 'clockIn');
      assert.equal(second.punchAction, 'clockOut');
      const expectedSeconds = (Date.parse(second.timestamp) - Date.parse(first.timestamp)) / 1000;
      const receiverSeconds = (Date.parse(receiverById.get(second.punchId).timestamp) - Date.parse(receiverById.get(first.punchId).timestamp)) / 1000;
      assert.equal(receiverSeconds, expectedSeconds, 'Receiver shift duration must equal the original saved pair');
      pairs.push({ clockInId: first.punchId, clockOutId: second.punchId, expectedSeconds, receiverSeconds });
    }
    receipt.staffReadback = { freshAdmin: true, punches: owned.size, identityHash: hash(JSON.stringify([...owned.keys()].sort())), pairs };
    check('Fresh TEST Admin confirms exact staff IDs, timestamps, and each receiver shift duration', receipt.staffReadback);
  } finally { await adminContext.close(); }
}

async function layouts() {
  for (const [name, width, height] of [['phone', 390, 844], ['tablet', 820, 1180], ['laptop', 1440, 1000]]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1);
    const selectors = suite === 'staff' ? ['#staffClockName', '#btnStaffClockAction'] : ['#nameInput', '#toggleClasses', '#btnSignIn'];
    for (const selector of selectors) assert.equal(await page.locator(selector).isVisible(), true);
    check('Visible controls and no horizontal overflow at ' + name + ' dimensions');
  }
}

async function localSaveFailure() {
  const name = await fill('Local Save Failure');
  const before = await localState();
  await page.evaluate(() => {
    window.__qaOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith('local_state_v2')) throw new DOMException('Synthetic storage fault', 'QuotaExceededError');
      return window.__qaOriginalSetItem.call(this, key, value);
    };
  });
  try {
    expectedDialog = 'could not be saved on the device';
    await page.locator('#btnSignIn').click();
    await delay(300);
    assert.equal(expectedDialog, null);
    assert.deepEqual(await localState(), before);
    assert.equal(await page.locator('#nameInput').inputValue(), name);
    assert.equal(await page.locator('#signInModal').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#btnSignIn').isEnabled(), true);
    check('Supplemental local-save failure preserves input without false success or lost rows');
  } finally {
    await page.evaluate(() => { Storage.prototype.setItem = window.__qaOriginalSetItem; delete window.__qaOriginalSetItem; });
  }
}

async function suspend(milliseconds) {
  const session = await context.newCDPSession(page);
  try {
    await session.send('Page.setWebLifecycleState', { state: 'frozen' });
    await delay(milliseconds);
  } finally {
    await session.send('Page.setWebLifecycleState', { state: 'active' });
    await session.detach();
  }
  await page.bringToFront();
  receipt.faults.push({ type: 'Browser lifecycle suspension', actualSuspendedMs: milliseconds, physicalSleep: false });
}

async function instructorSuite() {
  await localSaveFailure();
  await waitExpired(await submit('Walk Away One', 'touch'));
  check('Touch sign-in clears after 15 actual seconds without Done');
  await waitExpired(await submit('Next Person Two', 'keyboard'));
  await waitDrained();
  check('Different next person signs in with keyboard Enter after the walk-away reset');

  await submit('Optional Done');
  await page.locator('#btnConfirmSignInDone').tap();
  await neutral();
  const nextName = await fill('Active Next Input');
  await delay(17000);
  assert.equal(await page.locator('#nameInput').inputValue(), nextName);
  assert.ok((await page.locator('#notesInput').inputValue()).includes('Active Next Input'));
  check('Optional Done is immediate; old deadline and acknowledgments preserve active next input');

  const undo = await submit('Undo');
  await delay(2500);
  assert.equal(receipt.attempts.some(attempt => attempt.ids.includes(undo.rows[0].RowID)), false);
  await page.locator('#btnConfirmSignInUndo').tap();
  undone.add(undo.rows[0].RowID);
  const state = await checkpoint('Undo removed the unsent row');
  assert.equal(state.ledger.some(row => row.RowID === undo.rows[0].RowID), false);
  assert.equal(state.queue.some(row => row.RowID === undo.rows[0].RowID), false);
  assert.equal(await page.locator('#nameInput').inputValue(), undo.name);
  assert.ok((await page.locator('#notesInput').inputValue()).includes('Undo'));
  check('Undo restores the original input and removes unsent ledger and queue rows');

  await context.setOffline(true);
  const offline = await submit('Offline');
  await waitExpired(offline);
  assert.ok(remainingQueue.some(row => row.RowID === offline.rows[0].RowID));
  assert.match(await page.locator('#kioskDeliveryText').innerText(), /waiting|offline|tablet/iu);
  const nextOffline = await fill('Next While Recovering');
  await context.setOffline(false);
  await waitDrained();
  assert.equal(await page.locator('#nameInput').inputValue(), nextOffline);
  check('Offline saved record retains its warning and reconnects without erasing next input');

  fault = { type: 'lost-ack', applied: false };
  const lost = await submit('Lost Acknowledgment');
  await waitExpired(lost);
  await waitDrained();
  assert.equal(fault.applied, true, 'Lost-ack fault must actually occur after a real TEST response');
  assert.ok(receipt.attempts.filter(attempt => attempt.ids.includes(lost.rows[0].RowID)).length >= 2, 'Lost response must cause an exact-ID retry');
  fault = null;
  check('Lost response after real TEST receipt retries the same saved identity');

  await submit('Suspend Resume');
  await suspend(17000);
  await page.waitForFunction(() => document.querySelector('#signInModal').getAttribute('aria-hidden') === 'true');
  await neutral();
  check('Expired personal confirmation clears after actual browser suspension and resume');

  await submit('Back Navigation');
  await page.goto(base + '/m1/admin/', { waitUntil: 'domcontentloaded' });
  await delay(16500);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.locator('#nameInput').waitFor();
  await neutral();
  await waitDrained();
  const final = await checkpoint('instructor suite complete');
  for (const row of rowsOwned().filter(item => !undone.has(item.RowID))) assert.equal(final.ledger.filter(item => item.RowID === row.RowID).length, 1);
  assert.equal(receipt.attempts.some(attempt => attempt.ids.some(id => undone.has(id))), false);
  check('Browser Back is neutral and every active saved record remains exactly once');
  await layouts();
  if (mode === 'instructor-external') {
    receipt.readback = { status: 'PENDING', required: 'Independently reconcile each active ID once, exact hours, and Undo absence against the TEST receiver. Checkpointed rows are the identity list.' };
    save();
  } else await readbackInstructor();
}

async function staffPunch(expected, input = 'touch') {
  await page.locator('#staffClockName').selectOption('qa-test-staff');
  await page.waitForFunction(() => !document.querySelector('#btnStaffClockAction').disabled);
  assert.equal(await page.locator('#btnStaffClockAction').getAttribute('data-action'), expected);
  const beforeIds = new Set(owned.keys());
  const started = Date.now();
  mayAdoptNewRows = true;
  try {
    if (input === 'touch') await page.locator('#btnStaffClockAction').tap();
    else await page.locator('#btnStaffClockAction').press('Enter');
    await page.locator('#staffClockConfirmation').waitFor();
    await checkpoint('synthetic staff punch saved locally');
    const rows = rowsOwned().filter(row => !beforeIds.has(idOf(row)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].punchAction, expected);
    return { started, rows };
  } finally {
    await checkpointFailure('after attempted staff action, including UI failure');
    mayAdoptNewRows = false;
  }
}

async function staffReady() {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      await page.locator('#staffClockControls').waitFor({ timeout: 90000 });
      return;
    } catch (error) {
      if (attempt === 2 || !await page.locator('#retryStaffClock').isVisible()) throw error;
      await page.locator('#retryStaffClock').click();
      check('Native Staff Clock retry after a full readiness wait', { retry: attempt + 1 });
    }
  }
}

async function staffSuite() {
  await staffReady();
  await page.locator('#staffClockName').selectOption('qa-test-staff');
  await page.waitForFunction(() => !document.querySelector('#btnStaffClockAction').disabled);
  assert.equal(await page.locator('#btnStaffClockAction').getAttribute('data-action'), 'clockIn', 'QA staff must start clocked out; an old unmatched shift requires separate reconciliation');
  await waitExpired(await staffPunch('clockIn', 'touch'));
  await waitExpired(await staffPunch('clockOut', 'keyboard'));
  check('Touch clock-in and keyboard clock-out clear name, time, and shift details at five actual seconds');

  await staffPunch('clockIn');
  await page.waitForFunction(() => !document.querySelector('#btnStaffClockDone').disabled);
  await page.locator('#btnStaffClockDone').tap();
  await staffNeutral();
  await delay(1100);
  await waitExpired(await staffPunch('clockOut'));
  check('Staff Done permits the next action and the old deadline does not reset it');

  await context.setOffline(true);
  const offline = await staffPunch('clockIn');
  assert.match(await page.locator('#staffClockConfirmationTitle').innerText(), /waiting to sync/iu);
  await waitExpired(offline);
  assert.ok(remainingQueue.some(row => row.punchId === offline.rows[0].punchId));
  await page.locator('#staffClockName').selectOption('qa-test-staff');
  await context.setOffline(false);
  await waitDrained();
  assert.equal(await page.locator('#staffClockName').inputValue(), 'qa-test-staff');
  assert.equal(await page.locator('#staffClockConfirmation').isVisible(), false);
  await waitExpired(await staffPunch('clockOut'));
  check('Offline staff punch recovers without reopening confirmation or wiping next selection');

  fault = { type: 'delayed-ack', applied: false };
  await waitExpired(await staffPunch('clockIn'));
  await page.locator('#staffClockName').selectOption('qa-test-staff');
  await delay(6500);
  assert.equal(fault.applied, true);
  assert.equal(await page.locator('#staffClockName').inputValue(), 'qa-test-staff');
  assert.equal(await page.locator('#staffClockConfirmation').isVisible(), false);
  fault = null;
  await waitExpired(await staffPunch('clockOut'));
  check('Delayed staff acknowledgment preserves the original deadline and next selection');

  await staffPunch('clockIn');
  await suspend(7000);
  await page.waitForFunction(() => document.querySelector('#staffClockConfirmation').hidden);
  await staffNeutral();
  await waitExpired(await staffPunch('clockOut'));
  check('Expired staff confirmation clears after suspended browser resume');

  await staffPunch('clockIn');
  await page.goto(base + '/m1/admin/', { waitUntil: 'domcontentloaded' });
  await delay(7000);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await staffReady();
  await staffNeutral();
  await waitExpired(await staffPunch('clockOut'));
  await waitDrained();
  check('Staff browser Back clears personal details and the paired next punch is retained');
  await readbackStaff();
  await layouts();
}

async function recoverCheckpoint() {
  const pending = clone(remainingQueue);
  const ledger = rowsOwned().filter(row => !undone.has(idOf(row)));
  await page.evaluate(({ kind, pendingRows, originalRows }) => {
    const key = kind === 'staff' ? 'gib_m1b_staff_clock_state_v1'
      : Object.keys(localStorage).find(item => item.endsWith('local_state_v2'));
    if (!key) throw new Error('Recovery state key missing');
    const current = JSON.parse(localStorage.getItem(key));
    if (current.queue.length || (kind === 'staff' ? current.overlay : current.ledger).length) throw new Error('Recovery context must have no local rows');
    const restored = kind === 'staff'
      ? { ...current, overlay: pendingRows, queue: pendingRows }
      : { ...current, ledger: originalRows, queue: pendingRows };
    localStorage.setItem(key, JSON.stringify(restored));
  }, { kind: suite, pendingRows: pending, originalRows: ledger });
  recoveryRestored = true;
  await checkpoint('exact original queue restored before browser reload');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitDrained();
  if (suite === 'staff') await readbackStaff();
  else await readbackInstructor();
  check('Recovery replayed only original checkpointed IDs and confirmed them through fresh TEST Admin');
  if (suite === 'staff' && rowsOwned().filter(row => row.punchAction === 'clockIn').length !== rowsOwned().filter(row => row.punchAction === 'clockOut').length) {
    receipt.recovery.unmatchedOriginalPunches = true;
    receipt.recovery.limit = 'Exact replay does not close an interrupted shift. Separate TEST reconciliation is required; no replacement punch was created.';
  }
}

async function main() {
  try {
    if (original) loadRecovery();
    save();
    const { chromium } = require(process.env.GIB_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({
      headless: process.env.GIB_HEADLESS !== 'false',
      ...(process.env.GIB_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GIB_CHROMIUM_EXECUTABLE } : {})
    });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await installRoutes(context);
    if (gym === 'rev') await context.addInitScript(() => {
      if (!localStorage.getItem('gib_m1_sync_auto_v1')) localStorage.setItem('gib_m1_sync_auto_v1', 'true');
    });
    receipt.fixtureSetup = 'Fresh disposable context with Revolution auto-sync preference enabled; no existing profile or stored authentication is loaded.';
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => { receipt.errors.push(error.message); save(); });
    page.on('dialog', dialog => {
      if (expectedDialog && dialog.message().includes(expectedDialog)) {
        receipt.faults.push({ type: 'Expected synthetic local-save failure dialog' });
        expectedDialog = null;
      } else receipt.errors.push('Unexpected browser dialog');
      save();
      void dialog.dismiss().catch(error => { receipt.errors.push('Dialog dismissal failed: ' + error.message); save(); });
    });
    await page.goto(base + '/m1/', { waitUntil: 'domcontentloaded' });
    await page.locator('#nameInput').waitFor();
    await verifyTest(page);
    const empty = await localState();
    assert.equal(empty.queue.length, 0, 'Disposable context must start with an empty queue');
    assert.equal((suite === 'staff' ? empty.overlay : empty.ledger).length, 0, 'Disposable context must start without local rows');
    if (gym === 'richmond') {
      assert.equal(await page.locator('#staffClock').isVisible(), false);
      check('Richmond Staff Clock remains disabled');
    }
    if (mode === 'recover') {
      if (suite === 'staff') await staffReady();
      await recoverCheckpoint();
    } else if (suite === 'staff') await staffSuite();
    else {
      await page.locator('#toggleClasses').click();
      await page.locator('#classListWrap input').first().waitFor({ timeout: 45000 });
      await page.locator('#toggleClasses').click();
      await instructorSuite();
    }
    assert.equal(routeFatal, null, 'No guarded network failures');
    assert.equal(receipt.errors.length, 0, 'No browser script errors or unexpected dialogs');
    receipt.status = mode === 'instructor-external' ? 'UI_PASS_READBACK_PENDING' : 'PASS';
    if (mode === 'instructor-external') process.exitCode = 2;
  } catch (error) {
    receipt.status = 'FAIL';
    receipt.failure = error.message;
    if (page) await checkpointFailure('main failure');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (page) await checkpointFailure('final state before browser close');
    // Browser close releases any held network request; route errors are captured.
    if (browser) await browser.close().catch(error => { receipt.errors.push('Browser close failed: ' + error.message); });
    await Promise.allSettled([...pendingHandlers]);
    if (routeFatal || receipt.errors.length) { receipt.status = 'FAIL'; process.exitCode = 1; }
    receipt.finished = new Date().toISOString();
    save();
    console.log('CHECKPOINT ' + checkpointFile);
  }
}

void main().catch(error => {
  // A filesystem failure may prevent a new checkpoint; preserve the last atomic file.
  console.error('Runner stopped; retain the last checkpoint. ' + error.message);
  process.exitCode = 1;
});
