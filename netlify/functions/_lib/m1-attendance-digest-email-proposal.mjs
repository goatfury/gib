import { digestHash, renderAttendanceDigest } from './m1-attendance-digest.mjs';

export const TEST_EMAIL_MESSAGE_ID = 'm1-test-email-andrew-20260926-v1';
const DATE = '2026-09-26';
const SUBJECT = '[TEST — SYNTHETIC] Revolution attendance attention — 26 September 2026';
const FROM = 'GIB Revolution TEST <onboarding@resend.dev>';
const CLASS_URL = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/?reviewDate=2026-09-26#sign-ins';
const STAFF_URL = 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/#staff-time';
const INTRODUCTION = 'Proposed TEST email. Every example below is synthetic. No real records are described, created, or changed. This preview does not confirm delivery.';
const COVERAGE = 'A day not yet reviewed does not mean a sign-in or person is missing. One recorded instructor satisfies the missing-sign-in check. A missing second instructor requires an expected instructor count or assignment, or an explicit manager report; it cannot be inferred from one sign-in.';
const CUTOFF = 'No real closing time has been confirmed. The proposed 10 p.m. Eastern cutoff remains unverified.';
const LINKS = 'These links open the existing Revolution TEST screens behind Admin sign-in. They do not create or correct these synthetic examples.';
const FOOTER = 'This is a proposed synthetic TEST email. Actual email delivery is not established by this preview.';

const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function validateRecipient(recipient) {
  // Accept one plain ASCII mailbox, never a display name, list, or header value.
  // Authorization of that mailbox is a separate server-owned delivery check.
  if (typeof recipient !== 'string' || recipient.length > 254 || recipient.split('@')[0].length > 64
    || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(recipient)) {
    throw new Error('A single valid TEST recipient is required.');
  }
  return recipient;
}

function replaceOnce(value, expected, replacement) {
  if (!value.includes(expected) || value.indexOf(expected) !== value.lastIndexOf(expected)) {
    throw new Error('The reviewed TEST email template changed.');
  }
  return value.replace(expected, () => replacement);
}

export function buildTestDigestEmail(recipient) {
  validateRecipient(recipient);
  // Fixed in-memory examples only: no authoritative reads, records, or clock.
  const rendered = renderAttendanceDigest({
    date: DATE, syntheticRehearsal: true, shouldCapture: true,
    recipients: [{ name: 'TEST recipient', address: recipient }],
    groups: [{ gym: 'rev', name: 'Revolution TEST — synthetic examples', items: [
      { date: DATE, summary: 'Instructor class attendance — synthetic example: a finished class has no recorded instructor sign-in. A manager would check the class attendance.', url: CLASS_URL },
      { date: DATE, summary: 'Hourly Staff Clock — synthetic example: an earlier shift has no confirmed finish. The employee started a newer shift and selected “I’m not sure.” The earlier shift needs manager review; no finish time or worked hours are guessed.', url: STAFF_URL }
    ] }],
    readFailures: [{ gym: 'rev', message: 'Simulated unavailable read: class records could not be checked. Attendance coverage is incomplete; this is not an all-clear. Unfinished review days remain pending.', url: CLASS_URL }]
  });

  // Reuse the capture renderer unchanged. These exact substitutions adapt only
  // this immutable proposal's labels and append its explicitly TEST-only links.
  let html = replaceOnce(rendered.html, '<title>' + escape(rendered.subject) + '</title>', '<title>' + escape(SUBJECT) + '</title>');
  let text = replaceOnce(rendered.text, 'Subject: ' + rendered.subject, 'Subject: ' + SUBJECT);
  html = replaceOnce(html, 'TEST CAPTURE · sending disabled', 'PROPOSED TEST EMAIL · SYNTHETIC');
  text = replaceOnce(text, 'TEST CAPTURE — actual email sending is disabled.', 'PROPOSED TEST EMAIL · SYNTHETIC');
  const priorIntroduction = 'Controlled synthetic rehearsal. These are isolated fixtures, not real attendance or instructions to correct records. No real closing time has been confirmed.';
  html = replaceOnce(html, escape(priorIntroduction), escape(INTRODUCTION));
  text = replaceOnce(text, priorIntroduction, INTRODUCTION);
  const priorFooter = 'This is a capture preview; real delivery has not been tested.';
  html = replaceOnce(html, priorFooter, escape(FOOTER));
  text = replaceOnce(text, priorFooter, FOOTER);
  const extraHtml = '<section><h2 style="font-size:20px;margin-top:28px">Coverage and TEST review links</h2>'
    + [COVERAGE, CUTOFF, LINKS].map(paragraph => '<p>' + escape(paragraph) + '</p>').join('')
    + '<p><a href="' + CLASS_URL + '">Open Revolution TEST class review</a><br>'
    + '<a href="' + STAFF_URL + '">Open Revolution TEST Staff Clock review</a></p></section>';
  html = replaceOnce(html, '</main>', extraHtml + '</main>');
  text += '\n\nCoverage and TEST review links\n' + [COVERAGE, CUTOFF, LINKS,
    'Open Revolution TEST class review: ' + CLASS_URL, 'Open Revolution TEST Staff Clock review: ' + STAFF_URL].join('\n\n');

  const message = { messageId: TEST_EMAIL_MESSAGE_ID, from: FROM, to: [recipient], subject: SUBJECT,
    html, text, synthetic: true, target: 'test' };
  const hash = digestHash(message);
  Object.freeze(message.to);
  return Object.freeze({ ...message, hash });
}
