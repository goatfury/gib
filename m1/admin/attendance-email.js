(function (global) {
  'use strict';
  const API = '/api/m1-attendance-digest-email';
  const MESSAGE_ID = 'm1-test-email-andrew-20260926-v1';
  const STATES = new Set(['not-started', 'disabled', 'pending', 'unknown', 'accepted', 'rejected', 'blocked']);
  const LINKS = [
    ['Example sign-in review · September 26', 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/?reviewDate=2026-09-26#sign-ins'],
    ['Example Staff Clock review', 'https://deploy-preview-89--gib-live.netlify.app/m1/admin/#staff-time']
  ];
  const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function validDelivery(value, message) {
    return value && STATES.has(value.state) && value.messageId === message?.messageId && value.hash === message.hash
      && value.deliveryConfirmed === false && typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code)
      && Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0 && value.attemptCount <= 64
      && typeof value.retryAllowed === 'boolean'
      && (!value.retryAllowed || (['unknown', 'rejected'].includes(value.state) && value.attemptCount > 0
        && Number.isSafeInteger(value.retryBefore) && value.retryBefore > 0))
      && (value.state !== 'not-started' || (value.attemptCount === 0 && !value.retryAllowed))
      && (!['pending', 'rejected', 'accepted'].includes(value.state) || value.attemptCount > 0)
      && (value.state !== 'accepted' || (!value.retryAllowed && UUID.test(value.providerId)
        && Number.isSafeInteger(value.acceptedAt) && value.acceptedAt >= 0));
  }
  function valid(value) {
    const message = value?.message;
    return value?.ok === true && value.target === 'test' && typeof value.sendingEnabled === 'boolean'
      && value.recurringEnabled === false && value.provider === 'resend'
      && message?.messageId === MESSAGE_ID && validDelivery(value.delivery, message)
      && /^[0-9a-f]{64}$/.test(message.hash) && message.synthetic === true && message.target === 'test'
      && typeof message.from === 'string' && clean(message.from) && message.from.length <= 320 && !/[\r\n]/.test(message.from)
      && Array.isArray(message.to) && message.to.length === 1 && email(message.to[0])
      && typeof message.subject === 'string' && clean(message.subject) && message.subject.length <= 300 && !/[\r\n]/.test(message.subject)
      && typeof message.html === 'string' && message.html.length > 0 && message.html.length <= 100000
      && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 100000
      && value.recipientSettings?.andrew?.address === message.to[0]
      && value.recipientSettings.andrew.source === 'user-confirmed TEST recipient'
      && value.recipientSettings.stu?.address === null;
  }
  function create({ root, request, enabled, target, site, getAdmin, onUnauthorized }) {
    if (enabled !== true || target !== 'test' || site !== 'Rev' || !root
      || typeof request !== 'function' || typeof getAdmin !== 'function') return null;
    const document = root.ownerDocument || global.document;
    let active = false, generation = 0, owner = '', busy = false, current = false, data = null, note = '', flight = null, original = null, accepted = false;
    const reviewer = () => clean(getAdmin());
    const el = (tag, text = '', className = '') => {
      const node = document.createElement(tag); node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    function clear() {
      generation++; active = false; owner = ''; busy = false; current = false; data = null; note = ''; flight = null; original = null; accepted = false;
      root.replaceChildren(); root.hidden = true;
    }
    function stillCurrent(own) {
      if (!active || own !== generation) return false;
      if (!owner || reviewer() !== owner) { clear(); return false; }
      return true;
    }
    function deliveryText(state) {
      if (original && state === 'not-started') return 'Send outcome unknown. No retained attempt was found; delivery is not confirmed.';
      return {
        'not-started': 'No send has been started.',
        disabled: 'Sending is disabled. Check the retained status; delivery is not confirmed.',
        pending: 'A send request is pending. Delivery is not confirmed.',
        unknown: 'Send outcome unknown. Delivery is not confirmed.',
        accepted: 'Accepted by Resend. Delivery to the inbox is not confirmed.',
        rejected: 'Rejected by Resend. No delivery is confirmed.',
        blocked: 'Sending is blocked. No delivery is confirmed.'
      }[state];
    }
    function canSend() {
      if (!active || reviewer() !== owner || busy || accepted || !current || data?.sendingEnabled !== true) return false;
      if (original && (data.message.messageId !== original.messageId || data.message.hash !== original.hash)) return false;
      return (!original && data.delivery.state === 'not-started')
        || (['unknown', 'rejected'].includes(data.delivery.state) && data.delivery.retryAllowed === true);
    }
    function render() {
      if (!stillCurrent(generation)) return;
      root.hidden = false; root.setAttribute('aria-busy', String(busy));
      root.replaceChildren(el('h2', 'Proposed single TEST email'));
      root.append(el('p', 'The approved single TEST email and its retained send status. Recurring sending stays off.'));
      const refresh = el('button', 'Refresh preview', 'btn');
      refresh.type = 'button'; refresh.disabled = busy; refresh.dataset.emailAction = 'refresh';
      root.append(refresh);
      if (canSend()) {
        const retry = data.delivery.state !== 'not-started';
        const send = el('button', retry ? 'Retry this same TEST email' : 'Send approved TEST email', 'btn');
        send.type = 'button'; send.dataset.emailAction = 'send'; root.append(send);
        if (retry) root.append(el('p', 'The server permits recovery of this exact original message. This does not create a new message.', 'muted'));
      }
      const status = el('p', note || (busy ? 'Loading email preview…' : 'Email preview status unavailable.'), 'message');
      status.style.display = 'block'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.append(status);
      if (!data) return;
      if (!current) root.append(el('p', 'Stale preview: this is the last loaded message. Current send status is unknown.', 'manager-warning'));
      else {
        root.append(el('p', deliveryText(data.delivery.state)));
        root.append(el('p', data.sendingEnabled
          ? 'Only the separately approved single TEST message can be sent. Recurring sending is off.'
          : 'Sending is off. Recurring sending is off.', 'muted'));
      }
      const message = data.message;
      root.append(el('p', 'To: ' + message.to[0]));
      root.append(el('p', 'Recipient source: user-confirmed TEST recipient. Stu: address not configured.', 'muted'));
      root.append(el('p', 'From: ' + message.from)); root.append(el('p', 'Subject: ' + message.subject));
      root.append(el('p', 'Synthetic examples only. These examples do not describe actual recorded work.', 'manager-warning'));
      const details = el('details'); details.open = true; details.append(el('summary', 'Rendered email preview'));
      details.append(el('p', 'Links and controls inside this preview are inactive.', 'muted'));
      const frame = el('iframe'); frame.title = 'Proposed single TEST email preview';
      frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('csp', PREVIEW_CSP);
      frame.style.width = '100%'; frame.style.height = '480px'; frame.style.border = '1px solid #cbd5e1';
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'
        + PREVIEW_CSP + '"></head><body inert>' + message.html + '</body></html>';
      details.append(frame); root.append(details);
      const plain = el('details'); plain.append(el('summary', 'Read plain text'));
      const text = el('pre', message.text); text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; plain.append(text); root.append(plain);
      if (current) {
        const links = LINKS.filter(([, url]) => message.text.includes(url)
          || message.html.includes('href="' + url + '"') || message.html.includes("href='" + url + "'"));
        if (links.length) {
          root.append(el('p', 'Open the TEST tools used by these synthetic examples:', 'muted'));
          const actions = el('div', '', 'form-actions');
          links.forEach(([label, url]) => {
            const anchor = el('a', label, 'btn'); anchor.href = url; actions.append(anchor);
          });
          root.append(actions);
        }
      }
    }
    function open() {
      const admin = reviewer();
      if (!admin) { clear(); return Promise.resolve(false); }
      if (active && owner !== admin) clear();
      if (flight) return flight;
      active = true; owner = admin; busy = true; current = false;
      note = data ? 'Refreshing preview… The last preview is stale until this read completes.' : 'Loading email preview…';
      const own = generation; render();
      const operation = (async () => {
        try {
          const value = await request(API, undefined, { method: 'GET', timeoutMs: 12000 });
          if (!stillCurrent(own)) return false;
          if (!valid(value)) throw new Error('Incomplete email preview');
          if (original && (value.message.messageId !== original.messageId || value.message.hash !== original.hash)) throw new Error('Original message changed');
          if (accepted && value.delivery.state !== 'accepted') throw new Error('Provider acceptance status changed');
          if (value.delivery.state === 'accepted') accepted = true;
          data = value; current = true; note = 'Preview loaded. Retained send status checked.';
          return true;
        } catch (error) {
          if (!stillCurrent(own)) return false;
          if (error?.status === 401) { clear(); if (typeof onUnauthorized === 'function') onUnauthorized(); return false; }
          current = false; note = 'Email preview status unavailable. Current send status could not be confirmed.';
          return false;
        }
      })();
      flight = operation.finally(() => {
        if (!stillCurrent(own)) return;
        busy = false; flight = null; render();
      });
      return flight;
    }
    function send() {
      if (!stillCurrent(generation) || !canSend() || flight) return Promise.resolve(false);
      original = original || Object.freeze({ action: 'sendApprovedTest', messageId: data.message.messageId, hash: data.message.hash });
      const retainedOriginal = original, own = generation, message = data.message;
      busy = true; current = false; note = 'Sending the approved single TEST email. Waiting for its retained outcome…'; render();
      const operation = (async () => {
        let receipt = null;
        try {
          let reply;
          try { reply = await request(API, retainedOriginal, { method: 'POST', timeoutMs: 30000 }); }
          catch (error) {
            if (!stillCurrent(own)) return false;
            if (error?.status === 401) { clear(); if (typeof onUnauthorized === 'function') onUnauthorized(); return false; }
            reply = error?.data;
          }
          if (!stillCurrent(own)) return false;
          if (reply?.target === 'test' && reply.recurringEnabled === false
            && typeof reply.ok === 'boolean' && validDelivery(reply.delivery, message)
            && reply.ok === (reply.delivery.state === 'accepted')) receipt = reply.delivery;
          if (receipt?.state === 'accepted') accepted = true;
          note = (receipt ? deliveryText(receipt.state) + ' ' : 'The send result is not yet confirmed. ')
            + 'Checking the retained outcome…'; render();
          // A single read resolves a lost reply. Recovery never automatically sends.
          const value = await request(API, undefined, { method: 'GET', timeoutMs: 12000 });
          if (!stillCurrent(own)) return false;
          if (!valid(value) || value.message.messageId !== retainedOriginal.messageId || value.message.hash !== retainedOriginal.hash)
            throw new Error('Original email outcome unavailable');
          data = value; current = true;
          if (value.delivery.state === 'accepted') accepted = true;
          note = receipt?.state === 'accepted' && value.delivery.state !== 'accepted'
            ? 'Provider acceptance was confirmed, but the retained status changed. Delivery is not confirmed; further sending is blocked.'
            : 'Retained send outcome checked. ' + deliveryText(value.delivery.state);
          if (receipt?.state === 'accepted' && value.delivery.state !== 'accepted') current = false;
          return true;
        } catch (error) {
          if (!stillCurrent(own)) return false;
          if (error?.status === 401) { clear(); if (typeof onUnauthorized === 'function') onUnauthorized(); return false; }
          current = false;
          note = (receipt ? deliveryText(receipt.state) + ' ' : 'Send outcome unknown. ')
            + 'The retained status could not be refreshed. Use Refresh preview; no automatic retry will be sent.';
          return false;
        }
      })();
      flight = operation.finally(() => {
        if (!stillCurrent(own)) return;
        busy = false; flight = null; render();
      });
      return flight;
    }
    root.addEventListener('click', event => {
      const control = event.target.closest('[data-email-action]');
      if (!control || !root.contains(control) || control.disabled) return;
      if (control.dataset.emailAction === 'refresh') void open();
      else if (control.dataset.emailAction === 'send') void send();
    });
    root.hidden = true;
    return Object.freeze({ open, clear });
  }
  global.GIBM1AttendanceEmail = Object.freeze({ create });
})(globalThis);
