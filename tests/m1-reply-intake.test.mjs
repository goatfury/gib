import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { digestHash } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { MAILBOX, MANAGERS, REPLY_PREFIX, replyEvent, prepareReplyEvent, ingestReply, recordReplyPoll, replyQueue, reviewReply, reconcileReplyPayroll, replySignature } from '../netlify/functions/_lib/m1-reply-intake.mjs';
import { handleReplyIntake } from '../netlify/functions/m1-reply-intake.mjs';
import { runtimeConfig, createAdminSession, ADMIN_COOKIE, ADMIN_REQUEST_HEADER } from '../netlify/functions/_lib/m1-common.mjs';

const ID = '11111111-1111-4111-8111-111111111111', REVIEW = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-11T01:00:00Z'), DATE = '2026-10-10', LABEL = '7:15 PM BJJ', NAME = 'Canonical Instructor';
const scope = gym => ({ target: 'production', profile: { installationId: gym, environment: 'production', activation: 'active' }, liveFeatures: { reminders: true } });
const plain = value => JSON.parse(JSON.stringify(value));
function memory() {
  const entries = new Map(); let serial = 0, failKey = null;
  return { entries, fail: key => { failKey = key; }, async getWithMetadata(key) { return structuredClone(entries.get(key) || null); },
    async list({ prefix }) { return { blobs: [...entries.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
    async set(key, raw, { onlyIfNew } = {}) {
      if (key.includes(failKey || '\0')) throw Error('storage unavailable');
      if (onlyIfNew && entries.has(key)) return { modified: false };
      entries.set(key, { data: JSON.parse(raw), etag: String(++serial) }); return { modified: true };
    } };
}
function fixture(gym = 'rev') {
  const itemId = digestHash([gym, 'missing-instructor', DATE, LABEL.toLowerCase()]).slice(0, 24);
  const report = { rendered: { subject: 'Attendance ' + DATE, text: 'Attendance', html: '<p>Attendance</p>' } };
  const check = { binding: { requestId: ID, jobDate: DATE, createdAt: NOW - 600000 },
    digest: { groups: [{ gym, items: [{ id: itemId, kind: 'missing-instructor', date: DATE, summary: LABEL + ' has no valid instructor sign-in.' }] }] },
    snapshots: [{ gym, attendance: { ledger: { days: [{ date: DATE, attendanceHash: 'a'.repeat(64), records: [] }, { date: '2026-10-09', records: [{ recordId: 'prior', instructor: NAME, classLabel: LABEL, duration: 1 }] }] } } }],
    schedules: [{ gym, days: [{ date: DATE, occurrences: [{ label: LABEL }] }] }] };
  const event = replyEvent(check, scope(gym), report);
  const message = { gmailId: 'abcdef1234567890', threadId: 'abcdef0000000000', eventId: ID, from: MANAGERS[gym].address, to: [MAILBOX],
    rfcId: '<reply@example.invalid>', inReplyTo: '<sent@example.invalid>', references: ['<sent@example.invalid>'], receivedAt: NOW - 60000,
    subject: 'Re: ' + event.subject, body: NAME + ' taught the listed class.', authenticated: true, truncated: false,
    parent: { gmailId: 'abcdef9999999999', threadId: 'abcdef0000000000', rfcId: '<sent@example.invalid>', from: MAILBOX, to: [MANAGERS[gym].address],
      replyTo: MAILBOX, subject: event.subject, sent: true, sentAt: NOW - 500000 } };
  const review = { id: digestHash([MAILBOX, message.gmailId]), reviewId: REVIEW, cause: 'unresolved', reason: 'Manager confirms this exact item; human review still required.',
    decision: 'propose-correction', itemId, instructor: NAME, action: 'add-attendance', duration: 1 };
  return { gym, event, check, report, message, review };
}
async function seeded(gym = 'rev') {
  const f = fixture(gym), store = memory();
  await prepareReplyEvent(f.check, scope(gym), f.report, { replyStore: store }); return { ...f, store };
}
test('both gyms retain exact question, manager, canonical name, attendance hash and payroll period without changing send claims', async () => {
  for (const gym of ['rev', 'richmond']) {
    const f = await seeded(gym); f.store.entries.set('mailapp/messages/original', { data: { immutable: true }, etag: 'original' });
    const before = structuredClone(f.store.entries.get('mailapp/messages/original'));
    const receipt = await ingestReply(f.store, gym, f.message, NOW);
    assert.equal(receipt.new, true); assert.equal(receipt.state, 'needs-review');
    const queue = await replyQueue(f.store, gym, NOW);
    assert.equal(queue.items[0].questions[0].classLabel, LABEL); assert.equal(queue.items[0].manager.name, MANAGERS[gym].name);
    assert.equal(queue.items[0].cause, 'unresolved'); assert.equal(queue.items[0].causeReviewed, false);
    assert.equal(queue.items[0].attendanceWritten, false); assert.equal(queue.payrollReleaseEnabled, false);
    assert.deepEqual(f.store.entries.get('mailapp/messages/original'), before);
  }
});
test('replays and concurrent polls create one source; altered replay is a conflict', async () => {
  const f = await seeded();
  const receipts = await Promise.all([1,2,3].map(() => ingestReply(f.store, 'rev', f.message, NOW)));
  assert.equal(receipts.filter(r => r.new).length, 1);
  assert.equal((await ingestReply(f.store, 'rev', f.message, NOW + 86400000)).new, false);
  await assert.rejects(ingestReply(f.store, 'rev', { ...f.message, body: 'Changed' }, NOW), /REPLAY_CONFLICT/);
  assert.equal([...f.store.entries.keys()].filter(k => k.startsWith(REPLY_PREFIX + 'queue/')).length, 1);
});
test('wrong manager/gym, spoofed sender, recipient and missing event do not retain body or wake review', async () => {
  for (const change of [{ from: MANAGERS.richmond.address }, { authenticated: false }, { to: ['andrew@revolutionbjj.com'] }, { eventId: REVIEW }]) {
    const f = await seeded();
    const result = await ingestReply(f.store, 'rev', { ...f.message, ...change }, NOW);
    assert.equal(result.new, false); assert.equal((await replyQueue(f.store, 'rev', NOW)).items.length, 0);
    assert.equal(f.store.entries.get(REPLY_PREFIX + 'queue/' + result.id).data.body, null);
  }
  const f = await seeded(); await assert.rejects(ingestReply(f.store, 'richmond', f.message, NOW), /GYM_MISMATCH/);
});
test('both, stale threads, incomplete bodies and unverified parent stay held for human evidence', async () => {
  for (const [patch, expected, age] of [[{ body: 'Both were correct.' }, 'ambiguous-language', 0], [{}, 'stale-thread', 32 * 86400000],
    [{ truncated: true }, 'body-incomplete', 0], [{ parent: null }, 'thread-unverified', 0], [{ inReplyTo: '<other>', references: [] }, 'thread-unverified', 0]]) {
    const f = await seeded(); const r = await ingestReply(f.store, 'rev', { ...f.message, ...patch }, NOW + age);
    assert.equal(r.state, expected);
    await assert.rejects(reviewReply(f.store, 'rev', f.review, 'Andrew Smith', NOW + age), /AMBIGUITY/);
  }
});
test('storage failure preserves pending work and readback; review retry is idempotent and cannot overwrite an existing decision', async () => {
  const f = await seeded(); f.store.fail('queue/');
  await assert.rejects(ingestReply(f.store, 'rev', f.message, NOW)); f.store.fail(null);
  assert.equal((await ingestReply(f.store, 'rev', f.message, NOW)).new, true);
  f.store.fail('reviews/'); await assert.rejects(reviewReply(f.store, 'rev', f.review, 'Andrew Smith', NOW)); f.store.fail(null);
  const review = await reviewReply(f.store, 'rev', f.review, 'Andrew Smith', NOW);
  assert.deepEqual(await reviewReply(f.store, 'rev', f.review, 'Andrew Smith', NOW + 60000), review);
  await assert.rejects(reviewReply(f.store, 'rev', { ...f.review, duration: 0.5 }, 'Andrew Smith', NOW), /REVIEW_CONFLICT/);
  assert.equal(review.payrollReleased, false); assert.equal(review.attendanceWritten, false);
});
test('unknown/fuzzy instructor and wrong event cannot become a canonical proposal', async () => {
  for (const patch of [{ instructor: 'Canonical' }, { instructor: 'Another Person' }, { itemId: 'unknown' }, { duration: 0 }]) {
    const f = await seeded(); await ingestReply(f.store, 'rev', f.message, NOW);
    await assert.rejects(reviewReply(f.store, 'rev', { ...f.review, ...patch }, 'Andrew Smith', NOW), /CANONICAL_SELECTION/);
  }
});
test('missed poll, expired access and recovery have one stable exception key and confirmed coverage', async () => {
  const f = await seeded(); assert.equal((await replyQueue(f.store, 'rev', NOW)).health.code, 'poll-overdue');
  const poll = { requestId: ID, scanFrom: NOW - 3600000, scanThrough: NOW - 120000, createdAt: NOW, status: 'access-revoked', messages: [] };
  await recordReplyPoll(f.store, 'rev', poll, NOW);
  let health = (await replyQueue(f.store, 'rev', NOW)).health;
  assert.equal(health.code, 'access-revoked'); assert.equal(health.exceptionKey, 'rev:reply-intake');
  await recordReplyPoll(f.store, 'rev', { ...poll, requestId: REVIEW, createdAt: NOW + 1, status: 'complete', messages: [f.message] }, NOW + 1);
  health = (await replyQueue(f.store, 'rev', NOW + 1)).health; assert.equal(health.code, 'healthy');
  assert.equal((await replyQueue(f.store, 'rev', NOW + 4 * 3600000)).health.code, 'poll-overdue');
});
test('payroll compares actual saved credit/person/category/date and linked audit; a row or receipt alone never completes a correction', async () => {
  const f = await seeded('richmond'); await ingestReply(f.store, 'richmond', f.message, NOW);
  const review = await reviewReply(f.store, 'richmond', f.review, 'Andrew Smith', NOW);
  const row = { recordId: 'result-row', gym: 'richmond', date: DATE, classLabel: LABEL, instructor: NAME, duration: 1 };
  const evidence = { audit: { auditId: 'audit-1', sourceReplyId: review.sourceId, reviewId: REVIEW, gym: 'richmond', date: DATE,
    beforeAttendanceHash: 'a'.repeat(64), afterAttendanceHash: 'b'.repeat(64), resultRecordId: row.recordId }, attendanceHash: 'b'.repeat(64), attendance: [row],
    payroll: [{ ...row, auditId: 'audit-1', periodStart: review.selected.period.start, periodEnd: review.selected.period.end }] };
  const result = reconcileReplyPayroll(review, evidence); assert.equal(result.state, 'reconciled-for-human-review'); assert.equal(result.payrollReleased, false);
  for (const field of ['duration', 'instructor', 'classLabel', 'date', 'gym']) {
    const broken = structuredClone(evidence); broken.attendance[0][field] = field === 'duration' ? 1.75 : 'wrong';
    assert.equal(reconcileReplyPayroll(review, broken).code, 'PAYROLL_ATTENDANCE_DISCREPANCY');
  }
  for (const change of [{ audit: null }, { attendance: [] }, { payroll: [] }, { payroll: [evidence.payroll[0], evidence.payroll[0]] }]) assert.equal(reconcileReplyPayroll(review, { ...evidence, ...change }).state, 'held');
});

function googleHarness({ gym = 'rev', failure = null, enabled = true, messages = [] } = {}) {
  const properties = new Map([['GIB_M1_REPLY_INTAKE_ENABLED', String(enabled)], ['GIB_M1_REPLY_START_AT', String(NOW - 86400000)]]), calls = [], posts = [];
  class Clock extends Date { static now() { return NOW; } }
  const context = { Date: Clock, console, PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null, setProperty: (k,v) => properties.set(k,v) }) },
    gibM1LiveReminderScope_: () => ({ gym, target: 'production', digestUrl: 'https://' + (gym === 'rev' ? 'gib-live' : 'gib-richmond-live') + '.netlify.app/api/m1-attendance-digest-job' }),
    gibM1MailAppActor_: () => true, configuredAdminActionSecret_: () => 'fixture-secret', ScriptApp: { getOAuthToken: () => 'fixture-google-token' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { getUuid: () => ID, Charset: { UTF_8: 'UTF-8' }, base64DecodeWebSafe: value => Buffer.from(value, 'base64url'), newBlob: b => ({ getDataAsString: () => Buffer.from(b).toString('utf8') }),
      computeHmacSha256Signature: (data,key) => [...createHmac('sha256',key).update(data).digest()] },
    UrlFetchApp: { fetch(url, options) {
      calls.push({ url, options });
      if (url.includes('gmail.googleapis.com')) {
        assert.equal(options.method, 'get');
        const response = url.endsWith('/profile') ? { emailAddress: MAILBOX } : { messages };
        return { getResponseCode: () => failure === 'revoked' ? 401 : 200, getContentText: () => JSON.stringify(response) };
      }
      assert.equal(options.headers.Authorization, undefined); assert.ok(!options.payload.includes('fixture-google-token'));
      const body = JSON.parse(options.payload); posts.push(body);
      return { getResponseCode: () => failure === 'queue' ? 503 : 200, getContentText: () => JSON.stringify({ ok: true, accepted: true, requestId: body.requestId, newRelevant: [] }) };
    } } };
  vm.createContext(context); vm.runInContext(readFileSync(new URL('../integrations/google-apps-script/GibM1ReplyIntake.gs', import.meta.url), 'utf8'), context);
  return { context, properties, calls, posts };
}
test('a malformed message is durably quarantined without losing later replies or declaring an all-clear', async () => {
  const f = await seeded();
  const input = { requestId: ID, scanFrom: NOW - 3600000, scanThrough: NOW - 120000, createdAt: NOW, status: 'complete',
    messages: [{ gmailId: 'abcdef1111111111' }, f.message] };
  const result = await recordReplyPoll(f.store, 'rev', input, NOW);
  assert.equal(result.newRelevant.length, 1);
  const q = await replyQueue(f.store, 'rev', NOW); assert.equal(q.items.length, 1); assert.equal(q.rejections.length, 1);
  assert.equal(q.health.code, 'message-quarantined');
});
test('crash after queue write before checkpoint is repaired by replaying the retained interval', async () => {
  const f = await seeded();
  const poll = { requestId: ID, scanFrom: NOW - 3600000, scanThrough: NOW - 120000, createdAt: NOW, status: 'complete', messages: [f.message] };
  f.store.fail('polls/'); await assert.rejects(recordReplyPoll(f.store, 'rev', poll, NOW));
  assert.equal((await replyQueue(f.store, 'rev', NOW)).health.code, 'poll-overdue');
  f.store.fail(null); const retry = await recordReplyPoll(f.store, 'rev', poll, NOW);
  assert.deepEqual(retry.newRelevant, []); assert.equal((await replyQueue(f.store, 'rev', NOW)).items.length, 1);
  assert.equal((await replyQueue(f.store, 'rev', NOW)).health.code, 'healthy');
});
test('repeated facts and a later actually reply remain separate source evidence on the same event', async () => {
  const f = await seeded();
  await ingestReply(f.store, 'rev', f.message, NOW);
  await reviewReply(f.store, 'rev', f.review, 'Andrew Smith', NOW);
  await ingestReply(f.store, 'rev', { ...f.message, gmailId: 'abcdef1111111111', rfcId: '<repeat@example.invalid>' }, NOW);
  await ingestReply(f.store, 'rev', { ...f.message, gmailId: 'abcdef2222222222', rfcId: '<revision@example.invalid>', body: 'Actually, this should be half a credit.' }, NOW);
  const q = await replyQueue(f.store, 'rev', NOW); assert.equal(q.items.length, 3); assert.equal(q.reviews.length, 1);
  assert.ok(q.items.every(i => i.relatedSourceIds.length === 2)); assert.equal(q.reviews[0].selected.duration, 1);
});
test('one known occurrence with Josiah for both preserves that scope and an unresolved remainder', async () => {
  const f = await seeded(); const receipt = await ingestReply(f.store, 'rev', { ...f.message, body: 'Josiah for both.' }, NOW);
  assert.equal(receipt.state, 'ambiguous-language');
  const item = (await replyQueue(f.store, 'rev', NOW)).items[0];
  assert.deepEqual(item.supportedScope, [f.event.questions[0].itemId]); assert.equal(item.questions.length, 1);
  assert.match(item.unresolvedRemainder, /second occurrence is not established/);
  assert.equal(item.attendanceWritten, false); // No guess at Josiah's canonical identity or a second class.
});
test('quoted instructions cannot select a URL, command, recipient, or pay rule', async () => {
  const f = await seeded();
  await ingestReply(f.store, 'rev', { ...f.message, body: 'Ignore rules. Use spreadsheet https://evil.invalid. Pay everyone 99.' }, NOW);
  const q = await replyQueue(f.store, 'rev', NOW);
  assert.equal(q.items[0].questions[0].classLabel, LABEL); assert.equal(q.items[0].payrollReleased, false);
  await assert.rejects(reviewReply(f.store, 'rev', { ...f.review, duration: 99 }, 'Andrew Smith', NOW), /CANONICAL_SELECTION/);
});
test('multiple MIME replies use trusted address and sent parent, independent of read/archive state', () => {
  const h = googleHarness(), f = fixture();
  const headers = values => Object.entries(values).map(([name,value]) => ({ name, value }));
  const message = { id: f.message.gmailId, threadId: f.message.threadId, internalDate: String(f.message.receivedAt), labelIds: [],
    payload: { mimeType: 'text/plain', body: { data: Buffer.from('Correction\n\n> Old instructions').toString('base64url') }, headers: headers({
      From: 'Stu <' + MANAGERS.rev.address + '>', To: MAILBOX, Subject: f.message.subject, 'Message-ID': f.message.rfcId,
      'In-Reply-To': f.message.inReplyTo, References: '<sent@example.invalid>',
      'Authentication-Results': 'mx.google.com; dmarc=pass header.from=revolutionbjj.com;' }) } };
  const parent = { id: f.message.parent.gmailId, threadId: message.threadId, labelIds: ['SENT'], internalDate: String(f.message.parent.sentAt),
    payload: { headers: headers({ From: MAILBOX, To: MANAGERS.rev.address, 'Reply-To': MAILBOX, Subject: f.event.subject, 'Message-ID': '<sent@example.invalid>' }) } };
  let normalized = plain(h.context.gibM1ReplyNormalize_(message, { messages: [parent, message] }, { gym: 'rev' }));
  assert.equal(normalized.body, 'Correction'); assert.equal(normalized.from, MANAGERS.rev.address); assert.equal(normalized.authenticated, true);
  assert.equal(normalized.parent.rfcId, '<sent@example.invalid>');
  message.payload.headers.find(h => h.name === 'From').value = 'info@revolutionbjj.com <attacker@example.invalid>';
  normalized = plain(h.context.gibM1ReplyNormalize_(message, { messages: [parent, message] }, { gym: 'rev' }));
  assert.equal(normalized.from, 'attacker@example.invalid');
});
test('partial Gmail pagination never advances checkpoint or loses the original interval', () => {
  const h = googleHarness();
  const prior = h.context.gibM1ReplyGet_;
  h.context.gibM1ReplyGet_ = path => path.startsWith('messages?') ? { messages: [], nextPageToken: 'more' } : prior(path);
  assert.equal(h.context.pollBusinessAttendanceReplies().status, 'capacity-exceeded');
  assert.equal(h.properties.has('GIB_M1_REPLY_SCAN_THROUGH'), false);
  h.context.gibM1ReplyGet_ = prior;
  assert.equal(h.context.pollBusinessAttendanceReplies().ok, true);
  assert.equal(h.posts.at(-1).scanFrom, NOW - 86400000);
});
test('reviewer read failure is explicit, never a false empty queue', async () => {
  const f = await seeded();
  f.store.list = async () => { throw Error('read failure'); };
  await assert.rejects(replyQueue(f.store, 'rev', NOW), /read failure/);
});
test('hourly worker is disabled by default; approved business read polls are GET-only and cursor moves only after queue acknowledgement', () => {
  const off = googleHarness({ enabled: false }); assert.equal(off.context.pollBusinessAttendanceReplies().enabled, false); assert.equal(off.calls.length, 0);
  for (const gym of ['rev', 'richmond']) {
    const h = googleHarness({ gym }); assert.equal(h.context.pollBusinessAttendanceReplies().ok, true);
    assert.equal(h.properties.get('GIB_M1_REPLY_SCAN_THROUGH'), String(NOW - 120000));
    assert.ok(h.calls[1].url.includes('after%3A')); assert.equal(h.posts[0].gym, gym);
  }
  for (const failure of ['revoked', 'queue']) {
    const h = googleHarness({ failure });
    if (failure === 'queue') assert.throws(() => h.context.pollBusinessAttendanceReplies(), /QUEUE_UNCONFIRMED/);
    else { assert.equal(h.context.pollBusinessAttendanceReplies().status, 'access-revoked'); assert.equal(h.posts[0].messages.length, 0); }
    assert.equal(h.properties.has('GIB_M1_REPLY_SCAN_THROUGH'), false);
  }
});
test('routing requires verified flag and event marker; retains existing copies and never rewrites old mail', () => {
  const h = googleHarness(), f = fixture();
  const options = { to: MANAGERS.rev.address, bcc: 'andrew@revolutionbjj.com', replyTo: 'andrew@revolutionbjj.com', subject: f.event.subject,
    body: 'Your reply goes to Andrew at andrew@revolutionbjj.com. Andrew will update the spreadsheet during payroll, preserving the original records and correction history.', htmlBody: '<p>Body</p>' };
  const route = () => plain(h.context.gibM1ReplyMailOptions_({ gym: 'rev' }, options));
  assert.equal(route().replyTo, options.replyTo); assert.doesNotMatch(route().subject, /\[GiB/);
  h.properties.set('GIB_M1_REPLY_ROUTING_ENABLED', 'true'); assert.equal(route().replyTo, options.replyTo);
  h.properties.set('GIB_M1_REPLY_ROUTE_VERIFIED', 'v1'); assert.equal(route().replyTo, MAILBOX); assert.equal(route().bcc, options.bcc);
  assert.match(route().body, /private GiB/);
  assert.equal(h.context.gibM1ReplyMailOptions_({ gym: 'rev' }, { ...options, subject: 'Old reminder' }).replyTo, options.replyTo);
  assert.match(h.context.gibM1ReplyMailOptions_({ gym: 'rev' }, { ...options, body: 'Please reply here with any corrections and Andrew will update the record.' }).body, /private GiB/);
});
test('MIME parser strips quote/history/attachments and quarantines HTML-only or oversized text', () => {
  const h = googleHarness(), payload = text => ({ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } });
  assert.deepEqual(plain(h.context.gibM1ReplyText_(payload('Correction\n\nOn Friday the manager wrote:\nBoth'))), { body: 'Correction', truncated: false });
  assert.equal(h.context.gibM1ReplyText_({ mimeType: 'text/html', body: { data: 'AAAA' } }).truncated, true);
  assert.equal(h.context.gibM1ReplyText_(payload('a'.repeat(12001))).truncated, true);
});

function routeFixture(gym = 'rev') {
  const env = { GIB_M1_INSTALLATION: gym, GIB_M1_ENVIRONMENT: 'production', GIB_M1_REPLY_INTAKE_ENABLED: 'true', GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'true',
    GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/TEST_RECEIVER_PLACEHOLDER/exec',
    GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'isolated-receiver-secret-0123456789', GIB_M1_ADMIN_ACTION_TOKEN: 'isolated-admin-secret-0123456789', GIB_M1_ADMIN_PASSPHRASE: 'isolated amber forest meadow',
    GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_MAILAPP_LIVE_SEND_ENABLED: 'true' };
  if (gym === 'richmond') Object.assign(env, {
    GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true',
    GIB_RICHMOND_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/TEST_RICHMOND_PLACEHOLDER/exec',
    GIB_RICHMOND_PRODUCTION_WEBHOOK_TOKEN: 'isolated-richmond-receiver-0123456789',
    GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN: 'isolated-richmond-admin-0123456789',
    GIB_RICHMOND_PRODUCTION_ADMIN_PASSPHRASE: 'isolated coral ocean meadow',
    GIB_RICHMOND_PRODUCTION_DEVICE_TOKEN: 'isolated-richmond-device-0123456789'
  });
  const origin = 'https://' + (gym === 'rev' ? 'gib-live' : 'gib-richmond-live') + '.netlify.app';
  const context = { site: { name: gym === 'rev' ? 'gib-live' : 'gib-richmond-live', id: gym === 'rev' ? 'f748e737-11e3-4fab-8e8c-bf185eab29ff' : '9b7757a9-70f4-4977-9ca2-270b41e34007' }, deploy: { context: 'production', published: true } };
  const deps = { env, context, installationId: gym, environment: 'production', activation: 'active', clock: () => NOW, replyStore: memory() };
  const input = { schema: 'm1-reply-intake/v1', gym, target: 'production', action: 'poll', requestId: ID, createdAt: NOW, expiresAt: NOW + 60000, scanFrom: NOW - 3600000, scanThrough: NOW - 120000, messages: [], status: 'complete' };
  const request = patch => {
    const raw = JSON.stringify({ ...input, ...patch });
    return new Request(origin + '/api/m1-reply-intake', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GIB-M1-Reply-Signature': replySignature(raw, gym === 'rev' ? env.GIB_M1_ADMIN_ACTION_TOKEN : env.GIB_RICHMOND_PRODUCTION_ADMIN_ACTION_TOKEN) }, body: raw });
  };
  return { deps, request, origin };
}
for (const gym of ['rev', 'richmond']) test(gym + ' real endpoint permits own-gym signed intake; rejects preview, wrong gym, expired binding and unauthenticated queue reads', async () => {
  const h = routeFixture(gym);
  const response = await handleReplyIntake(h.request(), h.deps); assert.equal(response.status, 200, await response.text());
  for (const patch of [{ gym: gym === 'rev' ? 'richmond' : 'rev' }, { createdAt: NOW - 120000, expiresAt: NOW - 60000 }]) assert.equal((await handleReplyIntake(h.request(patch), h.deps)).status, 409);
  const off = { ...h.deps, env: { ...h.deps.env, GIB_M1_REPLY_INTAKE_ENABLED: 'false' } };
  assert.equal((await handleReplyIntake(h.request(), off)).status, 503);
  const preview = { ...h.deps, context: { ...h.deps.context, deploy: { context: 'deploy-preview', published: false } } };
  assert.equal((await handleReplyIntake(h.request(), preview)).status, 403);
  const url = h.origin + '/api/m1-reply-intake';
  assert.equal((await handleReplyIntake(new Request(url, { headers: { Origin: h.origin } }), h.deps)).status, 401);
  const runtime = runtimeConfig(h.deps.env, { admin: true, requestUrl: url, installationId: gym, environment: 'production', activation: 'active' });
  const requestToken = 'x'.repeat(43);
  const session = createAdminSession('Andrew Smith', runtime.sessionSecret, NOW, requestToken, runtime);
  const headers = { Origin: h.origin, Cookie: ADMIN_COOKIE + '=' + session, [ADMIN_REQUEST_HEADER]: requestToken };
  assert.equal((await handleReplyIntake(new Request(url, { headers }), h.deps)).status, 200);
});
