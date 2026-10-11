import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { prepareReplyAcceptance } from '../netlify/functions/_lib/m1-reply-acceptance.mjs';
import { handleReplyIntake } from '../netlify/functions/m1-reply-intake.mjs';
import { prepareReplyEvent, replySignature, replyQueue } from '../netlify/functions/_lib/m1-reply-intake.mjs';
const code = readFileSync(new URL('../integrations/google-apps-script/GibM1ReplyAcceptance.gs', import.meta.url), 'utf8');
globalThis.fetch = () => { throw Error('NETWORK_FORBIDDEN'); };
const NOW = Date.parse('2026-10-11T01:00:00Z'), ID = '33333333-3333-4333-8333-333333333333', REQUEST = '44444444-4444-4444-8444-444444444444';
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(gym) {
  const values = new Map(); let serial = 0;
  const store = { values, async getWithMetadata(key) { return structuredClone(values.get(key) || null); },
    async list({ prefix }) { return { blobs: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
    async set(key, text, options = {}) { if (options.onlyIfNew && values.has(key)) return { modified: false }; values.set(key, { data: JSON.parse(text), etag: String(++serial) }); return { modified: true }; } };
  const scope = { target: 'production', profile: { installationId: gym, environment: 'production', activation: 'active' }, liveFeatures: { reminders: true } };
  const env = { GIB_M1_REPLY_INTAKE_ENABLED: 'true', GIB_M1_REPLY_ACCEPTANCE_EVENT_ID: ID, GIB_M1_REPLY_ACCEPTANCE_START_AT: String(NOW - 1000), GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT: String(NOW + 1799000) };
  const input = { schema: 'm1-reply-intake/v1', action: 'prepare-acceptance', gym, target: 'production', eventId: ID, requestId: REQUEST, createdAt: NOW, expiresAt: NOW + 60000 };
  const prepare = (check, ownScope, report) => prepareReplyEvent(check, ownScope, report, { replyStore: store });
  return { gym, store, scope, env, input, prepare };
}
function sender(gym, patch = {}) {
  const props = new Map([['GIB_M1_REPLY_ACCEPTANCE_EVENT_ID', ID], ['GIB_M1_REPLY_ACCEPTANCE_START_AT', String(NOW - 1000)], ['GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT', String(NOW + 1799000)]]);
  const calls = [], writes = [], logs = []; let now = NOW;
  const context = { Date: { now: () => now }, GIB_M1_REPLY_SCHEMA_: 'm1-reply-intake/v1', console: { log: (...args) => logs.push(args) },
    gibM1ReplyScope_: () => { if (patch.wrongActor) throw Error('REPLY_ACCOUNT_UNVERIFIED'); return { gym, target: 'production' }; },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) || null,
      setProperty: (key, value) => { writes.push(key); if (patch.lostClaim && JSON.parse(value).state === 'call-pending') return; props.set(key, value); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !patch.busy, releaseLock() {} }) }, Utilities: { getUuid: () => REQUEST },
    MailApp: { getRemainingDailyQuota: () => patch.noQuota ? 0 : 10, sendEmail: options => {
      calls.push(plain(options)); assert.equal(JSON.parse(props.get('GIB_M1_REPLY_ACCEPTANCE_CLAIM_' + gym)).state, 'call-pending');
      if (patch.uncertain) throw Error('AMBIGUOUS_SEND_RESPONSE');
    } },
    gibM1ReplyPost_: (_, input) => { assert.equal(input.action, 'prepare-acceptance');
      if (patch.receiverFailure) throw Error('RECEIVER_UNAVAILABLE');
      if (patch.expireDuringPost) now += 1800000;
      return { schema: 'm1-reply-acceptance/v1', gym, eventId: ID,
        subject: 'GiB reply intake TEST ONLY - ' + (gym === 'rev' ? 'Revolution' : 'Richmond') + ' [GiB ' + gym + ' ' + ID + ']',
        mailbox: 'revbjjops@gmail.com', manager: patch.wrongRecipient ? 'outsider@example.invalid' : gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com', expiresAt: NOW + 1799000 };
    } };
  vm.createContext(context); vm.runInContext(code, context);
  return { context, props, calls, writes, logs };
}
for (const gym of ['rev','richmond']) {
  test(gym + ' candidate registration retries create exactly one synthetic event and no daily state', async () => {
    const f = fixture(gym);
    const result = await prepareReplyAcceptance(f.input, f.scope, f.env, NOW, f.prepare);
    assert.equal(result.eventId, ID);
    await prepareReplyAcceptance({ ...f.input, requestId: ID, createdAt: NOW + 1, expiresAt: NOW + 60001 }, f.scope, f.env, NOW + 1, f.prepare);
    assert.equal(f.store.values.size, 1);
    const [key, entry] = [...f.store.values][0]; assert.equal(key, 'reply-intake/v1/events/' + ID);
    assert.deepEqual(entry.data.questions, []); assert.deepEqual(entry.data.instructors, []); assert.match(entry.data.subject, /TEST ONLY/);
    assert.equal((await replyQueue(f.store, gym, NOW)).items.length, 0);
  });
  test(gym + ' candidate registrar rejects missing/long/expired lease, wrong identity, extra data and arbitrary event', async () => {
    for (const [inputPatch, envPatch, scopePatch, time] of [
      [{}, { GIB_M1_REPLY_ACCEPTANCE_EVENT_ID: '' }, {}, NOW], [{}, { GIB_M1_REPLY_ACCEPTANCE_START_AT: '0' }, {}, NOW],
      [{}, { GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT: String(NOW + 1800001) }, {}, NOW], [{}, {}, {}, NOW + 1800000],
      [{}, { GIB_M1_REPLY_INTAKE_ENABLED: 'false' }, {}, NOW], [{ gym: 'other' }, {}, {}, NOW],
      [{ eventId: REQUEST }, {}, {}, NOW], [{ body: 'unapproved data' }, {}, {}, NOW],
      [{}, {}, { target: 'test' }, NOW], [{}, {}, { profile: { installationId: gym === 'rev' ? 'richmond' : 'rev' } }, NOW]
    ]) {
      const f = fixture(gym);
      await assert.rejects(prepareReplyAcceptance({ ...f.input, ...inputPatch }, { ...f.scope, ...scopePatch }, { ...f.env, ...envPatch }, time, f.prepare), /NOT_APPROVED/);
      assert.equal(f.store.values.size, 0);
    }
  });
  test(gym + ' candidate sender uses fixed business route once and refuses repeat even with new event', () => {
    const s = sender(gym); assert.equal(s.context.sendBusinessReplyAcceptanceProbe().state, 'submitted');
    assert.equal(s.calls.length, 1); assert.equal(s.calls[0].replyTo, 'revbjjops@gmail.com');
    assert.equal(s.calls[0].to, gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com');
    assert.equal(s.calls[0].cc, undefined); assert.equal(s.calls[0].bcc, undefined); assert.match(s.calls[0].body, /TEST ONLY/);
    assert.throws(() => s.context.sendBusinessReplyAcceptanceProbe(), /ALREADY_CLAIMED/);
    s.props.set('GIB_M1_REPLY_ACCEPTANCE_EVENT_ID', REQUEST);
    assert.throws(() => s.context.sendBusinessReplyAcceptanceProbe(), /ALREADY_CLAIMED/);
    assert.equal(s.calls.length, 1); assert.ok(s.writes.every(key => key === 'GIB_M1_REPLY_ACCEPTANCE_CLAIM_' + gym));
  });
  test(gym + ' candidate sender uncertain send is never replayed; no provider-id claim', () => {
    const s = sender(gym, { uncertain: true }), result = s.context.sendBusinessReplyAcceptanceProbe();
    assert.equal(result.state, 'uncertain'); assert.equal(result.inboxArrivalConfirmed, false);
    assert.throws(() => s.context.sendBusinessReplyAcceptanceProbe(), /ALREADY_CLAIMED/); assert.equal(s.calls.length, 1);
  });
  test(gym + ' candidate sender stops before mail on wrong actor/recipient, quota, lock, expired lease, failed registration or lost claim', () => {
    for (const patch of [{ wrongActor: true }, { wrongRecipient: true }, { noQuota: true }, { busy: true },
      { expireDuringPost: true }, { receiverFailure: true }, { lostClaim: true }]) {
      const s = sender(gym, patch); assert.throws(() => s.context.sendBusinessReplyAcceptanceProbe()); assert.equal(s.calls.length, 0);
    }
    for (const key of ['GIB_M1_REPLY_ROUTING_ENABLED','GIB_M1_REPLY_ROUTE_VERIFIED']) {
      const s = sender(gym); s.props.set(key, key.endsWith('VERIFIED') ? 'v1' : 'true');
      assert.throws(() => s.context.sendBusinessReplyAcceptanceProbe(), /NOT_APPROVED/); assert.equal(s.calls.length, 0);
    }
  });
  test(gym + ' candidate receiver preserves authentication, deployment scope and disabled guard', async () => {
    const f = fixture(gym), name = gym === 'rev' ? 'gib-live' : 'gib-richmond-live', origin = 'https://' + name + '.netlify.app';
    const env = { ...f.env, GIB_M1_INSTALLATION: gym, GIB_M1_ENVIRONMENT: 'production', GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'true',
      GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/OFFLINE_FIXTURE/exec', GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'isolated-offline-receiver-secret-0123456789',
      GIB_M1_ADMIN_ACTION_TOKEN: 'isolated-offline-admin-secret-0123456789', GIB_M1_ADMIN_PASSPHRASE: 'isolated amber forest meadow',
      GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_MAILAPP_LIVE_SEND_ENABLED: 'true' };
    if (gym === 'richmond') Object.assign(env, { GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true',
      GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/OFFLINE_RICHMOND/exec', GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'isolated-richmond-receiver-0123456789',
      GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'isolated-richmond-admin-0123456789', GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'isolated coral ocean meadow', GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'isolated-richmond-device-0123456789' });
    const deps = { env, context: { site: { name, id: gym === 'rev' ? 'f748e737-11e3-4fab-8e8c-bf185eab29ff' : '9b7757a9-70f4-4977-9ca2-270b41e34007' },
      deploy: { context: 'production', published: true } }, installationId: gym, environment: 'production', activation: 'active', clock: () => NOW, replyStore: f.store };
    const raw = JSON.stringify(f.input), token = gym === 'rev' ? env.GIB_M1_ADMIN_ACTION_TOKEN : env.GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN;
    const request = signature => new Request(origin + '/api/m1-reply-intake', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-GIB-M1-Reply-Signature': signature } });
    assert.equal((await handleReplyIntake(request('0'.repeat(64)), deps)).status, 403); assert.equal(f.store.values.size, 0);
    assert.equal((await handleReplyIntake(request(replySignature(raw, token)), { ...deps, context: { ...deps.context, deploy: { context: 'deploy-preview', published: false } } })).status, 403);
    const accepted = await handleReplyIntake(request(replySignature(raw, token)), deps); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).eventId, ID); assert.equal(f.store.values.size, 1);
    env.GIB_M1_REPLY_INTAKE_ENABLED = 'false'; assert.equal((await handleReplyIntake(request(replySignature(raw, token)), deps)).status, 503);
  });
}
