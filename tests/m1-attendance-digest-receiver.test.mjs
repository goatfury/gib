import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { authenticateDigestJob, digestSignature } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { buildAttendanceDigest, defaultDigestConfiguration } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';

const source = readFileSync(new URL('../integrations/google-apps-script/GibM1AttendanceDigest.gs', import.meta.url), 'utf8');
const receiverSource = readFileSync(new URL('../integrations/google-apps-script/GibM1Receiver.gs', import.meta.url), 'utf8');
const adminAuthorizationSource = receiverSource.match(/^function adminActionAuthorized_\(body\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(adminAuthorizationSource, 'existing receiver authorization must be exercised');
const now = Date.parse('2026-09-25T02:30:00Z'), date = '2026-09-24';
const id = '00000000-0000-4000-8000-000000000001';
const secret = 'synthetic-digest-admin-secret';
const transportSecret = 'synthetic-digest-transport-secret';
const endpoint = 'https://deploy-preview-89--gib-live.netlify.app/api/m1-attendance-digest-job';
const schema = 'm1-attendance-digest-job/v1';
const plain = value => JSON.parse(JSON.stringify(value));
const localDate = stamp => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(stamp);
const binding = (patch = {}) => ({ schema, target: 'test', requestId: id, mode: 'manual', jobDate: date, createdAt: now, expiresAt: now + 60000, ...patch });
const ledger = (to = date) => ({ ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true, gym: 'rev', from: '2026-09-07', to,
  days: datesThrough(to).map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) });

function harness(options = {}) {
  let stamp = now, serial = 10, lockHeld = false;
  const properties = new Map(), events = [], requests = [], logs = [];
  const settings = { ...options };
  const pendingWrites = new Set();
  function assertPersisted() {
    const entry = [...properties.entries()].find(([key]) => key.startsWith('M1_TEST_DIGEST_PENDING_'));
    assert.ok(entry, 'pending request must be durable before reads or dispatch');
    assert.ok(events.some(event => event.kind === 'confirmed' && event.key === entry[0]), 'pending readback precedes reads');
  }
  const store = {
    getKeys: () => [...properties.keys()],
    getProperty(key) {
      if (pendingWrites.has(key)) {
        events.push({ kind: 'confirmed', key });
        if (settings.failPendingReadback) return 'unconfirmed';
      }
      return properties.get(key) ?? null;
    },
    setProperty(key, value) {
      if (key.startsWith('M1_TEST_DIGEST_PENDING_')) {
        if (settings.failPendingWrite) throw new Error('synthetic private storage error');
        pendingWrites.add(key);
      }
      if (key.startsWith('M1_TEST_DIGEST_RECEIPT_') && settings.failReceiptWrite) throw new Error('synthetic private receipt error');
      events.push({ kind: 'persist', key }); properties.set(key, value);
    },
    deleteProperty(key) { events.push({ kind: 'delete', key }); properties.delete(key); }
  };
  const lock = {
    tryLock(timeout) {
      assert.equal(timeout, 10000);
      assert.equal(lockHeld, false, 'no nested or overlapping shared locks');
      if (settings.staffLockUnavailable && events.some(event => event.kind === 'attendance')) return false;
      lockHeld = true; events.push({ kind: 'lock' }); return true;
    },
    releaseLock() { assert.equal(lockHeld, true); lockHeld = false; events.push({ kind: 'release' }); }
  };
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [stamp])); } static now() { return stamp; } },
    console: { log: value => logs.push(value) },
    EXPECTED_SPREADSHEET_NAME: settings.spreadsheetName || 'RBJJ M1 — TEST',
    GIB_M1_ADMIN_NAMES_: ['Andrew Smith', 'Stuart Turner'],
    PropertiesService: { getScriptProperties: () => store },
    LockService: { getScriptLock: () => lock },
    Utilities: {
      getUuid: () => '00000000-0000-4000-8000-' + String(++serial).padStart(12, '0'),
      formatDate(value, timezone, pattern) { assert.equal(timezone, 'America/New_York'); assert.equal(pattern, 'yyyy-MM-dd'); return localDate(value); },
      newBlob: value => ({ getBytes: () => [...Buffer.from(value, 'utf8')] }),
      computeHmacSha256Signature(value, key) { return [...createHmac('sha256', key).update(value).digest()].map(byte => byte > 127 ? byte - 256 : byte); }
    },
    gibM1TestReadCallbackEnabled_: () => settings.enabled !== false,
    configuredReceiverSecret_: () => transportSecret,
    configuredAdminActionSecret_: () => secret,
    GIB_M1_LEGACY_KIOSK_PROPERTY_: 'synthetic-legacy-property', GIB_M1_RECOVERY_PROPERTY_: 'synthetic-recovery-property',
    cleanText_: value => typeof value === 'string' ? value.trim() : '',
    deploymentTargetAllowed_: target => target === 'test',
    scriptProperty_: () => '',
    configuredSecretsArePairwiseDistinct_: values => { const configured = values.filter(Boolean); return new Set(configured).size === configured.length; },
    constantTimeTextEqual_: (one, two) => one === two,
    jsonResult_: value => ({ getContent: () => JSON.stringify(value) }),
    managerReviewAction_(body) {
      assertPersisted();
      assert.equal(body.action, 'managerReviewRead'); assert.equal(body.target, 'test'); assert.equal(body.gym, 'rev');
      assert.equal(body.token, transportSecret); assert.equal(body.adminActionToken, secret); assert.equal(body.check, null);
      assert.equal(body.from, '2026-09-07');
      assert.equal(lock.tryLock(10000), true);
      events.push({ kind: 'attendance' });
      try {
        if (settings.attendanceThrows) throw new Error('synthetic private attendance contents');
        if (settings.readElapsed) stamp += settings.readElapsed;
        return { getContent: () => settings.attendanceRaw ?? JSON.stringify(settings.ledger ?? ledger(body.to)) };
      } finally { lock.releaseLock(); }
    },
    openExpectedSpreadsheet_(body) { assert.equal(lockHeld, true); assert.equal(body.target, 'test'); return { syntheticSpreadsheet: true }; },
    staffRecoveryOutstanding_(book) {
      assertPersisted(); assert.equal(lockHeld, true); assert.equal(book.syntheticSpreadsheet, true);
      events.push({ kind: 'staff' });
      if (settings.staffThrows) throw new Error('synthetic private staff contents');
      return settings.staff ?? { ok: true, complete: true, items: [] };
    },
    UrlFetchApp: { fetch(url, init) {
      assertPersisted(); assert.equal(lockHeld, false, 'all authoritative read locks are released before network dispatch');
      assert.equal(url, endpoint); assert.equal(init.method, 'post'); assert.equal(init.contentType, 'application/json');
      assert.equal(init.followRedirects, false); assert.equal(init.muteHttpExceptions, true);
      const body = JSON.parse(init.payload); requests.push({ url, init: plain(init), body }); events.push({ kind: 'dispatch' });
      if (settings.deliveryThrows) throw new Error('synthetic private response URL or body');
      const response = settings.response ?? { ok: true, accepted: true, requestId: body.requestId, state: 'captured',
        messageId: body.mode === 'scheduled' ? 'm1-test-daily-' + body.jobDate : 'm1-test-manual-' + body.requestId };
      return { getResponseCode: () => settings.httpStatus ?? 200, getContentText: () => typeof response === 'string' ? response : JSON.stringify(response) };
    } }
  });
  vm.runInContext(adminAuthorizationSource + '\n' + source, context);
  return { context, settings, properties, events, requests, logs, store,
    advance: ms => { stamp += ms; }, stamp: () => stamp,
    receipts: () => [...properties.entries()].filter(([key]) => key.startsWith('M1_TEST_DIGEST_RECEIPT_')).map(([key, raw]) => ({ key, value: JSON.parse(raw) })),
    manual(patch = {}) { return JSON.parse(context.gibM1AttendanceDigestCapture_({ target: 'test', token: transportSecret, adminActionToken: secret, adminName: 'Andrew Smith', binding: binding(), ...patch }).getContent()); }
  };
}

test('manual capture is restricted to the separate Revolution TEST project and existing authenticated Admin names', () => {
  for (const options of [{ enabled: false }, { spreadsheetName: 'RBJJ M1' }, { spreadsheetName: 'Richmond M1 — TEST' }]) {
    const h = harness(options);
    assert.equal(h.manual().code, 'DIGEST_AUTHENTICATION_REQUIRED');
    assert.doesNotThrow(() => h.context.testRevolutionAttendanceDigestTick());
    assert.deepEqual(h.logs, ['M1_TEST_DIGEST_DISABLED']);
    assert.equal(h.events.length, 0); assert.equal(h.requests.length, 0);
  }
  for (const patch of [{ target: 'production' }, { target: undefined }, { token: 'wrong' }, { adminActionToken: 'wrong' }, { adminName: 'Unapproved Reviewer' }]) {
    const h = harness(); assert.equal(h.manual(patch).code, 'DIGEST_AUTHENTICATION_REQUIRED'); assert.equal(h.events.length, 0);
  }
  const h = harness(); assert.equal(h.manual({ adminName: 'Stuart Turner' }).ok, true);
});

test('exact binding, manual mode, gym-local date and expiry are checked before any reads or dispatch', () => {
  const invalid = [{ target: 'production' }, { mode: 'scheduled' }, { mode: 'other' }, { schema: schema + '-other' },
    { requestId: 'not-a-uuid' }, { createdAt: now + 1, expiresAt: now + 60001 }, { expiresAt: now + 60001 },
    { createdAt: now - 60000, expiresAt: now }, { jobDate: '2026-09-25' }, { gym: 'richmond' }];
  for (const patch of invalid) {
    const h = harness(); assert.equal(h.manual({ binding: binding(patch) }).code, 'DIGEST_CAPTURE_UNAVAILABLE', JSON.stringify(patch));
    assert.equal(h.events.length, 0); assert.equal(h.requests.length, 0);
  }
  const h = harness(); assert.throws(() => h.context.gibM1DigestDispatch_(binding({ mode: 'other' })), /DIGEST_BINDING_INVALID/);
});

test('pending binding must be persisted and read back exactly before the first authoritative read', () => {
  for (const fault of ['failPendingWrite', 'failPendingReadback']) {
    const h = harness({ [fault]: true }); assert.equal(h.manual().ok, false);
    assert.equal(h.events.some(event => ['attendance', 'staff', 'dispatch'].includes(event.kind)), false, fault);
  }
  const conflict = harness(), key = 'M1_TEST_DIGEST_PENDING_' + (now + 60000 + 3600000) + '_' + id;
  conflict.properties.set(key, JSON.stringify(binding({ mode: 'scheduled' })));
  assert.equal(conflict.manual().ok, false); assert.equal(conflict.events.length, 0);
  const h = harness(); assert.equal(h.manual().ok, true);
  const persisted = [...h.properties.entries()].find(([key]) => key.startsWith('M1_TEST_DIGEST_PENDING_'));
  assert.deepEqual(JSON.parse(persisted[1]), binding());
  assert.ok(h.events.findIndex(e => e.kind === 'confirmed') < h.events.findIndex(e => e.kind === 'attendance'));
});

test('both independent read locks release before the single synchronous fixed-destination callback, including read exceptions', () => {
  for (const options of [{}, { attendanceThrows: true }, { staffThrows: true }, { staffLockUnavailable: true }]) {
    const h = harness(options); assert.equal(h.manual().ok, true); assert.equal(h.requests.length, 1);
    assert.equal(h.events.filter(e => e.kind === 'lock').length, h.events.filter(e => e.kind === 'release').length);
    assert.ok(h.events.findLastIndex(e => e.kind === 'release') < h.events.findIndex(e => e.kind === 'dispatch'));
  }
  assert.doesNotMatch(source, /\b(?:ScriptApp|MailApp|GmailApp)\s*\.|\bsendEmail\s*\(|\bsetTimeout\s*\(|\bPromise\b/);
});

test('Google signature uses exact purpose and raw body; Netlify accepts it and rejects cross-purpose, changed-body and live replay', () => {
  const h = harness(); assert.equal(h.manual().ok, true);
  const request = h.requests[0], raw = request.init.payload, signature = request.init.headers['X-GIB-M1-Digest-Signature'];
  assert.equal(signature, digestSignature(raw, secret));
  assert.deepEqual(authenticateDigestJob(raw, signature, { target: 'test', adminActionToken: secret }, now).binding, binding());
  const wrongPurpose = createHmac('sha256', secret).update('m1-other-purpose/v1\n' + raw).digest('hex');
  for (const [body, signatureValue, target] of [[raw, wrongPurpose, 'test'], [raw + ' ', signature, 'test'], [raw, signature, 'production']]) {
    assert.throws(() => authenticateDigestJob(body, signatureValue, { target, adminActionToken: secret }, now),
      target === 'production' ? /DIGEST_RUNTIME_UNAVAILABLE/ : /DIGEST_AUTHENTICATION_FAILED/);
  }
  assert.throws(() => authenticateDigestJob(raw, signature, { target: 'test', adminActionToken: secret }, now + 60000), /DIGEST_REQUEST_EXPIRED/);
  assert.equal(request.body.gyms.length, 1); assert.equal(request.body.gyms[0].gym, 'rev');
  assert.equal('adminName' in request.body, false, 'scheduled capture cannot invent a reviewer identity');
});

test('failed and incomplete reads are captured as separate failures, never as presumed missing attendance or all clear', () => {
  for (const [options, component] of [[{ attendanceThrows: true }, 'attendance'], [{ ledger: { ok: false } }, 'attendance'],
    [{ ledger: { ...ledger(), complete: false } }, 'attendance'], [{ attendanceRaw: 'incomplete JSON' }, 'attendance'],
    [{ staffThrows: true }, 'staff'], [{ staffLockUnavailable: true }, 'staff'], [{ staff: { ok: true, complete: false, items: [] } }, 'staff']]) {
    const h = harness(options); assert.equal(h.manual().ok, true);
    const result = buildAttendanceDigest({ jobDate: date, snapshots: h.requests[0].body.gyms,
      configuration: defaultDigestConfiguration({ target: 'test', profile: { installationId: 'rev', gymName: 'Revolution BJJ' } }, { GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true' }), now,
      schedules: [{ gym: 'rev', timezone: 'America/New_York', days: datesThrough(date).map(date => ({ date, status: 'complete', observedAt: date + 'T12:00:00.000Z', sourceVersion: 'synthetic-confirmed', occurrences: [] })) }] });
    assert.equal(result.shouldCapture, true); assert.equal(result.itemCount, 0);
    assert.equal(result.readFailures.length, 1); assert.equal(result.readFailures[0].component, component);
    assert.equal(JSON.stringify(h.receipts()).includes('synthetic private'), false);
  }
});

test('only the exact matching successful acknowledgment and message ID count; failed capture is recorded explicitly', () => {
  const valid = { ok: true, accepted: true, requestId: id, state: 'captured', messageId: 'm1-test-manual-' + id };
  for (const [patch, status] of [[{ ok: false }, 200], [{ accepted: false }, 200], [{ requestId: 'different' }, 200],
    [{ state: 'unknown' }, 200], [{ messageId: 'different' }, 200], [{ messageId: null }, 200],
    [{ state: 'not-due' }, 200], [{ state: 'awaiting-configuration' }, 200], [{}, 302], [{}, 503]]) {
    const h = harness({ response: { ...valid, ...patch }, httpStatus: status });
    assert.equal(h.manual().ok, false); const receipt = h.receipts()[0].value;
    assert.equal(receipt.acknowledged, false); assert.equal(receipt.status, status); assert.equal(receipt.state, null);
  }
  for (const state of ['captured', 'suppressed', 'not-due', 'awaiting-configuration', 'failed']) {
    const h = harness({ response: { ...valid, state, messageId: ['not-due', 'awaiting-configuration'].includes(state) ? null : valid.messageId } }); const result = h.manual();
    assert.equal(result.ok, true); assert.equal(result.code, state === 'failed' ? 'CAPTURE_FAILED' : 'ACKNOWLEDGED');
    assert.equal(h.receipts()[0].value.state, state);
  }
  const scheduled = harness({ response: { ...valid, state: 'captured', messageId: 'm1-test-daily-' + date } });
  assert.equal(scheduled.context.gibM1DigestDispatch_(binding({ mode: 'scheduled' })).ok, true);
  const wrongMode = harness({ response: valid });
  assert.equal(wrongMode.context.gibM1DigestDispatch_(binding({ mode: 'scheduled' })).ok, false);
  const nonJSON = harness({ httpStatus: 503, response: 'synthetic private upstream error page' });
  assert.equal(nonJSON.manual().ok, false); assert.equal(nonJSON.receipts()[0].value.status, 503);
  assert.equal(nonJSON.receipts()[0].value.responseCode, 'RESPONSE_NOT_JSON');
  assert.equal(JSON.stringify(nonJSON.receipts()).includes('private'), false);
});

test('one failed callback leaves an independent sanitized receipt that later success cannot erase', () => {
  const h = harness({ deliveryThrows: true }); assert.equal(h.manual().ok, false);
  const original = h.receipts()[0]; h.settings.deliveryThrows = false; h.advance(1);
  assert.equal(h.manual().ok, true); assert.equal(h.receipts().length, 2);
  assert.deepEqual(h.receipts().find(entry => entry.key === original.key), original);
  for (const { key, value } of h.receipts()) {
    assert.deepEqual(Object.keys(value).sort(), ['acknowledged', 'code', 'elapsedMs', 'mode', 'requestId', 'responseCode', 'state', 'status']);
    assert.ok([now + 86400000, now + 86400001].includes(Number(key.match(/_(\d{13})_/)[1])));
    assert.equal(JSON.stringify(value).includes(secret), false); assert.equal(JSON.stringify(value).includes('private'), false);
  }
  const receiptFailure = harness({ failReceiptWrite: true });
  assert.equal(receiptFailure.manual().ok, true, 'diagnostic storage failure cannot invalidate confirmed capture');
  assert.deepEqual(receiptFailure.logs, ['M1_TEST_DIGEST_RECEIPT_UNAVAILABLE']);
  h.advance(86400000 - 1); h.context.gibM1DigestCleanup_(h.store, h.stamp());
  assert.equal(h.receipts().length, 1, 'first receipt expires exactly after 24 hours without deleting later receipt');
  h.advance(1); h.context.gibM1DigestCleanup_(h.store, h.stamp()); assert.equal(h.receipts().length, 0);
});

test('non-success callback receipts distinguish fixed scope, runtime and authentication rejections without retaining response contents', () => {
  for (const [responseCode, httpStatus] of [['DIGEST_SCOPE_REQUIRED', 403], ['DIGEST_RUNTIME_UNAVAILABLE', 503],
    ['DIGEST_AUTHENTICATION_FAILED', 403], ['DIGEST_BINDING_MISMATCH', 409], ['DIGEST_REQUEST_EXPIRED', 410],
    ['DIGEST_STORAGE_UNCONFIRMED', 503]]) {
    const h = harness({ httpStatus, response: { ok: false, code: responseCode, message: 'synthetic private response contents',
      token: secret, signedUrl: 'https://example.invalid/private-token' } });
    assert.equal(h.manual().ok, false); const failure = h.receipts()[0];
    assert.equal(failure.value.status, httpStatus); assert.equal(failure.value.responseCode, responseCode);
    assert.equal(failure.value.acknowledged, false); assert.equal(failure.value.requestId, id);
    assert.equal(failure.value.code, 'DELIVERY_HTTP_FAILURE');
    h.settings.httpStatus = 200; delete h.settings.response;
    assert.equal(h.manual().ok, true); assert.deepEqual(h.receipts().find(entry => entry.key === failure.key), failure);
    assert.equal(h.receipts().at(-1).value.responseCode, null);
    assert.doesNotMatch(JSON.stringify(h.receipts()) + JSON.stringify(h.logs), /private|synthetic-digest-admin-secret|example\.invalid/);
  }
});

test('unknown callback error codes are redacted, including direct receipt calls; malformed acknowledgments stay unconfirmed', () => {
  for (const code of [undefined, 'SECRET_PRIVATE_RESPONSE', { secret }, ['DIGEST_AUTHENTICATION_FAILED']]) {
    const h = harness({ httpStatus: 403, response: { ok: false, code, message: 'synthetic private detail' } });
    assert.equal(h.manual().ok, false); assert.equal(h.receipts()[0].value.responseCode, 'RESPONSE_CODE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(h.receipts()), /SECRET|private|synthetic-digest-admin-secret/);
  }
  const h = harness();
  h.context.gibM1DigestReceipt_(h.store, binding(), now, 'DELIVERY_HTTP_FAILURE', 403, false, null, secret);
  assert.equal(h.receipts()[0].value.responseCode, 'RESPONSE_CODE_UNAVAILABLE');
  h.settings.response = { ok: true, accepted: true, requestId: 'different', state: 'captured', messageId: 'm1-test-manual-' + id,
    code: 'DIGEST_AUTHENTICATION_FAILED' };
  assert.equal(h.manual().ok, false); assert.equal(h.receipts().at(-1).value.acknowledged, false);
});

test('expired and oversized UTF-8 results do not dispatch, and retain a bounded failure receipt', () => {
  const expired = harness({ readElapsed: 60000 });
  assert.equal(expired.manual().code, 'REQUEST_EXPIRED'); assert.equal(expired.requests.length, 0);
  const oversized = harness({ ledger: { ...ledger(), syntheticPadding: '界'.repeat(140000) } });
  assert.equal(oversized.manual().code, 'PAYLOAD_TOO_LARGE'); assert.equal(oversized.requests.length, 0);
  assert.equal(oversized.receipts()[0].value.code, 'PAYLOAD_TOO_LARGE');
});

test('bounded cleanup expires only digest temporary keys, preserves unexpired requests and failure receipts, and supports 96 daily ticks', () => {
  const h = harness(), uuid = value => '00000000-0000-4000-8000-' + String(value).padStart(12, '0');
  for (let index = 0; index < 40; index++) h.properties.set('M1_TEST_DIGEST_PENDING_' + (now - 1) + '_' + uuid(index), '{}');
  const live = 'M1_TEST_DIGEST_PENDING_' + (now + 3600000) + '_' + id;
  const receipt = 'M1_TEST_DIGEST_RECEIPT_' + (now + 86400000) + '_' + id;
  h.properties.set(live, 'original request'); h.properties.set(receipt, 'prior failure'); h.properties.set('other-feature-key', 'preserve');
  h.context.gibM1DigestCleanup_(h.store, now);
  assert.equal(h.events.filter(e => e.kind === 'delete').length, 32);
  assert.equal(h.properties.get(live), 'original request'); assert.equal(h.properties.get(receipt), 'prior failure'); assert.equal(h.properties.get('other-feature-key'), 'preserve');
  const day = harness(); let maxProperties = 0;
  for (let index = 0; index < 96; index++) {
    day.context.testRevolutionAttendanceDigestTick(); maxProperties = Math.max(maxProperties, day.properties.size); day.advance(15 * 60000);
  }
  assert.equal(day.requests.length, 96); assert.equal(day.receipts().length, 96); assert.ok(maxProperties < 160);
  assert.equal(new Set(day.requests.map(request => request.body.requestId)).size, 96);
  assert.equal(day.requests.every(request => request.body.mode === 'scheduled' && !('adminName' in request.body)), true);
  const full = harness(); for (let index = 0; index < 160; index++) full.properties.set('M1_TEST_DIGEST_RECEIPT_' + (now + 86400000) + '_' + uuid(index), '{}');
  assert.equal(full.manual().ok, false); assert.equal(full.requests.length, 0); assert.equal(full.events.length, 0);
});

test('scheduled storage failure is recorded without throwing into Google failure emails and a later tick can recover', () => {
  for (const fault of ['failPendingWrite', 'failPendingReadback']) {
    const h = harness({ [fault]: true });
    assert.doesNotThrow(() => h.context.testRevolutionAttendanceDigestTick());
    assert.equal(h.requests.length, 0); const failure = h.receipts()[0];
    assert.equal(failure.value.code, 'DIGEST_JOB_UNAVAILABLE'); assert.equal(failure.value.acknowledged, false);
    assert.equal(failure.value.mode, 'scheduled'); assert.equal(failure.value.status, null);
    assert.equal(JSON.stringify(h.logs).includes('private'), false); assert.match(h.logs.at(-1), /DIGEST_JOB_UNAVAILABLE/);
    h.settings[fault] = false; h.advance(15 * 60000);
    assert.doesNotThrow(() => h.context.testRevolutionAttendanceDigestTick());
    assert.equal(h.requests.length, 1); assert.equal(h.receipts().length, 2);
    assert.deepEqual(h.receipts().find(entry => entry.key === failure.key), failure);
  }
});
