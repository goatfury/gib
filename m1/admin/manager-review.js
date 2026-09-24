(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pretty = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  const endpoint = '/api/m1-manager-review';
  const target = globalThis.M1_MANAGER_REVIEW_CONFIG?.target;
  const test = target === 'test';
  const title = `Manager day review${test ? ' · TEST' : ''}`;
  const enabled = () => globalThis.M1_MANAGER_REVIEW_CONFIG?.enabled === true && ['test', 'production'].includes(target);
  globalThis.GIBM1ManagerReview = Object.freeze({ create({ request, site, onUnauthorized, openLegacy, additionRequestId, legacyWritePending = () => false, validateAdditionResult = result => Boolean(result?.linkedRecordId) }) {
    if (!enabled() || (!test && typeof additionRequestId !== 'function')) return null;
    const root = document.createElement('section');
    root.id = 'managerDayReview';
    document.getElementById('sign-ins').prepend(root);
    document.body.classList.add('manager-pilot');
    let data, selected = '', active = false, busy = false, generation = 0, pending = null;
    let inFlight = null, recoveryFlight = null, reading = false, unavailable = false;
    let dialog;
    const storageKey = 'm1-manager-pending-v1';
    const remember = value => { value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey); pending = value; };
    const current = () => data?.days.find(day => day.date === selected);
    const close = () => { if (dialog) { dialog.close(); dialog.remove(); dialog = null; } };
    const message = (text, success = false) => {
      const node = root.querySelector('.manager-status');
      if (node) { node.textContent = text; node.className = `manager-status ${success ? 'manager-success' : 'manager-warning'}`; }
    };
    function render(note = '') {
      if (!active) return;
      if (busy || pending) document.body.classList.remove('manager-legacy-open');
      root.setAttribute('aria-busy', String(reading));
      const retryLabel = isRevolutionAddition(pending) ? 'Check original save' : 'Retry / check the same save';
      const originalRetry = pending && !busy && isRevolutionAddition(pending) ? '<button class="btn" data-action="retry-original">Retry original save</button>' : '';
      const recovery = pending && !busy ? '<p class="manager-warning">A previous save needs confirmation before another edit.</p><button class="btn warn" data-action="retry">' + retryLabel + '</button>' + originalRetry : '';
      const legacy = `<button class="btn" data-action="legacy" ${busy || pending ? 'disabled' : ''}>Existing Daily Review tools</button>`;
      if (!data) {
        root.innerHTML = `<div class="manager-summary"><h2>${title}</h2><p>${reading ? 'Reading central records…' : 'Review status unavailable. Unfinished days still need review.'}</p><div class="manager-controls"><button class="btn" data-action="refresh" ${reading || busy ? 'disabled' : ''}>Retry central read</button>${legacy}</div>${recovery}<p class="manager-status" role="status"></p></div>`;
        message(note); return;
      }
      if (!current()) selected = (data.days.find(day => !day.complete) || data.days.at(-1)).date;
      const day = current();
      root.innerHTML = `<div class="manager-summary"><h2>${title}</h2><p><strong>${data.pendingDays} ${data.pendingDays === 1 ? 'day needs' : 'days need'} review</strong></p><p class="manager-note">Current payroll period: ${pretty(data.period.start)} – ${pretty(data.period.end)}, ${data.period.end.slice(0,4)}. Cleanup begins ${pretty(data.cleanupStart)}. Earlier unfinished days stay here. All dates use Eastern time.</p><div class="manager-controls"><label for="managerDate">Review day</label><select id="managerDate">${data.days.map(d => `<option value="${d.date}" ${d.date === selected ? 'selected' : ''}>${pretty(d.date)} · ${d.complete ? 'Complete' : d.changed ? 'Changed — review again' : 'Pending'}</option>`).join('')}</select><button class="btn" data-action="refresh">Refresh</button></div></div><div class="manager-day"><h2>${pretty(day.date)}</h2><p class="manager-note">Pay period ${pretty(day.period.start)} – ${pretty(day.period.end)}. Review every instructor below, including any second instructor. A recorded name does not mean the class is complete.</p>${!day.historyKnown ? '<p class="manager-warning">No saved timetable is available for this past date. These are recorded and date-specific classes only. Add any other classes that happened before confirming the day.</p>' : ''}${day.changed ? '<p class="manager-warning">Attendance or the schedule changed after the saved review. Check this day again.</p>' : ''}${day.complete ? `<p class="manager-success">Complete · ${escape(day.reviewer)} · ${escape(new Date(day.reviewedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }))} ET</p>` : ''}<p class="manager-status" role="status" aria-live="polite"></p>${pending && !busy ? '<p class="manager-warning">A previous save needs confirmation.</p><button class="btn warn" data-action="retry">' + retryLabel + '</button>' : ''}<div>${day.classes.map((row, index) => `<article class="manager-class"><h3>${escape(row.label)} ${row.scheduled ? '' : '<small>· Unlisted</small>'}</h3>${row.upcoming ? '<p class="manager-note">Upcoming — not missing</p>' : ''}${row.records.length ? `<ul>${row.records.map((r, ri) => `<li><span><strong>${escape(r.instructor)}</strong> · ${escape(r.duration)} hr${r.reviewRequired ? `<br><span class="manager-warning">${escape(r.reviewMessage)}</span>` : ''}</span>${r.correctable ? `<button class="btn small" data-action="correct" data-class="${index}" data-record="${ri}">${test ? 'Correct record' : 'Open correction tools'}</button>` : ''}</li>`).join('')}</ul>` : `<p class="blank">${row.outcome === 'not-held' ? 'Didn’t happen' : row.upcoming ? 'No instructors recorded yet' : 'No instructor recorded'}</p>`}${row.conflict ? '<p class="manager-warning">Recorded teaching conflicts with “Didn’t happen.” Resolve the records explicitly.</p>' : ''}<div class="manager-controls"><button class="btn" data-action="add" data-class="${index}" ${row.upcoming ? 'disabled' : ''}>${row.records.length ? 'Add another instructor' : 'Add instructor'}</button><label>Class status <select aria-label="Class status for ${escape(row.label)}" data-outcome="${index}" ${row.upcoming ? 'disabled' : ''}><option value="" ${!row.outcome ? 'selected' : ''}>${row.records.length ? 'Recorded — review all names' : 'Needs instructor'}</option><option value="unknown" ${row.outcome === 'unknown' ? 'selected' : ''}>Don’t know</option><option value="not-held" ${row.outcome === 'not-held' ? 'selected' : ''} ${row.records.length ? 'disabled' : ''}>Didn’t happen</option></select></label></div></article>`).join('') || '<p>No classes are recorded for this date. Add any classes that happened.</p>'}</div><div class="manager-controls"><button class="btn" data-action="unlisted">Record an unlisted class</button><button class="btn" data-action="partial">Save partial progress</button><button class="btn primary" data-action="complete" ${!day.canComplete || day.complete ? 'disabled' : ''}>This day is complete</button></div>${day.blockers.map(b => `<p class="manager-note">${escape(b)}</p>`).join('')}<p class="manager-note">Class status changes save centrally. Completing the day confirms every class and every instructor, including additional instructors. Future days are not counted.</p></div>`;
      const tools = document.createElement('div');
      tools.className = 'manager-controls';
      tools.innerHTML = '<button class="btn" data-action="export">Download this period’s records</button>' + legacy + originalRetry;
      root.querySelector('.manager-summary').append(tools);
      if (reading || unavailable) root.querySelector('.manager-summary strong').textContent = reading ? 'Reading central records…' : 'Review status unavailable';
      if (note) message(note);
      if (busy || pending || unavailable) root.querySelectorAll('button:not([data-action="retry"]):not([data-action="retry-original"]):not([data-action="refresh"]):not([data-action="legacy"]), select').forEach(node => { node.disabled = true; });
      if (reading) root.querySelectorAll('button:not([data-action="legacy"]), select').forEach(node => { node.disabled = true; });
    }
    function load(discardPrevious = false) {
      if (isRevolutionAddition(pending)) return reconcileAddition({ renew: true });
      if (inFlight) return inFlight;
      if (dialog?.open) { message('Finish or cancel the open edit before refreshing.'); return Promise.resolve(); }
      const own = generation;
      if (discardPrevious) data = null;
      reading = true; unavailable = false; render();
      inFlight = (async () => {
        let note = '';
        try {
          const result = site === 'Rev'
            ? await globalThis.GIBM1ReadClient.run({ ticket: globalThis.GIBM1ReadClient.createTicket(), current: () => active && own === generation,
              send: (readRequest, options) => request(endpoint, { action: 'read', readRequest }, options) })
            : await request(endpoint, { action: 'read' }, { timeoutMs: 60000, timeoutMessage: 'Review status unavailable. No fresh central read was confirmed.' });
          if (!active || own !== generation || dialog?.open) return;
          if (result?.ok !== true || result.target !== target || result.test !== test || !Array.isArray(result.days) || !result.days.length || !Number.isInteger(result.pendingDays) || result.pendingDays < 0) throw new Error('Incomplete central read.');
          data = result;
        } catch (error) {
          if (active && own === generation) { unavailable = true; note = 'Review status unavailable. No fresh central read was confirmed.'; if (error.status === 401) onUnauthorized(); }
        } finally {
          inFlight = null; reading = false;
          if (active && own === generation && !dialog?.open) render(note);
          else if (active && own !== generation) void load();
        }
      })();
      return inFlight;
    }
    function confirmedReviewSave(result, original) {
      const receipt = result?.receipt;
      if (result?.ok !== true || result.target !== target || result.test !== test
        || !['partial', 'complete'].includes(original.action)
        || typeof original.requestId !== 'string' || !/^manager-[a-zA-Z0-9-]{16,100}$/.test(original.requestId)
        || !Number.isSafeInteger(original.revision) || original.revision < 0
        || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || receipt.saved !== true || receipt.requestId !== original.requestId
        || !Number.isSafeInteger(receipt.revision) || receipt.revision !== original.revision + 1) return false;
      const keys = Object.keys(receipt);
      return keys.every(key => ['saved', 'requestId', 'revision', 'ok', 'retry'].includes(key))
        && (!keys.includes('ok') || receipt.ok === true)
        && (!keys.includes('retry') || (receipt.retry === true && receipt.ok === true));
    }
    async function save(requestData, url = endpoint) {
      if (busy || legacyWritePending()) return;
      try { remember({ url, body: requestData }); }
      catch { message('The original save could not be retained safely. Nothing was sent.'); return; }
      const own = ++generation;
      busy = true; render('Saving centrally…');
      try {
        const result = await request(url, requestData, { timeoutMs: 65000, timeoutMessage: 'Central saving could not be confirmed in time. Retry / check the same save safely.' });
        if (!active || own !== generation) return;
        const reviewSave = url === endpoint && ['partial', 'complete'].includes(requestData.action);
        if (result?.ok !== true || (reviewSave ? !confirmedReviewSave(result, requestData) : url === endpoint && !result.receipt)
          || (url !== endpoint && !validateAdditionResult(result, requestData))) throw new Error('Central saving was not confirmed.');
        remember(null); close();
        if (url === endpoint && Array.isArray(result.days)) data = result;
        else await load(true);
        busy = false; render(); message(data ? (current()?.complete ? 'This day is saved complete centrally.' : 'Saved centrally. Unresolved items keep this day pending.') : 'Save confirmed; the updated review still needs a fresh central read.', Boolean(data));
      } catch (error) {
        if (!active || own !== generation) return;
        busy = false;
        const stage = ['review.pre-save-read', 'review.pre-save-validation', 'review.save-dispatch', 'review.checked-receipt', 'review.save-receipt'].includes(error.data?.stage)
          ? error.data.stage : 'unknown-stage';
        console.warn('M1 review save unconfirmed', error.status || 'network', error.data?.code || 'no receipt', stage);
        if (error.status === 409 && url === endpoint) { remember(null); await load(true); }
        render(error.message);
        if (error.status === 401) onUnauthorized();
        else if (error.status !== 403 && isRevolutionAddition(pending)) await reconcileAddition({ renew: true });
      }
    }
    const isRevolutionAddition = value => site === 'Rev'
      && ['/.netlify/functions/m1-admin-add', '/api/m1-admin-add'].includes(value?.url);
    function confirmedAdditionReview(result, original, receipt) {
      if (result?.ok !== true || result.target !== target || result.test !== test
        || result.gym !== 'rev' || result.site !== 'Rev' || !Array.isArray(result.days)
        || !result.days.length || !Number.isInteger(result.pendingDays) || result.pendingDays < 0) return false;
      const days = result.days.filter(day => day.date === original.date);
      if (days.length !== 1) return false;
      const day = days[0];
      if (!Array.isArray(day.warnings) || day.warnings.length || !Array.isArray(day.classes)
        || !Number.isInteger(day.revision) || day.revision < 0 || typeof day.changed !== 'boolean'
        || typeof day.complete !== 'boolean' || (day.changed && day.complete)
        || (!day.revision && day.complete)) return false;
      const records = [];
      for (const row of day.classes) {
        if (!Array.isArray(row.records)) return false;
        records.push(...row.records.filter(record => record.recordId === receipt.linkedRecordId));
      }
      if (records.length !== 1) return false;
      const record = records[0];
      const notes = `Admin-added | Admin: ${receipt.confirmation?.adminName} | Reason: ${original.reason}${original.notes ? ` | Notes: ${original.notes}` : ''}`;
      return ['date', 'classLabel', 'duration', 'instructor', 'site'].every(key => record[key] === original[key])
        && record.source === 'Admin-added' && record.reviewRequired === false
        && record.displayId === receipt.linkedDisplayId && record.notes === notes;
    }
    function reconcileAddition({ renew = false } = {}) {
      if (recoveryFlight) return recoveryFlight;
      if (busy || !active || legacyWritePending() || !isRevolutionAddition(pending)) return Promise.resolve();
      const original = pending.body, own = ++generation;
      const currentRequest = () => active && own === generation && pending?.body?.requestId === original.requestId;
      const client = globalThis.GIBM1ReadClient;
      let ticket = pending.readTicket;
      try {
        if (!client.reusable(ticket)) {
          if (!renew) return Promise.resolve();
          ticket = client.createTicket();
        }
        remember({ ...pending, readTicket: ticket });
      } catch {
        render('The original save check could not be retained safely. Nothing was sent.');
        return Promise.resolve();
      }
      if (renew) onlineRenewalNeeded = false;
      busy = true; data = null; unavailable = true;
      render('Checking the original save and its audit without sending another save…');
      recoveryFlight = (async () => {
        try {
          const result = await client.run({ ticket, current: currentRequest,
            retain: readTicket => { if (!currentRequest()) throw new Error('Review session changed.'); remember({ ...pending, readTicket }); },
            send: (readRequest, options) => request('/api/m1-admin-add-check', { ...original, readRequest }, options) });
          if (!currentRequest()) return;
          const { review, ...receipt } = result || {};
          if (receipt.ok !== true || receipt.test !== test || !validateAdditionResult(receipt, original)
            || !confirmedAdditionReview(review, original, receipt)) throw new Error('The original save evidence or updated review is incomplete or changed. Editing stays locked.');
          remember(null); data = review; selected = original.date; unavailable = false;
          busy = false; render('Original save and audit confirmed. The updated day is ready to review.');
        } catch (error) {
          if (!currentRequest()) return;
          busy = false; render(error.message || 'The original save could not be confirmed. Editing stays locked.');
          if (error.status === 401) onUnauthorized();
        } finally {
          if (own === generation) recoveryFlight = null;
        }
      })();
      return recoveryFlight;
    }
    function reviewRequest(action, decisions = current().decisions) {
      const day = current();
      return { action, requestId: `manager-${crypto.randomUUID()}`, date: day.date, revision: day.revision, attendanceHash: day.attendanceHash, scheduleHash: day.scheduleHash, decisions };
    }
    function modal(html) {
      close(); dialog = document.createElement('dialog'); dialog.className = 'manager-dialog'; dialog.innerHTML = html;
      root.append(dialog); dialog.showModal();
      dialog.querySelector('[data-cancel]').addEventListener('click', close);
      return dialog;
    }
    function add(row) {
      const d = modal(`<h2>${row ? 'Add instructor' : 'Record an unlisted class'}</h2><p>${escape(pretty(selected))}</p><form><label>Class and start time<input name="classLabel" required maxlength="200" placeholder="${test ? '6:00 PM TEST class' : '6:00 PM class'}" value="${escape(row?.label || '')}" ${row ? 'readonly' : ''}></label><label>Instructor<input name="instructor" required maxlength="100" placeholder="${test ? 'Use a fake TEST instructor' : 'Instructor name'}"></label><label>Hours taught<input name="duration" type="number" min="0.25" max="8" step="0.25" value="1" required></label><label>Reason<input name="reason" minlength="3" maxlength="240" required value="Forgotten instructor"></label><div class="manager-controls"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save instructor</button></div><p class="manager-note">Saves an audited correction in the same attendance records used for payroll.</p></form>`);
      d.querySelector('form').addEventListener('submit', e => {
        e.preventDefault(); const values = Object.fromEntries(new FormData(e.target));
        const requestData = { ...values, duration: Number(values.duration), date: selected, requestId: test ? `manager-add-${crypto.randomUUID()}` : additionRequestId(selected), site, notes: '' };
        close(); void save(requestData, '/.netlify/functions/m1-admin-add');
      });
    }
    root.addEventListener('change', e => {
      if (e.target.id === 'managerDate') { selected = e.target.value; render(); return; }
      if (!e.target.hasAttribute('data-outcome') || !current() || busy || pending || reading || unavailable || legacyWritePending()) return;
      const row = current().classes[Number(e.target.dataset.outcome)];
      const decisions = current().decisions.filter(item => item.label !== row.label);
      if (e.target.value) decisions.push({ label: row.label, outcome: e.target.value });
      void save(reviewRequest('partial', decisions));
    });
    root.addEventListener('click', e => {
      const button = e.target.closest('[data-action]'); if (!button || busy) return;
      const action = button.dataset.action;
      if (action === 'legacy') {
        if (pending) { message('Check the original save before opening another edit.'); return; }
        document.body.classList.add('manager-legacy-open');
        const own = generation;
        void (async () => {
          try {
            const loaded = await openLegacy(selected);
            if (!active || own !== generation) return;
            const section = document.getElementById('reviewSection');
            section?.setAttribute('tabindex', '-1');
            section?.focus({ preventScroll: true });
            section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (loaded === false && unavailable) message('Neither review could load fresh records. No changes are available. Unfinished days still need review. Retry Daily Review when the connection returns.');
          } catch {
            if (active && own === generation) message('Daily Review could not load fresh records. Unfinished days still need review. Use its retry below.');
          }
        })();
        return;
      }
      if (reading) return;
      if (action === 'refresh') { void load(); return; }
      if (action === 'retry') { if (pending) void (isRevolutionAddition(pending) ? reconcileAddition({ renew: true }) : save(pending.body, pending.url)); return; }
      if (action === 'retry-original') { if (isRevolutionAddition(pending)) void save(pending.body, pending.url); return; }
      if (!current() || pending || unavailable) return;
      if (legacyWritePending()) { message('Check the saved Daily Review request before another edit.'); return; }
      if (action === 'export') {
        const period = current().period;
        void (async () => {
          await load();
          if (!data || unavailable) return;
          const days = data.days.filter(day => day.date >= period.start && day.date <= period.end);
          if (days.some(day => day.warnings.length)) { message('Export unavailable: resolve the unreadable attendance rows first.'); return; }
          const rows = [['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Notes', 'Status']];
          for (const day of days) for (const row of day.classes) for (const r of row.records) rows.push([r.recordId, r.timestamp, r.date, r.classLabel, r.duration, r.instructor, r.site, r.notes, 'OK']);
          const cell = value => '"' + String(value ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
          const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
          const link = document.createElement('a'); link.href = url; link.download = `M1-${data.gym}-${test ? 'TEST' : 'production'}-${period.start}-${period.end}.csv`; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          message('Downloaded fresh central attendance records. VOID records are excluded; incomplete days still need review.', true);
        })();
        return;
      }
      if (action === 'add') add(current().classes[Number(button.dataset.class)]);
      if (action === 'unlisted') add(null);
      if (action === 'partial') void save(reviewRequest('partial'));
      if (action === 'complete') {
        const d = modal(`<h2>Complete ${escape(pretty(selected))}?</h2><p>I have checked every class that happened and all its instructors, including second instructors and unlisted classes.</p>${!current().historyKnown ? '<p>No historical timetable is available. This confirmation includes any missing classes you know happened.</p>' : ''}<div class="manager-controls"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-confirm>Confirm day complete</button></div>`);
        d.querySelector('[data-confirm]').addEventListener('click', () => { const body = reviewRequest('complete'); close(); void save(body); });
      }
      if (action === 'correct') {
        if (!test) {
          const date = selected, own = generation;
          document.body.classList.add('manager-legacy-open');
          message('Opening the existing Daily Review correction tools below…');
          void (async () => {
            try {
              await openLegacy(date);
              if (!active || own !== generation || selected !== date) return;
              const section = document.getElementById('reviewSection');
              section?.setAttribute('tabindex', '-1');
              section?.focus({ preventScroll: true });
              section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch {
              if (active && own === generation) message('Correction tools could not be loaded. Use the Daily Review retry below.');
            }
          })();
          return;
        }
        const row = current().classes[Number(button.dataset.class)];
        const record = row.records[Number(button.dataset.record)];
        const d = modal(`<h2>Correct this record</h2><p><strong>${escape(record.instructor)}</strong><br>${escape(row.label)} · ${escape(pretty(selected))} · ${escape(record.duration)} hr</p><p>This explicitly marks this incorrect TEST record VOID and preserves its audit. Use “Add another instructor” to record the correct teaching.</p><form><label>Reason<input name="reason" required minlength="3" maxlength="240"></label><div class="manager-controls"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn warn" type="submit">Remove incorrect record</button></div></form>`);
        d.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const reason = new FormData(e.target).get('reason'); close(); void save({ action: 'void', date: selected, recordId: record.recordId, fingerprint: record.fingerprint, reason }); });
      }
    });
    let wasOffline = globalThis.navigator?.onLine === false, onlineRenewalNeeded = false, resumeWaiting = false;
    const resume = () => {
      if (!active || document.hidden || dialog?.open || !isRevolutionAddition(pending)) return;
      if (onlineRenewalNeeded && recoveryFlight) {
        if (resumeWaiting) return;
        resumeWaiting = true;
        const originalId = pending.body.requestId;
        void recoveryFlight.finally(() => { resumeWaiting = false; if (pending?.body?.requestId === originalId) resume(); });
        return;
      }
      if (busy || legacyWritePending()) return;
      void reconcileAddition({ renew: onlineRenewalNeeded });
    };
    globalThis.addEventListener?.('offline', () => { wasOffline = true; });
    globalThis.addEventListener?.('online', () => {
      if (wasOffline && isRevolutionAddition(pending)) onlineRenewalNeeded = true;
      wasOffline = false;
      // One actual connection recovery may replace an expired READ ticket.
      // It never resubmits the original attendance addition or loops on a timer.
      resume();
    });
    document.addEventListener?.('visibilitychange', () => resume());
    return {
      async open() { active = true; try { const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); if (stored?.url && stored?.body) { pending = stored; selected = stored.body.date || selected; } } catch {} await load(); },
      clear() { active = false; generation++; busy = false; recoveryFlight = null; data = null; close(); root.replaceChildren(); },
      refresh: load,
      hasPendingSave: () => Boolean(busy || pending),
      beginExternalSave(url, body) {
        if (busy || pending) return false;
        try { remember({ url, body }); }
        catch { message('The original save could not be retained safely. Nothing was sent.'); return false; }
        generation++;
        busy = true; render('Saving centrally…'); return true;
      },
      finishExternalSave(body, confirmed) {
        if (!pending || JSON.stringify(pending.body) !== JSON.stringify(body)) return;
        if (confirmed) { try { remember(null); } catch { confirmed = false; } }
        if (confirmed) { generation++; data = null; unavailable = true; }
        busy = false;
        render(confirmed ? 'Save confirmed centrally. Refresh records before another edit.' : 'Save result unknown. Retry / check the same save before another edit.');
        if (!confirmed && isRevolutionAddition(pending)) void reconcileAddition({ renew: true });
      }
    };
  } });
})();
