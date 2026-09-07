import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  appendBatchToState,
  applyAcknowledgements,
  blankLocalState,
  formatDateInTimeZone,
  formatTimestampInTimeZone,
  requestAcknowledgements
} from '../m1/sync-core.mjs';

const kiosk = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function sourceBetween(startMarker, endMarker) {
  const start = kiosk.indexOf(startMarker);
  const end = kiosk.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing kiosk source: ${startMarker}`);
  return kiosk.slice(start, end);
}

// Execute the real kiosk functions with an in-memory DOM/storage boundary.
// These are unit/integration regressions, not hosted browser or Google tests.
function signInHarness({ richmond = false, duration = 1 } = {}) {
  let state = blankLocalState();
  let id = 0;
  let writes = 0;
  let networkCalls = 0;
  const alerts = [];
  const confirmations = [];
  const label = '8:00 AM TEST Limited Class';
  const nameInput = { value: 'TEST Instructor One' };
  const notesInput = { value: 'Synthetic TEST only; DO NOT PAY' };
  const nodes = { '#nameInput': nameInput, '#notesInput': notesInput };
  const context = vm.createContext({
    IS_RICHMOND: richmond,
    IS_RICHMOND_PRODUCTION: false,
    RICHMOND_WRITES_ENABLED: false,
    INSTALLATION: { deviceLabel: 'TEST Richmond browser' },
    BACKEND_ENABLED: true,
    BUILD: 'elegant-admin-regression',
    DEVICE_LABEL_KEY: 'device',
    SYNC_AUTO_KEY: 'auto',
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-09-07T20:00:00.000Z'])); }
    },
    localStorage: { getItem: key => key === 'device' ? 'TEST browser' : 'false' },
    $: selector => nodes[selector],
    selectedClasses: () => [label],
    getSiteCode: () => richmond ? 'Richmond' : 'Rev',
    fmtTS: formatTimestampInTimeZone,
    fmtDate: formatDateInTimeZone,
    loadDurationRules: () => [{ match: 'TEST Limited Class', duration }],
    createPermanentRowId: () => `gib-m1-10000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    appendBatchToState,
    loadLocalState: () => clone(state),
    loadSignins: () => clone(state.ledger),
    persistLocalState(value) { state = clone(value); writes += 1; },
    upsertName() {},
    refreshNameDatalist() {},
    openSignInModal(value) { confirmations.push(clone(value)); },
    updateSyncStatus() {},
    clearSignInCountdown() {},
    toggleSignInModal() {},
    window: { setTimeout() { networkCalls += 1; } },
    syncNow() { networkCalls += 1; },
    alert: message => alerts.push(message)
  });
  const source = [
    'let signInLocked = false; let signInSecondsRemaining = 0;',
    sourceBetween('  function getDurationForClass(', '  // Admin schedule editor state'),
    sourceBetween('  function closeSignInModal()', '  function undoLastSigninBatch()'),
    sourceBetween('  function signIn()', '  function voidLastSignin()'),
    sourceBetween('  function buildCSV()', '  async function exportCSV()'),
    'globalThis.actions = { signIn, closeSignInModal, buildCSV };'
  ].join('\n');
  new vm.Script(source).runInContext(context);
  return {
    actions: context.actions,
    alerts,
    confirmations,
    nameInput,
    label,
    get state() { return clone(state); },
    set state(value) { state = clone(value); },
    get writes() { return writes; },
    get networkCalls() { return networkCalls; }
  };
}

for (const richmond of [false, true]) {
  for (const duration of [0.5, 1]) {
    test(`added class permits two instructors with full ${duration}h records and exact CSV in ${richmond ? 'Richmond' : 'Revolution'}`, () => {
      const harness = signInHarness({ richmond, duration });
      assert.equal(harness.state.ledger.length, 0);
      assert.equal(harness.writes, 0, 'merely displaying a class creates no teaching record');

      harness.actions.signIn();
      harness.actions.signIn();
      assert.equal(harness.state.ledger.length, 1, 'duplicate tap during confirmation is locked');
      assert.equal(harness.writes, 1);
      harness.actions.closeSignInModal();
      harness.nameInput.value = 'TEST Instructor Two';
      harness.actions.signIn();

      const state = harness.state;
      assert.deepEqual(harness.alerts, []);
      assert.equal(state.ledger.length, 2);
      assert.equal(state.queue.length, 2);
      assert.equal(new Set(state.ledger.map(row => row.RowID)).size, 2);
      assert.deepEqual(state.ledger.map(row => row.RowID), state.queue.map(row => row.RowID));
      assert.deepEqual(state.ledger.map(row => row.Instructor), ['TEST Instructor One', 'TEST Instructor Two']);
      assert.deepEqual(state.ledger.map(row => row['Duration (hr)']), [duration, duration]);
      assert.deepEqual(state.ledger.map(row => row.Date), ['2026-09-07', '2026-09-07']);
      assert.equal(harness.confirmations.length, 2);
      assert.equal(harness.networkCalls, 0, 'Auto-sync OFF remains respected');

      const site = richmond ? 'Richmond' : 'Rev';
      assert.equal(harness.actions.buildCSV(), [
        'Timestamp,Date,Class Label,Duration (hr),Instructor,Site,Notes',
        `2026-09-07 16:00:00,2026-09-07,${harness.label},${duration},TEST Instructor One,${site},Synthetic TEST only; DO NOT PAY`,
        `2026-09-07 16:00:00,2026-09-07,${harness.label},${duration},TEST Instructor Two,${site},Synthetic TEST only; DO NOT PAY`
      ].join('\n'));
    });
  }
}

test('two instructors retain separate queued identities through offline reload and exact retry acknowledgement', async () => {
  const harness = signInHarness();
  harness.actions.signIn();
  harness.actions.closeSignInModal();
  harness.nameInput.value = 'TEST Instructor Two';
  harness.actions.signIn();
  const original = harness.state;
  const originalCsv = harness.actions.buildCSV();
  const durable = JSON.stringify(original);
  let attempts = 0;
  await assert.rejects(requestAcknowledgements(original.queue, {
    online: false,
    fetchImpl() { attempts += 1; }
  }), /offline/u);
  assert.equal(attempts, 0);
  assert.deepEqual(harness.state, JSON.parse(durable));

  // Reload from durable bytes, then emulate a lost first response and an exact
  // already-exists receipt. The real receiver's dedup is covered separately.
  harness.state = JSON.parse(durable);
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.rows);
    if (sent.length === 1) throw new TypeError('Synthetic lost response');
    return new Response(JSON.stringify({
      ok: true,
      test: true,
      results: body.rows.map(row => ({
        rowId: row.RowID, result: 'already exists', linkedRecordId: row.RowID
      }))
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(requestAcknowledgements(harness.state.queue, { fetchImpl }), error => (
    error.syncCode === 'TABLET_SERVICE_UNREACHABLE'
  ));
  assert.deepEqual(harness.state, original);
  const queued = harness.state.queue;
  const receipt = await requestAcknowledgements(queued, { fetchImpl });
  assert.deepEqual(sent[0], sent[1], 'retry keeps both exact event identities and lesson durations');
  harness.state = applyAcknowledgements(harness.state, queued, receipt, '2026-09-07T20:01:00.000Z').state;
  assert.equal(harness.state.queue.length, 0);
  assert.equal(harness.state.ledger.length, 2);
  assert.deepEqual(harness.state.ledger.map(row => row.RowID), original.ledger.map(row => row.RowID));
  assert.equal(harness.actions.buildCSV(), originalCsv, 'acknowledgement does not rewrite export data');
});

test('legacy Admin rows render adversarial values as literal text without changing ledger or queue', () => {
  const row = Object.freeze({
    RowID: 'gib-m1-30000000-0000-4000-8000-000000000001',
    Status: '<img src=x onerror="statusAttack()">',
    Timestamp: '</td><script>timestampAttack()</script>',
    Date: '<svg onload="dateAttack()">',
    'Class Label': 'TEST <img src=x onerror="classAttack()"> & "quoted"',
    'Duration (hr)': '<iframe srcdoc="durationAttack()">',
    Instructor: '<script>instructorAttack()</script>',
    Site: '<a href="javascript:siteAttack()">',
    Notes: "TEST O'Brien & </td><img src=x onerror='notesAttack()'>"
  });
  const voidRow = Object.freeze({
    ...row, RowID: 'gib-m1-30000000-0000-4000-8000-000000000002', Status: 'VOID',
    voided_at: '" onmouseover="voidTimeAttack()" data-break="',
    void_reason: '\"><img src=x onerror="voidReasonAttack()"> & \'reason\''
  });
  const snapshot = Object.freeze({
    version: 2,
    ledger: Object.freeze([row, voidRow]),
    queue: Object.freeze([row])
  });
  const before = JSON.stringify(snapshot);
  const output = { innerHTML: '' };
  let reads = 0;
  let summaries = 0;
  const context = vm.createContext({
    readAdminLocalStateSnapshot() { reads += 1; return snapshot; },
    $: selector => { assert.equal(selector, '#adminTableWrap'); return output; },
    renderAdminSummary() { summaries += 1; },
    persistLocalState() { assert.fail('Rendering must not persist a record change.'); },
    fetch() { assert.fail('Rendering must not submit any records.'); },
    localStorage: {
      setItem() { assert.fail('Rendering must not write storage.'); },
      removeItem() { assert.fail('Rendering must not remove storage.'); }
    }
  });
  new vm.Script(sourceBetween('  function renderAdminTable()', '  function buildCSV()')
    + '\nrenderAdminTable();').runInContext(context);

  assert.ok(output.innerHTML.includes('<td>TEST &lt;img src=x onerror=&quot;classAttack()&quot;&gt; &amp; &quot;quoted&quot;</td>'));
  assert.ok(output.innerHTML.includes('<td>TEST O&#39;Brien &amp; &lt;/td&gt;&lt;img src=x onerror=&#39;notesAttack()&#39;&gt;</td>'));
  assert.ok(output.innerHTML.includes('title="Voided: &quot; onmouseover=&quot;voidTimeAttack()&quot; data-break=&quot; · Reason: &quot;&gt;&lt;img src=x onerror=&quot;voidReasonAttack()&quot;&gt; &amp; &#39;reason&#39;"'));
  assert.doesNotMatch(output.innerHTML, /<(?:img|script|svg|iframe|a)\b/iu);
  for (const [tag] of output.innerHTML.matchAll(/<[^>]*>/gu)) {
    // Remove quoted attributes before checking for an injected real handler;
    // escaped handler-looking text is allowed inside the title's value.
    const attributes = tag.replace(/"[^"]*"|'[^']*'/gu, '""');
    assert.doesNotMatch(attributes, /\son[a-z]+\s*=|\bsrcdoc\s*=/iu);
  }
  assert.equal((output.innerHTML.match(/<tbody>/gu) || []).length, 1);
  assert.equal((output.innerHTML.match(/<td(?:\s|>)/gu) || []).length, 18);
  assert.equal(reads, 1);
  assert.equal(summaries, 1);
  assert.equal(JSON.stringify(snapshot), before, 'The original permanent rows and queue remain byte-for-byte unchanged.');
});
