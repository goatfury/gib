import { createHash } from 'node:crypto';
import core from '../../../m1/temporary-classes-core.js';

export const ADDED_CLASSES_STORE = 'gib-m1-added-classes-test-v1';
export const ADDED_CLASSES_PRODUCTION_STORE = 'gib-m1-added-classes-production-v1';
export function addedClassesStoreName(target = 'test') {
  if (!['test', 'production'].includes(target)) throw new Error('Invalid class storage target.');
  return target === 'production' ? ADDED_CLASSES_PRODUCTION_STORE : ADDED_CLASSES_STORE;
}
export const addedClassesKey = (gymId, target = 'test') => {
  addedClassesStoreName(target);
  if (!['rev', 'richmond'].includes(gymId)) throw new Error('Invalid gym.');
  return `${target}/${gymId}/classes-v1`;
};
export class AddedClassesError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AddedClassesError(status, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
export async function defaultAddedClassesStore(target = 'test') {
  const name = addedClassesStoreName(target);
  const { getStore } = await import('@netlify/blobs');
  // TEST previews and production share a Netlify site for Revolution. Separate
  // both store and key; the verified runtime scope supplies target and gym.
  return getStore({ name, consistency: 'strong' });
}
export function emptyAddedClasses(gymId, target = 'test') {
  addedClassesKey(gymId, target);
  return { schema: core.SCHEMA, target, gymId, timezone: core.TIME_ZONE, version: 0, updatedAt: null, series: [], history: [], aliases: {}, audit: [] };
}
export function publicAddedClasses(value, now) {
  return {
    ok: true, schema: core.SCHEMA, target: value.target, gymId: value.gymId,
    timezone: core.TIME_ZONE, version: value.version, updatedAt: value.updatedAt,
    servedAt: new Date(now).toISOString(), current: true,
    series: value.series, history: value.history,
    importedIdentities: Object.keys(value.aliases).sort()
  };
}
export async function readAddedClasses(store, gymId, now, target = 'test') {
  const result = await store.getWithMetadata(addedClassesKey(gymId, target), { type: 'json', consistency: 'strong' });
  if (!result) return { value: emptyAddedClasses(gymId, target), etag: null };
  const value = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
  if (!result.etag || !value || value.schema !== core.SCHEMA || value.target !== target || value.timezone !== core.TIME_ZONE || !value.aliases || Array.isArray(value.aliases) || !Array.isArray(value.audit)
    || value.audit.length > 5000 || !core.validateDocument(publicAddedClasses(value, now), gymId, target)
    || Object.values(value.aliases).some(id => !value.series.some(series => series.id === id))) {
    throw new Error('The centrally saved classes could not be validated.');
  }
  return { value, etag: result.etag };
}
function seriesInput(raw) {
  const value = core.normalizeSeries({ ...raw, id: '' });
  if (!value) fail(400, 'Use a class name, valid start time, and matching dates within one year.');
  return value;
}
function normalizeMutation(input, today) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/u.test(input.requestId)
    || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) fail(400, 'A new request ID and current class version are required.');
  const actions = { create: ['series'], import: ['series'], update: ['seriesId', 'series', 'effectiveDate'], cancel: ['seriesId', 'effectiveDate', 'date'] };
  const allowed = typeof input.action === 'string' && Object.hasOwn(actions, input.action) ? actions[input.action] : null;
  if (!allowed || Object.keys(input).some(key => !['action', 'requestId', 'expectedVersion', ...allowed].includes(key))) fail(400, 'The class change is not supported.');
  const result = { action: input.action, requestId: input.requestId, expectedVersion: input.expectedVersion };
  if (input.action === 'create') result.series = [seriesInput(input.series)];
  if (input.action === 'import') {
    if (!Array.isArray(input.series) || input.series.length < 1 || input.series.length > 50) fail(400, 'Import between 1 and 50 existing temporary classes at a time.');
    result.series = input.series.map(seriesInput);
  }
  if (input.action === 'update' || input.action === 'cancel') {
    if (!/^added_[a-f0-9]{32}$/u.test(input.seriesId || '')) fail(400, 'Choose an existing added class.');
    result.seriesId = input.seriesId;
    const effectiveDate = input.date || input.effectiveDate || today;
    if (!core.validDate(effectiveDate) || (input.date && input.effectiveDate)) fail(400, 'Changes can begin today or on a future date. Past class history is preserved.');
    result.effectiveDate = effectiveDate;
    result.requestedEffectiveDate = input.date || input.effectiveDate || '';
    if (input.action === 'update') result.series = seriesInput(input.series);
    if (input.action === 'cancel' && input.date) result.date = input.date;
  }
  return result;
}
function appendRevision(document, series, fromDate, toDate = null) {
  document.version += 1;
  document.history.push({ seriesId: series.id, revision: document.version, fromDate, toDate, series: structuredClone(series) });
  const index = document.series.findIndex(item => item.id === series.id);
  if (index < 0) document.series.push(series);
  else document.series[index] = series;
  document.aliases[core.seriesIdentity(series)] = series.id;
}
function planMutation(existing, mutation, now, adminName) {
  const { expectedVersion, requestId, ...logicalMutation } = mutation;
  // A retry after midnight still represents the original request. Compare its
  // submitted date, not the server's newly calculated default for "today".
  const fingerprint = hash(JSON.stringify({ ...logicalMutation, ...(logicalMutation.effectiveDate ? { effectiveDate: logicalMutation.requestedEffectiveDate } : {}) }));
  const receipt = existing.audit.find(item => item.requestId === requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different class change.');
    return { value: existing, result: receipt.result, seriesIds: receipt.seriesIds, retry: true };
  }
  if (existing.version !== expectedVersion) fail(409, 'Classes changed in another browser. Refresh before saving again.');
  if (mutation.effectiveDate && mutation.effectiveDate < core.todayInGym(now)) fail(400, 'Changes can begin today or on a future date. Past class history is preserved.');
  if (existing.audit.length >= 5000) fail(409, 'The class history is full. No saved history was removed.');
  const next = structuredClone(existing);
  let result;
  const seriesIds = [];
  if (mutation.action === 'create' || mutation.action === 'import') {
    let created = 0;
    for (const item of mutation.series) {
      const identity = core.seriesIdentity(item);
      const match = next.aliases[identity] || next.series.find(series => core.seriesIdentity(series) === identity)?.id;
      if (match) { seriesIds.push(match); continue; }
      const id = `added_${hash(`${next.gymId}\0${identity}`).slice(0, 32)}`;
      const series = { ...item, id };
      appendRevision(next, series, series.startDate);
      seriesIds.push(id);
      created += 1;
    }
    result = created ? (mutation.action === 'import' ? 'imported' : 'created') : 'duplicate';
  } else {
    const existingSeries = next.series.find(item => item.id === mutation.seriesId);
    if (!existingSeries) fail(404, 'This added class was not found.');
    // A newer revision may replace already planned future changes from today
    // (or its explicit future cutoff). The resolver chooses the newest eligible
    // revision; snapshots and date choices before that cutoff stay unchanged.
    let series;
    if (mutation.action === 'update') {
      series = { ...mutation.series, id: mutation.seriesId };
      const correctedDates = new Set(core.datesForSeries(series, { includeCancelled: true }));
      // Editing a name/time/range does not silently restore a separately
      // cancelled occurrence. Keep cancellations on dates still in the series.
      series.cancelledDates = [...new Set([...series.cancelledDates, ...existingSeries.cancelledDates])]
        .filter(date => correctedDates.has(date)).sort();
      if (series.endDate < mutation.effectiveDate) fail(400, 'The corrected class must include today or a future date.');
      const identityMatch = next.aliases[core.seriesIdentity(series)];
      if (identityMatch && identityMatch !== series.id) fail(409, 'That class already exists. Choose the existing class.');
      result = 'updated';
    } else if (mutation.date) {
      if (!core.datesForSeries(existingSeries, { from: mutation.date, to: mutation.date }).length) fail(400, 'Choose a scheduled, uncancelled occurrence.');
      series = { ...existingSeries, cancelledDates: [...new Set([...existingSeries.cancelledDates, mutation.date])].sort() };
      result = 'cancelled';
    } else {
      if (existingSeries.endDate < mutation.effectiveDate) fail(400, 'There are no upcoming dates to cancel.');
      series = { ...existingSeries, enabled: false };
      result = 'cancelled';
    }
    // Cancelling one date overrides only that occurrence. It cannot move an
    // independently planned name/time change onto earlier or later dates.
    appendRevision(next, series, mutation.effectiveDate, mutation.date || null);
    seriesIds.push(series.id);
  }
  if (next.version === existing.version) next.version += 1;
  next.updatedAt = new Date(now).toISOString();
  next.audit.push({ requestId, fingerprint, action: mutation.action, result, seriesIds, version: next.version, changedAt: next.updatedAt, adminName });
  // Do not acknowledge a mutation that would make the shared snapshot too large
  // for its existing browser cache/read contract. Never prune past occurrences.
  if (next.series.length > 500 || next.history.length > 5000
    || Buffer.byteLength(JSON.stringify(publicAddedClasses(next, now)), 'utf8') > 1800000) fail(409, 'The class history is full. No saved history was removed.');
  return { value: next, result, seriesIds, retry: false };
}
export async function mutateAddedClasses(store, gymId, input, now, adminName, target = 'test') {
  const mutation = normalizeMutation(input, core.todayInGym(now));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await readAddedClasses(store, gymId, now, target);
    const planned = planMutation(previous.value, mutation, now, adminName);
    if (planned.retry) return planned;
    const saved = await store.set(addedClassesKey(gymId, target), JSON.stringify(planned.value), previous.etag ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
    if (saved?.modified === true) return planned;
    if (saved?.modified !== false) throw new Error('The central class save was not confirmed.');
  }
  fail(409, 'Classes changed in another browser. Refresh before saving again.');
}
