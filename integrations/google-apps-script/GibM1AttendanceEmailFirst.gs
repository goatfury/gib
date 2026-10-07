/* Production daily attendance only. The editor/browser/tablet are not runners.
 * Permanent gym/day claims precede MailApp; uncertain calls are never repeated.
 * No correction, attendance, payroll, promotion, or queue record is changed. */
var GIB_M1_EMAIL_FIRST_SCHEMA_ = 'm1-daily-email-check/v1';
var GIB_M1_EMAIL_FIRST_PREFIX_ = 'M1_ATTENDANCE_EMAIL_FIRST_DAY_';

function gibM1EmailFirstEnabled_() {
  var properties = PropertiesService.getScriptProperties();
  return Boolean(gibM1LiveReminderScope_())
    && properties.getProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED') === 'true'
    && properties.getProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_READY') === 'v1';
}
// Private background read: no manager-screen feature, reviewer, callback, or
// nested HTTP request. Reuses original record and journal validation read-only.
function gibM1AttendanceBackgroundRead_(body) {
  var scope = gibM1LiveReminderScope_();
  if (!scope || !adminActionAuthorized_(body) || body.target !== scope.target || body.gym !== scope.gym
    || body.from !== '2026-09-07' || body.to !== todayNewYork_()
    || scope.gym === 'richmond' && !gibM1RichmondProductionEnvelopeValid_(body)) throw new Error('ATTENDANCE_SCOPE_UNAVAILABLE');
  var lock = LockService.getScriptLock(), held = lock.tryLock(10000);
  if (!held) throw new Error('ATTENDANCE_READ_UNAVAILABLE');
  try {
    var spreadsheet = openExpectedSpreadsheet_(body);
    var state = readSignins_(signinsSheet_(spreadsheet), { tolerantReview: true });
    if (state.records.length > 20000) throw new Error('ATTENDANCE_READ_UNAVAILABLE');
    var journal = managerJournal_(spreadsheet, false);
    if (journal.events.some(function(event) { return event.gym !== scope.gym; })) throw new Error('ATTENDANCE_READ_UNAVAILABLE');
    var counts = {}, byDate = {}, unreadable = [];
    state.records.forEach(function(record) {
      if (record.rowId) counts[record.rowId] = (counts[record.rowId] || 0) + 1;
      if (!validCalendarDate_(record.date)) { if (activeRecord_(record)) unreadable.push(unreadableDateWarning_(record)); return; }
      (byDate[record.date] || (byDate[record.date] = [])).push(record);
    });
    var events = {}; journal.events.forEach(function(event) { events[event.date] = event; });
    var days = [], stamp = Date.parse(body.from + 'T12:00:00Z');
    for (var index = 0; index <= 3660; index++, stamp += 86400000) {
      var date = new Date(stamp).toISOString().slice(0, 10); if (date > body.to) break;
      var all = byDate[date] || [], records = [], warnings = unreadable.slice();
      all.forEach(function(record) {
        if (!activeRecord_(record)) return;
        if (reviewRecordIssue_(record)) { warnings.push(unreadableWarning_(record)); return; }
        if (!record.rowId || counts[record.rowId] !== 1) warnings.push({ code: 'RECORD_ID_CONFLICT', message: 'An attendance record has an ambiguous permanent ID.' });
        var value = publicRecord_(record); value.fingerprint = managerAttendanceHash_([record]);
        value.correctable = Boolean(record.rowId) && counts[record.rowId] === 1; records.push(value);
      });
      days.push({ date: date, records: records, warnings: warnings, attendanceHash: managerAttendanceHash_(all), review: events[date] || null });
    }
    if (!days.length || days[days.length - 1].date !== body.to) throw new Error('ATTENDANCE_READ_UNAVAILABLE');
    // A consumed offline ID remains a VOID audit receipt, never active teaching.
    // Reuse the receiver's unique replacement/audit/chronology validation; a VOID
    // marker alone cannot prove that this tablet record was safely reconciled.
    var site = scope.gym === 'richmond' ? 'Richmond' : 'Rev';
    var auditRows = adminSyncAuditRows_(spreadsheet), uploadReceipts = [];
    state.records.forEach(function(receipt) {
      if (!adminSyncReceiptRecord_(receipt, scope.target) || receipt.site !== site
        || counts[receipt.rowId] !== 1 || receipt.date < body.from || receipt.date > body.to) return;
      var linked = findAdminSyncReceipt_(state.records, receipt, auditRows, scope.target);
      if (!linked || linked.conflict || linked.site !== site || counts[linked.rowId] !== 1
        || reviewRecordIssue_(linked)) return;
      uploadReceipts.push({ schema: 'm1-upload-reconciliation/v1', gym: scope.gym, target: scope.target,
        date: receipt.date, rowId: receipt.rowId, linkedRecordId: linked.rowId });
    });
    return { ok: true, schema: 'm1-manager-review/v1', complete: true, target: scope.target, gym: scope.gym,
      from: body.from, to: body.to, days: days, uploadReceipts: uploadReceipts };
  } finally { lock.releaseLock(); }
}
function gibM1EmailFirstRead_(properties, date) {
  var raw = properties.getProperty(GIB_M1_EMAIL_FIRST_PREFIX_ + date);
  if (!raw) return null;
  var value = JSON.parse(raw);
  if (!value || value.date !== date || ['checking', 'suppressed', 'call-pending', 'submitted', 'uncertain', 'not-sent'].indexOf(value.state) < 0
    || !Number.isSafeInteger(value.startedAt)) throw new Error('EMAIL_FIRST_CLAIM_UNAVAILABLE');
  return value;
}
function gibM1EmailFirstWrite_(properties, value) {
  var raw = JSON.stringify(value), key = GIB_M1_EMAIL_FIRST_PREFIX_ + value.date;
  properties.setProperty(key, raw);
  if (properties.getProperty(key) !== raw) throw new Error('EMAIL_FIRST_CLAIM_UNAVAILABLE');
}
function gibM1EmailFirstMissed_(properties, date) {
  var start = properties.getProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE');
  if (!gibM1MailAppDate_(start) || start > date) throw new Error('EMAIL_FIRST_START_UNAVAILABLE');
  var missing = [], stamp = Date.parse(start + 'T12:00:00Z');
  for (var index = 0; index <= 3660; index++, stamp += 86400000) {
    var previous = new Date(stamp).toISOString().slice(0, 10); if (previous >= date) break;
    var retained = gibM1EmailFirstRead_(properties, previous);
    var coverage = properties.getProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_COVERAGE_THROUGH');
    if ((!coverage || previous > coverage) && (!retained || retained.state === 'checking' || retained.state === 'not-sent' || retained.checkConfirmed === false)) missing.push(previous);
  }
  return missing;
}
function gibM1EmailFirstCopy_(scope, subject, paragraphs) {
  var greeting = 'Hi ' + (scope.gym === 'rev' ? 'Stu' : 'Trey') + ',';
  var lines = [greeting].concat(paragraphs);
  var escape = function(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
  return { subject: subject, text: lines.join('\n\n'),
    html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + escape(subject) + '</title></head><body><main>'
      + lines.map(function(line) { return '<p>' + escape(line) + '</p>'; }).join('') + '</main></body></html>' };
}
function gibM1EmailFirstRichmondDate_(date) {
  var value = new Date(date + 'T12:00:00Z');
  var weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return weekdays[value.getUTCDay()] + ', ' + months[value.getUTCMonth()] + ' ' + value.getUTCDate();
}
function gibM1EmailFirstFallback_(scope, date) {
  if (scope.gym === 'richmond') return gibM1EmailFirstCopy_(scope, 'Today’s sign-in check couldn’t finish', [
    'We couldn’t finish the sign-in check for ' + gibM1EmailFirstRichmondDate_(date) + ' or confirm that all saved sign-ins reached the spreadsheet.'
  ]);
  return gibM1EmailFirstCopy_(scope, 'Today’s sign-in check couldn’t finish', [
    'We couldn’t confirm that all the sign-ins reached the spreadsheet. We haven’t identified a specific missing sign-in, so no correction reply is needed.',
    'The scheduled check for ' + date + ' couldn’t finish.',
    'Andrew will look into the check.'
  ]);
}
function gibM1EmailFirstReportValid_(report, scope, date) {
  if (!gibM1MailAppExact_(report, ['schema', 'gym', 'date', 'complete', 'shouldSend', 'rendered', 'issueCount', 'unconfirmedChecks'])
    || report.schema !== GIB_M1_EMAIL_FIRST_SCHEMA_ || report.gym !== scope.gym || report.date !== date || report.complete !== true
    || typeof report.shouldSend !== 'boolean' || !Number.isSafeInteger(report.issueCount) || report.issueCount < 0
    || !Number.isSafeInteger(report.unconfirmedChecks) || report.unconfirmedChecks < 0
    || report.shouldSend !== Boolean(report.issueCount || report.unconfirmedChecks)) return false;
  if (!report.shouldSend) return report.rendered === null;
  return gibM1MailAppExact_(report.rendered, ['subject', 'html', 'text'])
    && typeof report.rendered.subject === 'string' && report.rendered.subject.length > 0 && report.rendered.subject.length <= 998 && !/[\r\n]/.test(report.rendered.subject)
    && ['html', 'text'].every(function(key) { return typeof report.rendered[key] === 'string' && report.rendered[key].length > 0 && report.rendered[key].length <= 200000; });
}
function gibM1EmailFirstOwnsMessage_(message) {
  if (message?.target !== 'production') return null;
  var scope = gibM1LiveInstallation_(); if (!scope) return null;
  var retained = gibM1EmailFirstRead_(PropertiesService.getScriptProperties(), message.messageId.slice(-10));
  if (!retained) return null;
  return gibM1MailAppResult_(message, 'unknown', 'MAILAPP_ORIGINAL_CONFLICT', retained.attemptedAt || null);
}
// Best-effort history in the existing immutable mail ledger. Its absence cannot
// suppress the warning: permanent Script Properties claims own this new worker.
function gibM1EmailFirstAudit_(scope, value, rendered, event) {
  var lock = LockService.getScriptLock(), held = false;
  try {
    held = lock.tryLock(10000); if (!held) return;
    var body = { target: scope.target, token: configuredReceiverSecret_(), adminActionToken: configuredAdminActionSecret_() };
    if (scope.gym === 'richmond') { body.installation = 'richmond'; body.environment = 'production'; }
    var sheet = gibM1MailAppSheet_(body);
    gibM1MailAppAppend_(sheet, ['m1-production-scheduled-' + scope.gym + '-' + value.date, event, value.hash,
      scope.gym, value.date, value.requestId, new Date(value.attemptedAt).toISOString(), event === 'attempt' ? '' : new Date(value.completedAt).toISOString(),
      event === 'attempt' ? 'MAILAPP_CALL_PENDING' : event === 'submitted' ? 'MAILAPP_SUBMITTED' : 'MAILAPP_CALL_UNCERTAIN', GIB_M1_MAILAPP_SENDER_]);
  } catch (_) { /* The permanent claim stays authoritative. */ }
  finally { if (held) lock.releaseLock(); }
}
function gibM1AttendanceEmailFirstTick_() {
  if (!gibM1EmailFirstEnabled_() || !gibM1MailAppActor_()) return;
  var scope = gibM1LiveReminderScope_(), properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED') !== 'true'
    || properties.getProperty('GIB_M1_MAILAPP_LIVE_SEND_ENABLED') !== 'true') return;
  var now = Date.now(), date = Utilities.formatDate(new Date(now), 'America/New_York', 'yyyy-MM-dd');
  var localTime = Utilities.formatDate(new Date(now), 'America/New_York', 'HH:mm');
  if (localTime < '20:00' || localTime >= '21:00') return; // One 8pm opportunity; no morning/backlog catch-up.
  var lock = LockService.getScriptLock(), held = false, claimed, missed;
  try {
    held = lock.tryLock(10000); if (!held) return;
    if (gibM1EmailFirstRead_(properties, date)) return;
    missed = gibM1EmailFirstMissed_(properties, date);
    claimed = { date: date, startedAt: now, state: 'checking', requestId: Utilities.getUuid() };
    gibM1EmailFirstWrite_(properties, claimed); // durable before any external check or possible send
  } finally { if (held) lock.releaseLock(); }
  var rendered = gibM1EmailFirstFallback_(scope, date), report = null;
  try {
    var binding = { schema: GIB_M1_DIGEST_SCHEMA_, target: 'production', requestId: claimed.requestId, mode: 'scheduled',
      jobDate: date, createdAt: now, expiresAt: now + 60000 };
    var checked = gibM1DigestDispatch_(binding);
    if (checked.ok === true && gibM1EmailFirstReportValid_(checked.dailyEmail, scope, date)) report = checked.dailyEmail;
  } catch (_) { /* A failed website/record read still produces an honest warning. */ }
  if (report && !report.shouldSend && !missed.length) {
    properties.setProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_COVERAGE_THROUGH', date);
    gibM1EmailFirstWrite_(properties, { ...claimed, state: 'suppressed', completedAt: Date.now(), code: 'COMPLETE_CLEAN_CHECK' });
    return { ok: true, date: date, state: 'suppressed', realEmailAttempted: false };
  }
  if (report?.rendered) rendered = report.rendered;
  if (report && !report.shouldSend && missed.length) {
    var cleanNote = 'Today’s sign-in and upload check finished, and no problems were found. Earlier checks are still uncertain. We haven’t identified a specific missing sign-in, so no correction reply is needed.';
    rendered = gibM1EmailFirstCopy_(scope, 'Earlier sign-in checks are still uncertain', [cleanNote, 'Andrew will look into the earlier checks.']);
    if (scope.gym === 'richmond') rendered = gibM1EmailFirstCopy_(scope, 'Earlier sign-in checks are still incomplete', [
      'Today’s sign-in check found no questions; some earlier scheduled checks are still incomplete.'
    ]);
  }
  if (report && report.unconfirmedChecks === 0) properties.setProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_COVERAGE_THROUGH', date);
  if (missed.length && scope.gym === 'richmond' && (!report || report.shouldSend)) {
    var missedNote = 'Some earlier scheduled checks are still incomplete.';
    var greeting = 'Hi Trey,\n\n', greetingHtml = '<p>Hi Trey,</p>';
    rendered = { subject: rendered.subject,
      text: rendered.text.startsWith(greeting) ? rendered.text.replace(greeting, greeting + missedNote + '\n\n') : missedNote + '\n\n' + rendered.text,
      html: rendered.html.includes(greetingHtml) ? rendered.html.replace(greetingHtml, greetingHtml + '<p>' + missedNote + '</p>')
        : rendered.html.replace(/<body[^>]*>/, '$&<p>' + missedNote + '</p>') };
  }
  if (missed.length && scope.gym !== 'richmond') {
    var note = 'Earlier checks are still uncertain for ' + missed.length + ' day' + (missed.length === 1 ? '' : 's') + ': ' + missed[0] + (missed.length > 1 ? ' through ' + missed[missed.length - 1] : '') + '. Today’s email doesn’t resolve those older checks.';
    rendered = { subject: rendered.subject, text: rendered.text + '\n\n' + note, html: rendered.html.includes('</main>') ? rendered.html.replace('</main>', '<p>' + note + '</p></main>') : rendered.html.replace('</body>', '<p>' + note + '</p></body>') };
  }
  var expected = { to: [scope.gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com'], cc: [], bcc: ['andrew@revolutionbjj.com'] };
  var ready = properties.getProperty('GIB_M1_MAILAPP_LIVE_RECIPIENTS_JSON') === JSON.stringify(expected)
    && properties.getProperty('GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW') === 'true';
  var quota = 0; try { quota = MailApp.getRemainingDailyQuota(); } catch (_) {}
  if (!ready || !Number.isSafeInteger(quota) || quota < 2) {
    gibM1EmailFirstWrite_(properties, { ...claimed, state: 'not-sent', completedAt: Date.now(), code: 'SENDER_READINESS_UNAVAILABLE' });
    return { ok: false, date: date, state: 'not-sent', realEmailAttempted: false };
  }
  if (!gibM1EmailFirstEnabled_() || !gibM1MailAppActor_()
    || properties.getProperty('GIB_M1_MAILAPP_LIVE_SEND_ENABLED') !== 'true'
    || properties.getProperty('GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED') !== 'true') return;
  // Do not depend on Spreadsheet availability for a warning about unavailable records.
  var hash = managerHash_({ ...rendered, from: GIB_M1_MAILAPP_SENDER_, ...expected, replyTo: 'andrew@revolutionbjj.com' });
  var attempt = { ...claimed, state: 'call-pending', attemptedAt: Date.now(), hash: hash, checkConfirmed: Boolean(report) };
  gibM1EmailFirstWrite_(properties, attempt);
  gibM1EmailFirstAudit_(scope, attempt, rendered, 'attempt');
  if (!gibM1EmailFirstEnabled_() || !gibM1MailAppActor_()
    || properties.getProperty('GIB_M1_MAILAPP_LIVE_SEND_ENABLED') !== 'true'
    || properties.getProperty('GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED') !== 'true') return;
  var submitted = false;
  try { MailApp.sendEmail({ to: expected.to[0], bcc: expected.bcc[0], replyTo: 'andrew@revolutionbjj.com',
    subject: rendered.subject, body: rendered.text, htmlBody: rendered.html }); submitted = true; }
  catch (_) { /* Google may have accepted it; never resend this date. */ }
  var completed = { ...attempt, state: submitted ? 'submitted' : 'uncertain', completedAt: Date.now(),
    code: submitted ? 'GOOGLE_ACCEPTED_SEND' : 'SEND_OUTCOME_UNCERTAIN' };
  try { gibM1EmailFirstWrite_(properties, completed); } catch (_) {} // call-pending is also permanently non-retryable
  gibM1EmailFirstAudit_(scope, completed, rendered, submitted ? 'submitted' : 'exception');
  return { ok: submitted, date: date, state: completed.state, realEmailAttempted: true, inboxArrivalConfirmed: false };
}
function prepareProductionAttendanceEmailFirst() {
  var scope = gibM1LiveInstallation_(), properties = PropertiesService.getScriptProperties();
  if (!scope || !gibM1MailAppActor_() || properties.getProperty('GIB_M1_MAILAPP_LIVE_SEND_ENABLED') === 'true'
    || properties.getProperty('GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED') === 'true') throw new Error('EMAIL_FIRST_PREPARATION_UNAVAILABLE');
  var body = { target: scope.target, token: configuredReceiverSecret_(), adminActionToken: configuredAdminActionSecret_() };
  if (scope.gym === 'richmond') { body.installation = 'richmond'; body.environment = 'production'; }
  var sheet = gibM1MailAppHeaders_(openExpectedSpreadsheet_(body).getSheetByName(GIB_M1_MAILAPP_TAB_));
  var date = todayNewYork_(), last = sheet.getLastRow();
  if (last > 1 && sheet.getRange(2, 5, last - 1, 1).getValues().some(function(row) { return row[0] === date; })) throw new Error('EMAIL_FIRST_EXISTING_DAY_CLAIM');
  var start = properties.getProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE');
  if (!start) properties.setProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE', date);
  else if (!gibM1MailAppDate_(start)) throw new Error('EMAIL_FIRST_START_UNAVAILABLE');
  properties.setProperty('GIB_M1_ATTENDANCE_EMAIL_FIRST_READY', 'v1');
  var result = { ok: true, gym: scope.gym, startDate: start || date, senderVerified: true, realEmailSent: false };
  console.log('M1_EMAIL_FIRST_PREPARED ' + JSON.stringify(result)); return result;
}
function verifyProductionAttendanceEmailFirstReadOnly() {
  var scope = gibM1LiveReminderScope_();
  if (!scope || !gibM1MailAppActor_() || !gibM1EmailFirstEnabled_()) throw new Error('EMAIL_FIRST_STATUS_UNAVAILABLE');
  var now = Date.now(), date = todayNewYork_();
  var checked = gibM1DigestDispatch_({ schema: GIB_M1_DIGEST_SCHEMA_, target: 'production', requestId: Utilities.getUuid(),
    mode: 'scheduled', jobDate: date, createdAt: now, expiresAt: now + 60000 }, true);
  var valid = checked.ok === true && checked.readOnly === true && gibM1EmailFirstReportValid_(checked.dailyEmail, scope, date);
  var result = { ok: valid, gym: scope.gym, date: date, checkedAt: new Date(now).toISOString(), readOnly: true,
    issueCount: valid ? checked.dailyEmail.issueCount : null, unconfirmedChecks: valid ? checked.dailyEmail.unconfirmedChecks : null,
    realEmailSent: false, code: valid ? 'READ_ONLY_CHECK_COMPLETE' : 'READ_ONLY_CHECK_UNAVAILABLE' };
  console.log('M1_EMAIL_FIRST_READ_ONLY ' + JSON.stringify(result)); return result;
}
function productionAttendanceEmailFirstStatus() {
  var scope = gibM1LiveInstallation_(); if (!scope || !gibM1MailAppActor_()) throw new Error('EMAIL_FIRST_STATUS_UNAVAILABLE');
  var properties = PropertiesService.getScriptProperties(), date = todayNewYork_();
  var result = { gym: scope.gym, date: date, enabled: gibM1EmailFirstEnabled_(),
    sendEnabled: properties.getProperty('GIB_M1_MAILAPP_LIVE_SEND_ENABLED') === 'true',
    scheduleEnabled: properties.getProperty('GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED') === 'true',
    latestToday: gibM1EmailFirstRead_(properties, date), inboxArrivalConfirmed: false };
  console.log('M1_EMAIL_FIRST_STATUS ' + JSON.stringify(result)); return result;
}
