/* Private business Sheet projection. Existing Drive-readonly/Sheets scopes.
 * No mailbox, credential, attendance, payroll, sharing or schedule mutation. */
function gibM1ReplyProjectionHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function gibM1ReplyGoogle_(service, path, body) {
  var base = service === 'drive' ? 'https://www.googleapis.com/drive/v3/' : 'https://sheets.googleapis.com/v4/spreadsheets/';
  var options = { method: body ? 'post' : 'get', followRedirects: false, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  var response = UrlFetchApp.fetch(base + path, options);
  if (response.getResponseCode() !== 200) throw new Error('REPLY_PROJECTION_GOOGLE_UNAVAILABLE');
  return JSON.parse(response.getContentText());
}
function gibM1ReplyProjectionDestination_(scope) {
  var id = PropertiesService.getScriptProperties().getProperty('GIB_M1_REPLY_REVIEW_SHEET_ID');
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(id || '')) throw new Error('REPLY_PROJECTION_DESTINATION_REQUIRED');
  var metadata = gibM1ReplyGoogle_('drive', 'files/' + id + '?fields=id,mimeType,trashed,shared,owners(emailAddress)');
  var permissions = gibM1ReplyGoogle_('drive', 'files/' + id + '/permissions?includePermissionsForView=published&fields=nextPageToken,permissions(type,role,emailAddress,view)');
  if (metadata.id !== id || metadata.trashed || metadata.shared !== false || metadata.mimeType !== 'application/vnd.google-apps.spreadsheet'
    || metadata.owners?.length !== 1 || metadata.owners[0].emailAddress !== GIB_M1_REPLY_MAILBOX_
    || permissions.nextPageToken || permissions.permissions?.length !== 1 || permissions.permissions[0].type !== 'user'
    || permissions.permissions[0].role !== 'owner' || permissions.permissions[0].emailAddress !== GIB_M1_REPLY_MAILBOX_
    || permissions.permissions[0].view) throw new Error('REPLY_PROJECTION_NOT_PRIVATE');
  var book = gibM1ReplyGoogle_('sheets', id + '?fields=spreadsheetId,sheets(properties(sheetId,title,gridProperties))');
  var name = scope.gym === 'rev' ? 'Revolution' : 'Richmond';
  var reply = book.sheets.filter(function(s) { return s.properties.title === name + ' Replies'; });
  var health = book.sheets.filter(function(s) { return s.properties.title === name + ' Health'; });
  if (book.spreadsheetId !== id || reply.length !== 1 || health.length !== 1) throw new Error('REPLY_PROJECTION_TABS');
  return { id: id, reply: reply[0].properties, health: health[0].properties };
}
// Read-only editor check; does not grant access, write cells or create timers.
function verifyBusinessReplyProjectionDestination() {
  var scope = gibM1ReplyScope_(), destination = gibM1ReplyProjectionDestination_(scope);
  return { ok: true, gym: scope.gym, owner: GIB_M1_REPLY_MAILBOX_, spreadsheetId: destination.id, private: true };
}
function gibM1ReplyProjectionCells_(rows) {
  return rows.map(function(values) { return { values: values.map(function(value) { return { userEnteredValue:
    typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } }; }) }; });
}
function gibM1ReplyProjectionFailure_(properties) {
  var now = Date.now(), old = JSON.parse(properties.getProperty('GIB_M1_REPLY_PROJECTION_FAULT') || 'null');
  var fault = old || { code: 'projection-failed', episodeId: Utilities.getUuid(), firstFailureAt: now, lastFailureAt: now, failureCount: 0, recoveredAt: '', updatedAt: now };
  fault.lastFailureAt = now; fault.failureCount++; fault.recoveredAt = ''; fault.updatedAt = now;
  properties.setProperty('GIB_M1_REPLY_PROJECTION_FAULT', JSON.stringify(fault));
}
function publishBusinessAttendanceReplyProjection() {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('GIB_M1_REPLY_PROJECTION_ENABLED') !== 'true') return { enabled: false };
  // A separate user lock serializes projection writers without holding the
  // ScriptLock used by sending/attendance across network operations.
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) throw new Error('REPLY_PROJECTION_BUSY');
  try {
    var scope = gibM1ReplyScope_(), destination = gibM1ReplyProjectionDestination_(scope);
    var fault = JSON.parse(properties.getProperty('GIB_M1_REPLY_PROJECTION_FAULT') || 'null'), now = Date.now();
    var input = { schema: GIB_M1_REPLY_SCHEMA_, action: 'projection', gym: scope.gym, target: 'production',
      requestId: Utilities.getUuid(), createdAt: now, expiresAt: now + 60000, projectionFault: fault };
    var snapshot = gibM1ReplyPost_(scope, input);
    if (snapshot.schema !== 'm1-reply-sheet/v1' || snapshot.gym !== scope.gym || snapshot.generation !== input.requestId
      || snapshot.tabs.replies !== destination.reply.title || snapshot.tabs.health !== destination.health.title
      || snapshot.replyHeaders.length !== 18 || snapshot.healthHeaders.length !== 22
      || snapshot.replies.length > 2000 || snapshot.health.length > 2001) throw new Error('REPLY_PROJECTION_INVALID');
    var requests = [];
    [[destination.reply, snapshot.replyHeaders, snapshot.replies], [destination.health, snapshot.healthHeaders, snapshot.health]].forEach(function(part) {
      var tab = part[0], headers = part[1], rows = [headers].concat(part[2]);
      if (rows.some(function(r) { return r.length !== headers.length; })) throw new Error('REPLY_PROJECTION_INVALID');
      if (tab.gridProperties.rowCount < rows.length || tab.gridProperties.columnCount < headers.length) requests.push({ updateSheetProperties: {
        properties: { sheetId: tab.sheetId, gridProperties: { rowCount: Math.max(tab.gridProperties.rowCount, rows.length), columnCount: Math.max(tab.gridProperties.columnCount, headers.length) } }, fields: 'gridProperties(rowCount,columnCount)' } });
      // Bounded clearing prevents old tail rows surviving a smaller projection.
      requests.push({ updateCells: { range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: Math.max(rows.length, Math.min(tab.gridProperties.rowCount, 2002)), startColumnIndex: 0, endColumnIndex: headers.length },
        rows: gibM1ReplyProjectionCells_(rows), fields: 'userEnteredValue' } });
    });
    var body = { requests: requests };
    if (Utilities.newBlob(JSON.stringify(body)).getBytes().length > 1800000) throw new Error('REPLY_PROJECTION_CAPACITY');
    // Sheets batchUpdate applies the two tab updates atomically. Explicit
    // stringValue keeps =,+,-,@ and quoted text literal, never executable.
    gibM1ReplyGoogle_('sheets', destination.id + ':batchUpdate', body);
    var ranges = ["'" + destination.reply.title + "'!A1:R" + (snapshot.replies.length + 1), "'" + destination.health.title + "'!A1:V" + (snapshot.health.length + 1)];
    var back = gibM1ReplyGoogle_('sheets', destination.id + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&ranges=' + ranges.map(encodeURIComponent).join('&ranges='));
    var expected = [[snapshot.replyHeaders].concat(snapshot.replies), [snapshot.healthHeaders].concat(snapshot.health)];
    if (back.valueRanges?.length !== 2) throw new Error('REPLY_PROJECTION_READBACK');
    expected.forEach(function(rows, index) {
      var actual = back.valueRanges[index].values || [];
      actual = actual.map(function(r) { return rows[0].map(function(_, col) { return r[col] === undefined ? '' : r[col]; }); });
      if (gibM1ReplyProjectionHash_(actual) !== gibM1ReplyProjectionHash_(rows)) throw new Error('REPLY_PROJECTION_READBACK');
    });
    if (fault) {
      if (fault.recoveredAt && snapshot.projectionFaultAccepted === gibM1ReplyProjectionHash_(fault)) properties.deleteProperty('GIB_M1_REPLY_PROJECTION_FAULT');
      else { fault.recoveredAt = Date.now(); fault.updatedAt = fault.recoveredAt; properties.setProperty('GIB_M1_REPLY_PROJECTION_FAULT', JSON.stringify(fault)); }
    }
    return { ok: true, gym: scope.gym, generation: snapshot.generation, replyRows: snapshot.replies.length, healthRows: snapshot.health.length };
  } catch (error) {
    gibM1ReplyProjectionFailure_(properties);
    throw new Error('REPLY_PROJECTION_FAILED');
  } finally { lock.releaseLock(); }
}
