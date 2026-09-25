import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../m1/admin/staff-recovery.js', import.meta.url), 'utf8');
const UUID = number => `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const requestId = number => `gib-m1-staff-request-${UUID(number)}`;
const punchId = number => `gib-m1-staff-${UUID(number)}`;
const storageKey = 'm1-staff-recovery-admin-v1:Rev:test';
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function item(changes = {}) {
  return { requestId: requestId(1), staffId: 'qa-staff', staffName: 'QA Staff', previousClockInPunchId: punchId(1),
    previousClockInAt: '2026-09-21T09:00:00-04:00', newClockInPunchId: punchId(2), startedAt: '2026-09-22T09:00:00-04:00',
    proposedFinishAt: '2026-09-21T17:00:00-04:00', proposedBy: 'QA Staff', proposedAt: '2026-09-22T09:00:00-04:00',
    status: 'pending', revision: 0, decision: null, conflicts: [],
    punch: { punchId: punchId(2), timestamp: '2026-09-22T09:00:00-04:00', date: '2026-09-22', staffId: 'qa-staff', staffName: 'QA Staff',
      punchAction: 'clockIn', site: 'Rev', device: 'TEST tablet', build: 'm1b-test', note: '' }, ...changes };
}
const response = (items = [item()], changes = {}) => ({ ok: true, test: true, adminName: 'Andrew Smith', recovery: { enabled: true, items }, ...changes });
const receipt = (body, changes = {}) => ({ requestId: body.requestId, recoveryRequestId: body.recoveryRequestId, revision: body.revision + 1,
  decision: body.decision, finishAt: body.finishAt, punchId: body.punchId, reason: body.reason, adminName: 'Andrew Smith', decidedAt: '2026-09-23T12:00:00-04:00', ...changes });
const decidedItem = (body, changes = {}) => item({ status: body.decision === 'approve' ? 'approved' : 'rejected', revision: body.revision + 1, decision: receipt(body), ...changes });
const fields = () => ({ finishDate: '2026-09-21', finishTime: '17:00:00', finishOffset: '-04:00', reason: 'Verified prior finish' });
function runtime(options = {}) {
  const events = {}, calls = [], storage = options.storage || new Map(), confirmations = [];
  const status = { textContent: '', className: '' };
  const root = { hidden: true, innerHTML: '', attributes: {}, addEventListener: (name, handler) => { events[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, querySelector: () => status, replaceChildren() { this.innerHTML = ''; } };
  let sequence = 10, admin = 'Andrew Smith', unauthorized = 0, changed = 0;
  const context = vm.createContext({ Date, Intl, Object, Set, JSON, Promise, crypto: { randomUUID: () => UUID(++sequence) },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => { if (options.storageFails) throw new Error('Storage unavailable'); if (!options.storageNoop) storage.set(key, value); }, removeItem: key => storage.delete(key) },
    FormData: class { constructor(form) { return Object.entries(form.fields); } } });
  vm.runInContext(source, context);
  const ui = context.GIBM1StaffRecovery.create({ root, site: 'Rev', target: 'test', enabled: true, getAdmin: () => admin,
    timestampForInputs: (date, time, offset, required) => required && date && time && offset ? `${date}T${time.length === 5 ? `${time}:00` : time}${offset}` : '',
    request: (url, body) => { const call = deferred(); calls.push({ ...call, url, body: copy(body), journalAtDispatch: storage.get(storageKey) }); return call.promise; },
    confirm: message => { confirmations.push(message); return options.confirmed !== false; },
    onUnauthorized: () => unauthorized++, onChanged: () => changed++, ...options });
  return { ui, root, status, storage, calls, confirmations, events, setAdmin: value => { admin = value; }, unauthorized: () => unauthorized, changed: () => changed,
    async open(value = response()) { const result = ui.open(); await flush(); calls.at(-1).resolve(value); await result; },
    click(action, id = requestId(1)) { return events.click({ target: { closest: selector => ({ dataset: selector === '[data-recovery-form]' ? { recoveryForm: id } : { recoveryAction: action } }) } }); },
    submit(decision = 'approve', values = fields(), id = requestId(1)) { const form = { fields: values, dataset: { recoveryForm: id } }; return events.submit({ target: { closest: () => form }, submitter: { dataset: { recoveryDecision: decision } }, preventDefault() {} }); },
    edit(values = fields(), id = requestId(1)) { events.input({ target: { closest: () => ({ fields: values, dataset: { recoveryForm: id } }) } }); }
  };
}

test('requires explicit Revolution target and feature gate before creating any UI or requests', () => {
  for (const options of [{ enabled: false }, { enabled: undefined }, { site: 'RICH' }, { target: 'preview' }, { timestampForInputs: null }]) {
    const h = runtime(options); assert.equal(h.ui, null); assert.equal(h.calls.length, 0); assert.equal(h.root.hidden, true);
  }
});

test('pending proposals and unknown finishes stay visibly separate from approved payroll time', async () => {
  const h = runtime(); await h.open(response([item({ proposedFinishAt: null })]));
  assert.match(h.root.innerHTML, /Employee proposals do not count as approved payroll time/);
  assert.match(h.root.innerHTML, /Don’t know/); assert.match(h.root.innerHTML, /Pending manager approval/);
  assert.doesNotMatch(h.root.innerHTML, /Approved payroll finish:/);
  const pending = h.submit('approve', { ...fields(), finishDate: '', finishTime: '', finishOffset: '' }); await pending;
  assert.equal(h.calls.length, 1); assert.equal(h.storage.size, 0);
  assert.match(h.status.textContent, /valid Eastern finish/);
});

test('linked VOID conflicts preserve history, block approval and still permit explicit rejection', async () => {
  for (const conflict of ['previous-punch-void', 'new-punch-void']) {
    const h = runtime(); await h.open(response([item({ conflicts: [conflict] })]));
    assert.match(h.root.innerHTML, /VOID history is preserved/);
    assert.match(h.root.innerHTML, /data-recovery-decision="approve" disabled/);
    await h.submit('approve'); assert.equal(h.calls.length, 1); assert.equal(h.storage.size, 0);
    const rejected = h.submit('reject'); await flush();
    const body = h.calls[1].body;
    h.calls[1].resolve(response([decidedItem(body, { conflicts: [conflict] })], { receipt: receipt(body) }));
    await rejected; assert.equal(h.storage.size, 0);
    assert.match(h.status.textContent, /Linked VOID records still need review/);
  }
  const approvedBody = { requestId: requestId(90), recoveryRequestId: requestId(1), revision: 0, decision: 'approve',
    finishAt: '2026-09-21T17:00:00-04:00', punchId: punchId(90), reason: 'Verified finish' };
  const h = runtime(); await h.open(response([decidedItem(approvedBody, { conflicts: ['finish-punch-void'] })]));
  assert.match(h.root.innerHTML, /Historical approval \(linked records need review\)/);
  assert.doesNotMatch(h.root.innerHTML, /Approved payroll finish:/);
});

test('missing, duplicated and unknown conflict evidence makes the proposal feed unavailable', async () => {
  for (const conflicts of [undefined, null, ['unknown'], ['new-punch-void', 'new-punch-void']]) {
    const h = runtime(); await h.open(response([item({ conflicts })]));
    assert.match(h.status.textContent, /unavailable/);
    assert.doesNotMatch(h.root.innerHTML, /No finish proposals in the confirmed/);
  }
});

test('failed, incomplete and wrong-environment reads never claim no proposals and can recover', async () => {
  for (const value of [response([], { test: false }), response([], { adminName: 'Other reviewer' }), response([], { recovery: { enabled: false, items: [] } }), response([item(), item()]), response([item({ startedAt: '2026-09-22T09:00:00-05:00' })])]) {
    const h = runtime(); await h.open(value);
    assert.match(h.status.textContent, /unavailable/); assert.doesNotMatch(h.root.innerHTML, /No finish proposals in the confirmed/);
    const refresh = h.ui.refresh(); await flush(); h.calls[1].resolve(response([])); await refresh;
    assert.match(h.root.innerHTML, /No finish proposals in the confirmed central read/);
  }
  const h = runtime(), opened = h.ui.open(); await flush(); h.calls[0].reject(new Error('Read failed')); await opened;
  assert.match(h.root.innerHTML, /unavailable/); assert.equal(h.changed(), 0);
});

test('overlapping reads share one request, and late reads cannot repopulate a closed Admin view', async () => {
  const h = runtime(), first = h.ui.open(); h.ui.refresh(); h.ui.refresh(); await flush(); assert.equal(h.calls.length, 1);
  h.ui.clear(); h.calls[0].resolve(response()); await first;
  assert.equal(h.root.hidden, true); assert.equal(h.root.innerHTML, '');
  h.setAdmin('Stuart Turner'); const reopened = h.ui.open(); await flush(); h.calls[1].resolve(response([], { adminName: 'Stuart Turner' })); await reopened;
  assert.match(h.root.innerHTML, /No finish proposals/);
});

test('unfinished entries survive refresh; Cancel discards only the form edits without sending a decision', async () => {
  const h = runtime(); await h.open(); const rendered = h.root.innerHTML; h.edit(); await h.ui.refresh();
  assert.equal(h.root.innerHTML, rendered); assert.equal(h.calls.length, 1); assert.match(h.status.textContent, /unfinished entries/);
  h.click('cancel'); const refresh = h.ui.refresh(); await flush(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response()); await refresh; assert.equal(h.storage.size, 0);
});

test('approval checks exact Eastern offset and prior shift bounds before confirmation or dispatch', async () => {
  for (const change of [{ finishTime: '08:59:00' }, { finishDate: '2026-09-22', finishTime: '09:01:00' }, { finishDate: '2026-09-22', finishTime: '04:00:00' }, { finishOffset: '' }, { finishOffset: '-05:00' }, { reason: '=formula' }]) {
    const h = runtime(); await h.open(); await h.submit('approve', { ...fields(), ...change });
    assert.equal(h.calls.length, 1); assert.equal(h.confirmations.length, 0); assert.equal(h.storage.size, 0);
  }
  const cancelled = runtime({ confirmed: false }); await cancelled.open(); await cancelled.submit();
  assert.equal(cancelled.confirmations.length, 1); assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.storage.size, 0);
});

test('saving one proposal preserves unfinished entries on another proposal', async () => {
  const other = item({ requestId: requestId(3) }), h = runtime(); await h.open(response([item(), other]));
  h.edit({ ...fields(), reason: 'Unfinished second decision', finishTime: '16:20:00' }, other.requestId);
  const saving = h.submit(); const original = h.calls[1].body;
  assert.match(h.root.innerHTML, /value="Unfinished second decision"/);
  assert.match(h.root.innerHTML, /value="16:20:00"/);
  h.calls[1].resolve({ ...response([decidedItem(original), other]), receipt: receipt(original) }); await saving;
  assert.match(h.root.innerHTML, /value="Unfinished second decision"/); await h.ui.refresh(); assert.equal(h.calls.length, 2);
});

test('a decision is persisted before dispatch and payroll success requires its exact central receipt', async () => {
  for (const decision of ['approve', 'reject']) {
    const h = runtime(); await h.open(); const submitted = h.submit(decision); await flush();
    const original = h.calls[1].body, stored = JSON.parse(h.calls[1].journalAtDispatch);
    assert.deepEqual(stored.body, original); assert.equal(stored.adminName, 'Andrew Smith'); assert.equal(Object.hasOwn(original, 'adminName'), false);
    assert.equal(original.decision, decision); assert.equal(original.revision, 0);
    if (decision === 'reject') { assert.equal(original.finishAt, null); assert.equal(original.punchId, null); }
    else { assert.match(original.punchId, /^gib-m1-staff-/); assert.equal(original.finishAt, '2026-09-21T17:00:00-04:00'); }
    assert.match(h.status.textContent, /Saving/); h.click('retry'); await h.submit(); assert.equal(h.calls.length, 2);
    h.calls[1].resolve({ ...response([decidedItem(original)]), receipt: receipt(original) }); await submitted;
    assert.equal(h.ui.hasPendingSave(), false); assert.equal(h.storage.size, 0); assert.equal(h.changed(), 1);
    assert.match(h.status.textContent, decision === 'approve' ? /confirmed centrally for payroll/ : /Earlier shift remains unresolved/);
    assert.match(h.root.innerHTML, decision === 'approve' ? /Approved payroll finish/ : /Rejected by Andrew Smith/);
  }
});

test('storage failure sends nothing and a malformed retained decision stays blocked without being deleted', async () => {
  for (const options of [{ storageFails: true }, { storageNoop: true }]) {
    const h = runtime(options); await h.open(); await h.submit();
    assert.equal(h.calls.length, 1); assert.match(h.status.textContent, /Nothing was sent/);
  }
  const raw = '{corrupt retained original', storage = new Map([[storageKey, raw]]), broken = runtime({ storage }); await broken.open(); await broken.submit();
  assert.equal(broken.calls.length, 1); assert.equal(broken.ui.hasPendingSave(), true); assert.equal(storage.get(storageKey), raw);
  assert.match(broken.root.innerHTML, /has not been discarded/);
});

test('the bounded feed accepts existing 400-character punch notes and rejects excess items', async () => {
  const h = runtime(), valid = item(); valid.punch.note = 'x'.repeat(400); await h.open(response([valid]));
  assert.match(h.root.innerHTML, /Pending manager approval/);
  const many = Array.from({ length: 101 }, (_, i) => item({ requestId: requestId(i + 1) }));
  const invalid = runtime(); await invalid.open(response(many)); assert.match(invalid.status.textContent, /unavailable/);
});

test('malformed, mismatched, wrong-reviewer and wrong-environment receipts retain the original decision', async () => {
  const mutations = [r => { r.receipt.requestId = requestId(999); }, r => { r.receipt.recoveryRequestId = requestId(999); }, r => { r.receipt.adminName = 'Stuart Turner'; },
    r => { r.receipt.revision = 0; }, r => { r.receipt.revision = 2; }, r => { r.receipt.reason = 'Other reason'; }, r => { r.receipt.punchId = punchId(999); },
    r => { r.receipt.finishAt = '2026-09-21T16:59:00-04:00'; }, r => { r.test = false; }, r => { r.receipt.extra = true; }, r => { r.receipt.decidedAt = '2026-09-23T12:00:00-05:00'; }, r => { r.recovery.items[0].punch.site = 'RICH'; },
    r => { r.recovery.items = []; }, r => { r.recovery.items = [item()]; }, r => { r.recovery.items[0].decision.requestId = requestId(888); }];
  for (const mutate of mutations) {
    const h = runtime(); await h.open(); const pending = h.submit(); const original = h.calls[1].body;
    const value = { ...response([decidedItem(original)]), receipt: receipt(original) }; mutate(value); h.calls[1].resolve(value); await pending;
    assert.equal(h.ui.hasPendingSave(), true); assert.deepEqual(JSON.parse(h.storage.get(storageKey)).body, original);
    assert.equal(h.changed(), 0); assert.match(h.status.textContent, /not confirmed/);
  }
});

test('lost responses retry exactly the original IDs, decision and reviewer after reopening, without an automatic write', async () => {
  const storage = new Map(), first = runtime({ storage }); await first.open(); const saving = first.submit();
  const original = first.calls[1].body; first.calls[1].reject(new Error('Lost reply')); await saving; first.ui.clear();
  const h = runtime({ storage }); await h.open(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].body.operation, 'recoveryReview');
  h.click('retry'); h.click('retry'); await flush(); assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].body, original);
  h.calls[1].resolve({ ...response([decidedItem(original)]), receipt: receipt(original) }); await flush();
  assert.equal(h.storage.size, 0); assert.equal(h.changed(), 1);
});

test('authenticated readback can confirm the exact lost receipt, but a later different receipt cannot', async () => {
  for (const matches of [true, false]) {
    const storage = new Map(), first = runtime({ storage }); await first.open(); const saving = first.submit();
    const original = first.calls[1].body; first.calls[1].reject(new Error('Lost reply')); await saving; first.ui.clear();
    const h = runtime({ storage }), actual = decidedItem(original);
    if (!matches) { actual.revision = 2; actual.decision = receipt(original, { requestId: requestId(777), revision: 2 }); }
    await h.open(response([actual])); assert.equal(h.calls.length, 1); assert.equal(h.ui.hasPendingSave(), !matches); assert.equal(h.changed(), matches ? 1 : 0);
  }
});

test('retrying an original rejection after a later approval confirms its original audit without calling the shift unresolved', async () => {
  const h = runtime(); await h.open(); const saving = h.submit('reject'), original = h.calls[1].body;
  h.calls[1].reject(new Error('Lost rejection reply')); await saving;
  h.click('retry'); const later = { ...original, requestId: requestId(777), revision: 1, decision: 'approve', finishAt: '2026-09-21T17:00:00-04:00', punchId: punchId(777) };
  h.calls[2].resolve({ ...response([decidedItem(later)]), receipt: receipt(original) }); await flush();
  assert.equal(h.ui.hasPendingSave(), false); assert.equal(h.changed(), 1);
  assert.match(h.status.textContent, /later manager decision/); assert.doesNotMatch(h.status.textContent, /remains unresolved/);
  assert.match(h.root.innerHTML, /Approved payroll finish/); assert.deepEqual(h.calls[2].body, original);
});

test('another reviewer cannot retry a retained decision or be shown stale completion from an earlier session', async () => {
  const storage = new Map(), first = runtime({ storage }); await first.open(); const saving = first.submit(); const original = first.calls[1].body;
  first.ui.clear(); first.calls[1].resolve({ ...response([decidedItem(original)]), receipt: receipt(original) }); await saving;
  assert.equal(first.root.innerHTML, ''); assert.equal(first.changed(), 0); assert.equal(storage.size, 1);
  const h = runtime({ storage }); h.setAdmin('Stuart Turner'); await h.open(response([item()], { adminName: 'Stuart Turner' }));
  h.click('retry'); await h.submit(); assert.equal(h.calls.length, 1); assert.match(h.root.innerHTML, /previous reviewer’s decision/);
  assert.deepEqual(JSON.parse(storage.get(storageKey)).body, original);
});

test('a proved revision conflict requires a fresh read and explicit new decision, while 401 retains the original', async () => {
  for (const status of [409, 401]) {
    const h = runtime(); await h.open(); const saving = h.submit(); h.calls[1].reject(Object.assign(new Error('Rejected'), { status })); await saving;
    assert.equal(h.ui.hasPendingSave(), status !== 409); assert.equal(h.unauthorized(), status === 401 ? 1 : 0);
    assert.equal(h.calls.length, 2); assert.equal(h.changed(), 0);
    if (status === 409) { assert.match(h.status.textContent, /changed before/); await h.submit(); assert.equal(h.calls.length, 2); }
  }
});

test('a conflict with another unfinished draft leaves Cancel accessible so a fresh read is possible', async () => {
  const other = item({ requestId: requestId(3) }), h = runtime(); await h.open(response([item(), other]));
  h.edit({ ...fields(), reason: 'Keep this unfinished draft' }, other.requestId);
  const saving = h.submit(); h.calls[1].reject(Object.assign(new Error('Revision conflict'), { status: 409 })); await saving;
  await h.ui.refresh(); assert.equal(h.calls.length, 2); assert.match(h.root.innerHTML, /value="Keep this unfinished draft"/);
  assert.match(h.root.innerHTML, /<fieldset disabled>/);
  assert.match(h.root.innerHTML, /<\/fieldset><button[^>]*data-recovery-action="cancel" >Cancel changes<\/button>/,
    'Cancel must be enabled outside the disabled decision fieldset');
  h.click('cancel', other.requestId); const fresh = h.ui.refresh(); await flush(); assert.equal(h.calls.length, 3);
  h.calls[2].resolve(response([item(), other])); await fresh; assert.doesNotMatch(h.root.innerHTML, /<fieldset disabled>/);
});

test('a concurrently approved proposal keeps its now-unusable draft visible with an enabled Cancel', async () => {
  const other = item({ requestId: requestId(3) }), h = runtime(); await h.open(response([item(), other]));
  h.edit({ ...fields(), reason: 'Unsent second proposal reason' }, other.requestId);
  const saving = h.submit(), original = h.calls[1].body;
  const concurrent = { ...original, requestId: requestId(888), recoveryRequestId: other.requestId, punchId: punchId(888) };
  h.calls[1].resolve({ ...response([decidedItem(original), decidedItem(concurrent, { requestId: other.requestId })]), receipt: receipt(original) }); await saving;
  assert.match(h.root.innerHTML, /unfinished decision can no longer be applied/);
  assert.match(h.root.innerHTML, /Unsent second proposal reason/);
  assert.match(h.root.innerHTML, /data-recovery-action="cancel" >Cancel changes/);
  await h.ui.refresh(); assert.equal(h.calls.length, 2);
  h.click('cancel', other.requestId); const fresh = h.ui.refresh(); await flush(); assert.equal(h.calls.length, 3);
  h.calls[2].resolve(response([decidedItem(original), decidedItem(concurrent, { requestId: other.requestId })])); await fresh;
  assert.doesNotMatch(h.root.innerHTML, /Unsent second proposal reason/);
});

test('rejected proposals can be explicitly revised and later approved without changing the original recovery ID', async () => {
  const oldBody = { requestId: requestId(8), recoveryRequestId: requestId(1), revision: 0, decision: 'reject', finishAt: null, punchId: null, reason: 'Finish still unknown' };
  const h = runtime(); await h.open(response([decidedItem(oldBody)])); const saving = h.submit('approve'); const body = h.calls[1].body;
  assert.equal(body.recoveryRequestId, requestId(1)); assert.equal(body.revision, 1); assert.notEqual(body.requestId, oldBody.requestId);
  h.calls[1].resolve({ ...response([decidedItem(body)]), receipt: receipt(body) }); await saving;
  assert.match(h.root.innerHTML, /Approved payroll finish/); assert.equal(h.changed(), 1);
});

test('displayed names and reasons cannot inject markup, and production requires its own test=false responses', async () => {
  const h = runtime({ target: 'production' }); const unsafe = item({ staffName: '<img src=x>', proposedBy: '<img src=x>' }); unsafe.punch.staffName = unsafe.staffName;
  await h.open(response([unsafe], { test: false })); assert.match(h.root.innerHTML, /&lt;img src=x&gt;/); assert.doesNotMatch(h.root.innerHTML, /<img src=x>/);
  assert.doesNotMatch(h.root.innerHTML, / · TEST/);
});
