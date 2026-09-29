import { randomUUID } from 'node:crypto';
import { buildAttendanceDigest, defaultDigestConfiguration, digestHash, renderAttendanceDigest, datesThrough, DIGEST_ORIGIN } from './m1-attendance-digest.mjs';
import { localNow } from './m1-manager-review.mjs';
import { makeDigestBinding } from './m1-attendance-digest-outbox.mjs';
import { processAttendanceWorkflow, readWorkflowDeliveryHold } from './m1-attendance-digest-workflow.mjs';
import { readMailAppDelivery, deliverMailApp } from './m1-mailapp-delivery.mjs';
import { postGoogle } from './m1-common.mjs';

export const GOOGLE_EMAIL_TEST_DATE = '2026-09-28';
export const GOOGLE_EMAIL_TEST_ID = 'm1-test-scheduled-rev-' + GOOGLE_EMAIL_TEST_DATE;
export const GOOGLE_EMAIL_TEST_REQUEST_ID = '4d98c640-09c4-4dd1-a8e1-920928000001';
const ADDRESS = 'revbjjops@gmail.com', ROOT = 'google-email-test/' + GOOGLE_EMAIL_TEST_DATE + '/';
const SCHEMA = 'm1-google-email-test/v1', END = Date.parse('2026-09-29T04:00:00.000Z');
const clock = deps => (deps.clock || Date.now)();
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
const canonical = m => ({ messageId: m.messageId, from: m.from, to: m.to, cc: m.cc, subject: m.subject,
  html: m.html, text: m.text, synthetic: m.synthetic, target: m.target });
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function replaceOnce(value, source, replacement) {
  if (!value.includes(source) || value.indexOf(source) !== value.lastIndexOf(source)) fail('GOOGLE_EMAIL_TEMPLATE_CHANGED');
  return value.replace(source, () => replacement);
}
function requireScope(deps) {
  if (deps.scope?.target !== 'test' || deps.scope?.profile?.installationId !== 'rev' || deps.runtime?.target !== 'test') fail('GOOGLE_EMAIL_TEST_SCOPE_REQUIRED', 403);
}
function currentDate(deps) {
  const now = clock(deps);
  if (!Number.isSafeInteger(now) || localNow(new Date(now)).date !== GOOGLE_EMAIL_TEST_DATE || now >= END) fail('GOOGLE_EMAIL_DATE_EXPIRED', 409);
  return now;
}
async function storeFor(deps) {
  if (deps.workflowStore) return deps.workflowStore;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'gib-m1-digest-test-workflow-v1', consistency: 'strong' });
}
async function read(store, key) {
  const value = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (value !== null && (!value || !value.data || typeof value.etag !== 'string' || !value.etag)) fail('GOOGLE_EMAIL_STORAGE_UNAVAILABLE');
  return value;
}
async function write(store, key, value, before) {
  const result = await store.set(key, JSON.stringify(value), before ? { onlyIfMatch: before.etag } : { onlyIfNew: true });
  const after = await read(store, key);
  if (![true, false].includes(result?.modified) || !after || result.modified && digestHash(after.data) !== digestHash(value)) fail('GOOGLE_EMAIL_STORAGE_UNCONFIRMED');
  return { ...after, modified: result.modified };
}
function fixture(now, scope) {
  const configuration = defaultDigestConfiguration({ ...scope, syntheticRehearsal: true, profile: { ...scope.profile, gymName: 'Revolution TEST — fictional examples' } }, {
    GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME: '00:01', GIB_M1_DIGEST_CUTOFF_CONFIRMED: 'true', GIB_M1_ATTENDANCE_DIGEST_STU_EMAIL: ADDRESS,
    GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW: 'false', GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW: 'false'
  });
  // This closed one-message approval retains its original no-BCC v1 payload.
  // New daily reminder defaults cannot add a recipient or change its identity.
  for (const route of Object.values(configuration.routing)) delete route.bcc;
  delete configuration.classFinishCutoffConfirmed;
  // This is a fixture-only eligibility time, never saved as the gym's real closing time.
  configuration.dailyLocalTime = '00:01';
  const days = datesThrough(GOOGLE_EMAIL_TEST_DATE);
  const snapshots = [{ gym: 'rev', attendance: { ok: true, ledger: { ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true,
    gym: 'rev', from: days[0], to: GOOGLE_EMAIL_TEST_DATE, days: days.map(date => ({ date, attendanceHash: digestHash(['fictional-mailapp-test', date]), records: [], warnings: [], review: null })) } },
    staff: { ok: true, complete: true, items: [{ id: 'fictional-forgotten-finish', kind: 'forgotten-clock-out', date: GOOGLE_EMAIL_TEST_DATE,
      staffName: 'FICTIONAL staff member', status: 'pending', summary: 'An earlier shift has no confirmed finish. A manager would review it; no finish time or hours are guessed.' }] } }];
  const schedules = [{ gym: 'rev', timezone: 'America/New_York', days: days.map(date => ({ date, status: 'complete', observedAt: new Date(now).toISOString(),
    sourceVersion: 'fictional-one-email/v1', occurrences: date === GOOGLE_EMAIL_TEST_DATE ? [{ label: '12:01 AM FICTIONAL instructor class',
      startAt: date + 'T04:01:00.000Z', endAt: date + 'T04:02:00.000Z', cancelled: false }] : [] })) }];
  const digest = buildAttendanceDigest({ jobDate: GOOGLE_EMAIL_TEST_DATE, snapshots, schedules, configuration, now });
  if (digest.readFailures.length || digest.itemCount !== 2) fail('GOOGLE_EMAIL_FIXTURE_INVALID');
  return { configuration, digest, due: 'due', dueByGym: { rev: 'due' }, opportunityDueByGym: { rev: 'due' } };
}
export function buildGoogleEmailTestMessage(preparedAt) {
  const date = GOOGLE_EMAIL_TEST_DATE, classUrl = DIGEST_ORIGIN + '/m1/admin/?reviewDate=' + date + '#sign-ins', staffUrl = DIGEST_ORIGIN + '/m1/admin/#staff-time';
  const subject = '[TEST — FICTIONAL] Revolution attendance review — 28 September 2026';
  const introduction = 'One authorized TEST email from and to revbjjops@gmail.com, with no CC. These two examples are fictional; no real attendance or staff records were read, created, or changed.';
  const prepared = 'Prepared ' + new Date(preparedAt).toISOString() + '. This is a fictional example, not a live attendance assessment. No recurring sending or real closing time is approved.';
  const footer = 'These links open existing Revolution TEST Admin screens. They do not create these fictional records. Google submission does not confirm inbox delivery.';
  const rendered = renderAttendanceDigest({ date, syntheticRehearsal: true, routedGym: 'rev', shouldCapture: true, recipients: [{ name: 'Approved TEST recipient', address: ADDRESS }], cc: [],
    groups: [{ gym: 'rev', name: 'Revolution TEST — fictional examples', items: [
      { date, summary: 'FICTIONAL instructor class — a finished class has no instructor sign-in. A manager would check the class attendance.', url: classUrl },
      { date, summary: 'FICTIONAL Staff Clock — an earlier shift has no confirmed finish. A manager would review it; no finish time or worked hours are guessed.', url: staffUrl }
    ] }], readFailures: [] });
  let html = replaceOnce(rendered.html, '<title>' + escape(rendered.subject) + '</title>', '<title>' + escape(subject) + '</title>');
  let text = replaceOnce(rendered.text, 'Subject: ' + rendered.subject, 'Subject: ' + subject);
  for (const [prior, next] of [
    ['Controlled synthetic rehearsal. These are isolated fixtures, not real attendance or instructions to correct records. No real closing time has been confirmed.', introduction],
    ['Late uploads and corrections are checked again in the next digest. A day being unreviewed alone is not an email trigger.', prepared],
    ['This is a capture preview; real delivery has not been tested.', footer]
  ]) { html = replaceOnce(html, escape(prior), escape(next)); text = replaceOnce(text, prior, next); }
  html = replaceOnce(html, 'TEST CAPTURE · sending disabled', 'ONE AUTHORIZED TEST EMAIL · FICTIONAL');
  text = replaceOnce(text, 'TEST CAPTURE — actual email sending is disabled.', 'ONE AUTHORIZED TEST EMAIL · FICTIONAL');
  const message = { messageId: GOOGLE_EMAIL_TEST_ID, from: ADDRESS, to: [ADDRESS], cc: [], subject, html, text, synthetic: true, target: 'test' };
  return { ...message, hash: digestHash(message) };
}
function validateOriginal(value) {
  if (!exact(value, ['schema', 'requestId', 'preparedAt', 'expiresAt', 'message']) || value.schema !== SCHEMA || value.requestId !== GOOGLE_EMAIL_TEST_REQUEST_ID
    || !Number.isSafeInteger(value.preparedAt) || value.expiresAt !== Math.min(value.preparedAt + 30 * 60000, END)
    || digestHash(value.message) !== digestHash(buildGoogleEmailTestMessage(value.preparedAt))) fail('GOOGLE_EMAIL_ORIGINAL_INVALID');
  return value;
}
function validateAuthorization(value, original) {
  if (!exact(value, ['schema', 'requestId', 'hash', 'state', 'expiresAt', 'owner', 'startedAt', 'completedAt', 'outcome'])
    || value.schema !== SCHEMA || value.requestId !== original.requestId || value.hash !== original.message.hash
    || !['prepared', 'queued', 'consumed', 'closed'].includes(value.state) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt > original.expiresAt
    || value.owner !== null && !/^[0-9a-f-]{36}$/.test(value.owner) || value.startedAt !== null && !Number.isSafeInteger(value.startedAt)
    || value.completedAt !== null && !Number.isSafeInteger(value.completedAt) || ![null, 'completed', 'unavailable', 'disabled'].includes(value.outcome)) fail('GOOGLE_EMAIL_AUTHORIZATION_INVALID');
  return value;
}
async function original(store, prepare, deps) {
  let saved = await read(store, ROOT + 'original');
  if (!saved && prepare) {
    const now = currentDate(deps), value = { schema: SCHEMA, requestId: GOOGLE_EMAIL_TEST_REQUEST_ID, preparedAt: now, expiresAt: Math.min(now + 30 * 60000, END), message: buildGoogleEmailTestMessage(now) };
    saved = await write(store, ROOT + 'original', value, null);
  }
  if (!saved) fail('GOOGLE_EMAIL_ORIGINAL_REQUIRED', 409);
  return validateOriginal(saved.data);
}
function deliveryStore(store) {
  return { getWithMetadata: (path, options) => store.getWithMetadata('workflow/delivery/' + path, options),
    set: (path, value, options) => store.set('workflow/delivery/' + path, value, options) };
}
function engineStore(store) {
  const pathFor = path => path.startsWith('workflow/delivery/') ? path : ROOT + 'engine/' + path;
  return { getWithMetadata: (path, options) => store.getWithMetadata(pathFor(path), options), set: (path, value, options) => store.set(pathFor(path), value, options) };
}
function policy(value, deps) {
  return { canonical, validMessage: message => digestHash(message) === digestHash(value.message), gate: () => ({ state: 'disabled', code: 'GOOGLE_EMAIL_STATUS_ONLY' }),
    request: async (message, options) => {
      if (options.action !== 'attendanceMailStatus') fail('GOOGLE_EMAIL_STATUS_ONLY');
      const response = await postGoogle(deps.runtime, options.action, { gym: 'rev', binding: options.binding, message }, deps.fetch || fetch);
      if (!response.readable) fail('GOOGLE_EMAIL_STATUS_UNAVAILABLE');
      return response.value;
    } };
}
async function blockers(store, value, deps) {
  const existing = await read(store, 'workflow/messages/' + GOOGLE_EMAIL_TEST_ID);
  if (existing) return ['GOOGLE_EMAIL_DAY_ALREADY_USED'];
  const legacy = await read(store, 'workflow/delivery/messages/' + GOOGLE_EMAIL_TEST_ID);
  if (legacy) return ['MAILAPP_LEGACY_PROVIDER_RECORD'];
  const google = await read(store, 'workflow/delivery/mailapp/messages/' + GOOGLE_EMAIL_TEST_ID);
  if (google && digestHash(google.data.message) !== digestHash(value.message)) return ['GOOGLE_EMAIL_DAY_ALREADY_USED'];
  if (await readWorkflowDeliveryHold(value.message, deps.scope, { ...deps, workflowStore: store })) return ['GOOGLE_EMAIL_EXISTING_DELIVERY_HOLD'];
  return [];
}
export async function googleEmailTestState(deps = {}, prepare = true) {
  requireScope(deps); const store = await storeFor(deps), value = await original(store, prepare, deps);
  let auth = await read(store, ROOT + 'authorization');
  if (!auth && prepare) auth = await write(store, ROOT + 'authorization', { schema: SCHEMA, requestId: value.requestId, hash: value.message.hash,
    state: 'prepared', expiresAt: value.expiresAt, owner: null, startedAt: null, completedAt: null, outcome: null }, null);
  if (!auth) fail('GOOGLE_EMAIL_AUTHORIZATION_REQUIRED', 409);
  validateAuthorization(auth.data, value);
  const codes = await blockers(store, value, deps), now = clock(deps);
  if (deps.env?.GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED === 'true') codes.push('GOOGLE_EMAIL_GENERAL_SENDING_ENABLED');
  if (now >= auth.data.expiresAt) codes.push('GOOGLE_EMAIL_AUTHORIZATION_EXPIRED');
  if (auth.data.state !== 'prepared') codes.push('GOOGLE_EMAIL_AUTHORIZATION_CONSUMED');
  const delivery = await readMailAppDelivery(value.message, { ...deps, deliveryStore: deliveryStore(store) }, policy(value, deps));
  if (delivery.state !== 'not-started') codes.push('GOOGLE_EMAIL_ORIGINAL_RETAINED');
  const pending = ['queued', 'consumed'].includes(auth.data.state) && now < auth.data.expiresAt;
  return { ok: true, target: 'test', provider: 'mailapp', recurringEnabled: false, sendingEnabled: codes.length === 0,
    requestId: value.requestId, message: value.message, delivery,
    request: { requestId: value.requestId, state: pending ? 'pending' : auth.data.state === 'prepared' && !codes.length ? 'prepared' : auth.data.state === 'closed' ? 'complete' : 'disabled' },
    readiness: { ready: codes.length === 0, oneMessageOnly: true, exactRecipientApproved: true,
      generalSendingEnabled: deps.env?.GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED === 'true', expiresAt: auth.data.expiresAt, codes } };
}
export async function queueGoogleEmailTest(messageId, hash, deps = {}) {
  requireScope(deps); currentDate(deps); const store = await storeFor(deps), value = await original(store, false, deps);
  if (messageId !== value.message.messageId || hash !== value.message.hash) fail('GOOGLE_EMAIL_REVIEW_CHANGED', 409);
  const auth = await read(store, ROOT + 'authorization'); if (!auth) fail('GOOGLE_EMAIL_AUTHORIZATION_REQUIRED', 409);
  validateAuthorization(auth.data, value);
  if (auth.data.state !== 'prepared') return { dispatch: auth.data.state === 'queued' && clock(deps) < auth.data.expiresAt, state: await googleEmailTestState(deps, false) };
  const state = await googleEmailTestState(deps, false); if (!state.sendingEnabled) fail('GOOGLE_EMAIL_NOT_READY', 409);
  const queued = await write(store, ROOT + 'authorization', { ...auth.data, state: 'queued', expiresAt: Math.min(clock(deps) + 5 * 60000, value.expiresAt) }, auth);
  return { dispatch: queued.modified, state: await googleEmailTestState(deps, false) };
}
export async function disableGoogleEmailTest(deps = {}) {
  requireScope(deps); const store = await storeFor(deps), value = await original(store, false, deps), auth = await read(store, ROOT + 'authorization');
  if (!auth) fail('GOOGLE_EMAIL_AUTHORIZATION_REQUIRED', 409); validateAuthorization(auth.data, value);
  await write(store, ROOT + 'authorization', { ...auth.data, state: 'closed', completedAt: clock(deps), outcome: 'disabled' }, auth);
  return googleEmailTestState(deps, false);
}
export async function checkGoogleEmailOriginal(deps = {}) {
  requireScope(deps); const store = await storeFor(deps), value = await original(store, false, deps);
  const delivery = await deliverMailApp(value.message, { ...deps, statusOnly: true, deliveryStore: deliveryStore(store) }, policy(value, deps));
  return { ...await googleEmailTestState(deps, false), delivery };
}
export async function runGoogleEmailTest(requestId, deps = {}) {
  requireScope(deps); const store = await storeFor(deps), value = await original(store, false, deps);
  if (requestId !== value.requestId) fail('GOOGLE_EMAIL_ORIGINAL_REQUIRED', 409);
  const before = await read(store, ROOT + 'authorization'); if (!before) fail('GOOGLE_EMAIL_AUTHORIZATION_REQUIRED', 409);
  validateAuthorization(before.data, value);
  if (before.data.state !== 'queued' || clock(deps) >= before.data.expiresAt) return googleEmailTestState(deps, false);
  currentDate(deps); if ((await blockers(store, value, deps)).length) { await disableGoogleEmailTest(deps); return googleEmailTestState(deps, false); }
  const owner = randomUUID(), started = await write(store, ROOT + 'authorization', { ...before.data, state: 'consumed', owner, startedAt: clock(deps) }, before);
  if (!started.modified) return googleEmailTestState(deps, false);
  let outcome = 'unavailable';
  try {
    const assessedAt = clock(deps), input = fixture(assessedAt, deps.scope); input.binding = makeDigestBinding(value.requestId, 'scheduled', assessedAt);
    // These flags exist only inside this one consumed invocation, never in site configuration.
    const env = { ...(deps.env || {}), GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_ATTENDANCE_DIGEST_VERIFIED_SENDER: ADDRESS,
      GIB_M1_ATTENDANCE_DIGEST_VERIFIED_RECIPIENTS: ADDRESS };
    const guardedFetch = async (url, options) => {
      let body; try { body = JSON.parse(options.body); } catch { fail('GOOGLE_EMAIL_REQUEST_INVALID'); }
      if (!['attendanceMailStatus', 'attendanceMailSend'].includes(body.action) || digestHash(body.message) !== digestHash(value.message)) fail('GOOGLE_EMAIL_REQUEST_INVALID');
      if (body.action === 'attendanceMailSend') {
        if ((await blockers(store, value, deps)).length) fail('GOOGLE_EMAIL_EXISTING_DELIVERY_HOLD');
        const active = await read(store, ROOT + 'authorization');
        if (!active) fail('GOOGLE_EMAIL_AUTHORIZATION_CONSUMED');
        validateAuthorization(active.data, value);
        if (active.data.state !== 'consumed' || active.data.owner !== owner || clock(deps) >= active.data.expiresAt) fail('GOOGLE_EMAIL_AUTHORIZATION_CONSUMED');
      }
      return (deps.fetch || fetch)(url, options);
    };
    await (deps.processWorkflow || processAttendanceWorkflow)(input, { ...deps, env, workflowStore: engineStore(store), simulatedProvider: undefined,
      mailappRuntime: deps.runtime, fetch: guardedFetch, transformMessage: () => canonical(value.message) });
    outcome = 'completed';
  } finally {
    const active = await read(store, ROOT + 'authorization');
    if (active?.data.owner === owner && active.data.state === 'consumed')
      await write(store, ROOT + 'authorization', { ...active.data, state: 'closed', completedAt: clock(deps), outcome }, active);
  }
  return googleEmailTestState(deps, false);
}
