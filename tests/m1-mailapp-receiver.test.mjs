import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../integrations/google-apps-script/GibM1MailApp.gs', import.meta.url), 'utf8');
const receiver = readFileSync(new URL('../integrations/google-apps-script/GibM1Receiver.gs', import.meta.url), 'utf8');
const authorization = receiver.match(/^function adminActionAuthorized_\(body\) \{[\s\S]*?^\}/m)[0];
const SENDER = 'revbjjops@gmail.com', ID = '00000000-0000-4000-8000-000000000001';
const START = Date.parse('2026-09-28T01:00:00Z'), READY = 'GIB_M1_MAILAPP_TEST_LEDGER_READY';
const SEND = 'GIB_M1_MAILAPP_TEST_SEND_ENABLED', RECIPIENTS = 'GIB_M1_MAILAPP_TEST_RECIPIENTS_JSON';
const plain = value => JSON.parse(JSON.stringify(value));
function message(change = {}) {
  const value = { messageId: 'm1-test-scheduled-rev-2026-09-27', from: SENDER, to: ['qa@example.com'], cc: [],
    subject: 'Synthetic TEST attendance reminder', html: '<p>Synthetic café — second instructor needs review.</p>',
    text: 'Synthetic café — second instructor needs review.', synthetic: true, target: 'test', ...change };
  return { ...value, hash: createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex') };
}
function harness(options = {}) {
  let stamp = START, held = false, currentStage = null;
  const settings = { ...options }, events = [], calls = [], reads = [], logs = [], properties = new Map();
  if (settings.ready !== false) properties.set(READY, 'v1');
  if (settings.enabled !== false) properties.set(SEND, 'true');
  properties.set(RECIPIENTS, JSON.stringify({ to: ['qa@example.com'], cc: [] }));
  const propertyStore = { getProperty: key => properties.get(key) ?? null,
    setProperty(key, value) { if (settings.propertyWriteFails) throw new Error('private property error'); properties.set(key, value); events.push(['property', key]); } };
  const sheet = { rows: [], getLastRow() { return this.rows.length; }, getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); },
    getRange(row, col, count, width) {
      assert.ok(Number.isInteger(row) && row >= 1 && count >= 1 && width >= 1);
      const range = {
        getRow: () => row,
        setNumberFormat(format) { assert.equal(format, '@'); return range; },
        getValues() {
          reads.push({ row, col, count, width });
          if (count === 1 && row > 1 && sheet.rows[row - 1]?.[1] === 'attempt' && settings.markerReadbackFails) {
            settings.markerReadbackFails = false; throw new Error('private marker read error');
          }
          if (count === 1 && row > 1 && ['submitted', 'exception'].includes(sheet.rows[row - 1]?.[1]) && settings.resultReadbackFails) {
            settings.resultReadbackFails = false; throw new Error('private result read error');
          }
          return Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, column) => sheet.rows[row + offset - 1]?.[col + column - 1] ?? ''));
        },
        setValues(values) {
          assert.equal(values.length, count); assert.equal(count, 1); assert.equal(width, 10); assert.equal(col, 1);
          currentStage = values[0][1]; const kind = currentStage === 'attempt' ? 'marker' : ['submitted', 'exception'].includes(currentStage) ? 'result' : 'header';
          events.push(['write', kind]);
          if (settings[kind + 'Write'] === 'throw-before') throw new Error('private write error');
          if (settings[kind + 'Write'] !== 'drop') sheet.rows[row - 1] = plain(values[0]);
          if (settings[kind + 'Write'] === 'partial') sheet.rows[row - 1][2] = '';
          if (settings[kind + 'Write'] === 'throw-after') throw new Error('private write acknowledgment lost');
          return range;
        },
        createTextFinder(search) {
          assert.equal(col, 1); assert.equal(width, 1);
          let index = 0;
          const found = sheet.rows.map((values, position) => ({ values, position })).filter(({ values, position }) => position >= row - 1 && position < row - 1 + count && values[0] === search);
          const finder = { matchEntireCell(value) { assert.equal(value, true); return finder; }, matchCase(value) { assert.equal(value, true); return finder; },
            useRegularExpression(value) { assert.equal(value, false); return finder; }, findNext() {
              events.push(['find', search]); if (!found.length) return null;
              const hit = found[index++ % found.length]; return { getRow: () => hit.position + 1 };
            } };
          return finder;
        }
      };
      return range;
    }
  };
  let present = settings.missingSheet !== true;
  const book = { getSheetByName(name) { assert.equal(name, 'MailApp Attempts'); return present ? sheet : null; },
    insertSheet(name) { assert.equal(name, 'MailApp Attempts'); assert.equal(present, false); present = true; events.push(['insert']); return sheet; } };
  const lock = { tryLock(ms) { assert.equal(ms, 10000); if (held || settings.lockUnavailable || settings.resultLockUnavailable && calls.length) return false;
    held = true; events.push(['lock']); return true; }, releaseLock() { assert.equal(held, true); held = false; events.push(['release']);
      if (settings.releaseElapsed) { stamp += settings.releaseElapsed; settings.releaseElapsed = 0; } } };
  const context = vm.createContext({
    console: { log: value => logs.push(value) },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [stamp])); } static now() { return stamp; } },
    EXPECTED_SPREADSHEET_NAME: settings.sheetName || 'RBJJ M1 — TEST',
    configuredDeploymentTarget_: () => settings.target || 'test', deploymentTargetAllowed_: value => value === (settings.target || 'test') && settings.targetLock !== false,
    configuredReceiverSecret_: () => 'synthetic-transport', configuredAdminActionSecret_: () => 'synthetic-admin',
    cleanText_: value => typeof value === 'string' ? value.trim() : '', scriptProperty_: () => '',
    GIB_M1_LEGACY_KIOSK_PROPERTY_: 'synthetic-legacy', GIB_M1_RECOVERY_PROPERTY_: 'synthetic-recovery',
    configuredSecretsArePairwiseDistinct_: values => { const configured = values.filter(Boolean); return new Set(configured).size === configured.length; },
    constantTimeTextEqual_: (a, b) => a === b,
    PropertiesService: { getScriptProperties: () => propertyStore }, LockService: { getScriptLock: () => lock },
    Session: { getEffectiveUser: () => ({ getEmail() { if (settings.actorThrows) throw new Error('private auth error'); return settings.actor ?? SENDER; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF-8' },
      computeDigest(algorithm, value, charset) { assert.equal(algorithm, 'SHA_256'); assert.equal(charset, 'UTF-8'); return [...createHash('sha256').update(value, 'utf8').digest()].map(byte => byte > 127 ? byte - 256 : byte); } },
    SpreadsheetApp: { flush() { if (settings.flushFailsAt === currentStage) throw new Error('private flush error'); events.push(['flush', currentStage]); } },
    openExpectedSpreadsheet_(body) { assert.equal(body.target, 'test'); assert.equal(held, true); if (settings.openFails) throw new Error('private sheet error'); return book; },
    jsonResult_: value => ({ getContent: () => JSON.stringify(value) }),
    MailApp: {
      getRemainingDailyQuota() { assert.equal(held, false, 'remote quota read must not hold the shared attendance lock'); events.push(['quota']);
        if (settings.onQuota) settings.onQuota(); if (settings.quotaThrows) throw new Error('private quota authorization error'); return settings.quota ?? 100; },
      sendEmail(value) {
        assert.equal(held, false, 'MailApp must run outside the shared attendance lock');
        const marker = sheet.rows.find(row => row[1] === 'attempt'); assert.ok(marker, 'durable claim precedes send');
        assert.ok(reads.some(read => read.row > 1 && read.count === 1 && read.width === 10), 'claim readback precedes send');
        calls.push(plain(value)); events.push(['send']); if (settings.onSend) settings.onSend(context);
        if (settings.sendThrows) throw new Error('private delivery or permission failure');
      }
    }
  });
  vm.runInContext(authorization + '\n' + source, context);
  if (present && settings.emptySheet !== true) sheet.rows = [plain(context.GIB_M1_MAILAPP_HEADERS_)];
  function request(action = 'attendanceMailSend', patch = {}) {
    return JSON.parse(context.gibM1MailAppAction_({ action, target: 'test', gym: 'rev', token: 'synthetic-transport', adminActionToken: 'synthetic-admin',
      binding: { schema: 'm1-mailapp-request/v1', requestId: ID, createdAt: stamp, expiresAt: stamp + 60000 }, message: message(), ...patch }).getContent());
  }
  return { context, settings, events, calls, properties, sheet, reads, logs, request, advance: ms => { stamp += ms; }, deleteSheet: () => { present = false; }, held: () => held };
}

test('BCC is an actual private MailApp option, approved exactly, and included in the permanent hash', () => {
  const h = harness(), original = message({ bcc: ['andrew@example.invalid'] });
  h.properties.set(RECIPIENTS, JSON.stringify({ to: ['qa@example.com'], cc: [], bcc: ['andrew@example.invalid'] }));
  assert.equal(h.request('attendanceMailStatus', { message: original }).code, 'MAILAPP_READY');
  assert.equal(h.request('attendanceMailSend', { message: original }).state, 'submitted');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].to, 'qa@example.com');
  assert.equal(h.calls[0].bcc, 'andrew@example.invalid'); assert.equal(Object.hasOwn(h.calls[0], 'cc'), false);
  assert.doesNotMatch(h.calls[0].body + h.calls[0].htmlBody, /andrew@example/);
  assert.equal(h.sheet.rows[1][2], original.hash);
  // Removing future BCC does not alter a sent original or authorize a retry.
  h.properties.set(RECIPIENTS, JSON.stringify({ to: ['qa@example.com'], cc: [] }));
  assert.equal(h.request('attendanceMailStatus', { message: original }).state, 'submitted');
  assert.equal(h.request('attendanceMailSend', { message: message() }).code, 'MAILAPP_ORIGINAL_CONFLICT');
  assert.equal(h.calls.length, 1);
});

test('BCC permission, quota, malformed fields and hash tampering fail before any MailApp call', () => {
  const original = message({ bcc: ['andrew@example.invalid'] }), h = harness();
  assert.equal(h.request('attendanceMailSend', { message: original }).code, 'MAILAPP_RECIPIENTS_UNAPPROVED');
  assert.equal(h.calls.length, 0); assert.equal(h.sheet.rows.length, 1);
  const limited = harness({ quota: 1 });
  limited.properties.set(RECIPIENTS, JSON.stringify({ to: ['qa@example.com'], cc: [], bcc: ['andrew@example.invalid'] }));
  assert.equal(limited.request('attendanceMailSend', { message: original }).code, 'MAILAPP_QUOTA_UNAVAILABLE');
  assert.equal(limited.calls.length, 0); assert.equal(limited.sheet.rows.length, 1);
  for (const bcc of [null, 'andrew@example.invalid', ['QA@example.com'], ['a@example.invalid', 'b@example.invalid'], ['bad\r\n@example.invalid']]) {
    const rejected = harness(); assert.equal(rejected.request('attendanceMailSend', { message: message({ bcc }) }).code, 'MAILAPP_MESSAGE_INVALID');
    assert.equal(rejected.events.length, 0);
  }
  const tampered = { ...message(), bcc: ['andrew@example.invalid'] };
  assert.equal(h.request('attendanceMailSend', { message: tampered }).code, 'MAILAPP_MESSAGE_INVALID'); assert.equal(h.calls.length, 0);
});

test('no-BCC legacy hashes and receiver receipts remain valid, and removal applies only to a fresh day', () => {
  const h = harness(), original = message();
  assert.equal(h.context.gibM1MailAppHash_(original), original.hash);
  assert.equal(h.request('attendanceMailSend', { message: original }).state, 'submitted');
  const rows = plain(h.sheet.rows);
  h.properties.set(RECIPIENTS, JSON.stringify({ to: ['qa@example.com'], cc: [], bcc: ['andrew@example.invalid'] }));
  assert.equal(h.request('attendanceMailStatus', { message: original }).state, 'submitted');
  assert.equal(h.request('attendanceMailSend', { message: message({ bcc: ['andrew@example.invalid'] }) }).code, 'MAILAPP_ORIGINAL_CONFLICT');
  assert.deepEqual(h.sheet.rows, rows); assert.equal(h.calls.length, 1);
  const fresh = harness(); fresh.properties.set(RECIPIENTS, JSON.stringify({ to: ['qa@example.com'], cc: [], bcc: [] }));
  assert.equal(fresh.request('attendanceMailSend', { message: message({ bcc: [] }) }).state, 'submitted');
  assert.equal(Object.hasOwn(fresh.calls[0], 'bcc'), false);
});

test('ordinary sends are TEST/rev only and use both existing authentication secrets before storage or quota', () => {
  for (const options of [{ target: 'production' }, { targetLock: false }, { sheetName: 'RBJJ M1 — PRODUCTION' }, { sheetName: 'Richmond BJJ M1 — TEST' }]) {
    const h = harness(options); assert.equal(h.request().code, 'MAILAPP_AUTHENTICATION_REQUIRED'); assert.equal(h.events.length, 0);
  }
  for (const patch of [{ target: 'production' }, { gym: 'richmond' }, { token: 'wrong' }, { adminActionToken: 'wrong' }]) {
    const h = harness(); assert.equal(h.request('attendanceMailSend', patch).code, 'MAILAPP_AUTHENTICATION_REQUIRED'); assert.equal(h.events.length, 0);
  }
});

test('exact immutable payload, sender, identities, freshness and message hash are validated before any attempt', () => {
  const invalid = [{ messageId: 'm1-test-scheduled-richmond-2026-09-27' }, { messageId: 'm1-test-scheduled-rev-2026-02-31' }, { from: 'other@example.com' },
    { target: 'production' }, { to: ['qa@example.com,another@example.com'] }, { cc: ['QA@example.com'] }, { subject: 'injected\r\nsubject' }, { extra: true }];
  for (const patch of invalid) { const h = harness(); assert.equal(h.request('attendanceMailSend', { message: message(patch) }).code, 'MAILAPP_MESSAGE_INVALID'); assert.equal(h.events.length, 0); }
  const h = harness(); assert.equal(h.request('attendanceMailSend', { message: { ...message(), hash: '0'.repeat(64) } }).code, 'MAILAPP_MESSAGE_INVALID');
  for (const binding of [{ schema: 'wrong', requestId: ID, createdAt: START, expiresAt: START + 60000 },
    { schema: 'm1-mailapp-request/v1', requestId: ID, createdAt: START - 60000, expiresAt: START },
    { schema: 'm1-mailapp-request/v1', requestId: ID, createdAt: START + 1, expiresAt: START + 60001 }]) {
    assert.equal(h.request('attendanceMailSend', { binding }).code, 'MAILAPP_BINDING_INVALID');
  }
  assert.equal(h.events.length, 0); assert.equal(h.request('attendanceMailSend', { unapproved: true }).code, 'MAILAPP_REQUEST_INVALID');
});

test('status preflight is read-only and requires existing ledger, configured recipients, account, switch, permission and quota', () => {
  const ready = harness(); const value = ready.request('attendanceMailStatus');
  assert.equal(value.code, 'MAILAPP_READY'); assert.equal(value.state, 'not-attempted'); assert.equal(value.retrySafe, true); assert.equal(value.ok, true);
  assert.equal(ready.events.some(event => ['write', 'send', 'insert', 'property'].includes(event[0])), false);
  for (const [options, code] of [[{ enabled: false }, 'MAILAPP_DISABLED'], [{ quota: 0 }, 'MAILAPP_QUOTA_UNAVAILABLE'], [{ quotaThrows: true }, 'MAILAPP_AUTHORIZATION_UNAVAILABLE']]) {
    const h = harness(options), result = h.request('attendanceMailStatus'); assert.equal(result.code, code); assert.equal(result.retrySafe, true); assert.equal(result.state, 'not-attempted');
    assert.equal(result.attemptedAt, null); assert.equal(h.calls.length, 0); assert.equal(h.sheet.rows.length, 1);
  }
  const unapproved = harness(); unapproved.properties.set(RECIPIENTS, JSON.stringify({ to: ['different@example.com'], cc: [] }));
  assert.equal(unapproved.request('attendanceMailStatus').code, 'MAILAPP_RECIPIENTS_UNAPPROVED'); assert.equal(unapproved.sheet.rows.length, 1);
  for (const options of [{ actor: '' }, { actor: 'different@example.com' }, { actorThrows: true }]) {
    const h = harness(options); assert.equal(h.request().code, 'MAILAPP_SENDER_UNVERIFIED'); assert.equal(h.events.length, 0);
  }
});

test('one durable read-back claim precedes MailApp outside the lock; duplicate requests return the original completion forever', () => {
  const h = harness(), first = h.request(); assert.equal(first.state, 'submitted'); assert.equal(first.retrySafe, false);
  assert.equal(first.attemptedAt, new Date(START).toISOString()); assert.equal(first.completedAt, first.attemptedAt);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0], { to: 'qa@example.com', subject: message().subject, body: message().text, htmlBody: message().html });
  assert.equal(h.sheet.rows.length, 3); assert.deepEqual(h.sheet.rows.slice(1).map(row => row[1]), ['attempt', 'submitted']);
  assert.equal(Object.hasOwn(first, 'providerId'), false); assert.equal(Object.hasOwn(first, 'delivered'), false);
  h.advance(400 * 86400000); h.properties.set(SEND, 'false'); h.properties.set(RECIPIENTS, 'not configured');
  assert.deepEqual(h.request(), first); assert.deepEqual(h.request('attendanceMailStatus'), first); assert.equal(h.calls.length, 1); assert.equal(h.sheet.rows.length, 3);
});

test('payload bounds retain the existing workflow coverage and reject over-limit content before quota or storage', () => {
  const h = harness(), full = message({ subject: 's'.repeat(998), html: 'h'.repeat(200000), text: 't'.repeat(200000) });
  assert.equal(h.request('attendanceMailSend', { message: full }).state, 'submitted'); assert.equal(h.calls[0].body.length, 200000);
  for (const patch of [{ subject: 's'.repeat(999) }, { html: 'h'.repeat(200001) }, { text: 't'.repeat(200001) }]) {
    const bad = harness(); assert.equal(bad.request('attendanceMailSend', { message: message(patch) }).code, 'MAILAPP_MESSAGE_INVALID'); assert.equal(bad.events.length, 0);
  }
});

test('configuration and expiry are rechecked after unlocked quota reads while existing claims remain readable', () => {
  const changed = harness(); changed.settings.onQuota = () => changed.properties.set(SEND, 'false');
  assert.equal(changed.request().code, 'MAILAPP_DISABLED'); assert.equal(changed.calls.length, 0); assert.equal(changed.sheet.rows.length, 1);
  const expired = harness(); expired.settings.onQuota = () => expired.advance(61000);
  assert.equal(expired.request().code, 'MAILAPP_BINDING_INVALID'); assert.equal(expired.calls.length, 0); assert.equal(expired.sheet.rows.length, 1);
  const original = harness(), saved = original.request(); original.settings.quotaThrows = true;
  assert.deepEqual(original.request('attendanceMailStatus'), saved); assert.equal(original.calls.length, 1);
});

test('expiry after marker readback and lock release retains the claim without starting MailApp', () => {
  const h = harness({ releaseElapsed: 61000 }), result = h.request();
  assert.equal(result.state, 'unknown'); assert.equal(result.code, 'MAILAPP_BINDING_INVALID'); assert.equal(result.retrySafe, false);
  assert.equal(h.calls.length, 0); assert.equal(h.sheet.rows.length, 2); assert.equal(h.sheet.rows[1][1], 'attempt');
  assert.equal(h.request().state, 'unknown'); assert.equal(h.request('attendanceMailStatus').state, 'unknown'); assert.equal(h.calls.length, 0);
});

test('overlapping calls see the permanent claim and cannot send while the original call is outside the lock', () => {
  const h = harness(); let overlap;
  h.settings.onSend = () => { overlap = h.request(); };
  assert.equal(h.request().state, 'submitted'); assert.equal(overlap.state, 'unknown'); assert.equal(overlap.retrySafe, false);
  assert.equal(h.calls.length, 1); assert.equal(h.sheet.rows.length, 3); assert.equal(h.held(), false);
});

test('send exceptions are retained as uncertainty and never permit a repeated send, while the next gym-day can proceed', () => {
  const h = harness({ sendThrows: true }), first = h.request(); assert.equal(first.state, 'unknown'); assert.equal(first.code, 'MAILAPP_CALL_UNCERTAIN');
  assert.equal(h.sheet.rows[2][1], 'exception'); h.advance(86400000); h.settings.sendThrows = false;
  assert.deepEqual(h.request(), first); assert.equal(h.calls.length, 1);
  const next = h.request('attendanceMailSend', { message: message({ messageId: 'm1-test-scheduled-rev-2026-09-28' }) });
  assert.equal(next.state, 'submitted'); assert.equal(h.calls.length, 2); assert.equal(h.sheet.rows.length, 5);
  assert.deepEqual(h.request('attendanceMailStatus'), first);
});

test('uncertain marker writes or readback never call MailApp; any retained marker permanently consumes the day', () => {
  for (const fault of [{ markerWrite: 'throw-before' }, { markerWrite: 'throw-after' }, { markerWrite: 'drop' }, { markerWrite: 'partial' },
    { markerReadbackFails: true }, { flushFailsAt: 'attempt' }]) {
    const h = harness(fault), first = h.request(); assert.equal(first.state, 'unknown'); assert.equal(first.retrySafe, false); assert.equal(h.calls.length, 0);
    delete h.settings.markerWrite; delete h.settings.flushFailsAt;
    if (h.sheet.rows.length > 1) { assert.equal(h.request().state, 'unknown'); assert.equal(h.calls.length, 0); }
  }
});

test('a crash after durable claim but before call stays unknown after reopening, with no resend', () => {
  const h = harness({ markerReadbackFails: true }); assert.equal(h.request().state, 'unknown'); assert.equal(h.calls.length, 0);
  h.advance(86400000); assert.equal(h.request('attendanceMailStatus').state, 'unknown'); assert.equal(h.request().state, 'unknown');
  assert.equal(h.calls.length, 0); assert.equal(h.sheet.rows.length, 2);
});

test('completion storage failure never claims success; a retained exact completion receipt can later recover without a second call', () => {
  for (const fault of [{ resultWrite: 'throw-before' }, { resultWrite: 'throw-after' }, { resultWrite: 'drop' }, { resultReadbackFails: true }, { resultLockUnavailable: true }]) {
    const h = harness(fault), first = h.request(); assert.equal(first.state, 'unknown'); assert.equal(first.code, 'MAILAPP_RESULT_UNCONFIRMED'); assert.equal(h.calls.length, 1);
    delete h.settings.resultWrite; delete h.settings.resultLockUnavailable;
    const status = h.request('attendanceMailStatus'); assert.equal(status.state, h.sheet.rows.length === 3 ? 'submitted' : 'unknown');
    assert.deepEqual(h.request(), status); assert.equal(h.calls.length, 1);
  }
});

test('mismatched payload, duplicate claims, orphan receipts and malformed headers fail closed without deleting history', () => {
  const h = harness(); h.request(); const saved = plain(h.sheet.rows);
  assert.equal(h.request('attendanceMailSend', { message: message({ subject: 'Changed original body' }) }).code, 'MAILAPP_ORIGINAL_CONFLICT');
  assert.deepEqual(h.sheet.rows, saved); assert.equal(h.calls.length, 1);
  h.sheet.rows.push(plain(h.sheet.rows[1])); assert.equal(h.request().state, 'unknown'); assert.equal(h.calls.length, 1);
  const orphan = harness(); orphan.sheet.rows.push(plain(saved[2])); assert.equal(orphan.request().state, 'unknown'); assert.equal(orphan.calls.length, 0);
  const broken = harness(); broken.sheet.rows[0][1] = 'wrong'; assert.equal(broken.request().code, 'MAILAPP_LEDGER_UNAVAILABLE'); assert.equal(broken.calls.length, 0);
});

test('exact bounded ID lookup works beyond 256 historical days and does not read entire ledger rows', () => {
  const h = harness(); h.request(); const original = plain(h.sheet.rows.slice(1));
  for (let index = 0; index < 700; index++) h.sheet.rows.push(['unrelated-' + index, 'untouched', '', '', '', '', '', '', '', '']);
  const before = h.reads.length, finds = h.events.filter(event => event[0] === 'find').length;
  assert.equal(h.request('attendanceMailStatus').state, 'submitted'); assert.equal(h.calls.length, 1);
  assert.ok(h.reads.slice(before).every(read => read.count === 1));
  assert.equal(h.events.filter(event => event[0] === 'find').length - finds, 3);
  assert.deepEqual(h.sheet.rows.slice(1, 3), original);
});

test('editor consent check verifies the effective account and quota without writes or sends', () => {
  const h = harness(); assert.deepEqual(plain(h.context.authorizeRevolutionTestMailApp()), { ok: true, target: 'test', senderVerified: true, quotaAvailable: true });
  assert.deepEqual(h.events, [['quota']]); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.logs, ['M1_TEST_MAILAPP_AUTHORIZATION {"ok":true,"target":"test","senderVerified":true,"quotaAvailable":true}']);
  assert.doesNotMatch(h.logs.join('\n'), /revbjjops|100/);
  for (const options of [{ target: 'production' }, { actor: '' }, { actor: 'other@example.com' }]) {
    const bad = harness(options); assert.throws(() => bad.context.authorizeRevolutionTestMailApp(), /MAILAPP_SENDER_UNVERIFIED/); assert.equal(bad.events.length, 0);
  }
});

test('explicit ledger preparation is TEST-only and idempotent; ordinary actions never recreate a deleted initialized ledger', () => {
  const h = harness({ ready: false, missingSheet: true }); assert.equal(h.request().code, 'MAILAPP_LEDGER_UNAVAILABLE'); assert.equal(h.events.some(event => event[0] === 'insert'), false);
  assert.deepEqual(plain(h.context.prepareRevolutionTestMailAppLedger()), { ok: true, target: 'test', initialized: true });
  assert.equal(h.properties.get(READY), 'v1'); assert.equal(h.calls.length, 0); assert.equal(h.sheet.rows.length, 1);
  h.request(); const saved = plain(h.sheet.rows); h.context.prepareRevolutionTestMailAppLedger(); assert.deepEqual(h.sheet.rows, saved);
  h.deleteSheet(); assert.equal(h.request().code, 'MAILAPP_LEDGER_UNAVAILABLE'); assert.throws(() => h.context.prepareRevolutionTestMailAppLedger(), /MAILAPP_LEDGER_UNAVAILABLE/);
  assert.equal(h.calls.length, 1); assert.equal(h.events.filter(event => event[0] === 'insert').length, 1);
});

test('no external transport, diagnostics, guessed delivery IDs, cleanup or lifetime Script Properties ledger exists', () => {
  assert.doesNotMatch(source, /\b(?:UrlFetchApp|GmailApp|CacheService)\s*\.|\b(?:deleteRow|deleteRows|deleteSheet|deleteProperty|getKeys|setTimeout)\s*\(/);
  assert.doesNotMatch(source, /providerId\s*:/); assert.equal((source.match(/MailApp\.sendEmail\(/g) || []).length, 1);
  assert.equal((source.match(/\.setProperty\(/g) || []).length, 1, 'only a single fixed initialization guard is stored in properties');
});
