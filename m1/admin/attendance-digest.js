(function (global) {
  'use strict';
  const API = '/api/m1-attendance-digest';
  const KEY = 'm1-attendance-digest-test-rev-pending-v1';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const TERMINAL = new Set(['captured', 'suppressed', 'failed', 'expired']);
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

  // The caller supplies the existing exact gym/target/origin pilot gate and an
  // authenticated request adapter. GET must not be translated into a POST.
  // Only the original capture identity is journaled; previews and auth are not.
  function create({ root, request, enabled, target, site, getAdmin, onUnauthorized }) {
    if (enabled !== true || target !== 'test' || site !== 'Rev' || !root
      || typeof request !== 'function' || typeof getAdmin !== 'function') return null;
    const document = root.ownerDocument || global.document;
    let active = false, generation = 0, busy = false, current = false;
    let data = null, pending = null, storageBlocked = false, note = '', flight = null;
    let draftTime = '', timeConfirmed = false;
    const timers = new Map(), downloads = new Set();
    const authenticated = () => Boolean(clean(getAdmin()));
    const live = own => active && generation === own && authenticated();
    const el = (tag, text = '', className = '') => {
      const node = document.createElement(tag);
      node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    function button(label, action, disabled) {
      const node = el('button', label, 'btn');
      node.type = 'button'; node.disabled = disabled;
      node.dataset.digestAction = action;
      return node;
    }
    function remember(value) {
      if (value) {
        const serialized = JSON.stringify(value);
        global.sessionStorage.setItem(KEY, serialized);
        if (global.sessionStorage.getItem(KEY) !== serialized) throw new Error('Journal unavailable');
      } else {
        global.sessionStorage.removeItem(KEY);
        if (global.sessionStorage.getItem(KEY) !== null) throw new Error('Journal unavailable');
      }
      pending = value;
    }
    function restore() {
      try {
        const raw = global.sessionStorage.getItem(KEY);
        if (!raw) { pending = null; return; }
        const value = JSON.parse(raw);
        if (!value || Object.keys(value).sort().join('|') !== 'requestId|startedAt'
          || !UUID.test(value.requestId) || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0) {
          throw new Error('Invalid journal');
        }
        pending = value;
      } catch {
        storageBlocked = true;
        note = 'The previous capture could not be verified on this browser. New captures are paused.';
      }
    }
    function validCapture(value) {
      return value && ['captured', 'suppressed', 'failed'].includes(value.state)
        && clean(value.messageId) && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
        && typeof value.subject === 'string' && typeof value.html === 'string'
        && typeof value.text === 'string' && Array.isArray(value.groups)
        && value.groups.every(group => group && typeof group.name === 'string' && Array.isArray(group.items)
          && group.items.every(item => item && typeof item.summary === 'string'))
        && Array.isArray(value.readFailures)
        && value.readFailures.every(item => item && typeof item.message === 'string');
    }
    function validConfiguration(value) {
      return value?.ok === true && value.target === 'test' && value.sendingEnabled === false
        && value.configuration && validTime(value.configuration.dailyLocalTime)
        && typeof value.configuration.cutoffConfirmed === 'boolean'
        && typeof value.configuration.timezone === 'string'
        && Array.isArray(value.configuration.recipients)
        && value.configuration.recipients.every(person => person && typeof person.name === 'string'
          && (person.address === null || typeof person.address === 'string'));
    }
    function validResponse(value) {
      return validConfiguration(value) && (value.latest === null || validCapture(value.latest));
    }
    function timeControls() {
      const fieldset = el('fieldset');
      fieldset.disabled = busy || !current || Boolean(pending);
      fieldset.append(el('legend', 'Daily message time'));
      const label = el('label', 'Time in ' + data.configuration.timezone);
      label.htmlFor = 'attendanceDigestTime';
      const time = el('input'); time.type = 'time'; time.id = 'attendanceDigestTime';
      time.required = true; time.step = '60'; time.value = draftTime || data.configuration.dailyLocalTime;
      const confirmLabel = el('label');
      const confirm = el('input'); confirm.type = 'checkbox'; confirm.id = 'attendanceDigestConfirm';
      confirm.checked = timeConfirmed;
      confirmLabel.append(confirm, el('span', 'Confirm this is after the final class'));
      const save = button('Save confirmed time', 'configure', fieldset.disabled || !timeConfirmed || !validTime(time.value));
      time.addEventListener('input', () => {
        draftTime = time.value; timeConfirmed = false; confirm.checked = false; save.disabled = true;
      });
      confirm.addEventListener('change', () => {
        timeConfirmed = confirm.checked === true;
        draftTime = time.value;
        save.disabled = fieldset.disabled || !timeConfirmed || !validTime(draftTime);
      });
      fieldset.append(label, time, confirmLabel, save);
      fieldset.append(el('p', 'Saving confirms this cutoff time. Sending remains off in TEST.', 'muted'));
      return fieldset;
    }
    function render() {
      if (!active || !authenticated()) return;
      root.hidden = false;
      root.setAttribute('aria-busy', String(busy));
      root.replaceChildren(el('h2', 'Attendance digest · TEST'));
      root.append(el('p', 'Capture only. No email will be sent.'));
      if (data) {
        const config = data.configuration;
        root.append(el('p', `Daily cutoff: ${config.dailyLocalTime} ${config.timezone}${config.cutoffConfirmed ? '' : ' (not confirmed)'}.`, 'muted'));
        root.append(el('p', 'Recipients: ' + (config.recipients.map(person => `${person.name}: ${clean(person.address) || 'address not configured'}`).join('; ') || 'not configured') + '.', 'muted'));
        root.append(timeControls());
      }
      const controls = el('div', '', 'form-actions');
      controls.append(button('Capture preview', 'capture', busy || !current || Boolean(pending) || storageBlocked),
        button(pending ? 'Check original capture' : 'Refresh status', 'refresh', busy));
      root.append(controls);
      const status = el('p', note || (busy ? 'Checking capture status…' : pending
        ? 'The original capture is not yet confirmed. Check its status before another capture.'
        : current ? 'Ready to capture a preview. Sending remains off.' : 'Capture status unavailable.'), 'message');
      // Admin's shared .message style starts hidden. Match showMessage's
      // explicit display override so progress and failures are actually visible.
      status.style.display = 'block';
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
      const capture = data?.latest;
      if (!capture) return;
      root.append(el('h3', `${pending ? 'Previous preview' : 'Latest preview'} · ${capture.date}`));
      root.append(el('p', capture.subject));
      if (!current) root.append(el('p', 'This is the last loaded preview. Current records could not be checked.', 'manager-warning'));
      if (capture.state === 'failed' || capture.readFailures.length) {
        root.append(el('p', 'Some records could not be checked. This preview does not confirm that everything is resolved.', 'manager-warning'));
        const failures = el('ul');
        capture.readFailures.forEach(failure => failures.append(el('li', failure.message)));
        root.append(failures);
      } else if (capture.state === 'suppressed') {
        root.append(el('p', 'No email was captured: this check found no unresolved items. Sending remains off.'));
      }
      capture.groups.forEach(group => {
        const section = el('div'); section.append(el('strong', group.name));
        const items = el('ul');
        group.items.forEach(item => items.append(el('li', item.summary)));
        section.append(items); root.append(section);
      });
      if (capture.html) {
        const details = el('details'); details.open = true;
        details.append(el('summary', 'Rendered email preview'));
        details.append(el('p', 'Preview links are inactive. No email has been sent.', 'muted'));
        const frame = el('iframe');
        frame.title = 'Captured attendance email preview';
        frame.setAttribute('sandbox', '');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('csp', PREVIEW_CSP);
        frame.style.width = '100%'; frame.style.height = '480px'; frame.style.border = '1px solid #cbd5e1';
        // srcdoc is a DOM property, never an interpolated HTML attribute. The
        // first policy applies before any captured markup can load a resource.
        // The opaque sandbox denies scripts/forms/top navigation/popups; the
        // inert body prevents preview links or controls from being activated.
        frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'
          + PREVIEW_CSP + '"></head><body inert>' + capture.html + '</body></html>';
        details.append(frame); root.append(details);
      }
      if (capture.text) {
        const details = el('details'); details.append(el('summary', 'Read captured message'));
        const text = el('pre', capture.text); text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere';
        details.append(text); root.append(details);
      }
      if (capture.html || capture.text) {
        const actions = el('div', '', 'form-actions');
        if (capture.html) actions.append(button('Download HTML preview', 'html', !current || busy));
        if (capture.text) actions.append(button('Download text preview', 'text', !current || busy));
        root.append(actions);
      }
    }
    function delay(ms) {
      return new Promise(resolve => {
        const id = global.setTimeout(() => { timers.delete(id); resolve(); }, ms);
        timers.set(id, resolve);
      });
    }
    async function send(url, body, deadline) {
      const timeoutMs = Math.max(1, Math.min(12000, deadline - Date.now()));
      let id;
      const timeout = new Promise((_, reject) => {
        const cancel = () => reject(new Error('Capture status unavailable'));
        id = global.setTimeout(() => { timers.delete(id); cancel(); }, timeoutMs);
        timers.set(id, cancel);
      });
      try {
        return await Promise.race([request(url, body, { method: body ? 'POST' : 'GET', timeoutMs }), timeout]);
      } finally { global.clearTimeout(id); timers.delete(id); }
    }
    function accept(value, own) {
      if (!live(own)) return false;
      if (!validResponse(value)) throw new Error('Invalid capture status');
      data = value; current = true;
      if (!pending) return true;
      const result = value.request;
      if (!result || result.requestId !== pending.requestId
        || !['pending', ...TERMINAL].includes(result.state)) {
        throw new Error('Original capture not confirmed');
      }
      if (result.state === 'pending') return false;
      if (['captured', 'suppressed', 'failed'].includes(result.state)
        && (!data.latest || data.latest.messageId !== result.messageId || data.latest.state !== result.state)) {
        throw new Error('Original preview not confirmed');
      }
      remember(null);
      note = result.state === 'captured' ? 'Preview captured. No email was sent.'
        : result.state === 'suppressed' ? 'No email was captured: this check found no unresolved items. Sending remains off.'
        : result.state === 'expired' ? 'The original capture expired without a confirmed preview. No successful check is confirmed.'
        : 'The capture could not check all records. Review the errors below.';
      if (data.latest?.readFailures.length) note = 'Preview captured with read failures. Some records still need a successful check. No email was sent.';
      return true;
    }
    function failure(error, own) {
      if (!live(own)) return;
      current = false; timeConfirmed = false; draftTime = '';
      if (error?.status === 401 || error?.status === 403) {
        clear(); onUnauthorized?.(); return;
      }
      note = pending ? 'The original capture is not confirmed. Check its status before another capture. No new capture was started.'
        : 'Capture status unavailable. Records have not been confirmed.';
    }
    async function read(own, deadline, poll) {
      for (let count = 0; count < (poll ? 12 : 1) && live(own) && Date.now() < deadline; count++) {
        try {
          const value = await send(API + (pending ? `?requestId=${encodeURIComponent(pending.requestId)}` : ''), undefined, deadline);
          if (!live(own)) return;
          if (accept(value, own)) return;
          note = 'Capturing the original preview… No email will be sent.'; render();
        } catch (error) {
          failure(error, own);
          // A failed read cannot establish absence or permission to recapture.
          return;
        }
        if (count < 11 && live(own) && Date.now() + 3000 < deadline) await delay(3000);
      }
      if (live(own) && pending) note = 'The original capture is not yet confirmed. Automatic checking has stopped. Use Check original capture to read its status.';
    }
    function run(capture) {
      if (!active || !authenticated()) { clear(); return Promise.resolve(false); }
      if (flight) return flight;
      if (capture && (!current || pending || storageBlocked)) return Promise.resolve(false);
      const own = generation, deadline = Date.now() + 60000;
      busy = true; timeConfirmed = false; draftTime = '';
      note = storageBlocked ? 'The previous capture could not be verified on this browser. New captures are paused.' : '';
      render();
      const operation = (async () => {
        if (capture) {
          try {
            const requestId = global.crypto?.randomUUID?.();
            if (!UUID.test(requestId)) throw new Error('Capture identity unavailable');
            remember({ requestId, startedAt: Date.now() });
          } catch {
            storageBlocked = true;
            note = 'A capture cannot start because this browser could not preserve its request. No capture was sent.';
            return false;
          }
          try {
            const value = await send(API, { action: 'capture', requestId: pending.requestId }, deadline);
            if (!live(own)) return false;
            // Some accepted POSTs return only a receipt. GET supplies the
            // authenticated preview and verifies the original request identity.
            if (validResponse(value) && accept(value, own)) return true;
          } catch (error) {
            failure(error, own);
            if (!live(own)) return false;
          }
        }
        await read(own, deadline, Boolean(pending));
        return current;
      })();
      flight = operation.finally(() => {
        if (generation !== own) return;
        busy = false; flight = null; render();
      });
      return flight;
    }
    function configure() {
      if (!active || !authenticated()) { clear(); return Promise.resolve(false); }
      if (flight) return flight;
      if (!current || pending || !timeConfirmed || !validTime(draftTime)) return Promise.resolve(false);
      const own = generation, requestedTime = draftTime;
      busy = true; timeConfirmed = false; note = 'Saving the confirmed time…'; render();
      const operation = (async () => {
        try {
          const value = await send(API, { action: 'configure', dailyLocalTime: requestedTime }, Date.now() + 12000);
          if (!live(own)) return false;
          if (!validConfiguration(value) || value.configuration.cutoffConfirmed !== true
            || value.configuration.dailyLocalTime !== requestedTime) throw new Error('Time save not confirmed');
          data = { ...data, configuration: value.configuration }; current = true; draftTime = '';
          note = `Daily time saved: ${requestedTime} ${value.configuration.timezone}. Sending remains off. No email was sent.`;
          return true;
        } catch (error) {
          failure(error, own);
          if (live(own)) note = 'The time save is not confirmed. Refresh status to check the saved time before making another change. Sending remains off.';
          return false;
        }
      })();
      flight = operation.finally(() => {
        if (generation !== own) return;
        busy = false; flight = null; render();
      });
      return flight;
    }
    function download(format) {
      if (!active || !authenticated()) { clear(); return; }
      if (!current || busy || !data?.latest?.[format]) return;
      const blob = new global.Blob([data.latest[format]], { type: format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' });
      const url = global.URL.createObjectURL(blob); downloads.add(url);
      const anchor = el('a'); anchor.href = url;
      anchor.download = `attendance-digest-test-${data.latest.date}.${format === 'html' ? 'html' : 'txt'}`;
      root.append(anchor); anchor.click(); anchor.remove();
      const id = global.setTimeout(() => {
        timers.delete(id); global.URL.revokeObjectURL(url); downloads.delete(url);
      }, 1000);
      timers.set(id, () => {});
    }
    function clear() {
      generation++; active = false; busy = false; current = false; data = null; note = ''; flight = null;
      timeConfirmed = false; draftTime = '';
      timers.forEach((finish, id) => { global.clearTimeout(id); finish(); }); timers.clear();
      downloads.forEach(url => global.URL.revokeObjectURL(url)); downloads.clear();
      root.replaceChildren(); root.hidden = true;
    }
    root.addEventListener('click', event => {
      const control = event.target.closest('[data-digest-action]');
      if (!control || !root.contains(control) || control.disabled) return;
      const action = control.dataset.digestAction;
      if (action === 'capture') void run(true);
      else if (action === 'refresh') void run(false);
      else if (action === 'configure') void configure();
      else if (action === 'html' || action === 'text') download(action);
    });
    root.hidden = true;
    return Object.freeze({
      open() {
        if (!authenticated()) { clear(); return Promise.resolve(false); }
        if (!active) { active = true; storageBlocked = false; restore(); }
        return run(false);
      },
      clear
    });
  }
  global.GIBM1AttendanceDigest = Object.freeze({ create });
})(globalThis);
