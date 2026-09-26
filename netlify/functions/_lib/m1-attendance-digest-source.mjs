import { createHash } from 'node:crypto';
import { handleM1Schedule, REFRESH_INTERVAL_MS } from '../m1-schedule.mjs';
import { defaultAddedClassesStore, publicAddedClasses, readAddedClasses } from './m1-added-classes.mjs';
import { REVIEW_START, datePlus, localNow } from './m1-manager-review.mjs';
import temporary from '../../../m1/temporary-classes-core.js';

const SCHEMA = 'm1-digest-dated-schedule/v1';
const TIMEZONE = 'America/New_York';
const MAX_DATES = 3661;
const MAX_BYTES = 40000;
const LAST_DATE = datePlus(REVIEW_START, MAX_DATES - 1);
const keyFor = (gym, date) => `schedules/test/${gym}/${date}`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const identity = label => label.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const validLabel = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Only an unambiguous actual New York wall time can identify an occurrence.
// In particular, do not pick one side of the fall DST overlap or invent a
// spring-forward time. Existing payroll duration defaults are never read here.
function localInstant(date, time) {
  if (!temporary.validDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('SCHEDULE_TIME_UNAVAILABLE');
  const nominal = Date.parse(`${date}T${time}:00Z`), matches = [];
  for (const offset of [4, 5]) {
    const candidate = new Date(nominal + offset * 3600000), parts = localNow(candidate);
    if (parts.date === date && parts.minutes === +time.slice(0, 2) * 60 + +time.slice(3)) matches.push(candidate.toISOString());
  }
  if (matches.length !== 1) fail('SCHEDULE_TIME_UNAVAILABLE');
  return matches[0];
}
function labelStart(date, label) {
  const match = /^(0?[1-9]|1[0-2]):([0-5]\d)\s+(AM|PM)\b/i.exec(label);
  if (!match) fail('SCHEDULE_TIME_UNAVAILABLE');
  return localInstant(date, `${String(+match[1] % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0')}:${match[2]}`);
}
function normalizeBase(date, base) {
  if (!Array.isArray(base) || base.length > 100) fail('DATED_SCHEDULE_INVALID');
  const seen = new Set();
  return base.map(value => {
    const object = typeof value === 'string' ? { label: value, startAt: labelStart(date, value), endAt: null, cancelled: false } : value;
    if (!object || !validLabel(object.label) || !iso(object.startAt) || localNow(new Date(object.startAt)).date !== date
      || typeof object.cancelled !== 'boolean' || !Object.hasOwn(object, 'endAt')
      || Object.keys(object).some(key => !['label', 'startAt', 'endAt', 'cancelled'].includes(key))
      || (object.endAt !== null && (!iso(object.endAt) || Date.parse(object.endAt) <= Date.parse(object.startAt) || Date.parse(object.endAt) - Date.parse(object.startAt) > 86400000))
      || seen.has(identity(object.label))) fail('DATED_SCHEDULE_INVALID');
    const labelled = /^(0?[1-9]|1[0-2]):([0-5]\d)\s+(AM|PM)\b/i.exec(object.label);
    if (!labelled || localNow(new Date(object.startAt)).minutes !== (+labelled[1] % 12 + (labelled[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + +labelled[2]) fail('DATED_SCHEDULE_INVALID');
    seen.add(identity(object.label));
    return { label: object.label, startAt: object.startAt, endAt: object.endAt, cancelled: object.cancelled };
  }).sort((a, b) => a.startAt.localeCompare(b.startAt) || a.label.localeCompare(b.label));
}
function observation(gym, date, base, observedAt, sourceVersion, now) {
  if (!iso(observedAt) || Date.parse(observedAt) > now || localNow(new Date(observedAt)).date < date
    || typeof sourceVersion !== 'string' || !sourceVersion || sourceVersion.length > 160) fail('DATED_SCHEDULE_INVALID');
  const value = { schema: SCHEMA, target: 'test', gym, timezone: TIMEZONE, date, observedAt, sourceVersion, base: normalizeBase(date, base) };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('DATED_SCHEDULE_INVALID');
  return value;
}
function validateStored(value, gym, date, now) {
  if (!value || Object.keys(value).sort().join('|') !== ['schema', 'target', 'gym', 'timezone', 'date', 'observedAt', 'sourceVersion', 'base'].sort().join('|')
    || value.schema !== SCHEMA || value.target !== 'test' || value.gym !== gym || value.timezone !== TIMEZONE || value.date !== date) fail('SCHEDULE_STORAGE_UNAVAILABLE');
  const validated = observation(gym, date, value.base, value.observedAt, value.sourceVersion, now);
  if (JSON.stringify(validated) !== JSON.stringify(value)) fail('SCHEDULE_STORAGE_UNAVAILABLE');
  return validated;
}
async function readStored(store, gym, date, now) {
  const result = await store.getWithMetadata(keyFor(gym, date), { type: 'json', consistency: 'strong' });
  if (!result) return null;
  if (!result.etag || !result.data) fail('SCHEDULE_STORAGE_UNAVAILABLE');
  return { etag: result.etag, data: validateStored(result.data, gym, date, now) };
}
async function persist(store, gym, date, candidate, previous, now) {
  if (previous && previous.data.observedAt > candidate.observedAt) return previous.data;
  if (previous && previous.data.observedAt === candidate.observedAt) {
    if (digest(previous.data) !== digest(candidate)) fail('DATED_SCHEDULE_CONFLICT');
    return previous.data;
  }
  const saved = await store.set(keyFor(gym, date), JSON.stringify(candidate), previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
  if (![true, false].includes(saved?.modified)) fail('SCHEDULE_STORAGE_UNAVAILABLE');
  const confirmed = await readStored(store, gym, date, now);
  if (!confirmed || (saved.modified && digest(confirmed.data) !== digest(candidate))) fail('SCHEDULE_STORAGE_UNAVAILABLE');
  if (!saved.modified && (confirmed.data.observedAt < candidate.observedAt || (confirmed.data.observedAt === candidate.observedAt && digest(confirmed.data) !== digest(candidate)))) fail('DATED_SCHEDULE_CONFLICT');
  return confirmed.data;
}
async function currentSchedule(gym, now, dependencies) {
  let value;
  if (dependencies.loadCurrentSchedule) value = await dependencies.loadCurrentSchedule({ gym, now });
  else if (Object.hasOwn(dependencies, 'currentSchedule')) value = dependencies.currentSchedule;
  else {
    const origin = gym === 'rev' ? 'https://deploy-preview-89--gib-live.netlify.app' : 'https://gib-richmond-test.netlify.app';
    const response = await handleM1Schedule(new Request(origin + '/api/m1-schedule'), {
      ...dependencies.scheduleDependencies, deployContext: 'deploy-preview', published: false,
      installationId: gym, ...(gym === 'richmond' ? { environment: 'test' } : {}), now
    });
    if (!response.ok) fail('CURRENT_SCHEDULE_UNAVAILABLE');
    value = await response.json();
  }
  if (!value || value.site !== (gym === 'rev' ? 'Rev' : 'Richmond') || value.current !== true || value.fallback !== 'none' || value.timezone !== TIMEZONE || !iso(value.fetchedAt)
    || Date.parse(value.fetchedAt) > now || now - Date.parse(value.fetchedAt) > REFRESH_INTERVAL_MS
    || localNow(new Date(value.fetchedAt)).date !== localNow(new Date(now)).date
    || typeof value.version !== 'string' || !value.version || value.version.length > 160
    || !value.days || typeof value.days !== 'object' || Array.isArray(value.days)
    || (value.status && (value.status.current !== true || value.status.fallback !== 'none'))) fail('CURRENT_SCHEDULE_UNAVAILABLE');
  return value;
}
async function additions(gym, now, dependencies) {
  const store = dependencies.addedStore || await defaultAddedClassesStore('test');
  const read = await readAddedClasses(store, gym, now, 'test');
  const value = publicAddedClasses(read.value, now);
  if (!temporary.validateDocument(value, gym, 'test') || value.current !== true || (value.updatedAt && Date.parse(value.updatedAt) > now)) fail('ADDED_CLASSES_UNAVAILABLE');
  return value;
}
function occurrences(observed, added, closingTime, cutoffConfirmed) {
  const byLabel = new Map(observed.base.map(item => [identity(item.label), { ...item }]));
  const active = new Set(temporary.classesForDate({}, added, observed.date).map(identity));
  for (const series of temporary.resolvedSeriesForDate(added, observed.date)) {
    if (!temporary.datesForSeries(series, { from: observed.date, to: observed.date, includeCancelled: true }).length) continue;
    const label = temporary.classLabel(series), id = identity(label);
    // An added-series cancellation cannot cancel an independent regular class.
    if (!byLabel.has(id)) byLabel.set(id, { label, startAt: labelStart(observed.date, label), endAt: null, cancelled: !active.has(id) });
  }
  if (byLabel.size > 100) fail('DATED_SCHEDULE_INVALID');
  return [...byLabel.values()].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.label.localeCompare(b.label)).map(item => {
    if (item.cancelled || item.endAt !== null) return item;
    if (!cutoffConfirmed) fail('CLASS_FINISH_UNCONFIRMED');
    const finish = localInstant(observed.date, closingTime);
    if (Date.parse(finish) <= Date.parse(item.startAt)) fail('CLASS_FINISH_UNCONFIRMED');
    return { ...item, finishedAtCutoff: finish, finishBasis: 'confirmed-gym-close' };
  });
}

// One <=40KB observation per date/gym in the existing bounded manager cleanup
// domain (3661 dates). No rolling deletion can lose an unresolved historical
// date. Current additions always come from their separate authoritative store.
export async function loadDigestScheduleSnapshots({ gym, dates, now = Date.now(), store, closingTime = '22:00', cutoffConfirmed = false, reviewSnapshots = [] }, dependencies = {}) {
  now = now instanceof Date ? now.getTime() : now;
  if (!['rev', 'richmond'].includes(gym) || !Number.isFinite(now) || !store?.getWithMetadata || !store?.set
    || !Array.isArray(dates) || dates.length > MAX_DATES || new Set(dates).size !== dates.length
    || dates.some(date => !temporary.validDate(date) || date < REVIEW_START || date > LAST_DATE)
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(closingTime) || typeof cutoffConfirmed !== 'boolean'
    || !Array.isArray(reviewSnapshots) || reviewSnapshots.length > MAX_DATES) throw new Error('Invalid TEST digest schedule scope.');
  const today = localNow(new Date(now)).date;
  const [current, added] = await Promise.allSettled([
    dates.includes(today) ? currentSchedule(gym, now, dependencies) : Promise.resolve(null),
    additions(gym, now, dependencies)
  ]);
  const days = [];
  async function load(date) {
    try {
      if (date > today) fail('FUTURE_SCHEDULE_UNAVAILABLE');
      const previous = await readStored(store, gym, date, now);
      let candidate;
      if (date === today) {
        if (current.status !== 'fulfilled') fail('CURRENT_SCHEDULE_UNAVAILABLE');
        const value = current.value;
        candidate = observation(gym, date, value.days[temporary.dayNameForDate(date)], value.fetchedAt, 'observed-current:' + digest([value.version, value.days]), now);
      } else {
        const reviews = reviewSnapshots.filter(item => item?.date === date);
        if (reviews.length > 1) fail('DATED_SCHEDULE_CONFLICT');
        if (reviews.length) {
          const review = reviews[0];
          candidate = observation(gym, date, review.base, review.reviewedAt, 'reviewed-date:' + digest([date, review.base, review.reviewedAt]), now);
        }
      }
      const observed = candidate ? await persist(store, gym, date, candidate, previous, now) : previous?.data;
      if (!observed) fail('MISSING_DATED_SCHEDULE');
      if (added.status !== 'fulfilled') fail('ADDED_CLASSES_UNAVAILABLE');
      return { date, status: 'complete', observedAt: observed.observedAt,
        sourceVersion: digest([observed.sourceVersion, added.value.version, added.value.history]),
        occurrences: occurrences(observed, added.value, closingTime, cutoffConfirmed) };
    } catch (error) {
      const codes = ['SCHEDULE_STORAGE_UNAVAILABLE', 'DATED_SCHEDULE_INVALID', 'DATED_SCHEDULE_CONFLICT', 'SCHEDULE_TIME_UNAVAILABLE', 'CLASS_FINISH_UNCONFIRMED', 'CURRENT_SCHEDULE_UNAVAILABLE', 'ADDED_CLASSES_UNAVAILABLE', 'MISSING_DATED_SCHEDULE', 'FUTURE_SCHEDULE_UNAVAILABLE'];
      return { date, status: 'unavailable', code: codes.includes(error?.code) ? error.code : 'SCHEDULE_STORAGE_UNAVAILABLE' };
    }
  }
  // Bound concurrent storage calls independently from the retained date range.
  for (let offset = 0; offset < dates.length; offset += 8) days.push(...await Promise.all(dates.slice(offset, offset + 8).map(load)));
  return { gym, timezone: TIMEZONE, days };
}
