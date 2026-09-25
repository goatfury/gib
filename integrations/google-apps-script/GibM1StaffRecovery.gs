/* Revolution TEST only. Requests and decisions are append-only; Staff Time IDs
 * and columns stay unchanged. A boundary is evidence of a new shift, never an
 * inferred finish time or paid hours for its unresolved predecessor. */
var GIB_M1_STAFF_RECOVERY_HEADERS_ = ['Event ID', 'Recovery ID', 'Event', 'Time', 'Payload', 'Payload hash'];
function staffRecoveryEnabled_() {
  return configuredDeploymentTarget_() === 'test'
    && typeof managerReviewTestEnabled_ === 'function' && managerReviewTestEnabled_()
    && typeof GIB_M1_RICHMOND_INSTALLATION_ === 'undefined';
}
// Editor-only, two-minute TEST fault. It changes delivery, never a saved punch.
// Consumption happens inside the operation's existing lock, with no extra lock.
function testRevolutionStaffRecoveryLostReply() {
  if (!staffRecoveryEnabled_()) throw new Error('Revolution TEST project required.');
  PropertiesService.getScriptProperties().setProperty('M1_TEST_STAFF_RECOVERY_LOST_REPLY', JSON.stringify({ staffId: 'mandy-test', expiresAt: Date.now() + 120000 }));
  return { armed: true, expiresInSeconds: 120 };
}
function testRevolutionStaffRecoveryLostReplyReceipt() {
  if (!staffRecoveryEnabled_()) throw new Error('Revolution TEST project required.');
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('M1_TEST_STAFF_RECOVERY_RECEIPT') || 'null');
}
function staffRecoveryTestFault_(stage, item) {
  if (!staffRecoveryEnabled_()) return false;
  try {
    var properties = PropertiesService.getScriptProperties();
    var key = stage === 'saved' ? 'M1_TEST_STAFF_RECOVERY_LOST_REPLY' : 'M1_TEST_STAFF_RECOVERY_LOST_READ';
    var raw = properties.getProperty(key);
    if (!raw) return false;
    var fault = JSON.parse(raw);
    if (!Number.isFinite(fault.expiresAt) || fault.expiresAt < Date.now()) { properties.deleteProperty(key); return false; }
    if (stage === 'saved' ? fault.staffId !== 'mandy-test' || item.staffId !== 'mandy-test' : fault.requestId !== item.requestId) return false;
    properties.deleteProperty(key);
    if (stage === 'saved') {
      properties.setProperty('M1_TEST_STAFF_RECOVERY_LOST_READ', JSON.stringify({ requestId: item.requestId, expiresAt: fault.expiresAt }));
      properties.setProperty('M1_TEST_STAFF_RECOVERY_RECEIPT', JSON.stringify({ requestId: item.requestId, stage: 'saved-before-reply-loss' }));
    }
    return true;
  } catch (error) { return false; } // Fault instrumentation is never a dependency.
}
function staffRecoveryExact_(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());
}
function staffRecoveryFail_(message) { throw new Error(message || 'Staff recovery history could not be confirmed.'); }
function staffRecoveryConflict_(message) { return jsonResult_({ ok: false, result: 'conflict', message: message || 'Staff time changed. Refresh before reviewing.' }); }
function staffRecoveryJournal_(spreadsheet, create) {
  var sheet = spreadsheet.getSheetByName('Staff Recovery');
  if (!sheet && create) { sheet = spreadsheet.insertSheet('Staff Recovery'); sheet.appendRow(GIB_M1_STAFF_RECOVERY_HEADERS_); SpreadsheetApp.flush(); }
  if (!sheet) return { sheet: null, entries: [], byId: {} };
  var rows = sheet.getDataRange().getValues(), byId = {};
  if (rows.length > 5001 || JSON.stringify(rows[0]) !== JSON.stringify(GIB_M1_STAFF_RECOVERY_HEADERS_)) staffRecoveryFail_();
  var entries = rows.slice(1).map(function(row) {
    if (row.length !== 6 || !row[0] || byId[row[0]] || !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(row[1])
      || ['requested', 'decision', 'confirmed'].indexOf(row[2]) < 0 || !staffClockTimestamp_(row[3])
      || typeof row[4] !== 'string' || row[4].length > 8000 || staffClockSha256Hex_(row[4]) !== row[5]) staffRecoveryFail_();
    var entry = { id: row[0], recoveryId: row[1], kind: row[2], time: row[3], value: JSON.parse(row[4]) };
    byId[entry.id] = entry; return entry;
  });
  return { sheet: sheet, entries: entries, byId: byId };
}
function staffRecoveryAppend_(spreadsheet, id, recoveryId, kind, time, value) {
  var journal = staffRecoveryJournal_(spreadsheet, true), payload = JSON.stringify(value);
  if (journal.byId[id]) {
    var existing = journal.byId[id];
    if (existing.recoveryId !== recoveryId || existing.kind !== kind || JSON.stringify(existing.value) !== payload) staffRecoveryFail_();
    return;
  }
  journal.sheet.appendRow([id, recoveryId, kind, time, payload, staffClockSha256Hex_(payload)]);
  SpreadsheetApp.flush();
  if (!staffRecoveryJournal_(spreadsheet, false).byId[id]) staffRecoveryFail_();
}
function staffRecoveryPunchBody_(record) {
  return { punchId: record.punchId, timestamp: record.timestamp, date: record.date, staffId: record.staffId,
    staffName: record.staffName, punchAction: record.action, site: record.site, device: record.device, build: record.build, note: record.note };
}
function staffRecoverySamePunch_(record, punch) {
  return record && ['ACTIVE', 'VOID'].indexOf(record.status) >= 0 && record.source === 'Tablet' && !record.adminName
    && JSON.stringify(staffRecoveryPunchBody_(record)) === JSON.stringify(punch);
}
function staffRecoveryHistoryRoster_(staffState) {
  // Current availability controls new punches, not validation of immutable
  // history. Keep exact roster identities without mutating their active flags.
  var byId = {};
  Object.keys(staffState.byId).forEach(function(id) {
    var copy = {};
    Object.keys(staffState.byId[id]).forEach(function(key) { copy[key] = staffState.byId[id][key]; });
    copy.active = true; byId[id] = copy;
  });
  return { byId: byId };
}
function staffRecoveryStartInput_(body, staffState, historical) {
  var input = body.recovery;
  if (!staffRecoveryExact_(input, ['requestId', 'previousClockInPunchId', 'punch', 'proposedFinishAt'])
    || !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(input.requestId) || !GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(input.previousClockInPunchId)
    || !staffRecoveryExact_(input.punch, ['punchId', 'timestamp', 'date', 'staffId', 'staffName', 'punchAction', 'site', 'device', 'build', 'note'])) return null;
  var candidate = validateStaffClockPunch_(input.punch, historical ? staffRecoveryHistoryRoster_(staffState) : staffState);
  if (!candidate || candidate.action !== 'clockIn' || candidate.site !== 'Rev' || candidate.punchId === input.previousClockInPunchId
    || (input.proposedFinishAt !== null && staffClockTimestamp_(input.proposedFinishAt) !== input.proposedFinishAt)) return null;
  return { input: input, candidate: candidate };
}
function staffRecoveryFinishValid_(finish, previousAt, startedAt) {
  return staffClockTimestamp_(finish) === finish && Date.parse(finish) > Date.parse(previousAt)
    && Date.parse(finish) <= Date.parse(startedAt) && Date.parse(finish) - Date.parse(previousAt) <= GIB_M1_STAFF_MAX_SHIFT_MS_;
}
function staffRecoveryDecisionInput_(body) {
  var value = body.decision;
  if (!staffRecoveryExact_(value, ['requestId', 'recoveryRequestId', 'revision', 'decision', 'finishAt', 'punchId', 'reason'])
    || !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(value.requestId) || !GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(value.recoveryRequestId)
    || value.requestId === value.recoveryRequestId || !Number.isSafeInteger(value.revision) || value.revision < 0
    || ['approve', 'reject'].indexOf(value.decision) < 0 || safeExactText_(value.reason, 240, false) !== value.reason || value.reason.length < 3
    || (value.decision === 'reject' && (value.finishAt !== null || value.punchId !== null))
    || (value.decision === 'approve' && (!GIB_M1_STAFF_PUNCH_ID_PATTERN_.test(value.punchId) || staffClockTimestamp_(value.finishAt) !== value.finishAt))) return null;
  return value;
}
function staffRecoveryCorrection_(item, decision, adminName) {
  return { requestId: decision.requestId, punchId: decision.punchId, staffId: item.staffId, staffName: item.staffName,
    punchAction: 'clockOut', timestamp: decision.finishAt, date: decision.finishAt.slice(0, 10), reason: decision.reason,
    adminName: adminName, site: 'Rev', device: 'Admin Staff Time', build: 'm1b-staff-clock' };
}
function staffRecoveryState_(spreadsheet, options) {
  options = options || {};
  var staff = staffClockStaffState_(spreadsheet), raw = staffClockReadTime_(spreadsheet, staff, { skipRecovery: true });
  var journal = staffRecoveryJournal_(spreadsheet, false), items = [], byId = {}, prior = {}, newIds = {}, intents = {}, decisions = {};
  journal.entries.forEach(function(entry) {
    if (entry.kind === 'requested') {
      var value = entry.value, parsed = staffRecoveryStartInput_({ recovery: value.original }, staff, true);
      if (!parsed || entry.id !== parsed.input.requestId || entry.recoveryId !== entry.id || byId[entry.id]
        || !staffRecoveryExact_(value, ['original', 'previousClockInAt', 'proposedBy', 'proposedAt'])
        || value.proposedBy !== parsed.candidate.staffName || value.proposedAt !== entry.time) staffRecoveryFail_();
      var input = parsed.input, previous = raw.byId[input.previousClockInPunchId], next = raw.byId[input.punch.punchId];
      if (!previous || previous.action !== 'clockIn' || previous.staffId !== parsed.candidate.staffId
        || previous.site !== 'Rev' || previous.timestamp !== value.previousClockInAt || prior[previous.punchId] || newIds[input.punch.punchId]
        || Date.parse(input.punch.timestamp) <= previous.timestampMs
        || (input.proposedFinishAt !== null && !staffRecoveryFinishValid_(input.proposedFinishAt, previous.timestamp, input.punch.timestamp))) staffRecoveryFail_();
      if (next && !staffRecoverySamePunch_(next, input.punch)) staffRecoveryFail_();
      if (!next && options.pendingStart !== input.requestId) staffRecoveryFail_('A retained Staff start must finish saving before recovery can be read.');
      prior[previous.punchId] = true; newIds[input.punch.punchId] = true;
      var item = { requestId: input.requestId, staffId: input.punch.staffId, staffName: input.punch.staffName,
        previousClockInPunchId: previous.punchId, previousClockInAt: value.previousClockInAt, newClockInPunchId: input.punch.punchId,
        startedAt: input.punch.timestamp, proposedFinishAt: input.proposedFinishAt, proposedBy: value.proposedBy, proposedAt: value.proposedAt,
        status: 'pending', revision: 0, decision: null, punch: input.punch, conflicts: [] };
      if (previous.status === 'VOID') item.conflicts.push('previous-punch-void');
      if (next && next.status === 'VOID') item.conflicts.push('new-punch-void');
      items.push(item); byId[item.requestId] = item;
      if (next) { next.recoveryRequestId = item.requestId; next.previousClockInPunchId = item.previousClockInPunchId; }
    } else if (entry.kind === 'decision') {
      var value = entry.value, item = byId[entry.recoveryId], parsed = staffRecoveryDecisionInput_({ decision: value.original });
      if (!item || !parsed || !staffRecoveryExact_(value, ['original', 'adminName', 'decidedAt']) || entry.id !== parsed.requestId
        || parsed.recoveryRequestId !== item.requestId || parsed.revision !== item.revision || item.status === 'approved'
        || GIB_M1_ADMIN_NAMES_.indexOf(value.adminName) < 0 || value.decidedAt !== entry.time || intents[item.requestId]) staffRecoveryFail_();
      if (parsed.decision === 'approve' && !staffRecoveryFinishValid_(parsed.finishAt, item.previousClockInAt, item.startedAt)) staffRecoveryFail_();
      intents[item.requestId] = entry; decisions[entry.id] = entry;
    } else {
      var intent = intents[entry.recoveryId], item = byId[entry.recoveryId];
      if (!intent || !staffRecoveryExact_(entry.value, ['requestId']) || entry.value.requestId !== intent.id || entry.id !== intent.id + '-confirmed') staffRecoveryFail_();
      var d = intent.value.original;
      if (d.decision === 'approve') {
        var correction = validateStaffTimeCorrection_(staffRecoveryCorrection_(item, d, intent.value.adminName), staffRecoveryHistoryRoster_(staff));
        var audit = staffClockReadAudit_(spreadsheet, staff, raw).byRequestId[d.requestId], punch = raw.byId[d.punchId];
        if (!correction || !punch || punch.source !== 'Admin-added' || punch.note !== correction.record.note
          || !audit || !staffClockAuditMatchesCorrection_(audit, correction, punch) || audit.linkedPunchId !== d.punchId) staffRecoveryFail_();
        if (punch.status === 'VOID') item.conflicts.push('finish-punch-void');
      }
      item.revision += 1; item.status = d.decision === 'approve' ? 'approved' : 'rejected';
      item.decision = { requestId: d.requestId, recoveryRequestId: item.requestId, revision: item.revision, decision: d.decision,
        finishAt: d.finishAt, punchId: d.punchId, reason: d.reason, adminName: intent.value.adminName, decidedAt: intent.value.decidedAt };
      intent.receipt = item.decision; delete intents[item.requestId];
    }
  });
  Object.keys(intents).forEach(function(id) { if (intents[id].id !== options.pendingDecision) staffRecoveryFail_('A retained manager decision must finish saving before recovery can be read.'); });
  return { staff: staff, raw: raw, journal: journal, items: items, byId: byId, intents: intents, decisions: decisions };
}
function staffRecoveryOverlay_(spreadsheet, raw) {
  if (!spreadsheet.getSheetByName('Staff Recovery')) return raw;
  // Stored boundaries remain readable if entry controls are subsequently off.
  var verified = staffRecoveryState_(spreadsheet);
  raw.records.forEach(function(record) {
    var proof = verified.raw.byId[record.punchId];
    if (proof && proof.recoveryRequestId) { record.recoveryRequestId = proof.recoveryRequestId; record.previousClockInPunchId = proof.previousClockInPunchId; }
  });
  return raw;
}
function staffRecoveryPublic_(state) {
  var value = { enabled: true, items: state.items };
  if (state.items.length > 100 || JSON.stringify(value).length > 80000) staffRecoveryFail_('Staff recovery requires a bounded review window.');
  return value;
}
function staffRecoveryBoundary_(record, records, open, shifts, seen) {
  var previous = records.filter(function(value) { return value.punchId === record.previousClockInPunchId; });
  if (!GIB_M1_STAFF_REQUEST_ID_PATTERN_.test(record.recoveryRequestId) || previous.length !== 1
    || record.source !== 'Tablet' || previous[0].action !== 'clockIn' || previous[0].staffId !== record.staffId
    || previous[0].site !== record.site || previous[0].timestampMs >= record.timestampMs
    || seen[record.recoveryRequestId] || seen[record.previousClockInPunchId]) return false;
  var latest = shifts.length ? shifts[shifts.length - 1] : null;
  if (open ? open.punchId !== previous[0].punchId : !latest || latest.clockIn.punchId !== previous[0].punchId || latest.clockOut.timestampMs > record.timestampMs) return false;
  seen[record.recoveryRequestId] = true; seen[record.previousClockInPunchId] = true; return true;
}
function staffRecoveryMayPunch_(current, candidate) {
  if (!current || current.structuralContradiction) return false;
  return current.issues.every(function(issue) {
    if (issue.code === 'missing_clock_out_recovery') return true;
    return staffRecoveryEnabled_() && issue.code === 'missing_clock_out' && current.open
      && candidate.action === 'clockOut' && candidate.timestampMs > current.open.timestampMs
      && candidate.timestampMs - current.open.timestampMs <= GIB_M1_STAFF_MAX_SHIFT_MS_;
  });
}
function staffRecoveryStartReceipt_(item) {
  return { requestId: item.requestId, previousClockInPunchId: item.previousClockInPunchId, newClockInPunchId: item.newClockInPunchId,
    startedAt: item.startedAt, proposedFinishAt: item.proposedFinishAt, status: 'pending' };
}
function staffRecoveryAction_(body) {
  if (!staffRecoveryEnabled_() || requestTarget_(body) !== 'test') return rejectedAuthResult_();
  var admin = body.action === 'staffRecoveryReview' || body.action === 'staffRecoveryDecide';
  if (!(admin ? adminActionAuthorized_(body) : receiverKioskAuthorized_(body))) return rejectedAuthResult_();
  return staffClockWithLock_('Staff recovery is busy. Retry the same request.', function() {
    var spreadsheet = openExpectedSpreadsheet_(body);
    if (spreadsheet.getName() !== 'RBJJ M1 — TEST') return rejectedAuthResult_();
    if (body.action === 'staffRecoveryRead' || body.action === 'staffRecoveryReview') {
      var state = staffRecoveryState_(spreadsheet);
      if (body.action === 'staffRecoveryRead' && state.items.some(function(item) { return staffRecoveryTestFault_('read', item); })) return jsonResult_({ ok: false, result: 'failed', message: 'TEST Staff recovery confirmation is unavailable.' });
      return jsonResult_({ ok: true, target: 'test', recovery: staffRecoveryPublic_(state) });
    }
    if (body.action === 'staffRecoveryStart') {
      var parsed = staffRecoveryStartInput_(body, staffClockStaffState_(spreadsheet));
      if (!parsed) return rejectedAuthResult_();
      var input = parsed.input, state = staffRecoveryState_(spreadsheet, { pendingStart: input.requestId }), existing = state.byId[input.requestId];
      if (existing && JSON.stringify(state.journal.byId[input.requestId].value.original) !== JSON.stringify(input)) return staffRecoveryConflict_('This request ID belongs to a different Staff start.');
      if (existing && state.raw.byId[existing.newClockInPunchId]) return jsonResult_({ ok: true, target: 'test', recovery: staffRecoveryPublic_(state), receipt: staffRecoveryStartReceipt_(existing) });
      var adjustment = staffClockAdjustmentSheetState_(spreadsheet, state.staff, state.raw, false);
      var effective = staffClockApplyAdjustments_(state.raw, adjustment), current = staffClockAnalyze_(state.staff, effective).byStaff[parsed.candidate.staffId];
      var previous = current && current.open;
      if (!previous || previous.punchId !== input.previousClockInPunchId || previous.timestamp !== state.raw.byId[previous.punchId].timestamp
        || current.structuralContradiction || current.issues.some(function(issue) { return ['missing_clock_out', 'missing_clock_out_recovery'].indexOf(issue.code) < 0; })
        || parsed.candidate.timestampMs <= current.last.timestampMs || parsed.candidate.timestampMs > Date.now() + 5 * 60 * 1000
        || (!existing && (state.raw.byId[parsed.candidate.punchId] || state.items.some(function(item) { return item.previousClockInPunchId === previous.punchId; })))
        || (input.proposedFinishAt !== null && !staffRecoveryFinishValid_(input.proposedFinishAt, previous.timestamp, parsed.candidate.timestamp))) return staffRecoveryConflict_();
      if (!existing) {
        var proposedAt = staffClockNowTimestamp_();
        staffRecoveryAppend_(spreadsheet, input.requestId, input.requestId, 'requested', proposedAt,
          { original: input, previousClockInAt: previous.timestamp, proposedBy: parsed.candidate.staffName, proposedAt: proposedAt });
      }
      staffClockAppendTime_(state.raw, parsed.candidate); SpreadsheetApp.flush();
      state = staffRecoveryState_(spreadsheet);
      if (staffRecoveryTestFault_('saved', state.byId[input.requestId])) return jsonResult_({ ok: false, result: 'failed', message: 'TEST Staff recovery confirmation is unavailable.' });
      return jsonResult_({ ok: true, target: 'test', recovery: staffRecoveryPublic_(state), receipt: staffRecoveryStartReceipt_(state.byId[input.requestId]) });
    }
    if (body.action !== 'staffRecoveryDecide' || GIB_M1_ADMIN_NAMES_.indexOf(body.adminName) < 0) return rejectedAuthResult_();
    var input = staffRecoveryDecisionInput_(body);
    if (!input) return rejectedAuthResult_();
    var state = staffRecoveryState_(spreadsheet, { pendingDecision: input.requestId }), existing = state.decisions[input.requestId], item = state.byId[input.recoveryRequestId];
    if (existing && (JSON.stringify(existing.value.original) !== JSON.stringify(input) || existing.value.adminName !== body.adminName)) return staffRecoveryConflict_('This request ID belongs to a different manager decision.');
    if (existing && existing.receipt) return jsonResult_({ ok: true, target: 'test', recovery: staffRecoveryPublic_(state), receipt: existing.receipt });
    if (!item || item.revision !== input.revision || item.status === 'approved') return staffRecoveryConflict_();
    if (input.decision === 'approve') {
      if (item.conflicts.length) return staffRecoveryConflict_('A linked Staff punch is VOID. Review its existing correction history before approving a finish.');
      if (!state.staff.byId[item.staffId].active) return staffRecoveryConflict_('This staff member is inactive. The earlier shift remains unresolved.');
      if (!staffRecoveryFinishValid_(input.finishAt, item.previousClockInAt, item.startedAt) || input.punchId === item.previousClockInPunchId || input.punchId === item.newClockInPunchId) return staffRecoveryConflict_('Choose an actual finish after the earlier start, before the new shift, within 18 hours.');
      var adjustment = staffClockAdjustmentSheetState_(spreadsheet, state.staff, state.raw, false), effective = staffClockApplyAdjustments_(state.raw, adjustment);
      if (effective.byId[item.previousClockInPunchId].timestamp !== item.previousClockInAt || effective.byId[item.newClockInPunchId].timestamp !== item.startedAt
        || effective.records.some(function(record) { return record.status === 'ACTIVE' && record.staffId === item.staffId && record.punchId !== input.punchId
          && record.timestampMs > Date.parse(item.previousClockInAt) && record.timestampMs < Date.parse(item.startedAt); })) return staffRecoveryConflict_();
      if (!existing && state.raw.byId[input.punchId]) return staffRecoveryConflict_();
    }
    if (!existing) {
      var decisionTime = staffClockNowTimestamp_();
      staffRecoveryAppend_(spreadsheet, input.requestId, item.requestId, 'decision', decisionTime, { original: input, adminName: body.adminName, decidedAt: decisionTime });
    }
    if (input.decision === 'approve') {
      var correction = staffRecoveryCorrection_(item, input, body.adminName);
      correction.target = 'test';
      var result = JSON.parse(staffTimeCorrectUnlocked_(correction, { skipRecovery: true }).getContent());
      if (result.ok !== true || result.requestId !== input.requestId || result.linkedPunchId !== input.punchId) staffRecoveryFail_();
    }
    staffRecoveryAppend_(spreadsheet, input.requestId + '-confirmed', item.requestId, 'confirmed', staffClockNowTimestamp_(), { requestId: input.requestId });
    state = staffRecoveryState_(spreadsheet);
    return jsonResult_({ ok: true, target: 'test', recovery: staffRecoveryPublic_(state), receipt: state.decisions[input.requestId].receipt });
  });
}
function staffRecoveryOutstanding_(spreadsheet) {
  if (!staffRecoveryEnabled_()) staffRecoveryFail_('Staff recovery read is not enabled.');
  var state = staffRecoveryState_(spreadsheet), adjustment = staffClockAdjustmentSheetState_(spreadsheet, state.staff, state.raw, false);
  var analysis = staffClockAnalyze_(state.staff, staffClockApplyAdjustments_(state.raw, adjustment)), items = [];
  state.items.filter(function(item) {
    if (item.conflicts.length) return true;
    if (item.status === 'approved') return false;
    // A rejected proposal is no longer outstanding if an existing audited tool
    // independently supplied the valid missing punch. A pending proposal still
    // requires a manager decision, even when another correction arrived first.
    return item.status !== 'rejected' || !analysis.completedShifts.some(function(shift) {
      return shift.clockIn.punchId === item.previousClockInPunchId && shift.clockOut.timestampMs <= Date.parse(item.startedAt)
        && shift.elapsedMs > 0 && shift.elapsedMs <= GIB_M1_STAFF_MAX_SHIFT_MS_;
    });
  }).forEach(function(item) {
    items.push({ id: item.requestId, kind: item.conflicts.length ? 'staff-conflict' : 'time-correction', staffName: item.staffName, date: item.previousClockInAt.slice(0, 10), status: 'pending',
      summary: item.conflicts.length ? 'A linked Staff punch is VOID; its recovery history needs manager review.' : item.proposedFinishAt === null ? 'Earlier shift finish time is unknown and needs manager review.' : 'Employee finish time proposal needs manager review.', proposalId: item.requestId });
  });
  analysis.issues.filter(function(issue) { return issue.code !== 'missing_clock_out_recovery'; }).forEach(function(issue) {
    items.push({ id: issue.code + ':' + issue.staffId + ':' + issue.linkedPunchIds.join(':'), kind: issue.code === 'missing_clock_out' ? 'forgotten-clock-out' : 'staff-conflict',
      staffName: issue.staffName, date: issue.date, status: 'pending', summary: issue.message });
  });
  return { ok: true, complete: true, items: items };
}
