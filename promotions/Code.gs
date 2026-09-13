/* Private synthetic TEST only. Configure the destination and owner privately in
 * Script Properties; neither setting belongs in source or browser assets. */
const PROMOTION_TEST_TITLE_ = 'GYM IN A BOX Promotions — PRIVATE SYNTHETIC TEST';
const PROMOTION_TIME_ZONE_ = 'America/New_York';
const PROMOTION_BELTS_ = ['White Belt', 'Blue Belt', 'Purple Belt', 'Brown Belt', 'Black Belt'];
const PROMOTION_APPROVERS_ = [
  { id: 'TEST-COACH-A', label: 'TEST Coach Avery' },
  { id: 'TEST-COACH-B', label: 'TEST Coach Blake' }
];
const STUDENT_HEADERS_ = [
  'student_id', 'display_name', 'distinguishing_label', 'status', 'rank_known',
  'belt', 'marks', 'mark_type', 'revision', 'last_event_id', 'legacy_refs', 'history_note'
];
const PROMOTION_HISTORY_HEADERS_ = [
  'event_id', 'request_id', 'student_id', 'revision', 'event_kind', 'event_date_ny',
  'recorded_at_utc', 'display_name', 'distinguishing_label', 'before_status',
  'after_status', 'before_rank_known', 'before_belt', 'before_marks', 'before_mark_type',
  'after_rank_known', 'after_belt', 'after_marks', 'after_mark_type', 'approver_id',
  'approver_label', 'recorder_identity', 'corrects_event_id', 'reason', 'legacy_refs',
  'history_note', 'payload_fingerprint'
];

function doGet() {
  try {
    authenticatedPromotionOwner_();
    verifiedPromotionWorkbook_();
    return HtmlService.createTemplateFromFile('Index').evaluate()
      .setTitle('Promotions · PRIVATE SYNTHETIC TEST')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (error) {
    // No roster, identity, configuration values, or exception details in denials.
    return HtmlService.createHtmlOutput('<!doctype html><html><body><h1>Private TEST access required</h1><p>This promotion tool is available only to its configured TEST manager.</p></body></html>');
  }
}

function promotionRequest(request) {
  let lock;
  let locked = false;
  try {
    const recorder = authenticatedPromotionOwner_();
    const intent = validatePromotionRequest_(request);
    const workbook = verifiedPromotionWorkbook_();
    lock = LockService.getScriptLock();
    locked = lock.tryLock(10000);
    if (!locked) failPromotion_('BUSY', 'Another save is finishing. Please retry this same request.', true);
    const state = readPromotionHistory_(workbook);
    if (intent.operation === 'bootstrap') {
      return promotionSuccess_({
        todayNY: promotionToday_(), recorderLabel: 'Signed-in TEST manager', testOnly: true,
        approvers: PROMOTION_APPROVERS_.map(item => ({ ...item })),
        students: Array.from(state.students.values())
      });
    }
    if (intent.operation === 'readStudent') {
      const student = requirePromotionStudent_(state, intent.studentId);
      return promotionSuccess_({ student, history: state.events.filter(event => event.studentId === student.studentId) });
    }
    if (intent.operation === 'checkSave') {
      const existing = state.requests.get(intent.requestId);
      return promotionSuccess_(existing
        ? { status: 'confirmed', ...confirmedPromotionResult_(workbook, state, existing.receipt) }
        : { status: 'not_found' });
    }

    const fingerprint = promotionFingerprint_(request);
    const prior = state.requests.get(intent.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) failPromotion_('REQUEST_CONFLICT', 'This request ID already belongs to a different save.');
      return promotionSuccess_(confirmedPromotionResult_(workbook, state, prior.receipt));
    }
    const event = buildPromotionEvent_(intent, state, recorder);
    const row = promotionEventRow_(event, fingerprint);
    const history = requirePromotionSheet_(workbook, 'Promotion History', PROMOTION_HISTORY_HEADERS_);
    // Idempotency, revision checks, the one append, and exact readback all share
    // this lock. No mutable Students cell is ever used as rank authority.
    history.appendRow(literalPromotionRow_(row));
    SpreadsheetApp.flush();
    const committed = readPromotionHistory_(workbook);
    const receipt = committed.requests.get(intent.requestId);
    if (!receipt || receipt.fingerprint !== fingerprint || receipt.receipt.eventId !== event.eventId
      || promotionFingerprint_(receipt.receipt) !== promotionFingerprint_(event)) {
      failPromotion_('UNAVAILABLE', 'Save confirmation is unavailable. Check or retry the same request before creating another.', true);
    }
    return promotionSuccess_(confirmedPromotionResult_(workbook, committed, receipt.receipt));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error && error.promotionCode || 'UNAVAILABLE',
        message: error && error.promotionCode ? error.message : 'The connection could not confirm this request. Keep the input and check or retry the same request.',
        retryable: error && error.promotionCode ? error.promotionRetryable === true : true
      },
      ...(request && typeof request.requestId === 'string' ? { requestId: request.requestId.slice(0, 128) } : {})
    };
  } finally {
    if (locked) lock.releaseLock();
  }
}

function promotionSuccess_(data) { return { ok: true, data }; }

function failPromotion_(code, message, retryable) {
  const error = new Error(message);
  error.promotionCode = code;
  error.promotionRetryable = retryable === true;
  throw error;
}

function authenticatedPromotionOwner_() {
  const properties = PropertiesService.getScriptProperties();
  const owner = String(properties.getProperty('TEST_OWNER_EMAIL') || '').trim().toLowerCase();
  const active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const effective = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) || !active || !effective || active !== owner || effective !== owner) {
    failPromotion_('UNAUTHORIZED', 'Private TEST manager access is required.');
  }
  return active;
}

function verifiedPromotionWorkbook_() {
  const id = PropertiesService.getScriptProperties().getProperty('TEST_WORKBOOK_ID');
  if (!id || typeof id !== 'string') failPromotion_('TEST_DESTINATION_INVALID', 'The private TEST destination is not configured.');
  const workbook = SpreadsheetApp.openById(id);
  if (workbook.getName() !== PROMOTION_TEST_TITLE_ || workbook.getSpreadsheetTimeZone() !== PROMOTION_TIME_ZONE_) {
    failPromotion_('TEST_DESTINATION_INVALID', 'The configured destination is not the verified private TEST workbook.');
  }
  for (const title of ['Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student']) {
    if (!workbook.getSheetByName(title)) failPromotion_('TEST_DESTINATION_INVALID', 'The private TEST legacy views are incomplete.');
  }
  return workbook;
}

function requirePromotionSheet_(workbook, title, headers) {
  const sheet = workbook.getSheetByName(title);
  if (!sheet || sheet.getLastColumn() !== headers.length) failPromotion_('TEST_DESTINATION_INVALID', 'The private TEST data layout does not match this tool.');
  const actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (!actual || headers.some((header, index) => actual[index] !== header)) {
    failPromotion_('TEST_DESTINATION_INVALID', 'The private TEST data headers do not match this tool.');
  }
  return sheet;
}

function plainPromotionObject_(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactPromotionFields_(value, required, optional) {
  if (!plainPromotionObject_(value) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !(optional || []).includes(key))) {
    failPromotion_('VALIDATION', 'The request has missing or unsupported fields.');
  }
}

function promotionText_(value, maximum, allowBlank) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || /^[\s]*[=+\-@]/.test(value)) {
    failPromotion_('VALIDATION', 'Use plain text without formulas or control characters.');
  }
  const text = value.trim();
  if (!allowBlank && !text) failPromotion_('VALIDATION', 'Complete the required text fields.');
  return text;
}

function promotionId_(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) {
    failPromotion_('VALIDATION', 'The record or request identity is invalid.');
  }
  return value;
}

function promotionRank_(value) {
  exactPromotionFields_(value, ['belt', 'marks']);
  if (!PROMOTION_BELTS_.includes(value.belt) || !Number.isSafeInteger(value.marks) || value.marks < 0) {
    failPromotion_('VALIDATION', 'Choose a belt and enter a whole, nonnegative stripe or degree count.');
  }
  return { rankKnown: true, belt: value.belt, marks: value.marks, markType: value.belt === 'Black Belt' ? 'degrees' : 'stripes' };
}

function validatePromotionRequest_(request) {
  if (!plainPromotionObject_(request) || typeof request.operation !== 'string') failPromotion_('VALIDATION', 'Choose an operation.');
  const operation = request.operation;
  if (operation === 'bootstrap') { exactPromotionFields_(request, ['operation']); return { operation }; }
  if (operation === 'readStudent') {
    exactPromotionFields_(request, ['operation', 'studentId']);
    return { operation, studentId: promotionId_(request.studentId) };
  }
  if (operation === 'checkSave') {
    exactPromotionFields_(request, ['operation', 'requestId']);
    return { operation, requestId: promotionId_(request.requestId) };
  }
  if (operation === 'registerStudent') {
    exactPromotionFields_(request, ['operation', 'requestId', 'displayName', 'distinguishingLabel'], ['historyNote']);
    return {
      operation, requestId: promotionId_(request.requestId),
      displayName: promotionText_(request.displayName, 120),
      distinguishingLabel: promotionText_(request.distinguishingLabel, 120),
      historyNote: promotionText_(request.historyNote || '', 500, true)
    };
  }
  const common = ['operation', 'requestId', 'studentId', 'expectedRevision', 'approverId'];
  const extra = operation === 'recordPromotion' ? ['action']
    : operation === 'confirmRank' ? ['rank', 'reason']
      : operation === 'correctLatest' ? ['correctsEventId', 'rank', 'reason'] : null;
  if (!extra) failPromotion_('VALIDATION', 'This operation is not supported.');
  exactPromotionFields_(request, common.concat(extra), operation === 'recordPromotion' ? ['belt'] : []);
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) failPromotion_('VALIDATION', 'Reload this student before saving.');
  if (!PROMOTION_APPROVERS_.some(item => item.id === request.approverId)) failPromotion_('VALIDATION', 'Choose one of the fictional TEST approvers.');
  const intent = {
    operation, requestId: promotionId_(request.requestId), studentId: promotionId_(request.studentId),
    expectedRevision: request.expectedRevision, approverId: request.approverId
  };
  if (operation === 'recordPromotion') {
    if (request.action !== 'stripe' && request.action !== 'belt') failPromotion_('VALIDATION', 'Choose Add stripe or Change belt.');
    if (request.action === 'stripe' && Object.prototype.hasOwnProperty.call(request, 'belt')) failPromotion_('VALIDATION', 'Adding a stripe cannot change the belt.');
    intent.action = request.action;
    if (request.action === 'belt') {
      if (!PROMOTION_BELTS_.includes(request.belt)) failPromotion_('VALIDATION', 'Choose the intended new belt.');
      intent.belt = request.belt;
    }
  } else {
    const rank = promotionRank_(request.rank);
    intent.rank = { belt: rank.belt, marks: rank.marks };
    intent.reason = promotionText_(request.reason, 500);
    if (operation === 'correctLatest') intent.correctsEventId = promotionId_(request.correctsEventId);
  }
  return intent;
}

function promotionFingerprint_(intent) {
  function ordered(value) {
    if (!plainPromotionObject_(value)) return value;
    return Object.keys(value).sort().reduce((result, key) => { result[key] = ordered(value[key]); return result; }, {});
  }
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(ordered(intent)), Utilities.Charset.UTF_8)
    .map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function promotionToday_() { return Utilities.formatDate(new Date(), PROMOTION_TIME_ZONE_, 'yyyy-MM-dd'); }

function promotionCellText_(value) {
  return value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
}

function storedPromotionBoolean_(value) {
  if (value === true || value === 'TRUE' || value === 'true') return true;
  if (value === false || value === 'FALSE' || value === 'false') return false;
  failPromotion_('TEST_DESTINATION_INVALID', 'A historical rank confirmation is incomplete.');
}

function storedPromotionRank_(known, belt, marks, type) {
  const rankKnown = storedPromotionBoolean_(known);
  if (!rankKnown) {
    if (belt !== '' || marks !== '' || type !== '') failPromotion_('TEST_DESTINATION_INVALID', 'An uncertain historical rank must remain explicitly unknown.');
    return { rankKnown: false, belt: '', marks: null, markType: '' };
  }
  const rank = promotionRank_({ belt, marks: typeof marks === 'number' ? marks : Number(marks) });
  if (marks === '' || type !== rank.markType) failPromotion_('TEST_DESTINATION_INVALID', 'A historical rank snapshot is incomplete.');
  return rank;
}

function rankSnapshot_(student) {
  return { status: student.status, rankKnown: student.rankKnown, belt: student.belt, marks: student.marks, markType: student.markType };
}

function readPromotionHistory_(workbook) {
  const sheet = requirePromotionSheet_(workbook, 'Promotion History', PROMOTION_HISTORY_HEADERS_);
  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, PROMOTION_HISTORY_HEADERS_.length).getValues() : [];
  const state = { students: new Map(), requests: new Map(), eventIds: new Set(), events: [] };
  rows.forEach(row => {
    if (row.every(cell => cell === '')) return;
    const entry = Object.fromEntries(PROMOTION_HISTORY_HEADERS_.map((header, index) => [header, row[index]]));
    const eventId = promotionId_(entry.event_id);
    const requestId = promotionId_(entry.request_id);
    const studentId = promotionId_(entry.student_id);
    const revision = Number(entry.revision);
    const previous = state.students.get(studentId);
    const status = entry.after_status;
    const kind = entry.event_kind;
    if (state.eventIds.has(eventId) || state.requests.has(requestId) || !Number.isSafeInteger(revision)
      || revision !== (previous ? previous.revision + 1 : 1) || !['active', 'archived'].includes(status)
      || !['REGISTER', 'RANK_CONFIRM', 'STRIPE', 'BELT', 'CORRECTION'].includes(kind)
      || (!previous && kind !== 'REGISTER') || (previous && kind === 'REGISTER')) {
      failPromotion_('TEST_DESTINATION_INVALID', 'Promotion history has an inconsistent record identity or revision.');
    }
    const student = {
      studentId, displayName: promotionCellText_(entry.display_name), distinguishingLabel: promotionCellText_(entry.distinguishing_label),
      status, ...storedPromotionRank_(entry.after_rank_known, entry.after_belt, entry.after_marks, entry.after_mark_type),
      revision, lastEventId: eventId, legacyRefs: promotionCellText_(entry.legacy_refs), historyNote: promotionCellText_(entry.history_note)
    };
    if (!student.displayName || !student.distinguishingLabel) failPromotion_('TEST_DESTINATION_INVALID', 'A historical student identity is incomplete.');
    let before = null;
    if (previous) {
      before = { status: entry.before_status, ...storedPromotionRank_(entry.before_rank_known, entry.before_belt, entry.before_marks, entry.before_mark_type) };
      if (JSON.stringify(before) !== JSON.stringify(rankSnapshot_(previous)) || previous.status === 'archived'
        || student.displayName !== previous.displayName || student.distinguishingLabel !== previous.distinguishingLabel
        || student.legacyRefs !== previous.legacyRefs || student.historyNote !== previous.historyNote) {
        failPromotion_('TEST_DESTINATION_INVALID', 'Promotion history does not preserve its previous snapshot.');
      }
    } else if (['before_status', 'before_rank_known', 'before_belt', 'before_marks', 'before_mark_type'].some(key => entry[key] !== '')) {
      failPromotion_('TEST_DESTINATION_INVALID', 'The initial registration has an unexpected before-rank.');
    }
    const date = entry.event_date_ny instanceof Date
      ? Utilities.formatDate(entry.event_date_ny, PROMOTION_TIME_ZONE_, 'yyyy-MM-dd') : promotionCellText_(entry.event_date_ny);
    const fingerprint = promotionCellText_(entry.payload_fingerprint);
    const syntheticSeed = !previous && kind === 'REGISTER' && entry.recorder_identity === 'SYNTHETIC FIXTURE';
    if ((!syntheticSeed && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f]{64}$/.test(fingerprint)))
      || (syntheticSeed && (date !== '' || fingerprint !== '' || entry.approver_id !== '' || entry.approver_label !== ''))) {
      failPromotion_('TEST_DESTINATION_INVALID', 'A historical event date or request identity is invalid.');
    }
    const receipt = {
      eventId, requestId, studentId, revision, eventKind: kind, eventDateNY: date,
      recordedAtUTC: promotionCellText_(entry.recorded_at_utc), before, after: student,
      approverId: promotionCellText_(entry.approver_id), approverLabel: promotionCellText_(entry.approver_label),
      recorderIdentity: promotionCellText_(entry.recorder_identity), correctsEventId: promotionCellText_(entry.corrects_event_id),
      reason: promotionCellText_(entry.reason)
    };
    state.students.set(studentId, student);
    state.requests.set(requestId, { fingerprint, receipt });
    state.eventIds.add(eventId);
    state.events.push(receipt);
  });
  return state;
}

function requirePromotionStudent_(state, studentId) {
  const student = state.students.get(studentId);
  if (!student) failPromotion_('NOT_FOUND', 'This student was not found. Search again or explicitly register a missing TEST student.');
  return student;
}

function buildPromotionEvent_(intent, state, recorder) {
  let previous = null;
  let after;
  let kind;
  let reason = '';
  if (intent.operation === 'registerStudent') {
    const normalized = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (Array.from(state.students.values()).some(student => normalized(student.displayName) === normalized(intent.displayName)
      && normalized(student.distinguishingLabel) === normalized(intent.distinguishingLabel))) {
      failPromotion_('DUPLICATE_STUDENT', 'That name and identifying label already exist. Select that student or use a different label for a different person.');
    }
    kind = 'REGISTER';
    reason = 'Explicit TEST student registration; current rank needs confirmation.';
    after = {
      studentId: 'stu-' + Utilities.getUuid(), displayName: intent.displayName, distinguishingLabel: intent.distinguishingLabel,
      status: 'active', rankKnown: false, belt: '', marks: null, markType: '', revision: 1,
      legacyRefs: '', historyNote: intent.historyNote
    };
  } else {
    previous = requirePromotionStudent_(state, intent.studentId);
    if (previous.status === 'archived') failPromotion_('ARCHIVED', 'This former student record is read-only. Return-to-training policy is outside this TEST tool.');
    if (previous.revision !== intent.expectedRevision) failPromotion_('STALE_REVISION', 'This student changed in another session. Reload and review the current rank before making a new decision.');
    after = { ...previous, revision: previous.revision + 1 };
    if (intent.operation === 'confirmRank') {
      if (previous.rankKnown) failPromotion_('RANK_ALREADY_KNOWN', 'The current rank is already recorded. Use a promotion or an audited correction.');
      kind = 'RANK_CONFIRM';
      Object.assign(after, promotionRank_(intent.rank));
      reason = intent.reason;
    } else if (intent.operation === 'correctLatest') {
      const latest = state.events.find(event => event.eventId === previous.lastEventId);
      if (intent.correctsEventId !== previous.lastEventId || !latest || latest.eventKind === 'REGISTER') {
        failPromotion_('CORRECTION_NOT_LATEST', 'Only the latest recorded rank entry can be corrected here. Reload its history first.');
      }
      kind = 'CORRECTION';
      Object.assign(after, promotionRank_(intent.rank));
      reason = intent.reason;
    } else {
      if (!previous.rankKnown) failPromotion_('RANK_UNKNOWN', 'The current rank is uncertain. Confirm it explicitly before recording a promotion.');
      if (intent.action === 'stripe') {
        if (!Number.isSafeInteger(previous.marks + 1)) failPromotion_('VALIDATION', 'This degree or stripe count cannot be represented safely.');
        kind = 'STRIPE';
        after.marks += 1;
      } else {
        if (intent.belt === previous.belt) failPromotion_('VALIDATION', 'Choose a different belt for a belt change.');
        kind = 'BELT';
        Object.assign(after, promotionRank_({ belt: intent.belt, marks: 0 }));
      }
    }
  }
  const eventId = 'evt-' + Utilities.getUuid();
  after.lastEventId = eventId;
  const approver = PROMOTION_APPROVERS_.find(item => item.id === intent.approverId);
  return {
    eventId, requestId: intent.requestId, studentId: after.studentId, revision: after.revision, eventKind: kind,
    eventDateNY: promotionToday_(), recordedAtUTC: new Date().toISOString(), before: previous ? rankSnapshot_(previous) : null,
    after, approverId: approver ? approver.id : '', approverLabel: approver ? approver.label : '',
    recorderIdentity: recorder, correctsEventId: intent.correctsEventId || '', reason
  };
}

function promotionEventRow_(event, fingerprint) {
  const before = event.before;
  const after = event.after;
  return [
    event.eventId, event.requestId, event.studentId, event.revision, event.eventKind, event.eventDateNY,
    event.recordedAtUTC, after.displayName, after.distinguishingLabel, before ? before.status : '', after.status,
    before ? before.rankKnown : '', before ? before.belt : '', before && before.marks !== null ? before.marks : '', before ? before.markType : '',
    after.rankKnown, after.belt, after.marks === null ? '' : after.marks, after.markType,
    event.approverId, event.approverLabel, event.recorderIdentity, event.correctsEventId, event.reason,
    after.legacyRefs, after.historyNote, fingerprint
  ];
}

function literalPromotionRow_(row) {
  // New user text is validated; this also keeps carried legacy annotations
  // literal if a future synthetic fixture contains formula-looking text.
  return row.map(value => typeof value === 'string' && /^[\s]*[=+\-@]/.test(value) ? "'" + value : value);
}

function rebuildPromotionStudents_(workbook, state) {
  const sheet = requirePromotionSheet_(workbook, 'Students', STUDENT_HEADERS_);
  const rows = Array.from(state.students.values()).map(student => literalPromotionRow_([
    student.studentId, student.displayName, student.distinguishingLabel, student.status, student.rankKnown,
    student.belt, student.marks === null ? '' : student.marks, student.markType, student.revision,
    student.lastEventId, student.legacyRefs, student.historyNote
  ]));
  const priorRows = Math.max(0, sheet.getLastRow() - 1);
  if (rows.length) sheet.getRange(2, 1, rows.length, STUDENT_HEADERS_.length).setValues(rows);
  if (priorRows > rows.length) sheet.getRange(rows.length + 2, 1, priorRows - rows.length, STUDENT_HEADERS_.length).clearContent();
  SpreadsheetApp.flush();
}

function confirmedPromotionResult_(workbook, state, receipt) {
  let viewPending = false;
  try { rebuildPromotionStudents_(workbook, state); } catch (error) { viewPending = true; }
  return { receipt, student: state.students.get(receipt.studentId), viewPending };
}
