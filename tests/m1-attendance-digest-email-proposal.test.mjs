import assert from 'node:assert/strict';
import test from 'node:test';
import { digestHash, renderAttendanceDigest } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { buildTestDigestEmail, TEST_EMAIL_MESSAGE_ID } from '../netlify/functions/_lib/m1-attendance-digest-email-proposal.mjs';

const recipient = 'reader@example.com';
const classUrl = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/?reviewDate=2026-09-26#sign-ins';
const staffUrl = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/#staff-time';
const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const htmlText = value => decode(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

test('immutable synthetic proposal has one recipient and a deterministic complete-content hash', () => {
  const value = buildTestDigestEmail(recipient);
  assert.equal(value.messageId, TEST_EMAIL_MESSAGE_ID);
  assert.equal(value.messageId, 'm1-test-email-andrew-20260926-v1');
  assert.equal(value.from, 'GIB Revolution TEST <onboarding@resend.dev>');
  assert.deepEqual(value.to, [recipient]);
  assert.equal(value.subject, '[TEST — SYNTHETIC] Revolution attendance attention — 26 September 2026');
  assert.equal(value.target, 'test'); assert.equal(value.synthetic, true);
  const { messageId, from, to, subject, html, text, synthetic, target } = value;
  assert.equal(value.hash, digestHash({ messageId, from, to, subject, html, text, synthetic, target }));
  // This message identity binds the reviewed wording. A renderer change must
  // not silently produce new content under an already approved identity.
  assert.equal(value.hash, '38ec067137d5af9b29e763a5be488fcc59fa22cc2ebd8da06dc59f01b7a3d9df');
  assert.deepEqual(buildTestDigestEmail(recipient), value);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.to), true);
  assert.throws(() => value.to.push('other@example.com'), TypeError);
  assert.notEqual(buildTestDigestEmail('other@example.com').hash, value.hash);
  for (const field of ['messageId', 'from', 'subject', 'html', 'text', 'target']) {
    assert.notEqual(digestHash({ messageId, from, to, subject, html, text, synthetic, target, [field]: value[field] + 'changed' }), value.hash);
  }
});

test('HTML and plain text retain both examples, failure warning, coverage limits and unconfirmed cutoff', () => {
  const value = buildTestDigestEmail(recipient), renderedText = htmlText(value.html);
  for (const content of [renderedText, value.text]) {
    for (const phrase of ['PROPOSED TEST EMAIL · SYNTHETIC', 'Every example below is synthetic.',
      'No real records are described, created, or changed.', 'This preview does not confirm delivery.',
      'Instructor class attendance — synthetic example:', 'Hourly Staff Clock — synthetic example:',
      'no finish time or worked hours are guessed.', 'Simulated unavailable read:',
      'Attendance coverage is incomplete; this is not an all-clear.', 'Unfinished review days remain pending.',
      'A day not yet reviewed does not mean a sign-in or person is missing.',
      'A missing second instructor requires an expected instructor count or assignment, or an explicit manager report;',
      'The proposed 10 p.m. Eastern cutoff remains unverified.',
      'These links open the existing Revolution TEST screens behind Admin sign-in.']) assert.ok(content.includes(phrase), phrase);
    assert.ok(content.indexOf('Instructor class attendance') < content.indexOf('Hourly Staff Clock'));
    assert.doesNotMatch(content, /No outstanding items were found|No daily email is needed|Everything is resolved|Stu|Mandy|Walter/);
  }
  for (const summary of [...value.html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(match => htmlText(match[1]))) {
    const withoutLinkLabel = summary.replace(/ Check records in M1$/, '');
    assert.ok(value.text.includes(withoutLinkLabel), withoutLinkLabel);
  }
});

test('all email links point to the two verified Revolution TEST Admin views with no external resources', () => {
  const value = buildTestDigestEmail(recipient);
  const links = [...value.html.matchAll(/href="([^"]+)"/g)].map(match => decode(match[1]));
  assert.deepEqual([...new Set(links)].sort(), [classUrl, staffUrl].sort());
  assert.equal(value.html.includes('<base'), false);
  assert.doesNotMatch(value.html, /<(?:script|iframe|img|object|embed|form)\b|\bsrc\s*=|\bon[a-z]+\s*=|url\(/i);
  for (const url of value.text.match(/https?:\/\/\S+/g) || []) assert.ok([classUrl, staffUrl].includes(url));
  assert.ok(value.text.includes(classUrl)); assert.ok(value.text.includes(staffUrl));
});

test('recipient validation rejects lists, display names, malformed mailboxes and header injection', () => {
  for (const input of [null, undefined, 42, {}, [], '', 'missing-domain', 'reader@localhost', 'a@@example.com',
    ' reader@example.com', 'reader@example.com ', 'Name <reader@example.com>', 'reader@example.com,other@example.com',
    'reader@example.com\r\nBcc: other@example.com', 'a..b@example.com', '.a@example.com', 'a.@example.com',
    'a@-example.com', 'a@example-.com', 'a@ex..com', 'ä@example.com', 'a'.repeat(65) + '@example.com',
    'a@' + 'b'.repeat(64) + '.com']) assert.throws(() => buildTestDigestEmail(input), /single valid TEST recipient/);
  const escaped = buildTestDigestEmail("o'hara+test@example.com");
  assert.deepEqual(escaped.to, ["o'hara+test@example.com"]);
  assert.ok(escaped.html.includes('o&#39;hara+test@example.com'));
  assert.ok(escaped.text.includes("o'hara+test@example.com"));
});

test('proposal adapter leaves the existing capture renderer unchanged', () => {
  const input = { date: '2026-09-26', syntheticRehearsal: true, shouldCapture: false,
    recipients: [], groups: [], readFailures: [] };
  const before = renderAttendanceDigest(input);
  buildTestDigestEmail(recipient);
  assert.deepEqual(renderAttendanceDigest(input), before);
  assert.match(before.text, /TEST CAPTURE — actual email sending is disabled/);
  assert.match(before.html, /TEST CAPTURE · sending disabled/);
  assert.doesNotMatch(before.html + before.text, /PROPOSED TEST EMAIL/);
});
