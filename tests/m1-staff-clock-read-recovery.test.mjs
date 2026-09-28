import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8').replace(/\r\n?/gu, '\n');
const PUNCH = 'gib-m1-staff-11111111-1111-4111-8111-111111111111';
const REQUEST = 'gib-m1-staff-request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source markers: ${start}, ${end}`);
  return html.slice(from, to);
}

function actualFunction(name) {
  const match = new RegExp(`^      (?:async )?function ${name}\\(`, 'mu').exec(html);
  assert.ok(match, `Missing actual function ${name}`);
  const tail = html.slice(match.index + match[0].length);
  const next = /^      (?:async )?function /mu.exec(tail);
  assert.ok(next, `Missing function after ${name}`);
  return html.slice(match.index, match.index + match[0].length + next.index);
}

function initial(token = A) {
  const person = { staffId: 'mandy-test', staffName: 'Mandy Test' };
  return {
    ok: true, test: true, adminName: 'Andrew Smith', staff: [person], shiftStaff: [person],
    clockedInNow: [{ ...person, punchId: PUNCH, clockInAt: '2026-08-18T17:27:00-04:00' }],
    periods: {
      current: { startDate: '2026-08-10', endDate: '2026-08-23', totals: [] },
      previous: { startDate: '2026-07-27', endDate: '2026-08-09', totals: [] }
    },
    view: {
      token, today: '2026-08-18', recordCount: 1, recordTotal: 1,
      todayPunchCount: 1, todayPunchTotal: 1, adjustmentCount: 0, adjustmentTotal: 0,
      attentionCount: 1, attentionOccurrenceCount: 1, auditCount: 0, auditTotal: 0,
      recordsTruncated: false, auditTruncated: false
    }
  };
}

function attention(token) {
  return {
    ok: true, test: true, adminName: 'Andrew Smith', viewToken: token,
    stream: 'attention', offset: 0, nextOffset: null,
    items: [{ staffId: 'mandy-test', staffName: 'Mandy Test', code: 'missing_clock_out',
      message: 'Mandy Test is still clocked in.', occurrenceCount: 1, linkedPunchIds: [PUNCH] }]
  };
}

function recent(token) {
  return {
    ok: true, test: true, adminName: 'Andrew Smith', viewToken: token, mode: 'recent',
    dateFrom: '2026-08-12', dateThrough: '2026-08-18', staffId: '', date: '',
    total: 0, items: [], truncated: false
  };
}

function stale() {
  return Object.assign(new Error('Expired snapshot'), {
    status: 409, data: { ok: false, result: 'stale', code: 'STAFF_TIME_VIEW_STALE' }
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The actual main read intentionally returns before its progressive recent read.
// Drain already-settled promises without inventing a second orchestration loop.
const flush = () => new Promise(resolve => setImmediate(resolve));

function element(tagName = 'div') {
  const classes = new Set();
  let ownText = '';
  return {
    tagName, children: [], dataset: {}, attributes: {}, style: {}, value: '', max: '',
    hidden: false, disabled: false, open: false,
    classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); } },
    get textContent() { return ownText + this.children.map(child => child.textContent).join(' '); },
    set textContent(value) { ownText = String(value); this.children = []; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    replaceChildren(...children) { ownText = ''; this.children = children; if (tagName === 'select') this.value = children[0]?.value || ''; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    focus() {}
  };
}

function matches(node, selector) {
  const className = /^\.([a-z-]+)/u.exec(selector)?.[1];
  if (className && !(node.className || '').split(/\s+/u).includes(className)) return false;
  for (const match of selector.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/gu)) {
    const [, name, value] = match;
    const key = name.startsWith('data-') ? name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase()) : null;
    const actual = name === 'open' ? (node.open ? '' : undefined)
      : key ? node.dataset[key] : node.attributes[name];
    if (actual === undefined || (value !== undefined && actual !== value)) return false;
  }
  return true;
}

// Only the DOM, timers and transport are substitutes. The orchestration, strict
// validators, section rendering, defaults and logout are extracted unchanged.
function runtime(respond = () => undefined) {
  const nodes = new Map();
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  let reviewCount = 0;
  function $(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element(/(?:Name|Staff)$/u.test(selector) ? 'select' : 'div'));
    return nodes.get(selector);
  }
  function querySelector(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    function search(node) {
      if (selectors.some(value => matches(node, value))) return node;
      for (const child of node.children) { const found = search(child); if (found) return found; }
      return null;
    }
    for (const node of nodes.values()) { const found = search(node); if (found) return found; }
    return null;
  }
  const storage = { getItem() { throw new Error('Unexpected storage read'); },
    setItem() { throw new Error('Read recovery must not replace persisted saves'); },
    removeItem() { throw new Error('Read recovery must not remove persisted saves'); },
    clear() { throw new Error('Read recovery must not clear storage'); } };
  const context = vm.createContext({ $, Date, Intl, TextEncoder, console,
    document: { createElement: element, querySelector }, localStorage: storage, sessionStorage: storage,
    window: { setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
      clearTimeout(id) { timers.delete(id); } },
    async requestJson(url, request, options) {
      assert.equal(url, '/staff-time');
      assert.ok(['review', 'reviewPage', 'shiftLookup'].includes(request.operation), 'No mutation may be sent during read recovery');
      assert.equal(options.timeoutMs, 25_000, 'Recovery must not increase the read deadline');
      calls.push(structuredClone(request));
      if (request.operation === 'review') reviewCount += 1;
      const result = await respond(request, reviewCount, calls);
      if (result !== undefined) return result;
      if (request.operation === 'review') return initial(reviewCount === 1 ? A : B);
      if (request.operation === 'reviewPage') return attention(request.viewToken);
      return recent(request.viewToken);
    }
  });
  const functions = [
    'clean', 'isObject', 'exactObjectKeys', 'validReviewDate', 'shiftDate', 'showMessage',
    'makeElement', 'staffActionLabel', 'staffTimestampLabel', 'staffEmpty', 'staffBadge', 'staffTimeRow',
    'staffPeriodElement', 'populateStaffCorrectionNames', 'clearStaffPrimarySlowNotice',
    'clearStaffAttentionSlowNotice', 'clearStaffRecentSlowNotice', 'startStaffPrimarySlowNotice',
    'startStaffAttentionSlowNotice', 'startStaffRecentSlowNotice', 'beginStaffShiftLookupLoading',
    'renderStaffAttentionState', 'renderStaffClockedInState', 'renderStaffRecentShifts',
    'renderStaffOlderShiftLookup', 'renderStaffTimePrimary', 'primaryValidatedStaffAttentionAction',
    'renderStaffTimeAdvancedState', 'setStaffCorrectionDefaults', 'clearStaffCorrectionIdentity',
    'loadStaffAttention', 'loadStaffTime', 'retryStaffTime', 'retryStaffAttention',
    'loadStaffRecentShifts', 'retryStaffRecentShifts', 'setLoggedOut'
  ];
  new vm.Script(`
    const SITE = 'Rev'; const TIME_ZONE = 'America/New_York'; const API = { staffTime: '/staff-time' };
    ${between('const STAFF_PUNCH_ID_PATTERN =', 'const MIN_CLASSES_BY_DAY =')}
    ${between('let reviewLoaded =', 'let diagnosticWindow =')}
    currentAdminName = 'Andrew Smith'; testMode = true; adminRequestToken = 'retained-session';
    function clearDiagnosticRun() {}
    function clearTabletPairingReview() {}
    function staffCompletedShiftElement() { throw new Error('Unexpected completed-shift fixture'); }
    function loadStaffTimeAdvanced() { throw new Error('Advanced records are outside these primary-read tests'); }
    ${between('function validStaffId(', 'function validDiagnosticIssueResponse(')}
    ${functions.map(actualFunction).join('\n')}
    globalThis.hooks = {
      loadStaffTime, retryStaffTime, retryStaffAttention, retryStaffRecentShifts, setLoggedOut,
      state: () => ({ current: currentStaffTime, attention: currentStaffAttention,
        recent: currentStaffRecentLookup, primaryError: staffPrimaryLoadError,
        attentionError: staffAttentionLoadError, recentError: staffRecentLoadError,
        generation: staffTimeLoadGeneration, admin: currentAdminName,
        attentionNeedsRefresh: staffAttentionNeedsRefresh, recentNeedsRefresh: staffRecentNeedsRefresh,
        primaryLoading: staffPrimaryLoading, attentionLoading: staffAttentionLoading,
        recentLoading: staffRecentLoading })
    };
  `, { filename: 'actual-staff-clock-read-functions.js' }).runInContext(context);
  return { ...context.hooks, $, calls, timers };
}

function assertLoaded(app, token = B) {
  const state = app.state();
  assert.equal(state.current?.view.token, token);
  assert.equal(state.attention.length, 1);
  assert.equal(state.recent?.viewToken, token);
  assert.equal(state.attentionError, '');
  assert.equal(state.recentError, '');
  assert.equal(app.$('#staffNeedsAttentionRetry').hidden, true);
  assert.equal(app.$('#staffRecentShiftsRetry').hidden, true);
  assert.match(app.$('#staffTimeSummary').textContent, /1 need attention/u);
  assert.equal(app.timers.size, 0);
}

for (const section of ['attention', 'recent']) {
  test(`${section}: one Retry after a timeout requests a fresh summary before its pages`, async () => {
    const app = runtime((request, reviewNumber) => {
      if (reviewNumber === 1 && ((section === 'attention' && request.operation === 'reviewPage')
        || (section === 'recent' && request.operation === 'shiftLookup'))) {
        throw new Error('Staff Time took too long to load. Retry below.');
      }
    });
    await app.loadStaffTime();
    await flush();
    assert.match(app.state()[`${section}Error`], /took too long/u);
    assert.equal(app.state()[`${section}NeedsRefresh`], false, 'Timeout is not fabricated stale evidence');
    const beforeRetry = app.calls.length;
    await app[section === 'attention' ? 'retryStaffAttention' : 'retryStaffRecentShifts']();
    await flush();
    assert.equal(app.calls[beforeRetry].operation, 'review');
    assert.equal(app.calls.filter(call => call.operation === 'review').length, 2);
    assertLoaded(app);
  });

  test(`${section}: a strict stale response restarts the entire main read once automatically`, async () => {
    const app = runtime((request, reviewNumber) => {
      if (reviewNumber === 1 && ((section === 'attention' && request.operation === 'reviewPage')
        || (section === 'recent' && request.operation === 'shiftLookup'))) throw stale();
    });
    await app.loadStaffTime();
    await flush();
    assert.equal(app.calls.filter(call => call.operation === 'review').length, 2);
    const lastReview = app.calls.findLastIndex(call => call.operation === 'review');
    assert.deepEqual(app.calls.slice(lastReview).map(call => call.operation), ['review', 'reviewPage', 'shiftLookup']);
    assertLoaded(app);
  });
}

test('the single stale-restart budget is shared across attention and recent; repeated stale remains visible', async () => {
  const app = runtime((request, number) => {
    if ((number === 1 && request.operation === 'reviewPage')
      || (number === 2 && request.operation === 'shiftLookup')) throw stale();
  });
  await app.loadStaffTime();
  await flush();
  assert.equal(app.calls.filter(call => call.operation === 'review').length, 2);
  assert.equal(app.state().recent, null);
  assert.match(app.state().recentError, /expired or changed/u);
  assert.equal(app.$('#staffRecentShiftsRetry').hidden, false);
  assert.doesNotMatch(app.$('#staffRecentShifts').textContent, /No completed shifts/u);
  assert.equal(app.timers.size, 0);
});

test('repeated attention stale does not loop or present an empty attention list as all clear', async () => {
  const app = runtime(request => { if (request.operation === 'reviewPage') throw stale(); });
  await app.loadStaffTime();
  await flush();
  assert.equal(app.calls.filter(call => call.operation === 'review').length, 2);
  assert.equal(app.calls.filter(call => call.operation === 'shiftLookup').length, 0);
  assert.match(app.state().attentionError, /expired or changed/u);
  assert.match(app.$('#staffTimeSummary').textContent, /unavailable/u);
  assert.doesNotMatch(app.$('#staffNeedsAttention').textContent, /No Staff Clock issues/u);
  assert.equal(app.$('#staffNeedsAttentionRetry').hidden, false);
  assert.equal(app.$('#staffRecentShiftsRetry').hidden, false);
});

test('only a validated stale response permits automatic restart', async () => {
  const app = runtime(request => {
    if (request.operation === 'reviewPage') {
      const error = stale();
      error.data.unexpected = true;
      throw error;
    }
  });
  await app.loadStaffTime();
  await flush();
  assert.equal(app.calls.filter(call => call.operation === 'review').length, 1);
  assert.equal(app.state().attentionNeedsRefresh, false);
  assert.match(app.state().attentionError, /could not be loaded/u);
});

for (const section of ['summary', 'attention', 'recent']) {
  test(`${section}: an incomplete response stays unavailable until a fresh successful Retry`, async () => {
    const app = runtime((request, number) => {
      if (number !== 1) return undefined;
      if (section === 'summary' && request.operation === 'review') {
        const value = initial(); delete value.periods; return value;
      }
      if (section === 'attention' && request.operation === 'reviewPage') return { ...attention(A), items: [] };
      if (section === 'recent' && request.operation === 'shiftLookup') return { ...recent(A), total: 1 };
    });
    await app.loadStaffTime();
    await flush();
    assert.equal(app.calls.filter(call => call.operation === 'review').length, 1);
    if (section === 'summary') {
      assert.equal(app.state().current, null);
      assert.equal(app.$('#staffCorrectionOpen').disabled, true);
      assert.match(app.$('#staffTimeSummary').textContent, /unavailable/u);
    } else {
      assert.match(app.state()[`${section}Error`], /incomplete/u);
      assert.doesNotMatch(app.$(section === 'attention' ? '#staffNeedsAttention' : '#staffRecentShifts').textContent,
        /No Staff Clock issues|No completed shifts/u);
    }
    await app[section === 'recent' ? 'retryStaffRecentShifts' : 'retryStaffAttention']();
    await flush();
    assertLoaded(app);
  });
}

for (const failure of [false, true]) {
  test(`an older ${failure ? 'failed' : 'successful'} attention read cannot overwrite a newer generation`, async () => {
    const pending = deferred();
    const entered = deferred();
    const app = runtime((request, number) => {
      if (number === 1 && request.operation === 'reviewPage') { entered.resolve(); return pending.promise; }
    });
    const older = app.loadStaffTime();
    await entered.promise;
    await app.loadStaffTime();
    await flush();
    assertLoaded(app);
    if (failure) pending.reject(stale()); else pending.resolve(attention(A));
    assert.equal(await older, false);
    await flush();
    assertLoaded(app);
    assert.equal(app.calls.filter(call => call.operation === 'review').length, 2);
  });
}

test('actual logout invalidates an in-flight read and cannot be undone by its late completion', async () => {
  const pending = deferred();
  const entered = deferred();
  const app = runtime(request => {
    if (request.operation === 'shiftLookup') { entered.resolve(); return pending.promise; }
  });
  const loading = app.loadStaffTime();
  await entered.promise;
  app.setLoggedOut('Admin login required.');
  pending.resolve(recent(A));
  await loading;
  await flush();
  assert.equal(app.state().current, null);
  assert.equal(app.state().recent, null);
  assert.equal(app.state().admin, '');
  assert.equal(app.$('#appPanel').hidden, true);
  assert.match(app.$('#staffRecentShifts').textContent, /Sign in/u);
  assert.equal(app.calls.filter(call => call.operation === 'review').length, 1);
  assert.equal(app.timers.size, 0);
});

test('section Retry is ignored while the current progressive load is still in flight', async () => {
  const pending = deferred();
  const entered = deferred();
  const app = runtime(request => {
    if (request.operation === 'shiftLookup') { entered.resolve(); return pending.promise; }
  });
  const loading = app.loadStaffTime();
  await entered.promise;
  await Promise.all([app.retryStaffAttention(), app.retryStaffRecentShifts()]);
  assert.equal(app.calls.filter(call => call.operation === 'review').length, 1);
  pending.resolve(recent(A));
  await loading;
  await flush();
  assertLoaded(app, A);
});

test('automatic restart and quiet Retry preserve the unsent correction and original pending identity', async () => {
  const app = runtime((request, number) => {
    if (number === 1 && request.operation === 'reviewPage') throw stale();
  });
  const values = {
    '#staffCorrectionName': 'mandy-test', '#staffCorrectionDate': '2026-08-17',
    '#staffCorrectionTime': '20:15', '#staffCorrectionReason': 'Original entered finish time',
    '#staffOlderShiftStaff': 'mandy-test', '#staffOlderShiftDate': '2026-08-17'
  };
  for (const [selector, value] of Object.entries(values)) app.$(selector).value = value;
  const original = { staffRequestId: REQUEST, staffPunchId: PUNCH, staffFingerprint: 'original-unsent-form' };
  Object.assign(app.$('#staffCorrectionForm').dataset, original);
  app.$('#staffCorrectionPanel').hidden = false;
  await app.loadStaffTime();
  await flush();
  await app.retryStaffAttention();
  await flush();
  for (const [selector, value] of Object.entries(values)) assert.equal(app.$(selector).value, value, selector);
  assert.deepEqual(app.$('#staffCorrectionForm').dataset, original);
  assert.equal(app.$('#staffCorrectionPanel').hidden, false);
  assertLoaded(app);
});

function putInlineEdit(app, kind) {
  const details = element('details');
  details.className = 'staff-adjustment';
  details.open = kind === 'open';
  const form = element('form');
  form.dataset.staffAdjustForm = '';
  form.elements = { correctedClockOut: { value: '2026-08-17T20:15:00' }, reason: { value: 'Original finish time' } };
  if (kind === 'busy') form.setAttribute('aria-busy', 'true');
  if (kind === 'retained') Object.assign(form.dataset, { staffRequestId: REQUEST, staffFingerprint: 'same adjustment' });
  details.appendChild(form);
  app.$('#staffOlderShiftResults').appendChild(details);
  return { details, form };
}

for (const kind of ['open', 'busy', 'retained']) {
  test(`${kind} inline correction: fresh read Retry preserves the exact form and pending request`, async () => {
    const app = runtime();
    await app.loadStaffTime();
    await flush();
    const edit = putInlineEdit(app, kind);
    const before = structuredClone(edit.form.dataset);
    const generation = app.state().generation;
    const callCount = app.calls.length;
    for (const retry of ['retryStaffTime', 'retryStaffAttention', 'retryStaffRecentShifts']) {
      await app[retry]();
      await flush();
      assert.equal(app.calls.length, callCount, 'No replacement reads may detach the pending edit');
      assert.equal(app.state().generation, generation);
      assert.ok(app.$('#staffOlderShiftResults').children.includes(edit.details));
      assert.deepEqual(edit.form.dataset, before);
      assert.equal(edit.form.elements.correctedClockOut.value, '2026-08-17T20:15:00');
      assert.equal(edit.form.elements.reason.value, 'Original finish time');
      assert.match(app.$('#staffTimeMessage').textContent, /unfinished correction.*preserved/u);
      assert.match(app.$('#staffTimeMessage').textContent, /Records have not been refreshed/u);
    }
  });
}

for (const section of ['attention', 'recent']) {
  test(`${section}: an edit opened during a read is retained when stale would restart it`, async () => {
    const pending = deferred();
    const entered = deferred();
    const app = runtime(request => {
      if ((section === 'attention' && request.operation === 'reviewPage')
        || (section === 'recent' && request.operation === 'shiftLookup')) {
        entered.resolve(); return pending.promise;
      }
    });
    const loading = app.loadStaffTime();
    await entered.promise;
    const edit = putInlineEdit(app, 'retained');
    const generation = app.state().generation;
    pending.reject(stale());
    await loading;
    await flush();
    assert.equal(app.calls.filter(call => call.operation === 'review').length, 1);
    assert.equal(app.state().generation, generation);
    assert.ok(app.$('#staffOlderShiftResults').children.includes(edit.details));
    assert.equal(edit.form.dataset.staffRequestId, REQUEST);
    assert.match(app.state()[`${section}Error`], /expired or changed/u);
    assert.match(app.$('#staffTimeMessage').textContent, /Records have not been refreshed/u);
    assert.match(app.$('#staffRecentShifts').textContent, /expired or changed/u);
    assert.equal(app.$('#staffRecentShiftsRetry').hidden, false);
  });
}
