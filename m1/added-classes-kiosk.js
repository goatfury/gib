'use strict';

// Class schedules are cached separately from the sign-in ledger and its queue.
// This client never creates, edits, or sends a teaching record.
(function (root) {
  function create(options) {
    const core = options.core || root.GIBM1TemporaryClasses;
    const profile = options.profile;
    const target = core.resolveAddedClassesTarget(profile, root.location?.href || '');
    const storage = options.storage || root.localStorage;
    const fetcher = options.fetch || root.fetch.bind(root);
    const clock = options.now || (() => new Date());
    const cacheKey = `${profile.storagePrefix}added_classes_cache_v1`;
    let document = null;
    let phase = target ? 'loading' : 'failed';
    let cachedAt = '';
    let cacheFailed = false;
    let inFlight = null;
    let lastAttempt = 0;
    const readCache = () => {
      if (!target) return;
      try {
        const cached = JSON.parse(storage.getItem(cacheKey) || 'null');
        const validated = core.validateDocument(cached?.document, profile.installationId, target);
        if (validated) {
          document = validated;
          cachedAt = typeof cached.receivedAt === 'string' ? cached.receivedAt : '';
          phase = 'cached';
        }
      } catch { /* Keep local temporary classes and the regular schedule. */ }
    };
    readCache();

    function state() {
      const time = cachedAt && Number.isFinite(Date.parse(cachedAt))
        ? new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit'
        }).format(new Date(cachedAt))
        : '';
      const localCount = unsharedLegacy().length;
      let message = phase === 'ready'
        ? `Added classes checked ${time || 'just now'}.`
        : document
          ? `Added classes may be out of date. Last checked ${time || 'on an earlier visit'}.`
          : phase === 'loading'
            ? 'Checking added classes…'
            : 'Added classes could not be checked. The regular schedule and classes saved on this browser remain available.';
      if (cacheFailed) message += ' This update could not be saved for offline use.';
      if (localCount) message += ` ${localCount} temporary class${localCount === 1 ? ' is' : 'es are'} saved only on this browser. Share from Admin → Add a class.`;
      return { phase, document, cachedAt, cacheFailed, message, localCount };
    }

    function unsharedLegacy() {
      const identities = new Set(document?.importedIdentities || []);
      return (options.legacySeries?.() || []).filter(item => !identities.has(core.seriesIdentity(item)));
    }

    function classesForDate(date) {
      const shared = document ? core.classesForDate({}, document, date) : [];
      // Use the former local resolver for legacy entries, including its historical
      // label formatting; sharing never silently rewrites an existing label.
      const local = unsharedLegacy()
        .filter(item => options.legacyActive(item, core.dayNameForDate(date), date))
        .map(options.legacyLabel);
      return [...new Set([...shared, ...local])];
    }

    function changed() { options.onChange?.(state()); }
    async function refreshNow() {
      if (!target) return false;
      lastAttempt = clock().getTime();
      phase = 'loading';
      changed();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetcher('/api/m1-added-classes', {
          method: 'GET', cache: 'no-store', credentials: 'same-origin',
          headers: { Accept: 'application/json' }, signal: controller.signal
        });
        if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          throw new Error('Added classes unavailable');
        }
        const raw = await response.text();
        if (raw.length > 2000000) throw new Error('Added classes response too large');
        const validated = core.validateDocument(JSON.parse(raw), profile.installationId, target);
        if (!validated || validated.current !== true || (document && validated.version < document.version)) {
          throw new Error('Added classes response invalid or older');
        }
        if (document && validated.version === document.version && (
          JSON.stringify(validated.series) !== JSON.stringify(document.series)
          || JSON.stringify(validated.history) !== JSON.stringify(document.history)
          || JSON.stringify(validated.importedIdentities) !== JSON.stringify(document.importedIdentities)
        )) throw new Error('Added classes response conflicts with saved version');
        document = validated;
        cachedAt = clock().toISOString();
        cacheFailed = false;
        try { storage.setItem(cacheKey, JSON.stringify({ document, receivedAt: cachedAt })); }
        catch { cacheFailed = true; }
        phase = 'ready';
        changed();
        return true;
      } catch {
        phase = 'failed';
        changed();
        return false;
      } finally { clearTimeout(timer); }
    }
    function refresh() {
      if (!inFlight) inFlight = refreshNow().finally(() => { inFlight = null; });
      return inFlight;
    }
    function refreshIfDue() {
      if (clock().getTime() - lastAttempt >= 30000) return refresh();
      return inFlight;
    }
    function start() {
      changed();
      if (!target) return;
      refresh();
      root.setInterval(refreshIfDue, 30000);
      ['online', 'focus', 'pageshow'].forEach(event => root.addEventListener(event, refreshIfDue));
      root.addEventListener('offline', () => { phase = 'cached'; changed(); });
      root.document.addEventListener('visibilitychange', () => {
        if (root.document.visibilityState === 'visible') refreshIfDue();
      });
    }
    return Object.freeze({ state, classesForDate, refresh, start, unsharedLegacy });
  }
  const api = Object.freeze({ create });
  root.GIBM1AddedClassesKiosk = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
