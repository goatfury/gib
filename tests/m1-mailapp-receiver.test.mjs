import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../integrations/google-apps-script/GibM1MailApp.gs', import.meta.url), 'utf8');
const receiver = readFileSync(new URL('../integrations/google-apps-script/GibM1Receiver.gs', import.meta.url), 'utf8');
const richmondWrapper = readFileSync(new URL('../integrations/google-apps-script/richmond-test/Code.gs', import.meta.url), 'utf8');
const liveWrapper = gym => readFileSync(new URL('../integrations/google-apps-script/' + (gym === 'richmond' ? 'richmond-production' : 'production') + '/Code.gs', import.meta.url), 'utf8');
const liveFeatures = readFileSync(new URL('../integrations/google-apps-script/GibM1LiveFeatures.gs', import.meta.url), 'utf8');
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

test('both real production wrappers can submit exactly once using fake MailApp, own recipients and hidden BCC', () => {
  for (const richmond of [false, true]) {
    const h = harness({ production: true, richmond });
    const ready = h.request('attendanceMailStatus'); assert.equal(ready.code, 'MAILAPP_READY');
    assert.equal(ready.target, 'production'); assert.equal(ready.gym, richmond ? 'richmond' : 'rev');
    assert.equal(h.request().state, 'submitted');
    const retained = plain(h.sheet.rows);
    h.advance(86400000);
    assert.equal(h.request().state, 'submitted', 'expired leases cannot resend an attempted day');
    assert.deepEqual(h.sheet.rows, retained); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].to, richmond ? 'info@richmondbjj.com' : 'info@revolutionbjj.com');
    assert.equal(h.calls[0].bcc, 'andrew@revolutionbjj.com');
    assert.doesNotMatch(h.calls[0].body + h.calls[0].htmlBody, /andrew@|deploy-preview|gib-richmond-test/);
    assert.equal(h.sheet.rows.length, 3);
    assert.throws(() => h.context.authorizeRevolutionTestMailApp());
    assert.throws(() => h.context.prepareRevolutionTestMailAppLedger());
    assert.equal(h.context.authorizeProductionMailApp().senderVerified, true); assert.equal(h.calls.length, 1);
  }
});

test('production gates reject wrong execution accounts, recipients, gyms, TEST identities, links and invalid controls before a call', () => {
  for (const richmond of [false, true]) {
    const actor = harness({ production: true, richmond, actor: 'someone@example.invalid' });
    assert.equal(actor.request().code, 'MAILAPP_SENDER_UNVERIFIED'); assert.equal(actor.calls.length, 0);
    assert.throws(() => actor.context.authorizeProductionMailApp(), /MAILAPP_SENDER_UNVERIFIED/);
    for (const property of ['GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED', 'GIB_M1_MAILAPP_LIVE_SEND_ENABLED']) {
      for (const value of [null, 'TRUE', 'active', 'false']) {
        const h = harness({ production: true, richmond }); value === null ? h.properties.delete(property) : h.properties.set(property, value);
        assert.notEqual(h.request().state, 'submitted'); assert.equal(h.calls.length, 0); assert.equal(h.sheet.rows.length, 1);
      }
    }
    for (const patch of [{ target: 'test' }, { gym: richmond ? 'rev' : 'richmond' }, { token: 'wrong' }, { adminActionToken: 'wrong' }, ...(richmond ? [{ environment: 'test' }, { installation: 'rev' }] : [])]) {
      const h = harness({ production: true, richmond }); assert.notEqual(h.request('attendanceMailSend', patch).state, 'submitted'); assert.equal(h.calls.length, 0);
    }
    for (const address of ['someone@example.invalid', richmond ? 'info@revolutionbjj.com' : 'info@richmondbjj.com']) {
      const h = harness({ production: true, richmond }); h.properties.set('GIB_M1_MAILAPP_LIVE_RECIPIENTS_JSON', JSON.stringify({ to: [address], cc: [], bcc: ['andrew@revolutionbjj.com'] }));
      assert.equal(h.request().code, 'MAILAPP_RECIPIENTS_UNAPPROVED'); assert.equal(h.calls.length, 0);
    }
    const links = harness({ production: true, richmond }), original = message({ target: 'production', synthetic: false, messageId: 'm1-production-scheduled-' + (richmond ? 'richmond' : 'rev') + '-2026-09-27', to: [richmond ? 'info@richmondbjj.com' : 'info@revolutionbjj.com'], bcc: ['andrew@revolutionbjj.com'] });
    assert.equal(links.request('attendanceMailSend', { message: message({ ...original, html: '<a href="https://gib-richmond-test.netlify.app/m1/admin/">wrong environment</a>' }) }).code, 'MAILAPP_MESSAGE_INVALID'); assert.equal(links.calls.length, 0);
    const testId = harness({ production: true, richmond }); assert.equal(testId.request('attendanceMailSend', { message: message() }).code, 'MAILAPP_MESSAGE_INVALID'); assert.equal(testId.events.length, 0);
  }
});

test('production interrupted claims, overlapping requests and lost final writes retain original evidence without a second send', () => {
  for (const richmond of [false, true]) {
    for (const options of [{ markerWrite: 'throw-after' }, { sendThrows: true }, { resultWrite: 'throw-after' }, { resultWrite: 'throw-before' }]) {
      const h = harness({ production: true, richmond, ...options }); const first = h.request();
      assert.equal(first.state, 'unknown'); const count = h.calls.length, rows = plain(h.sheet.rows);
      h.settings.markerWrite = null; h.settings.resultWrite = null; h.settings.sendThrows = false; h.advance(3 * 86400000);
      assert.ok(['unknown', 'submitted'].includes(h.request('attendanceMailStatus').state));
      assert.ok(['unknown', 'submitted'].includes(h.request().state));
      assert.equal(h.calls.length, count); assert.deepEqual(h.sheet.rows, rows);
    }
    const h = harness({ production: true, richmond });
    h.settings.onSend = () => { assert.equal(h.request().state, 'unknown'); };
    assert.equal(h.request().state, 'submitted'); assert.equal(h.calls.length, 1); assert.equal(h.sheet.rows.length, 3);
    const corrupt = harness({ production: true, richmond, markerWrite: 'partial' });
    assert.equal(corrupt.request().state, 'unknown'); corrupt.settings.markerWrite = null;
    assert.equal(corrupt.request().state, 'unknown'); assert.equal(corrupt.calls.length, 0);
  }
});

test('Richmond MailApp is scoped and disabled even with an enabled Script Property', () => {
  const h = harness({ richmond: true });
  for (const action of ['attendanceMailSend', 'attendanceMailStatus']) {
    const result = h.request(action);
    assert.equal(result.gym, 'richmond'); assert.equal(result.messageId, 'm1-test-scheduled-richmond-2026-09-27');
    assert.equal(result.code, 'MAILAPP_DISABLED'); assert.equal(result.state, 'not-attempted'); assert.equal(result.retrySafe, true);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.sheet.rows.length, 1); assert.equal(h.events.some(event => event[0] === 'quota'), false);
  assert.equal(h.context.gibM1RichmondActionValid_({ action: 'attendanceMailStatus', gym: 'richmond' }), true);
  assert.equal(h.context.gibM1RichmondActionValid_({ action: 'attendanceMailSend', gym: 'rev' }), false);
});

test('Richmond MailApp rejects cross-gym messages and request identities before touching records', () => {
  for (const patch of [{ gym: 'rev' }, { target: 'production' }, { installation: 'rev' }, { environment: 'production' }, { installation: undefined }, { token: 'wrong' }]) {
    const h = harness({ richmond: true }); assert.equal(h.request('attendanceMailStatus', patch).code, 'MAILAPP_AUTHENTICATION_REQUIRED'); assert.equal(h.events.length, 0);
  }
  const h = harness({ richmond: true }); assert.equal(h.request('attendanceMailSend', { message: message() }).code, 'MAILAPP_MESSAGE_INVALID'); assert.equal(h.events.length, 0);
  for (const key of ['GIB_M1_DEPLOYMENT_TARGET_LOCK', 'GIB_M1_INSTALLATION_LOCK', 'GIB_M1_ENVIRONMENT_LOCK', 'GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED', 'GIB_M1_RICHMOND_TEST_SPREADSHEET_ID']) {
    const bad = harness({ richmond: true }); bad.properties.delete(key);
    assert.equal(bad.request().code, 'MAILAPP_AUTHENTICATION_REQUIRED', key); assert.equal(bad.events.length, 0);
  }
});

test('Richmond disabled status preserves permanent own-gym claims and rejects foreign ledger rows', () => {
  const h = harness({ richmond: true }), original = message({ messageId: 'm1-test-scheduled-richmond-2026-09-27' });
  h.sheet.rows.push([original.messageId, 'attempt', original.hash, 'richmond', '2026-09-27', ID, new Date(START).toISOString(), '', 'MAILAPP_CALL_PENDING', SENDER]);
  assert.equal(h.request('attendanceMailStatus').state, 'unknown'); assert.equal(h.request().state, 'unknown'); assert.equal(h.calls.length, 0);
  h.sheet.rows[1][3] = 'rev'; assert.equal(h.request('attendanceMailStatus').code, 'MAILAPP_ORIGINAL_CONFLICT');
  assert.equal(h.sheet.rows.length, 2); assert.equal(h.calls.length, 0);
});

test('Richmond MailApp preparation uses its scoped helpers without altering Revolution payload hashes', () => {
  const h = harness({ richmond: true, ready: false, missingSheet: true, emptySheet: true });
  assert.throws(() => h.context.prepareRevolutionTestMailAppLedger(), /MAILAPP_SENDER_UNVERIFIED/);
  assert.throws(() => h.context.authorizeRevolutionTestMailApp(), /MAILAPP_SENDER_UNVERIFIED/);
  assert.equal(h.context.prepareRichmondTestMailAppLedger().initialized, true);
  assert.equal(h.sheet.rows.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.context.GIB_M1_RICHMOND_MAILAPP_SEND_ENABLED, false);
  const rev = harness(), original = message(); assert.equal(rev.context.gibM1MailAppHash_(original), original.hash);
  assert.equal(h.context.gibM1MailAppHash_(message({ messageId: 'm1-test-scheduled-richmond-2026-09-27' })), message({ messageId: 'm1-test-scheduled-richmond-2026-09-27' }).hash);
});
function harness(options = {}) {
  let stamp = START, held = false, currentStage = null;
  const settings = { ...options }, events = [], calls = [], reads = [], logs = [], properties = new Map();
  if (settings.richmond) for (const [key, value] of Object.entries({ GIB_M1_RICHMOND_TEST_SPREADSHEET_ID: 'synthetic-richmond-sheet',
    GIB_M1_DEPLOYMENT_TARGET_LOCK: 'test', GIB_M1_INSTALLATION_LOCK: 'richmond', GIB_M1_ENVIRONMENT_LOCK: 'test',
    GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED: 'richmond-test-v1' })) properties.set(key, value);
  if (settings.ready !== false) properties.set(READY, 'v1');
  if (settings.enabled !== false) properties.set(SEND, 'true');
  properties.set(RECIPIENTS, JSON.stringify({ to: ['qa@example.com'], cc: [] }));
  if (settings.production) {
    properties.delete('GIB_M1_RICHMOND_TEST_SPREADSHEET_ID');
    const locks = settings.richmond ? { GIB_M1_DEPLOYMENT_TARGET_LOCK: 'production', GIB_M1_INSTALLATION_LOCK: 'richmond', GIB_M1_ENVIRONMENT_LOCK: 'production', GIB_M1_RICHMOND_PRODUCTION_PROVISIONING_CLOSED: 'richmond-production-v1', GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_ID: 'synthetic-richmond-live-sheet', GIB_M1_RICHMOND_PRODUCTION_WRITES_ENABLED: 'true' }
      : { GIB_M1_DEPLOYMENT_TARGET_LOCK: 'production', GIB_M1_PROVISIONING_CLOSED: 'closed-v1', GIB_M1_PRODUCTION_SPREADSHEET_ID: 'synthetic-rev-live-sheet' };
    for (const [key, value] of Object.entries({ ...locks, GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'true', GIB_M1_MAILAPP_LIVE_LEDGER_READY: 'v1', GIB_M1_MAILAPP_LIVE_SEND_ENABLED: 'true', GIB_M1_MAILAPP_LIVE_RECIPIENTS_JSON: JSON.stringify({ to: [settings.richmond ? 'info@richmondbjj.com' : 'info@revolutionbjj.com'], cc: [], bcc: ['andrew@revolutionbjj.com'] }) })) properties.set(key, value);
  }
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
    GIB_M1_TARGET_LOCK_PROPERTY_: 'GIB_M1_DEPLOYMENT_TARGET_LOCK',
    configuredDeploymentTarget_: () => settings.target || (settings.production ? 'production' : 'test'), deploymentTargetAllowed_: value => value === (settings.target || (settings.production ? 'production' : 'test')) && settings.targetLock !== false,
    configuredReceiverSecret_: () => 'synthetic-transport', configuredAdminActionSecret_: () => 'synthetic-admin',
    cleanText_: value => typeof value === 'string' ? value.trim() : '', scriptProperty_: () => '',
    exactText_: value => typeof value === 'string' ? value : '',
    GIB_M1_LEGACY_KIOSK_PROPERTY_: 'synthetic-legacy', GIB_M1_RECOVERY_PROPERTY_: 'synthetic-recovery',
    configuredSecretsArePairwiseDistinct_: values => { const configured = values.filter(Boolean); return new Set(configured).size === configured.length; },
    constantTimeTextEqual_: (a, b) => a === b,
    PropertiesService: { getScriptProperties: () => propertyStore }, LockService: { getScriptLock: () => lock },
    Session: { getEffectiveUser: () => ({ getEmail() { if (settings.actorThrows) throw new Error('private auth error'); return settings.actor ?? SENDER; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF-8' },
      formatDate(value, zone, format) { const fields = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value); const parts = Object.fromEntries(fields.map(part => [part.type, part.value])); return format === 'HH:mm' ? parts.hour + ':' + parts.minute : parts.year + '-' + parts.month + '-' + parts.day; },
      computeDigest(algorithm, value, charset) { assert.equal(algorithm, 'SHA_256'); assert.equal(charset, 'UTF-8'); return [...createHash('sha256').update(value, 'utf8').digest()].map(byte => byte > 127 ? byte - 256 : byte); } },
    SpreadsheetApp: { flush() { if (settings.flushFailsAt === currentStage) throw new Error('private flush error'); events.push(['flush', currentStage]); } },
    openExpectedSpreadsheet_(body) { assert.equal(body.target, settings.production ? 'production' : 'test'); assert.equal(held, true); if (settings.openFails) throw new Error('private sheet error'); return book; },
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
  if (settings.production) vm.runInContext(liveWrapper(settings.richmond ? 'richmond' : 'rev') + '\n' + liveFeatures, context);
  else if (settings.richmond) vm.runInContext(richmondWrapper, context);
  if (present && settings.emptySheet !== true) sheet.rows = [plain(context.GIB_M1_MAILAPP_HEADERS_)];
  function request(action = 'attendanceMailSend', patch = {}) {
    const target = settings.production ? 'production' : 'test', gym = settings.richmond ? 'richmond' : 'rev';
    const prepared = settings.production ? message({ messageId: 'm1-production-scheduled-' + gym + '-2026-09-27', target, synthetic: false, to: [gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com'], bcc: ['andrew@revolutionbjj.com'], subject: 'Isolated attendance fixture', html: '<p>Fixture <a href="' + (gym === 'rev' ? 'https://gib-live.netlify.app' : 'https://gib-richmond-live.netlify.app') + '/m1/admin/">Review</a></p>', text: 'Fixture ' + (gym === 'rev' ? 'https://gib-live.netlify.app' : 'https://gib-richmond-live.netlify.app') + '/m1/admin/' }) : message(settings.richmond ? { messageId: 'm1-test-scheduled-richmond-2026-09-27' } : {});
    return JSON.parse(context.gibM1MailAppAction_({ action, target, gym, token: 'synthetic-transport', adminActionToken: 'synthetic-admin',
      binding: { schema: 'm1-mailapp-request/v1', requestId: ID, createdAt: stamp, expiresAt: stamp + 60000 },
      message: prepared,
      ...(settings.richmond ? { installation: 'richmond', environment: target } : {}), ...patch }).getContent());
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
