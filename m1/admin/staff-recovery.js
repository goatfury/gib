(() => {
  'use strict';
  const endpoint = '/.netlify/functions/m1-admin-staff-time';
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const requestId = new RegExp(`^gib-m1-staff-request-${uuid}$`);
  const punchId = new RegExp(`^gib-m1-staff-${uuid}$`);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const keys = (value, expected) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
  const text = (value, maximum = 120) => typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value === value.normalize('NFKC').trim().replace(/\s+/g, ' ') && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const timestamp = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-(?:04|05):00$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === value.slice(0, 19);
  };
  const receiptFields = ['requestId', 'recoveryRequestId', 'revision', 'decision', 'finishAt', 'punchId', 'reason', 'adminName', 'decidedAt'];
  const bodyFields = ['operation', 'requestId', 'recoveryRequestId', 'revision', 'decision', 'finishAt', 'punchId', 'reason'];
  const itemFields = ['requestId', 'staffId', 'staffName', 'previousClockInPunchId', 'previousClockInAt', 'newClockInPunchId', 'startedAt', 'proposedFinishAt', 'proposedBy', 'proposedAt', 'status', 'revision', 'decision', 'punch', 'conflicts'];
  const conflictLabels = { 'previous-punch-void': 'Earlier clock-in was removed', 'new-punch-void': 'New shift clock-in was removed', 'finish-punch-void': 'Approved finish was removed' };
  const punchFields = ['punchId', 'timestamp', 'date', 'staffId', 'staffName', 'punchAction', 'site', 'device', 'build', 'note'];
  const boundedFinish = (value, item) => timestamp(value) && Date.parse(value) > Date.parse(item.previousClockInAt)
    && Date.parse(value) <= Date.parse(item.startedAt) && Date.parse(value) - Date.parse(item.previousClockInAt) <= 18 * 60 * 60 * 1000;
  function validDecision(value, isBody = false) {
    return keys(value, isBody ? bodyFields : receiptFields) && (!isBody || value.operation === 'recoveryDecide')
      && requestId.test(value.requestId) && requestId.test(value.recoveryRequestId)
      && Number.isSafeInteger(value.revision) && value.revision >= (isBody ? 0 : 1)
      && text(value.reason, 240) && value.reason.length >= 3 && !/^[=+\-@]/.test(value.reason)
      && (value.decision === 'approve' ? timestamp(value.finishAt) && punchId.test(value.punchId)
        : value.decision === 'reject' && value.finishAt === null && value.punchId === null)
      && (isBody || (text(value.adminName) && timestamp(value.decidedAt)));
  }
  function validItem(item) {
    if (!keys(item, itemFields) || !requestId.test(item.requestId) || !text(item.staffId) || !text(item.staffName)
      || !punchId.test(item.previousClockInPunchId) || !punchId.test(item.newClockInPunchId)
      || item.previousClockInPunchId === item.newClockInPunchId || !timestamp(item.previousClockInAt)
      || !timestamp(item.startedAt) || Date.parse(item.startedAt) <= Date.parse(item.previousClockInAt)
      || !(item.proposedFinishAt === null || boundedFinish(item.proposedFinishAt, item))
      || !text(item.proposedBy) || !timestamp(item.proposedAt)
      || !Array.isArray(item.conflicts) || item.conflicts.length > 3 || new Set(item.conflicts).size !== item.conflicts.length
      || item.conflicts.some(code => !Object.hasOwn(conflictLabels, code))
      || !Number.isSafeInteger(item.revision) || item.revision < 0 || !['pending', 'rejected', 'approved'].includes(item.status)) return false;
    const punch = item.punch;
    if (!keys(punch, punchFields) || punch.punchId !== item.newClockInPunchId || punch.timestamp !== item.startedAt
      || punch.date !== item.startedAt.slice(0, 10) || punch.staffId !== item.staffId || punch.staffName !== item.staffName
      || punch.punchAction !== 'clockIn' || punch.site !== 'Rev' || !text(punch.device) || !text(punch.build)
      || !(punch.note === '' || text(punch.note, 400))) return false;
    if (item.status === 'pending') return item.revision === 0 && item.decision === null;
    return validDecision(item.decision) && item.decision.recoveryRequestId === item.requestId
      && item.decision.revision === item.revision && item.decision.decision === (item.status === 'approved' ? 'approve' : 'reject')
      && (item.status !== 'approved' || boundedFinish(item.decision.finishAt, item));
  }
  function exactReceipt(receipt, pending) {
    return validDecision(receipt) && receipt.adminName === pending.adminName
      && receipt.revision === pending.body.revision + 1
      && ['requestId', 'recoveryRequestId', 'decision', 'finishAt', 'punchId', 'reason'].every(key => receipt[key] === pending.body[key]);
  }
  globalThis.GIBM1StaffRecovery = Object.freeze({ create({ root, request, site, target, enabled, getAdmin, getSession,
    timestampForInputs, onUnauthorized = () => {}, onChanged = () => {} }) {
    if (!root || site !== 'Rev' || enabled !== true || !['test', 'production'].includes(target)
      || typeof request !== 'function' || typeof getAdmin !== 'function' || typeof getSession !== 'function' || typeof timestampForInputs !== 'function') return null;
    const storageKey = `m1-staff-recovery-admin-v1:${site}:${target}`;
    let active = false, admin = '', generation = 0, items = null, unavailable = false, busy = false;
    let pending = null, invalidJournal = false, reading = null, confirmation = null;
    const drafts = new Map();
    function retain(value) {
      if (value) {
        const encoded = JSON.stringify(value);
        sessionStorage.setItem(storageKey, encoded);
        if (sessionStorage.getItem(storageKey) !== encoded) throw new Error('Decision was not retained');
      }
      else sessionStorage.removeItem(storageKey);
      pending = value;
    }
    function restore() {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) { pending = null; invalidJournal = false; return; }
        if (raw.length > 10000) throw new Error('Invalid journal');
        const value = JSON.parse(raw);
        if (!keys(value, ['version', 'site', 'target', 'adminName', 'body']) || value.version !== 1
          || value.site !== site || value.target !== target || !text(value.adminName) || !validDecision(value.body, true)) throw new Error('Invalid journal');
        pending = value; invalidJournal = false;
      } catch { invalidJournal = true; }
    }
    const current = own => active && own === generation && getAdmin() === admin;
    const readIsValid = result => keys(result, Object.hasOwn(result || {}, 'receipt')
      ? ['ok', 'test', 'adminName', 'recovery', 'receipt'] : ['ok', 'test', 'adminName', 'recovery'])
      && result.ok === true && result.test === (target === 'test') && result.adminName === admin
      && keys(result.recovery, ['enabled', 'items']) && result.recovery.enabled === true
      && Array.isArray(result.recovery.items) && result.recovery.items.length <= 100
      && result.recovery.items.every(validItem)
      && new Set(result.recovery.items.map(item => item.requestId)).size === result.recovery.items.length;
    function status(note, success = false) {
      const node = root.querySelector('[data-recovery-status]');
      if (node) { node.textContent = note; node.className = `message${success ? ' success' : ''}`; node.style.display = note ? 'block' : 'none'; }
    }
    const label = value => value ? `${value.slice(0, 10)} ${value.slice(11, 19)} ET (${value.slice(-6)})` : 'Don’t know';
    const draftFor = item => drafts.get(item.requestId) || { finishDate: item.proposedFinishAt?.slice(0, 10) || '',
      finishTime: item.proposedFinishAt?.slice(11, 19) || '', finishOffset: item.proposedFinishAt?.slice(-6) || '', reason: '' };
    // Compare all validated proposal evidence, independently of JSON property order.
    const proposalState = item => JSON.stringify(itemFields.map(key => key === 'punch' ? punchFields.map(field => item.punch[field])
      : key === 'decision' && item.decision ? receiptFields.map(field => item.decision[field])
        : key === 'conflicts' ? [...item.conflicts].sort() : item[key]));
    function closeConfirmation() {
      if (!confirmation) return;
      confirmation.dialog.close(); confirmation.dialog.remove(); confirmation = null;
    }
    function render(note = '') {
      if (!active) return;
      root.hidden = false;
      const disabled = busy || Boolean(reading) || unavailable || Boolean(pending) || invalidJournal;
      const pendingOwn = pending?.adminName === admin;
      root.setAttribute('aria-busy', String(busy || Boolean(reading)));
      root.innerHTML = `<h3>Previous shift finish proposals${target === 'test' ? ' · TEST' : ''}</h3>
        <p class="record-detail">Employee proposals do not count as approved payroll time. Approve a verified finish or reject it and leave the earlier shift unresolved.</p>
        <p data-recovery-status class="message" role="status" aria-live="polite"></p>
        <button class="btn ghost small" type="button" data-recovery-action="refresh" ${busy || reading ? 'disabled' : ''}>Refresh finish proposals</button>
        ${pending ? `<p class="message" style="display:block">${pendingOwn ? 'A decision is waiting for central confirmation. Retry keeps the original IDs and audit identity.' : 'A previous reviewer’s decision still needs confirmation. Reopen this page as that reviewer before retrying.'}</p><button class="btn" type="button" data-recovery-action="retry" ${!pendingOwn || busy || reading ? 'disabled' : ''}>Retry same decision</button>` : ''}
        ${invalidJournal ? '<p class="message" style="display:block">The saved decision could not be read safely. Decisions are blocked; the retained request has not been discarded.</p>' : ''}
        ${!items ? `<p>${reading ? 'Loading finish proposals…' : 'Finish proposals unavailable. Unresolved shifts still need review.'}</p>`
          : unavailable ? '<p>Finish proposals unavailable. Previously loaded proposals are not safe to approve.</p>' : items.length === 0 ? '<p>No finish proposals in the confirmed central read.</p>' : ''}
        ${items ? items.map(item => `<article class="staff-time-block" data-recovery-id="${escape(item.requestId)}">
          <h4>${escape(item.staffName)}</h4><p class="record-detail">Earlier clock-in: ${escape(label(item.previousClockInAt))}<br>New shift started: ${escape(label(item.startedAt))}</p>
          <p>Employee proposed finish: <strong>${escape(label(item.proposedFinishAt))}</strong></p>
          <p class="record-detail">Proposed by ${escape(item.proposedBy)} · ${escape(label(item.proposedAt))}</p>
          ${item.conflicts.length ? `<p class="message" style="display:block">${item.conflicts.map(code => escape(conflictLabels[code])).join('. ')}. VOID history is preserved; this proposal cannot be approved. Review the linked records in the existing Staff Clock tools.</p>` : ''}
          ${item.status === 'approved' ? `<p class="message${item.conflicts.length ? '' : ' success'}" style="display:block">${item.conflicts.length ? 'Historical approval (linked records need review)' : 'Approved payroll finish'}: ${escape(label(item.decision.finishAt))} · ${escape(item.decision.adminName)} · ${escape(label(item.decision.decidedAt))}</p>`
            : `<p class="message" style="display:block">${item.status === 'rejected' ? `Rejected by ${escape(item.decision.adminName)}. Earlier shift remains unresolved.` : 'Pending manager approval — no approved finish for payroll.'}</p>
            <form data-recovery-form="${escape(item.requestId)}" novalidate><fieldset ${disabled ? 'disabled' : ''}>
            <legend>Review this prior finish</legend><div class="staff-fix-grid">
            <label>Approved finish date<input name="finishDate" type="date" value="${escape(draftFor(item).finishDate)}"></label>
            <label>Approved finish time<input name="finishTime" type="time" step="1" value="${escape(draftFor(item).finishTime)}"></label>
            <label>Eastern time offset<select name="finishOffset"><option value="">Choose offset</option><option value="-04:00" ${draftFor(item).finishOffset === '-04:00' ? 'selected' : ''}>Daylight time (UTC−04:00)</option><option value="-05:00" ${draftFor(item).finishOffset === '-05:00' ? 'selected' : ''}>Standard time (UTC−05:00)</option></select></label>
            </div><label>Required reason<input name="reason" maxlength="240" value="${escape(draftFor(item).reason)}" placeholder="Why this finish is approved or rejected"></label>
            <div class="form-actions"><button class="btn primary" type="submit" data-recovery-decision="approve" ${item.conflicts.length ? 'disabled' : ''}>Approve finish</button><button class="btn ghost" type="submit" data-recovery-decision="reject">Reject proposal</button></div>
            </fieldset><button class="btn ghost" type="button" data-recovery-action="cancel" ${busy || reading || pending || invalidJournal ? 'disabled' : ''}>Cancel changes</button></form>`}</article>`).join('') : ''}
        ${[...drafts].filter(([id]) => !items?.some(item => item.requestId === id && item.status !== 'approved')).map(([id, draft]) =>
          `<form data-recovery-form="${escape(id)}"><p class="message" style="display:block">An unfinished decision can no longer be applied to the current proposal. Its unsent entries are retained below; cancel them to refresh.</p>
          <p class="record-detail">Finish: ${escape(draft.finishDate)} ${escape(draft.finishTime)} (${escape(draft.finishOffset)})<br>Reason: ${escape(draft.reason)}</p>
          <button class="btn ghost" type="button" data-recovery-action="cancel" ${busy || reading || pending || invalidJournal ? 'disabled' : ''}>Cancel changes</button></form>`).join('')}`;
      status(note);
    }
    async function load() {
      if (!active || busy || getAdmin() !== admin) return;
      if (reading) return reading;
      if (confirmation) { status('Confirm this decision or go back before refreshing. Your unfinished entries are still here.'); return; }
      if (drafts.size) { status('Finish or cancel the current decision before refreshing. Your unfinished entries are still here.'); return; }
      const own = generation;
      const task = (async () => {
        let note = '', changed = false;
        try {
          const result = await Promise.resolve().then(() => request(endpoint, { operation: 'recoveryReview' }));
          if (!current(own)) return;
          if (!readIsValid(result)) throw new Error('Unconfirmed read');
          items = result.recovery.items; unavailable = false;
          if (pending?.adminName === admin && items.some(item => exactReceipt(item.decision, pending))) {
            retain(null); changed = true; note = 'The original decision is confirmed centrally.';
          }
        } catch (error) {
          if (!current(own)) return;
          unavailable = true; note = 'Finish proposals unavailable. No fresh central read was confirmed.';
          if (error?.status === 401 || error?.status === 403) onUnauthorized();
        } finally {
          if (reading === task) reading = null;
          if (current(own)) { render(note); if (changed) { try { onChanged(); } catch {} } }
        }
      })();
      reading = task; render();
      return task;
    }
    async function send() {
      if (!active || busy || reading || invalidJournal || !pending || pending.adminName !== admin || getAdmin() !== admin) return;
      const original = pending, own = generation;
      busy = true; drafts.delete(original.body.recoveryRequestId); render('Saving decision centrally…');
      try {
        const result = await request(endpoint, original.body);
        if (!current(own) || pending !== original) return;
        if (!readIsValid(result) || !exactReceipt(result.receipt, original)) throw new Error('Unconfirmed decision');
        const latest = result.recovery.items.find(item => item.requestId === original.body.recoveryRequestId);
        if (!latest || latest.revision < result.receipt.revision
          || (latest.revision === result.receipt.revision && !exactReceipt(latest.decision, original))) throw new Error('Unconfirmed decision state');
        retain(null); items = result.recovery.items; unavailable = false;
        render(); status(latest.conflicts.length ? 'The original decision is confirmed centrally. Linked VOID records still need review; the historical approval does not confirm payroll hours.' : latest.revision > result.receipt.revision ? 'The original decision is confirmed centrally. A later manager decision is shown below.'
          : original.body.decision === 'approve' ? 'Finish approved and confirmed centrally for payroll.' : 'Rejection confirmed centrally. Earlier shift remains unresolved.', true);
        try { onChanged(); } catch {}
      } catch (error) {
        if (!current(own) || pending !== original) return;
        if (error?.status === 409) {
          try { retain(null); } catch { invalidJournal = true; }
          unavailable = true;
          status('This proposal changed before the decision was saved. Refresh and review it again.');
        } else {
          status('The decision is not confirmed. Retry the same decision; its original IDs and audit identity are retained.');
          if (error?.status === 401 || error?.status === 403) onUnauthorized();
        }
      } finally {
        if (current(own)) {
          const note = root.querySelector('[data-recovery-status]')?.textContent || '';
          busy = false; render(note);
        }
      }
    }
    async function submit(event) {
      const form = event.target.closest('[data-recovery-form]');
      if (!form) return;
      event.preventDefault();
      if (!active || busy || reading || confirmation || unavailable || pending || invalidJournal || getAdmin() !== admin) return;
      const item = items?.find(row => row.requestId === form.dataset.recoveryForm);
      const decision = event.submitter?.dataset.recoveryDecision;
      if (!item || item.status === 'approved' || !['approve', 'reject'].includes(decision)) return;
      if (decision === 'approve' && item.conflicts.length) { status('Linked VOID records need review. This proposal cannot be approved.'); return; }
      const fields = Object.fromEntries(new FormData(form));
      const reason = String(fields.reason || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
      const finishAt = decision === 'approve' ? timestampForInputs(fields.finishDate, fields.finishTime, fields.finishOffset, true) : null;
      if (!text(reason, 240) || reason.length < 3 || /^[=+\-@]/.test(reason) || (decision === 'approve' && (!['-04:00', '-05:00'].includes(fields.finishOffset) || !boundedFinish(finishAt, item)))) {
        status('Enter a reason of at least three characters. To approve, enter a valid Eastern finish after the earlier clock-in, within 18 hours, and no later than the new shift.'); return;
      }
      drafts.set(item.requestId, fields);
      const dialog = document.createElement('dialog'); dialog.className = 'manager-dialog';
      dialog.setAttribute('aria-label', decision === 'approve' ? 'Confirm previous shift finish approval' : 'Confirm previous shift proposal rejection');
      dialog.innerHTML = `<h2>${decision === 'approve' ? 'Approve previous shift finish?' : 'Reject previous shift proposal?'}</h2>
        <p><strong>${escape(item.staffName)}</strong></p>
        <p>Previous shift started: <strong>${escape(label(item.previousClockInAt))}</strong><br>Newer shift started: ${escape(label(item.startedAt))}</p>
        <p>Employee proposed finish: <strong>${escape(label(item.proposedFinishAt))}</strong></p>
        ${decision === 'approve' ? `<p>Finish to approve: <strong>${escape(label(finishAt))}</strong></p><p>This adds an audited finish for the previous shift. Original punches and the newer shift stay unchanged.</p>`
          : '<p>This rejects the proposal. The previous shift stays unresolved; no finish time or worked hours will be guessed.</p>'}
        <p>Reason: <strong>${escape(reason)}</strong></p><p>Reviewer: ${escape(admin)}</p>
        <p data-confirmation-status class="manager-note" role="status" aria-live="polite"></p>
        <div class="manager-controls"><button type="button" class="btn" data-confirmation-back>Go back</button><button type="button" class="btn primary" data-confirmation-submit>${decision === 'approve' ? 'Confirm approval' : 'Confirm rejection'}</button></div>`;
      confirmation = { dialog, item, state: proposalState(item), decision, finishAt, reason, adminName: admin, session: getSession(), own: generation, checking: false };
      const goBack = () => { if (confirmation?.dialog === dialog && !confirmation.checking) closeConfirmation(); };
      dialog.querySelector('[data-confirmation-back]').addEventListener('click', goBack);
      dialog.addEventListener('cancel', event => { event.preventDefault(); goBack(); });
      dialog.querySelector('[data-confirmation-submit]').addEventListener('click', confirmDecision);
      root.append(dialog); dialog.showModal();
    }
    async function confirmDecision() {
      const reviewed = confirmation;
      if (!reviewed || reviewed.checking || busy || reading || pending || invalidJournal) return;
      if (!current(reviewed.own) || reviewed.adminName !== admin || reviewed.session !== getSession()) {
        closeConfirmation(); render('Your Admin session changed. Reopen the proposals and review this decision again. Nothing was sent.'); return;
      }
      reviewed.checking = true;
      const confirmButton = reviewed.dialog.querySelector('[data-confirmation-submit]');
      const backButton = reviewed.dialog.querySelector('[data-confirmation-back]');
      const message = reviewed.dialog.querySelector('[data-confirmation-status]');
      confirmButton.disabled = true; backButton.disabled = true;
      message.textContent = 'Checking the current proposal before saving…';
      try {
        const result = await request(endpoint, { operation: 'recoveryReview' });
        if (confirmation !== reviewed) return;
        if (!current(reviewed.own) || reviewed.adminName !== admin || reviewed.session !== getSession()) {
          closeConfirmation(); render('Your Admin session changed. Reopen the proposals and review this decision again. Nothing was sent.'); return;
        }
        if (!readIsValid(result)) throw new Error('Unconfirmed read');
        const latest = result.recovery.items.find(item => item.requestId === reviewed.item.requestId);
        if (!latest || proposalState(latest) !== reviewed.state) {
          items = result.recovery.items; unavailable = false; closeConfirmation();
          render('This proposal changed. Review the current details before making a fresh decision. Your unsent entries are retained; nothing was sent.'); return;
        }
      } catch (error) {
        if (confirmation !== reviewed) return;
        if (!current(reviewed.own) || reviewed.adminName !== admin || reviewed.session !== getSession()) {
          closeConfirmation(); render('Your Admin session changed. Reopen the proposals and review this decision again. Nothing was sent.'); return;
        }
        message.textContent = 'The current proposal could not be confirmed. Nothing was sent. Try confirming again when the connection returns, or go back to your unchanged entries.';
        if (error?.status === 401 || error?.status === 403) onUnauthorized();
        return;
      } finally {
        if (confirmation === reviewed) { reviewed.checking = false; confirmButton.disabled = false; backButton.disabled = false; }
      }
      try {
        const body = { operation: 'recoveryDecide', requestId: `gib-m1-staff-request-${crypto.randomUUID()}`,
          recoveryRequestId: reviewed.item.requestId, revision: reviewed.item.revision, decision: reviewed.decision, finishAt: reviewed.finishAt,
          punchId: reviewed.decision === 'approve' ? `gib-m1-staff-${crypto.randomUUID()}` : null, reason: reviewed.reason };
        if (!validDecision(body, true)) throw new Error('Invalid identity');
        retain({ version: 1, site, target, adminName: admin, body });
      } catch { closeConfirmation(); render('The original decision could not be retained safely. Nothing was sent.'); return; }
      closeConfirmation();
      await send();
    }
    root.addEventListener('submit', submit);
    function rememberDraft(event) {
      const form = event.target.closest('[data-recovery-form]');
      if (form && active && !busy && !reading && !confirmation && !pending && !invalidJournal) drafts.set(form.dataset.recoveryForm, Object.fromEntries(new FormData(form)));
    }
    root.addEventListener('input', rememberDraft);
    root.addEventListener('change', rememberDraft);
    root.addEventListener('click', event => {
      const action = event.target.closest('[data-recovery-action]')?.dataset.recoveryAction;
      if (action === 'refresh') void load();
      if (action === 'retry') void send();
      if (action === 'cancel' && active && !busy && !reading && !confirmation && !pending && !invalidJournal) {
        const form = event.target.closest('[data-recovery-form]');
        if (form) { drafts.delete(form.dataset.recoveryForm); render(); }
      }
    });
    return Object.freeze({
      open() {
        if (active && getAdmin() === admin) return load();
        closeConfirmation();
        generation += 1; admin = getAdmin(); active = text(admin);
        items = null; reading = null; busy = false; drafts.clear(); unavailable = false;
        if (!active) { root.hidden = true; root.replaceChildren(); return Promise.resolve(); }
        restore(); return load();
      },
      refresh: load,
      clear() { closeConfirmation(); generation += 1; active = false; admin = ''; items = null; reading = null; busy = false; drafts.clear(); root.hidden = true; root.replaceChildren(); },
      hasPendingSave: () => Boolean(pending) || invalidJournal
    });
  } });
})();
