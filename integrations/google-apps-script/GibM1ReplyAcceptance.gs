/* CANDIDATE ONLY. Editor-only one-shot probe; independently review before upload.
 * No daily send/capture/attendance/payroll keys; no triggers or scope additions.
 * Needs matching 30-minute receiver lease and an explicit owner-approved send. */
function prepareBusinessReplyAcceptanceIntakeWindow() {
  var scope = gibM1ReplyScope_(), p = PropertiesService.getScriptProperties(), now = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('REPLY_ACCEPTANCE_BUSY');
  try {
    var savedStart = p.getProperty('GIB_M1_REPLY_START_AT'), savedCursor = p.getProperty('GIB_M1_REPLY_SCAN_THROUGH');
    var initialized = false;
    // Initialize once, only when BOTH long-lived values are absent. The sender
    // lease is independent; a continuation never resets it or rearms a send.
    if (savedStart === null && savedCursor === null) {
      savedStart = String(now);
      p.setProperty('GIB_M1_REPLY_START_AT', savedStart);
      if (p.getProperty('GIB_M1_REPLY_START_AT') !== savedStart) throw new Error('REPLY_START_REQUIRED');
      initialized = true;
    }
    var start = Number(savedStart), cursor = savedCursor === null ? start : Number(savedCursor);
    if (!Number.isSafeInteger(start) || start <= 0 || start > now || !Number.isSafeInteger(cursor)
      || cursor < start || cursor > now) throw new Error('REPLY_START_REQUIRED');
    return { gym: scope.gym, initialized: initialized, startAt: start, scanThrough: cursor,
      senderSetupChanged: false, mailboxRead: false, emailSent: false };
  } finally { lock.releaseLock(); }
}
function sendBusinessReplyAcceptanceProbe() {
  var scope = gibM1ReplyScope_(), p = PropertiesService.getScriptProperties();
  var gym = scope.gym, expected = gym === 'rev' ? 'info@revolutionbjj.com' : gym === 'richmond' ? 'info@richmondbjj.com' : null;
  var eventId = p.getProperty('GIB_M1_REPLY_ACCEPTANCE_EVENT_ID');
  var start = Number(p.getProperty('GIB_M1_REPLY_ACCEPTANCE_START_AT'));
  var until = Number(p.getProperty('GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT')), now = Date.now();
  if (!expected || scope.target !== 'production' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId || '')
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(until) || start <= 0 || until <= start || until - start > 1800000
    || now < start || now >= until || p.getProperty('GIB_M1_REPLY_ROUTING_ENABLED') === 'true'
    || p.getProperty('GIB_M1_REPLY_ROUTE_VERIFIED') === 'v1') throw new Error('REPLY_ACCEPTANCE_NOT_APPROVED');
  var quota = MailApp.getRemainingDailyQuota();
  if (!Number.isSafeInteger(quota) || quota < 1) throw new Error('REPLY_ACCEPTANCE_QUOTA');
  var key = 'GIB_M1_REPLY_ACCEPTANCE_CLAIM_' + gym, lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('REPLY_ACCEPTANCE_BUSY');
  var claim = { gym: gym, eventId: eventId, startAt: start, expiresAt: until, state: 'preparing', claimedAt: now };
  try {
    // One durable attempt per gym, even if an operator changes the event ID.
    // Missing result after a crash is never authority to rearm this property.
    if (p.getProperty(key)) throw new Error('REPLY_ACCEPTANCE_ALREADY_CLAIMED');
    p.setProperty(key, JSON.stringify(claim));
    if (p.getProperty(key) !== JSON.stringify(claim)) throw new Error('REPLY_ACCEPTANCE_CLAIM_UNCONFIRMED');
  } finally { lock.releaseLock(); }
  now = Date.now();
  var registration = gibM1ReplyPost_(scope, { schema: GIB_M1_REPLY_SCHEMA_, action: 'prepare-acceptance', gym: gym, target: 'production',
    requestId: Utilities.getUuid(), createdAt: now, expiresAt: now + 60000, eventId: eventId });
  var label = gym === 'rev' ? 'Revolution' : 'Richmond';
  var subject = 'GiB reply intake TEST ONLY - ' + label + ' [GiB ' + gym + ' ' + eventId + ']';
  if (registration.schema !== 'm1-reply-acceptance/v1' || registration.gym !== gym || registration.eventId !== eventId
    || registration.subject !== subject || registration.mailbox !== 'revbjjops@gmail.com' || registration.manager !== expected
    || registration.expiresAt !== until || Date.now() >= until) throw new Error('REPLY_ACCEPTANCE_REGISTRATION_UNCONFIRMED');
  // Recheck identity/lease/routing after network I/O and durably claim BEFORE mail.
  var current = gibM1ReplyScope_();
  if (current.gym !== gym || current.target !== 'production'
    || p.getProperty('GIB_M1_REPLY_ACCEPTANCE_EVENT_ID') !== eventId
    || Number(p.getProperty('GIB_M1_REPLY_ACCEPTANCE_START_AT')) !== start
    || Number(p.getProperty('GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT')) !== until
    || p.getProperty('GIB_M1_REPLY_ROUTING_ENABLED') === 'true'
    || p.getProperty('GIB_M1_REPLY_ROUTE_VERIFIED') === 'v1') throw new Error('REPLY_ACCEPTANCE_NOT_APPROVED');
  claim.state = 'call-pending'; claim.attemptedAt = Date.now();
  p.setProperty(key, JSON.stringify(claim));
  if (p.getProperty(key) !== JSON.stringify(claim) || Date.now() >= until) throw new Error('REPLY_ACCEPTANCE_CLAIM_UNCONFIRMED');
  var body = 'This is a one-time GiB reply-delivery test. Please use Reply from this manager address and send exactly: ACCEPT '
    + gym.toUpperCase() + ' - TEST ONLY; no attendance or payroll change.';
  // Same Google MailApp transport as the production sender. This probe has its
  // own claim and fixed business Reply-To, so routing verification is not faked.
  var sent = false;
  try { MailApp.sendEmail({ to: expected, replyTo: 'revbjjops@gmail.com', subject: subject, body: body }); sent = true; }
  catch (_) { /* May have been accepted. Never resend this claim. */ }
  claim.state = sent ? 'submitted' : 'uncertain'; claim.completedAt = Date.now();
  try { p.setProperty(key, JSON.stringify(claim)); } catch (_) { /* call-pending remains non-retryable */ }
  var result = { gym: gym, eventId: eventId, state: claim.state, realEmailAttempted: true, inboxArrivalConfirmed: false };
  console.log('GIB_REPLY_ACCEPTANCE ' + JSON.stringify(result));
  return result;
}
