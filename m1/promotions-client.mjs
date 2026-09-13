import { promotionsTemplate } from './promotions-template.mjs?v=2026-09-13-promotions-test-a';
import { promotionsEnabled, createPromotionsLifecycle } from './promotions-core.mjs?v=2026-09-13-promotions-test-a';

export function createPromotionsTransport(fetcher, { timeoutMs = 30000, online = () => globalThis.navigator?.onLine !== false } = {}) {
  return payload => new Promise((resolve, reject) => {
    if (!online()) { reject({ code:'UNAVAILABLE', message:'Connect to load a fresh record or send this entry.', retryable:true }); return; }
    const abort = new AbortController();
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { finish(reject, { code:'UNAVAILABLE', message:'No confirmation arrived. Keep this entry and check or retry it.', retryable:true }); abort.abort(); }, timeoutMs);
    Promise.resolve().then(() => fetcher('/api/m1-promotions', {
      method:'POST', credentials:'same-origin', cache:'no-store', signal:abort.signal,
      headers:{ 'Content-Type':'application/json', Accept:'application/json' }, body:JSON.stringify(payload)
    })).then(async response => {
      const body = await response.json();
      if (response.ok && body?.ok === true && body.data && typeof body.data === 'object') finish(resolve, body.data);
      else finish(reject, body?.error || { code:response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'UNAVAILABLE', message:'The TEST log could not confirm this request.', retryable:response.status >= 500 });
    }).catch(() => finish(reject, { code:'UNAVAILABLE', message:'The connection was interrupted. This entry is not confirmed.', retryable:true }));
  });
}


export function mountPromotionsLog({ document = globalThis.document, profile = globalThis.M1_INSTALLATION_PROFILE, config = globalThis.M1_PROMOTIONS_TEST_CONFIG, fetcher = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage, now = Date.now, windowTarget = globalThis.window } = {}) {
  if (!promotionsEnabled(profile, config)) return null;
  const host = document.getElementById('promotionsPanel');
  const navigation = document.getElementById('promotionsNavigation');
  if (!host || !navigation) return null;
  host.innerHTML = promotionsTemplate;
  const $ = id => host.querySelector(`[data-promo-id="${id}"]`);
  const transport = createPromotionsTransport(fetcher);
  const lifecycle = createPromotionsLifecycle({ now, storage, onClear: clearPresentation });
  const state = {
    students: new Map(), approvers: [], recorderLabel: '', todayNY: '', selected: null,
    history: [], selectedGeneration: 0, readGeneration: 0, searchGeneration: 0, searchResults: [], activeResult: -1,
    draft: null, drafts: new Map(), pending: null, authenticated: false, loadingStudent: false, selectedFresh: false
  };
  const belts = ['White Belt', 'Blue Belt', 'Purple Belt', 'Brown Belt', 'Black Belt'];
  const mutationErrors = new Set(['VALIDATION', 'NOT_FOUND', 'ARCHIVED', 'RANK_UNKNOWN', 'RANK_ALREADY_KNOWN', 'STALE_REVISION', 'REQUEST_CONFLICT', 'DUPLICATE_STUDENT', 'CORRECTION_NOT_LATEST', 'TEST_DESTINATION_INVALID']);
  const eventLabels = { REGISTER:'Student registered', RANK_CONFIRM:'Current rank confirmed', STRIPE:'Stripe or degree added', BELT:'Belt changed', CORRECTION:'Audited correction' };

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
  function normalize(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase().trim(); }
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
      ? 'This tablet is not authorized for the TEST log. Sign-In is still available.'
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
      if (data.testOnly !== true || !Array.isArray(data.students) || !Array.isArray(data.approvers)) {
        throw { code:'TEST_DESTINATION_INVALID', message:'The TEST destination could not be verified.' };
      }
      state.students = new Map(data.students.map(student => [student.studentId, student]));
      state.approvers = data.approvers;
      state.recorderLabel = String(data.recorderLabel || 'Authorized TEST tablet');
      state.todayNY = data.todayNY;
      state.authenticated = true;
      $('approverChoice').replaceChildren(node('option', 'Choose an instructor'));
      $('approverChoice').firstElementChild.value = '';
      for (const approver of state.approvers) {
        const option = node('option', approver.label); option.value = approver.id; $('approverChoice').append(option);
      }
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
      option.append(node('strong', student.displayName), node('span', `${student.distinguishingLabel}${student.status === 'archived' ? ' · Archived' : ''}`));
      option.addEventListener('click', () => selectStudent(student.studentId));
      $('searchResults').append(option);
    }
    const open = state.searchResults.length > 0;
    $('searchResults').hidden = !open;
    $('studentSearch').setAttribute('aria-expanded', String(open));
    $('studentSearch').removeAttribute('aria-activedescendant');
    $('searchHint').textContent = !query
      ? 'Use the identifying label to distinguish students with the same name.'
      : matches.length === 0 ? 'No matching student. Add a separate student if they are missing.'
      : matches.length > 8 ? `Showing 8 of ${matches.length} matches. Type more to narrow the list.`
      : 'Choose the correct identifying label. Matching names are separate students.';
  }
  function closeSearch() {
    $('searchResults').hidden = true;
    $('studentSearch').setAttribute('aria-expanded', 'false');
    $('studentSearch').removeAttribute('aria-activedescendant');
    state.activeResult = -1;
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
    $('studentIdentity').textContent = student.distinguishingLabel;
    $('studentRank').textContent = state.selectedFresh ? rankLabel(student) : 'Current rank not yet verified';
    const latestPromotion = [...state.history].sort((a,b) => b.revision - a.revision).find(event => ['STRIPE','BELT'].includes(event.eventKind) && event.eventDateNY);
    $('studentDate').textContent = state.selectedFresh ? `Latest promotion: ${student.lastPromotionDateNY || latestPromotion?.eventDateNY || 'Date not recorded'}` : 'Connect and refresh to verify this record.';
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
    return [...state.history].sort((left, right) => right.revision - left.revision).find(event => event.eventKind !== 'REGISTER') || null;
  }
  function renderHistory() {
    $('historyList').replaceChildren();
    const history = [...state.history].sort((left, right) => right.revision - left.revision);
    $('historyEmpty').hidden = history.length > 0;
    for (const event of history) {
      const article = node('article', undefined, 'history-item');
      article.append(node('h3', `${event.eventDateNY || 'Date not recorded'} · ${eventLabels[event.eventKind] || 'Recorded event'}`));
      article.append(node('p', `${event.before ? rankLabel(event.before) : 'New identity'} → ${rankLabel(event.after)}`));
      const recordedThrough = /^m1-test-device-[a-f0-9]{24}$/u.test(event.recorderIdentity || '')
        ? 'Authorized TEST tablet' : 'Earlier log';
      article.append(node('p', `Promoted by: ${event.approverLabel || 'Not recorded'} · Recorded through: ${recordedThrough}`, 'history-meta'));
      if (event.reason) article.append(node('p', event.reason, 'small'));
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
      renderEditor(true);
      $('editor').scrollIntoView({ block:'nearest', behavior:'smooth' });
      return;
    }
    state.draft = {
      kind, studentId,
      expectedRevision:student?.revision, belt:kind === 'correct' && student?.rankKnown ? student.belt : '',
      marks:kind === 'correct' && student?.rankKnown ? student.marks : 0,
      approverId:'', reason:'', displayName:kind === 'register' ? $('studentSearch').value.trim() : '',
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
    if ($('editor').hidden) return;
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
      $('marksChoice').value = String(draft.marks); $('approverChoice').value = draft.approverId;
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
    draft.approverId = $('approverChoice').value;
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
    $('previewApprover').textContent = state.approvers.find(approver => approver.id === draft.approverId)?.label || 'Choose an instructor';
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
    if (!state.approvers.some(approver => approver.id === draft.approverId)) throw new Error('Choose the instructor recording this entry.');
    let request;
    if (draft.kind === 'register') {
      if (!draft.displayName.trim() || !draft.distinguishingLabel.trim()) throw new Error('Enter the student name and a distinguishing label.');
      request = { operation:'registerStudent', approverId:draft.approverId, displayName:draft.displayName.trim(), distinguishingLabel:draft.distinguishingLabel.trim(), historyNote:draft.historyNote.trim() };
    } else {
      if (!state.selectedFresh || !state.selected || state.selected.studentId !== draft.studentId) throw new Error('Select this student again before saving.');
      if (!state.approvers.some(approver => approver.id === draft.approverId)) throw new Error('Choose the instructor who awarded this promotion.');
      request = { studentId:draft.studentId, expectedRevision:draft.expectedRevision, approverId:draft.approverId };
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
    $('approverChoice').replaceChildren();
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
