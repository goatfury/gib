(() => {
  if (globalThis.M1_MANAGER_REVIEW_CONFIG?.enabled !== true) return;
  let inFlight = false, timer;
  async function refresh() {
    const link = document.getElementById('managerWorkspaceLink');
    if (!link || document.hidden || inFlight) return;
    clearTimeout(timer); inFlight = true;
    link.textContent = 'Admin · Review status loading';
    try {
      const response = await fetch('/api/m1-manager-review', { cache: 'no-store', signal: AbortSignal.timeout(60000) });
      const data = await response.json();
      const age = Date.now() - Date.parse(data.asOf);
      if (!response.ok || data.ok !== true || !Number.isInteger(data.pendingDays) || data.pendingDays < 0 || !Number.isFinite(age) || age < -5000 || age >= 60000) throw new Error('Unavailable');
      link.textContent = data.pendingDays ? `Admin · ${data.pendingDays} ${data.pendingDays === 1 ? 'day needs' : 'days need'} review` : 'Admin · All days reviewed';
      link.style.borderColor = data.pendingDays ? '#f4bc62' : '';
    } catch { link.textContent = 'Admin · Review status unavailable'; link.style.borderColor = '#f4bc62'; }
    finally { inFlight = false; timer = setTimeout(refresh, 120000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else void refresh();
  document.addEventListener('visibilitychange', refresh);
})();
