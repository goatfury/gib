import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { ADMIN_NAMES, ADMIN_COOKIE, ADMIN_REQUEST_HEADER, adminNamesForScope, createAdminSession,
  readAdminSession, requireAdmin, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { sanitizeDailyReviewPayload } from '../netlify/functions/_lib/m1-admin-contracts.mjs';
import { handleAdminLogin } from '../netlify/functions/m1-admin-login.mjs';
import { handleAdminReview } from '../netlify/functions/m1-admin-review.mjs';
import { handleAdminAdd } from '../netlify/functions/m1-admin-add.mjs';
import { handleAdminStaffTime } from '../netlify/functions/m1-admin-staff-time.mjs';

const ORIGIN = 'https://gib-richmond-test.netlify.app';
const NOW = Date.parse('2026-09-29T18:00:00Z');
const TOKEN = 'q'.repeat(43);
const SCOPE = { installationId: 'richmond', environment: 'test', target: 'test', preview: true };
const ENV = {
  GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'test',
  GIB_RICHMOND_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_REVIEWER_TEST/exec',
  GIB_RICHMOND_TEST_WEBHOOK_TOKEN: 'richmond-test-receiver-1234567890abcdef',
  GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN: 'richmond-test-admin-1234567890abcdef',
  GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_REV_REVIEWER_TEST/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'rev-test-receiver-1234567890abcdef',
  GIB_TEST_ADMIN_ACTION_TOKEN: 'rev-test-admin-1234567890abcdefghijkl',
  GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_REV_REVIEWER_PRODUCTION/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'rev-production-receiver-1234567890abcdef',
  GIB_M1_ADMIN_ACTION_TOKEN: 'rev-production-admin-1234567890abcdef',
  GIB_M1_ADMIN_PASSPHRASE: 'violet harbor maple lantern',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_REVIEWER_PRODUCTION/exec',
  GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'richmond-production-receiver-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'richmond-production-admin-1234567890abcdef',
  GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'cedar orbit copper meadow',
  GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'richmond-production-device-1234567890abcdef'
};
const deps = { env: ENV, installationId: 'richmond', environment: 'test', now: NOW, dateNow: new Date(NOW) };
const runtime = runtimeConfig(ENV, { ...SCOPE, admin: true, requestUrl: ORIGIN + '/m1/admin/' });
const session = () => createAdminSession('Trey Martin', runtime.sessionSecret, NOW, TOKEN, runtime);
function request(path, body, { origin = ORIGIN, cookie = session(), token = TOKEN } = {}) {
  return new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`, [ADMIN_REQUEST_HEADER]: token }, body: JSON.stringify(body) });
}
const audit = { auditId: 'audit-row-2', actionNumber: 1, adminName: 'Trey Martin', actionTime: '2026-09-29 10:00:00',
  instructor: 'QA TEST Richmond identity', classDate: '2026-09-28', classLabel: '6:00 PM QA TEST class', site: 'Richmond',
  duration: 1, reason: 'Synthetic correction verification', result: 'added', linkedRecordId: 'gib-admin-m1-2026-09-28-' + 'a'.repeat(24) };
const daily = (row = audit) => ({ ok: true, date: audit.classDate, records: [], warnings: [], auditHistory: [row] });
const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');

test('Trey is allowed only by the full trusted Richmond TEST runtime; global identities stay unchanged', () => {
  assert.deepEqual(ADMIN_NAMES, ['Andrew Smith', 'Stuart Turner']);
  assert.deepEqual(adminNamesForScope(runtime), [...ADMIN_NAMES, 'Trey Martin']);
  for (const scope of [undefined, {}, { ...SCOPE, installationId: 'rev' }, { ...SCOPE, environment: 'production' },
    { ...SCOPE, target: 'production' }, { ...SCOPE, preview: false }, { ...SCOPE, preview: 'true' }]) {
    assert.deepEqual(adminNamesForScope(scope), ADMIN_NAMES);
    assert.throws(() => createAdminSession('Trey Martin', runtime.sessionSecret, NOW, TOKEN, scope));
    assert.equal(readAdminSession(session(), runtime.sessionSecret, NOW, scope), null);
  }
});

test('the retained signed session binds Trey to Richmond TEST, expiry and the original page token', () => {
  const value = session();
  assert.equal(readAdminSession(value, runtime.sessionSecret, NOW, runtime).adminName, 'Trey Martin');
  assert.equal(readAdminSession(value, runtime.sessionSecret, NOW + 1800000, runtime), null);
  assert.equal(readAdminSession(value, 'different-secret', NOW, runtime), null);
  assert.equal(requireAdmin(request('/api/m1-admin-review', {}, { cookie: value }), runtime, NOW).session.adminName, 'Trey Martin');
  assert.equal(requireAdmin(request('/api/m1-admin-review', {}, { token: 'wrong' }), runtime, NOW).response.status, 403);
  const payload = JSON.parse(Buffer.from(value.split('.')[0], 'base64url'));
  const sign = input => {
    const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
    const key = createHash('sha256').update('gib-m1-admin:' + runtime.sessionSecret).digest();
    return encoded + '.' + createHmac('sha256', key).update(encoded).digest('base64url');
  };
  for (const altered of [{ ...payload, s: 'rev:test' }, { ...payload, s: 'richmond:production' },
    Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 's'))]) {
    assert.equal(readAdminSession(sign(altered), runtime.sessionSecret, NOW, runtime), null, 'even validly signed wrong-scope claims are rejected');
  }
  for (const name of ADMIN_NAMES) {
    const old = createAdminSession(name, runtime.sessionSecret, NOW, TOKEN);
    assert.equal(readAdminSession(old, runtime.sessionSecret, NOW, runtime).adminName, name);
    assert.equal(Object.hasOwn(JSON.parse(Buffer.from(old.split('.')[0], 'base64url')), 's'), false);
  }
});

test('actual login accepts the source-backed name only on canonical or immutable Richmond TEST', async () => {
  for (const origin of [ORIGIN, 'https://' + 'a'.repeat(24) + '--gib-richmond-test.netlify.app']) {
    const response = await handleAdminLogin(request('/api/m1-admin-login', { adminName: 'Trey Martin', testShortcut: true }, { origin }), deps);
    assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.adminName, 'Trey Martin'); assert.equal(data.test, true);
    const cookie = decodeURIComponent(response.headers.get('set-cookie').split(';')[0].split('=').slice(1).join('='));
    assert.equal(readAdminSession(cookie, runtime.sessionSecret, NOW, runtime).adminName, 'Trey Martin');
  }
  for (const name of ['Trey', 'info@richmondbjj.com', 'Someone Else']) {
    assert.equal((await handleAdminLogin(request('/api/m1-admin-login', { adminName: name, testShortcut: true }), deps)).status, 400);
  }
  for (const [origin, installationId, environment] of [
    ['https://deploy-preview-89--gib-live.netlify.app', 'rev', 'test'], ['https://gib-live.netlify.app', 'rev', 'production'],
    ['https://gib-richmond-live.netlify.app', 'richmond', 'production']]) {
    const response = await handleAdminLogin(request('/api/m1-admin-login', { adminName: 'Trey Martin', testShortcut: true }, { origin }),
      { ...deps, env: { ...ENV, GIB_M1_ENVIRONMENT: environment,
        GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true' }, installationId, environment, activation: 'active' });
    assert.equal(response.status, 400, origin);
  }
  assert.equal((await handleAdminLogin(request('/api/m1-admin-login', { adminName: 'Trey Martin', testShortcut: true }, { origin: 'https://foreign.example' }), deps)).status, 503);
});

test('Daily Review accepts Trey audit evidence only in Richmond TEST and retains malformed/foreign rejection', async () => {
  const options = { adminScope: runtime, managerReviewTestSite: 'Richmond' };
  assert.ok(sanitizeDailyReviewPayload(daily(), audit.classDate, options));
  for (const adminScope of [undefined, { ...runtime, installationId: 'rev' }, { ...runtime, target: 'production' }]) {
    assert.equal(sanitizeDailyReviewPayload(daily(), audit.classDate, { ...options, adminScope }), null);
  }
  for (const row of [{ ...audit, site: 'Rev' }, { ...audit, adminName: 'Trey' }, { ...audit, actionNumber: 0 }, { ...audit, extra: true }]) {
    assert.equal(sanitizeDailyReviewPayload(daily(row), audit.classDate, options), null);
  }
  const response = await handleAdminReview(request('/api/m1-admin-review', { date: audit.classDate }),
    { ...deps, fetch: async () => new Response(JSON.stringify(daily())) });
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.adminName, 'Trey Martin'); assert.deepEqual(data.auditHistory, [audit]);
});

test('correction uses the authenticated Trey attribution and exact original receipt; Staff Clock stays disabled', async () => {
  const original = { requestId: 'm1-2026-09-28-' + 'a'.repeat(24), date: audit.classDate, classLabel: audit.classLabel,
    duration: 1, instructor: audit.instructor, site: 'Richmond', notes: '', reason: audit.reason };
  const sent = [];
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    assert.equal(body.adminName, 'Trey Martin'); assert.equal(body.installation, 'richmond');
    assert.equal(body.environment, 'test'); assert.equal(body.target, 'test');
    return new Response(JSON.stringify({ ok: true, result: 'added', requestId: original.requestId,
      linkedRecordId: audit.linkedRecordId, linkedDisplayId: 'sheet-row-2', auditActionNumber: 1,
      confirmation: { adminName: 'Trey Martin', ...Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'requestId')) } }));
  };
  const response = await handleAdminAdd(request('/api/m1-admin-add', original), { ...deps, fetch });
  assert.equal(response.status, 200); assert.equal((await response.json()).confirmation.adminName, 'Trey Martin');
  assert.equal(sent.length, 1);
  assert.equal((await handleAdminAdd(request('/api/m1-admin-add', { ...original, adminName: 'Andrew Smith' }), { ...deps, fetch })).status, 400);
  const staff = await handleAdminStaffTime(request('/api/m1-admin-staff-time', { action: 'read' }),
    { ...deps, fetch: async () => { throw new Error('Staff must remain disabled'); } });
  assert.equal(staff.status, 404);
  assert.equal(sent.length, 1);
});

function uiScope(installation, origin) {
  const options = [];
  const context = vm.createContext({ INSTALLATION: installation, IS_RICHMOND: installation.installationId === 'richmond',
    location: new URL(origin), document: { createElement: () => ({}), getElementById: () => ({ append: value => options.push(value) }) } });
  const source = html.slice(html.indexOf('const RICHMOND_TEST_ADMIN_ENABLED ='), html.indexOf('const REV_REMOVAL_ENABLED ='));
  vm.runInContext(source + '\nthis.enabled = RICHMOND_TEST_ADMIN_ENABLED;', context);
  return { enabled: context.enabled, options };
}
test('client exposes Trey only on the actual Richmond TEST profile and hosts', () => {
  for (const origin of [ORIGIN, 'https://' + 'b'.repeat(24) + '--gib-richmond-test.netlify.app']) {
    const result = uiScope(SCOPE, origin); assert.equal(result.enabled, true);
    assert.deepEqual(result.options.map(option => option.value), ['Trey Martin']);
  }
  for (const [profile, origin] of [[{ ...SCOPE, installationId: 'rev' }, ORIGIN], [{ ...SCOPE, environment: 'production' }, ORIGIN],
    [SCOPE, 'https://gib-richmond-live.netlify.app'], [SCOPE, 'https://deploy-preview-89--gib-live.netlify.app'],
    [SCOPE, 'http://gib-richmond-test.netlify.app'], [SCOPE, ORIGIN + ':8443']]) {
    assert.deepEqual(uiScope(profile, origin).options, []);
  }
});

test('actual client Daily Review validators recognize scoped Trey history without relaxing retained audits', () => {
  const source = html.slice(html.indexOf('function exactObjectKeys('), html.indexOf('function validAdminAdditionResponse('));
  for (const enabled of [false, true]) {
    const context = vm.createContext({ REVIEW_NOTES_MAX_LENGTH: 800, RICHMOND_REVIEWER_ENABLED: enabled, RICHMOND_REVIEW_HISTORY_ENABLED: enabled, testMode: true });
    vm.runInContext(source + '\nthis.validate = validDailyReviewResponse;', context);
    const response = { ...daily(), test: true, adminName: 'Trey Martin' };
    assert.equal(context.validate(response, audit.classDate), enabled);
    assert.equal(context.validate({ ...response, test: false }, audit.classDate), false);
    assert.equal(context.validate({ ...response, auditHistory: [{ ...audit, site: 'Rev' }] }, audit.classDate), false);
    assert.equal(context.validate({ ...response, auditHistory: [audit, { ...audit, auditId: 'audit-row-3' }] }, audit.classDate), false);
  }
});

test('Richmond reminder panel mount is canonical TEST-only and cannot enable Staff Recovery or mail sending panels', () => {
  const source = html.slice(html.indexOf('const ATTENDANCE_REMINDER_TEST_ENABLED ='), html.indexOf('const STAFF_CLOCK_PAIRING_ENABLED ='));
  const enabled = (profile, origin, settings = { enabled: true, target: 'test' }) => {
    const context = vm.createContext({ INSTALLATION: profile, IS_RICHMOND: profile.installationId === 'richmond',
      M1_MANAGER_REVIEW_CONFIG: settings, RECOVERY_PILOT_TARGET: settings.target, location: new URL(origin) });
    vm.runInContext(source + '\nthis.result = ATTENDANCE_REMINDER_TEST_ENABLED;', context); return context.result;
  };
  assert.equal(enabled(SCOPE, ORIGIN), true);
  assert.equal(enabled({ installationId: 'rev' }, 'https://deploy-preview-89--gib-live.netlify.app'), true);
  for (const origin of ['https://gib-richmond-live.netlify.app', 'https://' + 'b'.repeat(24) + '--gib-richmond-test.netlify.app',
    'https://deploy-preview-89--gib-live.netlify.app', 'http://gib-richmond-test.netlify.app', ORIGIN + ':8443']) {
    assert.equal(enabled(SCOPE, origin), false);
  }
  assert.equal(enabled({ ...SCOPE, environment: 'production' }, ORIGIN), false);
  assert.equal(enabled(SCOPE, ORIGIN, { enabled: false, target: 'test' }), false);
  assert.equal(enabled(SCOPE, ORIGIN, { enabled: true, target: 'production' }), false);
  for (const name of ['attendanceDigest', 'attendanceWorkflow']) {
    const mount = html.slice(html.indexOf(name + ' = globalThis.'), html.indexOf('\n      });', html.indexOf(name + ' = globalThis.')));
    assert.match(mount, /enabled: ATTENDANCE_REMINDER_TEST_ENABLED/);
  }
  for (const name of ['staffRecoveryReview', 'attendanceEmail', 'attendanceGoogleEmail']) {
    const mount = html.slice(html.indexOf(name + ' = globalThis.'), html.indexOf('\n      });', html.indexOf(name + ' = globalThis.')));
    assert.match(mount, /enabled:.*RECOVERY_PILOT_ENABLED/); assert.doesNotMatch(mount, /ATTENDANCE_REMINDER_TEST_ENABLED/);
  }
});
