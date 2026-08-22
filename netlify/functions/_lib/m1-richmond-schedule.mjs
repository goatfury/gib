import bootstrapSchedule from '../../../m1/richmond-schedule.json' with { type: 'json' };
import {
  RICHMOND_MAX_UPSTREAM_BYTES,
  RICHMOND_PUBLIC_SCHEDULE_URL,
  RICHMOND_SCHEDULE_SITE,
  RICHMOND_SCHEDULE_TIME_ZONE,
  RichmondScheduleSourceError,
  richmondContentHash,
  scheduleFromRichmondHtml,
  validateRichmondDays,
  validateRichmondTransition
} from './m1-richmond-schedule-core.mjs';

export const RICHMOND_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;
export const RICHMOND_FAILURE_BACKOFF_MS = 60 * 1_000;
export const RICHMOND_LAST_KNOWN_GOOD_STORE = 'gib-m1-richmond-schedule-v1';
export const RICHMOND_LAST_KNOWN_GOOD_KEY = 'richmond-weekly-last-validated';

let richmondMemory = {
  value: null,
  storedAt: 0,
  lastAttemptAt: 0,
  lastFailureReason: '',
  storageWarning: ''
};

const APPROVED_DAYS = validateRichmondDays(bootstrapSchedule.days);

export function resetRichmondScheduleMemoryForTests() {
  richmondMemory = {
    value: null,
    storedAt: 0,
    lastAttemptAt: 0,
    lastFailureReason: '',
    storageWarning: ''
  };
}

function responseBody(schedule, options) {
  return {
    timezone: schedule.timezone,
    site: schedule.site,
    version: schedule.version,
    contentHash: schedule.contentHash,
    days: schedule.days,
    source: {
      url: schedule.source.url,
      upstreamUrl: schedule.source.upstreamUrl,
      type: schedule.source.type,
      pageId: null,
      modifiedAt: schedule.source.modifiedAt,
      etag: schedule.source.etag || ''
    },
    fetchedAt: schedule.fetchedAt,
    current: options.current,
    fallback: options.fallback,
    status: {
      state: options.current ? 'current' : 'fallback',
      current: options.current,
      fallback: options.fallback,
      reason: options.reason || null,
      storageWarning: options.storageWarning || null,
      servedAt: options.servedAt
    },
    cache: { refreshIntervalSeconds: RICHMOND_REFRESH_INTERVAL_MS / 1_000 }
  };
}

function scheduleResponse(schedule, options, method) {
  return new Response(method === 'HEAD' ? null : JSON.stringify(responseBody(schedule, options)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': options.current
        ? 'public, max-age=0, s-maxage=300, must-revalidate'
        : 'public, max-age=0, s-maxage=60, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function errorResponse(status, message, method) {
  return new Response(method === 'HEAD' ? null : JSON.stringify({ ok: false, message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function validFullIso(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function validateStoredSchedule(value) {
  const days = validateRichmondDays(value?.days);
  const contentHash = richmondContentHash(days);
  if (
    value?.timezone !== RICHMOND_SCHEDULE_TIME_ZONE
    || value.site !== RICHMOND_SCHEDULE_SITE
    || value.contentHash !== contentHash
    || value.version !== `richmondbjj-${contentHash.slice(0, 16)}`
    || value.source?.url !== RICHMOND_PUBLIC_SCHEDULE_URL
    || value.source?.upstreamUrl !== RICHMOND_PUBLIC_SCHEDULE_URL
    || value.source?.type !== 'squarespace-html'
    || value.source?.pageId !== null
    || !validFullIso(value.source?.modifiedAt)
    || !validFullIso(value.fetchedAt)
    || typeof value.source?.etag !== 'string'
    || value.source.etag.length > 240
  ) throw new RichmondScheduleSourceError('invalid-last-known-good');
  return value;
}

function bootstrapFallback(now) {
  const days = validateRichmondDays(bootstrapSchedule.days);
  const contentHash = richmondContentHash(days);
  return {
    timezone: RICHMOND_SCHEDULE_TIME_ZONE,
    site: RICHMOND_SCHEDULE_SITE,
    version: `richmondbjj-${contentHash.slice(0, 16)}`,
    contentHash,
    days,
    source: {
      url: RICHMOND_PUBLIC_SCHEDULE_URL,
      upstreamUrl: RICHMOND_PUBLIC_SCHEDULE_URL,
      type: 'checked-in-bootstrap',
      pageId: null,
      modifiedAt: bootstrapSchedule.version,
      etag: ''
    },
    fetchedAt: new Date(now).toISOString()
  };
}

async function readTextLimited(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RICHMOND_MAX_UPSTREAM_BYTES) {
    throw new RichmondScheduleSourceError('oversized-response');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > RICHMOND_MAX_UPSTREAM_BYTES) {
    throw new RichmondScheduleSourceError('oversized-response');
  }
  return text;
}

export async function fetchRichmondCurrentSchedule(fetchImpl, now, previous = null) {
  const headers = {
    Accept: 'text/html; charset=utf-8',
    'User-Agent': 'GiB-M1-Richmond-Schedule/1.0 (+https://github.com/goatfury/gib)'
  };
  const etag = previous?.source?.etag || '';
  if (etag && /^[\x20-\x7e]{1,240}$/u.test(etag)) headers['If-None-Match'] = etag;
  let response;
  try {
    response = await fetchImpl(RICHMOND_PUBLIC_SCHEDULE_URL, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new RichmondScheduleSourceError('network-timeout');
    }
    throw new RichmondScheduleSourceError('network-failure');
  }
  if (response.status === 304 && previous) {
    return {
      ...validateStoredSchedule(previous),
      fetchedAt: new Date(now).toISOString()
    };
  }
  if (response.status >= 300 && response.status < 400) {
    throw new RichmondScheduleSourceError('redirect-rejected');
  }
  if (!response.ok) throw new RichmondScheduleSourceError('http-failure');
  if (response.url && response.url !== RICHMOND_PUBLIC_SCHEDULE_URL) {
    throw new RichmondScheduleSourceError('redirect-rejected');
  }
  if (!/^text\/html(?:;|$)/iu.test(response.headers.get('content-type') || '')) {
    throw new RichmondScheduleSourceError('unexpected-content-type');
  }
  const html = await readTextLimited(response);
  return scheduleFromRichmondHtml(
    html,
    new Date(now).toISOString(),
    response.headers.get('etag') || ''
  );
}

function validRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:'
    || url.port || url.username || url.password
    || url.pathname !== '/api/m1-schedule'
    || url.search || url.hash
    || !(
      url.hostname === 'gib-richmond-test.netlify.app'
      || /^[0-9a-f]{24}--gib-richmond-test\.netlify\.app$/iu.test(url.hostname)
    )
  ) return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}

async function defaultStore(blobsOverride) {
  const { getStore } = blobsOverride || await import('@netlify/blobs');
  return getStore({ name: RICHMOND_LAST_KNOWN_GOOD_STORE, consistency: 'strong' });
}

async function resolveStore(dependencies) {
  if (Object.hasOwn(dependencies, 'store')) return dependencies.store;
  try {
    return await defaultStore(dependencies.blobs);
  } catch {
    return null;
  }
}

async function readStored(store) {
  if (!store || typeof store.get !== 'function') return null;
  try {
    if (typeof store.getWithMetadata === 'function') {
      const result = await store.getWithMetadata(RICHMOND_LAST_KNOWN_GOOD_KEY, {
        type: 'json', consistency: 'strong'
      });
      return result?.data
        ? { value: validateStoredSchedule(result.data), etag: result.etag || '' }
        : null;
    }
    const value = await store.get(RICHMOND_LAST_KNOWN_GOOD_KEY, { type: 'json', consistency: 'strong' });
    return value ? { value: validateStoredSchedule(value), etag: '' } : null;
  } catch {
    return null;
  }
}

async function saveStored(store, value, previous) {
  if (!store || typeof store.set !== 'function') return false;
  try {
    const options = previous?.etag ? { onlyIfMatch: previous.etag } : { onlyIfNew: true };
    const result = await store.set(RICHMOND_LAST_KNOWN_GOOD_KEY, JSON.stringify(value), options);
    return result?.modified !== false;
  } catch {
    return false;
  }
}

export async function handleRichmondSchedule(request, dependencies = {}) {
  const method = String(request?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return errorResponse(405, 'Method not allowed.', method);
  if (!validRequest(request)) return errorResponse(404, 'Not found.', method);
  const now = dependencies.now ?? Date.now();
  const memory = dependencies.memory || richmondMemory;
  if (
    memory.value && Number.isFinite(memory.storedAt)
    && now - memory.storedAt >= 0 && now - memory.storedAt < RICHMOND_REFRESH_INTERVAL_MS
  ) {
    return scheduleResponse(memory.value, {
      current: true, fallback: 'none', reason: null,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  }

  const store = await resolveStore(dependencies);
  const stored = await readStored(store);
  const previous = memory.value || stored?.value || null;
  if (
    previous && Number.isFinite(Date.parse(previous.fetchedAt))
    && now - Date.parse(previous.fetchedAt) >= 0
    && now - Date.parse(previous.fetchedAt) < RICHMOND_REFRESH_INTERVAL_MS
  ) {
    memory.value = previous;
    memory.storedAt = Date.parse(previous.fetchedAt);
    return scheduleResponse(previous, {
      current: true, fallback: 'none', reason: null,
      storageWarning: null, servedAt: new Date(now).toISOString()
    }, method);
  }
  if (
    previous && memory.lastFailureReason
    && now - memory.lastAttemptAt >= 0
    && now - memory.lastAttemptAt < RICHMOND_FAILURE_BACKOFF_MS
  ) {
    return scheduleResponse(previous, {
      current: false, fallback: 'last-known-good', reason: memory.lastFailureReason,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  }

  memory.lastAttemptAt = now;
  let failureReason = 'refresh-failed';
  try {
    const current = await fetchRichmondCurrentSchedule(dependencies.fetchImpl || fetch, now, previous);
    validateRichmondTransition(current.days, APPROVED_DAYS);
    if (previous) validateRichmondTransition(current.days, previous.days);
    const persisted = await saveStored(store, current, stored);
    memory.value = current;
    memory.storedAt = now;
    memory.lastFailureReason = '';
    memory.storageWarning = persisted ? '' : 'last-known-good-storage-not-updated';
    return scheduleResponse(current, {
      current: true, fallback: 'none', reason: null,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  } catch (error) {
    failureReason = error instanceof RichmondScheduleSourceError ? error.code : 'refresh-failed';
    memory.lastFailureReason = failureReason;
  }

  if (previous) {
    memory.value = previous;
    memory.storedAt = 0;
    return scheduleResponse(previous, {
      current: false, fallback: 'last-known-good', reason: failureReason,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  }
  try {
    const bootstrap = bootstrapFallback(now);
    return scheduleResponse(bootstrap, {
      current: false, fallback: 'bootstrap', reason: failureReason,
      storageWarning: null, servedAt: new Date(now).toISOString()
    }, method);
  } catch {
    return errorResponse(503, 'No validated schedule is available.', method);
  }
}
