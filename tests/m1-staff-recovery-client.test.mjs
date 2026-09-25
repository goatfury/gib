import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStaffRecovery, confirmedRecovery, staffRecoveryEnabled, staffRecoveryFinish, validRecoveryOriginal } from '../m1/staff-recovery-client.mjs';

const uuid = digit => `${digit}23e4567-e89b-42d3-a456-426614174000`;
const original = () => ({ operation: 'recover', requestId: `gib-m1-staff-request-${uuid(1)}`,
  previousClockInPunchId: `gib-m1-staff-${uuid(2)}`, punch: { punchId: `gib-m1-staff-${uuid(3)}`,
    timestamp: '2026-09-25T09:00:00-04:00', date: '2026-09-25', staffId: 'test-staff', staffName: 'Test Staff',
    punchAction: 'clockIn', site: 'Rev', device: 'Staff Clock tablet', build: 'test', note: '' }, proposedFinishAt: null });
const result = (body = original()) => ({ ok: true, target: 'test', recovery: { enabled: true, items: [{
  requestId: body.requestId, previousClockInPunchId: body.previousClockInPunchId,
  staffId: body.punch.staffId, staffName: body.punch.staffName, newClockInPunchId: body.punch.punchId,
  startedAt: body.punch.timestamp, proposedFinishAt: body.proposedFinishAt, punch: structuredClone(body.punch), status: 'pending', revision: 0, conflicts: []
}] }, receipt: { requestId: body.requestId, previousClockInPunchId: body.previousClockInPunchId,
  newClockInPunchId: body.punch.punchId, startedAt: body.punch.timestamp, proposedFinishAt: body.proposedFinishAt, status: 'pending' } });
function harness(overrides = {}) {
  const values = new Map([['gib_m1b_staff_clock_state_v1', 'original ordinary queue'], ['instructorQueue', 'preserved']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const calls = [], adopted = [];
  const options = { storage, key: 'pending-recovery', target: 'test', post: async body => { calls.push(structuredClone(body)); return result(); },
    onConfirmed: async body => { adopted.push(structuredClone(body)); }, ...overrides };
  return { values, storage, calls, adopted, options, controller: createStaffRecovery(options) };
}

test('recovery gate is exact Revolution pilot environment and HTTPS origin', () => {
  const profile = { installationId: 'rev', allowedOrigin: 'https://gib-live.netlify.app' };
  const location = new URL('https://deploy-preview-89--gib-live.netlify.app/m1/');
  assert.equal(staffRecoveryEnabled(profile, { enabled: true, target: 'test' }, location), true);
  for (const [p, c, l] of [[{ ...profile, installationId: 'richmond' }, { enabled: true, target: 'test' }, location],
    [profile, { enabled: false, target: 'test' }, location], [profile, { enabled: true, target: 'production' }, location],
    [profile, { enabled: true, target: 'test' }, new URL('https://gib-live.netlify.app')],
    [profile, { enabled: true, target: 'test' }, new URL('http://deploy-preview-89--gib-live.netlify.app')]]) assert.equal(staffRecoveryEnabled(p, c, l), false);
  assert.equal(staffRecoveryEnabled(profile, { enabled: true, target: 'production' }, new URL(profile.allowedOrigin)), false);
  assert.equal(staffRecoveryEnabled(profile, { enabled: true, target: 'test' }, new URL('https://deploy-preview-90--gib-live.netlify.app')), false);
});

test('original request is durable before dispatch and ordinary queues remain byte-for-byte intact', async () => {
  const h = harness();
  h.options.post = async body => { assert.deepEqual(JSON.parse(h.values.get('pending-recovery')), body); return result(body); };
  const controller = createStaffRecovery(h.options);
  assert.equal(await controller.begin(original()), true);
  assert.equal(h.values.has('pending-recovery'), false);
  assert.equal(h.values.get('gib_m1b_staff_clock_state_v1'), 'original ordinary queue');
  assert.equal(h.values.get('instructorQueue'), 'preserved');
  assert.deepEqual(h.adopted, [original()]);
});

test('lost reply and reload recover by authoritative read with exact original timestamp and IDs, no replacement write', async () => {
  const h = harness({ post: async () => { throw new Error('connection interrupted'); } });
  assert.equal(await h.controller.begin(original()), false);
  const calls = [];
  const reopened = createStaffRecovery({ ...h.options, post: async body => { calls.push(body); return result(); } });
  assert.equal(await reopened.resume(), true);
  assert.deepEqual(calls, [{ operation: 'recoveryRead' }]);
  assert.deepEqual(h.adopted, [original()]);
});

test('complete missing read permits only the exact durable retry and overlapping lifecycle events coalesce', async () => {
  const h = harness(); h.values.set('pending-recovery', JSON.stringify(original()));
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const controller = createStaffRecovery({ ...h.options, post: async body => {
    h.calls.push(structuredClone(body));
    if (body.operation === 'recoveryRead') { await waiting; return { ok: true, target: 'test', recovery: { enabled: true, items: [] } }; }
    return result(body);
  } });
  const first = controller.resume(), second = controller.resume();
  assert.equal(first, second); release(); await first;
  assert.deepEqual(h.calls, [{ operation: 'recoveryRead' }, original()]);
  assert.equal(h.adopted.length, 1);
});

test('wrong environment, missing proof, conflicting metadata and duplicate matching items never clear journal', async () => {
  const variants = [value => { value.target = 'production'; }, value => { delete value.receipt; },
    value => { value.receipt.startedAt = '2026-09-25T10:00:00-04:00'; }, value => { value.recovery.items[0].punch.note = 'changed'; },
    value => { value.recovery.items.push(value.recovery.items[0]); }];
  for (const change of variants) {
    const value = result(); change(value);
    const h = harness({ post: async () => value });
    assert.equal(await h.controller.begin(original()), false);
    assert.deepEqual(h.controller.pending(), original());
    assert.equal(h.adopted.length, 0);
  }
});

test('failed read never dispatches a write; conflicting present proof never causes retry', async () => {
  for (const value of [{ ok: false }, { ...result(), target: 'production' }, (() => { const v = result(); v.recovery.items[0].punch.timestamp = '2026-09-25T10:00:00-04:00'; return v; })()]) {
    const calls = [];
    const h = harness({ post: async body => { calls.push(body); return value; } });
    h.values.set('pending-recovery', JSON.stringify(original()));
    assert.equal(await h.controller.resume(), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(h.controller.pending(), original());
  }
});

test('explicit same-original retry can finish an incomplete central intent even when readback fails', async () => {
  const h = harness({ post: async body => { h.calls.push(structuredClone(body)); if (body.operation === 'recoveryRead') throw new Error('incomplete intent'); return result(body); } });
  h.values.set('pending-recovery', JSON.stringify(original()));
  assert.equal(await h.controller.resume(), false);
  assert.equal(await h.controller.retryOriginal(), true);
  assert.deepEqual(h.calls, [{ operation: 'recoveryRead' }, original()]);
});

test('local adoption/storage failure and a changed journal retain evidence and never unlock', async () => {
  const h = harness({ onConfirmed: async () => { throw new Error('storage full'); } });
  assert.equal(await h.controller.begin(original()), false);
  assert.deepEqual(h.controller.pending(), original());
  const changed = original(); changed.proposedFinishAt = '2026-09-24T18:00:00-04:00';
  const other = harness({ post: async () => { other.values.set('pending-recovery', JSON.stringify(changed)); return result(); } });
  assert.equal(await other.controller.begin(original()), false);
  assert.deepEqual(other.controller.pending(), changed);
  assert.equal(other.adopted.length, 0);
});

test('approved/rejected current state can confirm immutable original start without altering proposal receipt', () => {
  for (const status of ['approved', 'rejected']) { const v = result(); v.recovery.items[0].status = status; v.recovery.items[0].revision = 1;
    assert.equal(confirmedRecovery(v, original(), 'test', true).status, status); }
});

test('a newer journal written during local adoption is never erased by the older confirmation', async () => {
  const newer = original(); newer.requestId = `gib-m1-staff-request-${uuid(4)}`;
  newer.punch.punchId = `gib-m1-staff-${uuid(5)}`;
  const h = harness({ onConfirmed: async () => { h.values.set('pending-recovery', JSON.stringify(newer)); } });
  assert.equal(await h.controller.begin(original()), false);
  assert.deepEqual(h.controller.pending(), newer);
});

test('a VOID new shift and incomplete conflict evidence never becomes a local active punch', async () => {
  for (const conflicts of [['new-punch-void'], ['unexpected'], ['finish-punch-void', 'finish-punch-void'], null, undefined]) {
    const value = result(); value.recovery.items[0].conflicts = conflicts;
    const h = harness({ post: async () => value });
    assert.equal(await h.controller.begin(original()), false);
    assert.deepEqual(h.controller.pending(), original());
    assert.equal(h.adopted.length, 0);
  }
});

test('finish parser uses New York time and refuses nonexistent or ambiguous local times', () => {
  assert.equal(staffRecoveryFinish('2026-09-24T17:30'), '2026-09-24T17:30:00-04:00');
  assert.equal(staffRecoveryFinish('2026-03-08T02:30'), null);
  assert.equal(staffRecoveryFinish('2026-11-01T01:30'), null);
  assert.equal(validRecoveryOriginal({ ...original(), proposedFinishAt: '2026-09-25T10:00:00-04:00' }), false);
});

test('kiosk offers explicit unknown finish and keeps proposed hours separate; default Staff Clock initializer remains gated', () => {
  const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../m1/staff-clock-client.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="staffRecoveryUnknown"[^>]*checked/);
  assert.match(html, /Start new shift now/);
  assert.match(source, /if \(!STAFF_RECOVERY_ENABLED\) return;/);
  assert.match(source, /Previous shift hours are pending manager review and are not included in approved hours/);
  assert.match(source, /recoveryRequestId: original.requestId, previousClockInPunchId: original.previousClockInPunchId/);
});
