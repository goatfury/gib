(() => {
  if (globalThis.M1_MANAGER_REVIEW_CONFIG?.enabled !== true) return;
  let inFlight = false, timer;
  async function refresh() {
    const link = document.getElementById('managerWorkspaceLink');
    if (!link || document.hidden || inFlight) return;
    clearTimeout(timer); inFlight = true;
    link.textContent = 'Admin · Review status loading';
    const traceId = globalThis.location?.origin === 'https://deploy-preview-89--gib-live.netlify.app' ? globalThis.crypto?.randomUUID?.() : null;
    const started = Date.now();
    let response, outcome = 'failed';
    const trace = state => {
      if (traceId) { try { console.info('M1_TEST_READ_CLIENT', JSON.stringify({ clientId: traceId,
        requestId: /^[0-9a-f-]{36}$/.test(response?.headers.get('X-GIB-M1-Read-ID') || '') ? response.headers.get('X-GIB-M1-Read-ID') : null,
        stage: 'badge.delivery', state, status: response?.status || null, elapsedMs: Date.now() - started })); } catch {} }
    };
    trace('start');
    try {
      const revolution = globalThis.M1_INSTALLATION_PROFILE?.installationId === 'rev';
      const data = revolution ? await globalThis.GIBM1ReadClient.run({ ticket: globalThis.GIBM1ReadClient.createTicket(),
        send: async (readRequest, options) => {
          response = await fetch('/api/m1-manager-review', { cache: 'no-store', signal: AbortSignal.timeout(options.timeoutMs), headers: {
            'X-GIB-M1-Read-Operation': readRequest.operation, 'X-GIB-M1-Read-ID': readRequest.requestId
          } });
          const value = await response.json();
          if (!response.ok) throw Object.assign(new Error('Unavailable'), { status: response.status, data: value });
          return value;
        } }) : await (async () => {
          response = await fetch('/api/m1-manager-review', { cache: 'no-store', signal: AbortSignal.timeout(60000), ...(traceId ? { headers: { 'X-GIB-M1-Read-ID': traceId } } : {}) });
          return response.json();
        })();
      const age = Date.now() - Date.parse(data.asOf);
      if (!response.ok || data.ok !== true || !Number.isInteger(data.pendingDays) || data.pendingDays < 0 || !Number.isFinite(age) || age < -5000 || age >= 60000) throw new Error('Unavailable');
      link.textContent = data.pendingDays ? `Admin · ${data.pendingDays} ${data.pendingDays === 1 ? 'day needs' : 'days need'} review` : 'Admin · All days reviewed';
      link.style.borderColor = data.pendingDays ? '#f4bc62' : '';
      outcome = 'received';
    } catch { link.textContent = 'Admin · Review status unavailable'; link.style.borderColor = '#f4bc62'; }
    finally { trace(outcome); inFlight = false; timer = setTimeout(refresh, 120000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else void refresh();
  document.addEventListener('visibilitychange', refresh);
  globalThis.addEventListener?.('online', refresh);
})();
