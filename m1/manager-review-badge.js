(() => {
  if (globalThis.M1_MANAGER_REVIEW_CONFIG?.enabled !== true) return;
  async function refresh() {
    const link = document.getElementById('managerWorkspaceLink');
    if (!link || document.hidden) return;
    link.textContent = 'Admin · Review status loading';
    try {
      const response = await fetch('/api/m1-manager-review', { cache: 'no-store', signal: AbortSignal.timeout(60000) });
      const data = await response.json();
      if (!response.ok || data.ok !== true || !Number.isInteger(data.pendingDays) || data.pendingDays < 0) throw new Error('Unavailable');
      link.textContent = data.pendingDays ? `Admin · ${data.pendingDays} ${data.pendingDays === 1 ? 'day needs' : 'days need'} review` : 'Admin · All days reviewed';
      link.style.borderColor = '#f4bc62';
    } catch { link.textContent = 'Admin · Review status unavailable'; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else void refresh();
  setInterval(refresh, 120000);
  document.addEventListener('visibilitychange', refresh);
})();
