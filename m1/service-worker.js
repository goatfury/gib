'use strict';

const CACHE_PREFIX = 'gib-m1-shell-';
const workerUrl = new URL(self.location.href);
const SHELL_REVISION = workerUrl.searchParams.get('v') || '';

if (!/^[a-z0-9._-]{1,64}$/iu.test(SHELL_REVISION)) {
  throw new Error('A valid M1 offline-shell revision is required.');
}

const CACHE_NAME = `${CACHE_PREFIX}${SHELL_REVISION}`;
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname.endsWith('/')
  ? SCOPE_URL.pathname
  : `${SCOPE_URL.pathname}/`;
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const SYNC_CORE_URL = new URL(
  `sync-core.mjs?v=${encodeURIComponent(SHELL_REVISION)}`,
  SCOPE_URL
).href;
const SHELL_REQUESTS = Object.freeze([INDEX_URL, SYNC_CORE_URL].map(url => new Request(url, {
  cache: 'reload',
  credentials: 'same-origin'
})));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_REQUESTS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function shellCacheKey(request) {
  if (!request || request.method !== 'GET') return '';

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return '';

  if (
    request.mode === 'navigate'
    && (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`)
  ) {
    return INDEX_URL;
  }

  return url.href === SYNC_CORE_URL ? SYNC_CORE_URL : '';
}

async function networkFirst(request, cacheKey) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const cacheKey = shellCacheKey(event.request);
  if (!cacheKey) return;
  event.respondWith(networkFirst(event.request, cacheKey));
});
