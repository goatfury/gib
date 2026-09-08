(function (root) {
  'use strict';
  const API = '/api/m1-added-classes';
  const clean = value => String(value || '').trim();
  const dateLabel = value => new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }).format(new Date(`${value}T12:00:00Z`));

  // Compare calendar dates and wall-clock minutes in the gym's timezone. A class
  // later today is upcoming, never missing. Lesson duration is intentionally absent.
  function classTiming(label, date, now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    if (date > today) return 'upcoming';
    if (date < today) return 'past';
    const match = clean(label).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
    if (!match) return 'unknown';
    const start = (Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(match[2]);
    return start > Number(parts.hour) * 60 + Number(parts.minute) ? 'upcoming' : 'past';
  }

  function create(options) {
    const { document, profile, request, onChange, onUnauthorized } = options;
    const core = root.GIBM1TemporaryClasses;
    const target = core.resolveAddedClassesTarget(profile, root.location?.href);
    const profileAllowsWrites = profile.installationId !== 'richmond' || target !== 'production'
      || (profile.activation === 'active' && profile.writesEnabled === true);
    const $ = selector => document.querySelector(selector);
    let shared = null;
    let current = false;
    let active = false;
    let busy = false;
    let loadPromise = null;
    let generation = 0;
    let editingId = '';
    let pendingRequest = null;
    let cancelTarget = null;
    const today = () => core.todayInGym();
    const el = (tag, className = '', text = '') => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = text;
      return node;
    };
    function status(message, tone = '') {
      const node = $('#addedClassStatus');
      node.textContent = message;
      node.className = `message added-status ${tone}`;
      node.style.display = message ? 'block' : 'none';
    }
    function validResponse(data) {
      return Boolean(core.validateDocument(data, profile.installationId, target)) && data.current === true;
    }
    function canWrite() { return Boolean(target) && profileAllowsWrites && active && current && shared?.target === target && !busy; }
    function datesList(dates, seriesId = '') {
      const list = el('ul', 'added-date-list');
      dates.forEach(date => {
        const item = el('li', '', dateLabel(date));
        if (seriesId) {
          const cancel = el('button', 'btn small ghost', 'Cancel this date');
          cancel.type = 'button'; cancel.dataset.addedCancel = seriesId; cancel.dataset.addedCancelDate = date;
          cancel.disabled = !canWrite(); item.append(cancel);
        }
        list.append(item);
      });
      return list;
    }
    function getDraft() {
      const form = $('#addedClassForm');
      const repeating = form.elements.repeatMode.value === 'series';
      const startDate = repeating ? form.elements.startDate.value : form.elements.singleDate.value;
      const endDate = repeating ? form.elements.endDate.value : startDate;
      const days = repeating
        ? Array.from(form.querySelectorAll('[name="weekday"]:checked')).map(node => node.value)
        : [core.dayNameForDate(startDate)];
      const previous = editingId && shared?.series.find(item => item.id === editingId);
      const cancelledDates = (previous?.cancelledDates || []).filter(date => date >= startDate && date <= endDate && days.includes(core.dayNameForDate(date)));
      return core.normalizeSeries({
        id: editingId || 'draft-added-class', label: clean(form.elements.className.value),
        time: form.elements.startTime.value, days, startDate, endDate, enabled: true, cancelledDates
      });
    }
    function preview() {
      const form = $('#addedClassForm');
      const repeating = form.elements.repeatMode.value === 'series';
      $('#addedSingleDate').hidden = repeating;
      $('#addedRepeatingDates').hidden = !repeating;
      form.elements.singleDate.disabled = busy || repeating;
      form.elements.startDate.disabled = busy || !repeating;
      form.elements.endDate.disabled = busy || !repeating;
      const draft = getDraft();
      const dates = draft ? core.datesForSeries(draft, { from: today() }) : [];
      const isValid = draft && dates.length && (editingId || draft.startDate >= today());
      const node = $('#addedClassPreview');
      node.replaceChildren();
      if (isValid) {
        node.append(el('strong', '', `${core.classLabel(draft)} · ${dates.length} ${dates.length === 1 ? 'date' : 'dates'}`), datesList(dates));
        node.append(el('p', 'record-detail', editingId
          ? 'These dates replace the remaining schedule from today. Earlier occurrences and teaching records stay unchanged.'
          : 'Adds these dates to the schedule. Instructors still sign in separately; this creates no attendance or pay records.'));
      } else {
        node.append(el('p', 'muted', 'Enter a class name, start time and valid date(s) to see every scheduled date here. New classes can start today, even after the start time.'));
      }
      $('#addedClassSave').disabled = !canWrite() || !isValid;
      $('#addedClassImport').disabled = !canWrite() || !localSeries().series.length;
      return isValid ? draft : null;
    }
    function resetForm() {
      editingId = '';
      pendingRequest = null;
      const form = $('#addedClassForm');
      form.reset();
      form.elements.singleDate.value = today();
      form.elements.startDate.value = today();
      form.elements.endDate.value = today();
      ['singleDate', 'startDate', 'endDate'].forEach(name => { form.elements[name].min = today(); });
      form.querySelectorAll('[name="weekday"]').forEach(node => { node.checked = node.value === core.dayNameForDate(today()); });
      $('#addedClassFormHeading').textContent = 'Add a class';
      $('#addedClassSave').textContent = 'Save class centrally';
      $('#addedClassEditCancel').hidden = true;
      preview();
    }
    function setBusy(value) {
      busy = value;
      $('#addedClassForm').setAttribute('aria-busy', String(value));
      Array.from($('#addedClassForm').elements).forEach(node => { node.disabled = value; });
      document.querySelectorAll('[data-added-edit], [data-added-cancel], #addedClassCancelConfirm, #addedClassCancelClose').forEach(node => { node.disabled = value; });
      preview();
    }
    function localSeries() {
      try {
        const raw = JSON.parse(root.localStorage.getItem(`${profile.storagePrefix}series_v1`) || '[]');
        if (!Array.isArray(raw)) return { series: [], count: 1, invalid: 1 };
        const series = raw.map(core.normalizeSeries).filter(Boolean);
        return { series, count: raw.length, invalid: raw.length - series.length };
      } catch { return { series: [], count: 1, invalid: 1 }; }
    }
    function render() {
      const list = $('#addedClassList');
      list.replaceChildren();
      const currentSeries = (shared?.series || []).filter(item => core.datesForSeries(item, { from: today() }).length);
      currentSeries.forEach(series => {
        const dates = core.datesForSeries(series, { from: today() });
        const row = el('article', 'record');
        const main = el('div', 'added-summary');
        const copy = el('div');
        copy.append(el('strong', '', core.classLabel(series)), el('div', 'record-detail', `${dates.length} remaining ${dates.length === 1 ? 'date' : 'dates'} · next ${dateLabel(dates[0])}`));
        const actions = el('div', 'form-actions');
        const edit = el('button', 'btn small', 'Edit upcoming');
        edit.type = 'button'; edit.dataset.addedEdit = series.id; edit.disabled = !canWrite();
        const cancel = el('button', 'btn small ghost', 'Cancel upcoming');
        cancel.type = 'button'; cancel.dataset.addedCancel = series.id; cancel.disabled = !canWrite();
        actions.append(edit, cancel); main.append(copy, actions); row.append(main);
        const details = el('details', 'daily-secondary');
        details.append(el('summary', '', 'Show dates'), datesList(dates, series.id));
        row.append(details); list.append(row);
      });
      if (!currentSeries.length) list.append(el('div', 'empty', current
        ? 'No upcoming added classes.' : 'Added classes could not be verified. The regular timetable is shown separately.'));
      const history = $('#addedClassHistoryList');
      history.replaceChildren();
      const histories = shared?.history || [];
      const seen = new Set();
      histories.forEach(revision => {
        const series = revision.series;
        const dates = core.datesForSeries(series, { from: revision.fromDate, to: revision.toDate || today() }).filter(date => date < today()
          && core.resolvedSeriesForDate(shared, date).some(item => item.id === series.id && core.classLabel(item) === core.classLabel(series)
            && core.datesForSeries(item, { from: date, to: date }).length));
        const key = `${series.id}|${series.label}|${series.time}|${dates.join(',')}`;
        if (!dates.length || seen.has(key)) return;
        seen.add(key);
        const item = el('details', 'record');
        item.append(el('summary', '', `${core.classLabel(series)} · past dates`));
        const links = el('div', 'form-actions');
        dates.forEach(date => {
          const button = el('button', 'btn small ghost', dateLabel(date));
          button.type = 'button'; button.dataset.addedReviewDate = date;
          links.append(button);
        });
        item.append(links); history.append(item);
      });
      if (!history.children.length) history.append(el('div', 'empty', current ? 'No past added-class dates.' : 'Added-class history is unavailable.'));
      const local = localSeries();
      $('#addedClassLocal').hidden = local.count === 0;
      $('#addedClassLocalCount').textContent = `${local.count} locally saved class ${local.count === 1 ? 'entry' : 'entries'} found; ${local.series.length} can be shared.${local.invalid ? ` ${local.invalid} could not be shared because the saved dates or time need correction in Device maintenance.` : ''} Originals remain on this browser. Repeating an import does not duplicate classes.`;
      preview();
    }
    async function refresh({ quiet = false } = {}) {
      if (!target) {
        current = false;
        status('Shared classes are unavailable at this address. Use this gym’s Admin page.');
        render(); onChange(); return false;
      }
      if (loadPromise) return loadPromise;
      const loadGeneration = generation;
      if (!quiet) status('Loading shared classes…', 'working');
      loadPromise = (async () => {
        try {
          const response = await root.fetch(API, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(12000) });
          const data = await response.json();
          if (!response.ok || !validResponse(data)) throw new Error('Shared class schedule is unavailable for this installation.');
          if (loadGeneration !== generation) return false;
          // A slow read that started before a save cannot undo its confirmed state.
          if (shared && data.version < shared.version) return true;
          if (shared && data.version === shared.version
            && JSON.stringify([data.series, data.history, data.importedIdentities]) !== JSON.stringify([shared.series, shared.history, shared.importedIdentities])) {
            throw new Error('Conflicting shared schedule version.');
          }
          shared = data; current = true;
          if (!quiet) status('Shared classes loaded. Tablets check for updates when online.', 'success');
          render(); onChange(); return true;
        } catch (error) {
          if (loadGeneration !== generation) return false;
          current = false;
          status(`Shared classes could not be refreshed. ${shared ? 'Last loaded classes remain visible; they may be out of date.' : 'Added classes and their history are unavailable.'} Retry when connected.`);
          render(); onChange(); return false;
        } finally { loadPromise = null; }
      })();
      return loadPromise;
    }
    async function mutate(payload, successMessage) {
      if (!canWrite()) return false;
      const mutationGeneration = generation;
      const fingerprint = JSON.stringify(payload);
      if (!pendingRequest || pendingRequest.fingerprint !== fingerprint) {
        pendingRequest = { fingerprint, body: { ...payload, requestId: `gib-m1-added-${root.crypto.randomUUID()}`, expectedVersion: shared.version } };
      }
      setBusy(true); status('Saving centrally… Keep this page open.', 'working');
      try {
        const data = await request(API, pendingRequest.body, { timeoutMs: 25000, timeoutMessage: 'The class save could not be confirmed. Retry the same save safely.' });
        if (mutationGeneration !== generation) return false;
        if (!validResponse(data)) throw new Error('The central save could not be confirmed.');
        shared = data; current = true; pendingRequest = null;
        status(`${successMessage} Saved centrally for ${profile.gymName}. Tablet receipt has not been confirmed.`, 'success');
        $('#addedClassCancelReview').hidden = true;
        cancelTarget = null;
        resetForm(); onChange(); return true;
      } catch (error) {
        if (error.status === 401 || error.status === 403) onUnauthorized();
        if (error.status === 409) {
          pendingRequest = null;
          await refresh({ quiet: true });
          status('The shared schedule changed while you were editing. Your form is preserved. Check the current dates below, then save again.');
        } else status(`Save not confirmed. ${clean(error.message) || 'Retry the same save when connected; it will not create a duplicate.'}`);
        return false;
      } finally { setBusy(false); render(); }
    }
    $('#addedClassForm').addEventListener('input', preview);
    $('#addedClassForm').addEventListener('change', preview);
    $('#addedClassForm').addEventListener('submit', async event => {
      event.preventDefault();
      const series = preview();
      if (!series) return;
      if (editingId) await mutate({ action: 'update', seriesId: editingId, series, effectiveDate: today() }, 'Upcoming dates updated.');
      else {
        // Keep the class identity stable when an unconfirmed request is retried.
        const previous = pendingRequest?.body?.action === 'create' ? pendingRequest.body.series : null;
        series.id = previous && JSON.stringify({ ...previous, id: '' }) === JSON.stringify({ ...series, id: '' })
          ? previous.id : `added-${root.crypto.randomUUID()}`;
        await mutate({ action: 'create', series }, 'Class added.');
      }
    });
    $('#addedClassEditCancel').addEventListener('click', () => { resetForm(); status(''); });
    $('#addedClassRetry').addEventListener('click', () => refresh());
    $('#addedClassImport').addEventListener('click', async () => {
      const { series } = localSeries();
      if (series.length) await mutate({ action: 'import', series }, 'Browser classes copied to the shared schedule.');
    });
    $('#addedClassList').addEventListener('click', event => {
      const edit = event.target.closest('[data-added-edit]');
      const cancel = event.target.closest('[data-added-cancel]');
      const id = edit?.dataset.addedEdit || cancel?.dataset.addedCancel;
      if (!id || busy) return;
      const series = shared.series.find(item => item.id === id);
      if (!series) return;
      if (edit) {
        editingId = id; pendingRequest = null;
        const form = $('#addedClassForm');
        form.elements.className.value = series.label; form.elements.startTime.value = series.time;
        form.elements.repeatMode.value = series.startDate === series.endDate ? 'one' : 'series';
        form.elements.singleDate.value = series.startDate;
        form.elements.startDate.value = series.startDate < today() ? today() : series.startDate;
        form.elements.endDate.value = series.endDate;
        form.querySelectorAll('[name="weekday"]').forEach(node => { node.checked = series.days.includes(node.value); });
        $('#addedClassFormHeading').textContent = 'Edit upcoming dates';
        $('#addedClassSave').textContent = 'Save upcoming changes';
        $('#addedClassEditCancel').hidden = false;
        preview(); form.scrollIntoView({ block: 'start', behavior: 'smooth' }); form.elements.className.focus({ preventScroll: true });
      } else {
        cancelTarget = { id, date: cancel.dataset.addedCancelDate || '' }; pendingRequest = null;
        const dates = cancelTarget.date ? [cancelTarget.date] : core.datesForSeries(series, { from: today() });
        $('#addedClassCancelCopy').replaceChildren(el('strong', '', `Cancel ${core.classLabel(series)} on these remaining dates?`), datesList(dates), el('p', 'record-detail', 'Earlier dates and all recorded teaching records stay unchanged.'));
        $('#addedClassCancelReview').hidden = false;
        $('#addedClassCancelReview').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        $('#addedClassCancelConfirm').focus();
      }
    });
    $('#addedClassCancelConfirm').addEventListener('click', async () => {
      if (cancelTarget) await mutate({ action: 'cancel', seriesId: cancelTarget.id,
        ...(cancelTarget.date ? { date: cancelTarget.date } : { effectiveDate: today() })
      }, cancelTarget.date ? 'Selected date canceled.' : 'Remaining dates canceled.');
    });
    $('#addedClassCancelClose').addEventListener('click', () => { cancelTarget = null; $('#addedClassCancelReview').hidden = true; });
    $('#addedClassHistoryList').addEventListener('click', event => {
      const button = event.target.closest('[data-added-review-date]');
      if (button) options.onReviewDate(button.dataset.addedReviewDate);
    });
    resetForm();
    return {
      refresh,
      classesForDate(days, date) { return core.classesForDate(days, shared || [], date); },
      isCurrent() { return current; },
      setActive(value) {
        active = value;
        if (!active) { generation += 1; current = false; pendingRequest = null; resetForm(); }
        preview();
      },
      open() { $('#add-class').open = true; $('#addedClassForm').elements.className.focus(); }
    };
  }
  root.GIBM1AddedClassesAdmin = Object.freeze({ create, classTiming, dateLabel });
})(globalThis);
