import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test('fallback opens a fresh Daily Review request with selected, previous, or yesterday date', async () => {
  const calls = [];
  const context = vm.createContext({
    managerDayReview: { hasPendingSave: () => false }, currentDate: '',
    defaultYesterday: () => '2026-09-23',
    loadReview: async (...args) => { calls.push(args); return true; }
  });
  vm.runInContext(between('async function openLegacyReview(', 'managerDayReview = globalThis.GIBM1ManagerReview'), context);
  assert.equal(await context.openLegacyReview('2026-09-07'), true);
  context.currentDate = '2026-09-22';
  assert.equal(await context.openLegacyReview(''), true);
  context.currentDate = '';
  assert.equal(await context.openLegacyReview(''), true);
  assert.deepEqual(calls, [['2026-09-07'], ['2026-09-22'], ['2026-09-23']]);
  // No preserveOnFailure option: an unsuccessful read cannot retain editable stale records.
});

test('fallback and direct Daily Review reload do not discard or bypass an original pending save', async () => {
  let requests = 0;
  const notices = [];
  const context = vm.createContext({
    managerDayReview: { hasPendingSave: () => true },
    loadReview: async () => { requests++; },
    $: () => ({}), showMessage: (_node, message) => notices.push(message)
  });
  vm.runInContext(between('async function openLegacyReview(', 'managerDayReview = globalThis.GIBM1ManagerReview'), context);
  assert.equal(await context.openLegacyReview('2026-09-22'), false);
  vm.runInContext(between('async function loadReview(', 'function setStaffCorrectionDefaults('), context);
  assert.equal(await context.loadReview('2026-09-22'), false);
  assert.equal(requests, 0);
  assert.match(notices[0], /original save/);
});

function additionHarness({ valid = true, reject = false, loaded = true, pending = false, retain = true } = {}) {
  const sequence = [], requests = [], receipts = [], statuses = [];
  let journal = pending ? { body: { requestId: 'original-request' } } : null;
  const status = {};
  const form = {
    dataset: { classIndex: '0' }, elements: [],
    getAttribute: () => 'false', querySelector: () => status,
    reset() {}, classList: { remove() {} }
  };
  const body = { date: '2026-09-22', classLabel: '6 PM TEST', site: 'Rev', duration: 1,
    instructor: 'Synthetic existing instructor', reason: 'TEST existing request', notes: 'DO NOT PAY' };
  const context = vm.createContext({
    managerDayReview: {
      hasPendingSave: () => Boolean(journal),
      beginExternalSave(url, request) {
        sequence.push('persist');
        assert.equal(context.inFlightAdditions.size, 0, 'journal must precede in-flight guard');
        if (!retain) return false;
        journal = { url, body: request };
        return true;
      },
      finishExternalSave(request, confirmed) {
        assert.equal(context.inFlightAdditions.size, 0);
        assert.equal(request, journal.body);
        receipts.push({ request, confirmed });
        sequence.push(confirmed ? 'confirmed' : 'pending');
        if (confirmed) journal = null;
      }
    },
    reviewLoaded: loaded, legacyWritePending: () => false,
    ADMIN_MUTATIONS_ENABLED: true, readAdditionForm: () => body,
    normalize: value => value.toLowerCase(), inFlightAdditions: new Set(),
    clearClassOutcome() {}, setAdditionWorking() {}, additionInteractionGeneration: 0,
    currentDate: body.date, currentAdminName: 'Stuart Turner', API: { add: '/.netlify/functions/m1-admin-add' },
    requestIdForAddition: () => 'm1-2026-09-22-111111112222222233333333',
    requestAdditionWithReconciliation: async request => {
      sequence.push('dispatch'); requests.push(request);
      assert.equal(journal.body, request);
      if (reject) throw new Error('Connection lost');
      return { data: { ok: true, linkedRecordId: 'original-permanent-record', result: 'added' } };
    },
    validAdminAdditionResponse: () => { sequence.push('validate'); return valid; },
    clearAdditionRequestId() {}, setClassOutcome() {}, upsertConfirmedAddition() {}, focusClassCard() {},
    refreshConfirmedAddition: async () => { assert.equal(journal, null); sequence.push('fresh-read'); },
    applyPendingScheduleToReview() {}, setLoggedOut() {},
    showMessage: (_node, message) => statuses.push(message),
    window: { setTimeout: () => 1, clearTimeout() {} }
  });
  vm.runInContext(between('async function addInstructor(', 'function renderRecordList('), context);
  return { context, form, sequence, requests, receipts, statuses, get journal() { return journal; } };
}

test('legacy add retains the exact request before dispatch and clears it only after full receipt validation', async () => {
  const h = additionHarness();
  await h.context.addInstructor(h.form);
  assert.deepEqual(h.sequence, ['persist', 'dispatch', 'validate', 'confirmed', 'fresh-read']);
  assert.equal(h.requests.length, 1);
  assert.equal(h.receipts[0].request, h.requests[0]);
  assert.equal(h.journal, null);
});

for (const [name, options] of [['network failure', { reject: true }], ['incomplete receipt', { valid: false }]]) {
  test(`legacy ${name} keeps the original request and blocks a second addition`, async () => {
    const h = additionHarness(options);
    await h.context.addInstructor(h.form);
    assert.equal(h.requests.length, 1);
    const original = h.requests[0];
    assert.equal(h.journal.body, original);
    assert.equal(h.receipts[0].confirmed, false);
    await h.context.addInstructor(h.form);
    assert.equal(h.requests.length, 1);
    assert.equal(h.journal.body, original);
    assert.match(h.statuses[0], /same save/);
  });
}

test('legacy additions require a fresh Daily Review and safely retained request before dispatch', async () => {
  for (const options of [{ loaded: false }, { pending: true }, { retain: false }]) {
    const h = additionHarness(options);
    await h.context.addInstructor(h.form);
    assert.equal(h.requests.length, 0);
    assert.equal(h.receipts.length, 0);
  }
});

test('manager integration tracks existing removal/addition work and injects complete addition receipt validation', () => {
  const calls = [];
  const context = vm.createContext({
    removalWorking: false, savedRemoval: null, inFlightAdditions: new Set(),
    managerDayReview: null, requestJson() {}, SITE: 'Rev', currentAdminName: 'Stuart Turner',
    uniqueRequestId() {}, setLoggedOut() {},
    validAdminAdditionResponse: (result, expected) => { calls.push({ result, expected }); return false; },
    globalThis: { GIBM1ManagerReview: { create: options => options } }
  });
  vm.runInContext(between('function legacyWritePending()', '      initialize();'), context);
  assert.equal(context.managerDayReview.legacyWritePending(), false);
  context.savedRemoval = { request: { requestId: 'preserved-removal' } };
  assert.equal(context.managerDayReview.legacyWritePending(), true);
  context.savedRemoval = null; context.inFlightAdditions.add('preserved-addition');
  assert.equal(context.managerDayReview.legacyWritePending(), true);
  const body = { requestId: 'same-id', date: '2026-09-22', classLabel: '6 PM TEST', duration: 1,
    instructor: 'Synthetic instructor', site: 'Rev', reason: 'TEST', notes: 'DO NOT PAY' };
  assert.equal(context.managerDayReview.validateAdditionResult({ ok: true, linkedRecordId: 'id' }, body), false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].expected)), { ...body, adminName: 'Stuart Turner' });
});

test('stale instructor-search removal controls cannot start a new removal after Daily Review fails', async () => {
  const notices = [];
  const context = vm.createContext({
    managerDayReview: { hasPendingSave: () => false }, reviewLoaded: false, savedRemoval: null,
    toast: message => notices.push(message),
    $: () => ({}), showMessage: (_node, message) => notices.push(message)
  });
  vm.runInContext(between('function openRemoval(', 'function validRemovalReceipt('), context);
  vm.runInContext(between('async function runRemoval(', 'async function leaveConflictedRemoval('), context);
  context.openRemoval({ recordId: 'stale-record' });
  await context.runRemoval('remove');
  assert.equal(notices.length, 2);
  assert.ok(notices.every(message => /fresh Daily Review records/.test(message)));
});

test('a saved removal keeps its read-only recovery path when Daily Review has not loaded', async () => {
  const requests = [];
  const context = vm.createContext({
    managerDayReview: { hasPendingSave: () => false }, reviewLoaded: false,
    savedRemoval: { request: { requestId: 'preserved-original-removal' }, record: {} },
    removalWorking: false, REV_REMOVAL_ENABLED: true, removalSelection: {},
    removalResubmitAllowed: false, removalConflictConfirmed: false, adminRequestToken: 'existing-memory-only-token',
    currentAdminName: 'Stuart Turner', API: { void: '/.netlify/functions/m1-admin-void' },
    $: () => ({}), showMessage() {}, savedRemovalNotice() {},
    requestJson: async (_url, body) => { requests.push(body); throw new Error('Offline'); }
  });
  vm.runInContext(between('async function runRemoval(', 'async function leaveConflictedRemoval('), context);
  await context.runRemoval('check');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestId, 'preserved-original-removal');
  assert.equal(requests[0].operation, 'check');
  assert.equal(context.savedRemoval.request.requestId, 'preserved-original-removal');
});
