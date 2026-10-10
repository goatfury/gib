import { createHmac } from 'node:crypto';
import { digestHash, digestGym, digestStoreName, digestLabelKey as labelKey } from './m1-attendance-digest.mjs';
import { periodFor } from './m1-manager-review.mjs';

export const REPLY_SCHEMA = 'm1-reply-intake/v1';
export const REPLY_PREFIX = 'reply-intake/v1/';
export const MAILBOX = 'revbjjops@gmail.com';
export const MANAGERS = Object.freeze({ rev: { name: 'Stuart Turner', address: 'info@revolutionbjj.com' }, richmond: { name: 'Trey Martin', address: 'info@richmondbjj.com' } });
export const CAUSES = Object.freeze(['unresolved', 'confirmed-human-omission', 'cancelled-class', 'delayed-upload', 'technical-uncertainty', 'schedule-uncertainty']);
export const replySignature = (raw, secret) => createHmac('sha256', secret).update(REPLY_SCHEMA + '\n' + raw).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const gmailId = value => typeof value === 'string' && /^[a-f0-9]{8,40}$/.test(value);
const text = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const normal = value => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const eventMarker = (gym, id) => '[GiB ' + gym + ' ' + id + ']';
export async function replyStore(scope, dependencies = {}) {
  if (scope?.target !== 'production' || !digestGym(scope)) fail('REPLY_SCOPE_REQUIRED');
  if (dependencies.replyStore) return dependencies.replyStore;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: digestStoreName(scope, 'delivery'), consistency: 'strong' });
}
export async function readReplyRecord(store, key) { return (await store.getWithMetadata(REPLY_PREFIX + key, { type: 'json', consistency: 'strong' }))?.data ?? null; }
const read = readReplyRecord;
export async function retainReplyRecord(store, key, value) {
  const result = await store.set(REPLY_PREFIX + key, JSON.stringify(value), { onlyIfNew: true });
  const saved = await read(store, key);
  if (![true, false].includes(result?.modified) || digestHash(saved) !== digestHash(value)) fail('REPLY_STORAGE_CONFLICT');
  return result.modified;
}
const retain = retainReplyRecord;
export async function listReplyRecords(store, kind) {
  if (!['events', 'queue', 'reviews', 'polls', 'rejections', 'thread-evidence', 'route-faults', 'route-verifications', 'handoffs', 'handoff-receipts'].includes(kind)) fail('REPLY_KEY_INVALID');
  const { blobs } = await store.list({ prefix: REPLY_PREFIX + kind + '/' });
  if (blobs.length > 10000) fail('REPLY_REVIEW_CAPACITY');
  return Promise.all(blobs.map(async blob => {
    const value = await read(store, blob.key.slice(REPLY_PREFIX.length));
    if (!value) fail('REPLY_STORAGE_INCOMPLETE');
    return value;
  }));
}

// Capture only the specific attendance questions already in this exact digest.
// Never derive a class, person, or date from the manager's free-form language.
export function replyEvent(check, scope, report) {
  const gym = digestGym(scope), id = check.binding.requestId;
  if (scope.target !== 'production' || !uuid(id) || !report?.rendered) fail('REPLY_EVENT_INVALID');
  if (!text(report.rendered.subject + ' ' + eventMarker(gym, id), 998)) fail('REPLY_EVENT_INVALID');
  const ledger = check.snapshots?.find(s => s.gym === gym)?.attendance?.ledger;
  const schedule = check.schedules?.find(s => s.gym === gym);
  const items = (check.digest.groups.find(g => g.gym === gym)?.items || []).filter(i => ['missing-instructor', 'attendance-conflict'].includes(i.kind));
  const questions = items.map(item => {
    const day = ledger?.days?.find(d => d.date === item.date);
    const labels = [...new Set([...(schedule?.days?.find(d => d.date === item.date)?.occurrences || []).map(o => o.label), ...(day?.records || []).map(r => r.classLabel), ...(day?.review?.decisions || []).map(d => d.label)])];
    // One digest identity can have several original spellings. Group by the
    // digest's exact key, without removing times or other occurrence markers.
    const labelGroups = new Map();
    for (const label of labels) {
      const key = labelKey(label);
      labelGroups.set(key, [...(labelGroups.get(key) || []), label]);
    }
    const matches = [...labelGroups].filter(([key]) => {
      const records = (day?.records || []).filter(r => labelKey(r.classLabel) === key);
      const identities = [key, 'schedule-cancellation:' + key, 'cancellation:' + key, ...records.flatMap(r => [r.recordId, 'duration:' + r.recordId, 'ambiguous-id:' + r.recordId])];
      return identities.some(identity => digestHash([gym, item.kind, item.date, identity]).slice(0, 24) === item.id);
    });
    const classLabels = matches.length === 1 ? matches[0][1] : [];
    const classLabel = classLabels[0] || null;
    return { itemId: item.id, date: item.date, kind: item.kind, classLabel, observedClassLabels: classLabels, summary: item.summary,
      attendanceHash: day?.attendanceHash || null, period: periodFor(item.date),
      records: classLabel ? day.records.filter(r => labelKey(r.classLabel) === labelKey(classLabel)).map(r => ({ recordId: r.recordId, classLabel: r.classLabel, instructor: r.instructor, duration: r.duration, fingerprint: r.fingerprint || null, reviewRequired: r.reviewRequired })) : [] };
  });
  // The existing system's canonical identity is the complete instructor name.
  // New/ambiguous names require a human to verify the roster, never fuzzy aliases.
  const instructors = [...new Set((ledger?.days || []).flatMap(d => d.records.map(r => r.instructor)))].filter(n => text(n, 100)).sort();
  return { schema: 'm1-reply-event/v1', eventId: id, gym, target: 'production', opportunityDate: check.binding.jobDate,
    createdAt: check.binding.createdAt, manager: MANAGERS[gym], mailbox: MAILBOX,
    subject: report.rendered.subject + ' ' + eventMarker(gym, id), questions, instructors,
    digestHash: digestHash(check.digest), unattendedWrites: false, payrollRelease: false };
}
export async function prepareReplyEvent(check, scope, report, dependencies = {}) {
  const event = replyEvent(check, scope, report), store = await replyStore(scope, dependencies);
  await retain(store, 'events/' + event.eventId, event);
  return { ...report, rendered: { ...report.rendered, subject: event.subject } };
}
export async function retainReplyRouteFault(store, gym, fault, now) {
  if (!uuid(fault?.eventId) || !Number.isSafeInteger(fault.at) || fault.at <= 0 || fault.at > now
    || !['event-registration-unavailable', 'sender-route-unconfirmed'].includes(fault.code)) fail('REPLY_ROUTE_FAULT_INVALID');
  const record = { id: digestHash([gym, fault.eventId, fault.code]), gym, eventId: fault.eventId, at: fault.at, code: fault.code };
  await retain(store, 'route-faults/' + record.id, record); return record;
}
async function retainReplyRouteOverflow(store, gym, overflow, now) {
  if (!uuid(overflow?.eventId) || !uuid(overflow.lastEventId) || overflow.code !== 'sender-route-overflow'
    || !Number.isSafeInteger(overflow.at) || overflow.at <= 0 || !Number.isSafeInteger(overflow.through)
    || overflow.through < overflow.at || overflow.through > now || !Number.isSafeInteger(overflow.count) || overflow.count < 1) fail('REPLY_ROUTE_FAULT_INVALID');
  const record = { id: digestHash([gym, overflow]), gym, eventId: overflow.eventId, at: overflow.through,
    affectedFrom: overflow.at, affectedThrough: overflow.through, count: overflow.count, code: overflow.code };
  await retain(store, 'route-faults/' + record.id, record); return record;
}
export async function verifyReplyRouteRecovery(store, gym, input, reviewer, now) {
  if (!hex(input.faultId) || !uuid(input.eventId) || !text(input.reason, 1000)) fail('REPLY_ROUTE_PROOF_REQUIRED');
  const fault = await read(store, 'route-faults/' + input.faultId), event = await read(store, 'events/' + input.eventId);
  const polls = await listReplyRecords(store, 'polls');
  if (fault?.gym !== gym || event?.gym !== gym || event.createdAt < fault.at
    || !polls.some(p => p.gym === gym && p.status === 'complete' && p.checkedAt >= fault.at)) fail('REPLY_ROUTE_PROOF_REQUIRED');
  const key = 'route-verifications/' + fault.id;
  const record = { faultId: fault.id, eventId: event.eventId, gym, reason: input.reason, reviewer };
  await retain(store, key, record); return record;
}

export function validateReplyMessage(message) {
  if (!message || !gmailId(message.gmailId) || !gmailId(message.threadId) || !uuid(message.eventId)
    || !text(message.from) || !Array.isArray(message.to) || !message.to.every(a => text(a))
    || !text(message.rfcId, 998) || !text(message.inReplyTo, 998) || !text(message.subject, 998)
    || !Array.isArray(message.references) || message.references.length > 100 || !message.references.every(a => text(a, 998))
    || !Number.isSafeInteger(message.receivedAt) || !text(message.body, 12000) || typeof message.authenticated !== 'boolean'
    || typeof message.truncated !== 'boolean') fail('REPLY_MESSAGE_INVALID');
  const p = message.parent;
  if (p !== null && (!p || !gmailId(p.gmailId) || !gmailId(p.threadId) || !text(p.rfcId, 998)
    || !text(p.from) || !Array.isArray(p.to) || !p.to.every(a => text(a)) || !text(p.subject, 998)
    || p.replyTo !== MAILBOX || p.sent !== true || !Number.isSafeInteger(p.sentAt))) fail('REPLY_PARENT_INVALID');
}
function classify(message, event, now) {
  if (!event) return 'event-not-found';
  if (message.from !== event.manager.address) return 'wrong-manager';
  if (!message.authenticated) return 'sender-unverified';
  if (!message.to.includes(MAILBOX)) return 'wrong-recipient';
  const p = message.parent;
  if (!p || p.from !== MAILBOX || !p.to.includes(event.manager.address) || p.subject !== event.subject
    || p.threadId !== message.threadId || p.rfcId === message.rfcId
    || !message.references.includes(p.rfcId) && message.inReplyTo !== p.rfcId
    || p.sentAt < event.createdAt || p.sentAt > message.receivedAt) return 'thread-unverified';
  if (message.subject.replace(/^(?:re:\s*)+/i, '') !== event.subject) return 'subject-mismatch';
  if (message.receivedAt < event.createdAt || message.receivedAt > now + 60000) return 'invalid-time';
  if (now - event.createdAt > 31 * 86400000) return 'stale-thread';
  if (message.truncated) return 'body-incomplete';
  if (!event.questions.length) return 'no-attendance-question';
  if (/\b(both|all of (?:them|those)|same as|yesterday|last (?:week|time))\b/i.test(message.body)) return 'ambiguous-language';
  return 'needs-review';
}
export async function ingestReply(store, gym, message, now) {
  validateReplyMessage(message);
  const event = await read(store, 'events/' + message.eventId);
  if (event && (event.gym !== gym || event.target !== 'production')) fail('REPLY_GYM_MISMATCH');
  const id = digestHash([MAILBOX, message.gmailId]);
  const original = await read(store, 'queue/' + id);
  const { parent, ...immutableMessage } = message;
  const sourceHash = digestHash(immutableMessage);
  if (original) {
    if (original.sourceHash !== sourceHash) {
      await retain(store, 'rejections/' + id + '/conflict-' + sourceHash, { id, gym, gmailId: message.gmailId,
        code: 'REPLY_REPLAY_CONFLICT', state: 'operator-review-required', originalSourceHash: original.sourceHash, conflictingSourceHash: sourceHash });
      return { id, new: false, state: 'replay-conflict' };
    }
    await quarantineUnverifiedReply(store, original);
    return observeThreadEvidence(store, original, message, event, now, false);
  }
  const state = classify(message, event, now);
  // Wrong sender/recipient/event gets no body retention and no agent wake.
  const relevant = Boolean(event && message.from === event.manager.address && message.to.includes(MAILBOX) && message.authenticated);
  const record = { schema: 'm1-reply-correction/v1', id, gym, eventId: message.eventId, sourceHash,
    gmailId: message.gmailId, threadId: message.threadId, rfcIdHash: digestHash(message.rfcId), receivedAt: message.receivedAt,
    state, relevant, body: relevant ? message.body : null, cause: 'unresolved', causeReviewed: false,
    manager: relevant ? event.manager : null, questions: relevant ? event.questions : [],
    supportedScope: relevant && event.questions.length === 1 ? [event.questions[0].itemId] : [],
    unresolvedRemainder: relevant && /\bboth\b/i.test(message.body) ? 'A second occurrence is not established by this reply; verify it separately.' : null,
    payrollState: 'held-for-review', attendanceWritten: false, payrollReleased: false };
  const created = await retain(store, 'queue/' + id, record);
  await quarantineUnverifiedReply(store, record);
  return observeThreadEvidence(store, record, message, event, now, created);
}
async function observeThreadEvidence(store, source, message, event, now, created) {
  if (!source.relevant) return { id: source.id, new: false, state: source.state };
  const state = classify(message, event, now);
  const parentHash = digestHash(message.parent);
  const evidenceId = digestHash([source.id, source.sourceHash, parentHash, state]);
  const evidence = { schema: 'm1-reply-thread-evidence/v1', id: evidenceId, sourceId: source.id, sourceHash: source.sourceHash,
    gym: source.gym, eventId: source.eventId, parentHash, parent: message.parent, state };
  const fresh = await retain(store, 'thread-evidence/' + source.id + '/' + evidenceId, evidence);
  return { id: source.id, new: created || fresh && source.state === 'thread-unverified' && state !== 'thread-unverified', state, evidenceId };
}
function projectedReply(source, evidence, rejections) {
  const matching = evidence.filter(e => e.sourceId === source.id && e.sourceHash === source.sourceHash && e.gym === source.gym);
  const verified = matching.filter(e => e.state !== 'thread-unverified');
  const parents = [...new Set(verified.map(e => e.parentHash))];
  const conflicting = rejections.some(r => r.id === source.id && r.code === 'REPLY_REPLAY_CONFLICT');
  // Missing a parent on a later fetch cannot erase previously verified proof.
  // Different verified parents or source bytes always return to an explicit hold.
  const state = conflicting ? 'replay-conflict' : parents.length > 1 ? 'thread-evidence-conflict'
    : verified.find(e => e.state === 'stale-thread')?.state || verified[0]?.state || source.state;
  const evidenceIds = verified.map(e => e.id).sort();
  return { ...source, state, evidenceIds, sourceVersion: digestHash([source.sourceHash, state, evidenceIds, conflicting]) };
}
async function quarantineUnverifiedReply(store, record) {
  if (!['sender-unverified', 'event-not-found'].includes(record.state)) return;
  // The expected attendance scan found evidence we cannot verify. Keep it
  // visible to the operator without trusting or retaining its message body.
  // Replay also repairs a crash after the source write but before quarantine.
  await retain(store, 'rejections/' + record.id, { id: record.id, gym: record.gym, gmailId: record.gmailId,
    code: record.state === 'sender-unverified' ? 'REPLY_SENDER_UNVERIFIED' : 'REPLY_EVENT_NOT_FOUND', state: 'operator-review-required' });
}
export async function recordReplyPoll(store, gym, input, now) {
  if (!uuid(input.requestId) || !Number.isSafeInteger(input.scanFrom) || !Number.isSafeInteger(input.scanThrough)
    || input.scanFrom > input.scanThrough || input.scanThrough > now || !['complete', 'access-revoked', 'poll-failed', 'capacity-exceeded'].includes(input.status)
    || !Array.isArray(input.messages) || input.messages.length > 50 || input.status !== 'complete' && input.messages.length) fail('REPLY_POLL_INVALID');
  const receipts = [];
  const routeFaults = input.routeFaults || (input.routeFault ? [input.routeFault] : []);
  if (!Array.isArray(routeFaults) || routeFaults.length > 20) fail('REPLY_ROUTE_FAULT_INVALID');
  const routeRecords = [];
  for (const fault of routeFaults) routeRecords.push(await retainReplyRouteFault(store, gym, fault, now));
  const overflowRecord = input.routeFaultOverflow && await retainReplyRouteOverflow(store, gym, input.routeFaultOverflow, now);
  for (const message of input.messages) {
    try { receipts.push(await ingestReply(store, gym, message, now)); }
    catch (error) {
      if (!['REPLY_MESSAGE_INVALID', 'REPLY_PARENT_INVALID'].includes(error.code) || !gmailId(message?.gmailId)) throw error;
      const id = digestHash([MAILBOX, message.gmailId]);
      await retain(store, 'rejections/' + id, { id, gym, gmailId: message.gmailId, code: error.code, state: 'operator-review-required' });
      receipts.push({ id, new: false, state: 'malformed-message' });
    }
  }
  // Retries retain the exact batch; freshness is not rewritten by a replay.
  const poll = { schema: 'm1-reply-poll/v1', requestId: input.requestId, gym, scanFrom: input.scanFrom, scanThrough: input.scanThrough,
    status: input.status, checkedAt: input.createdAt, messageIds: receipts.map(r => r.id), evidenceIds: receipts.map(r => r.evidenceId || null) };
  await retain(store, 'polls/' + input.requestId, poll);
  const routeFaultAcknowledgements = [];
  for (let index = 0; index < routeRecords.length; index++) if (await read(store, 'route-verifications/' + routeRecords[index].id)) routeFaultAcknowledgements.push(routeFaults[index]);
  const overflowAcknowledged = overflowRecord && await read(store, 'route-verifications/' + overflowRecord.id);
  return { accepted: true, newRelevant: receipts.filter(r => r.new).map(r => r.id),
    routeFaultAcknowledgements,
    ...(input.routeFault && routeFaultAcknowledgements.length ? { routeFaultAcknowledged: input.routeFault.eventId } : {}),
    ...(overflowAcknowledged ? { routeFaultOverflowAcknowledged: input.routeFaultOverflow } : {}) };
}
export async function replyQueue(store, gym, now) {
  const [sources, polls, reviews, rejections, evidence, routeFaults, routeVerifications] = await Promise.all(['queue', 'polls', 'reviews', 'rejections', 'thread-evidence', 'route-faults', 'route-verifications'].map(kind => listReplyRecords(store, kind)));
  const queue = sources.map(source => projectedReply(source, evidence, rejections));
  const unresolvedRouteFaults = routeFaults.filter(f => f.gym === gym && !routeVerifications.some(v => v.faultId === f.id && v.gym === gym));
  const orderedPolls = polls.filter(p => p.gym === gym).sort((a,b) => b.checkedAt - a.checkedAt);
  const latest = orderedPolls[0];
  const mailboxCode = !latest || now - latest.checkedAt > 3 * 3600000 ? 'poll-overdue' : latest.status !== 'complete' ? latest.status
    : now - latest.scanThrough > 24 * 3600000 ? 'poll-backlog' : rejections.length || queue.some(r => r.state === 'thread-evidence-conflict') ? 'message-quarantined' : 'healthy';
  const code = mailboxCode === 'healthy' && unresolvedRouteFaults.length ? 'route-degraded' : mailboxCode;
  const episodeAnchor = mailboxCode === 'poll-overdue' ? latest?.requestId : latest?.status !== 'complete'
    ? orderedPolls.find(p => p.status !== latest?.status)?.requestId
    : mailboxCode === 'poll-backlog' ? orderedPolls.find(p => p.status === 'complete' && p.checkedAt - p.scanThrough <= 24 * 3600000)?.requestId : null;
  return { gym, health: { code, mailboxCode, checkedAt: latest?.checkedAt || null, scanThrough: latest?.scanThrough || null,
    episode: code === 'healthy' ? null : digestHash([gym, code, episodeAnchor || 'initial']),
    exceptionKey: code === 'healthy' ? null : gym + ':reply-intake', action: code === 'healthy' ? null : 'Check the hourly business-mailbox trigger and its authorization; retry the retained interval. Do not change attendance.' },
    routing: { code: unresolvedRouteFaults.length ? 'route-degraded' : routeFaults.length ? 'recovery-verified' : 'unverified', unresolvedFaults: unresolvedRouteFaults, verifications: routeVerifications,
      action: unresolvedRouteFaults.length ? 'A reminder fell back to Andrew. Repair event registration, verify a retained event and successful scan, and account for replies to the old address before clearing this exception.' : null },
    items: queue.filter(r => r.gym === gym && r.relevant).sort((a,b) => a.receivedAt - b.receivedAt).map(r => ({ ...r,
      relatedSourceIds: queue.filter(other => other.id !== r.id && other.gym === gym && other.eventId === r.eventId && other.relevant).map(other => other.id),
      intakeState: reviews.find(review => review.sourceId === r.id && review.sourceVersion === r.sourceVersion)?.decision === 'propose-correction' ? 'proposed'
        : reviews.find(review => review.sourceId === r.id && review.sourceVersion === r.sourceVersion)?.decision || 'received' })), reviews, rejections,
    attendanceWritesEnabled: false, clarificationEmailsEnabled: false, payrollReleaseEnabled: false };
}

// One immutable human decision per source/evidence version. New thread proof
// preserves earlier held reviews. No decision calls attendance APIs.
export async function reviewReply(store, gym, input, reviewer, now) {
  if (!hex(input.id) || !uuid(input.reviewId) || !CAUSES.includes(input.cause) || !text(input.reason, 1000)
    || !['propose-correction', 'hold', 'dismiss'].includes(input.decision)) fail('REPLY_REVIEW_INVALID');
  const original = await read(store, 'queue/' + input.id), event = original && await read(store, 'events/' + original.eventId);
  const [evidence, rejections] = await Promise.all(['thread-evidence', 'rejections'].map(kind => listReplyRecords(store, kind)));
  const source = original && projectedReply(original, evidence, rejections);
  if (!source?.relevant || source.gym !== gym || !event) fail('REPLY_REVIEW_SOURCE_INVALID');
  let selected = null;
  if (input.decision === 'propose-correction') {
    if (source.state !== 'needs-review') fail('REPLY_AMBIGUITY_REQUIRES_NEW_EVIDENCE');
    const question = event.questions.find(q => q.itemId === input.itemId);
    const names = event.instructors.filter(n => normal(n) === normal(input.instructor));
    if (!question?.classLabel || !hex(question.attendanceHash) || names.length !== 1 || names[0] !== input.instructor
      || !['add-attendance', 'correct-attendance', 'class-not-held', 'no-change'].includes(input.action)
      || !Number.isFinite(input.duration) || input.duration < 0 || input.duration > 24
      || ['add-attendance', 'correct-attendance'].includes(input.action) && input.duration === 0
      || ['class-not-held', 'no-change'].includes(input.action) && input.duration !== 0) fail('REPLY_CANONICAL_SELECTION_REQUIRED');
    if (new Set(question.records.map(r => r.recordId)).size !== question.records.length) fail('REPLY_DUPLICATE_RECORD_IDS');
    selected = { ...question, instructor: input.instructor, action: input.action, duration: input.duration };
  }
  const record = { schema: 'm1-reply-review/v1', reviewId: input.reviewId, sourceId: source.id, sourceHash: source.sourceHash,
    sourceVersion: source.sourceVersion,
    eventId: event.eventId, gym, reviewer, reviewedAt: now, decision: input.decision, reason: input.reason,
    cause: input.cause, causeReviewed: input.cause !== 'unresolved', selected, payrollState: 'held-until-audit-and-payroll-readback', attendanceWritten: false, payrollReleased: false };
  const reviewKey = 'reviews/' + source.id + '/' + source.sourceVersion;
  const existing = await read(store, reviewKey);
  if (existing) {
    if (digestHash({ ...existing, reviewedAt: 0 }) !== digestHash({ ...record, reviewedAt: 0 })) fail('REPLY_REVIEW_CONFLICT');
    return existing;
  }
  await retain(store, reviewKey, record); return record;
}

// Offline comparison of independently exported attendance audit and payroll
// inputs. A passing comparison is evidence for goati, never payroll authority.
export function reconcileReplyPayroll(review, evidence) {
  const hold = code => ({ state: 'held', code, payrollReleased: false });
  const s = review?.selected, a = evidence?.audit, rows = evidence?.attendance, payroll = evidence?.payroll;
  if (!s || review.decision !== 'propose-correction' || !evidence || !Array.isArray(rows) || !Array.isArray(payroll)) return hold('EVIDENCE_MISSING');
  if (!a || !text(a.auditId) || a.sourceReplyId !== review.sourceId || a.reviewId !== review.reviewId
    || a.gym !== review.gym || a.date !== s.date || a.beforeAttendanceHash !== s.attendanceHash
    || !hex(a.afterAttendanceHash) || evidence.attendanceHash !== a.afterAttendanceHash) return hold('AUDIT_LINK_MISMATCH');
  if (s.action === 'class-not-held' || s.action === 'no-change') return hold('MANUAL_NONPAYABLE_RECONCILIATION_REQUIRED');
  if (new Set(rows.map(r => r.recordId)).size !== rows.length || new Set(payroll.map(r => r.recordId)).size !== payroll.length) return hold('DUPLICATE_INPUT_IDS');
  const row = rows.filter(r => r.recordId === a.resultRecordId);
  const pay = payroll.filter(r => r.recordId === a.resultRecordId);
  if (row.length !== 1 || pay.length !== 1) return hold('RESULT_ROW_NOT_EXACTLY_ONCE');
  for (const r of [row[0], pay[0]]) if (r.gym !== review.gym || r.date !== s.date || r.classLabel !== s.classLabel
    || r.instructor !== s.instructor || r.duration !== s.duration || r.voided === true) return hold('PAYROLL_ATTENDANCE_DISCREPANCY');
  if (pay[0].periodStart !== s.period.start || pay[0].periodEnd !== s.period.end || pay[0].auditId !== a.auditId) return hold('PAYROLL_AUDIT_MISMATCH');
  if (s.action === 'correct-attendance' && s.records.some(r => r.recordId !== a.resultRecordId && (rows.some(n => n.recordId === r.recordId && !n.voided) || payroll.some(n => n.recordId === r.recordId)))) return hold('SUPERSEDED_ROW_STILL_PAYABLE');
  return { state: 'reconciled-for-human-review', auditId: a.auditId, evidenceHash: digestHash(evidence), payrollReleased: false };
}
