import assert from 'node:assert/strict';
import test from 'node:test';
import { digestHash } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { deliverMailApp, readMailAppDelivery } from '../netlify/functions/_lib/m1-mailapp-delivery.mjs';

const START = Date.parse('2026-09-28T22:00:00.000Z');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => structuredClone(value);
const canonical = m => ({ messageId: m.messageId, from: m.from, to: m.to, cc: m.cc, subject: m.subject,
  html: m.html, text: m.text, synthetic: m.synthetic, target: m.target, ...(Object.hasOwn(m, 'bcc') ? { bcc: m.bcc } : {}) });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };

function harness() {
  let now = START, sequence = 0, version = 0;
  const message = { messageId: 'm1-test-scheduled-rev-2026-09-28', from: 'revbjjops@gmail.com', to: ['stu@example.invalid'], cc: [],
    subject: 'Synthetic daily review', html: '<p>Synthetic question</p>', text: 'Synthetic question', synthetic: true, target: 'test' };
  message.hash = digestHash(canonical(message));
  const entries = new Map(), calls = [], reads = [], writes = [];
  const store = {
    async getWithMetadata(key, options) { assert.deepEqual(options, { type: 'json', consistency: 'strong' }); reads.push(key); return clone(entries.get(key) || null); },
    async set(key, raw, options) {
      assert.ok(options.onlyIfNew === true || typeof options.onlyIfMatch === 'string');
      writes.push(key); const previous = entries.get(key);
      if (options.onlyIfNew && previous || options.onlyIfMatch && options.onlyIfMatch !== previous?.etag) return { modified: false };
      const etag = 'opaque-' + ++version; entries.set(key, { etag, data: JSON.parse(raw) }); return { modified: true, etag };
    }
  };
  const deps = { scope: { target: 'test', profile: { installationId: 'rev' } }, deliveryStore: store, clock: () => now, uuid: () => uuid(++sequence) };
  const result = (state = 'not-attempted', code = state === 'submitted' ? 'MAILAPP_SUBMITTED' : state === 'unknown' ? 'MAILAPP_CALL_UNCERTAIN' : 'MAILAPP_READY') => ({
    ok: ['MAILAPP_READY', 'MAILAPP_SUBMITTED'].includes(code), target: 'test', gym: 'rev', messageId: message.messageId, hash: message.hash, state, code,
    attemptedAt: state === 'not-attempted' ? null : new Date(START).toISOString(),
    completedAt: state === 'submitted' ? new Date(START + 1).toISOString() : null, retrySafe: state === 'not-attempted'
  });
  let provider = async (_, options) => result(options.action === 'attendanceMailSend' ? 'submitted' : 'not-attempted');
  const policy = { canonical, validMessage: m => digestHash(canonical(m)) === m.hash,
    gate: () => null,
    async request(m, options, signal) { calls.push({ message: clone(m), options: clone(options), signal }); return provider(m, options, signal); } };
  return { message, entries, calls, reads, writes, store, deps, policy, result,
    at(value) { now = value; }, provider(fn) { provider = fn; },
    send(m = message) { return deliverMailApp(m, deps, policy); }, read(m = message) { return readMailAppDelivery(m, deps, policy); },
    sends() { return calls.filter(call => call.options.action === 'attendanceMailSend'); },
    claimKey: 'mailapp/messages/' + message.messageId };
}

test('optional BCC is immutable, hash-bound and passed separately without changing legacy payloads', async () => {
  const old = harness(), original = clone(old.message), oldHash = old.message.hash;
  assert.equal((await old.send()).state, 'submitted');
  assert.deepEqual(old.entries.get(old.claimKey).data.message, original);
  assert.equal(old.entries.get(old.claimKey).data.message.hash, oldHash);
  assert.equal(Object.hasOwn(old.entries.get(old.claimKey).data.message, 'bcc'), false);
  const changed = { ...original, bcc: ['andrew@example.invalid'] }; changed.hash = digestHash(canonical(changed));
  assert.equal((await old.send(changed)).code, 'RETAINED_MESSAGE_MISMATCH'); assert.equal(old.sends().length, 1);
  const h = harness(); h.message.bcc = ['andrew@example.invalid']; h.message.hash = digestHash(canonical(h.message));
  const saved = clone(h.message), waiting = deferred(), entered = deferred();
  h.provider(async (_message, options) => {
    if (options.action === 'attendanceMailStatus') { entered.resolve(); await waiting.promise; }
    return { ...h.result(options.action === 'attendanceMailSend' ? 'submitted' : 'not-attempted'), hash: saved.hash };
  });
  const send = h.send(); await entered.promise; h.message.bcc[0] = 'changed@example.invalid'; waiting.resolve();
  assert.equal((await send).state, 'submitted');
  assert.deepEqual(h.entries.get(h.claimKey).data.message, saved);
  assert.deepEqual(h.sends()[0].message.bcc, ['andrew@example.invalid']); assert.deepEqual(h.sends()[0].message.cc, []);
  assert.doesNotMatch(h.sends()[0].message.html + h.sends()[0].message.text, /andrew@example/);
});

test('Richmond TEST status binds own message ID and reply gym; cross-gym, production and unknown environments make no calls', async () => {
  const prepare = () => { const h = harness(); h.deps.scope.profile = { installationId: 'richmond', environment: 'test' };
    h.message.messageId = 'm1-test-scheduled-richmond-2026-09-28'; h.message.to = ['trey@example.invalid'];
    h.message.hash = digestHash(canonical(h.message)); return h; };
  const h = prepare(); h.deps.statusOnly = true;
  h.provider(async () => ({ ...h.result('not-attempted', 'MAILAPP_DISABLED'), gym: 'richmond' }));
  const result = await h.send(); assert.equal(result.state, 'not-started'); assert.equal(result.code, 'MAILAPP_DISABLED');
  assert.equal(h.calls.length, 1); assert.equal(h.sends().length, 0); assert.equal(h.writes.length, 0);
  const mismatch = prepare(); mismatch.deps.statusOnly = true;
  assert.equal((await mismatch.send()).code, 'MAILAPP_RESPONSE_INVALID'); assert.equal(mismatch.sends().length, 0); assert.equal(mismatch.writes.length, 0);
  for (const change of [h => { h.deps.scope.target = 'production'; }, h => { delete h.deps.scope.profile.environment; },
    h => { h.deps.scope.profile.environment = 'production'; }, h => { h.deps.scope.profile.installationId = 'rev'; },
    h => { h.message.messageId = 'm1-test-scheduled-rev-2026-09-28'; h.message.hash = digestHash(canonical(h.message)); }]) {
    const invalid = prepare(); change(invalid); assert.equal((await invalid.send()).state, 'blocked');
    assert.equal(invalid.calls.length, 0); assert.equal(invalid.writes.length, 0);
  }
});

test('BCC tampering, invalid addresses and duplicate To/CC recipients cannot dispatch', async () => {
  for (const bcc of ['andrew@example.invalid', null, ['andrew@example.invalid', 'other@example.invalid'], ['STU@example.invalid'], ['injected\r\n@example.invalid']]) {
    const h = harness(); h.message.bcc = bcc; h.message.hash = digestHash(canonical(h.message));
    assert.equal((await h.send()).code, 'INVALID_MAILAPP_MESSAGE'); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  }
  const h = harness(); h.message.bcc = ['andrew@example.invalid'];
  assert.equal((await h.send()).code, 'INVALID_MAILAPP_MESSAGE'); assert.equal(h.calls.length, 0);
});

test('lost confirmation retains the original BCC and never resends or accepts removing it from that day', async () => {
  const h = harness(); h.message.bcc = ['andrew@example.invalid']; h.message.hash = digestHash(canonical(h.message));
  h.provider(async (_, options) => { if (options.action === 'attendanceMailSend') throw new Error('Synthetic reply lost'); return h.result(); });
  assert.equal((await h.send()).state, 'unknown'); const original = clone(h.entries.get(h.claimKey).data);
  h.at(START + 61000); assert.equal((await h.send()).state, 'unknown'); assert.equal(h.sends().length, 1);
  const removed = { ...h.message }; delete removed.bcc; removed.hash = digestHash(canonical(removed));
  assert.equal((await h.send(removed)).code, 'RETAINED_MESSAGE_MISMATCH'); assert.equal(h.sends().length, 1);
  assert.deepEqual(h.entries.get(h.claimKey).data, original);
});

test('read is local and a single submitted send has an immutable, read-back claim and receipt', async () => {
  const h = harness(); assert.equal((await h.read()).state, 'not-started'); assert.equal(h.calls.length, 0);
  let guard = 0; h.policy.beforeDispatch = async () => { guard++; };
  h.provider(async (message, options) => {
    assert.deepEqual(message, h.message); assert.match(options.binding.requestId, /^00000000-/);
    assert.equal(options.binding.expiresAt - options.binding.createdAt, 60000);
    if (options.action === 'attendanceMailSend') {
      const saved = h.entries.get(h.claimKey).data;
      assert.deepEqual(saved.message, h.message); assert.deepEqual(saved.bindings[0], options.binding);
      assert.ok(h.reads.filter(key => key === h.claimKey).length >= 2); assert.equal(guard, 2);
      return h.result('submitted');
    }
    assert.equal(h.entries.has(h.claimKey), false); return h.result();
  });
  const result = await h.send(); assert.equal(result.state, 'submitted'); assert.equal(result.provider, 'mailapp');
  assert.equal(result.attemptCount, 1); assert.equal(result.durableAttempt, true); assert.equal(result.deliveryConfirmed, false);
  assert.equal(result.retryAllowed, false); assert.equal(result.receipts.length, 1); assert.equal('providerId' in result, false);
  const calls = h.calls.length; assert.deepEqual(await h.read(), result); assert.deepEqual(await h.send(), result); assert.equal(h.calls.length, calls);
  assert.equal(h.sends().length, 1);
});

test('proven readiness failures are recheckable without a claim, while wrong scope and gates do no network work', async () => {
  for (const code of ['MAILAPP_DISABLED', 'MAILAPP_RECIPIENTS_UNAPPROVED', 'MAILAPP_AUTHORIZATION_UNAVAILABLE', 'MAILAPP_QUOTA_UNAVAILABLE']) {
    const h = harness(); h.provider(async () => h.result('not-attempted', code));
    const result = await h.send(); assert.equal(result.state, 'rejected'); assert.equal(result.googleResult.retrySafe, true);
    assert.equal(result.retryAllowed, false); assert.equal(result.attemptCount, 0); assert.equal(h.entries.size, 0);
    h.provider(async (_, options) => h.result(options.action === 'attendanceMailSend' ? 'submitted' : 'not-attempted'));
    assert.equal((await h.send()).state, 'submitted'); assert.equal(h.sends().length, 1);
  }
  for (const change of [h => { h.deps.scope.target = 'production'; }, h => { h.deps.scope.profile.installationId = 'richmond'; },
    h => { h.policy.gate = () => ({ state: 'disabled', code: 'MAILAPP_DISABLED' }); }]) {
    const h = harness(); change(h); assert.ok(['disabled', 'blocked'].includes((await h.send()).state)); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  }
});

test('concurrent requests and caller mutation cannot produce another send or change the claimed payload', async () => {
  const h = harness(), ready = deferred(), entered = deferred(); let count = 0;
  h.provider(async (_, options) => {
    if (options.action === 'attendanceMailStatus') { if (++count === 2) entered.resolve(); await ready.promise; return { ...h.result(), hash: original.hash }; }
    assert.deepEqual(h.calls.at(-1).message, original); return { ...h.result('submitted'), hash: original.hash };
  });
  const original = clone(h.message), first = h.send(), second = h.send(); await entered.promise;
  h.message.to[0] = 'changed@example.invalid'; h.message.text = 'Changed while awaiting';
  ready.resolve(); const results = await Promise.all([first, second]);
  assert.equal(h.sends().length, 1); assert.ok(results.some(item => item.state === 'submitted'));
  assert.deepEqual(h.entries.get(h.claimKey).data.message, original);
});

test('a claim write that throws after persistence or cannot be read back never dispatches, including after expiry/reload', async () => {
  for (const mode of ['throw-after-write', 'lost-readback']) {
    const h = harness(), set = h.store.set, get = h.store.getWithMetadata; let broken = true;
    h.store.set = async (...args) => { const value = await set(...args); if (broken && args[0] === h.claimKey && mode === 'throw-after-write') throw new Error('private platform detail'); return value; };
    h.store.getWithMetadata = async (...args) => { if (broken && args[0] === h.claimKey && h.entries.has(h.claimKey) && mode === 'lost-readback') throw new Error('read unavailable'); return get(...args); };
    const failed = await h.send(); assert.equal(failed.code, 'PENDING_STORAGE_UNCONFIRMED'); assert.equal(failed.durableAttempt, undefined);
    assert.equal(h.sends().length, 0); assert.equal(h.entries.has(h.claimKey), true);
    broken = false; h.at(START + 48 * 60 * 60 * 1000);
    const saved = await h.read(); assert.equal(saved.state, 'unknown'); assert.equal(saved.durableAttempt, true);
    const recovered = await h.send(); assert.equal(recovered.state, 'unknown'); assert.equal(recovered.googleResult.retrySafe, true);
    assert.equal(recovered.retryAllowed, false); assert.equal(h.sends().length, 0);
    assert.equal(JSON.stringify(recovered).includes('private platform detail'), false);
  }
});

test('storage failure before a claim may recover, and a failed final ownership guard cannot send after claiming', async () => {
  const h = harness(), set = h.store.set; let broken = true;
  h.store.set = async (...args) => { if (broken && args[0] === h.claimKey) throw new Error('before write'); return set(...args); };
  assert.equal((await h.send()).state, 'unknown'); assert.equal(h.entries.size, 0); assert.equal(h.sends().length, 0);
  broken = false; assert.equal((await h.send()).state, 'submitted'); assert.equal(h.sends().length, 1);
  const guarded = harness(); let guards = 0;
  guarded.policy.beforeDispatch = async () => { if (++guards === 2) throw new Error('WORKFLOW_PROCESSOR_SUPERSEDED'); };
  assert.equal((await guarded.send()).state, 'unknown'); assert.equal(guarded.entries.has(guarded.claimKey), true); assert.equal(guarded.sends().length, 0);
  guarded.policy.beforeDispatch = () => { throw new Error('must not gate status recovery'); };
  assert.equal((await guarded.send()).state, 'unknown'); assert.equal(guarded.sends().length, 0);
});

test('lost send reply remains permanently single-dispatch and a later status can prove submission without erasing failure evidence', async () => {
  const h = harness(); let attempted = false;
  h.provider(async (_, options) => {
    if (options.action === 'attendanceMailSend') { attempted = true; throw new Error('private signed URL'); }
    return h.result(attempted ? 'unknown' : 'not-attempted');
  });
  const first = await h.send(); assert.equal(first.state, 'unknown'); assert.equal(first.code, 'MAILAPP_NETWORK_FAILURE');
  assert.equal(first.durableAttempt, true); const receipt = clone(first.receipts[0]);
  h.at(START + 24 * 60 * 60 * 1000); await h.send(); assert.equal(h.sends().length, 1);
  h.policy.gate = () => ({ state: 'disabled', code: 'MAILAPP_DISABLED' });
  h.provider(async (_, options) => { assert.equal(options.action, 'attendanceMailStatus'); return h.result('submitted'); });
  const recovered = await h.send(); assert.equal(recovered.state, 'submitted'); assert.deepEqual(recovered.receipts[0], receipt);
  assert.equal(recovered.receipts.length, 2); assert.equal(recovered.retryAllowed, false); assert.equal(h.sends().length, 1);
});

test('a final awaited ownership check cannot dispatch after the binding expires or the send gate closes', async () => {
  for (const mode of ['expired', 'disabled']) {
    const h = harness(), paused = deferred(), entered = deferred(); let guards = 0;
    h.policy.beforeDispatch = async () => { if (++guards === 2) { entered.resolve(); await paused.promise; } };
    const work = h.send(); await entered.promise;
    if (mode === 'expired') h.at(START + 60000);
    else h.policy.gate = () => ({ state: 'disabled', code: 'MAILAPP_DISABLED' });
    paused.resolve(); const result = await work;
    assert.equal(result.code, mode === 'expired' ? 'MAILAPP_BINDING_EXPIRED' : 'MAILAPP_DISABLED');
    assert.equal(result.attemptCount, 1); assert.equal(h.sends().length, 0); assert.equal(h.entries.has(h.claimKey), true);
    h.policy.beforeDispatch = undefined; await h.send(); assert.equal(h.sends().length, 0);
  }
});

test('receipt persistence uncertainty cannot permit a resend; local read failure never claims durable uncertainty', async () => {
  const h = harness(), set = h.store.set; let rejectReceipt = true;
  h.store.set = async (...args) => { if (rejectReceipt && args[0].startsWith('mailapp/receipts/')) throw new Error('receipt failure'); return set(...args); };
  const failed = await h.send(); assert.equal(failed.code, 'RESULT_STORAGE_UNCONFIRMED'); assert.equal(failed.durableAttempt, undefined); assert.equal(h.sends().length, 1);
  rejectReceipt = false; h.provider(async () => h.result('submitted'));
  assert.equal((await h.send()).state, 'submitted'); assert.equal(h.sends().length, 1);
  h.store.getWithMetadata = async () => { throw new Error('unreadable'); };
  assert.equal((await h.read()).durableAttempt, undefined); const result = await h.send();
  assert.equal(result.state, 'unknown'); assert.equal(result.durableAttempt, undefined); assert.equal(h.sends().length, 1);
});

test('a proven no-call Send receipt permits only a newly claimed retry after expiry and fresh readiness', async () => {
  const h = harness(); h.provider(async (_, options) => h.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  const first = await h.send(); assert.equal(first.state, 'rejected'); assert.equal(first.googleResult.retrySafe, true); assert.equal(first.retryAllowed, false);
  const original = clone(h.entries.get(h.claimKey).data), receipt = clone(first.receipts[0]);
  h.at(START + 59999); await h.send(); assert.equal(h.sends().length, 1);
  h.at(START + 60000); assert.equal((await h.read()).retryAllowed, true);
  h.provider(async (_, options) => h.result(options.action === 'attendanceMailSend' ? 'submitted' : 'not-attempted'));
  const result = await h.send(); assert.equal(result.state, 'submitted'); assert.equal(h.sends().length, 2);
  assert.deepEqual(h.entries.get(h.claimKey).data.bindings[0], original.bindings[0]); assert.deepEqual(result.receipts[0], receipt);
  assert.notEqual(h.sends()[0].options.binding.requestId, h.sends()[1].options.binding.requestId);
  assert.equal(result.attemptCount, 2); assert.equal(result.attemptedAt, START); assert.equal(result.lastAttemptAt, START + 60000);
  assert.equal(result.retryBefore, START + 23 * 60 * 60 * 1000); assert.equal(result.retryAllowed, false);
});

test('a new Send failure wins an equally timed readiness receipt while attempted status remains authoritative', async () => {
  const h = harness(); h.provider(async (_, options) => h.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  await h.send(); h.at(START + 60000);
  const retry = await h.send(); assert.equal(retry.state, 'rejected'); assert.equal(retry.code, 'MAILAPP_QUOTA_UNAVAILABLE');
  assert.equal(retry.googleResult.code, 'MAILAPP_QUOTA_UNAVAILABLE'); assert.equal(h.sends().length, 2);
  h.at(START + 120000); h.provider(async () => h.result('unknown'));
  const conflict = await h.send(); assert.equal(conflict.code, 'CONFLICTING_MAILAPP_RECEIPTS');
  h.provider(async () => h.result());
  assert.equal((await h.send()).code, 'CONFLICTING_MAILAPP_RECEIPTS'); assert.equal(h.sends().length, 2);
});

test('proven no-call retries remain bounded by six claims, original23h, exact CAS and consistent evidence', async () => {
  const h = harness(); h.provider(async (_, options) => h.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  for (let n = 0; n < 6; n++) { h.at(START + n * 60000); assert.equal((await h.send()).attemptCount, n + 1); }
  h.at(START + 6 * 60000); assert.equal((await h.send()).retryAllowed, false); assert.equal(h.sends().length, 6);
  const expired = harness(); expired.provider(async (_, options) => expired.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  await expired.send(); expired.at(START + 23 * 60 * 60 * 1000);
  assert.equal((await expired.send()).retryAllowed, false); assert.equal(expired.sends().length, 1);
  const concurrent = harness(); concurrent.provider(async (_, options) => concurrent.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  await concurrent.send(); concurrent.at(START + 60000);
  const ready = deferred(), entered = deferred(); let statuses = 0;
  concurrent.provider(async (_, options) => { if (options.action === 'attendanceMailStatus') { if (++statuses === 2) entered.resolve(); await ready.promise; return concurrent.result(); } return concurrent.result('submitted'); });
  const a = concurrent.send(), b = concurrent.send(); await entered.promise; ready.resolve(); await Promise.all([a, b]);
  assert.equal(concurrent.sends().length, 2); assert.equal(concurrent.entries.get(concurrent.claimKey).data.bindings.length, 2);
  const conflict = harness(); conflict.provider(async (_, options) => conflict.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  await conflict.send(); conflict.at(START + 60000); conflict.provider(async () => conflict.result('unknown'));
  assert.equal((await conflict.send()).code, 'CONFLICTING_MAILAPP_RECEIPTS');
  conflict.provider(async () => conflict.result()); assert.equal((await conflict.send()).state, 'blocked'); assert.equal(conflict.sends().length, 1);
});

test('an unknown send or missing exact Send receipt never becomes retryable merely because status reports ready', async () => {
  for (const kind of ['unknown', 'missing']) {
    const h = harness(); h.provider(async (_, options) => { if (options.action === 'attendanceMailSend') throw new Error('unknown'); return h.result(); });
    await h.send();
    if (kind === 'missing') {
      const firstId = h.entries.get(h.claimKey).data.bindings[0].requestId;
      h.entries.delete('mailapp/receipts/' + h.message.messageId + '/' + firstId);
    }
    h.at(START + 60000); h.provider(async () => h.result());
    const result = await h.send(); assert.equal(result.state, 'unknown'); assert.equal(result.retryAllowed, false); assert.equal(h.sends().length, 1);
  }
});

test('an ambiguous retry-claim write preserves the original no-call receipt and forbids later redispatch', async () => {
  const h = harness(); h.provider(async (_, options) => h.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  const first = await h.send(), firstReceipt = clone(first.receipts[0]); h.at(START + 60000);
  const set = h.store.set; let fail = true;
  h.store.set = async (...args) => { const result = await set(...args); if (fail && args[0] === h.claimKey) throw new Error('write reply lost'); return result; };
  assert.equal((await h.send()).code, 'PENDING_STORAGE_UNCONFIRMED'); assert.equal(h.sends().length, 1);
  fail = false; h.at(START + 120000); const recovered = await h.send();
  assert.equal(recovered.state, 'unknown'); assert.equal(recovered.attemptCount, 2); assert.equal(recovered.retryAllowed, false);
  assert.deepEqual(recovered.receipts[0], firstReceipt); assert.equal(h.sends().length, 1);
});

test('a paused safe retry still cannot cross the original23-hour window even with an unexpired new binding', async () => {
  const h = harness(); h.provider(async (_, options) => h.result('not-attempted', options.action === 'attendanceMailSend' ? 'MAILAPP_QUOTA_UNAVAILABLE' : 'MAILAPP_READY'));
  await h.send(); h.at(START + 23 * 60 * 60 * 1000 - 30000);
  const paused = deferred(), entered = deferred(); let checks = 0;
  h.policy.beforeDispatch = async () => { if (++checks === 2) { entered.resolve(); await paused.promise; } };
  const work = h.send(); await entered.promise;
  h.at(START + 23 * 60 * 60 * 1000); paused.resolve();
  const result = await work; assert.equal(result.code, 'MAILAPP_BINDING_EXPIRED'); assert.equal(result.attemptCount, 2);
  assert.equal(h.sends().length, 1); assert.equal(h.entries.get(h.claimKey).data.bindings.length, 2);
  h.policy.beforeDispatch = undefined; assert.equal((await h.send()).retryAllowed, false); assert.equal(h.sends().length, 1);
});

test('existing Google attempts are retained locally during preflight without ever dispatching', async () => {
  for (const state of ['unknown', 'submitted']) {
    const h = harness(); h.provider(async () => h.result(state));
    const result = await h.send(); assert.equal(result.state, state); assert.equal(result.durableAttempt, true); assert.equal(result.attemptCount, 1);
    assert.equal(h.entries.has(h.claimKey), true); assert.equal(h.sends().length, 0);
    h.provider(async () => h.result()); await h.send(); assert.equal(h.sends().length, 0);
  }
});

test('legacy provider records, altered same-day bodies, malformed replies and corrupt receipt heads fail closed', async () => {
  const legacy = harness(); legacy.entries.set('messages/' + legacy.message.messageId, { etag: 'legacy', data: { hash: 'different', attempts: [] } });
  assert.equal((await legacy.send()).code, 'MAILAPP_LEGACY_PROVIDER_RECORD'); assert.equal(legacy.calls.length, 0);
  const h = harness(); await h.send(); const changed = { ...h.message, text: 'Different day body' }; changed.hash = digestHash(canonical(changed));
  assert.equal((await h.send(changed)).code, 'RETAINED_MESSAGE_MISMATCH'); assert.equal(h.sends().length, 1);
  for (const change of [{ target: 'production' }, { gym: 'richmond' }, { hash: '0'.repeat(64) }, { extra: 'private' }, { code: 'arbitrary private detail' }, { retrySafe: false }, { state: 'submitted' }]) {
    const broken = harness(); broken.provider(async () => ({ ...broken.result(), ...change }));
    assert.equal((await broken.send()).code, 'MAILAPP_RESPONSE_INVALID'); assert.equal(broken.sends().length, 0); assert.equal(broken.entries.size, 0);
  }
  h.entries.set('mailapp/status/' + h.message.messageId, { etag: 'bad', data: { requestId: uuid(90) } });
  const bad = await h.read(); assert.equal(bad.code, 'RETAINED_RECEIPT_INVALID'); assert.equal(bad.durableAttempt, undefined);
});

test('overlapping late status cannot downgrade a previously confirmed submission', async () => {
  const h = harness(); h.provider(async (_, options) => { if (options.action === 'attendanceMailSend') throw new Error('lost'); return h.result(); });
  await h.send(); const first = deferred(), second = deferred(), entered = deferred(); let count = 0;
  h.provider(async () => { const promise = ++count === 1 ? first.promise : second.promise; if (count === 2) entered.resolve(); return promise; });
  const old = h.send(), fresh = h.send(); await entered.promise;
  second.resolve(h.result('submitted')); assert.equal((await fresh).state, 'submitted');
  first.resolve(h.result('unknown')); assert.equal((await old).state, 'submitted'); assert.equal((await h.read()).state, 'submitted');
  assert.equal(h.sends().length, 1);
});

test('the unchanged25-second bound leaves an irreversible unknown claim after transport timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), never = deferred();
  h.provider(async (_, options) => options.action === 'attendanceMailSend' ? never.promise : h.result());
  const work = h.send(); await flush(); assert.equal(h.sends().length, 1);
  t.mock.timers.tick(25000); const result = await work;
  assert.equal(result.code, 'MAILAPP_TIMEOUT'); assert.equal(result.state, 'unknown'); assert.equal(result.durableAttempt, true);
  assert.equal(h.sends()[0].signal.aborted, true); assert.equal(result.retryAllowed, false);
  h.provider(async () => h.result('unknown')); await h.send(); assert.equal(h.sends().length, 1);
});
