(function (global) {
  'use strict';
  const API = '/api/m1-attendance-workflow', KEY = 'm1-attendance-workflow-test-rev-pending-v1';
  const ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
  const ADMIN_URLS = Object.freeze({ rev: ORIGIN + '/m1/admin/', richmond: 'https://gib-richmond-test.netlify.app/m1/admin/' });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
  const text = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const addresses = value => Array.isArray(value) && value.length <= 4 && value.every(address => typeof address === 'string'
    && address.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address));
  function valid(value) {
    const run = value?.latestRun;
    const optional = ['request', 'current', 'setup'].filter(key => Object.hasOwn(value || {}, key));
    return exact(value, ['ok', 'target', 'sendingEnabled', 'recurringEnabled', 'latestRun', ...optional]) && value.ok === true && value.target === 'test'
      && (!Object.hasOwn(value, 'request') || exact(value.request, ['runId', 'state']) && UUID.test(value.request.runId) && value.request.state === 'pending' && run === null)
      && value.sendingEnabled === false && value.recurringEnabled === false && (run === null ||
        exact(run, ['runId', 'complete', 'synthetic', 'scenarios']) && UUID.test(run.runId) && run.complete === true && run.synthetic === true
        && Array.isArray(run.scenarios) && run.scenarios.length > 0 && run.scenarios.length <= 20
        && new Set(run.scenarios.map(scenario => scenario?.key)).size === run.scenarios.length
        && run.scenarios.every(scenario => exact(scenario, ['key', 'title', 'passed', 'summary', 'warnings', 'messages', 'checks'])
          && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(scenario.key) && text(scenario.title, 200) && typeof scenario.passed === 'boolean' && text(scenario.summary, 2000)
          && Array.isArray(scenario.checks) && scenario.checks.length <= 30 && scenario.checks.every(check => text(check, 1000))
          && Array.isArray(scenario.warnings) && scenario.warnings.length <= 12 && scenario.warnings.every(warning => exact(warning, ['code', 'message'])
            && /^[A-Z][A-Z0-9_]{0,79}$/.test(warning.code) && text(warning.message))
          && Array.isArray(scenario.messages) && scenario.messages.length <= 8 && scenario.messages.every(message =>
            exact(message, ['gym', 'name', 'to', 'cc', 'subject', 'html', 'text', 'adminUrl']) && Object.hasOwn(ADMIN_URLS, message.gym)
            && message.adminUrl === ADMIN_URLS[message.gym] && text(message.name, 120) && addresses(message.to) && message.to.length > 0
            && addresses(message.cc) && text(message.subject, 300) && text(message.html, 100000) && text(message.text, 100000))));
  }
  function create({ root, request, enabled, target, site, getAdmin, getSession, onUnauthorized = () => {} }) {
    if (!root || enabled !== true || target !== 'test' || site !== 'Rev' || typeof request !== 'function' || typeof getAdmin !== 'function' || typeof getSession !== 'function'
      || global.location?.origin !== ORIGIN || global.location?.protocol !== 'https:' || global.location?.port
      || global.M1_MANAGER_REVIEW_CONFIG?.enabled !== true || global.M1_MANAGER_REVIEW_CONFIG?.target !== 'test'
      || global.M1_INSTALLATION_PROFILE?.installationId !== 'rev') return null;
    const document = root.ownerDocument || global.document;
    let active = false, generation = 0, owner = '', session = null, flight = null, data = null, current = false, pending = null, storageBlocked = false, note = '', pollTimer = null, pollUntil = 0, pollCount = 0;
    const el = (tag, value = '', className = '') => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
    const live = own => active && generation === own && owner === getAdmin() && session === getSession();
    function retain(value) {
      if (value) { const raw = JSON.stringify(value); global.sessionStorage.setItem(KEY, raw); if (global.sessionStorage.getItem(KEY) !== raw) throw new Error('Journal unavailable'); }
      else { global.sessionStorage.removeItem(KEY); if (global.sessionStorage.getItem(KEY) !== null) throw new Error('Journal unavailable'); }
      pending = value;
    }
    function restore() {
      storageBlocked = false;
      try { const raw = global.sessionStorage.getItem(KEY); pending = raw ? JSON.parse(raw) : null;
        if (pending && (!exact(pending, ['requestId', 'adminName']) || !UUID.test(pending.requestId) || !text(pending.adminName, 120))) throw new Error('Invalid retained run');
      } catch { storageBlocked = true; }
    }
    function render() {
      if (!live(generation)) return;
      root.hidden = false; root.setAttribute('aria-busy', String(Boolean(flight))); root.replaceChildren(el('h2', 'Automatic attendance workflow · TEST'));
      root.append(el('p', 'Synthetic examples run through the workflow with a simulated email provider. No emails are sent and recurring sending is off.', 'manager-warning'));
      root.append(el('p', 'Live setup is unverified: Stu and Trey’s email addresses are not configured; Trey still needs existing Admin access. The actual closing cutoff has not been confirmed.', 'manager-note'));
      root.append(el('p', 'An unreviewed day does not prove a missing sign-in. Every instructor, including a second instructor, must remain covered. Staff Clock finish corrections remain separate.', 'manager-note'));
      const health = data?.current?.health;
      const validHealth = health?.ok === true && health.target === 'test' && Array.isArray(health.codes) && health.codes.length <= 5
        && ['check-overdue', 'check-incomplete', 'delivery-failed', 'delivery-unconfirmed', 'not-configured', 'attention', 'clear'].includes(health.state)
        && health.codes.every(code => global.GIBM1AttendanceWarning?.label(code))
        && [health.pendingCount, health.failedCount, health.unconfirmedCount].every(count => Number.isSafeInteger(count) && count >= 0)
        && (health.checkedAt === null || typeof health.checkedAt === 'string' && Number.isFinite(Date.parse(health.checkedAt)));
      root.append(el('p', !current || !validHealth ? 'Current attendance check status unavailable.'
        : health.codes.length ? 'Current status: ' + health.codes.map(code => global.GIBM1AttendanceWarning.label(code)).join(' ')
          : health.state === 'attention' ? 'Attendance still needs review in the existing correction tools.'
            : health.state === 'clear' && health.checkedAt && Date.now() - Date.parse(health.checkedAt) >= -5000
              && Date.now() - Date.parse(health.checkedAt) <= 1800000 && Date.parse(health.expiresAt) > Date.now()
              && health.pendingCount === 0 && health.failedCount === 0 && health.unconfirmedCount === 0
              ? 'Current attendance check completed.' : 'Current attendance check status unavailable.', 'manager-note'));
      const controls = el('div', '', 'manager-controls');
      for (const [action, label] of [['refresh', pending ? 'Check original example run' : 'Refresh workflow examples'], ['run', pending ? 'Retry original example run' : 'Run synthetic workflow examples']]) {
        const button = el('button', label, 'btn'); button.type = 'button'; button.dataset.workflowAction = action;
        button.disabled = Boolean(flight) || action === 'run' && (storageBlocked || pending && pending.adminName !== owner); controls.append(button);
      }
      root.append(controls);
      const status = el('p', storageBlocked ? 'The original example request could not be retained safely. New example runs are blocked; existing requests are preserved.'
        : pending && pending.adminName !== owner ? 'Another reviewer’s original example run still needs confirmation. Reopen as that reviewer to retry.'
          : note || 'No confirmed workflow example run yet.', 'message');
      status.style.display = 'block'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
      if (!data?.latestRun) return;
      if (!current) root.append(el('p', 'Previously loaded examples are shown below. Current workflow status is unavailable.', 'manager-warning'));
      root.append(el('p', 'Synthetic run: ' + data.latestRun.runId, 'manager-note'));
      for (const scenario of data.latestRun.scenarios) {
        const article = el('details', '', 'manager-class'); article.open = scenario.key === 'routing';
        article.append(el('summary', (scenario.passed ? 'Passed · ' : 'Needs attention · ') + scenario.title));
        article.append(el('p', (scenario.passed ? 'Example passed: ' : 'Example needs attention: ') + scenario.summary, scenario.passed ? 'manager-success' : 'manager-warning'));
        for (const warning of scenario.warnings) article.append(el('p', global.GIBM1AttendanceWarning?.label(warning.code) || warning.message, 'manager-warning'));
        const checks = el('ul'); scenario.checks.forEach(check => checks.append(el('li', check))); article.append(checks);
        for (const message of scenario.messages) {
          const details = el('details'); details.open = true; details.append(el('summary', message.name + ' · simulated email'));
          details.append(el('p', 'To: ' + message.to.join(', ') + (message.cc.length ? ' · CC: ' + message.cc.join(', ') : '')));
          details.append(el('p', 'Subject: ' + message.subject));
          const frame = el('iframe'); frame.title = scenario.title + ' — ' + message.name + ' simulated email';
          frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('csp', CSP);
          frame.style.width = '100%'; frame.style.height = '360px'; frame.style.border = '1px solid #cbd5e1';
          frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + CSP + '"></head><body inert>' + message.html + '</body></html>';
          details.append(frame, el('p', 'Links inside this synthetic preview are inactive.', 'manager-note'));
          const plain = el('details'); plain.append(el('summary', 'Read plain text')); const pre = el('pre', message.text);
          pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere'; plain.append(pre); details.append(plain);
          if (current) { const link = el('a', 'Open ' + message.name + ' TEST correction tools', 'btn'); link.href = message.adminUrl; details.append(link); }
          article.append(details);
        }
        root.append(article);
      }
    }
    async function run(send = false, polling = false) {
      if (!live(generation)) return;
      if (flight) return flight;
      if (polling && Date.now() >= pollUntil) { note = 'The original example run is not yet confirmed. Use Check original example run to continue; its request ID is retained.'; render(); return; }
      if (send && (storageBlocked || pending && pending.adminName !== owner)) return;
      if (send && !pending) {
        try { const requestId = global.crypto.randomUUID(); if (!UUID.test(requestId)) throw new Error('Invalid identity'); retain({ requestId, adminName: owner }); }
        catch { storageBlocked = true; render(); return; }
      }
      global.clearTimeout(pollTimer);
      if (!polling) { pollUntil = Date.now() + 120000; pollCount = 0; }
      const own = generation, original = pending?.requestId || null;
      current = false; note = send ? 'Running isolated synthetic examples…' : 'Loading confirmed workflow examples…';
      const task = (async () => {
        try {
          const result = await Promise.resolve().then(() => send ? request(API, { action: 'runExamples', requestId: original }, { timeoutMs: 25000 })
            : request(API + (original ? '?runId=' + encodeURIComponent(original) : ''), undefined, { method: 'GET', timeoutMs: 25000 }));
          if (!live(own)) return;
          if (!valid(result) || original && result.latestRun && result.latestRun.runId !== original
            || result.request && result.request.runId !== original || send && !result.latestRun && !result.request) throw new Error('Unconfirmed workflow run');
          data = result; current = true;
          if (original && result.latestRun?.runId === original) { retain(null); note = 'The original synthetic run is confirmed centrally. No real email was sent.'; }
          else note = original ? 'The original synthetic run is still waiting for confirmation. Checking it automatically; its request ID is retained.'
            : result.latestRun ? 'Saved synthetic examples loaded. No real email was sent.' : 'No confirmed workflow example run yet.';
        } catch (error) {
          if (!live(own)) return;
          current = false; note = pending ? 'The original example run is not confirmed. Check or retry that same run; its request ID is retained.' : 'Attendance workflow status unavailable. Unfinished days still need review.';
          if (error?.status === 401 || error?.status === 403) onUnauthorized();
        } finally {
          if (flight === task) flight = null;
          if (live(own)) {
            if (pending && !storageBlocked && pending.adminName === owner && Date.now() < pollUntil && !document.hidden) {
              pollTimer = global.setTimeout(() => { if (live(own)) void run(false, true); }, pollCount++ === 0 ? 1000 : 3000);
            } else if (pending && Date.now() >= pollUntil) note = 'The original example run is not yet confirmed. Use Check original example run to continue; its request ID is retained.';
            render();
          }
        }
      })();
      flight = task; render(); return task;
    }
    root.addEventListener('click', event => { const action = event.target.closest('[data-workflow-action]')?.dataset.workflowAction;
      if (action === 'refresh') void run(); if (action === 'run') void run(true); });
    function clear() { active = false; generation++; global.clearTimeout(pollTimer); owner = ''; session = null; flight = null; data = null; current = false; root.hidden = true; root.replaceChildren(); }
    return Object.freeze({ open() {
      if (active && owner === getAdmin() && session === getSession()) return run();
      clear(); owner = getAdmin(); session = getSession(); active = text(owner, 120); if (!active) return Promise.resolve(); restore(); return run();
    }, refresh: () => run(), clear });
  }
  global.GIBM1AttendanceWorkflow = Object.freeze({ create, valid });
})(globalThis);
