(function (global) {
  'use strict';
  const API = '/api/m1-attendance-google-email';
  const KEY = 'm1-attendance-google-email-test-rev-original-v1';
  const ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
  const MESSAGE_ID = 'm1-test-scheduled-rev-2026-09-28', ADDRESS = 'revbjjops@gmail.com';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const STATES = new Set(['not-started', 'disabled', 'pending', 'unknown', 'submitted', 'rejected', 'blocked']);
  const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  function valid(value) {
    const m = value?.message, d = value?.delivery, r = value?.request, checks = value?.readiness;
    return value?.ok === true && value.target === 'test' && value.provider === 'mailapp' && value.recurringEnabled === false && typeof value.sendingEnabled === 'boolean'
      && exact(m, ['messageId', 'hash', 'from', 'to', 'cc', 'subject', 'html', 'text', 'synthetic', 'target'])
      && m.messageId === MESSAGE_ID && /^[0-9a-f]{64}$/.test(m.hash) && m.from === ADDRESS
      && Array.isArray(m.to) && m.to.length === 1 && m.to[0] === ADDRESS && Array.isArray(m.cc) && m.cc.length === 0
      && m.synthetic === true && m.target === 'test' && text(m.subject, 300) && !/[\r\n]/.test(m.subject)
      && text(m.html, 100000) && text(m.text, 100000)
      && d?.provider === 'mailapp' && d.messageId === m.messageId && d.hash === m.hash && STATES.has(d.state)
      && /^[A-Z0-9_]{1,80}$/.test(d.code) && d.deliveryConfirmed === false && typeof d.retryAllowed === 'boolean'
      && Number.isSafeInteger(d.attemptCount) && d.attemptCount >= 0 && d.attemptCount <= 6
      && (d.state !== 'not-started' || d.attemptCount === 0 && !d.retryAllowed)
      && (d.state !== 'submitted' || d.attemptCount > 0 && d.durableAttempt === true && !d.retryAllowed
        && d.googleResult?.ok === true && d.googleResult.target === 'test' && d.googleResult.gym === 'rev'
        && d.googleResult.messageId === m.messageId && d.googleResult.hash === m.hash
        && d.googleResult.state === 'submitted' && d.googleResult.code === 'MAILAPP_SUBMITTED' && d.googleResult.retrySafe === false
        && iso(d.googleResult.attemptedAt) && iso(d.googleResult.completedAt)
        && Date.parse(d.googleResult.completedAt) >= Date.parse(d.googleResult.attemptedAt))
      && (value.requestId === null || UUID.test(value.requestId))
      && exact(r, ['requestId', 'state']) && r.requestId === value.requestId
      && ['prepared', 'pending', 'complete', 'disabled'].includes(r.state)
      && (!['prepared', 'pending', 'complete'].includes(r.state) || UUID.test(r.requestId))
      && exact(checks, ['ready', 'oneMessageOnly', 'exactRecipientApproved', 'generalSendingEnabled', 'expiresAt', 'codes'])
      && checks.ready === value.sendingEnabled && checks.oneMessageOnly === true && checks.exactRecipientApproved === true
      && checks.generalSendingEnabled === false && Number.isSafeInteger(checks.expiresAt) && checks.expiresAt > 0
      && Array.isArray(checks.codes) && checks.codes.length <= 12 && checks.codes.every(code => /^[A-Z0-9_]{1,80}$/.test(code))
      && (!checks.ready || checks.codes.length === 0);
  }
  function create({ root, request, enabled, target, site, getAdmin, getSession, onUnauthorized = () => {} }) {
    if (!root || enabled !== true || target !== 'test' || site !== 'Rev' || typeof request !== 'function'
      || typeof getAdmin !== 'function' || typeof getSession !== 'function'
      || global.location?.origin !== ORIGIN || global.location?.protocol !== 'https:' || global.location?.port
      || new URLSearchParams(global.location?.search || '').get('emailTest') !== 'google-v1'
      || global.location?.hash !== '#attendanceGoogleEmail'
      || global.M1_MANAGER_REVIEW_CONFIG?.enabled !== true || global.M1_MANAGER_REVIEW_CONFIG?.target !== 'test'
      || global.M1_INSTALLATION_PROFILE?.installationId !== 'rev') return null;
    const document = root.ownerDocument || global.document;
    let active = false, generation = 0, owner = '', session = '', flight = null, busy = false;
    let data = null, current = false, original = null, storageBlocked = false, submitted = false, note = '';
    let pollTimer = null, pollUntil = 0, pollCount = 0;
    const el = (tag, value = '', className = '') => { const n = document.createElement(tag); n.textContent = value; if (className) n.className = className; return n; };
    function stopPolling() { if (pollTimer !== null) global.clearTimeout(pollTimer); pollTimer = null; }
    function clear() {
      stopPolling(); generation++; active = false; owner = ''; session = ''; flight = null; busy = false;
      data = null; current = false; original = null; storageBlocked = false; submitted = false; note = ''; pollUntil = 0; pollCount = 0;
      root.replaceChildren(); root.hidden = true;
    }
    function live(own) {
      if (!active || own !== generation) return false;
      if (owner !== getAdmin() || session !== getSession()) { clear(); return false; }
      return true;
    }
    function restore() {
      try {
        const raw = global.sessionStorage.getItem(KEY);
        const retained = raw === null ? null : JSON.parse(raw);
        if (raw !== null && (!exact(retained, ['messageId', 'hash', 'requestId', 'submitted']) || retained.messageId !== MESSAGE_ID
          || !/^[0-9a-f]{64}$/.test(retained.hash) || !UUID.test(retained.requestId) || typeof retained.submitted !== 'boolean')) throw new Error('Original request invalid');
        original = retained; submitted = retained?.submitted === true; storageBlocked = false;
      } catch { storageBlocked = true; }
    }
    function retain(message, requestId, completed = false) {
      const next = { messageId: message.messageId, hash: message.hash, requestId, submitted: completed || submitted };
      // Keep this one-message latch even after confirmation. Never erase other journals.
      original = next; submitted = next.submitted;
      try {
        const raw = JSON.stringify(next); global.sessionStorage.setItem(KEY, raw);
        if (global.sessionStorage.getItem(KEY) !== raw) throw new Error('Original request unconfirmed');
      } catch { storageBlocked = true; return false; }
      return true;
    }
    function canSend() {
      return active && !busy && current && !original && !storageBlocked && !submitted
        && data?.sendingEnabled === true && data.delivery.state === 'not-started' && data.delivery.attemptCount === 0
        && data.request.state === 'prepared';
    }
    function outcome() {
      if (submitted) return 'Submitted to Google: the Google mail call completed. Arrival in the inbox has not been verified.';
      if (original && data?.delivery.state === 'not-started') return 'The original send result is unconfirmed. No second send is allowed; check the original result.';
      return {
        'not-started': 'No send has been started.', disabled: 'Sending is off. No inbox delivery is confirmed.',
        pending: 'The original request is still being checked. No second send is allowed.',
        unknown: 'The original send result is unconfirmed. Check the original result; do not send again.',
        rejected: 'Google did not confirm a completed mail call. This one-shot page will not send again.',
        blocked: 'The original result cannot be confirmed safely. Sending is blocked.'
      }[data?.delivery.state] || 'Email status unavailable.';
    }
    function render() {
      if (!live(generation)) return;
      root.hidden = false; root.setAttribute('aria-busy', String(busy)); root.replaceChildren(el('h2', 'One real Google TEST email'));
      root.append(el('p', 'This sends the approved synthetic TEST email once to the business test inbox. It does not send to Stu or Trey. Recurring sending stays off.', 'manager-warning'));
      const controls = el('div', '', 'form-actions');
      const refresh = el('button', 'Refresh status', 'btn'); refresh.type = 'button'; refresh.dataset.googleEmailAction = 'refresh'; refresh.disabled = busy; controls.append(refresh);
      if (canSend()) { const send = el('button', 'Send approved Google TEST email once', 'btn'); send.type = 'button'; send.dataset.googleEmailAction = 'send'; controls.append(send); }
      if (original && !submitted && !storageBlocked) { const check = el('button', 'Check original result', 'btn'); check.type = 'button'; check.dataset.googleEmailAction = 'check'; check.disabled = busy; controls.append(check); }
      root.append(controls);
      const status = el('p', storageBlocked ? 'The original request could not be retained safely. Sending is blocked; existing browser records are preserved.'
        : note || 'Email preview status unavailable.', 'message');
      status.style.display = 'block'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
      if (!data) return;
      if (!current) root.append(el('p', 'This is the last loaded preview. Current email status is unavailable; sending is blocked.', 'manager-warning'));
      if (current || submitted) root.append(el('p', outcome(), submitted ? 'manager-note' : 'manager-warning'));
      root.append(el('p', data.sendingEnabled && current && !original ? 'The one approved send is enabled. Recurring sending is off.' : 'No new send is available. Recurring sending is off.', 'muted'));
      const m = data.message;
      root.append(el('p', 'From: ' + m.from), el('p', 'To: ' + m.to[0]), el('p', 'CC: none'), el('p', 'Subject: ' + m.subject));
      root.append(el('p', 'Synthetic examples only. Sending this email changes no attendance, clock records or review warnings.', 'muted'));
      const details = el('details'); details.open = true; details.append(el('summary', 'Exact approved email preview'));
      const frame = el('iframe'); frame.title = 'Approved Google TEST email'; frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('csp', CSP);
      frame.style.width = '100%'; frame.style.height = '480px'; frame.style.border = '1px solid #cbd5e1';
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + CSP + '"></head><body inert>' + m.html + '</body></html>';
      details.append(frame, el('p', 'Preview links are inactive.', 'muted')); root.append(details);
      const plain = el('details'); plain.append(el('summary', 'Read exact plain text')); const pre = el('pre', m.text); pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere'; plain.append(pre); root.append(plain);
    }
    function accept(value) {
      if (!valid(value)) throw new Error('Incomplete original result');
      if (original && (original.messageId !== value.message.messageId || original.hash !== value.message.hash
        || original.requestId !== value.requestId)) throw new Error('Original request changed');
      if (submitted && value.delivery.state !== 'submitted') throw new Error('Confirmed result changed');
      if (!original && (value.delivery.attemptCount > 0 || ['pending', 'complete'].includes(value.request.state))) {
        if (!UUID.test(value.requestId)) throw new Error('Original request unavailable');
        retain(value.message, value.requestId, value.delivery.state === 'submitted');
      } else if (value.delivery.state === 'submitted') retain(value.message, value.requestId, true);
      data = value; current = true; note = value.request.state === 'pending' ? 'Waiting for the original result. Only its saved status is being checked.' : 'Original email status checked. ' + outcome();
    }
    function schedulePoll() {
      stopPolling();
      if (!active || !current || data?.request.state !== 'pending' || document.hidden) return;
      if (Date.now() >= pollUntil || pollCount >= 40) {
        note = 'The original result is still pending. Automatic checking has stopped; Check original result will check without sending again.'; render(); return;
      }
      const own = generation; pollTimer = global.setTimeout(() => {
        pollTimer = null; if (!live(own) || document.hidden) return;
        if (Date.now() >= pollUntil) { schedulePoll(); return; }
        pollCount++; void load(false);
      }, 3000);
    }
    function handleError(error, own) {
      if (!live(own)) return;
      if (error?.status === 401) { clear(); onUnauthorized(); return; }
      current = false; note = original ? 'The original email result is unavailable. Use Check original result when the connection returns. No second send will be made.'
        : 'Email preview status unavailable. Nothing can be sent until a fresh preview is confirmed.';
    }
    function operation(action) {
      if (!live(generation) || flight) return flight || Promise.resolve(false);
      stopPolling(); const own = generation; busy = true; current = false;
      note = action === 'sendApprovedTest' ? 'Sending the one approved email. Waiting for its original result…'
        : action === 'checkOriginal' ? 'Checking the original Google result. No email is being sent again…' : 'Loading the saved original status…'; render();
      const run = (async () => {
        try {
          const body = action ? { action, messageId: original.messageId, hash: original.hash } : undefined;
          let value;
          try { value = await request(API, body, { method: action ? 'POST' : 'GET', timeoutMs: action ? 30000 : 12000 }); }
          catch (error) { if (error?.data?.ok === true) value = error.data; else throw error; }
          if (!live(own)) return false;
          accept(value); return true;
        } catch (error) { handleError(error, own); return false; }
      })();
      flight = run.finally(() => { if (!live(own)) return; busy = false; flight = null; render(); schedulePoll(); });
      return flight;
    }
    function load(resetWindow = true) {
      if (resetWindow) { pollUntil = Date.now() + 120000; pollCount = 0; }
      return operation(null);
    }
    function open() {
      if (!text(getAdmin(), 120) || !text(getSession(), 1000)) { clear(); return Promise.resolve(false); }
      if (active && (owner !== getAdmin() || session !== getSession())) clear();
      if (flight) return flight;
      if (!active) { active = true; owner = getAdmin(); session = getSession(); restore(); }
      return load();
    }
    function send() {
      if (!live(generation) || !canSend()) return Promise.resolve(false);
      if (!retain(data.message, data.requestId)) { render(); return Promise.resolve(false); }
      pollUntil = Date.now() + 120000; pollCount = 0; return operation('sendApprovedTest');
    }
    function check() {
      if (!live(generation) || !original || storageBlocked || submitted || flight) return Promise.resolve(false);
      pollUntil = Date.now() + 120000; pollCount = 0; return operation('checkOriginal');
    }
    root.addEventListener('click', event => {
      const control = event.target.closest('[data-google-email-action]');
      if (!control || !root.contains(control) || control.disabled) return;
      if (control.dataset.googleEmailAction === 'refresh') void open();
      else if (control.dataset.googleEmailAction === 'send') void send();
      else if (control.dataset.googleEmailAction === 'check') void check();
    });
    root.hidden = true;
    return Object.freeze({ open, clear });
  }
  global.GIBM1AttendanceGoogleEmail = Object.freeze({ create });
})(globalThis);
