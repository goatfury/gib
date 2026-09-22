(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pretty = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  const endpoint = '/api/m1-manager-review';
  const enabled = () => globalThis.M1_MANAGER_REVIEW_CONFIG?.enabled === true;
  globalThis.GIBM1ManagerReview = Object.freeze({ create({ request, site, onUnauthorized, openLegacy }) {
    if (!enabled()) return null;
    const root = document.createElement('section');
    root.id = 'managerDayReview';
    document.getElementById('sign-ins').prepend(root);
    document.body.classList.add('manager-pilot');
    let data, selected = '', active = false, busy = false, generation = 0, pending = null;
    let dialog;
    const storageKey = 'm1-manager-pending-v1';
    const remember = value => { pending = value; try { value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey); } catch {} };
    const current = () => data?.days.find(day => day.date === selected);
    const close = () => { if (dialog) { dialog.close(); dialog.remove(); dialog = null; } };
    const message = (text, success = false) => {
      const node = root.querySelector('.manager-status');
      if (node) { node.textContent = text; node.className = `manager-status ${success ? 'manager-success' : 'manager-warning'}`; }
    };
    function render(note = '') {
      if (!active) return;
      if (!data) {
        root.innerHTML = '<div class="manager-summary"><h2>Manager day review · TEST</h2><p>Review status is unavailable. Days are not being marked caught up.</p><button class="btn" data-action="refresh">Retry central read</button><p class="manager-status" role="status"></p></div>';
        message(note); return;
      }
      if (!current()) selected = (data.days.find(day => !day.complete) || data.days.at(-1)).date;
      const day = current();
      root.innerHTML = `<div class="manager-summary"><h2>Manager day review · TEST</h2><p><strong>${data.pendingDays} ${data.pendingDays === 1 ? 'day needs' : 'days need'} review</strong></p><p class="manager-note">Current payroll period: ${pretty(data.period.start)} – ${pretty(data.period.end)}, ${data.period.end.slice(0,4)}. Cleanup begins ${pretty(data.cleanupStart)}. Earlier unfinished days stay here. All dates use Eastern time.</p><div class="manager-controls"><label for="managerDate">Review day</label><select id="managerDate">${data.days.map(d => `<option value="${d.date}" ${d.date === selected ? 'selected' : ''}>${pretty(d.date)} · ${d.complete ? 'Complete' : d.changed ? 'Changed — review again' : 'Pending'}</option>`).join('')}</select><button class="btn" data-action="refresh">Refresh</button></div></div><div class="manager-day"><h2>${pretty(day.date)}</h2><p class="manager-note">Pay period ${pretty(day.period.start)} – ${pretty(day.period.end)}. Review every instructor below, including any second instructor. A recorded name does not mean the class is complete.</p>${!day.historyKnown ? '<p class="manager-warning">No saved timetable is available for this past date. These are recorded and date-specific classes only. Add any other classes that happened before confirming the day.</p>' : ''}${day.changed ? '<p class="manager-warning">Attendance or the schedule changed after the saved review. Check this day again.</p>' : ''}${day.complete ? `<p class="manager-success">Complete · ${escape(day.reviewer)} · ${escape(new Date(day.reviewedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }))} ET</p>` : ''}<p class="manager-status" role="status" aria-live="polite"></p>${pending && !busy ? '<p class="manager-warning">A previous save needs confirmation.</p><button class="btn warn" data-action="retry">Retry / check the same save</button>' : ''}<div>${day.classes.map((row, index) => `<article class="manager-class"><h3>${escape(row.label)} ${row.scheduled ? '' : '<small>· Unlisted</small>'}</h3>${row.upcoming ? '<p class="manager-note">Upcoming — not missing</p>' : ''}${row.records.length ? `<ul>${row.records.map((r, ri) => `<li><span><strong>${escape(r.instructor)}</strong> · ${escape(r.duration)} hr${r.reviewRequired ? `<br><span class="manager-warning">${escape(r.reviewMessage)}</span>` : ''}</span>${r.correctable ? `<button class="btn small" data-action="correct" data-class="${index}" data-record="${ri}">Correct record</button>` : ''}</li>`).join('')}</ul>` : `<p class="blank">${row.outcome === 'not-held' ? 'Didn’t happen' : row.upcoming ? 'No instructors recorded yet' : 'No instructor recorded'}</p>`}${row.conflict ? '<p class="manager-warning">Recorded teaching conflicts with “Didn’t happen.” Resolve the records explicitly.</p>' : ''}<div class="manager-controls"><button class="btn" data-action="add" data-class="${index}" ${row.upcoming ? 'disabled' : ''}>${row.records.length ? 'Add another instructor' : 'Add instructor'}</button><label>Class status <select aria-label="Class status for ${escape(row.label)}" data-outcome="${index}" ${row.upcoming ? 'disabled' : ''}><option value="" ${!row.outcome ? 'selected' : ''}>${row.records.length ? 'Recorded — review all names' : 'Needs instructor'}</option><option value="unknown" ${row.outcome === 'unknown' ? 'selected' : ''}>Don’t know</option><option value="not-held" ${row.outcome === 'not-held' ? 'selected' : ''} ${row.records.length ? 'disabled' : ''}>Didn’t happen</option></select></label></div></article>`).join('') || '<p>No classes are recorded for this date. Add any classes that happened.</p>'}</div><div class="manager-controls"><button class="btn" data-action="unlisted">Record an unlisted class</button><button class="btn" data-action="partial">Save partial progress</button><button class="btn primary" data-action="complete" ${!day.canComplete || day.complete ? 'disabled' : ''}>This day is complete</button></div>${day.blockers.map(b => `<p class="manager-note">${escape(b)}</p>`).join('')}<p class="manager-note">Class status changes save centrally. Completing the day confirms every class and every instructor, including additional instructors. Future days are not counted.</p></div>`;
      const tools = document.createElement('div');
      tools.className = 'manager-controls';
      tools.innerHTML = '<button class="btn" data-action="export">Download this period’s records</button><button class="btn" data-action="legacy">Existing Daily Review tools</button>';
      root.querySelector('.manager-summary').append(tools);
      if (note) message(note);
      if (busy || pending) root.querySelectorAll('button:not([data-action="retry"]):not([data-action="refresh"]), select').forEach(node => { node.disabled = true; });
    }
    async function load() {
      const own = ++generation;
      data = null; render('Reading central records…');
      try {
        const result = await request(endpoint, { action: 'read' });
        if (!active || own !== generation) return;
        if (result?.ok !== true || result.test !== true || !Array.isArray(result.days) || !result.days.length || !Number.isInteger(result.pendingDays)) throw new Error('Incomplete central read.');
        data = result; render();
      } catch (error) { if (own === generation) { data = null; render(error.message); } if (error.status === 401) onUnauthorized(); }
    }
    async function save(requestData, url = endpoint) {
      if (busy) return;
      busy = true; remember({ url, body: requestData }); render('Saving centrally…');
      try {
        const result = await request(url, requestData);
        if (result?.ok !== true || (url === endpoint && !result.receipt) || (url !== endpoint && !result.linkedRecordId)) throw new Error('Central saving was not confirmed.');
        remember(null); close();
        if (url === endpoint && Array.isArray(result.days)) data = result;
        else await load();
        busy = false; render(); message(data ? (current()?.complete ? 'This day is saved complete centrally.' : 'Saved centrally. Unresolved items keep this day pending.') : 'Save confirmed; the updated review still needs a fresh central read.', Boolean(data));
      } catch (error) {
        busy = false;
        console.warn('M1 TEST review save unconfirmed', error.status || 'network', error.data?.code || 'no receipt');
        if (error.status === 409) { remember(null); await load(); }
        render(error.message);
        if (error.status === 401) onUnauthorized();
      }
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
      const d = modal(`<h2>${row ? 'Add instructor' : 'Record an unlisted class'}</h2><p>${escape(pretty(selected))}</p><form><label>Class and start time<input name="classLabel" required maxlength="200" placeholder="6:00 PM TEST class" value="${escape(row?.label || '')}" ${row ? 'readonly' : ''}></label><label>Instructor<input name="instructor" required maxlength="100" placeholder="Use a fake TEST instructor"></label><label>Hours taught<input name="duration" type="number" min="0.25" max="8" step="0.25" value="1" required></label><label>Reason<input name="reason" minlength="3" maxlength="240" required value="Forgotten instructor"></label><div class="manager-controls"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save instructor</button></div><p class="manager-note">Saves an audited correction in the same attendance records used for payroll.</p></form>`);
      d.querySelector('form').addEventListener('submit', e => {
        e.preventDefault(); const values = Object.fromEntries(new FormData(e.target));
        const requestData = { ...values, duration: Number(values.duration), date: selected, requestId: `manager-add-${crypto.randomUUID()}`, site, notes: '' };
        close(); void save(requestData, '/.netlify/functions/m1-admin-add');
      });
    }
    root.addEventListener('change', e => {
      if (e.target.id === 'managerDate') { selected = e.target.value; render(); return; }
      if (!e.target.hasAttribute('data-outcome') || !current() || busy || pending) return;
      const row = current().classes[Number(e.target.dataset.outcome)];
      const decisions = current().decisions.filter(item => item.label !== row.label);
      if (e.target.value) decisions.push({ label: row.label, outcome: e.target.value });
      void save(reviewRequest('partial', decisions));
    });
    root.addEventListener('click', e => {
      const button = e.target.closest('[data-action]'); if (!button || busy) return;
      const action = button.dataset.action;
      if (action === 'refresh') { void load(); return; }
      if (action === 'retry') { if (pending) void save(pending.body, pending.url); return; }
      if (!current() || pending) return;
      if (action === 'legacy') {
        document.body.classList.toggle('manager-legacy-open');
        if (document.body.classList.contains('manager-legacy-open')) void openLegacy(selected);
        return;
      }
      if (action === 'export') {
        const period = current().period;
        void (async () => {
          await load();
          if (!data) return;
          const days = data.days.filter(day => day.date >= period.start && day.date <= period.end);
          if (days.some(day => day.warnings.length)) { message('Export unavailable: resolve the unreadable attendance rows first.'); return; }
          const rows = [['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Notes', 'Status']];
          for (const day of days) for (const row of day.classes) for (const r of row.records) rows.push([r.recordId, r.timestamp, r.date, r.classLabel, r.duration, r.instructor, r.site, r.notes, 'OK']);
          const cell = value => '"' + String(value ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
          const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
          const link = document.createElement('a'); link.href = url; link.download = `M1-${data.gym}-TEST-${period.start}-${period.end}.csv`; link.click();
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
        const row = current().classes[Number(button.dataset.class)];
        const record = row.records[Number(button.dataset.record)];
        const d = modal(`<h2>Correct this record</h2><p><strong>${escape(record.instructor)}</strong><br>${escape(row.label)} · ${escape(pretty(selected))} · ${escape(record.duration)} hr</p><p>This explicitly marks this incorrect TEST record VOID and preserves its audit. Use “Add another instructor” to record the correct teaching.</p><form><label>Reason<input name="reason" required minlength="3" maxlength="240"></label><div class="manager-controls"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn warn" type="submit">Remove incorrect record</button></div></form>`);
        d.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const reason = new FormData(e.target).get('reason'); close(); void save({ action: 'void', date: selected, recordId: record.recordId, fingerprint: record.fingerprint, reason }); });
      }
    });
    return { async open() { active = true; try { const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); if (stored?.url && stored?.body) pending = stored; } catch {} await load(); }, clear() { active = false; generation++; data = null; close(); root.replaceChildren(); }, refresh: load };
  } });
})();
