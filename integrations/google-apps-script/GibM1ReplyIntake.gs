/* Optional business-mailbox intake. Gmail API GET only; never GmailApp.
 * No access token leaves Google's API call. Existing per-gym HMAC authenticates
 * minimized records to that gym's private Netlify queue. No new credentials. */
var GIB_M1_REPLY_SCHEMA_ = 'm1-reply-intake/v1';
var GIB_M1_REPLY_MAILBOX_ = 'revbjjops@gmail.com';
function gibM1ReplyScope_() {
  var scope = gibM1LiveReminderScope_();
  if (!scope || scope.target !== 'production' || !gibM1MailAppActor_()) throw new Error('REPLY_ACCOUNT_UNVERIFIED');
  return scope;
}
function gibM1ReplyGet_(path) {
  // Path is constructed internally. Neither an email nor a request supplies a URL.
  var response = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    method: 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    followRedirects: false, muteHttpExceptions: true });
  var status = response.getResponseCode();
  if (status === 401 || status === 403) throw new Error('REPLY_ACCESS_REVOKED');
  if (status !== 200) throw new Error('REPLY_GMAIL_UNAVAILABLE');
  return JSON.parse(response.getContentText());
}
// Editor-only, after Andrew approves the exact account and readonly scope.
// Reads profile only. Does not install a trigger, change routing, or read mail.
function verifyBusinessReplyIntakeAccess() {
  var scope = gibM1ReplyScope_(), profile = gibM1ReplyGet_('profile');
  if (profile.emailAddress !== GIB_M1_REPLY_MAILBOX_) throw new Error('REPLY_ACCOUNT_UNVERIFIED');
  return { ok: true, gym: scope.gym, mailbox: profile.emailAddress, scope: 'https://www.googleapis.com/auth/gmail.readonly', routingChanged: false };
}
function gibM1ReplyHeader_(message, name) {
  var values = (message.payload?.headers || []).filter(function(h) { return String(h.name).toLowerCase() === name.toLowerCase(); });
  return values.length === 1 ? String(values[0].value) : '';
}
function gibM1ReplyAddresses_(value) {
  var addresses = String(value).split(',').map(function(part) {
    var angle = /<([^<>]+)>\s*$/.exec(part), address = (angle ? angle[1] : part).trim().toLowerCase();
    return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address) ? address : '';
  });
  return addresses.length && addresses.every(Boolean) ? addresses : [];
}
function gibM1ReplyEventId_(subject, gym) {
  var found = new RegExp('\\[GiB ' + gym + ' ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\]$').exec(subject);
  return found ? found[1] : null;
}
function gibM1ReplyText_(payload) {
  var parts = [], incomplete = false;
  function visit(part, depth) {
    if (!part || depth > 12) { incomplete = true; return; }
    if (part.filename) return; // No attachments, including attached messages.
    if (part.mimeType === 'text/plain') {
      if (part.body?.attachmentId) { incomplete = true; return; }
      if (part.body?.data) parts.push(Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString('UTF-8'));
    } else (part.parts || []).forEach(function(child) { visit(child, depth + 1); });
  }
  visit(payload, 0);
  var body = parts.join('\n').replace(/\r\n/g, '\n');
  // Retain the new text only. Quoted history cannot create a correction.
  var cutoff = body.search(/(?:^|\n)(?:On .{1,300}wrote:|>\s*|--\s*$|_{5,}|-{5,}\s*Original Message)/m);
  if (cutoff >= 0) body = body.slice(0, cutoff);
  if (!body.trim()) { body = '[No unquoted plain-text correction; inspect original message.]'; incomplete = true; }
  return { body: body.trim().slice(0, 12000), truncated: incomplete || body.length > 12000 };
}
function gibM1ReplyNormalize_(message, thread, scope) {
  var subject = gibM1ReplyHeader_(message, 'Subject'), eventId = gibM1ReplyEventId_(subject, scope.gym);
  if (!eventId) return null;
  var from = gibM1ReplyAddresses_(gibM1ReplyHeader_(message, 'From'));
  var expected = scope.gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com';
  var auth = (message.payload?.headers || []).filter(function(h) { return String(h.name).toLowerCase() === 'authentication-results' && /^mx\.google\.com;/i.test(String(h.value).trim()); })[0]?.value || '';
  var domain = expected.split('@')[1].replace(/\./g, '\\.');
  var authenticated = new RegExp('dmarc=pass\\b[^;]*header\\.from=' + domain + '(?:[;\\s]|$)', 'i').test(auth);
  var parents = (thread.messages || []).filter(function(p) {
    return p.id !== message.id && p.threadId === message.threadId && (p.labelIds || []).indexOf('SENT') >= 0
      && gibM1ReplyHeader_(p, 'Subject') === subject.replace(/^(?:re:\s*)+/i, '')
      && gibM1ReplyAddresses_(gibM1ReplyHeader_(p, 'From')).join(',') === GIB_M1_REPLY_MAILBOX_
      && gibM1ReplyAddresses_(gibM1ReplyHeader_(p, 'Reply-To')).join(',') === GIB_M1_REPLY_MAILBOX_;
  });
  var p = parents.length === 1 ? parents[0] : null, body = gibM1ReplyText_(message.payload);
  return { gmailId: message.id, threadId: message.threadId, eventId: eventId, from: from.length === 1 ? from[0] : 'unverified@invalid.example',
    to: gibM1ReplyAddresses_(gibM1ReplyHeader_(message, 'To')), subject: subject,
    rfcId: gibM1ReplyHeader_(message, 'Message-ID') || '[missing]', inReplyTo: gibM1ReplyHeader_(message, 'In-Reply-To') || '[missing]',
    references: (gibM1ReplyHeader_(message, 'References').match(/<[^<>\s]+>/g) || []).slice(0, 100),
    receivedAt: Number(message.internalDate), authenticated: authenticated, body: body.body, truncated: body.truncated,
    parent: p ? { gmailId: p.id, threadId: p.threadId, rfcId: gibM1ReplyHeader_(p, 'Message-ID'), from: GIB_M1_REPLY_MAILBOX_,
      to: gibM1ReplyAddresses_(gibM1ReplyHeader_(p, 'To')), replyTo: GIB_M1_REPLY_MAILBOX_, subject: gibM1ReplyHeader_(p, 'Subject'), sent: true, sentAt: Number(p.internalDate) } : null };
}
function gibM1ReplyPost_(scope, input) {
  var raw = JSON.stringify(input);
  var signature = Utilities.computeHmacSha256Signature(GIB_M1_REPLY_SCHEMA_ + '\n' + raw, configuredAdminActionSecret_(), Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
  var url = scope.digestUrl.replace(/\/api\/m1-attendance-digest-job$/, '/api/m1-reply-intake');
  if (url === scope.digestUrl || !/^https:\/\/(?:gib-live|gib-richmond-live)\.netlify\.app\/api\/m1-reply-intake$/.test(url)) throw new Error('REPLY_ENDPOINT_INVALID');
  var result = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: raw,
    headers: { 'X-GIB-M1-Reply-Signature': signature }, followRedirects: false, muteHttpExceptions: true });
  var value = JSON.parse(result.getContentText());
  if (result.getResponseCode() !== 200 || value.ok !== true || input.action === 'poll' && value.accepted !== true || value.requestId !== input.requestId) throw new Error('REPLY_QUEUE_UNCONFIRMED');
  return value;
}
// Private operator/goati read through the existing per-gym server trust. Returns
// data to the authorized caller; never logs bodies or opens a public page.
function readBusinessAttendanceReplyQueue() {
  var scope = gibM1ReplyScope_(), now = Date.now();
  return gibM1ReplyPost_(scope, { schema: GIB_M1_REPLY_SCHEMA_, action: 'read', gym: scope.gym, target: 'production',
    requestId: Utilities.getUuid(), createdAt: now, expiresAt: now + 60000 });
}
function gibM1ReplyRouteFaults_(properties) {
  var raw = properties.getProperty('GIB_M1_REPLY_ROUTE_FAULT');
  if (!raw) return { faults: [], overflow: null };
  var saved = JSON.parse(raw);
  // Preserve the earlier single-fault shape if encountered during an upgrade.
  return saved.eventId ? { faults: [saved], overflow: null } : saved;
}
function gibM1ReplyRememberRoute_(scope, report, requestId, now, reportedFault) {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('GIB_M1_REPLY_ROUTING_ENABLED') !== 'true') return;
  var missingMarker = !report || report.shouldSend && !gibM1ReplyEventId_(report.rendered?.subject || '', scope.gym);
  if (!reportedFault && !missingMarker) return;
  var fault = reportedFault?.eventId === requestId ? reportedFault : { eventId: requestId, at: now, code: 'sender-route-unconfirmed' };
  var key = 'GIB_M1_REPLY_ROUTE_FAULT';
  // Retain every unacknowledged event, bounded below the 9 KB property limit.
  // Beyond twenty events retain a cumulative affected interval/count. Overflow
  // remains a separate operator exception until that exact interval is cleared.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('REPLY_ROUTE_FAULT_UNCONFIRMED');
  try {
    var state = gibM1ReplyRouteFaults_(p);
    if (!state.faults.some(function(existing) { return existing.eventId === fault.eventId; })) {
      if (state.faults.length < 20) state.faults.push(fault);
      else {
        var previous = state.overflow;
        if (!previous || previous.lastEventId !== fault.eventId) state.overflow = {
          eventId: previous?.eventId || fault.eventId, at: Math.min(previous?.at || fault.at, fault.at),
          through: Math.max(previous?.through || fault.at, fault.at), count: (previous?.count || 0) + 1,
          lastEventId: fault.eventId, code: 'sender-route-overflow' };
      }
    }
    var encoded = JSON.stringify(state); p.setProperty(key, encoded);
    if (p.getProperty(key) !== encoded) throw new Error('REPLY_ROUTE_FAULT_UNCONFIRMED');
  } finally { lock.releaseLock(); }
}
// Install one hourly time trigger per existing production project using the
// editor UI only after access + receiving route verification. No trigger API
// scope is requested here; this source never creates or deletes triggers.
function pollBusinessAttendanceReplies() {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('GIB_M1_REPLY_INTAKE_ENABLED') !== 'true') return { enabled: false };
  var scope = gibM1ReplyScope_(), start = Number(properties.getProperty('GIB_M1_REPLY_START_AT'));
  var cursor = Number(properties.getProperty('GIB_M1_REPLY_SCAN_THROUGH') || start), now = Date.now();
  if (!Number.isSafeInteger(start) || start <= 0 || start > now || !Number.isSafeInteger(cursor) || cursor < start || cursor > now) throw new Error('REPLY_START_REQUIRED');
  // No shared attendance lock is held across network I/O. Duplicate overlapping
  // polls converge on immutable Gmail-ID keys; cursor advances monotonically.
  var input = { schema: GIB_M1_REPLY_SCHEMA_, action: 'poll', gym: scope.gym, target: 'production',
    requestId: Utilities.getUuid(), createdAt: now, expiresAt: now + 60000,
    scanFrom: Math.max(start, cursor - 600000), scanThrough: now - 120000, messages: [], status: 'complete' };
  var routeFaults = gibM1ReplyRouteFaults_(properties);
  input.routeFaults = routeFaults.faults;
  if (routeFaults.overflow) input.routeFaultOverflow = routeFaults.overflow;
  if (input.scanThrough < input.scanFrom) return { warmingUp: true };
  try {
    if (gibM1ReplyGet_('profile').emailAddress !== GIB_M1_REPLY_MAILBOX_) throw new Error('REPLY_ACCOUNT_UNVERIFIED');
    var manager = scope.gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com';
    var page;
    for (var division = 0; division < 8; division++) {
      var query = 'to:' + GIB_M1_REPLY_MAILBOX_ + ' from:' + manager + ' subject:"GiB ' + scope.gym + '" after:' + Math.floor(input.scanFrom / 1000) + ' before:' + Math.ceil(input.scanThrough / 1000);
      page = gibM1ReplyGet_('messages?maxResults=25&q=' + encodeURIComponent(query));
      if (!page.nextPageToken) break;
      // Bounded oldest-first recovery; never checkpoint an incomplete page.
      if (input.scanThrough - input.scanFrom < 1200000) break;
      input.scanThrough = Math.floor((input.scanFrom + input.scanThrough) / 2);
    }
    if (page.nextPageToken) throw new Error('REPLY_CAPACITY_EXCEEDED');
    for (var index = 0; index < (page.messages || []).length; index++) {
      if (Date.now() > input.createdAt + 45000) throw new Error('REPLY_POLL_BUDGET');
      var id = page.messages[index].id;
      if (!/^[a-f0-9]{8,40}$/.test(id)) throw new Error('REPLY_GMAIL_UNAVAILABLE');
      var message = gibM1ReplyGet_('messages/' + id + '?format=full');
      if (Number(message.internalDate) < start || !gibM1ReplyEventId_(gibM1ReplyHeader_(message, 'Subject'), scope.gym)) continue;
      if (!/^[a-f0-9]{8,40}$/.test(message.threadId)) throw new Error('REPLY_GMAIL_UNAVAILABLE');
      var thread = gibM1ReplyGet_('threads/' + message.threadId + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID');
      try {
        var normalized = gibM1ReplyNormalize_(message, thread, scope); if (normalized) input.messages.push(normalized);
      } catch (_) { input.messages.push({ gmailId: id }); } // Durable metadata-only quarantine; do not strand later replies.
    }
  } catch (error) {
    input.messages = [];
    input.status = error.message === 'REPLY_ACCESS_REVOKED' || error.message === 'REPLY_ACCOUNT_UNVERIFIED' ? 'access-revoked' : error.message === 'REPLY_CAPACITY_EXCEEDED' ? 'capacity-exceeded' : 'poll-failed';
  }
  // Fresh transport binding; scan interval remains the original interval.
  input.createdAt = Date.now(); input.expiresAt = input.createdAt + 60000;
  var result = gibM1ReplyPost_(scope, input);
  if (result.routeFaultAcknowledgements?.length || result.routeFaultOverflowAcknowledged) {
    // Remove only the exact faults/overflow snapshot that the server confirms
    // an authenticated operator has accounted for. Preserve concurrent failures.
    var faultLock = LockService.getScriptLock();
    if (faultLock.tryLock(1000)) {
      try {
        var current = gibM1ReplyRouteFaults_(properties), acknowledged = result.routeFaultAcknowledgements || [];
        current.faults = current.faults.filter(function(fault) {
          return !acknowledged.some(function(saved) { return JSON.stringify(saved) === JSON.stringify(fault); });
        });
        if (current.overflow && JSON.stringify(current.overflow) === JSON.stringify(result.routeFaultOverflowAcknowledged)) current.overflow = null;
        properties.setProperty('GIB_M1_REPLY_ROUTE_FAULT', JSON.stringify(current));
      }
      finally { faultLock.releaseLock(); }
    }
  }
  if (input.status === 'complete') {
    var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) throw new Error('REPLY_CURSOR_UNCONFIRMED');
    try {
      var before = Number(properties.getProperty('GIB_M1_REPLY_SCAN_THROUGH') || start);
      if (before < input.scanThrough) properties.setProperty('GIB_M1_REPLY_SCAN_THROUGH', String(input.scanThrough));
      if (Number(properties.getProperty('GIB_M1_REPLY_SCAN_THROUGH') || start) < input.scanThrough) throw new Error('REPLY_CURSOR_UNCONFIRMED');
    } finally { lock.releaseLock(); }
  }
  // Projection retries even after a retained failed mailbox poll. Its failure
  // never rolls back a durably acknowledged mailbox scan or changes attendance.
  var projection = { enabled: false };
  if (properties.getProperty('GIB_M1_REPLY_PROJECTION_ENABLED') === 'true') {
    try { projection = publishBusinessAttendanceReplyProjection(); }
    catch (_) { projection = { ok: false, code: 'projection-failed' }; }
  }
  // IDs/counts only, no email bodies, credentials, or exception payloads in logs.
  return { ok: input.status === 'complete', gym: scope.gym, status: input.status, newRelevant: result.newRelevant, scanThrough: input.scanThrough, projection: projection };
}
function gibM1ReplyMailOptions_(scope, options) {
  var eventId = gibM1ReplyEventId_(options.subject, scope.gym);
  if (!eventId) return options; // Old replies and unconfirmed fallback checks stay on the old route.
  var enabled = PropertiesService.getScriptProperties().getProperty('GIB_M1_REPLY_ROUTING_ENABLED') === 'true'
    && PropertiesService.getScriptProperties().getProperty('GIB_M1_REPLY_ROUTE_VERIFIED') === 'v1';
  if (!enabled) return { ...options, subject: options.subject.replace(/ \[GiB [^\]]+\]$/, '') };
  var revise = function(value) { return String(value).replace(/Your reply goes to Andrew at andrew@revolutionbjj\.com\. Andrew will update the spreadsheet during payroll, preserving the original records and correction history\./g,
    'Your reply goes to the private GiB attendance review queue at revbjjops@gmail.com. Corrections are reviewed before attendance or payroll changes.')
    .replace(/Please reply here with any corrections and Andrew will update the record\./g,
      'Please reply here with any corrections. They go to the private GiB attendance review queue at revbjjops@gmail.com for review before attendance or payroll changes.'); };
  return { ...options, replyTo: GIB_M1_REPLY_MAILBOX_, body: revise(options.body), htmlBody: revise(options.htmlBody) };
}
