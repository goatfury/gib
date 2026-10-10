import { digestHash } from './m1-attendance-digest.mjs';
import { replyQueue, listReplyRecords, retainReplyRecord } from './m1-reply-intake.mjs';

export const PROJECTION_SCHEMA = 'm1-reply-sheet/v1';
export const PROJECTION_LIMIT = 2000;
export const REPLY_HEADERS = ['gym', 'sourceId', 'sourceVersion', 'eventId', 'receivedAt', 'managerAddress', 'gmailId', 'threadId', 'rfcIdHash', 'state', 'reviewState', 'replyText', 'incomplete', 'ambiguous', 'questionsJson', 'relatedSourceIdsJson', 'generation', 'rowHash'];
export const HEALTH_HEADERS = ['rowType', 'gym', 'code', 'checkedAt', 'scanThrough', 'routeFaultsJson', 'routeOverflowJson', 'generation', 'projectedAt', 'replyRowCount', 'replySnapshotHash', 'episodeRowCount', 'episodeSnapshotHash', 'sourceRevision', 'projectionStatus', 'episodeId', 'firstFailureAt', 'lastFailureAt', 'failureCount', 'recoveredAt', 'episodeVersion', 'rowHash'];
export const RECEIPT_HEADERS = ['gym', 'kind', 'sourceId', 'sourceVersion', 'surfacedAt', 'outputReference'];
export const projectionTabs = gym => ({ replies: gym === 'rev' ? 'Revolution Replies' : 'Richmond Replies', health: gym === 'rev' ? 'Revolution Health' : 'Richmond Health' });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const row = (headers, fields) => {
  const cells = headers.slice(0, -1).map(key => fields[key] ?? '');
  if (cells.some(value => typeof value === 'string' && value.length > 45000)) fail('REPLY_PROJECTION_CELL_CAPACITY');
  return [...cells, digestHash(cells)];
};
const minimalQuestion = q => ({ itemId: q.itemId, date: q.date, kind: q.kind, classLabel: q.classLabel,
  observedClassLabels: q.observedClassLabels, attendanceHash: q.attendanceHash, period: q.period,
  records: q.records.map(r => ({ recordId: r.recordId, classLabel: r.classLabel, instructor: r.instructor,
    credit: r.duration, fingerprint: r.fingerprint, reviewRequired: Boolean(r.reviewRequired) })) });

// Derive episodes from immutable poll history, including recovered failures and
// silent gaps. A later successful poll never erases a failed poll's evidence.
export function replyHealthEpisodes(polls, gym, now) {
  const ordered = polls.filter(p => p.gym === gym).sort((a, b) => a.checkedAt - b.checkedAt || a.requestId.localeCompare(b.requestId));
  const episodes = [], active = new Map(); let previous;
  for (const poll of ordered) {
    if (previous && poll.checkedAt - previous.checkedAt > 3 * 3600000) episodes.push({
      episodeId: digestHash([gym, 'poll-overdue', previous.requestId]), code: 'poll-overdue',
      firstFailureAt: previous.checkedAt + 3 * 3600000, lastFailureAt: poll.checkedAt, failureCount: 1, recoveredAt: poll.checkedAt });
    if (poll.status === 'complete') {
      for (const episode of active.values()) episode.recoveredAt = poll.checkedAt;
      active.clear();
    } else {
      let episode = active.get(poll.status);
      if (!episode) {
        episode = { episodeId: digestHash([gym, poll.status, poll.requestId]), code: poll.status,
          firstFailureAt: poll.checkedAt, lastFailureAt: poll.checkedAt, failureCount: 0, recoveredAt: '' };
        episodes.push(episode); active.set(poll.status, episode);
      }
      episode.lastFailureAt = poll.checkedAt; episode.failureCount++;
    }
    previous = poll;
  }
  if (previous && now - previous.checkedAt > 3 * 3600000) episodes.push({
    episodeId: digestHash([gym, 'poll-overdue', previous.requestId]), code: 'poll-overdue',
    firstFailureAt: previous.checkedAt + 3 * 3600000, lastFailureAt: previous.checkedAt + 3 * 3600000, failureCount: 1, recoveredAt: '' });
  return episodes.map(e => ({ ...e, episodeVersion: digestHash(e) })).sort((a, b) => a.firstFailureAt - b.firstFailureAt || a.episodeId.localeCompare(b.episodeId));
}

export async function replyProjection(store, gym, now, generation, projectionFault) {
  if (!['rev', 'richmond'].includes(gym) || !/^[0-9a-f-]{36}$/.test(generation)) fail('REPLY_PROJECTION_SCOPE');
  const queue = await replyQueue(store, gym, now);
  let projectionFaultAccepted = null;
  if (projectionFault) {
    const f = projectionFault;
    if (Object.keys(f).sort().join(',') !== 'code,episodeId,failureCount,firstFailureAt,lastFailureAt,recoveredAt,updatedAt'
      || f.code !== 'projection-failed' || !/^[0-9a-f-]{36}$/.test(f.episodeId)
      || ![f.firstFailureAt, f.lastFailureAt, f.updatedAt, f.failureCount].every(Number.isSafeInteger)
      || f.firstFailureAt <= 0 || f.lastFailureAt < f.firstFailureAt || f.updatedAt < f.lastFailureAt || f.updatedAt > now + 60000 || f.failureCount < 1
      || f.recoveredAt !== '' && (!Number.isSafeInteger(f.recoveredAt) || f.recoveredAt < f.lastFailureAt || f.recoveredAt > f.updatedAt)) fail('REPLY_PROJECTION_FAULT');
    projectionFaultAccepted = digestHash(f);
    await retainReplyRecord(store, 'projection-health/' + f.episodeId + '/' + projectionFaultAccepted, { gym, ...f });
  }
  // Preserve every published source/evidence version in the canonical private
  // store so a damaged/missing Sheet can be rebuilt without losing old versions.
  for (const item of queue.items) {
    const record = { gym, sourceId: item.id, sourceVersion: item.sourceVersion, eventId: item.eventId,
      receivedAt: item.receivedAt, managerAddress: item.manager.address, gmailId: item.gmailId,
      threadId: item.threadId, rfcIdHash: item.rfcIdHash, state: item.state, replyText: item.body,
      incomplete: item.state === 'body-incomplete', ambiguous: item.state !== 'needs-review',
      questionsJson: JSON.stringify(item.questions.map(minimalQuestion)) };
    await retainReplyRecord(store, 'projection-replies/' + item.id + '/' + item.sourceVersion, record);
  }
  const [saved, polls, projectionFaults] = await Promise.all(['projection-replies', 'polls', 'projection-health'].map(kind => listReplyRecords(store, kind)));
  const sources = saved.filter(r => r.gym === gym).sort((a,b) => a.receivedAt - b.receivedAt || a.sourceId.localeCompare(b.sourceId) || a.sourceVersion.localeCompare(b.sourceVersion));
  const episodes = replyHealthEpisodes(polls, gym, now);
  const latestFaults = new Map();
  for (const f of projectionFaults.filter(f => f.gym === gym).sort((a,b) => a.updatedAt - b.updatedAt || a.failureCount - b.failureCount)) latestFaults.set(f.episodeId, f);
  for (const f of latestFaults.values()) episodes.push({ ...f, episodeVersion: digestHash(f) });
  episodes.sort((a,b) => a.firstFailureAt - b.firstFailureAt || a.episodeId.localeCompare(b.episodeId));
  if (sources.length > PROJECTION_LIMIT || episodes.length > PROJECTION_LIMIT) fail('REPLY_PROJECTION_CAPACITY');
  const rows = sources.map(r => row(REPLY_HEADERS, { ...r, generation,
    reviewState: queue.reviews.find(v => v.gym === gym && v.sourceId === r.sourceId && v.sourceVersion === r.sourceVersion)?.decision || 'received',
    relatedSourceIdsJson: JSON.stringify([...new Set(sources.filter(s => s.eventId === r.eventId && s.sourceId !== r.sourceId).map(s => s.sourceId))].sort()) }));
  const episodeRows = episodes.map(e => row(HEALTH_HEADERS, { rowType: 'episode', gym, generation, ...e }));
  const overview = row(HEALTH_HEADERS, { rowType: 'current', gym, code: queue.health.code,
    checkedAt: queue.health.checkedAt, scanThrough: queue.health.scanThrough,
    routeFaultsJson: JSON.stringify(queue.routing.unresolvedFaults.filter(f => f.code !== 'sender-route-overflow')),
    routeOverflowJson: JSON.stringify(queue.routing.unresolvedFaults.filter(f => f.code === 'sender-route-overflow')),
    generation, projectedAt: now, replyRowCount: rows.length, replySnapshotHash: digestHash(rows),
    episodeRowCount: episodeRows.length, episodeSnapshotHash: digestHash(episodeRows),
    sourceRevision: digestHash([sources, queue.reviews, episodes, queue.health, queue.routing.unresolvedFaults]), projectionStatus: 'ready' });
  return { schema: PROJECTION_SCHEMA, gym, generation, projectionFaultAccepted, tabs: projectionTabs(gym), replyHeaders: REPLY_HEADERS,
    healthHeaders: HEALTH_HEADERS, receiptHeaders: RECEIPT_HEADERS, replies: rows, health: [overview, ...episodeRows],
    intakeCadenceHours: 1, parentCadenceHours: 6, attendanceWritesEnabled: false, payrollReleaseEnabled: false };
}

const normalizedRows = (rows, width) => rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
// Used by the parent after a bounded health -> replies -> health read. Sheet
// data cannot authorize a write or supply an endpoint, recipient or instruction.
export function verifyReplyProjection({ gym, before, replies, after, receipts = [], now = Date.now() }) {
  const first = normalizedRows(before, HEALTH_HEADERS.length), last = normalizedRows(after, HEALTH_HEADERS.length);
  if (!first.length || JSON.stringify(first) !== JSON.stringify(last)) fail('REPLY_PROJECTION_CHANGED');
  const current = Object.fromEntries(HEALTH_HEADERS.map((key, i) => [key, first[0][i]]));
  if (current.rowType !== 'current' || current.gym !== gym || current.projectionStatus !== 'ready') fail('REPLY_PROJECTION_NOT_READY');
  if (!Number.isSafeInteger(current.projectedAt) || current.projectedAt > now + 60000 || now - current.projectedAt > 3 * 3600000) fail('REPLY_PROJECTION_STALE');
  const rows = normalizedRows(replies, REPLY_HEADERS.length), episodes = first.slice(1);
  if (rows.length > PROJECTION_LIMIT || episodes.length > PROJECTION_LIMIT || rows.length !== current.replyRowCount || episodes.length !== current.episodeRowCount
    || digestHash(rows) !== current.replySnapshotHash || digestHash(episodes) !== current.episodeSnapshotHash) fail('REPLY_PROJECTION_INCOMPLETE');
  for (const [records, headers] of [[rows, REPLY_HEADERS], [first, HEALTH_HEADERS]]) for (const cells of records) {
    if (cells[headers.indexOf('gym')] !== gym || cells[headers.indexOf('generation')] !== current.generation
      || digestHash(cells.slice(0, -1)) !== cells.at(-1)) fail('REPLY_PROJECTION_HASH');
  }
  const delivered = new Set(receipts.filter(r => r[0] === gym && ['reply', 'health'].includes(r[1])
    && Number.isSafeInteger(r[4]) && r[4] <= now && typeof r[5] === 'string' && r[5].trim()).map(r => r.slice(0, 4).join(':')));
  const unseen = rows.filter(r => !delivered.has([gym, 'reply', r[1], r[2]].join(':')));
  const unseenEpisodes = episodes.filter(r => !delivered.has([gym, 'health', r[15], r[20]].join(':')));
  const health = !current.checkedAt || now - current.checkedAt > 3 * 3600000 ? 'poll-overdue'
    : !current.scanThrough || now - current.scanThrough > 24 * 3600000 ? 'poll-backlog' : current.code;
  return { gym, generation: current.generation, health, unseenReplies: unseen, unseenEpisodes,
    attendanceWritesEnabled: false, payrollReleaseEnabled: false };
}
