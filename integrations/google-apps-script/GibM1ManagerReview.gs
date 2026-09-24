/* Explicitly gated day review journal. Attendance remains in Signins and AdminAudit. */
function managerReviewTestEnabled_() {
  return typeof GIB_M1_MANAGER_REVIEW_TEST_ENABLED !== 'undefined'
    && GIB_M1_MANAGER_REVIEW_TEST_ENABLED === true && configuredDeploymentTarget_() === 'test';
}
function managerReviewEnabled_() {
  return managerReviewTestEnabled_() || (
    typeof GIB_M1_MANAGER_REVIEW_LIVE_ENABLED !== 'undefined'
    && GIB_M1_MANAGER_REVIEW_LIVE_ENABLED === true
    && configuredDeploymentTarget_() === 'production'
    && typeof GIB_M1_RICHMOND_INSTALLATION_ === 'undefined'
    && typeof GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ === 'undefined'
  );
}
function managerHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function managerAttendanceHash_(records) {
  return managerHash_(records.map(function(r) { return [r.rowId, r.timestamp, r.date, r.classLabel, r.duration, r.instructor, r.site, r.device, r.build, r.notes, r.status]; })
    .sort(function(a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); }));
}
function managerRequestHash_(reviewer, input) {
  return managerHash_([reviewer, input.requestId, input.date, input.action, input.revision, input.attendanceHash, input.scheduleHash, input.decisions]);
}
function managerAdditionCheckHash_(original, reviewer, target) {
  var fields = ['requestId', 'date', 'classLabel', 'duration', 'instructor', 'site', 'notes', 'reason'];
  if (['test', 'production'].indexOf(target) < 0 || GIB_M1_ADMIN_NAMES_.indexOf(reviewer) < 0
    || !original || Array.isArray(original) || JSON.stringify(Object.keys(original).sort()) !== JSON.stringify(fields.slice().sort())
    || typeof original.requestId !== 'string' || !/^(?:m1-\d{4}-\d{2}-\d{2}-[0-9a-f]{24}|manager-add-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(original.requestId)
    || (target === 'production' && original.requestId.indexOf('m1-') !== 0)
    || typeof original.date !== 'string' || !validCalendarDate_(original.date) || original.date < '2026-09-07'
    || (original.requestId.indexOf('m1-') === 0 && original.requestId.slice(3, 13) !== original.date)
    || typeof original.duration !== 'number' || !isFinite(original.duration) || original.duration <= 0 || original.duration > 8
    || original.site !== 'Rev') throw new Error('Invalid original addition binding.');
  [['classLabel', 200, false], ['instructor', 100, false], ['notes', 400, true], ['reason', 240, false]].forEach(function(rule) {
    var value = original[rule[0]];
    if (typeof value !== 'string' || value !== safeText_(value, rule[1], rule[2]) || (rule[0] === 'reason' && value.length < 3)) throw new Error('Invalid original addition binding.');
  });
  if (target === 'test' && !obviousTestValue_(original.instructor)) throw new Error('Synthetic TEST original required.');
  return managerHash_(['adminAdditionCheckRead', target, 'rev', reviewer].concat(fields.map(function(field) { return original[field]; })));
}
function managerJournal_(spreadsheet, create) {
  var headers = ['Request ID', 'Gym', 'Date', 'Revision', 'Reviewer', 'Time', 'Action', 'Attendance hash', 'Schedule hash', 'Decisions', 'Reviewed data', 'Request hash'];
  var sheet = spreadsheet.getSheetByName('Manager Reviews');
  if (!sheet && create) { sheet = spreadsheet.insertSheet('Manager Reviews'); sheet.appendRow(headers); }
  if (!sheet) return { sheet: null, events: [] };
  var rows = sheet.getDataRange().getValues();
  if (JSON.stringify(rows[0]) !== JSON.stringify(headers) || rows.length > 5001) throw new Error('Review journal is incomplete or oversized.');
  var ids = {};
  var revisions = {};
  var events = rows.slice(1).map(function(row) {
    if (!row[0] || ids[row[0]]) throw new Error('Review request identity conflict.');
    ids[row[0]] = true;
    var date = displayDate_(row[2]);
    var revision = Number(row[3]);
    if (!validCalendarDate_(date) || revision !== (revisions[date] || 0) + 1 || ['partial', 'complete'].indexOf(row[6]) < 0) throw new Error('Review history conflict.');
    revisions[date] = revision;
    return { requestId: row[0], gym: row[1], date: date, revision: revision, reviewer: row[4], time: String(row[5]), action: row[6], attendanceHash: row[7], scheduleHash: row[8], decisions: JSON.parse(row[9]), snapshot: JSON.parse(row[10]), requestHash: row[11] };
  });
  return { sheet: sheet, events: events };
}
function managerDay_(date, state, events) {
  var all = state.records.filter(function(r) { return r.date === date; });
  var warnings = [];
  var records = [];
  state.records.forEach(function(r) {
    if (!activeRecord_(r)) return;
    if (!validCalendarDate_(r.date)) { warnings.push(unreadableDateWarning_(r)); return; }
    if (r.date !== date) return;
    if (reviewRecordIssue_(r)) { warnings.push(unreadableWarning_(r)); return; }
    if (!r.rowId || state.records.filter(function(other) { return other.rowId === r.rowId; }).length !== 1) {
      warnings.push({ code: 'RECORD_ID_CONFLICT', message: 'An attendance record has an ambiguous permanent ID.' });
    }
    var value = publicRecord_(r);
    value.fingerprint = managerAttendanceHash_([r]);
    // Production opens the existing Daily Review, which independently checks eligibility.
    value.correctable = Boolean(r.rowId) && (configuredDeploymentTarget_() === 'production' || obviousTestValue_(r.instructor))
      && state.records.filter(function(other) { return other.rowId === r.rowId; }).length === 1;
    records.push(value);
  });
  var reviews = events.filter(function(event) { return event.date === date; });
  return { date: date, records: records, warnings: warnings, attendanceHash: managerAttendanceHash_(all), review: reviews.length ? reviews[reviews.length - 1] : null };
}
function managerReviewAction_(body, readTrace) {
  var target = configuredDeploymentTarget_();
  if (!managerReviewEnabled_() || requestTarget_(body) !== target || !adminActionAuthorized_(body)) return rejectedAuthResult_();
  if (['managerReviewRead', 'managerReviewSave', 'adminAdditionCheckRead'].indexOf(body.action) < 0 && !(body.action === 'managerReviewVoid' && managerReviewTestEnabled_())) return rejectedAuthResult_();
  var gym = typeof GIB_M1_RICHMOND_INSTALLATION_ !== 'undefined' ? 'richmond' : 'rev';
  if (body.gym !== gym || body.from !== '2026-09-07' || body.to !== todayNewYork_()) return rejectedAuthResult_();
  var additionCheck = body.action === 'adminAdditionCheckRead';
  if (additionCheck && (gym !== 'rev' || body.originalHash !== managerAdditionCheckHash_(body.original, body.adminName, target)
    || body.date !== body.original.date || body.date > body.to || body.check !== undefined)) return rejectedAuthResult_();
  var trace = (body.action === 'managerReviewRead' || additionCheck) && typeof readTrace === 'function' ? readTrace : function() {};
  var lock = LockService.getScriptLock();
  trace('google.lock', 'waiting');
  if (!lock.tryLock(10000)) {
    trace('google.lock', 'unavailable');
    return jsonResult_({ ok: false, message: 'Records are changing. Retry after refreshing.' });
  }
  trace('google.lock', 'acquired');
  try {
    trace('google.read', 'start');
    var spreadsheet = openExpectedSpreadsheet_(body);
    var expectedName = target === 'production' ? 'RBJJ M1 — PRODUCTION' : (gym === 'rev' ? 'RBJJ M1 — TEST' : 'Richmond BJJ M1 — TEST');
    if (spreadsheet.getName() !== expectedName) return rejectedAuthResult_();
    var state = readSignins_(signinsSheet_(spreadsheet), { tolerantReview: true });
    if (state.records.length > 20000) throw new Error('Attendance range too large.');
    var journal = managerJournal_(spreadsheet, false);
    if (journal.events.some(function(e) { return e.gym !== gym; })) throw new Error('Wrong gym in review journal.');
    if (body.action === 'managerReviewRead' || additionCheck) {
      var days = [];
      var stamp = new Date(body.from + 'T12:00:00Z').getTime();
      for (var i = 0; i <= 3660; i++, stamp += 86400000) {
        var date = new Date(stamp).toISOString().slice(0, 10);
        if (date > body.to) break;
        days.push(managerDay_(date, state, journal.events));
      }
      if (!days.length || days[days.length - 1].date !== body.to) throw new Error('Review date range incomplete.');
      var result = { ok: true, schema: 'm1-manager-review/v1', complete: true, target: target, gym: gym, from: body.from, to: body.to, days: days };
      if (additionCheck) {
        // dailyReviewAction_ owns no lock. Read its exact audit/removal contract
        // while this one attendance lock also protects the manager snapshot.
        var dailyBody = { action: 'dailyReview', target: target, token: body.token, adminActionToken: body.adminActionToken, date: body.date };
        if (target === 'production') { dailyBody.removalVersion = 'revolution-instructor-removal-v1'; dailyBody.installation = 'rev'; dailyBody.environment = target; }
        var daily = JSON.parse(dailyReviewAction_(dailyBody).getContent());
        if (daily.ok !== true || daily.date !== body.date) throw new Error('Daily addition proof unavailable.');
        result = { ok: true, schema: 'm1-admin-addition-check/v1', target: target, gym: gym, originalHash: body.originalHash,
          date: body.date, reviewer: body.adminName,
          dailyRead: { ok: true, test: target === 'test', adminName: body.adminName, date: daily.date, records: daily.records, warnings: daily.warnings, auditHistory: daily.auditHistory }, ledger: result };
      }
      if (body.check && GIB_M1_ADMIN_NAMES_.indexOf(body.adminName) >= 0) {
        var checked = journal.events.filter(function(e) { return e.requestId === body.check.requestId; });
        if (checked.length && checked[0].requestHash !== managerRequestHash_(body.adminName, body.check)) return jsonResult_({ ok: false, message: 'Review request identity conflict.' });
        if (checked.length) result.receipt = { saved: true, requestId: checked[0].requestId, revision: checked[0].revision };
      }
      if (JSON.stringify(result).length > 240000) throw new Error('Review response requires pagination.');
      trace('google.read', 'validated');
      return jsonResult_(result);
    }
    if (GIB_M1_ADMIN_NAMES_.indexOf(body.adminName) < 0 || !validCalendarDate_(body.date) || body.date < body.from || body.date > body.to) return rejectedAuthResult_();
    if (body.action === 'managerReviewVoid') return managerReviewVoid_(body, spreadsheet, state);
    var input = body.review;
    if (!input || input.date !== body.date || !/^manager-[a-zA-Z0-9-]{16,100}$/.test(input.requestId) || ['partial', 'complete'].indexOf(input.action) < 0 || !Array.isArray(input.decisions) || !input.snapshot || JSON.stringify(input).length > 42000) return rejectedAuthResult_();
    var requestHash = managerRequestHash_(body.adminName, input);
    var previous = journal.events.filter(function(e) { return e.requestId === input.requestId; });
    if (previous.length) {
      if (previous[0].requestHash !== requestHash) return jsonResult_({ ok: false, message: 'This request ID belongs to a different review.' });
      return jsonResult_({ ok: true, saved: true, retry: true, requestId: input.requestId, revision: previous[0].revision });
    }
    var day = managerDay_(body.date, state, journal.events);
    if (input.attendanceHash !== day.attendanceHash || input.revision !== (day.review ? day.review.revision : 0)) return jsonResult_({ ok: false, conflict: true, message: 'Attendance or another review changed. Refresh before confirming.' });
    if (day.warnings.length || !/^[a-f0-9]{64}$/.test(input.scheduleHash)) return jsonResult_({ ok: false, message: 'Incomplete data cannot be confirmed.' });
    if (input.action === 'complete' && day.records.some(function(r) { return r.reviewRequired; })) return rejectedAuthResult_();
    journal = managerJournal_(spreadsheet, true);
    var revision = input.revision + 1;
    var row = [input.requestId, gym, body.date, revision, body.adminName, new Date().toISOString(), input.action, input.attendanceHash, input.scheduleHash, JSON.stringify(input.decisions), JSON.stringify(input.snapshot), requestHash];
    var destination = journal.sheet.getRange(journal.sheet.getLastRow() + 1, 1, 1, row.length);
    destination.setNumberFormat('@');
    destination.setValues([row]);
    SpreadsheetApp.flush();
    var confirmed = managerJournal_(spreadsheet, false).events.filter(function(e) { return e.requestId === input.requestId && e.requestHash === requestHash; });
    if (confirmed.length !== 1) throw new Error('Save was not confirmed.');
    return jsonResult_({ ok: true, saved: true, requestId: input.requestId, revision: revision });
  } catch (error) { trace('google.read', 'failed'); throw error; }
  finally { lock.releaseLock(); trace('google.lock', 'released'); }
}

// Same permanent VOID + append-only AdminAudit contract as existing corrections.
// The pilot can exercise it only on fake records in a permanently TEST-locked receiver.
function managerReviewVoid_(body, spreadsheet, state) {
  if (!managerReviewTestEnabled_() || requestTarget_(body) !== 'test') return rejectedAuthResult_();
  var matches = state.records.filter(function(r) { return r.rowId && r.rowId === body.recordId; });
  var reason = safeText_(body.reason, 240, false);
  if (matches.length !== 1 || !reason || reason.length < 3 || !obviousTestValue_(matches[0].instructor)) return rejectedAuthResult_();
  var record = matches[0];
  if (record.date !== body.date) return rejectedAuthResult_();
  var audit = spreadsheet.getSheetByName(GIB_M1_AUDIT_SHEET_);
  if (!audit || state.indexes.status < 0 || reviewRecordIssue_(record)) return rejectedAuthResult_();
  var value = { adminName: body.adminName, instructor: record.instructor, date: record.date, classLabel: record.classLabel, site: record.site, duration: record.duration, reason: reason };
  var linked = adminAuditValues_(audit).slice(1).filter(function(row) { return exactText_(row[10]) === record.rowId && /^(?:voided|already voided)$/.test(cleanText_(row[9]).toLowerCase()); });
  var matching = linked.filter(function(row) { return sameExactAdminAudit_(row, value, 'voided', record.rowId); });
  if (linked.length > 1 || linked.length !== matching.length) return jsonResult_({ ok: false, conflict: true, message: 'An existing correction must be confirmed before this record can change.' });
  if (!activeRecord_(record)) return jsonResult_({ ok: matching.length === 1, removed: matching.length === 1, recordId: record.rowId });
  if (body.fingerprint !== managerAttendanceHash_([record]) || matching.length > 1) return jsonResult_({ ok: false, conflict: true, message: 'The record changed. Refresh before correcting it.' });
  if (!matching.length) { appendAdminAudit_(audit, value, 'voided', record.rowId); SpreadsheetApp.flush(); }
  signinsSheet_(spreadsheet).getRange(record.sheetRow, state.indexes.status + 1).setValue('VOID');
  SpreadsheetApp.flush();
  var readback = readSignins_(signinsSheet_(spreadsheet)).records.filter(function(r) { return r.rowId === record.rowId; });
  return jsonResult_({ ok: readback.length === 1 && readback[0].status === 'VOID', removed: readback.length === 1 && readback[0].status === 'VOID', recordId: record.rowId });
}

function managerReviewHistoryComplete_(spreadsheet, row) {
  if (!managerReviewTestEnabled_()) return false;
  var records = readSignins_(signinsSheet_(spreadsheet)).records.filter(function(record) { return record.rowId === exactText_(row[10]); });
  if (records.length !== 1 || records[0].status !== 'VOID' || !obviousTestValue_(records[0].instructor)) return false;
  var r = records[0];
  return sameExactAdminAudit_(row, { adminName: row[1], instructor: r.instructor, date: r.date, classLabel: r.classLabel, site: r.site, duration: r.duration, reason: row[8] }, 'voided', r.rowId);
}
