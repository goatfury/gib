'use strict';

const workerUrl = new URL(self.location.href);
const RICHMOND_PRODUCTION_HOST = /^(?:[0-9a-f]{24}--)?gib-richmond-live\.netlify\.app$/iu
  .test(workerUrl.hostname);
const CACHE_PREFIX = RICHMOND_PRODUCTION_HOST
  ? 'gib-m1-richmond-production-shell-'
  : 'gib-m1-shell-';
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
const INSTALLATION_PROFILE_URL = new URL(
  `installation-profile.generated.js?v=${encodeURIComponent(SHELL_REVISION)}`,
  SCOPE_URL
).href;
const SYNC_CORE_URL = new URL(
  `sync-core.mjs?v=${encodeURIComponent(SHELL_REVISION)}`,
  SCOPE_URL
).href;
const STAFF_CLOCK_CORE_URL = new URL(
  `staff-clock-core.mjs?v=${encodeURIComponent(SHELL_REVISION)}`,
  SCOPE_URL
).href;
const STAFF_CLOCK_CLIENT_URL = new URL(
  `staff-clock-client.mjs?v=${encodeURIComponent(SHELL_REVISION)}`,
  SCOPE_URL
).href;
const KIOSK_ENHANCEMENTS_CSS_URL = new URL(
  `kiosk-enhancements.css?v=${encodeURIComponent(SHELL_REVISION)}`,
  SCOPE_URL
).href;
const KIOSK_ENHANCEMENTS_URL = new URL(
  `kiosk-enhancements.mjs?v=${encodeURIComponent(SHELL_REVISION)}`,
  SCOPE_URL
).href;
const KIOSK_ENHANCEMENTS_CORE_URL = new URL('kiosk-enhancements-core.mjs', SCOPE_URL).href;
const REVOLUTION_LOGO_URL = new URL('assets/revolution-bjj-logo.webp', SCOPE_URL).href;
const RICHMOND_LOGO_URL = new URL('assets/richmond-bjj-logo.webp', SCOPE_URL).href;
const SHELL_URLS = Object.freeze([
  INDEX_URL,
  INSTALLATION_PROFILE_URL,
  SYNC_CORE_URL,
  STAFF_CLOCK_CORE_URL,
  STAFF_CLOCK_CLIENT_URL,
  KIOSK_ENHANCEMENTS_CSS_URL,
  KIOSK_ENHANCEMENTS_URL,
  KIOSK_ENHANCEMENTS_CORE_URL,
  REVOLUTION_LOGO_URL,
  RICHMOND_LOGO_URL
]);
const SHELL_REQUESTS = Object.freeze(SHELL_URLS.map(url => new Request(url, {
  cache: 'reload',
  credentials: 'same-origin'
})));
const SHELL_URL_SET = new Set(SHELL_URLS);

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

  return SHELL_URL_SET.has(url.href) ? url.href : '';
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
