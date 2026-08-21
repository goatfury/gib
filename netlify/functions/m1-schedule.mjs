import bootstrapSchedule from '../../m1/shared-schedule.json' with { type: 'json' };
import {
  MAX_SOURCE_CLOCK_SKEW_MS,
  MAX_UPSTREAM_BYTES,
  PUBLIC_SCHEDULE_URL,
  ScheduleSourceError,
  WORDPRESS_SCHEDULE_URL,
  contentHashForDays,
  scheduleFromWordPressPayload,
  validatePlausibleScheduleTransition,
  validateScheduleContract
} from './_lib/m1-schedule-core.mjs';
import {
  deploymentInstallationProfile,
  remoteScheduleEnabled
} from './_lib/m1-installation.mjs';
import { handleRichmondSchedule } from './_lib/m1-richmond-schedule.mjs';

export const SCHEDULE_PATH = '/api/m1-schedule';
export const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
export const FAILURE_BACKOFF_MS = 60 * 1_000;
export const LAST_KNOWN_GOOD_STORE = 'gib-m1-schedule-v1';
export const LAST_KNOWN_GOOD_KEY = 'rev-weekly-last-validated';

export const config = {
  path: '/api/m1-schedule',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

let serverMemory = {
  value: null,
  storedAt: 0,
  lastAttemptAt: 0,
  lastFailureReason: '',
  storageWarning: '',
  currentReason: ''
};

// This checked-in schedule is reviewed with each release and is the independent
// trust anchor for cumulative website changes. A fetched schedule may advance
// last-known-good storage, but it must never become its own approval anchor.
const APPROVED_SCHEDULE_ANCHOR_DAYS = validateScheduleContract(bootstrapSchedule);
const APPROVED_SCHEDULE_ANCHOR_HASH = contentHashForDays(APPROVED_SCHEDULE_ANCHOR_DAYS);

export function resetScheduleMemoryForTests() {
  serverMemory = {
    value: null,
    storedAt: 0,
    lastAttemptAt: 0,
    lastFailureReason: '',
    storageWarning: '',
    currentReason: ''
  };
}

function publicStatus(schedule, options) {
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
      pageId: Number.isInteger(schedule.source.pageId) ? schedule.source.pageId : null,
      modifiedAt: schedule.source.modifiedAt || null
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
    cache: {
      refreshIntervalSeconds: REFRESH_INTERVAL_MS / 1_000
    }
  };
}

function scheduleResponse(status, schedule, options, method = 'GET') {
  const fallback = !options.current;
  const body = publicStatus(schedule, options);
  return new Response(method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': fallback
        ? 'public, max-age=0, s-maxage=60, must-revalidate'
        : 'public, max-age=0, s-maxage=300, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function errorResponse(status, message, method = 'GET') {
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

async function defaultStore(deployContext, published, blobsOverride) {
  const { getDeployStore, getStore } = blobsOverride || await import('@netlify/blobs');
  const options = {
    name: LAST_KNOWN_GOOD_STORE,
    consistency: 'strong'
  };
  // Deploy-specific storage keeps a Deploy Preview's last-known-good data
  // isolated from every other deploy and from production.
  if (deployContext !== 'production' || published !== true) return getDeployStore(options);
  return getStore(options);
}

async function readTextLimited(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
    throw new ScheduleSourceError('oversized-response');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_BYTES) {
      throw new ScheduleSourceError('oversized-response');
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BYTES) throw new ScheduleSourceError('oversized-response');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function allowedResponseUrl(value) {
  try {
    const url = new URL(value || '');
    const expected = new URL(WORDPRESS_SCHEDULE_URL);
    return url.protocol === 'https:'
      && url.hostname === 'revolutionbjj.com'
      && url.port === ''
      && url.pathname === '/wp-json/wp/v2/pages'
      && url.searchParams.size === expected.searchParams.size
      && [...expected.searchParams].every(([key, value]) => url.searchParams.get(key) === value);
  } catch {
    return false;
  }
}

export async function fetchCurrentSchedule(fetchImpl, now) {
  let response;
  try {
    response = await fetchImpl(WORDPRESS_SCHEDULE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GiB-M1-Schedule/1.0 (+https://github.com/goatfury/gib)'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ScheduleSourceError('network-timeout');
    }
    throw new ScheduleSourceError('network-failure');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ScheduleSourceError('redirect-rejected');
  }
  if (!response.ok) throw new ScheduleSourceError('http-failure');
  if (!allowedResponseUrl(response.url)) throw new ScheduleSourceError('redirect-rejected');
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') || '')) {
    throw new ScheduleSourceError('unexpected-content-type');
  }
  let text;
  try {
    text = await readTextLimited(response);
  } catch (error) {
    if (error instanceof ScheduleSourceError) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ScheduleSourceError('network-timeout');
    }
    throw new ScheduleSourceError('network-failure');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ScheduleSourceError('invalid-json');
  }
  return scheduleFromWordPressPayload(payload, new Date(now).toISOString());
}

function validateStoredSchedule(value) {
  validateScheduleContract(value);
  const expectedHash = contentHashForDays(value.days);
  const modifiedAt = Date.parse(value.source?.modifiedAt || '');
  const fetchedAt = Date.parse(value.fetchedAt || '');
  if (
    value.contentHash !== expectedHash
    || value.version !== `revbjj-${expectedHash.slice(0, 16)}`
    || value.source?.url !== PUBLIC_SCHEDULE_URL
    || value.source?.upstreamUrl !== WORDPRESS_SCHEDULE_URL
    || value.source?.type !== 'wordpress-rest'
    || !Number.isInteger(value.source?.pageId)
    || value.source.pageId <= 0
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value.source?.modifiedAt || '')
    || !Number.isFinite(modifiedAt)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.fetchedAt || '')
    || !Number.isFinite(fetchedAt)
    || new Date(fetchedAt).toISOString() !== value.fetchedAt
    || modifiedAt > fetchedAt + MAX_SOURCE_CLOCK_SKEW_MS
  ) {
    throw new ScheduleSourceError('invalid-last-known-good');
  }
  return value;
}

function newestValidatedStoredSchedule(...candidates) {
  let newest = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    let validated;
    try {
      validated = validateStoredSchedule(candidate);
    } catch {
      continue;
    }
    if (!newest) {
      newest = validated;
      continue;
    }
    const candidateModified = Date.parse(validated.source.modifiedAt);
    const newestModified = Date.parse(newest.source.modifiedAt);
    if (candidateModified > newestModified) {
      newest = validated;
      continue;
    }
    if (candidateModified === newestModified) {
      const candidateFetched = Date.parse(validated.fetchedAt);
      const newestFetched = Date.parse(newest.fetchedAt);
      if (candidateFetched > newestFetched) newest = validated;
    }
  }
  return newest;
}

function bootstrapFallback(now) {
  const days = validateScheduleContract(bootstrapSchedule);
  const contentHash = contentHashForDays(days);
  return {
    timezone: bootstrapSchedule.timezone,
    site: bootstrapSchedule.site,
    version: `revbjj-${contentHash.slice(0, 16)}`,
    contentHash,
    days,
    source: {
      url: PUBLIC_SCHEDULE_URL,
      upstreamUrl: WORDPRESS_SCHEDULE_URL,
      type: 'checked-in-bootstrap',
      modifiedAt: bootstrapSchedule.version || null
    },
    fetchedAt: new Date(now).toISOString()
  };
}

async function resolveStore(dependencies, deployContext, published) {
  if (Object.hasOwn(dependencies, 'store')) return dependencies.store;
  try {
    return await defaultStore(deployContext, published, dependencies.blobs);
  } catch {
    return null;
  }
}

async function readLastKnownGood(store) {
  if (!store || typeof store.get !== 'function') return null;
  try {
    if (typeof store.getWithMetadata === 'function') {
      const result = await store.getWithMetadata(LAST_KNOWN_GOOD_KEY, {
        type: 'json',
        consistency: 'strong'
      });
      return result?.data
        ? { value: validateStoredSchedule(result.data), etag: result.etag || '' }
        : null;
    }
    const value = await store.get(LAST_KNOWN_GOOD_KEY, { type: 'json', consistency: 'strong' });
    return value ? { value: validateStoredSchedule(value), etag: '' } : null;
  } catch {
    return null;
  }
}

async function saveLastKnownGood(store, schedule, previous) {
  if (!store || typeof store.set !== 'function') return 'unavailable';
  try {
    const options = previous?.etag
      ? { onlyIfMatch: previous.etag }
      : { onlyIfNew: true };
    const result = await store.set(LAST_KNOWN_GOOD_KEY, JSON.stringify(schedule), options);
    return result?.modified === false ? 'conflict' : 'persisted';
  } catch {
    return 'unavailable';
  }
}

function validateRefreshProgression(current, previous) {
  validatePlausibleScheduleTransition(current.days, APPROVED_SCHEDULE_ANCHOR_DAYS);
  const restoringExactApprovedAnchor = current.contentHash === APPROVED_SCHEDULE_ANCHOR_HASH;
  if (!restoringExactApprovedAnchor) {
    validatePlausibleScheduleTransition(current.days, previous.days);
  }
  if (previous.source?.type !== 'wordpress-rest') return;
  const currentModified = Date.parse(current.source.modifiedAt);
  const previousModified = Date.parse(previous.source.modifiedAt);
  if (currentModified < previousModified) throw new ScheduleSourceError('stale-upstream');
  if (
    currentModified === previousModified
    && current.contentHash !== previous.contentHash
  ) {
    throw new ScheduleSourceError('conflicting-upstream-version');
  }
}

function deployContextFor(request, dependencies) {
  const explicit = dependencies.deployContext || dependencies.context?.deploy?.context;
  if (explicit) return explicit;
  if (dependencies.env?.CONTEXT) return dependencies.env.CONTEXT;
  return 'unknown';
}

function allowedDeploymentRequest(request, deployContext, published, env) {
  let hostname;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return false;
  }
  if (deployContext === 'deploy-preview') {
    return /^(?:deploy-preview-\d+|[a-f0-9]{24})--gib-live\.netlify\.app$/iu.test(hostname);
  }
  return deployContext === 'production'
    && published === true
    && hostname === 'gib-live.netlify.app'
    && env.GIB_M1_WEBSITE_SCHEDULE_PRODUCTION_ENABLED === 'true';
}

export function validScheduleRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.pathname !== SCHEDULE_PATH
    || url.search
    || url.hash
  ) {
    return false;
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

export async function handleM1Schedule(request, dependencies = {}) {
  if (deploymentInstallationProfile(dependencies.installationId)?.installationId === 'richmond') {
    return handleRichmondSchedule(request, dependencies);
  }
  const method = String(request?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return errorResponse(405, 'Method not allowed.', method);
  }
  if (!validScheduleRequest(request)) {
    return errorResponse(404, 'Not found.', method);
  }
  const now = dependencies.now ?? Date.now();
  const deployContext = deployContextFor(request, dependencies);
  const published = dependencies.published ?? dependencies.context?.deploy?.published ?? false;
  const env = dependencies.env || process.env;
  if (!remoteScheduleEnabled(dependencies.installationId)) {
    return errorResponse(503, 'This installation uses a deployment-local TEST schedule.', method);
  }
  if (!allowedDeploymentRequest(request, deployContext, published, env)) {
    return errorResponse(503, 'The website schedule service is not enabled in this deployment.', method);
  }
  const memory = dependencies.memory || serverMemory;
  if (
    memory.value
    && Number.isFinite(memory.storedAt)
    && now - memory.storedAt >= 0
    && now - memory.storedAt < REFRESH_INTERVAL_MS
  ) {
    return scheduleResponse(200, memory.value, {
      current: true,
      fallback: 'none',
      reason: memory.currentReason || null,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  }

  const store = await resolveStore(dependencies, deployContext, published);
  const durableRecord = await readLastKnownGood(store);
  const previousSchedule = newestValidatedStoredSchedule(memory.value, durableRecord?.value);
  const durableTime = Date.parse(durableRecord?.value?.fetchedAt || '');
  if (
    durableRecord
    && previousSchedule === durableRecord.value
    && Number.isFinite(durableTime)
    && now - durableTime >= 0
    && now - durableTime < REFRESH_INTERVAL_MS
  ) {
    memory.value = durableRecord.value;
    memory.storedAt = durableTime;
    memory.storageWarning = '';
    memory.currentReason = '';
    return scheduleResponse(200, durableRecord.value, {
      current: true,
      fallback: 'none',
      reason: null,
      storageWarning: null,
      servedAt: new Date(now).toISOString()
    }, method);
  }
  if (
    memory.value
    && memory.lastFailureReason
    && now - memory.lastAttemptAt >= 0
    && now - memory.lastAttemptAt < FAILURE_BACKOFF_MS
  ) {
    return scheduleResponse(200, validateStoredSchedule(memory.value), {
      current: false,
      fallback: 'last-known-good',
      reason: memory.lastFailureReason,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  }
  let failureReason = 'refresh-failed';
  memory.lastAttemptAt = now;
  try {
    const current = await fetchCurrentSchedule(dependencies.fetchImpl || fetch, now);
    validateRefreshProgression(
      current,
      previousSchedule || bootstrapSchedule
    );
    memory.lastFailureReason = '';
    const persistence = await saveLastKnownGood(store, current, durableRecord);
    let served = current;
    memory.currentReason = '';
    memory.storageWarning = '';
    if (persistence === 'conflict') {
      const durableWinner = await readLastKnownGood(store);
      if (durableWinner) {
        if (durableWinner.value.contentHash === current.contentHash) {
          served = durableWinner.value;
        } else {
          try {
            validateRefreshProgression(current, durableWinner.value);
            // The just-fetched candidate is newer, but the conditional write lost.
            // Serve it only from memory and keep the durability warning visible.
            served = current;
            memory.storageWarning = 'last-known-good-storage-not-updated';
          } catch {
            served = durableWinner.value;
            memory.currentReason = 'concurrent-refresh-winner';
          }
        }
      } else {
        memory.storageWarning = 'last-known-good-storage-not-updated';
      }
    } else if (persistence !== 'persisted') {
      memory.storageWarning = 'last-known-good-storage-not-updated';
    }
    memory.value = served;
    memory.storedAt = now;
    return scheduleResponse(200, served, {
      current: true,
      fallback: 'none',
      reason: memory.currentReason || null,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  } catch (error) {
    failureReason = error instanceof ScheduleSourceError ? error.code : 'refresh-failed';
    memory.lastFailureReason = failureReason;
  }

  const fallbackSchedule = newestValidatedStoredSchedule(memory.value, durableRecord?.value);
  if (fallbackSchedule) {
    memory.value = fallbackSchedule;
    memory.storedAt = 0;
    if (fallbackSchedule === durableRecord?.value) memory.storageWarning = '';
    memory.currentReason = '';
    return scheduleResponse(200, fallbackSchedule, {
      current: false,
      fallback: 'last-known-good',
      reason: failureReason,
      storageWarning: memory.storageWarning || null,
      servedAt: new Date(now).toISOString()
    }, method);
  }

  let bootstrap;
  try {
    bootstrap = bootstrapFallback(now);
  } catch {
    return errorResponse(503, 'No validated schedule is available.', method);
  }
  return scheduleResponse(200, bootstrap, {
    current: false,
    fallback: 'bootstrap',
    reason: failureReason,
    storageWarning: null,
    servedAt: new Date(now).toISOString()
  }, method);
}

export default (request, context) => handleM1Schedule(request, { context, env: process.env });
