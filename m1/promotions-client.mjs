import { promotionsTemplate } from './promotions-template.mjs?v=2026-09-14-promotions-repair-c';
import { promotionsEnabled, createPromotionsLifecycle } from './promotions-core.mjs?v=2026-09-14-promotions-repair-c';

export function createPromotionsTransport(fetcher, { timeoutMs = 30000, online = () => globalThis.navigator?.onLine !== false, testOnly = true, onDiagnostic } = {}) {
  const diagnose = testOnly === true && typeof onDiagnostic === 'function';
  const operations = new Set(['bootstrap', 'readStudent', 'checkSave', 'recordPromotion', 'confirmRank', 'registerStudent', 'correctLatest']);
  const errorCodes = new Set(['UNAVAILABLE', 'UNAUTHORIZED', 'VALIDATION', 'NOT_FOUND', 'ARCHIVED', 'RANK_UNKNOWN', 'RANK_ALREADY_KNOWN',
    'STALE_REVISION', 'REQUEST_CONFLICT', 'DUPLICATE_STUDENT', 'CORRECTION_NOT_LATEST', 'TEST_DESTINATION_INVALID', 'LIVE_DESTINATION_INVALID', 'BUSY']);
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const numericHeader = (value, minimum, maximum) => typeof value === 'string' && /^(0|[1-9][0-9]{0,8})$/u.test(value)
    && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null;
  const traceHeader = value => {
    if (typeof value !== 'string' || value.length > 10000) return null;
    try {
      const trace = JSON.parse(value);
      const fields = ['method', 'host', 'status', 'type', 'ms', 'destination'];
      const hosts = ['google-content', 'google-script', 'google-auth', 'other', 'missing'];
      if (!Array.isArray(trace) || trace.length > 20 || !trace.every(hop => hop && typeof hop === 'object' && !Array.isArray(hop)
        && Object.keys(hop).length === fields.length && fields.every(field => Object.hasOwn(hop, field))
        && ['POST', 'GET'].includes(hop.method) && hosts.includes(hop.host)
        && (hop.status === null || (Number.isInteger(hop.status) && hop.status >= 100 && hop.status <= 599))
        && ['json', 'html', 'other', 'missing'].includes(hop.type)
        && Number.isInteger(hop.ms) && hop.ms >= 0 && hop.ms <= 3600000
        && [...hosts, 'none'].includes(hop.destination))) return null;
      return trace.map(({ method, host, status, type, ms, destination }) => ({ method, host, status, type, ms, destination }));
    } catch (_) { return null; }
  };
  return payload => new Promise((resolve, reject) => {
    const startedAt = diagnose ? new Date().toISOString() : null;
    const startedMs = diagnose ? clock() : 0;
    let phase = 'fetch';
    let httpStatus = null;
    let upstream = { upstreamPhase:null, upstreamMs:null, upstreamStatus:null, upstreamType:null, upstreamRedirected:null, upstreamHost:null, upstreamEnvelope:null, upstreamTrace:null };
    let settled = false;
    let timer;
    const finish = (fn, value, outcome) => {
      if (settled) return;
      settled = true; clearTimeout(timer); fn(value);
      if (diagnose) {
        try {
          const record = {
            operation:operations.has(payload?.operation) ? payload.operation : 'OTHER', startedAt,
            browserElapsedMs:Math.max(0, Math.round(clock() - startedMs)), phase, httpStatus,
            errorCode:outcome === 'success' ? null : errorCodes.has(value?.code) ? value.code : 'OTHER', outcome, ...upstream
          };
          // Observers receive only fixed categories/timing, never the input or
          // reply. Their failure cannot alter settlement or trigger a retry.
          Promise.resolve(onDiagnostic(record)).catch(() => {});
        } catch (_) { /* TEST observation cannot affect the request. */ }
      }
    };
    if (!online()) { phase = 'offline'; finish(reject, { code:'UNAVAILABLE', message:'Connect to load a fresh record or send this entry.', retryable:true }, 'error'); return; }
    const abort = new AbortController();
    timer = setTimeout(() => { phase = 'timeout'; finish(reject, { code:'UNAVAILABLE', message:'No confirmation arrived. Keep this entry and check or retry it.', retryable:true }, 'error'); abort.abort(); }, timeoutMs);
    Promise.resolve().then(() => fetcher('/api/m1-promotions', {
      method:'POST', credentials:'same-origin', cache:'no-store', signal:abort.signal,
      headers:{ 'Content-Type':'application/json', Accept:'application/json' }, body:JSON.stringify(payload)
    })).then(async response => {
      phase = 'body';
      if (diagnose) {
        httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        try {
          const header = name => response.headers?.get?.('X-GIB-TEST-Upstream' + name);
          const category = (value, allowed) => allowed.includes(value) ? value : null;
          upstream = {
            upstreamPhase:category(header(''), ['fetch', 'body', 'http', 'json', 'envelope']),
            upstreamMs:numericHeader(header('-Ms'), 0, 3600000), upstreamStatus:numericHeader(header('-Status'), 100, 599),
            upstreamType:category(header('-Type'), ['json', 'html', 'other', 'missing']),
            upstreamRedirected:numericHeader(header('-Redirected'), 0, 1),
            upstreamHost:category(header('-Host'), ['google-content', 'google-script', 'google-auth', 'other', 'missing']),
            upstreamEnvelope:category(header('-Envelope'), ['bare-auth-denial', 'mismatch', 'none']),
            upstreamTrace:traceHeader(header('-Trace'))
          };
        } catch (_) { /* Missing diagnostic headers do not change the reply. */ }
      }
      const body = await response.json();
      phase = 'application';
      if (response.ok && body?.ok === true && body.data && typeof body.data === 'object') finish(resolve, body.data, 'success');
      else finish(reject, body?.error || { code:response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'UNAVAILABLE', message:`The ${testOnly ? 'TEST ' : ''}log could not confirm this request.`, retryable:response.status >= 500 }, 'error');
    }).catch(() => finish(reject, { code:'UNAVAILABLE', message:'The connection was interrupted. This entry is not confirmed.', retryable:true }, 'error'));
  });
}


export function mountPromotionsLog({ document = globalThis.document, profile = globalThis.M1_INSTALLATION_PROFILE, config = globalThis.M1_PROMOTIONS_TEST_CONFIG, fetcher = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage, now = Date.now, windowTarget = globalThis.window, origin = globalThis.location?.origin } = {}) {
  if (!promotionsEnabled(profile, config, origin)) return null;
  const testOnly = config.testOnly;
  const target = testOnly ? 'test' : 'live';
  const host = document.getElementById('promotionsPanel');
  const navigation = document.getElementById('promotionsNavigation');
  if (!host || !navigation) return null;
  host.innerHTML = promotionsTemplate;
  const $ = id => host.querySelector(`[data-promo-id="${id}"]`);
  if (!testOnly) {
    $('modeBadge').textContent = ''; $('modeBadge').hidden = true;
    $('privacyNote').textContent = 'Lookups clear after 60 seconds without activity. Confirmed entries return to Sign-In after 3 seconds.';
  }
  const transport = createPromotionsTransport(fetcher, { testOnly,
    onDiagnostic:testOnly ? record => console.info('Promotions TEST lookup', JSON.stringify(record)) : undefined
  });
  const lifecycle = createPromotionsLifecycle({ now, storage, onClear: clearPresentation });
  const state = {
    students: new Map(), approvers: [], recorderLabel: '', todayNY: '', selected: null,
    history: [], selectedGeneration: 0, readGeneration: 0, searchGeneration: 0, searchResults: [], activeResult: -1,
    approverResults: [], activeApproverResult: -1,
    draft: null, drafts: new Map(), pending: null, authenticated: false, loadingStudent: false, selectedFresh: false
  };
  const belts = ['White Belt', 'Blue Belt', 'Purple Belt', 'Brown Belt', 'Black Belt'];
  const mutationErrors = new Set(['VALIDATION', 'NOT_FOUND', 'ARCHIVED', 'RANK_UNKNOWN', 'RANK_ALREADY_KNOWN', 'STALE_REVISION', 'REQUEST_CONFLICT', 'DUPLICATE_STUDENT', 'CORRECTION_NOT_LATEST', 'TEST_DESTINATION_INVALID']);
  const eventLabels = { REGISTER:'Student registered', RANK_CONFIRM:'Current rank confirmed', STRIPE:'Stripe or degree added', BELT:'Belt changed', CORRECTION:'Audited correction', REPAIR:'Data repair' };

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }
  function rankLabel(student) {
    if (!student || !student.rankKnown) return 'Unknown — needs confirmation';
    const type = student.belt === 'Black Belt' ? 'degree' : 'stripe';
    return `${student.belt} · ${student.marks} ${type}${student.marks === 1 ? '' : 's'}`;
  }
  function normalize(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim(); }
  function dateLabel(value) {
    if (!value) return 'Date not recorded';
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return String(value);
    const date = new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0,10) !== value) return String(value);
    return new Intl.DateTimeFormat('en-US', { timeZone:'UTC', year:'numeric', month:'long', day:'numeric' }).format(date);
  }
  function identityLabel(student) {
    const label = String(student?.distinguishingLabel || '');
    return /^Legacy .+ row \d+$/u.test(label) ? `Source record: ${label}` : label;
  }
  function todayNY() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function newRequestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function showMessage(message, tone = '') {
    $('message').textContent = message;
    $('message').className = `notice ${tone}`;
    $('message').hidden = !message;
  }
  function formError(message) { $('formError').textContent = message; $('formError').hidden = !message; }
  function rpc(payload) { return transport(payload); }
  function accessFailure(error) {
    state.authenticated = false;
    $('app').hidden = true;
    $('recorder').hidden = true;
    $('accessStatus').hidden = false;
    $('accessStatus').className = 'notice error';
    $('accessStatus').textContent = error?.code === 'UNAUTHORIZED'
      ? `This tablet is not authorized for the ${testOnly ? 'TEST ' : ''}log. Sign-In is still available.`
      : (error?.message || 'The protected log could not be loaded.');
    $('retryAccess').hidden = false;
  }
  async function bootstrap() {
    const viewToken = lifecycle.token();
    state.authenticated = false;
    $('app').hidden = true;
    $('retryAccess').hidden = true;
    $('accessStatus').hidden = false;
    $('accessStatus').className = 'notice';
    $('accessStatus').textContent = 'Checking secure access…';
    try {
      const data = await rpc({ operation:'bootstrap' });
      if (!lifecycle.isCurrent(viewToken)) return;
      if (data.testOnly !== testOnly || (data.target !== undefined && data.target !== target) || !Array.isArray(data.students)) {
        throw { code:testOnly ? 'TEST_DESTINATION_INVALID' : 'LIVE_DESTINATION_INVALID', message:`The ${testOnly ? 'TEST' : 'live'} destination could not be verified.` };
      }
      state.students = new Map(data.students.map(student => [student.studentId, student]));
      state.approvers = Array.isArray(data.approvers) ? data.approvers : [];
      state.recorderLabel = String(data.recorderLabel || (testOnly ? 'Authorized TEST tablet' : 'Authorized Revolution tablet'));
      state.todayNY = data.todayNY;
      state.authenticated = true;
      closeApproverSuggestions();
      $('recorder').textContent = `Access: ${state.recorderLabel}`;
      $('recorder').hidden = false;
      $('accessStatus').hidden = true;
      $('app').hidden = false;
      renderSearch();
      renderBusy();
    } catch (error) { if (lifecycle.isCurrent(viewToken)) accessFailure(error); }
  }

  function renderSearch() {
    if (globalThis.navigator?.onLine === false) {
      closeSearch(); $('searchResults').replaceChildren();
      $('searchHint').textContent = 'Connect to look up a fresh student record.';
      return;
    }
    const query = normalize($('studentSearch').value);
    const matches = query ? [...state.students.values()].filter(student => normalize(`${student.displayName} ${student.distinguishingLabel}`).includes(query)) : [];
    state.searchResults = matches.slice(0, 8);
    state.activeResult = -1;
    $('searchResults').replaceChildren();
    for (const [index, student] of state.searchResults.entries()) {
      const option = node('button', undefined, 'search-option');
      option.type = 'button'; option.id = `promotions-student-result-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      option.append(node('strong', student.displayName), node('span', `${identityLabel(student)}${student.status === 'archived' ? ' · Archived' : ''}`));
      option.addEventListener('click', () => selectStudent(student.studentId));
      $('searchResults').append(option);
    }
    const open = state.searchResults.length > 0;
    $('searchResults').hidden = !open;
    $('studentSearch').setAttribute('aria-expanded', String(open));
    $('studentSearch').removeAttribute('aria-activedescendant');
    $('searchHint').textContent = !query
      ? 'Search by first name, surname, or full name.'
      : matches.length === 0 ? 'No matching student. Add a separate student if they are missing.'
      : matches.length > 8 ? `Showing 8 of ${matches.length} matches. Type more to narrow the list.`
      : 'Choose the full name. Identical names remain separate records; check the details below each name.';
  }
  function closeSearch() {
    $('searchResults').hidden = true;
    $('studentSearch').setAttribute('aria-expanded', 'false');
    $('studentSearch').removeAttribute('aria-activedescendant');
    state.activeResult = -1;
  }
  function renderApproverSuggestions() {
    const query = normalize($('approverChoice').value);
    closeApproverSuggestions();
    if (!query || $('approverChoice').disabled) return;
    const names = [...new Set(state.approvers.map(approver => approver?.label).filter(name => typeof name === 'string' && name.trim()))];
    state.approverResults = names.filter(name => normalize(name).includes(query)).slice(0, 4);
    for (const [index, name] of state.approverResults.entries()) {
      const option = node('button', name, 'search-option');
      option.type = 'button'; option.tabIndex = -1; option.id = `promotions-approver-result-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      // Keep the input focused until an explicit pointer selection completes.
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => selectApproverSuggestion(name));
      $('approverSuggestions').append(option);
    }
    const open = state.approverResults.length > 0;
    $('approverSuggestions').hidden = !open;
    $('approverChoice').setAttribute('aria-expanded', String(open));
  }
  function closeApproverSuggestions() {
    state.approverResults = []; state.activeApproverResult = -1;
    $('approverSuggestions').replaceChildren(); $('approverSuggestions').hidden = true;
    $('approverChoice').setAttribute('aria-expanded', 'false');
    $('approverChoice').removeAttribute('aria-activedescendant');
  }
  function selectApproverSuggestion(name) {
    if (!lifecycle.isCurrent(lifecycle.token()) || !state.draft || state.pending || $('approverChoice').disabled
      || $('approverSuggestions').hidden || !state.approverResults.includes(name)) return;
    $('approverChoice').value = name;
    readDraftControls(); closeApproverSuggestions(); $('approverChoice').focus();
  }
  function resetDraftApprover(draft) {
    if (!draft || draft === state.pending?.submittedDraft) return;
    draft.approverName = '';
    draft.intent = null; draft.intentSignature = '';
  }
  async function selectStudent(studentId) {
    if (!lifecycle.snapshot().active || lifecycle.snapshot().phase === 'success') return;
    state.selectedFresh = false;
    $('historyDisclosure').open = false;
    if (state.draft) state.drafts.set(state.draft.studentId || '__register', state.draft);
    state.selected = state.students.get(studentId) || null;
    state.selectedGeneration += 1;
    state.history = [];
    state.draft = state.drafts.get(studentId) || null;
    resetDraftApprover(state.draft);
    $('studentSearch').value = state.selected?.displayName || '';
    closeSearch();
    showMessage('');
    renderStudent();
    renderEditor(true);
    await refreshSelected();
  }
  async function refreshSelected() {
    if (!state.selected) return;
    const studentId = state.selected.studentId;
    const selectedGeneration = state.selectedGeneration;
    const viewToken = lifecycle.token();
    const readGeneration = ++state.readGeneration;
    state.loadingStudent = true;
    renderBusy();
    try {
      const data = await rpc({ operation:'readStudent', studentId });
      if (!lifecycle.isCurrent(viewToken) || selectedGeneration !== state.selectedGeneration || readGeneration !== state.readGeneration || state.selected?.studentId !== studentId) return;
      if (!data.student || data.student.studentId !== studentId || !Array.isArray(data.history)) throw { message:'The student record could not be verified.' };
      if ((state.students.get(studentId)?.revision || 0) > data.student.revision) return;
      state.selectedFresh = true;
      state.selected = data.student;
      state.students.set(studentId, data.student);
      state.history = data.history;
      if (state.draft) state.draft.expectedRevision = data.student.revision;
      renderStudent();
      renderEditor(false);
    } catch (error) {
      if (!lifecycle.isCurrent(viewToken) || selectedGeneration !== state.selectedGeneration) return;
      state.selectedFresh = false;
      renderStudent();
      if (error?.code === 'UNAUTHORIZED') accessFailure(error);
      else showMessage(error?.message || 'The current record could not be loaded. Refresh before saving.', 'error');
    } finally {
      if (lifecycle.isCurrent(viewToken) && selectedGeneration === state.selectedGeneration && readGeneration === state.readGeneration) { state.loadingStudent = false; renderBusy(); }
    }
  }
  function renderStudent() {
    const student = state.selected;
    $('studentCard').hidden = !student;
    $('historyCard').hidden = !student || !state.selectedFresh;
    if (!student) return;
    $('studentName').textContent = student.displayName;
    $('studentIdentity').textContent = identityLabel(student);
    $('studentRank').textContent = state.selectedFresh ? rankLabel(student) : 'Current rank not yet verified';
    const latestPromotion = [...state.history].sort((a,b) => b.revision - a.revision).find(event => ['STRIPE','BELT'].includes(event.eventKind) && event.eventDateNY);
    const lastPromotionDate = typeof student.lastPromotionDateNY === 'string' ? student.lastPromotionDateNY : latestPromotion?.eventDateNY;
    $('studentDate').textContent = state.selectedFresh ? `Latest promotion: ${dateLabel(lastPromotionDate)}` : 'Connect and refresh to verify this record.';
    $('studentState').hidden = student.status !== 'archived' && student.rankKnown;
    $('studentState').textContent = student.status === 'archived'
      ? 'Archived student. Their record and history are available to read; promotions are disabled.'
      : 'The current rank is uncertain. Confirm a verified rank before recording a promotion. Unknown historical dates stay unknown.';
    $('promotionActions').hidden = !state.selectedFresh || student.status !== 'active' || !student.rankKnown;
    $('confirmRank').hidden = !state.selectedFresh || student.status !== 'active' || student.rankKnown;
    $('addStripe').textContent = student.belt === 'Black Belt' ? 'Add degree' : 'Add stripe';
    const legacy = [student.historyNote].filter(Boolean).join('\n');
    $('legacyDetails').hidden = !legacy;
    $('legacyNotes').textContent = legacy;
    $('legacyNotes').style.whiteSpace = 'pre-wrap';
    renderHistory();
    renderBusy();
  }
  function latestCorrectable() {
    const latest = [...state.history].sort((left, right) => right.revision - left.revision)
      .find(event => !(event.eventKind === 'REPAIR' && event.repair?.field === 'identity'));
    return latest && ['RANK_CONFIRM', 'STRIPE', 'BELT', 'CORRECTION'].includes(latest.eventKind) ? latest : null;
  }
  function renderHistory() {
    $('historyList').replaceChildren();
    const history = [...state.history].sort((left, right) => right.revision - left.revision);
    $('historyEmpty').hidden = history.length > 0;
    for (const event of history) {
      const article = node('article', undefined, 'history-item');
      article.append(node('h3', `${event.eventDateNY || 'Date not recorded'} · ${eventLabels[event.eventKind] || 'Recorded event'}`));
      if (event.eventKind === 'REPAIR' && event.repair?.field === 'identity') {
        article.append(node('p', `${event.repair.before.displayName} → ${event.repair.after.displayName}`));
        if (event.repair.before.distinguishingLabel !== event.repair.after.distinguishingLabel) {
          article.append(node('p', `Identifying label: ${event.repair.before.distinguishingLabel} → ${event.repair.after.distinguishingLabel}`, 'history-meta'));
        }
      } else {
        article.append(node('p', `${event.before ? rankLabel(event.before) : 'New identity'} → ${rankLabel(event.after)}`));
      }
      if (event.eventKind === 'REPAIR') {
        article.append(node('p', 'Source-supported data repair. This is not an instructor-awarded promotion.', 'history-meta'));
        if (event.repair?.field === 'rank') article.append(node('p', `Historical promotion date: ${dateLabel(event.repair.after.lastPromotionDateNY)}`, 'history-meta'));
        if (event.repair?.evidence?.interpretation) article.append(node('p', event.repair.evidence.interpretation, 'small'));
      }
      const recordedThrough = /^m1-test-device-[a-f0-9]{24}$/u.test(event.recorderIdentity || '')
        ? 'Authorized TEST tablet' : /^m1-live-device-[a-f0-9]{24}$/u.test(event.recorderIdentity || '')
          ? 'Authorized Revolution tablet' : 'Earlier log';
      if (event.eventKind !== 'REPAIR') article.append(node('p', `Promoted by: ${event.approverLabel || 'Not recorded'} · Recorded through: ${recordedThrough}`, 'history-meta'));
      if (event.eventKind !== 'REPAIR' && event.reason) article.append(node('p', event.reason, 'small'));
      if (event.correctsEventId) article.append(node('p', 'Corrects an earlier entry; the original is retained below.', 'history-meta'));
      $('historyList').append(article);
    }
    const canCorrect = state.selectedFresh && state.selected?.status === 'active' && Boolean(latestCorrectable());
    $('correctLatest').hidden = !canCorrect;
    $('correctionHint').hidden = !canCorrect;
  }

  function openDraft(kind) {
    if (state.pending || state.loadingStudent || lifecycle.snapshot().phase === 'success') return;
    const student = state.selected;
    if (kind !== 'register' && (!state.selectedFresh || !student || student.status !== 'active')) return;
    const studentId = kind === 'register' ? null : student.studentId;
    const savedDraft = state.draft?.kind === kind && state.draft.studentId === studentId
      ? state.draft : state.drafts.get(studentId || '__register');
    if (savedDraft?.kind === kind) {
      state.draft = savedDraft;
      resetDraftApprover(state.draft);
      renderEditor(true);
      $('editor').scrollIntoView({ block:'nearest', behavior:'smooth' });
      return;
    }
    state.draft = {
      kind, studentId,
      expectedRevision:student?.revision, belt:kind === 'correct' && student?.rankKnown ? student.belt : '',
      marks:kind === 'correct' && student?.rankKnown ? student.marks : 0,
      approverName:'', reason:'', displayName:kind === 'register' ? $('studentSearch').value.trim() : '',
      distinguishingLabel:'', historyNote:'', correctsEventId:kind === 'correct' ? latestCorrectable()?.eventId : null,
      intent:null, intentSignature:''
    };
    showMessage('');
    renderEditor(true);
    $('editor').scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
  function renderEditor(fillControls) {
    const draft = state.draft;
    $('editor').hidden = !draft || (draft.kind !== 'register' && draft.studentId !== state.selected?.studentId);
    if ($('editor').hidden) {
      $('approverChoice').value = ''; closeApproverSuggestions();
      return;
    }
    const labels = { stripe:state.selected?.belt === 'Black Belt' ? 'Add one degree' : 'Add one stripe', belt:'Change belt', confirm:'Confirm current rank', correct:'Correct latest entry', register:'Add a missing student' };
    $('editorHeading').textContent = labels[draft.kind];
    $('registrationFields').hidden = draft.kind !== 'register';
    $('rankFields').hidden = !['belt', 'confirm', 'correct'].includes(draft.kind);
    $('marksField').hidden = draft.kind === 'belt';
    $('reasonField').hidden = !['confirm', 'correct'].includes(draft.kind);
    $('reasonLabel').textContent = draft.kind === 'confirm' ? 'How was this current rank verified?' : 'Reason for the correction';
    $('approvalField').hidden = false;
    $('preview').hidden = false;
    $('saveEntry').textContent = { register:'Confirm student identity', confirm:'Confirm verified rank', correct:'Confirm correction' }[draft.kind] || 'Confirm promotion';
    if (fillControls) {
      $('newName').value = draft.displayName; $('newIdentity').value = draft.distinguishingLabel;
      $('newHistoryNote').value = draft.historyNote; $('beltChoice').value = draft.belt;
      $('marksChoice').value = String(draft.marks); $('approverChoice').value = draft.approverName || '';
      closeApproverSuggestions();
      $('entryReason').value = draft.reason; formError('');
    }
    updatePreview();
    renderBusy();
  }
  function readDraftControls() {
    const draft = state.draft;
    if (!draft) return;
    formError('');
    draft.displayName = $('newName').value;
    draft.distinguishingLabel = $('newIdentity').value;
    draft.historyNote = $('newHistoryNote').value;
    draft.belt = $('beltChoice').value;
    draft.marks = $('marksChoice').value;
    draft.approverName = $('approverChoice').value;
    draft.reason = $('entryReason').value;
    updatePreview();
  }
  function intendedRank() {
    const draft = state.draft;
    if (!draft) return null;
    if (draft.kind === 'stripe') return { ...state.selected, marks:state.selected.marks + 1 };
    return { rankKnown:Boolean(draft.belt), belt:draft.belt, marks:draft.kind === 'belt' ? 0 : Number(draft.marks) };
  }
  function updatePreview() {
    const draft = state.draft;
    if (!draft) return;
    $('marksLabel').textContent = draft.belt === 'Black Belt' ? 'Degrees' : 'Stripes';
    $('beforeRank').textContent = draft.kind === 'register' ? 'New student' : rankLabel(state.selected);
    $('afterRank').textContent = draft.kind === 'register' ? 'Unknown — confirm next' : draft.kind !== 'stripe' && !draft.belt ? 'Choose a belt' : rankLabel(intendedRank());
    $('previewDate').textContent = `${todayNY()} · New York`;
    $('previewApprover').textContent = String(draft.approverName || '').trim() || 'Enter instructor’s name';
    $('previewNote').textContent = draft.kind === 'stripe'
      ? 'Adds one only. The belt does not change automatically.'
      : draft.kind === 'belt' ? 'The new belt starts with zero stripes or degrees. Earlier history is preserved.'
      : draft.kind === 'register' ? 'Creates a separate student with an unknown rank. Confirm their verified current rank next.'
      : draft.kind === 'confirm' ? 'Records the verified current rank today. This is not a new promotion and does not invent a historical date.'
      : 'A new correction entry will preserve the original event and its selected instructor.';
  }
  function buildIntent() {
    readDraftControls();
    const draft = state.draft;
    if (!draft) throw new Error('Choose an action first.');
    const approverName = draft.approverName.trim();
    if (!approverName) throw new Error('Enter the instructor’s name in Promoted by.');
    if (approverName.length > 120) throw new Error('Keep the instructor’s name to 120 characters or fewer.');
    let request;
    if (draft.kind === 'register') {
      if (!draft.displayName.trim() || !draft.distinguishingLabel.trim()) throw new Error('Enter the student name and a distinguishing label.');
      request = { operation:'registerStudent', approverName, displayName:draft.displayName.trim(), distinguishingLabel:draft.distinguishingLabel.trim(), historyNote:draft.historyNote.trim() };
    } else {
      if (!state.selectedFresh || !state.selected || state.selected.studentId !== draft.studentId) throw new Error('Select this student again before saving.');
      request = { studentId:draft.studentId, expectedRevision:draft.expectedRevision, approverName };
      if (draft.kind === 'stripe') request = { ...request, operation:'recordPromotion', action:'stripe' };
      else if (draft.kind === 'belt') {
        if (!belts.includes(draft.belt)) throw new Error('Choose the intended new belt.');
        if (draft.belt === state.selected.belt) throw new Error('Choose a different belt. Use an audited correction to fix the current rank.');
        request = { ...request, operation:'recordPromotion', action:'belt', belt:draft.belt };
      } else {
        const marks = Number(draft.marks);
        if (!belts.includes(draft.belt) || !String(draft.marks).trim() || !Number.isSafeInteger(marks) || marks < 0) throw new Error('Choose the verified belt and enter a whole number of stripes or degrees.');
        if (draft.reason.trim().length < 3) throw new Error('Explain how the rank was verified or why this correction is needed.');
        request = { ...request, operation:draft.kind === 'confirm' ? 'confirmRank' : 'correctLatest', rank:{ belt:draft.belt, marks }, reason:draft.reason.trim() };
        if (draft.kind === 'correct') request.correctsEventId = draft.correctsEventId;
      }
    }
    const signature = JSON.stringify(request);
    if (draft.intent && draft.intentSignature === signature) return draft.intent;
    draft.intent = Object.freeze({ ...request, requestId:newRequestId() });
    draft.intentSignature = signature;
    return draft.intent;
  }
  function renderBusy() {
    const locked = Boolean(state.pending) || lifecycle.snapshot().phase === 'success';
    if (locked || state.loadingStudent) closeApproverSuggestions();
    $('studentSearch').disabled = lifecycle.snapshot().phase === 'success';
    for (const id of ['addStripe', 'changeBelt', 'confirmRank', 'correctLatest', 'addStudent']) $(id).disabled = locked || state.loadingStudent;
    $('refreshStudent').disabled = state.loadingStudent || locked;
    $('closeEditor').disabled = locked;
    for (const control of $('entryForm').querySelectorAll('input,select,textarea,button')) control.disabled = locked || state.loadingStudent;
    $('pendingPanel').hidden = !state.pending;
    if (state.pending) {
      $('pendingHeading').textContent = state.pending.busy ? 'Saving…' : 'Save not confirmed';
      $('pendingText').textContent = state.pending.message || 'Keep this entry until its save is confirmed. You can view another student without changing the pending entry.';
      $('checkSave').disabled = state.pending.busy;
      $('retrySave').disabled = state.pending.busy;
    }
  }
  async function submitEntry(event) {
    event.preventDefault();
    if (state.pending || state.loadingStudent || !state.authenticated || lifecycle.snapshot().phase === 'success') return;
    let intent;
    try { intent = buildIntent(); } catch (error) { formError(error.message); return; }
    formError('');
    try { lifecycle.begin(intent); } catch (error) { formError(error.message || 'This tablet could not safely keep the request. Nothing was sent.'); return; }
    state.pending = {
      intent:JSON.parse(JSON.stringify(intent)), selectedGeneration:state.selectedGeneration,
      searchGeneration:state.searchGeneration, submittedDraft:state.draft,
      studentId:state.draft.studentId, displayName:state.draft.kind === 'register' ? state.draft.displayName.trim() : state.selected.displayName,
      identityLabel:state.draft.kind === 'register' ? state.draft.distinguishingLabel.trim() : state.selected.distinguishingLabel,
      busy:true, message:'Saving this entry. Wait for a confirmed result.'
    };
    renderBusy();
    await sendPending(false);
  }
  async function sendPending(checkOnly) {
    const pending = state.pending;
    if (!pending) return;
    const viewToken = lifecycle.token();
    pending.busy = true;
    pending.message = checkOnly ? 'Checking whether this exact entry was saved.' : 'Saving this entry. Wait for a confirmed result.';
    renderBusy();
    try {
      const data = await rpc(checkOnly ? { operation:'checkSave', requestId:pending.intent.requestId } : pending.intent);
      if (state.pending !== pending) return;
      if (checkOnly && data.status === 'not_found') {
        if (!lifecycle.isCurrent(viewToken)) { pending.busy = false; return; }
        pending.busy = false;
        pending.message = 'No confirmed save was found. Retry this same entry; its details have been kept.';
        renderBusy();
        return;
      }
      if (!data.receipt || !data.student || data.receipt.requestId !== pending.intent.requestId || data.receipt.studentId !== data.student.studentId) {
        throw { code:'UNAVAILABLE', message:'The response did not verify this exact entry.', retryable:true };
      }
      const sameInteraction = pending.selectedGeneration === state.selectedGeneration
        && pending.searchGeneration === state.searchGeneration;
      const recoveringWithoutLookup = pending.restored && !state.selected && !$('studentSearch').value;
      const canAcknowledge = lifecycle.isCurrent(viewToken) && (sameInteraction || recoveringWithoutLookup);
      lifecycle.reconcile(pending.intent.requestId, { token:canAcknowledge ? viewToken : -1 });
      state.pending = null;
      if (!lifecycle.isCurrent(viewToken)) { if (lifecycle.snapshot().active) renderBusy(); return; }
      if (!canAcknowledge) {
        const key = pending.studentId || '__register';
        if (state.drafts.get(key) === pending.submittedDraft) state.drafts.delete(key);
        if (state.draft === pending.submittedDraft) state.draft = null;
        renderEditor(false); renderBusy();
        return;
      }
      const cachedStudent = state.students.get(data.student.studentId);
      const currentStudent = cachedStudent && cachedStudent.revision > data.student.revision ? cachedStudent : data.student;
      state.students.set(currentStudent.studentId, currentStudent);
      const draftKey = pending.studentId || '__register';
      if (state.drafts.get(draftKey) === pending.submittedDraft) state.drafts.delete(draftKey);
      // Reselecting A while A's save is pending restores this same draft object.
      // Retire that exact submitted draft even if a newer read has changed its revision.
      // An unrelated student's draft and a newly typed search remain untouched.
      if (state.draft === pending.submittedDraft) state.draft = null;
      const sameStudent = state.selected?.studentId === currentStudent.studentId;
      const showRegisteredStudent = pending.intent.operation === 'registerStudent'
        && pending.selectedGeneration === state.selectedGeneration
        && pending.searchGeneration === state.searchGeneration;
      if (sameStudent || showRegisteredStudent) {
        // A read begun before this commit must not replay an older rank/history.
        state.readGeneration += 1;
        state.loadingStudent = false;
        state.selectedFresh = true;
        state.selected = currentStudent;
        state.history = [data.receipt, ...state.history.filter(event => event.studentId === currentStudent.studentId && event.eventId !== data.receipt.eventId)];
        if (showRegisteredStudent) {
          $('studentSearch').value = currentStudent.displayName;
          closeSearch();
        }
        renderStudent();
      }
      renderEditor(false);
      const personLabel = `${data.receipt.after.displayName} (${data.receipt.after.distinguishingLabel})`;
      const label = data.receipt.eventKind === 'REGISTER' ? `Registered ${personLabel}. Confirm their verified current rank next.`
        : `Saved: ${personLabel} · ${rankLabel(data.receipt.after)} · ${data.receipt.eventDateNY}.`;
      showMessage(data.viewPending ? `${label} The history is saved; the spreadsheet view is still updating.` : label, 'success');
      renderBusy();
    } catch (error) {
      if (state.pending !== pending) return;
      pending.busy = false;
      if (!lifecycle.isCurrent(viewToken)) { if (lifecycle.snapshot().active) renderBusy(); return; }
      if (error?.code === 'UNAUTHORIZED') { pending.busy = false; accessFailure(error); return; }
      const definitelyRejected = ['VALIDATION','NOT_FOUND','ARCHIVED','RANK_UNKNOWN','RANK_ALREADY_KNOWN','STALE_REVISION','DUPLICATE_STUDENT','CORRECTION_NOT_LATEST'].includes(error?.code) && error.retryable !== true;
      if (definitelyRejected) {
        try {
          lifecycle.settleRejected(pending.intent.requestId);
          state.pending = null;
          if (pending.selectedGeneration === state.selectedGeneration) {
            formError(error.message || 'Review this entry and try again.');
            showMessage(error.message || 'This entry was rejected. Your input is unchanged.', 'error');
          }
        } catch (_) {
          pending.message = 'The rejected request could not be cleared safely on this tablet. Its original details are kept; Sign-In remains available.';
        }
        renderBusy();
        return;
      }
      pending.message = `${error?.message || 'The connection was interrupted.'} This entry is not confirmed. Check save or retry the same entry; its details are kept on this tablet.`;
      renderBusy();
    }
  }

  $('retryAccess').addEventListener('click', bootstrap);
  $('studentSearch').addEventListener('input', () => {
    state.searchGeneration += 1;
    if (lifecycle.snapshot().phase !== 'success') renderSearch();
  });
  $('studentSearch').addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeSearch(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || $('searchResults').hidden || !state.searchResults.length) return;
    event.preventDefault();
    if (event.key === 'Enter') {
      if (state.activeResult >= 0) selectStudent(state.searchResults[state.activeResult].studentId);
      else if (state.searchResults.length === 1) selectStudent(state.searchResults[0].studentId);
      return;
    }
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    state.activeResult = (state.activeResult + delta + state.searchResults.length) % state.searchResults.length;
    for (const [index, element] of [...$('searchResults').children].entries()) element.setAttribute('aria-selected', String(index === state.activeResult));
    const active = $('searchResults').children[state.activeResult];
    $('studentSearch').setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block:'nearest' });
  });
  $('addStudent').addEventListener('click', () => openDraft('register'));
  $('addStripe').addEventListener('click', () => openDraft('stripe'));
  $('changeBelt').addEventListener('click', () => openDraft('belt'));
  $('confirmRank').addEventListener('click', () => openDraft('confirm'));
  $('correctLatest').addEventListener('click', () => openDraft('correct'));
  $('refreshStudent').addEventListener('click', refreshSelected);
  $('closeEditor').addEventListener('click', () => {
    if (state.pending) return;
    if (state.draft) state.drafts.set(state.draft.studentId || '__register', state.draft);
    state.draft = null; renderEditor(false);
  });
  $('entryForm').addEventListener('input', readDraftControls);
  $('entryForm').addEventListener('change', readDraftControls);
  $('approverChoice').addEventListener('input', renderApproverSuggestions);
  $('approverChoice').addEventListener('blur', closeApproverSuggestions);
  $('approverChoice').addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeApproverSuggestions(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (state.activeApproverResult >= 0) selectApproverSuggestion(state.approverResults[state.activeApproverResult]);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || $('approverSuggestions').hidden || !state.approverResults.length) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    state.activeApproverResult = state.activeApproverResult < 0
      ? (delta > 0 ? 0 : state.approverResults.length - 1)
      : (state.activeApproverResult + delta + state.approverResults.length) % state.approverResults.length;
    for (const [index, option] of [...$('approverSuggestions').children].entries()) option.setAttribute('aria-selected', String(index === state.activeApproverResult));
    const active = $('approverSuggestions').children[state.activeApproverResult];
    $('approverChoice').setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block:'nearest' });
  });
  $('entryForm').addEventListener('submit', submitEntry);
  $('checkSave').addEventListener('click', () => { if (state.pending && !state.pending.busy) sendPending(true); });
  $('retrySave').addEventListener('click', () => { if (state.pending && !state.pending.busy) sendPending(false); });
  function navigationBlocked() {
    const instructorGuard = globalThis.M1_KIOSK_NAVIGATION;
    if (!instructorGuard || !instructorGuard.canLeaveSignIn()) return true;
    const staff = document.getElementById('staffClockName');
    const confirmation = document.getElementById('staffClockConfirmation');
    return Boolean(profile.featureFlags?.staffClock && (staff?.value || confirmation && !confirmation.hidden));
  }
  function updateNavigation() {
    const active = lifecycle.snapshot().active;
    document.getElementById('openPromotionsLog').disabled = !active && navigationBlocked();
    document.getElementById('openPromotionsLog').setAttribute('aria-expanded', String(active));
  }
  function clearPresentation() {
    state.selectedGeneration += 1;
    state.readGeneration += 1;
    state.searchGeneration += 1;
    state.students.clear(); state.history = []; state.selected = null; state.selectedFresh = false;
    state.approvers = []; state.recorderLabel = ''; state.todayNY = ''; state.authenticated = false;
    state.draft = null; state.drafts.clear(); state.loadingStudent = false; state.searchResults = [];
    for (const control of host.querySelectorAll('input,textarea,select')) control.value = '';
    for (const id of ['searchResults','historyList','studentName','studentIdentity','studentRank','studentDate','legacyNotes','message','beforeRank','afterRank','previewDate','previewApprover','formError','recorder']) $(id).textContent = '';
    closeApproverSuggestions();
    for (const id of ['app','studentCard','editor','historyCard','searchResults','message','pendingPanel','legacyDetails','recorder']) $(id).hidden = true;
    $('historyDisclosure').open = false; $('legacyDetails').open = false;
    $('studentSearch').removeAttribute('aria-activedescendant'); $('studentSearch').setAttribute('aria-expanded','false');
    if (state.pending) {
      state.pending.displayName = ''; state.pending.identityLabel = ''; state.pending.submittedDraft = null;
      state.pending.message = 'An earlier entry still needs confirmation. Its exact request is kept on this tablet.';
    }
    $('pendingText').textContent = ''; $('pendingHeading').textContent = 'Save not confirmed';
    $('accessStatus').textContent = 'Checking this tabletâ€¦';
    host.hidden = true;
    document.body.classList.remove('promotions-view');
    updateNavigation();
  }
  async function open() {
    const token = lifecycle.open({ blocked:navigationBlocked() });
    if (token === null) return false;
    const intent = lifecycle.pending();
    if (intent && state.pending?.intent.requestId !== intent.requestId) state.pending = {
      intent, studentId:intent.studentId || null, displayName:'', identityLabel:'', submittedDraft:null,
      selectedGeneration:-1, searchGeneration:-1, restored:true, busy:false,
      message:'An earlier entry still needs confirmation. Check its save or retry its exact original details.'
    };
    if (!intent) state.pending = null;
    host.hidden = false;
    document.body.classList.add('promotions-view');
    updateNavigation();
    await bootstrap();
    if (lifecycle.isCurrent(token) && state.authenticated) $('studentSearch').focus();
    return true;
  }
  function leave() { lifecycle.leave('back'); }
  $('clearBack').addEventListener('click', leave);
  document.getElementById('openPromotionsLog').addEventListener('click', () => { if (!lifecycle.snapshot().active) void open(); });
  for (const type of ['input','keydown','pointerdown','change']) host.addEventListener(type, () => lifecycle.touch(), { passive:true });
  document.addEventListener('input', updateNavigation);
  document.addEventListener('change', updateNavigation);
  const timer = windowTarget.setInterval(() => { lifecycle.check(); updateNavigation(); }, 250);
  for (const type of ['pagehide','popstate']) windowTarget.addEventListener(type, leave);
  for (const type of ['pageshow','focus']) windowTarget.addEventListener(type, () => { lifecycle.check(); updateNavigation(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lifecycle.check(); });
  document.addEventListener('resume', () => lifecycle.check());
  navigation.hidden = false;
  updateNavigation();
  return { open, leave, lifecycle, snapshot:() => ({ active:lifecycle.snapshot().active, pending:Boolean(state.pending), selectedId:state.selected?.studentId || null, selectedFresh:state.selectedFresh }), destroy:() => { windowTarget.clearInterval(timer); leave(); } };
}

if (globalThis.document && globalThis.window) {
  try { mountPromotionsLog(); } catch (_) { /* Optional log failure must not interrupt Instructor Sign-In or Staff Clock. */ }
}
