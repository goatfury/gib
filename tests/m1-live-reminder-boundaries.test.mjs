import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFeatureScope } from '../netlify/functions/_lib/m1-release-scope.mjs';
import { liveControls, LIVE_ORIGINS, LIVE_RECIPIENTS } from '../tools/m1-release-controls.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig, requireAdmin, auditAdminNamesForScope } from '../netlify/functions/_lib/m1-common.mjs';
import { handleAdminLogin } from '../netlify/functions/m1-admin-login.mjs';
import { handleAdminVoid } from '../netlify/functions/m1-admin-void.mjs';
import { handleAttendanceWorkflow } from '../netlify/functions/m1-attendance-workflow.mjs';
import { handleAttendanceWarning } from '../netlify/functions/m1-attendance-warning.mjs';
import { handleAttendanceDigestJob } from '../netlify/functions/m1-attendance-digest-job.mjs';
import { handleAttendanceDeliveryBackground } from '../netlify/functions/m1-attendance-delivery-background.mjs';
import { handleAttendanceGoogleEmail } from '../netlify/functions/m1-attendance-google-email.mjs';
import { handleAttendanceDigestEmail } from '../netlify/functions/m1-attendance-digest-email.mjs';
import { handleAttendanceWorkflowBackground } from '../netlify/functions/m1-attendance-workflow-background.mjs';
import { handleAttendanceDigest } from '../netlify/functions/m1-attendance-digest.mjs';
import { defaultDigestConfiguration, digestStoreName, buildAttendanceDigest, digestHash, datesThrough } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { makeDigestBinding, digestSignature } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, workflowHealth, workflowMessages, WORKFLOW_DISPATCH_HEADER } from '../netlify/functions/_lib/m1-attendance-digest-workflow.mjs';
import { loadDigestScheduleSnapshots } from '../netlify/functions/_lib/m1-attendance-digest-source.mjs';

// No network credentials, mail, hosted settings or real records are used here.
const NOW = Date.parse('2026-09-30T00:05:00Z'), DATE = '2026-09-29', PAGE = 'synthetic-page-token-012345678901234567890123';
const ENV = Object.freeze({
  GIB_M1_ENVIRONMENT: 'production',
  GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'true', GIB_M1_STAFF_RECOVERY_LIVE_ENABLED: 'true', GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED: 'true',
  GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_MAILAPP_LIVE_SEND_ENABLED: 'true', GIB_M1_ATTENDANCE_DIGEST_VERIFIED_SENDER: 'revbjjops@gmail.com',
  GIB_M1_ATTENDANCE_DIGEST_VERIFIED_RECIPIENTS: 'info@revolutionbjj.com,info@richmondbjj.com,andrew@revolutionbjj.com',
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_REV_PRODUCTION/exec', GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'isolated-rev-production-transport-0123456789',
  GIB_M1_ADMIN_ACTION_TOKEN: 'isolated-rev-production-action-0123456789', GIB_M1_ADMIN_PASSPHRASE: 'isolated violet lake forest',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICH_PRODUCTION/exec', GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'isolated-rich-production-transport-0123456789',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'isolated-rich-production-action-0123456789', GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'isolated silver mountain meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'isolated-rich-production-device-0123456789', GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true'
});
const SITES = { rev: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' }, richmond: { name: 'gib-richmond-live', id: '9b7757a9-70f4-4977-9ca2-270b41e34007' } };
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
class Store {
  entries = new Map(); serial = 0; fault = null;
  async getWithMetadata(key) { if (this.fault === 'read') throw new Error('isolated storage read failure'); return structuredClone(this.entries.get(key) || null); }
  async set(key, raw, options = {}) {
    const before = this.entries.get(key);
    if (options.onlyIfNew && before || options.onlyIfMatch && options.onlyIfMatch !== before?.etag) return { modified: false };
    this.entries.set(key, { data: JSON.parse(raw), etag: String(++this.serial) });
    if (this.fault === 'write-after') { this.fault = null; throw new Error('isolated lost storage acknowledgment'); }
    return { modified: true };
  }
}
function deps(gym, env = ENV) { return { env, installationId: gym, environment: gym === 'richmond' ? 'production' : undefined, activation: 'active', context: { site: SITES[gym], deploy: { context: 'production', published: true } }, clock: () => NOW, now: NOW }; }
function runtime(gym, env = ENV) { return runtimeConfig(env, { admin: true, requestUrl: LIVE_ORIGINS[gym] + '/api/m1-attendance-workflow', installationId: gym, environment: gym === 'richmond' ? 'production' : undefined, activation: 'active' }); }
function request(gym, path, { body, name = 'Stuart Turner', env = ENV, auth = true, headers = {} } = {}) {
  const own = runtime(gym, env), session = auth && own ? { Cookie: ADMIN_COOKIE + '=' + createAdminSession(name, own.sessionSecret, NOW, PAGE, own), [ADMIN_REQUEST_HEADER]: PAGE } : {};
  return new Request(LIVE_ORIGINS[gym] + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(LIVE_ORIGINS[gym]).host, Origin: LIVE_ORIGINS[gym], 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...session, ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
function fixture(gym) {
  let now = NOW, serial = 0;
  const scope = releaseFeatureScope(request(gym, '/api/m1-attendance-workflow'), 'reminders', deps(gym)); assert.ok(scope);
  const store = new Store(), receipts = new Map(), sends = [], calls = [], settings = {};
  const dependencies = { ...deps(gym), now: undefined, scope, workflowStore: store, mailappRuntime: runtime(gym), clock: () => now,
    uuid: () => uuid(++serial), fetch: async (url, init) => {
      assert.equal(url, runtime(gym).webhookUrl); const body = JSON.parse(init.body); calls.push(body);
      assert.equal(body.target, 'production'); assert.equal(body.gym, gym);
      if (gym === 'richmond') { assert.equal(body.installation, gym); assert.equal(body.environment, 'production'); }
      const result = receipts.get(body.message.messageId), attempted = body.action === 'attendanceMailSend';
      if (attempted) { assert.equal(result, undefined, 'original Google action is never resubmitted'); sends.push(structuredClone(body.message)); receipts.set(body.message.messageId, 'submitted'); if (settings.dropReply) throw new Error('isolated interrupted confirmation'); }
      const state = attempted || result ? 'submitted' : 'not-attempted';
      return new Response(JSON.stringify({ ok: true, target: 'production', gym, messageId: body.message.messageId, hash: body.message.hash, state,
        code: state === 'submitted' ? 'MAILAPP_SUBMITTED' : 'MAILAPP_READY', attemptedAt: state === 'submitted' ? new Date(now).toISOString() : null,
        completedAt: state === 'submitted' ? new Date(now).toISOString() : null, retrySafe: state === 'not-attempted' }));
    } };
  function input(mode = 'issue') {
    const configuration = defaultDigestConfiguration(scope), binding = makeDigestBinding(uuid(++serial), 'scheduled', now, 'production');
    const ledger = { ok: true, complete: true, target: 'production', schema: 'm1-manager-review/v1', gym, from: '2026-09-07', to: binding.jobDate,
      days: datesThrough(binding.jobDate).map(date => ({ date, attendanceHash: digestHash(date), records: [], warnings: [], review: null })) };
    const snapshots = [{ gym, attendance: mode === 'incomplete' ? { ok: false, code: 'ATTENDANCE_READ_UNAVAILABLE' } : { ok: true, ledger }, staff: { ok: true, complete: true, items: [], ...(gym === 'richmond' ? { notApplicable: true } : {}) } }];
    const schedules = [{ gym, timezone: 'America/New_York', days: datesThrough(binding.jobDate).map(date => ({ date, status: 'complete', observedAt: date + 'T12:00:00.000Z', sourceVersion: 'isolated-dated-proof', occurrences: date === DATE && mode !== 'clean' ? [{ label: 'Fixture older unresolved class', startAt: DATE + 'T20:00:00.000Z', endAt: DATE + 'T21:00:00.000Z', cancelled: false }] : [] })) }];
    return { binding, configuration, due: 'due', digest: buildAttendanceDigest({ jobDate: binding.jobDate, snapshots, schedules, configuration, now }) };
  }
  return { scope, store, dependencies, calls, sends, settings, input, at: stamp => { now = stamp; }, run: mode => processAttendanceWorkflow(input(mode), dependencies), read: () => workflowMessages(scope, dependencies) };
}

test('production feature scopes require exact activation and canonical own published installation; independent switches do not enable Richmond Staff', () => {
  for (const gym of ['rev', 'richmond']) {
    const req = request(gym, '/api/m1-attendance-workflow'), d = deps(gym);
    assert.equal(releaseFeatureScope(req, 'reminders', d)?.target, 'production');
    for (const value of [undefined, 'false', 'TRUE', 'active', true]) assert.equal(releaseFeatureScope(req, 'reminders', deps(gym, { ...ENV, GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: value })), null);
    for (const context of [{ ...d.context, site: SITES[gym === 'rev' ? 'richmond' : 'rev'] }, { ...d.context, deploy: { context: 'deploy-preview', published: false } }, { ...d.context, deploy: { context: 'production', published: false } }]) assert.equal(releaseFeatureScope(req, 'reminders', { ...d, context }), null);
    assert.equal(releaseFeatureScope(request(gym === 'rev' ? 'richmond' : 'rev', '/api/m1-attendance-workflow'), 'reminders', d), null);
    assert.equal(releaseFeatureScope(req, 'staffRecovery', d)?.profile.installationId || null, gym === 'rev' ? 'rev' : null);
    assert.equal(liveControls({}, gym).reminders, false);
  }
});

test('live namespaces, sender and own-gym links are separate from TEST, with fixed approved routes and removable hidden BCC', () => {
  for (const gym of ['rev', 'richmond']) {
    const h = fixture(gym), config = defaultDigestConfiguration(h.scope);
    for (const kind of ['digest', 'workflow', 'delivery']) assert.equal(digestStoreName(h.scope, kind), 'gib-m1-digest-production-' + gym + '-' + kind + '-v1');
    assert.notEqual(digestStoreName(h.scope), digestStoreName({ target: 'test', profile: { installationId: gym, environment: 'test' } }));
    assert.equal(config.target, 'production'); assert.equal(config.dailyLocalTime, '20:00'); assert.equal(config.timezone, 'America/New_York');
    assert.equal(config.senderAddress, 'revbjjops@gmail.com'); assert.equal(config.gyms.length, 1); assert.equal(config.gyms[0].id, gym);
    assert.equal(config.gyms[0].adminUrl, LIVE_ORIGINS[gym] + '/m1/admin/'); assert.equal(config.routing[gym].reviewer.address, LIVE_RECIPIENTS[gym]);
    assert.deepEqual(config.routing[gym].cc, []); assert.equal(config.routing[gym].bcc[0].address, 'andrew@revolutionbjj.com');
    assert.deepEqual(defaultDigestConfiguration(h.scope, { GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW: 'false' }).routing[gym].bcc, []);
    for (const env of [{ GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME: '22:00' }, { GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW: 'true' }, { GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: 'wrong@example.invalid' }, { GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW: 'TRUE' }]) assert.throws(() => defaultDigestConfiguration(h.scope, env));
  }
});

test('actual enabled production workflow reaches fake Google once, survives lost confirmation/reload and permits next-day fresh older work', async () => {
  for (const gym of ['rev', 'richmond']) {
    const h = fixture(gym); h.settings.dropReply = true; await h.run();
    assert.equal(h.sends.length, 1); const original = structuredClone(h.sends[0]);
    assert.equal(original.messageId, 'm1-production-scheduled-' + gym + '-' + DATE); assert.equal(original.synthetic, false);
    assert.deepEqual(original.to, [LIVE_RECIPIENTS[gym]]); assert.deepEqual(original.bcc, ['andrew@revolutionbjj.com']);
    assert.doesNotMatch(original.html + original.text, /Bcc:|TEST|deploy-preview|gib-richmond-test|correction screen/);
    assert.match(original.text, /older unresolved class/); assert.match(original.text, gym === 'richmond' ? /Reply here and Andrew will update the records\./ : /reply.*corrections/i);
    assert.match(original.text, /Andrew will update the record/);
    const reloaded = { ...h.dependencies }; h.settings.dropReply = false;
    await processAttendanceWorkflow(h.input(), reloaded); await h.read(); assert.equal(h.sends.length, 1);
    h.at(NOW + 86400000); await h.run(); assert.equal(h.sends.length, 2);
    assert.equal(h.sends[1].messageId, 'm1-production-scheduled-' + gym + '-2026-09-30'); assert.match(h.sends[1].text, gym === 'richmond' ? /Tuesday, September 29/ : /2026-09-29/);
    assert.deepEqual((await h.read()).messages.find(entry => entry.messageId === original.messageId).message, original);
  }
});

test('production clean decisions and incomplete checks remain durable and concurrent ticks cannot create duplicate messages', async () => {
  for (const gym of ['rev', 'richmond']) {
    const clean = fixture(gym); await clean.run('clean'); await clean.run('clean'); assert.equal(clean.calls.length, 0);
    assert.equal((await clean.read()).messages[0].state, 'suppressed'); assert.equal((await workflowHealth(clean.scope, clean.dependencies)).state, 'clear');
    const incomplete = fixture(gym); await incomplete.run('incomplete');
    assert.equal(incomplete.sends.length, 1); assert.match(incomplete.sends[0].text, gym === 'richmond' ? /The sign-in check for .* couldn.t finish\./ : /attendance records couldn.t be read/); assert.doesNotMatch(incomplete.sends[0].text, /No instructor sign-in/);
    assert.ok((await workflowHealth(incomplete.scope, incomplete.dependencies)).codes.includes('CHECK_INCOMPLETE'));
    const concurrent = fixture(gym); const results = await Promise.allSettled([concurrent.run(), concurrent.run()]);
    assert.ok(results.some(result => result.status === 'fulfilled')); await concurrent.run(); assert.equal(concurrent.sends.length, 1);
    const unreadable = fixture(gym); unreadable.store.fault = 'read'; await assert.rejects(unreadable.run()); assert.equal(unreadable.calls.length, 0);
    const interrupted = fixture(gym); interrupted.store.fault = 'write-after'; await assert.rejects(interrupted.run()); assert.equal(interrupted.sends.length, 0);
    interrupted.at(NOW + 10 * 60000 + 1); await interrupted.run(); await interrupted.run(); assert.equal(interrupted.sends.length, 1);
  }
});

test('Trey can authenticate and use only the enabled Richmond production app session; deactivation retains readable audit identity', async () => {
  const login = (gym, env, passphrase, shortcut = false) => handleAdminLogin(request(gym, '/api/m1-admin-login', { auth: false, body: { adminName: 'Trey Martin', passphrase, testShortcut: shortcut } }), { ...deps(gym, env), now: NOW });
  assert.equal((await login('richmond', ENV, ENV.GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE)).status, 200);
  assert.equal((await login('rev', ENV, ENV.GIB_M1_ADMIN_PASSPHRASE)).status, 400);
  assert.equal((await login('richmond', ENV, 'wrong')).status, 401);
  assert.equal((await login('richmond', ENV, '', true)).status, 401);
  const own = runtime('richmond'), req = request('richmond', '/api/m1-attendance-workflow', { name: 'Trey Martin' }); assert.equal(requireAdmin(req, own, NOW).session.adminName, 'Trey Martin');
  assert.equal(requireAdmin(new Request(LIVE_ORIGINS.rev + '/api/m1-attendance-workflow', { headers: req.headers }), runtime('rev'), NOW).response.status, 401);
  for (const value of [undefined, 'false', 'TRUE', 'active']) {
    const disabled = { ...ENV, GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED: value };
    assert.equal((await login('richmond', disabled, ENV.GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE)).status, 400);
    assert.equal(requireAdmin(req, runtime('richmond', disabled), NOW).response.status, 401);
    assert.ok(auditAdminNamesForScope(runtime('richmond', disabled)).includes('Trey Martin'));
  }
});

test('Trey Richmond production void reaches the unchanged audited correction with the current scoped identity, and off/wrong-gym sessions cannot dispatch', async () => {
  const rowId = 'gib-m1-' + uuid(321), body = { requestId: 'gib-m1-admin-void-' + rowId, rowId, adminName: 'Trey Martin', reason: 'Isolated correction fixture' }, calls = [];
  const dependencies = { ...deps('richmond'), fetch: async (url, init) => {
    const value = JSON.parse(init.body); calls.push(value); assert.equal(url, runtime('richmond').webhookUrl);
    assert.equal(value.adminName, 'Trey Martin'); assert.equal(value.installation, 'richmond'); assert.equal(value.environment, 'production');
    return new Response(JSON.stringify({ ok: true, result: 'voided', requestId: body.requestId, linkedRecordId: rowId, auditActionNumber: 1,
      confirmation: { adminName: body.adminName, rowId, timestamp: '2026-09-29 12:00:00', date: DATE, classLabel: 'Fixture class', duration: 1,
        instructor: 'Fixture Instructor', site: 'Richmond', device: 'Richmond Front Desk Tablet', build: 'isolated-build', notes: '', status: 'VOID', reason: body.reason } }));
  } };
  const result = await handleAdminVoid(request('richmond', '/.netlify/functions/m1-admin-void', { body, name: 'Trey Martin' }), dependencies);
  assert.equal(result.status, 200); assert.equal((await result.json()).confirmation.adminName, 'Trey Martin'); assert.equal(calls.length, 1);
  const disabled = { ...dependencies, env: { ...ENV, GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED: 'false' } };
  assert.equal((await handleAdminVoid(request('richmond', '/.netlify/functions/m1-admin-void', { body, name: 'Trey Martin' }), disabled)).status, 401);
  const foreign = request('richmond', '/.netlify/functions/m1-admin-void', { body, name: 'Trey Martin' });
  const wrong = new Request(LIVE_ORIGINS.rev + '/.netlify/functions/m1-admin-void', { method: 'POST', headers: foreign.headers, body: JSON.stringify(body) });
  assert.ok((await handleAdminVoid(wrong, { ...dependencies, ...deps('rev') })).status >= 400); assert.equal(calls.length, 1);
});

test('production Google callback captures centrally and dispatches an authenticated own-gym supported background job; replay creates no extra email', async () => {
  for (const gym of ['rev', 'richmond']) {
    const h = fixture(gym), input = h.input(), binding = input.binding, digestStore = new Store(), dispatches = [];
    const ledger = { ok: true, target: 'production', schema: 'm1-manager-review/v1', complete: true, gym, from: '2026-09-07', to: binding.jobDate,
      days: datesThrough(binding.jobDate).map(date => ({ date, attendanceHash: digestHash(date), records: [], warnings: [], review: null })) };
    const raw = JSON.stringify({ ...binding, gyms: [{ gym, attendance: { ok: true, ledger }, staff: { ok: true, complete: true, items: [], ...(gym === 'richmond' ? { notApplicable: true } : {}) } }] });
    const dependencies = { ...h.dependencies, digestStore, traceLog() {}, loadScheduleSnapshots: async () => ({ gym, timezone: 'America/New_York',
      days: datesThrough(binding.jobDate).map(date => ({ date, status: 'complete', observedAt: date + 'T12:00:00.000Z', sourceVersion: 'isolated-dated-proof', occurrences: date === DATE ? [{ label: 'Fixture class', startAt: DATE + 'T20:00:00.000Z', endAt: DATE + 'T21:00:00.000Z', cancelled: false }] : [] })) }),
      backgroundFetch: async (url, init) => { dispatches.push({ url, init }); return new Response(null, { status: 202 }); } };
    const callback = () => request(gym, '/api/m1-attendance-digest-job', { auth: false, body: raw, headers: { 'X-GIB-M1-Digest-Signature': digestSignature(raw, runtime(gym).adminActionToken) } });
    const captured = await handleAttendanceDigestJob(callback(), dependencies); assert.equal(captured.status, 200); const receipt = await captured.json(); assert.equal(receipt.accepted, true);
    assert.ok(receipt.messageId.startsWith('m1-production-daily-')); assert.ok(digestStore.entries.has('captures/' + receipt.messageId));
    assert.equal(dispatches.length, 1); assert.equal(dispatches[0].url, LIVE_ORIGINS[gym] + '/api/m1-attendance-delivery-background');
    const run = () => handleAttendanceDeliveryBackground(new Request(dispatches[0].url, dispatches[0].init), dependencies);
    assert.equal((await run()).status, 200); assert.equal((await run()).status, 200); assert.equal(h.sends.length, 1);
    assert.equal((await handleAttendanceDigestJob(callback(), dependencies)).status, 200); assert.equal(dispatches.length, 1); assert.equal(h.sends.length, 1);
    const crossed = request(gym === 'rev' ? 'richmond' : 'rev', '/api/m1-attendance-digest-job', { auth: false, body: raw, headers: { 'X-GIB-M1-Digest-Signature': digestSignature(raw, runtime(gym).adminActionToken) } });
    assert.equal((await handleAttendanceDigestJob(crossed, { ...dependencies, ...deps(gym === 'rev' ? 'richmond' : 'rev'), now: undefined })).status, 403);
    const bad = new Request(dispatches[0].url, { ...dispatches[0].init, headers: { ...dispatches[0].init.headers, [WORKFLOW_DISPATCH_HEADER]: '0'.repeat(64) } });
    assert.equal((await handleAttendanceDeliveryBackground(bad, dependencies)).status, 403);
  }
});

test('production dated observations use own live schedule/additions namespace and never project TEST or undated past evidence', async () => {
  for (const gym of ['rev', 'richmond']) {
    const store = new Store(), addedStore = new Store();
    const value = await loadDigestScheduleSnapshots({ target: 'production', gym, dates: ['2026-09-28', DATE], now: NOW, store, closingTime: '20:00', cutoffConfirmed: true, classFinishCutoffConfirmed: false }, {
      addedStore, currentSchedule: { site: gym === 'rev' ? 'Rev' : 'Richmond', timezone: 'America/New_York', current: true, fallback: 'none', fetchedAt: new Date(NOW).toISOString(), version: 'isolated-current', days: { Tuesday: [gym === 'rev' ? '6:00 PM Fixture BJJ' : '8:00 PM–9:00 PM Fixture BJJ'] } }
    });
    assert.equal(store.entries.get('schedules/production/' + gym + '/' + DATE).data.target, 'production');
    assert.equal(store.entries.has('schedules/test/' + gym + '/' + DATE), false);
    assert.equal(value.days[0].status, 'unavailable');
    assert.equal(value.days[1].occurrences.length, 1);
    if (gym === 'rev') {
      assert.equal(value.days[1].occurrences[0].eligibilityBasis, 'rev-reminder-20-v1');
      assert.equal(value.days[1].occurrences[0].reminderEligibleAt, '2026-09-30T00:00:00.000Z');
      assert.equal(value.days[1].occurrences[0].endAt, null, 'reminder rule never invents an actual finish');
    }
    else assert.equal(value.days[1].occurrences[0].endAt, '2026-09-30T01:00:00.000Z');
  }
});

test('own live Admin status stays authenticated, badge stays aggregate-only, and every TEST prototype path rejects live enabled settings', async () => {
  for (const gym of ['rev', 'richmond']) {
    const h = fixture(gym); await h.run('incomplete');
    const dependencies = { ...h.dependencies, now: undefined };
    assert.equal((await handleAttendanceWorkflow(request(gym, '/api/m1-attendance-workflow', { auth: false }), dependencies)).status, 401);
    const admin = await handleAttendanceWorkflow(request(gym, '/api/m1-attendance-workflow', { name: gym === 'richmond' ? 'Trey Martin' : 'Stuart Turner' }), dependencies);
    assert.equal(admin.status, 200); assert.equal((await admin.json()).target, 'production');
    const badge = await handleAttendanceWarning(request(gym, '/api/m1-attendance-warning', { auth: false }), dependencies);
    assert.equal(badge.status, 200); const status = await badge.json(); assert.equal(status.target, 'production'); assert.equal(status.gym, gym); assert.equal(status.status, 'attention');
    assert.doesNotMatch(JSON.stringify(status), /info@|andrew@|Fixture|messageId|html/);
    for (const [handler, path, body] of [[handleAttendanceGoogleEmail, '/api/m1-attendance-google-email', undefined], [handleAttendanceDigestEmail, '/api/m1-attendance-digest-email', undefined], [handleAttendanceWorkflowBackground, '/api/m1-attendance-workflow-background', { action: 'runDaily', requestId: uuid(123) }], [handleAttendanceWorkflow, '/api/m1-attendance-workflow', { action: 'runExamples', requestId: uuid(123) }]]) assert.equal((await handler(request(gym, path, { body }), dependencies)).status, 403);
    const rehearsal = await handleAttendanceDigest(request(gym, '/api/m1-attendance-digest?rehearsalId=' + uuid(123)), dependencies); assert.ok(rehearsal.status >= 400);
  }
});
