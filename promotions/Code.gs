/* TEST owner reference and separately enabled, signed Revolution tablet routes.
 * Configure destinations and credentials privately in Script Properties. */
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
  try {
    return promotionRequestWithRecorder_(request, authenticatedPromotionOwner_());
  } catch (error) {
    return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Private TEST manager access is required.', retryable: false } };
  }
}

// Deliberately separate from promotionRequest/doPost: selecting an instructor
// never authorizes a data migration. The live gate approves one exact reviewed
// request, and is not enabled by deploying this reader or enabling the pilot.
function promotionRepair(request) {
  let lock;
  let locked = false;
  let appendAttempted = false;
  try {
    const owner = authenticatedPromotionOwner_();
    exactPromotionFields_(request, ['operation', 'repair']);
    if (request.operation !== 'applyRepair') failPromotion_('VALIDATION', 'Choose an explicitly reviewed data repair.');
    const repair = validatePromotionRepair_(request.repair);
    const fingerprint = promotionRepairFingerprint_(request);
    if (repair.target === 'live' && PropertiesService.getScriptProperties().getProperty('LIVE_REPAIR_APPROVED_FINGERPRINT') !== fingerprint) {
      failPromotion_('REPAIR_NOT_APPROVED', 'This exact live repair has not been approved.');
    }
    lock = LockService.getScriptLock();
    locked = lock.tryLock(10000);
    if (!locked) failPromotion_('BUSY', 'Another save is finishing. Retry this exact repair.', true);
    if (repair.target === 'live' && PropertiesService.getScriptProperties().getProperty('LIVE_REPAIR_APPROVED_FINGERPRINT') !== fingerprint) {
      failPromotion_('REPAIR_NOT_APPROVED', 'This exact live repair is no longer approved.');
    }
    const workbook = verifiedPromotionWorkbook_(repair.target);
    if (workbook.getId() !== repair.workbookId) failPromotion_('REPAIR_DESTINATION_CHANGED', 'The reviewed repair belongs to a different workbook.');
    const state = readPromotionHistory_(workbook);
    const requestId = 'req-' + repair.repairId;
    const prior = state.requests.get(requestId);
    // A lost confirmation remains reconcilable after newer events or source
    // edits. Never append again, and rebuild Students from all current history.
    if (prior) {
      if (prior.fingerprint !== fingerprint || prior.receipt.eventKind !== 'REPAIR') failPromotion_('REQUEST_CONFLICT', 'This repair identity belongs to different contents.');
      return promotionSuccess_(confirmedPromotionResult_(workbook, state, prior.receipt));
    }
    const previous = requirePromotionStudent_(state, repair.studentId);
    validatePromotionRepairTransition_(repair, previous, state.events);
    verifyPromotionRepairSource_(workbook, repair, previous);
    const after = { ...previous, ...repair.after, revision: previous.revision + 1, lastEventId: 'evt-' + repair.repairId };
    const event = {
      eventId: after.lastEventId, requestId, studentId: previous.studentId, revision: after.revision,
      eventKind: 'REPAIR', eventDateNY: promotionToday_(), recordedAtUTC: new Date().toISOString(),
      before: rankSnapshot_(previous), after, approverId: '', approverLabel: '',
      recorderIdentity: 'OWNER DATA REPAIR: ' + owner, correctsEventId: '',
      reason: canonicalPromotionRepairJson_(repair), repair
    };
    appendAttempted = true;
    requirePromotionSheet_(workbook, 'Promotion History', PROMOTION_HISTORY_HEADERS_).appendRow(literalPromotionRow_(promotionEventRow_(event, fingerprint)));
    SpreadsheetApp.flush();
    const committed = readPromotionHistory_(workbook);
    const receipt = committed.requests.get(requestId);
    if (!receipt || receipt.fingerprint !== fingerprint || promotionRepairFingerprint_(receipt.receipt) !== promotionRepairFingerprint_(event)) {
      failPromotion_('UNAVAILABLE', 'Repair confirmation is unavailable. Retry this exact repair.', true);
    }
    return promotionSuccess_(confirmedPromotionResult_(workbook, committed, receipt.receipt));
  } catch (error) {
    return { ok: false, error: {
      code: !appendAttempted && error && error.promotionCode || 'UNAVAILABLE',
      message: !appendAttempted && error && error.promotionCode ? error.message : 'The connection could not confirm this repair. Retry the exact reviewed request.',
      retryable: appendAttempted || !(error && error.promotionCode) || error.promotionRetryable === true
    } };
  } finally {
    if (locked) lock.releaseLock();
  }
}

function canonicalPromotionRepairJson_(value) {
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (!plainPromotionObject_(item)) return item;
    return Object.keys(item).sort().reduce((result, key) => { result[key] = ordered(item[key]); return result; }, {});
  }
  return JSON.stringify(ordered(value));
}

function promotionRepairDigest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function promotionRepairFingerprint_(value) { return promotionRepairDigest_(canonicalPromotionRepairJson_(value)); }

function promotionRepairDate_(value) {
  if (value === '') return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(value + 'T12:00:00.000Z'))
    || new Date(value + 'T12:00:00.000Z').toISOString().slice(0, 10) !== value) {
    failPromotion_('VALIDATION', 'A repair date must be an exact source-supported date or blank.');
  }
  return value;
}

function promotionRepairFieldSnapshot_(student, field) {
  return field === 'identity' ? { displayName: student.displayName, distinguishingLabel: student.distinguishingLabel }
    : { rankKnown: student.rankKnown, belt: student.belt, marks: student.marks, markType: student.markType, lastPromotionDateNY: student.lastPromotionDateNY };
}

function validatePromotionRepair_(repair) {
  exactPromotionFields_(repair, ['schema', 'manifestId', 'repairId', 'target', 'workbookId', 'studentId', 'expectedRevision',
    'expectedLastEventId', 'expectedSourceFingerprint', 'field', 'before', 'after', 'evidence']);
  if (repair.schema !== 'promotions-data-repair-v1' || !['test', 'live'].includes(repair.target)
    || !['identity', 'rank'].includes(repair.field) || !Number.isSafeInteger(repair.expectedRevision) || repair.expectedRevision < 1
    || !/^[0-9a-f]{64}$/.test(repair.expectedSourceFingerprint || '')) failPromotion_('VALIDATION', 'The reviewed repair schema is invalid.');
  for (const key of ['manifestId', 'studentId', 'expectedLastEventId', 'workbookId']) promotionId_(repair[key]);
  for (const snapshot of [repair.before, repair.after]) {
    if (repair.field === 'identity') {
      exactPromotionFields_(snapshot, ['displayName', 'distinguishingLabel']);
      for (const key of ['displayName', 'distinguishingLabel']) {
        if (snapshot === repair.before) {
          // The imported snapshot is immutable and may retain whitespace or
          // control characters. Compare it exactly to history at the transition
          // check; do not normalize it into a different historical identity.
          if (typeof snapshot[key] !== 'string' || !snapshot[key] || snapshot[key].length > 2000) {
            failPromotion_('VALIDATION', 'Preserve the exact bounded historical identity text.');
          }
        } else if (promotionText_(snapshot[key], 120) !== snapshot[key]) failPromotion_('VALIDATION', 'Use the exact reviewed identity text.');
      }
    } else {
      exactPromotionFields_(snapshot, ['rankKnown', 'belt', 'marks', 'markType', 'lastPromotionDateNY']);
      if (typeof snapshot.rankKnown !== 'boolean') failPromotion_('VALIDATION', 'A repair rank must state its certainty explicitly.');
      const rank = storedPromotionRank_(snapshot.rankKnown, snapshot.belt, snapshot.marks === null ? '' : snapshot.marks, snapshot.markType);
      if (promotionRepairFingerprint_({ ...rank, lastPromotionDateNY: promotionRepairDate_(snapshot.lastPromotionDateNY) }) !== promotionRepairFingerprint_(snapshot)) {
        failPromotion_('VALIDATION', 'A repair rank snapshot is invalid.');
      }
    }
  }
  if (promotionRepairFingerprint_(repair.before) === promotionRepairFingerprint_(repair.after)) failPromotion_('VALIDATION', 'A repair must change its one reviewed field.');
  if (repair.field === 'rank' && repair.after.lastPromotionDateNY && repair.after.lastPromotionDateNY > promotionToday_()) {
    failPromotion_('VALIDATION', 'A rank repair cannot invent a future award.');
  }
  exactPromotionFields_(repair.evidence, ['interpretation', 'headerRefs', 'cells'], ['rankConflict']);
  const rankConflict = Object.prototype.hasOwnProperty.call(repair.evidence, 'rankConflict');
  if (repair.field === 'rank' && !repair.after.rankKnown) {
    if (!repair.before.rankKnown || repair.after.lastPromotionDateNY !== '' || !rankConflict) {
      failPromotion_('VALIDATION', 'An uncertain rank repair requires a known original rank and explicit conflicting source evidence.');
    }
    exactPromotionFields_(repair.evidence.rankConflict, ['summaryRef', 'awardRefs']);
    if (typeof repair.evidence.rankConflict.summaryRef !== 'string'
      || !Array.isArray(repair.evidence.rankConflict.awardRefs) || !repair.evidence.rankConflict.awardRefs.length
      || repair.evidence.rankConflict.awardRefs.length > 5
      || new Set(repair.evidence.rankConflict.awardRefs).size !== repair.evidence.rankConflict.awardRefs.length) {
      failPromotion_('VALIDATION', 'Identify the explicit summary and conflicting dated award cells.');
    }
  } else if (rankConflict) failPromotion_('VALIDATION', 'Conflict evidence is only valid for a known-to-unknown rank repair.');
  promotionText_(repair.evidence.interpretation, 2000);
  if (!Array.isArray(repair.evidence.headerRefs) || !repair.evidence.headerRefs.length
    || repair.evidence.headerRefs.length > 10 || repair.evidence.headerRefs.some(ref => typeof ref !== 'string' || ref.length > 120)
    || new Set(repair.evidence.headerRefs).size !== repair.evidence.headerRefs.length) {
    failPromotion_('VALIDATION', 'Identify the original header block for every source row.');
  }
  promotionRepairSourceRanges_(JSON.stringify(repair.evidence.headerRefs.map(range => ({ range }))));
  if (!Array.isArray(repair.evidence.cells) || !repair.evidence.cells.length || repair.evidence.cells.length > 200) {
    failPromotion_('VALIDATION', 'Provide bounded original source-cell evidence.');
  }
  const cells = new Set();
  for (const cell of repair.evidence.cells) {
    exactPromotionFields_(cell, ['sheet', 'cell', 'value', 'display', 'numberFormat']);
    if (!['Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student'].includes(cell.sheet)
      || !/^[A-Z]{1,2}[1-9][0-9]{0,5}$/.test(cell.cell || '') || cells.has(cell.sheet + '!' + cell.cell)) failPromotion_('VALIDATION', 'Source-cell evidence is invalid or duplicated.');
    cells.add(cell.sheet + '!' + cell.cell);
    exactPromotionFields_(cell.value, ['type', 'value']);
    const { type, value } = cell.value;
    // Native Sheets CellData can omit default formatting for inert text/blank
    // cells. Do not invent a default pattern; date/numeric evidence must retain
    // an explicit pattern, and every cell still requires an exact display.
    if (typeof cell.display !== 'string' || cell.display.length > 2000
      || !(typeof cell.numberFormat === 'string' && cell.numberFormat.length <= 200 && (type !== 'date' || cell.numberFormat.trim())
        || cell.numberFormat === null && ['blank', 'string', 'boolean'].includes(type))) {
      failPromotion_('VALIDATION', 'Preserve the original displayed value and number format.');
    }
    if (!(type === 'blank' && value === '' || type === 'string' && typeof value === 'string' && value.length <= 2000
      || type === 'number' && typeof value === 'number' && Number.isFinite(value)
      || type === 'boolean' && typeof value === 'boolean'
      || type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value)) failPromotion_('VALIDATION', 'Preserve the original typed source value.');
  }
  if (rankConflict) validatePromotionRepairRankConflict_(repair);
  const { repairId, ...identity } = repair;
  if (repairId !== 'repair-' + promotionRepairFingerprint_(identity) || canonicalPromotionRepairJson_(repair).length > 30000) {
    failPromotion_('VALIDATION', 'The deterministic repair identity does not match the reviewed contents.');
  }
  return repair;
}

function validatePromotionRepairRankConflict_(repair) {
  const cells = new Map(repair.evidence.cells.map(cell => [cell.sheet + '!' + cell.cell, cell]));
  const reference = ref => {
    const match = typeof ref === 'string' && ref.match(/^'((?:[^']|'')+)'!([A-Z]{1,2}[1-9][0-9]{0,5})$/);
    if (!match) failPromotion_('VALIDATION', 'A rank conflict must reference explicit reviewed source cells.');
    const sheet = match[1].replace(/''/g, "'");
    const cell = cells.get(sheet + '!' + match[2]);
    if (!cell) failPromotion_('VALIDATION', 'Rank conflict evidence is missing from the reviewed source snapshot.');
    return { sheet, address: match[2], ...promotionRepairCellPosition_(match[2]), cell };
  };
  const summary = reference(repair.evidence.rankConflict.summaryRef);
  const black = repair.before.belt === 'Black Belt';
  const header = promotionRepairSourceRanges_(JSON.stringify(repair.evidence.headerRefs.map(range => ({ range }))))
    .find(item => item.sheet === summary.sheet && item.row < summary.row);
  const summaryHeader = header && cells.get(summary.sheet + '!' + summary.address.replace(/[0-9]+$/, String(header.row)));
  const summaryLabel = summary.cell.value.type === 'string'
    ? summary.cell.value.value.trim().match(black ? /^(\d+)\s+degrees?$/i : /^(\d+)\s+stripes?$/i) : null;
  const marks = summary.cell.value.type === 'number' ? summary.cell.value.value : summaryLabel ? Number(summaryLabel[1]) : null;
  if (summary.sheet !== repair.before.belt || summary.column !== (black ? 4 : 2)
    || !summaryHeader || !['rank awarded', 'current rank awarded'].includes(String(summaryHeader.value.value).trim().toLowerCase())
    || !Number.isSafeInteger(marks) || marks < 0 || marks !== repair.before.marks) {
    failPromotion_('VALIDATION', 'The conflicting source summary must explicitly match the untouched original rank.');
  }
  for (const ref of repair.evidence.rankConflict.awardRefs) {
    const award = reference(ref);
    const label = cells.get(award.sheet + '!' + award.address.replace(/[0-9]+$/, String(header.row)));
    const awardedMarks = label && label.value.type === 'string' && label.value.value.trim().match(/^(\d+)\s+stripes?$/i);
    const firstColumn = black ? 5 : repair.before.belt === 'White Belt' ? 4 : 3;
    const lastColumn = black ? 9 : 7;
    if (award.sheet !== summary.sheet || award.row !== summary.row || award.column < firstColumn || award.column > lastColumn
      || !awardedMarks || Number(awardedMarks[1]) <= marks || award.cell.value.type !== 'date'
      || Utilities.formatDate(new Date(award.cell.value.value), PROMOTION_TIME_ZONE_, 'yyyy-MM-dd') > promotionToday_()) {
      failPromotion_('VALIDATION', 'The conflict must contain a dated higher-mark award within the same current-belt block.');
    }
  }
}

function validatePromotionRepairTransition_(repair, previous, events) {
  const baseline = events.find(event => event.studentId === previous.studentId);
  if (!baseline || baseline.eventKind !== 'REGISTER' || baseline.recorderIdentity !== 'LEGACY BASELINE IMPORT') {
    failPromotion_('REPAIR_NOT_LEGACY', 'Only an existing imported identity can receive this source repair.');
  }
  if (previous.revision !== repair.expectedRevision || previous.lastEventId !== repair.expectedLastEventId
    || promotionRepairDigest_(previous.legacyRefs) !== repair.expectedSourceFingerprint
    || promotionRepairFingerprint_(promotionRepairFieldSnapshot_(previous, repair.field)) !== promotionRepairFingerprint_(repair.before)) {
    failPromotion_('STALE_REPAIR', 'This student or source binding changed. Skip this repair and review a new proposal.');
  }
  if (repair.field === 'rank' && (previous.status === 'archived' || events.some(event => event.studentId === previous.studentId
    && event.eventKind !== 'REGISTER' && !(event.eventKind === 'REPAIR' && event.repair.field === 'identity')))) {
    failPromotion_('RANK_REPAIR_CONFLICT', 'Later application rank history or an archived record prevents replacing this baseline.');
  }
}

function promotionRepairCellPosition_(cell) {
  const match = cell.match(/^([A-Z]+)([0-9]+)$/);
  return { row: Number(match[2]), column: match[1].split('').reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0) };
}

function promotionRepairSourceRanges_(legacyRefs) {
  let references;
  try { references = JSON.parse(legacyRefs); } catch (_) { failPromotion_('VALIDATION', 'The imported source binding is invalid.'); }
  return references.map(reference => {
    const match = reference.range.match(/^'((?:[^']|'')+)'!([A-Z]{1,2}[1-9][0-9]*):([A-Z]{1,2}[1-9][0-9]*)$/);
    if (!match) failPromotion_('VALIDATION', 'The imported source range is not supported for repair.');
    const first = promotionRepairCellPosition_(match[2]); const last = promotionRepairCellPosition_(match[3]);
    if (first.row !== last.row || first.column !== 1 || last.column < first.column) failPromotion_('VALIDATION', 'Repair evidence must bind one original source row.');
    return { sheet: match[1].replace(/''/g, "'"), row: first.row, width: last.column };
  });
}

function validatePromotionRepairEvidenceBinding_(repair, previous) {
  const ranges = promotionRepairSourceRanges_(previous.legacyRefs);
  const headers = promotionRepairSourceRanges_(JSON.stringify(repair.evidence.headerRefs.map(range => ({ range }))));
  const evidence = new Map(repair.evidence.cells.map(cell => [cell.sheet + '!' + cell.cell, cell]));
  if (headers.length !== ranges.length || ranges.some((range, index) => headers[index].sheet !== range.sheet || headers[index].row >= range.row)) {
    failPromotion_('VALIDATION', 'Each reviewed header must precede its corresponding original source row on the same tab.');
  }
  // Archived tabs contain repeated blocks: their header is explicitly reviewed,
  // never assumed to be row 1. Preserve every source/header cell so summaries,
  // previous-belt blocks, label changes and changed date precision are checked.
  for (const range of ranges.concat(headers)) for (let column = 1; column <= range.width; column += 1) {
    const address = (column > 26 ? String.fromCharCode(64 + Math.floor((column - 1) / 26)) : '') + String.fromCharCode(65 + (column - 1) % 26) + range.row;
    if (!evidence.has(range.sheet + '!' + address)) failPromotion_('VALIDATION', 'Evidence must include the complete original source row and its headers.');
  }
  if (headers.some(header => {
    const cell = evidence.get(header.sheet + '!A' + header.row);
    return cell.value.type !== 'string' || cell.value.value.trim().toLowerCase() !== 'name';
  })) failPromotion_('VALIDATION', 'The reviewed header must identify a recognized name block.');
  for (const cell of repair.evidence.cells) {
    const position = promotionRepairCellPosition_(cell.cell);
    if (!ranges.concat(headers).some(range => range.sheet === cell.sheet && range.row === position.row && position.column <= range.width)) {
      failPromotion_('VALIDATION', 'Repair evidence must belong to this existing identity and its headers.');
    }
  }
}

function verifyPromotionRepairSource_(workbook, repair, previous) {
  validatePromotionRepairEvidenceBinding_(repair, previous);
  for (const cell of repair.evidence.cells) {
    const position = promotionRepairCellPosition_(cell.cell);
    const sheet = workbook.getSheetByName(cell.sheet);
    const range = sheet.getRange(position.row, position.column, 1, 1);
    const value = range.getValues()[0][0];
    if (range.getFormulas()[0][0]) failPromotion_('SOURCE_CHANGED', 'Formula-derived source cells require explicit resolution.');
    // This bounded repair schema covers the reviewed no-note source snapshot.
    // A note can change an award's meaning without changing its cell value.
    if (range.getNotes()[0][0]) failPromotion_('SOURCE_CHANGED', 'Source-cell notes require explicit resolution before repair.');
    const actual = value === '' ? { type: 'blank', value: '' }
      : Object.prototype.toString.call(value) === '[object Date]' ? { type: 'date', value: value.toISOString() }
        : { type: typeof value, value };
    if (promotionRepairFingerprint_(actual) !== promotionRepairFingerprint_(cell.value)
      || range.getDisplayValues()[0][0] !== cell.display
      || (cell.numberFormat !== null && range.getNumberFormats()[0][0] !== cell.numberFormat)) {
      failPromotion_('SOURCE_CHANGED', 'The original source values, display or date precision changed. Skip this repair and review their current values.');
    }
  }
}

function doPost(event) {
  let bridge;
  try {
    bridge = verifiedPromotionBridge_(event);
    const result = promotionRequestWithRecorder_(bridge.request, bridge.deviceIdentity, bridge);
    return promotionJsonOutput_({ bridge: bridge.mode, target: bridge.target, installation: 'rev', requestNonce: bridge.nonce, result });
  } catch (error) {
    return promotionJsonOutput_({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authorized tablet access is required.', retryable: false } });
  }
}

function promotionJsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function verifiedPromotionBridge_(event) {
  if (!event || !event.postData || typeof event.postData.contents !== 'string'
    || event.postData.contents.length > 65536) failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  const envelope = JSON.parse(event.postData.contents);
  exactPromotionFields_(envelope, ['payload', 'signature']);
  const payload = envelope.payload;
  exactPromotionFields_(payload, ['version', 'mode', 'target', 'installation', 'origin', 'issuedAt', 'nonce', 'deviceIdentity', 'request']);
  if (payload.target !== 'test' && payload.target !== 'live') failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  const properties = PropertiesService.getScriptProperties();
  const live = payload.target === 'live';
  const mode = live ? 'm1-authorized-tablet-live-v1' : 'm1-authorized-tablet-test-v1';
  const prefix = live ? 'LIVE' : 'TEST';
  const owner = String(properties.getProperty('TEST_OWNER_EMAIL') || '').trim().toLowerCase();
  const effective = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  const secret = String(properties.getProperty(prefix + '_BRIDGE_SECRET') || '');
  const origin = String(properties.getProperty(prefix + '_BRIDGE_ORIGIN') || '');
  if (!owner || effective !== owner || properties.getProperty(prefix + '_BRIDGE_MODE') !== mode
    || properties.getProperty(prefix + '_BRIDGE_INSTALLATION') !== 'rev'
    || (live ? origin !== 'https://gib-live.netlify.app' : !/^https:\/\/(?:deploy-preview-[0-9]+|[0-9a-f]{24})--gib-live\.netlify\.app$/.test(origin))
    || secret.length < 32 || secret.length > 512 || secret !== secret.trim()
    || (live && (properties.getProperty('LIVE_ENABLED') !== 'true'
      || !properties.getProperty('TEST_BRIDGE_SECRET') || secret === properties.getProperty('TEST_BRIDGE_SECRET')))) {
    failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  }
  // Validate live destination isolation before signature acceptance or any open.
  if (live) promotionLiveDestination_();
  const now = Math.floor(Date.now() / 1000);
  const identityPattern = live ? /^m1-live-device-[0-9a-f]{24}$/ : /^m1-test-device-[0-9a-f]{24}$/;
  if (payload.version !== 1 || payload.mode !== mode || payload.installation !== 'rev'
    || payload.origin !== origin || !Number.isSafeInteger(payload.issuedAt)
    || payload.issuedAt > now + 30 || payload.issuedAt < now - 120
    || !/^[0-9a-f]{32}$/.test(payload.nonce || '') || !identityPattern.test(payload.deviceIdentity || '')
    || !/^[0-9a-f]{64}$/.test(envelope.signature || '')) failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  const domain = live ? 'gib-promotions-live-bridge:v1\n' : 'gib-promotions-test-bridge:v1\n';
  const signature = Utilities.computeHmacSha256Signature(domain + canonicalPromotionJson_(payload), secret, Utilities.Charset.UTF_8)
    .map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
  let difference = 0;
  for (let index = 0; index < signature.length; index += 1) difference |= signature.charCodeAt(index) ^ envelope.signature.charCodeAt(index);
  if (difference) failPromotion_('UNAUTHORIZED', 'Invalid promotion bridge.');
  // Registration is a write too. The retained owner reference may still use
  // its older registration form; every tablet write requires attribution.
  if (payload.request && payload.request.operation === 'registerStudent') promotionAttribution_(payload.request);
  return payload;
}

function promotionRequestWithRecorder_(request, recorder, bridge) {
  let lock;
  let locked = false;
  let appendAttempted = false;
  try {
    const target = bridge ? bridge.target : 'test';
    const intent = validatePromotionRequest_(request);
    if (target === 'live' && !['bootstrap', 'readStudent', 'checkSave'].includes(intent.operation)
      && (!Object.prototype.hasOwnProperty.call(request, 'approverName')
        || Object.prototype.hasOwnProperty.call(request, 'approverId'))) {
      failPromotion_('VALIDATION', 'Enter a name in Promoted by.');
    }
    lock = LockService.getScriptLock();
    locked = lock.tryLock(10000);
    if (!locked) failPromotion_('BUSY', 'Another save is finishing. Please retry this same request.', true);
    if (bridge) {
      const cache = CacheService.getScriptCache();
      const key = 'promotions-bridge:' + (bridge.target === 'live' ? 'live:' : '') + bridge.nonce;
      if (cache.get(key)) failPromotion_('UNAUTHORIZED', 'This tablet request has already been used.');
      cache.put(key, 'used', 180);
    }
    const workbook = verifiedPromotionWorkbook_(target);
    let state;
    try {
      state = readPromotionHistory_(workbook);
    } catch (error) {
      // A retry may already be durable even when history cannot be read back.
      // Keep the validator strict and leave the same request unresolved.
      if (intent.operation !== 'bootstrap' && intent.operation !== 'readStudent') {
        failPromotion_('UNAVAILABLE', 'Promotion history could not confirm whether this request was saved. Keep the input and check or retry the same request.', true);
      }
      throw error;
    }
    if (intent.operation === 'bootstrap') {
      return promotionSuccess_({
        todayNY: promotionToday_(), recorderLabel: target === 'live' ? 'Authorized Revolution tablet' : bridge ? 'Authorized TEST tablet' : 'Signed-in TEST manager', testOnly: target === 'test',
        approvers: target === 'live'
          ? [...new Set(state.events.map(event => event.approverLabel).filter(name => typeof name === 'string' && name.trim()))].map(label => ({ label }))
          : PROMOTION_APPROVERS_.map(item => ({ ...item })),
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
    const event = buildPromotionEvent_(intent, state, recorder, target);
    const row = promotionEventRow_(event, fingerprint);
    const history = requirePromotionSheet_(workbook, 'Promotion History', PROMOTION_HISTORY_HEADERS_);
    // Idempotency, revision checks, the one append, and exact readback all share
    // this lock. No mutable Students cell is ever used as rank authority.
    appendAttempted = true;
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
        code: !appendAttempted && error && error.promotionCode || 'UNAVAILABLE',
        message: !appendAttempted && error && error.promotionCode ? error.message : 'The connection could not confirm this request. Keep the input and check or retry the same request.',
        retryable: !appendAttempted && error && error.promotionCode ? error.promotionRetryable === true : true
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

function promotionLiveDestination_() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty('LIVE_WORKBOOK_ID');
  const title = properties.getProperty('LIVE_WORKBOOK_TITLE');
  const testId = properties.getProperty('TEST_WORKBOOK_ID');
  if (properties.getProperty('LIVE_ENABLED') !== 'true' || !id || typeof id !== 'string' || id !== id.trim()
    || !testId || id === testId || !title || typeof title !== 'string' || !title.trim()) {
    failPromotion_('TEST_DESTINATION_INVALID', 'The promotion destination is not configured.');
  }
  return { id, title };
}

function verifiedPromotionWorkbook_(target = 'test') {
  if (target !== 'test' && target !== 'live') failPromotion_('TEST_DESTINATION_INVALID', 'The promotion destination is not configured.');
  const destination = target === 'live' ? promotionLiveDestination_() : {
    id: PropertiesService.getScriptProperties().getProperty('TEST_WORKBOOK_ID'), title: PROMOTION_TEST_TITLE_
  };
  const { id, title } = destination;
  if (!id || typeof id !== 'string') failPromotion_('TEST_DESTINATION_INVALID', 'The promotion destination is not configured.');
  const workbook = SpreadsheetApp.openById(id);
  if (workbook.getName() !== title || workbook.getSpreadsheetTimeZone() !== PROMOTION_TIME_ZONE_) {
    failPromotion_('TEST_DESTINATION_INVALID', 'The configured destination could not be verified.');
  }
  for (const title of ['Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student']) {
    if (!workbook.getSheetByName(title)) failPromotion_('TEST_DESTINATION_INVALID', 'The promotion legacy views are incomplete.');
  }
  // Live never creates or repairs an unprepared schema before accepting work.
  if (target === 'live') {
    requirePromotionSheet_(workbook, 'Students', STUDENT_HEADERS_);
    requirePromotionSheet_(workbook, 'Promotion History', PROMOTION_HISTORY_HEADERS_);
  }
  return workbook;
}

function requirePromotionSheet_(workbook, title, headers) {
  const sheet = workbook.getSheetByName(title);
  if (!sheet || sheet.getLastColumn() !== headers.length) failPromotion_('TEST_DESTINATION_INVALID', 'The promotion data layout does not match this tool.');
  const actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (!actual || headers.some((header, index) => actual[index] !== header)) {
    failPromotion_('TEST_DESTINATION_INVALID', 'The promotion data headers do not match this tool.');
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

function promotionAttribution_(request, allowMissing) {
  const hasName = Object.prototype.hasOwnProperty.call(request, 'approverName');
  const hasId = Object.prototype.hasOwnProperty.call(request, 'approverId');
  if (hasName && !hasId) {
    const value = request.approverName;
    if (typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(value) || !value.trim()) {
      failPromotion_('VALIDATION', 'Enter a name in Promoted by.');
    }
    // Attribution is plain text, not authentication or a roster lookup. The
    // existing literal-cell writer preserves punctuation and formula prefixes.
    return { approverName: value.trim() };
  }
  if (hasId && !hasName && PROMOTION_APPROVERS_.some(item => item.id === request.approverId)) {
    return { approverId: request.approverId }; // Retain exact older pending requests.
  }
  if (allowMissing && !hasName && !hasId) return {};
  failPromotion_('VALIDATION', 'Enter one name in Promoted by.');
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
    exactPromotionFields_(request, ['operation', 'requestId', 'displayName', 'distinguishingLabel'], ['historyNote', 'approverId', 'approverName']);
    return {
      operation, requestId: promotionId_(request.requestId),
      displayName: promotionText_(request.displayName, 120),
      distinguishingLabel: promotionText_(request.distinguishingLabel, 120),
      historyNote: promotionText_(request.historyNote || '', 500, true),
      ...promotionAttribution_(request, true)
    };
  }
  const common = ['operation', 'requestId', 'studentId', 'expectedRevision'];
  const extra = operation === 'recordPromotion' ? ['action']
    : operation === 'confirmRank' ? ['rank', 'reason']
      : operation === 'correctLatest' ? ['correctsEventId', 'rank', 'reason'] : null;
  if (!extra) failPromotion_('VALIDATION', 'This operation is not supported.');
  exactPromotionFields_(request, common.concat(extra), ['approverName', 'approverId'].concat(operation === 'recordPromotion' ? ['belt'] : []));
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) failPromotion_('VALIDATION', 'Reload this student before saving.');
  const intent = {
    operation, requestId: promotionId_(request.requestId), studentId: promotionId_(request.studentId),
    expectedRevision: request.expectedRevision, ...promotionAttribution_(request)
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

function canonicalPromotionJson_(intent) {
  function ordered(value) {
    if (!plainPromotionObject_(value)) return value;
    return Object.keys(value).sort().reduce((result, key) => { result[key] = ordered(value[key]); return result; }, {});
  }
  return JSON.stringify(ordered(intent));
}

function promotionFingerprint_(intent) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonicalPromotionJson_(intent), Utilities.Charset.UTF_8)
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

function validLegacyPromotionBaseline_(entry, previous, student) {
  if (previous || entry.event_kind !== 'REGISTER' || Number(entry.revision) !== 1
    || entry.reason !== 'Legacy baseline import; manifest=promotions-live-baseline-v1; promotion date unknown.'
    || entry.event_date_ny !== '' || entry.payload_fingerprint !== '' || entry.approver_id !== '' || entry.approver_label !== ''
    || (student.status === 'archived' && student.rankKnown)) return false;
  const recorded = promotionCellText_(entry.recorded_at_utc);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recorded)) return false;
  try {
    if (new Date(recorded).toISOString() !== recorded) return false;
    const references = JSON.parse(entry.legacy_refs);
    return Array.isArray(references) && references.length > 0 && references.every(reference =>
      plainPromotionObject_(reference) && Object.keys(reference).sort().join('|') === 'fingerprint|range'
      && typeof reference.range === 'string' && reference.range.trim()
      && typeof reference.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(reference.fingerprint));
  } catch (_) { return false; }
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
    const date = entry.event_date_ny instanceof Date
      ? Utilities.formatDate(entry.event_date_ny, PROMOTION_TIME_ZONE_, 'yyyy-MM-dd') : promotionCellText_(entry.event_date_ny);
    if (state.eventIds.has(eventId) || state.requests.has(requestId) || !Number.isSafeInteger(revision)
      || revision !== (previous ? previous.revision + 1 : 1) || !['active', 'archived'].includes(status)
      || !['REGISTER', 'RANK_CONFIRM', 'STRIPE', 'BELT', 'CORRECTION', 'REPAIR'].includes(kind)
      || (!previous && kind !== 'REGISTER') || (previous && kind === 'REGISTER')) {
      failPromotion_('TEST_DESTINATION_INVALID', 'Promotion history has an inconsistent record identity or revision.');
    }
    let repair = null;
    if (kind === 'REPAIR') {
      try { repair = validatePromotionRepair_(JSON.parse(entry.reason)); }
      catch (_) { failPromotion_('TEST_DESTINATION_INVALID', 'A data repair record is invalid.'); }
    }
    const student = {
      studentId, displayName: promotionCellText_(entry.display_name), distinguishingLabel: promotionCellText_(entry.distinguishing_label),
      status, ...storedPromotionRank_(entry.after_rank_known, entry.after_belt, entry.after_marks, entry.after_mark_type),
      revision, lastEventId: eventId, legacyRefs: promotionCellText_(entry.legacy_refs), historyNote: promotionCellText_(entry.history_note),
      lastPromotionDateNY: repair && repair.field === 'rank' ? repair.after.lastPromotionDateNY
        : kind === 'STRIPE' || kind === 'BELT' ? date : previous ? previous.lastPromotionDateNY : ''
    };
    if (!student.displayName || !student.distinguishingLabel) failPromotion_('TEST_DESTINATION_INVALID', 'A historical student identity is incomplete.');
    let before = null;
    if (previous) {
      before = { status: entry.before_status, ...storedPromotionRank_(entry.before_rank_known, entry.before_belt, entry.before_marks, entry.before_mark_type) };
      if (JSON.stringify(before) !== JSON.stringify(rankSnapshot_(previous)) || (previous.status === 'archived' && !(repair && repair.field === 'identity'))
        || (!(repair && repair.field === 'identity') && (student.displayName !== previous.displayName || student.distinguishingLabel !== previous.distinguishingLabel))
        || student.legacyRefs !== previous.legacyRefs || student.historyNote !== previous.historyNote) {
        failPromotion_('TEST_DESTINATION_INVALID', 'Promotion history does not preserve its previous snapshot.');
      }
    } else if (['before_status', 'before_rank_known', 'before_belt', 'before_marks', 'before_mark_type'].some(key => entry[key] !== '')) {
      failPromotion_('TEST_DESTINATION_INVALID', 'The initial registration has an unexpected before-rank.');
    }
    const fingerprint = promotionCellText_(entry.payload_fingerprint);
    if (repair) {
      try {
        validatePromotionRepairTransition_(repair, previous, state.events);
        validatePromotionRepairEvidenceBinding_(repair, previous);
        const expected = { ...previous, ...repair.after, revision, lastEventId: eventId };
        if (repair.studentId !== studentId || repair.workbookId !== workbook.getId()
          || eventId !== 'evt-' + repair.repairId || requestId !== 'req-' + repair.repairId
          || fingerprint !== promotionRepairFingerprint_({ operation: 'applyRepair', repair })
          || entry.reason !== canonicalPromotionRepairJson_(repair)
          || promotionRepairFingerprint_(student) !== promotionRepairFingerprint_(expected)
          || entry.approver_id !== '' || entry.approver_label !== '' || entry.corrects_event_id !== ''
          || !/^OWNER DATA REPAIR: [^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.recorder_identity)
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(promotionCellText_(entry.recorded_at_utc))
          || (repair.field === 'rank' && repair.after.lastPromotionDateNY > date)) {
          failPromotion_('TEST_DESTINATION_INVALID', 'A data repair does not match its explicit audit.');
        }
      } catch (_) { failPromotion_('TEST_DESTINATION_INVALID', 'A data repair does not match its explicit audit.'); }
    }
    const syntheticSeed = !previous && kind === 'REGISTER' && entry.recorder_identity === 'SYNTHETIC FIXTURE';
    const legacyImport = entry.recorder_identity === 'LEGACY BASELINE IMPORT';
    const legacySeed = legacyImport && validLegacyPromotionBaseline_(entry, previous, student);
    if ((legacyImport && !legacySeed)
      || (!syntheticSeed && !legacySeed && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f]{64}$/.test(fingerprint)))
      || (syntheticSeed && (date !== '' || fingerprint !== '' || entry.approver_id !== '' || entry.approver_label !== ''))) {
      failPromotion_('TEST_DESTINATION_INVALID', 'A historical event date or request identity is invalid.');
    }
    const receipt = {
      eventId, requestId, studentId, revision, eventKind: kind, eventDateNY: date,
      recordedAtUTC: promotionCellText_(entry.recorded_at_utc), before, after: student,
      approverId: promotionCellText_(entry.approver_id), approverLabel: promotionCellText_(entry.approver_label),
      recorderIdentity: promotionCellText_(entry.recorder_identity), correctsEventId: promotionCellText_(entry.corrects_event_id),
      reason: promotionCellText_(entry.reason), ...(repair ? { repair } : {})
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
  if (!student) failPromotion_('NOT_FOUND', 'This student was not found. Search again or explicitly register a missing student.');
  return student;
}

function buildPromotionEvent_(intent, state, recorder, target = 'test') {
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
    reason = target === 'live' ? 'Explicit student registration; current rank needs confirmation.' : 'Explicit TEST student registration; current rank needs confirmation.';
    after = {
      studentId: 'stu-' + Utilities.getUuid(), displayName: intent.displayName, distinguishingLabel: intent.distinguishingLabel,
      status: 'active', rankKnown: false, belt: '', marks: null, markType: '', revision: 1,
      legacyRefs: '', historyNote: intent.historyNote
    };
  } else {
    previous = requirePromotionStudent_(state, intent.studentId);
    if (previous.status === 'archived') failPromotion_('ARCHIVED', 'This former student record is read-only. Return-to-training policy is outside this tool.');
    if (previous.revision !== intent.expectedRevision) failPromotion_('STALE_REVISION', 'This student changed in another session. Reload and review the current rank before making a new decision.');
    after = { ...previous, revision: previous.revision + 1 };
    if (intent.operation === 'confirmRank') {
      if (previous.rankKnown) failPromotion_('RANK_ALREADY_KNOWN', 'The current rank is already recorded. Use a promotion or an audited correction.');
      kind = 'RANK_CONFIRM';
      Object.assign(after, promotionRank_(intent.rank));
      reason = intent.reason;
    } else if (intent.operation === 'correctLatest') {
      // A name repair does not award rank or prevent correction of the latest
      // instructor rank entry. The current head revision still guards the save;
      // neither a source rank repair nor any later instructor event is crossed.
      const latest = state.events.filter(event => event.studentId === previous.studentId).reverse()
        .find(event => !(event.eventKind === 'REPAIR' && event.repair.field === 'identity'));
      if (!latest || intent.correctsEventId !== latest.eventId || !['RANK_CONFIRM', 'STRIPE', 'BELT', 'CORRECTION'].includes(latest.eventKind)) {
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
  after.lastPromotionDateNY = kind === 'STRIPE' || kind === 'BELT'
    ? promotionToday_() : previous ? previous.lastPromotionDateNY : '';
  const approver = PROMOTION_APPROVERS_.find(item => item.id === intent.approverId);
  return {
    eventId, requestId: intent.requestId, studentId: after.studentId, revision: after.revision, eventKind: kind,
    eventDateNY: promotionToday_(), recordedAtUTC: new Date().toISOString(), before: previous ? rankSnapshot_(previous) : null,
    after, approverId: approver ? approver.id : '', approverLabel: intent.approverName || (approver ? approver.label : ''),
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
  // literal. Sheets consumes one leading apostrophe as a text marker, so an
  // existing literal apostrophe (such as a quoted sheet name) needs escaping too.
  return row.map(value => typeof value === 'string' && /^[\s]*['=+\-@]/.test(value) ? "'" + value : value);
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
