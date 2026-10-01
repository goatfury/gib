(function (global) {
  'use strict';
  const ORIGINS = { rev: 'https://gib-live.netlify.app', richmond: 'https://gib-richmond-live.netlify.app' };
  const STATES = ['check-overdue', 'check-incomplete', 'delivery-failed', 'delivery-unconfirmed', 'not-configured', 'attention', 'clear'];
  const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  function valid(value, gym) {
    const health = value?.current?.health, history = value?.current?.messages;
    return value?.ok === true && value.target === 'production' && value.latestRun === null
      && health?.ok === true && health.target === 'production' && STATES.includes(health.state)
      && Array.isArray(health.codes) && health.codes.length <= 5 && health.codes.every(code => global.GIBM1AttendanceWarning?.label(code))
      && (['clear', 'attention'].includes(health.state) || health.codes.length > 0)
      && [health.pendingCount, health.failedCount, health.unconfirmedCount, health.historicalUnconfirmedCount, health.historicalFailedCount]
        .every(count => Number.isSafeInteger(count) && count >= 0)
      && (health.checkedAt === null || validTime(health.checkedAt)) && (health.expiresAt === null || validTime(health.expiresAt))
      && (health.state !== 'clear' || health.checkedAt !== null && validTime(health.expiresAt) && Date.parse(health.expiresAt) > Date.now()
        && Date.now() - Date.parse(health.checkedAt) >= -5000 && Date.now() - Date.parse(health.checkedAt) < 1800000
        && health.codes.length === 0 && !health.pendingCount && !health.failedCount && !health.unconfirmedCount)
      && history?.ok === true && history.target === 'production' && history.historyComplete === true
      && Array.isArray(history.messages) && history.messages.length <= 256 && history.messages.every(entry => {
        const message = entry.message;
        return entry.gym === gym && entry.messageId === 'm1-production-scheduled-' + gym + '-' + entry.date
          && typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
          && (message === null || message?.target === 'production' && message.synthetic === false && message.messageId === entry.messageId
            && ['subject', 'html', 'text'].every(key => typeof message[key] === 'string' && message[key].length > 0 && message[key].length <= 200000)
            && (message.html + ' ' + message.text).match(/https:\/\/[^\s"<>]+/g)?.every(url => url.startsWith(ORIGINS[gym] + '/m1/admin/')));
      });
  }
  function create({ root, request, getAdmin, getSession, onUnauthorized = () => {} }) {
    const profile = global.M1_INSTALLATION_PROFILE, gym = profile?.installationId;
    if (!root || typeof request !== 'function' || typeof getAdmin !== 'function' || typeof getSession !== 'function'
      || global.M1_MANAGER_REVIEW_CONFIG?.reminders !== true || !Object.hasOwn(ORIGINS, gym)
      || global.location?.origin !== ORIGINS[gym] || profile.allowedOrigin !== ORIGINS[gym]
      || global.location?.protocol !== 'https:' || global.location?.port
      || gym === 'richmond' && (profile.environment !== 'production' || profile.activation !== 'active')) return null;
    const document = root.ownerDocument || global.document;
    let generation = 0, active = false, flight = null;
    const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    function clear() { active = false; generation++; root.replaceChildren(); root.hidden = true; }
    function show(text) { root.hidden = false; root.replaceChildren(el('h2', 'Attendance reminders'), el('p', text)); }
    function retry() { const button = el('button', 'Refresh reminder status'); button.type = 'button'; button.className = 'btn'; button.addEventListener('click', open); root.append(button); }
    async function open() {
      if (flight) return flight;
      const owner = getAdmin(), session = getSession(); if (!owner || !session) { clear(); return; }
      active = true; const own = ++generation;
      const current = () => active && own === generation && owner === getAdmin() && session === getSession();
      show('Loading reminder status…');
      const task = (async () => {
        try {
          const value = await request('/api/m1-attendance-workflow', undefined, { method: 'GET', timeoutMs: 15000 });
          if (!current()) return;
          if (!valid(value, gym)) throw new Error('Incomplete status');
          const health = value.current.health;
          show(health.codes.length ? health.codes.map(code => global.GIBM1AttendanceWarning.label(code)).join(' ')
            : health.state === 'attention' ? 'Attendance still needs attention. Use the current correction screens below.' : 'The latest attendance check found nothing outstanding.');
          root.append(el('p', 'Google submission does not confirm inbox delivery. Sending a reminder never resolves the records.'));
          if (health.historicalUnconfirmedCount || health.historicalFailedCount) root.append(el('p', `Past reminders: ${health.historicalUnconfirmedCount} send results unknown; ${health.historicalFailedCount} recorded failures. Original history is retained.`));
          retry();
          for (const entry of value.current.messages.messages) {
            const details = el('details'); details.append(el('summary', entry.date + ' · ' + entry.state));
            if (entry.message) {
              const frame = el('iframe'); frame.title = 'Original reminder · ' + entry.date; frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
              frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">' + entry.message.html; frame.style.width = '100%'; frame.style.height = '420px'; details.append(frame);
            } else details.append(el('p', 'Complete clean check: no email was prepared.'));
            root.append(details);
          }
        } catch (error) {
          if (!current()) return;
          if (error?.status === 401 || error?.status === 403) { clear(); onUnauthorized(); return; }
          show('Attendance reminder status unavailable. Unfinished questions still need review.'); retry();
        } finally { if (flight === task) flight = null; }
      })();
      flight = task; return task;
    }
    return Object.freeze({ open, clear });
  }
  global.GIBM1AttendanceLive = Object.freeze({ create, valid });
})(globalThis);
