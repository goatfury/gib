(function (global) {
  'use strict';
  const ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
  const LABELS = Object.freeze({ CHECK_OVERDUE: 'Attendance check overdue. Open Admin.',
    CHECK_INCOMPLETE: 'Attendance could not be fully checked. Open Admin.', DELIVERY_FAILED: 'Attendance email could not be sent. Open Admin.',
    DELIVERY_UNCONFIRMED: 'Attendance email delivery is unconfirmed. Open Admin.', CONFIGURATION_REQUIRED: 'Attendance reminders are not set up yet.' });
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
  function valid(value) {
    return exact(value, ['ok', 'target', 'gym', 'status', 'warnings', 'checkedAt']) && value.ok === true && value.target === 'test' && value.gym === 'rev'
      && ['not-configured', 'clear', 'attention'].includes(value.status) && Array.isArray(value.warnings) && value.warnings.length <= 5
      && new Set(value.warnings.map(warning => warning?.code)).size === value.warnings.length
      && value.warnings.every(warning => exact(warning, ['code', 'message']) && Object.hasOwn(LABELS, warning.code)
        && typeof warning.message === 'string' && warning.message.length <= 500)
      && (value.checkedAt === null || typeof value.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value.checkedAt)
        && Number.isFinite(Date.parse(value.checkedAt)) && Date.parse(value.checkedAt) <= Date.now() + 5000)
      && (value.status === 'attention' ? value.warnings.length > 0 : value.status === 'not-configured'
        ? value.warnings.every(warning => warning.code === 'CONFIGURATION_REQUIRED') : value.warnings.length === 0)
      && (value.status !== 'clear' || value.checkedAt !== null && Date.now() - Date.parse(value.checkedAt) <= 30 * 60 * 1000);
  }
  function create({ root, fetch = global.fetch } = {}) {
    if (!root || typeof fetch !== 'function' || global.location?.origin !== ORIGIN || global.location?.protocol !== 'https:' || global.location?.port
      || global.M1_MANAGER_REVIEW_CONFIG?.enabled !== true || global.M1_MANAGER_REVIEW_CONFIG?.target !== 'test'
      || global.M1_INSTALLATION_PROFILE?.installationId !== 'rev') return null;
    let active = true, generation = 0, flight = null, timer = null, queued = false;
    const document = root.ownerDocument || global.document;
    function show(message, state) { root.hidden = false; root.textContent = message; root.dataset.attendanceState = state; }
    async function refresh() {
      if (!active || document.hidden) return;
      if (flight) { queued = true; return flight; }
      global.clearTimeout(timer); const own = generation;
      if (root.hidden) show('Attendance check status loading…', 'loading');
      const task = (async () => {
        try {
          const response = await Promise.resolve().then(() => fetch('/api/m1-attendance-warning', { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: global.AbortSignal.timeout(10000) }));
          const value = await response.json();
          if (!active || own !== generation || document.hidden) return;
          if (!response.ok || !valid(value)) throw new Error('Unconfirmed warning read');
          if (value.status === 'clear') { root.hidden = true; root.textContent = ''; root.dataset.attendanceState = 'clear'; }
          else show(value.status === 'not-configured' ? 'Attendance reminders are not configured.'
            : value.warnings.map(warning => LABELS[warning.code]).join(' '), value.status);
        } catch {
          if (active && own === generation && !document.hidden) show('Attendance check status unavailable', 'unavailable');
        } finally {
          if (flight === task) flight = null;
          if (active && own === generation) {
            const repeat = queued; queued = false;
            if (repeat && !document.hidden) void refresh(); else timer = global.setTimeout(refresh, 120000);
          }
        }
      })();
      flight = task; return task;
    }
    function clear() { active = false; generation++; queued = false; global.clearTimeout(timer); }
    return Object.freeze({ refresh, clear });
  }
  global.GIBM1AttendanceWarning = Object.freeze({ create, valid, label: code => LABELS[code] || null });
  const start = () => {
    const ui = create({ root: global.document?.getElementById('attendanceWarning') });
    if (!ui) return;
    void ui.refresh(); global.document.addEventListener('visibilitychange', ui.refresh); global.addEventListener?.('online', ui.refresh);
  };
  if (global.document?.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start); else start();
})(globalThis);
