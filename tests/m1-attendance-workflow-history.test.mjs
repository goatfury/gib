import assert from 'node:assert/strict';
import test from 'node:test';
import { changeHistoryMessage, migrateHistory, historyRoot, historyPage, historyGroup, historyRoundRobin,
  supersedeHistoryDrafts, queueHistoryWake, historyWakePending, drainHistoryWakes } from '../netlify/functions/_lib/m1-attendance-workflow-history.mjs';

function fixture() {
  const values = new Map(); let serial = 0, reads = 0, writes = 0;
  const store = { async getWithMetadata(key) { reads++; return structuredClone(values.get(key) || null); },
    async set(key, raw, options) {
      writes++; const old = values.get(key);
      if (options.onlyIfNew && old || options.onlyIfMatch && old?.etag !== options.onlyIfMatch) return { modified: false };
      const etag = String(++serial); values.set(key, { etag, data: JSON.parse(raw) }); return { modified: true, etag };
    } };
  const project = async entry => ({ messageId: entry.data.messageId, gym: 'rev', date: entry.data.date, sourceEtag: entry.etag,
    groups: entry.data.groups || [], unattempted: entry.data.unattempted === true, checkAt: entry.data.checkAt,
    counts: { failed: 0, unconfirmed: Number(!entry.data.unattempted && entry.data.uncertain === true), pending: Number(entry.data.unattempted === true), configuration: Number(entry.data.unattempted === true) } });
  const body = (number, patch = {}) => { const date = new Date(Date.UTC(2026, 0, 1 + number)).toISOString().slice(0, 10);
    return { messageId: 'm1-test-scheduled-rev-' + date, date, checkAt: number + 1, unattempted: false, ...patch }; };
  return { store, values, project, body, async add(number, patch) { const value = body(number, patch); return changeHistoryMessage(store, value.messageId, { etag: null, value }, project); },
    reset() { reads = 0; writes = 0; }, stats() { return { reads, writes }; } };
}

test('legacy batches resume an interrupted journal, then retain more than256 originals with bounded group and page reads', async () => {
  const h = fixture(), ids = [];
  for (let index = 0; index < 256; index++) {
    const value = h.body(index, index === 0 ? { uncertain: true, groups: ['unknown/rev', 'provider/original'] } : {});
    ids.push(value.messageId); await h.store.set('workflow/messages/' + value.messageId, JSON.stringify(value), { onlyIfNew: true });
  }
  await h.store.set('workflow/index', JSON.stringify({ ids }), { onlyIfNew: true });
  const originals = structuredClone([...h.values].filter(([key]) => key.startsWith('workflow/messages/')));
  const set = h.store.set; let fail = true;
  h.store.set = async (key, ...args) => { if (fail && key.startsWith('workflow/history/months/')) { fail = false; throw new Error('synthetic interruption'); } return set(key, ...args); };
  await assert.rejects(() => migrateHistory(h.store, h.project), /interruption/);
  await assert.rejects(() => historyRoot(h.store), /TRANSITION_PENDING/);
  let result; for (let batch = 0; batch < 17; batch++) { result = await migrateHistory(h.store, h.project); if (result.complete) break; }
  assert.equal(result.complete, true); assert.equal(result.cursor, 256);
  assert.deepEqual([...h.values].filter(([key]) => key.startsWith('workflow/messages/')), originals);
  h.reset(); await historyGroup(h.store, 'provider/original'); const oldReads = h.stats().reads;
  for (let index = 256; index < 300; index++) await h.add(index);
  h.reset(); const located = await historyGroup(h.store, 'provider/original'); assert.deepEqual(located.ids, [ids[0]]); assert.equal(h.stats().reads, oldReads);
  h.reset(); const root = await historyRoot(h.store); assert.equal(h.stats().reads, 1); assert.equal(root.data.counts.rev.unconfirmed, 1);
  const overview = await historyPage(h.store); assert.equal(overview.ids.length, 8);
  let cursor = overview.nextCursor; const preserved = new Set();
  while (cursor) { h.reset(); const page = await historyPage(h.store, cursor); assert.ok(page.ids.length <= 32); assert.ok(h.stats().reads <= 2); page.ids.forEach(id => preserved.add(id)); cursor = page.nextCursor; }
  assert.equal(preserved.size, 300); assert.deepEqual(h.values.get('workflow/index').data.ids, ids, 'legacy evidence is retained');
});

test('a fresh complete-check watermark supersedes all archived unsent warnings without deleting sources or double-subtracting counts', async () => {
  const h = fixture();
  for (let index = 0; index < 40; index++) await h.add(index, { unattempted: true, groups: ['draft/rev'] });
  assert.equal((await historyRoot(h.store)).data.counts.rev.pending, 40);
  const original = structuredClone(h.values.get('workflow/messages/' + h.body(0).messageId));
  await supersedeHistoryDrafts(h.store, 'rev', 100);
  assert.equal((await historyRoot(h.store)).data.counts.rev.pending, 0);
  assert.equal((await historyRoot(h.store)).data.counts.rev.configuration, 0);
  assert.deepEqual(h.values.get('workflow/messages/' + h.body(0).messageId), original);
  await changeHistoryMessage(h.store, h.body(0).messageId, null, h.project);
  assert.equal((await historyRoot(h.store)).data.counts.rev.pending, 0);
  await h.add(40, { checkAt: 101, unattempted: true, groups: ['draft/rev'] });
  assert.equal((await historyRoot(h.store)).data.counts.rev.pending, 1);
});

test('retry maintenance advances through bounded pages and a changed generation cannot reuse an old first-send clearance', async () => {
  const h = fixture();
  for (let index = 0; index < 20; index++) await h.add(index, { uncertain: true, groups: ['retry/rev'] });
  const seen = new Set();
  for (let pass = 0; pass < 3; pass++) { const page = await historyRoundRobin(h.store, 'retry/rev'); assert.ok(page.ids.length <= 8); page.ids.forEach(id => seen.add(id)); }
  assert.equal(seen.size, 20);
  const prepared = await h.add(21), epoch = (await historyRoot(h.store)).data.epoch;
  await h.add(22, { groups: ['bounce/rev/permanent'] });
  const rejected = await changeHistoryMessage(h.store, prepared.data.messageId, { etag: prepared.etag, value: { ...prepared.data, firstAttemptAt: 123 }, requiresNoWake: true, guardEpoch: epoch }, h.project);
  assert.equal(rejected.modified, false); assert.equal(rejected.data.firstAttemptAt, undefined);
});

test('queued evidence survives interruption and is not removed before its complete owned transition finishes', async () => {
  const h = fixture(), original = await h.add(0), event = { eventId: 'isolated_signed_fixture' };
  await queueHistoryWake(h.store, original.data.messageId, event);
  await assert.rejects(() => drainHistoryWakes(h.store, async () => { throw new Error('synthetic interrupted event write'); }), /interrupted/);
  assert.equal(await historyWakePending(h.store), true);
  const applied = [];
  await drainHistoryWakes(h.store, async node => { applied.push(node); assert.equal(await historyWakePending(h.store), true); });
  assert.equal(applied.length, 1); assert.deepEqual(applied[0].event, event); assert.equal(await historyWakePending(h.store), false);
  assert.deepEqual(h.values.get('workflow/messages/' + original.data.messageId).data, original.data);
});
