import { randomUUID } from 'node:crypto';
import { digestHash, digestDate } from './m1-attendance-digest.mjs';

const PREFIX = 'workflow/history/', ROOT = PREFIX + 'root', SCHEMA = 'm1-workflow-history/v2';
const ID = /^m1-(?:test|production)-scheduled-(rev|richmond)-(\d{4}-\d{2}-\d{2})$/;
export const HISTORY_BATCH = 16, HISTORY_RECENT = 8, HISTORY_PAGE = 32;
const zero = () => ({ failed: 0, unconfirmed: 0, pending: 0, configuration: 0 });
const fail = () => { throw new Error('WORKFLOW_HISTORY_UNAVAILABLE'); };
async function read(store, key) {
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (entry && (!entry.data || typeof entry.etag !== 'string' || !entry.etag)) fail();
  return entry || null;
}
async function put(store, key, value, before) {
  const result = await store.set(key, JSON.stringify(value), before ? { onlyIfMatch: before.etag } : { onlyIfNew: true });
  const saved = await read(store, key);
  if (![true, false].includes(result?.modified) || !saved || result.modified && digestHash(saved.data) !== digestHash(value)) fail();
  return { ...saved, modified: result.modified };
}
function validateRoot(root) {
  if (!root || root.schema !== SCHEMA || !Number.isSafeInteger(root.epoch) || root.epoch < 0 || !Array.isArray(root.recent) || root.recent.length > HISTORY_RECENT
    || root.recent.some(id => !ID.test(id)) || !root.migration || !Number.isSafeInteger(root.migration.cursor) || !Number.isSafeInteger(root.migration.total)
    || root.migration.cursor < 0 || root.migration.cursor > root.migration.total || root.migration.total > 256) fail();
  for (const gym of ['rev', 'richmond']) if (!root.counts?.[gym] || Object.keys(zero()).some(key => !Number.isSafeInteger(root.counts[gym][key]) || root.counts[gym][key] < 0)) fail();
  return root;
}
export async function historyRoot(store, { initialize = false, incomplete = false } = {}) {
  let root = await read(store, ROOT);
  if (!root && initialize) {
    const legacy = await read(store, 'workflow/index'), ids = legacy?.data.ids || [];
    if (!Array.isArray(ids) || ids.length > 256 || new Set(ids).size !== ids.length || ids.some(id => !ID.test(id))) fail();
    root = await put(store, ROOT, { schema: SCHEMA, epoch: 0, pending: null, recent: [], counts: { rev: zero(), richmond: zero() }, firstMonth: null, lastMonth: null,
      drafts: { rev: { epoch: 0, through: 0 }, richmond: { epoch: 0, through: 0 } },
      migration: { hash: digestHash(ids), cursor: 0, total: ids.length, complete: ids.length === 0 } }, null);
  }
  if (!root) {
    if (await read(store, 'workflow/index')) throw new Error('WORKFLOW_HISTORY_MIGRATION_PENDING');
    return null;
  }
  validateRoot(root.data);
  if (!incomplete && (!root.data.migration.complete || root.data.pending)) throw new Error(root.data.pending ? 'WORKFLOW_HISTORY_TRANSITION_PENDING' : 'WORKFLOW_HISTORY_MIGRATION_PENDING');
  return root;
}
const projectionKey = id => PREFIX + 'messages/' + id;
const groupKey = name => PREFIX + 'groups/' + digestHash(name);

async function makePlan(store, base, intent, project) {
  const source = await read(store, 'workflow/messages/' + intent.messageId);
  if (!source) fail();
  const nextProjection = await project(source), old = await read(store, projectionKey(intent.messageId));
  if (nextProjection.messageId !== intent.messageId || !ID.test(nextProjection.messageId) || !Array.isArray(nextProjection.groups) || nextProjection.groups.length > 10) fail();
  const draftFence = base.drafts[nextProjection.gym];
  nextProjection.draftEpoch = draftFence.epoch;
  if (nextProjection.unattempted && nextProjection.checkAt < draftFence.through) { nextProjection.counts.pending = 0; nextProjection.counts.configuration = 0; }
  const oldCounts = { ...(old?.data.counts || zero()) };
  if (old?.data.unattempted && old.data.draftEpoch !== draftFence.epoch) { oldCounts.pending = 0; oldCounts.configuration = 0; }
  const staged = new Map();
  async function cell(key) {
    if (!staged.has(key)) staged.set(key, { before: await read(store, key), value: undefined });
    const item = staged.get(key); return item.value === undefined ? item.before?.data : item.value;
  }
  async function set(key, value) { await cell(key); staged.get(key).value = value; }
  for (const name of old?.data.groups || []) {
    if (nextProjection.groups.includes(name)) continue;
    const group = groupKey(name), head = await cell(group + '/head'), linkKey = group + '/links/' + intent.messageId, link = await cell(linkKey);
    if (!head || head.count < 1 || !link?.active) fail();
    if (link.prev) { const key = group + '/links/' + link.prev, neighbor = await cell(key); if (!neighbor?.active || neighbor.next !== intent.messageId) fail(); await set(key, { ...neighbor, next: link.next }); }
    if (link.next) { const key = group + '/links/' + link.next, neighbor = await cell(key); if (!neighbor?.active || neighbor.prev !== intent.messageId) fail(); await set(key, { ...neighbor, prev: link.prev }); }
    await set(group + '/head', { name, count: head.count - 1, id: head.id === intent.messageId ? link.next : head.id });
    await set(linkKey, { ...link, active: false });
  }
  for (const name of nextProjection.groups) {
    if (old?.data.groups?.includes(name)) continue;
    const group = groupKey(name), head = await cell(group + '/head');
    if (head && (head.name !== name || !Number.isSafeInteger(head.count) || head.count < 0)) fail();
    if (head?.id) { const key = group + '/links/' + head.id, neighbor = await cell(key); if (!neighbor?.active || neighbor.prev !== null) fail(); await set(key, { ...neighbor, prev: intent.messageId }); }
    await set(group + '/links/' + intent.messageId, { active: true, prev: null, next: head?.id || null });
    await set(group + '/head', { name, count: (head?.count || 0) + 1, id: intent.messageId });
  }
  await set(projectionKey(intent.messageId), nextProjection);
  const month = nextProjection.date.slice(0, 7), monthKey = PREFIX + 'months/' + month, bucket = await cell(monthKey), ids = bucket?.ids || [];
  if (!Array.isArray(ids) || ids.length > 62 || ids.some(id => !ID.test(id) || id.slice(-10, -3) !== month)) fail();
  if (!ids.includes(intent.messageId)) await set(monthKey, { ids: [...ids, intent.messageId].sort() });
  const next = structuredClone(base);
  next.epoch++; next.pending = null;
  for (const field of Object.keys(zero())) next.counts[nextProjection.gym][field] += nextProjection.counts[field] - oldCounts[field];
  next.recent = [...new Set([...next.recent, intent.messageId])].sort((a, b) => b.slice(-10).localeCompare(a.slice(-10)) || a.localeCompare(b)).slice(0, HISTORY_RECENT);
  next.firstMonth = next.firstMonth && next.firstMonth < month ? next.firstMonth : month;
  next.lastMonth = next.lastMonth && next.lastMonth > month ? next.lastMonth : month;
  if (intent.migrationCursor !== undefined) { next.migration.cursor = intent.migrationCursor; next.migration.complete = next.migration.cursor === next.migration.total; }
  validateRoot(next);
  return { schema: SCHEMA, intentId: intent.id, baseEpoch: base.epoch, next,
    operations: [...staged.entries()].filter(([, item]) => item.value !== undefined).map(([key, item]) => ({ key, etag: item.before?.etag || null, value: item.value })) };
}

// One published intent fences all aggregate/index changes. Original blobs are
// retained; a failed invocation is completed from this exact intent on recovery.
export async function recoverHistory(store, project, clock = Date.now) {
  const root = await historyRoot(store, { initialize: true, incomplete: true });
  if (!root.data.pending) return root;
  const intent = (await read(store, PREFIX + 'intents/' + root.data.pending))?.data;
  if (!intent || intent.id !== root.data.pending || intent.baseEpoch !== root.data.epoch || !ID.test(intent.messageId)) fail();
  if (intent.source) {
    const resultKey = PREFIX + 'source-results/' + intent.id;
    if (!await read(store, resultKey)) {
      const key = 'workflow/messages/' + intent.messageId, current = await read(store, key);
      const wakeBlocked = intent.source.requiresNoWake && await historyWakePending(store);
      let leaseBlocked = false;
      if (intent.source.processorLease) {
        try { await requireHistoryProcessor(store, intent.source.processorLease, clock); } catch { leaseBlocked = true; }
      }
      const modified = !wakeBlocked && !leaseBlocked && (current?.etag || null) === intent.source.etag ? (await put(store, key, intent.source.value, current)).modified : false;
      await put(store, resultKey, { modified }, null);
    }
  }
  const planKey = PREFIX + 'plans/' + intent.id;
  let saved = await read(store, planKey);
  if (!saved) saved = await put(store, planKey, await makePlan(store, root.data, intent, project), null);
  const plan = saved.data;
  if (plan.intentId !== intent.id || plan.baseEpoch !== root.data.epoch || !Array.isArray(plan.operations) || plan.operations.length > 50) fail();
  for (const operation of plan.operations) {
    const fence = await historyRoot(store, { incomplete: true });
    if (fence.data.epoch > plan.baseEpoch) return fence;
    if (fence.data.pending !== intent.id) fail();
    const current = await read(store, operation.key);
    if (current && digestHash(current.data) === digestHash(operation.value)) continue;
    if ((current?.etag || null) !== operation.etag) {
      const advanced = await historyRoot(store, { incomplete: true });
      if (advanced.data.epoch > plan.baseEpoch) return advanced;
      fail();
    }
    const written = await put(store, operation.key, operation.value, current);
    if (digestHash(written.data) !== digestHash(operation.value)) fail();
  }
  const currentRoot = await historyRoot(store, { incomplete: true });
  if (currentRoot.data.pending === intent.id && currentRoot.data.epoch === plan.baseEpoch) {
    const committed = await put(store, ROOT, plan.next, currentRoot);
    if (committed.data.epoch < plan.next.epoch) fail();
  }
  return historyRoot(store, { incomplete: true });
}
export async function changeHistoryMessage(store, messageId, source, project, migrationCursor, clock = Date.now) {
  if (!ID.test(messageId)) fail();
  for (let attempt = 0; attempt < 3; attempt++) {
    const root = await recoverHistory(store, project, clock);
    if (!root.data.migration.complete && migrationCursor === undefined) throw new Error('WORKFLOW_HISTORY_MIGRATION_PENDING');
    if (source?.requiresNoWake && (source.guardEpoch !== root.data.epoch || await historyWakePending(store))) return { ...(await read(store, 'workflow/messages/' + messageId)), modified: false };
    const intent = { id: randomUUID(), baseEpoch: root.data.epoch, messageId, source, ...(migrationCursor === undefined ? {} : { migrationCursor }) };
    await put(store, PREFIX + 'intents/' + intent.id, intent, null);
    const claimed = await put(store, ROOT, { ...root.data, pending: intent.id }, root);
    if (!claimed.modified) continue;
    await recoverHistory(store, project, clock);
    const actual = await read(store, 'workflow/messages/' + messageId);
    const outcome = source ? await read(store, PREFIX + 'source-results/' + intent.id) : null;
    return { ...actual, modified: Boolean(outcome?.data.modified && digestHash(actual.data) === digestHash(source.value)) };
  }
  throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
}
export async function migrateHistory(store, project) {
  let root = await recoverHistory(store, project);
  if (root.data.migration.complete) return { complete: true, cursor: root.data.migration.cursor, total: root.data.migration.total };
  const legacy = (await read(store, 'workflow/index'))?.data.ids;
  if (!Array.isArray(legacy) || digestHash(legacy) !== root.data.migration.hash) fail();
  const limit = Math.min(root.data.migration.total, root.data.migration.cursor + HISTORY_BATCH);
  while (root.data.migration.cursor < limit) {
    await changeHistoryMessage(store, legacy[root.data.migration.cursor], null, project, root.data.migration.cursor + 1);
    root = await historyRoot(store, { incomplete: true });
  }
  return { complete: root.data.migration.complete, cursor: root.data.migration.cursor, total: root.data.migration.total };
}
export async function supersedeHistoryDrafts(store, gym, through) {
  if (!['rev', 'richmond'].includes(gym) || !Number.isSafeInteger(through)) fail();
  for (let attempt = 0; attempt < 3; attempt++) {
    const root = await historyRoot(store);
    if (root.data.drafts[gym].through >= through) return;
    const next = structuredClone(root.data); next.epoch++;
    next.drafts[gym] = { epoch: next.drafts[gym].epoch + 1, through };
    next.counts[gym].pending = 0; next.counts[gym].configuration = 0;
    if ((await put(store, ROOT, next, root)).modified) return;
  }
  throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
}
export async function historyGroup(store, name, limit = 8) {
  const root = await historyRoot(store);
  const group = groupKey(name), head = await read(store, group + '/head');
  if (!head) return { ids: [], count: 0 };
  if (head.data.name !== name || !Number.isSafeInteger(head.data.count) || head.data.count < 0 || Boolean(head.data.id) !== Boolean(head.data.count)) fail();
  const ids = []; let id = head.data.id, previous = null;
  while (id && ids.length < limit) {
    if (!ID.test(id) || ids.includes(id)) fail();
    const link = (await read(store, group + '/links/' + id))?.data;
    if (!link?.active || link.prev !== previous) fail();
    ids.push(id); previous = id; id = link.next;
  }
  if ((await historyRoot(store))?.etag !== root?.etag) throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
  return { ids, count: head.data.count };
}
export async function historyRoundRobin(store, name, limit = 8) {
  const root = await historyRoot(store), group = groupKey(name), head = await read(store, group + '/head');
  if (!head?.data.count) return { ids: [], count: 0 };
  const cursorKey = group + '/cursor', cursor = await read(store, cursorKey);
  let id = cursor?.data.id || head.data.id;
  if (id && !(await read(store, group + '/links/' + id))?.data.active) id = head.data.id;
  const ids = [];
  while (id && ids.length < limit) {
    if (!ID.test(id) || ids.includes(id)) fail();
    const link = (await read(store, group + '/links/' + id))?.data;
    if (!link?.active) fail();
    ids.push(id); id = link.next;
  }
  if ((await historyRoot(store))?.etag !== root.etag) throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
  await put(store, cursorKey, { id: id || head.data.id }, cursor);
  return { ids, count: head.data.count };
}
export async function historyPage(store, cursor) {
  const root = await historyRoot(store);
  if (!root) return { ids: [], nextCursor: null };
  if (cursor === undefined) return { ids: [...root.data.recent].sort((a, b) => a.slice(-10).localeCompare(b.slice(-10)) || a.localeCompare(b)), nextCursor: root.data.lastMonth ? root.data.lastMonth + ':0' : null };
  if (!/^\d{4}-\d{2}:\d{1,2}$/.test(cursor)) fail();
  const [month, offsetText] = cursor.split(':'), offset = Number(offsetText);
  if (offset >= 62 || month < root.data.firstMonth || month > root.data.lastMonth) fail();
  const ids = (await read(store, PREFIX + 'months/' + month))?.data.ids || [];
  if (!Array.isArray(ids) || ids.length > 62 || ids.some(id => !ID.test(id) || id.slice(-10, -3) !== month)) fail();
  const ordered = [...ids].sort((a, b) => b.slice(-10).localeCompare(a.slice(-10)) || a.localeCompare(b));
  const previous = new Date(month + '-01T00:00:00Z'); previous.setUTCMonth(previous.getUTCMonth() - 1);
  const priorMonth = previous.toISOString().slice(0, 7);
  return { ids: ordered.slice(offset, offset + HISTORY_PAGE), nextCursor: offset + HISTORY_PAGE < ids.length ? month + ':' + (offset + HISTORY_PAGE) : priorMonth >= root.data.firstMonth ? priorMonth + ':0' : null };
}

export async function queueHistoryWake(store, messageId, event) {
  if (messageId !== null && !ID.test(messageId)) fail();
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await read(store, PREFIX + 'wake'), id = randomUUID();
    await put(store, PREFIX + 'wakes/' + id, { id, messageId, event, next: before?.data.id || null }, null);
    if ((await put(store, PREFIX + 'wake', { id }, before)).modified) return;
  }
  fail();
}
export async function historyWakePending(store) { return Boolean((await read(store, PREFIX + 'wake'))?.data.id); }
export async function advanceHistoryGeneration(store) {
  for (let count = 0; count < 3; count++) {
    const root = await historyRoot(store);
    if ((await put(store, ROOT, { ...root.data, epoch: root.data.epoch + 1 }, root)).modified) return;
  }
  throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
}
export async function drainHistoryWakes(store, apply, limit = 8) {
  for (let count = 0; count < limit; count++) {
    const head = await read(store, PREFIX + 'wake'); if (!head?.data.id) return true;
    const node = (await read(store, PREFIX + 'wakes/' + head.data.id))?.data;
    if (!node || node.id !== head.data.id || node.messageId !== null && !ID.test(node.messageId)) fail();
    await apply(node);
    await put(store, PREFIX + 'wake', { id: node.next }, head);
  }
  return !await historyWakePending(store);
}

const opportunityKey = gym => 'workflow/opportunities/' + gym;
export async function readHistoryOpportunity(store, gym) {
  if (!['rev', 'richmond'].includes(gym)) fail();
  const entry = await read(store, opportunityKey(gym));
  if (entry && (entry.data.schema !== 'm1-workflow-opportunity/v1' || entry.data.gym !== gym
    || !digestDate(entry.data.opportunityDate) || !digestDate(entry.data.assessmentDate) || entry.data.opportunityDate > entry.data.assessmentDate
    || !['test', 'production'].some(target => entry.data.messageId === 'm1-' + target + '-scheduled-' + gym + '-' + entry.data.opportunityDate)
    || !['open', 'clean', 'message'].includes(entry.data.decision) || !Number.isSafeInteger(entry.data.assessedAt)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.data.requestId) || !/^[a-f0-9]{64}$/.test(entry.data.digestHash))) fail();
  return entry;
}
export async function requireHistoryProcessor(store, lease, clock) {
  const retained = await read(store, 'workflow/processor');
  if (!lease || retained?.data.owner !== lease.owner || retained.data.expiresAt !== lease.expiresAt || clock() >= lease.expiresAt) throw new Error('WORKFLOW_PROCESSOR_SUPERSEDED');
}
export async function claimHistoryOpportunity(store, value, lease, clock) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readHistoryOpportunity(store, value.gym);
    if (before && (before.data.opportunityDate > value.opportunityDate || before.data.opportunityDate === value.opportunityDate
      && (before.data.decision !== 'open' || before.data.assessedAt > value.assessedAt))) return before;
    if (before?.data.requestId === value.requestId && before.data.opportunityDate === value.opportunityDate) {
      if (before.data.digestHash !== value.digestHash) throw new Error('WORKFLOW_OPPORTUNITY_CONFLICT');
      return before;
    }
    await requireHistoryProcessor(store, lease, clock);
    const result = await put(store, opportunityKey(value.gym), { ...value, schema: 'm1-workflow-opportunity/v1', decision: 'open' }, before);
    if (result.modified) return result;
  }
  throw new Error('WORKFLOW_OPPORTUNITY_UNCONFIRMED');
}
export async function finishHistoryOpportunity(store, expected, decision, lease, clock) {
  if (!['clean', 'message'].includes(decision)) fail();
  const current = await readHistoryOpportunity(store, expected.data.gym);
  if (!current || current.etag !== expected.etag || current.data.decision !== 'open') return current;
  await requireHistoryProcessor(store, lease, clock);
  return put(store, opportunityKey(expected.data.gym), { ...current.data, decision }, current);
}
