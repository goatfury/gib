(() => {
  'use strict';
  const countries = window.ATLAS_COUNTRIES;
  if (!Array.isArray(countries) || countries.length !== 197) throw new Error('The country set could not be loaded.');
  const $ = id => document.getElementById(id);
  const dom = Object.fromEntries(['answerInput','inputLabel','hintBtn','hintBadge','showBtn','countryCount','capitalCount','countryPercent','capitalPercent','timer','finishBtn','feedback','matchCue','roundStatus','worldMap','mapStage','worldBtn','zoomReadout','autoZoomBtn','autoZoomState','zoomInBtn','zoomOutBtn','answerKey','resultSummary','recordSummary','endReason','missedCountriesTitle','missedCapitalsTitle','missedCountries','missedCapitals','fullReference','newRoundBtn','closeKeyBtn','helpBtn','helpDialog','closeHelpBtn'].map(id => [id, $(id)]));
  const TOTAL = 197, DURATION = 15 * 60 * 1000, WORLD = [0, 38, 1200, 534];
  const RECORD_KEY = 'atlasRecall.clean.capitalRecords.v1';
  const byId = new Map(countries.map(c => [c.id, c]));
  const alphabetical = [...countries].sort((a, b) => a.quizName.localeCompare(b.quizName, 'en'));
  const mapNodes = new Map(countries.map(c => [c.id, [...document.querySelectorAll('[data-id="' + c.id + '"]')]]));
  const normalize = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  const percent = count => Math.round(count / TOTAL * 100) + '%';
  const entries = [];
  for (const c of countries) {
    for (const word of new Set([c.name, c.quizName, ...c.aliases])) entries.push({ id: c.id, kind: 'country', word, normalized: normalize(word), canonical: normalize(word) === normalize(c.name) || normalize(word) === normalize(c.quizName) });
    for (const word of new Set([c.capital, ...c.capitals])) entries.push({ id: c.id, kind: 'capital', word, normalized: normalize(word), canonical: normalize(word) === normalize(c.capital) });
  }
  const exactIndex = new Map();
  for (const e of entries) {
    if (!exactIndex.has(e.normalized)) exactIndex.set(e.normalized, []);
    exactIndex.get(e.normalized).push(e);
  }
  const state = { phase: 'ready', deadline: null, countries: new Set(), capitals: new Set(), revealedCapitals: new Set(), pending: null, hint: null, autoZoom: false, view: [...WORLD], records: loadRecords() };
  let autoTimer = null, teachingTimer = null, teachingQueue = [], teachingActive = false, composing = false, drag = null;

  function loadRecords() {
    try {
      const saved = JSON.parse(localStorage.getItem(RECORD_KEY) || 'null');
      if (saved && Number.isInteger(saved.baseline) && saved.baseline >= 0 && saved.baseline <= TOTAL && Number.isInteger(saved.best) && saved.best >= saved.baseline && saved.best <= TOTAL) return saved;
    } catch (_) { /* Local storage is optional; play does not depend on it. */ }
    return { baseline: null, best: null, rounds: 0 };
  }
  function saveRecords() {
    try { localStorage.setItem(RECORD_KEY, JSON.stringify(state.records)); } catch (_) { /* Private browsing can disable persistence. */ }
  }
  function cue(text, warning = false) { dom.matchCue.textContent = text; dom.matchCue.classList.toggle('warning', warning); }
  function feedback(lead, answer = '', meta = '', reveal = false) {
    dom.feedback.replaceChildren();
    const a = document.createElement('span'); a.className = 'feedback-lead'; a.textContent = lead; dom.feedback.append(a);
    if (answer) { const b = document.createElement('strong'); b.className = 'feedback-answer'; b.textContent = answer; dom.feedback.append(b); }
    if (meta) { const c = document.createElement('span'); c.className = 'feedback-meta'; c.textContent = meta; dom.feedback.append(c); }
    dom.feedback.classList.toggle('reveal', reveal);
  }
  function teach(lead, answer, meta, reveal = false) {
    teachingQueue.push({ lead, answer, meta, reveal });
    if (!teachingActive) nextTeaching();
  }
  function nextTeaching() {
    clearTimeout(teachingTimer);
    const item = teachingQueue.shift();
    teachingActive = !!item;
    if (!item) { if (state.phase !== 'ended') feedback(state.pending ? 'Try the capital, or keep moving.' : 'Keep going.', '', 'Countries and capitals count separately.'); return; }
    feedback(item.lead, item.answer, item.meta, item.reveal);
    teachingTimer = setTimeout(nextTeaching, 2250);
  }
  function clearTeaching() { clearTimeout(teachingTimer); teachingQueue = []; teachingActive = false; }
  function startIfNeeded() {
    if (state.phase !== 'ready') return;
    state.phase = 'playing'; state.deadline = Date.now() + DURATION;
    dom.roundStatus.textContent = 'Round live · name countries or capitals'; updateTimer();
  }
  function updateTimer() {
    let remaining = DURATION;
    if (state.phase === 'playing') remaining = Math.max(0, state.deadline - Date.now());
    if (state.phase === 'ended') return;
    const seconds = Math.ceil(remaining / 1000);
    dom.timer.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    dom.timer.classList.toggle('urgent', seconds <= 60);
    if (state.phase === 'playing' && remaining <= 0) finishRound('Time is up');
  }
  function renderCounts() {
    dom.countryCount.textContent = state.countries.size + ' / ' + TOTAL;
    dom.capitalCount.textContent = state.capitals.size + ' / ' + TOTAL;
    dom.countryPercent.textContent = percent(state.countries.size);
    dom.capitalPercent.textContent = percent(state.capitals.size);
  }
  function renderEntry() {
    const pending = state.pending && byId.get(state.pending);
    dom.inputLabel.textContent = pending ? 'Capital of ' + pending.quizName + '?' : 'Any country. Any capital.';
    dom.answerInput.placeholder = pending ? 'Capital of ' + pending.quizName + '?' : state.phase === 'ready' ? 'Type a country or capital to begin' : 'Type any country or capital';
    dom.showBtn.hidden = !pending || state.phase === 'ended';
    dom.hintBtn.textContent = state.hint ? '2nd letter' : 'Hint';
    dom.hintBtn.disabled = state.phase === 'ended' || (!!state.hint && state.hint.letters >= 2) || (!pending && state.countries.size === TOTAL);
    dom.hintBadge.hidden = !state.hint;
    if (state.hint) {
      const c = byId.get(state.hint.id), answer = state.hint.kind === 'capital' ? c.capital : c.quizName;
      dom.hintBadge.textContent = (state.hint.kind === 'capital' ? 'Capital: ' : 'Country: ') + [...answer].slice(0, state.hint.letters).join('') + '…';
    } else dom.hintBadge.textContent = '';
  }
  function renderMap() {
    for (const [id, nodes] of mapNodes) for (const node of nodes) {
      node.classList.toggle('recalled', state.countries.has(id));
      node.classList.toggle('hinted', !!state.hint && state.hint.kind === 'country' && state.hint.id === id);
      node.classList.toggle('missed', state.phase === 'ended' && !state.countries.has(id));
    }
  }
  function clearHint() { state.hint = null; renderMap(); }
  function applyView() {
    dom.worldMap.setAttribute('viewBox', state.view.map(n => +n.toFixed(2)).join(' '));
    dom.zoomReadout.textContent = Math.round(WORLD[2] / state.view[2] * 100) + '%';
    dom.autoZoomBtn.setAttribute('aria-pressed', String(state.autoZoom));
    dom.autoZoomState.textContent = state.autoZoom ? 'On' : 'Off';
    dom.zoomOutBtn.disabled = state.view[2] >= WORLD[2];
    dom.zoomInBtn.disabled = state.view[2] <= WORLD[2] / 6;
  }
  function clampView(view) {
    const w = Math.max(WORLD[2] / 6, Math.min(WORLD[2], view[2]));
    const h = w * WORLD[3] / WORLD[2];
    return [Math.max(0, Math.min(WORLD[2] - w, view[0])), Math.max(WORLD[1], Math.min(WORLD[1] + WORLD[3] - h, view[1])), w, h];
  }
  function zoom(factor) {
    const [x, y, w, h] = state.view, nw = Math.max(WORLD[2] / 6, Math.min(WORLD[2], w * factor)), nh = nw * WORLD[3] / WORLD[2];
    state.view = clampView([x + (w - nw) / 2, y + (h - nh) / 2, nw, nh]); applyView();
  }
  function follow(id) {
    if (!state.autoZoom) return;
    const node = mapNodes.get(id)?.[0]; if (!node) return;
    const box = node.getBBox(); let x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (node.classList.contains('country-marker')) { const matrix = node.transform.baseVal.consolidate()?.matrix; if (matrix) { x += matrix.e; y += matrix.f; } }
    const w = Math.min(1200, Math.max(340, box.width * 2.7, box.height * 2.7 * WORLD[2] / WORLD[3]));
    state.view = clampView([x - w / 2, y - w * WORLD[3] / WORLD[2] / 2, w, w * WORLD[3] / WORLD[2]]); applyView();
  }
  // Optimal-string-alignment distance handles a single swapped pair as one typo.
  function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) d[i][0] = i;
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }
  function uniqueEntries(list) {
    const seen = new Set();
    return list.filter(e => { const key = e.kind + ':' + e.id; if (seen.has(key)) return false; seen.add(key); return true; });
  }
  function choose(list, fuzzy = false) {
    const candidates = uniqueEntries([...list].sort((a, b) => Number(b.canonical) - Number(a.canonical)));
    const pending = candidates.find(e => e.kind === 'capital' && e.id === state.pending);
    if (pending) return { type: 'accept', entry: pending, fuzzy };
    // A city-state's shared name genuinely names both answers.
    const country = candidates.find(e => e.kind === 'country' && !state.countries.has(e.id));
    if (country && candidates.every(e => e.id === country.id)) return { type: 'accept', entry: country, fuzzy, alsoCapital: candidates.find(e => e.kind === 'capital' && e.id === country.id) || null };
    const fresh = candidates.filter(e => e.kind === 'country' ? !state.countries.has(e.id) : !state.capitals.has(e.id));
    const preferred = fresh.filter(e => e.canonical);
    const pool = preferred.length === 1 ? preferred : fresh;
    if (pool.length === 1) return { type: 'accept', entry: pool[0], fuzzy };
    if (pool.length > 1) return { type: 'ambiguous' };
    return { type: 'duplicate', entry: candidates[0] };
  }
  function match(raw) {
    const norm = normalize(raw); if (!norm) return { type: 'empty' };
    if (exactIndex.has(norm)) {
      const result = choose(exactIndex.get(norm));
      result.prefix = entries.some(e => e.normalized.length > norm.length && e.normalized.startsWith(norm));
      return result;
    }
    if (norm.length < 4) return { type: 'unknown' };
    const limit = norm.length >= 9 ? 2 : 1;
    let best = Infinity, hits = [];
    for (const e of entries) {
      if (Math.abs(e.normalized.length - norm.length) > limit || e.normalized.length < 4) continue;
      const d = distance(norm, e.normalized);
      if (d > limit || d / Math.max(norm.length, e.normalized.length) > .25) continue;
      if (d < best) { best = d; hits = [e]; } else if (d === best) hits.push(e);
    }
    return hits.length ? choose(hits, true) : { type: 'unknown' };
  }
  function revealPending() {
    if (!state.pending || state.phase === 'ended') return false;
    const c = byId.get(state.pending);
    state.revealedCapitals.add(c.id);
    teach('Shown, not counted:', c.capital + '.', c.quizName + ' · keep going', true);
    state.pending = null; clearHint(); renderEntry();
    cue('Any country or any capital is welcome.');
    return true;
  }
  function acceptCapital(entry, raw, fuzzy) {
    const c = byId.get(entry.id), already = state.capitals.has(c.id), revealed = state.revealedCapitals.has(c.id);
    if (!already && !revealed) state.capitals.add(c.id);
    const canonical = entry.canonical || ['Prishtina','Kiev','Ulan Bator','Ulanbaatar','Nay Pyi Taw','Naypyitaw','Washington DC','Washington','City of San Marino','The Vatican','Kotte','Sri Jayewardenepura Kotte'].includes(entry.word) ? c.capital : entry.word;
    const lead = fuzzy ? 'Correct spelling:' : 'Spelling confirmed:';
    let meta = fuzzy ? 'You typed “' + raw + '”.' : c.quizName + ' · capital';
    if (revealed) meta += ' Shown earlier — no point this round.';
    else if (already) meta += ' Already counted.';
    teach(lead, canonical + '.', meta, revealed);
    if (state.pending === c.id) { state.pending = null; clearHint(); }
  }
  function accept(result, raw) {
    if (state.phase === 'ended') return;
    startIfNeeded();
    clearTimeout(autoTimer); dom.answerInput.value = '';
    const e = result.entry, c = byId.get(e.id);
    if (e.kind === 'country') {
      if (state.pending && state.pending !== c.id) revealPending();
      state.countries.add(c.id); clearHint();
      if (result.alsoCapital) acceptCapital(result.alsoCapital, raw, result.fuzzy);
      state.pending = state.capitals.has(c.id) || state.revealedCapitals.has(c.id) ? null : c.id;
      if (!teachingActive) feedback(result.fuzzy ? 'Country spelling:' : 'Country counted:', c.quizName + '.', result.fuzzy ? 'You typed “' + raw + '”.' : '');
      follow(c.id);
    } else acceptCapital(e, raw, result.fuzzy);
    renderCounts(); renderMap(); renderEntry();
    cue(state.pending ? 'Capital, next country, or blank Enter / Tab to show.' : 'Enter checks a close spelling.');
    if (state.countries.size === TOTAL && state.capitals.size === TOTAL) finishRound('Every answer recalled');
  }
  function onInput() {
    clearTimeout(autoTimer);
    if (state.phase === 'ended' || composing) return;
    const raw = dom.answerInput.value.trim();
    if (!raw) { cue(state.pending ? 'Blank Enter / Tab shows the capital without a point.' : 'Enter checks a close spelling.'); return; }
    startIfNeeded();
    const result = match(raw);
    if (result.type === 'accept') {
      if (result.fuzzy) { cue('Close spelling found — press Enter to check.', true); return; }
      if (result.prefix) { cue('Recognized — press Enter, or keep typing.', true); return; }
      cue('Recognized.');
      autoTimer = setTimeout(() => { if (!composing && dom.answerInput.value.trim() === raw && state.phase === 'playing') accept(result, raw); }, 380);
    } else if (result.type === 'duplicate') cue('Already counted. Try another answer.');
    else if (result.type === 'ambiguous') cue('More than one match. Name the country first.', true);
    else cue('Keep typing; Enter checks your answer.');
  }
  function submit() {
    clearTimeout(autoTimer);
    if (state.phase === 'ended') return;
    const raw = dom.answerInput.value.trim();
    if (!raw) { revealPending(); return; }
    startIfNeeded();
    const result = match(raw);
    if (result.type === 'accept') accept(result, raw);
    else {
      cue(result.type === 'duplicate' ? 'Already counted — no extra point.' : result.type === 'ambiguous' ? 'More than one match. Name the country first.' : 'Not recognized. Check spelling or try another answer.', true);
      dom.answerInput.select();
    }
  }
  function requestHint() {
    if (state.phase === 'ended') return;
    if (state.hint) { if (state.hint.letters < 2) state.hint.letters = 2; }
    else if (state.pending) state.hint = { kind: 'capital', id: state.pending, letters: 1 };
    else { const target = alphabetical.find(c => !state.countries.has(c.id)); if (target) state.hint = { kind: 'country', id: target.id, letters: 1 }; }
    renderEntry(); renderMap();
    cue(state.hint?.letters === 1 ? 'One letter only. Use “2nd letter” for one more.' : 'Two letters shown. No answer has been counted.');
    dom.answerInput.focus({ preventScroll: true });
  }
  function listItem(target, c, capitalFirst) {
    const li = document.createElement('li'); li.dataset.countryId = c.id;
    const primary = document.createElement('strong'); primary.textContent = capitalFirst ? c.capital : c.quizName;
    const secondary = document.createElement('span'); secondary.textContent = capitalFirst ? c.quizName : c.capital;
    li.append(primary, secondary); target.append(li);
  }
  function renderAnswerKey() {
    const missedCountries = alphabetical.filter(c => !state.countries.has(c.id));
    const missedCapitals = alphabetical.filter(c => !state.capitals.has(c.id));
    dom.resultSummary.replaceChildren();
    for (const [count, name, className] of [[state.countries.size, 'countries', 'country-result'], [state.capitals.size, 'capitals', 'cap-result']]) {
      const block = document.createElement('div'); block.className = className;
      const strong = document.createElement('strong'); strong.textContent = count + ' / ' + TOTAL;
      const span = document.createElement('span'); span.textContent = name + ' · ' + percent(count); block.append(strong, span); dom.resultSummary.append(block);
    }
    const records = state.records;
    dom.recordSummary.textContent = records.baseline === null ? 'Complete a round to set your first capital baseline.' : 'First capital baseline: ' + records.baseline + ' / ' + TOTAL + ' (' + percent(records.baseline) + ') · Best: ' + records.best + ' / ' + TOTAL + ' (' + percent(records.best) + ')';
    dom.missedCountriesTitle.textContent = 'Missed countries · ' + missedCountries.length;
    dom.missedCapitalsTitle.textContent = 'Missed capitals · ' + missedCapitals.length;
    dom.missedCountries.replaceChildren(); dom.missedCapitals.replaceChildren(); dom.fullReference.replaceChildren();
    for (const c of missedCountries) listItem(dom.missedCountries, c, false);
    for (const c of missedCapitals) listItem(dom.missedCapitals, c, true);
    for (const list of [dom.missedCountries, dom.missedCapitals]) if (!list.children.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'All recalled.'; list.append(li); }
    for (const c of alphabetical) {
      const row = document.createElement('div'); row.className = 'reference-row'; row.dataset.countryId = c.id;
      const name = document.createElement('strong'); name.textContent = c.quizName;
      const cap = document.createElement('span'); cap.textContent = c.capital; row.append(name, cap); dom.fullReference.append(row);
    }
  }
  function finishRound(reason = 'Round finished') {
    if (state.phase === 'ended') { if (!dom.answerKey.open) dom.answerKey.showModal(); return; }
    clearTimeout(autoTimer); clearTeaching();
    const started = state.phase === 'playing';
    state.phase = 'ended'; state.pending = null; state.hint = null;
    if (started) { if (state.records.baseline === null) state.records.baseline = state.capitals.size; state.records.best = Math.max(state.records.best || 0, state.capitals.size); state.records.rounds = (state.records.rounds || 0) + 1; saveRecords(); }
    dom.endReason.textContent = reason.toUpperCase();
    dom.answerInput.disabled = true; dom.finishBtn.textContent = 'Answers';
    dom.roundStatus.textContent = 'Round complete · answers revealed without points';
    renderEntry(); renderMap(); renderCounts(); renderAnswerKey();
    feedback('Round complete.', '', 'Open Answers to review, or start a new round.');
    dom.answerKey.showModal();
  }
  function newRound() {
    clearTimeout(autoTimer); clearTeaching();
    if (dom.answerKey.open) dom.answerKey.close();
    state.phase = 'ready'; state.deadline = null; state.countries.clear(); state.capitals.clear(); state.revealedCapitals.clear(); state.pending = null; state.hint = null; state.autoZoom = false; state.view = [...WORLD];
    dom.answerInput.value = ''; dom.answerInput.disabled = false; dom.finishBtn.textContent = 'Finish';
    dom.roundStatus.textContent = 'Your first letter starts the clock.';
    const reference = dom.fullReference.closest('details'); if (reference) reference.open = false;
    renderCounts(); renderEntry(); renderMap(); updateTimer(); applyView();
    feedback('Start anywhere.', '', 'Exact answers count automatically.'); cue('Enter checks a close spelling.');
    dom.answerInput.focus({ preventScroll: true });
  }
  dom.answerInput.addEventListener('input', onInput);
  dom.answerInput.addEventListener('compositionstart', () => { composing = true; clearTimeout(autoTimer); });
  dom.answerInput.addEventListener('compositionend', () => { composing = false; onInput(); });
  dom.answerInput.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
    else if (event.key === 'Tab' && !event.shiftKey && !dom.answerInput.value.trim() && state.pending) { event.preventDefault(); revealPending(); }
  });
  dom.hintBtn.addEventListener('click', requestHint);
  dom.showBtn.addEventListener('click', () => { revealPending(); dom.answerInput.value = ''; clearTimeout(autoTimer); dom.answerInput.focus({ preventScroll: true }); });
  dom.finishBtn.addEventListener('click', () => finishRound());
  dom.newRoundBtn.addEventListener('click', newRound);
  dom.closeKeyBtn.addEventListener('click', () => dom.answerKey.close());
  dom.helpBtn.addEventListener('click', () => dom.helpDialog.showModal());
  dom.closeHelpBtn.addEventListener('click', () => { dom.helpDialog.close(); dom.answerInput.focus({ preventScroll: true }); });
  dom.worldBtn.addEventListener('click', () => { state.view = [...WORLD]; state.autoZoom = false; applyView(); dom.answerInput.focus({ preventScroll: true }); });
  dom.autoZoomBtn.addEventListener('click', () => { state.autoZoom = !state.autoZoom; applyView(); dom.answerInput.focus({ preventScroll: true }); });
  dom.zoomInBtn.addEventListener('click', () => zoom(.75)); dom.zoomOutBtn.addEventListener('click', () => zoom(1 / .75));
  dom.mapStage.addEventListener('pointerdown', event => { if (state.view[2] >= 1200) return; drag = { x: event.clientX, y: event.clientY, view: [...state.view] }; dom.mapStage.setPointerCapture(event.pointerId); });
  dom.mapStage.addEventListener('pointermove', event => { if (!drag) return; const rect = dom.worldMap.getBoundingClientRect(); const scale = Math.min(rect.width / drag.view[2], rect.height / drag.view[3]); state.view = clampView([drag.view[0] - (event.clientX - drag.x) / scale, drag.view[1] - (event.clientY - drag.y) / scale, drag.view[2], drag.view[3]]); applyView(); });
  dom.mapStage.addEventListener('pointerup', () => { drag = null; }); dom.mapStage.addEventListener('pointercancel', () => { drag = null; });
  document.addEventListener('keydown', event => { if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.key === ' ' || document.querySelector('dialog[open]') || ['INPUT','BUTTON','SELECT','TEXTAREA'].includes(document.activeElement.tagName) || state.phase === 'ended') return; event.preventDefault(); dom.answerInput.focus({ preventScroll: true }); dom.answerInput.value += event.key; onInput(); });
  document.addEventListener('visibilitychange', updateTimer);
  setInterval(updateTimer, 250);
  newRound();
  // Read-only observability; scoring and timeout tests still use the actual UI.
  window.atlasSnapshot = () => ({ build: document.body.dataset.build, phase: state.phase, countries: [...state.countries], capitals: [...state.capitals], revealedCapitals: [...state.revealedCapitals], pending: state.pending, hint: state.hint && { ...state.hint }, view: [...state.view], autoZoom: state.autoZoom, records: { ...state.records } });
  window.__ATLAS_READY = true;
})();
