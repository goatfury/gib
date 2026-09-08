import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { installationProfile } from '../m1/installation-profile-core.mjs';

const require = createRequire(import.meta.url);
const core = require('../m1/temporary-classes-core.js');
const source = readFileSync(new URL('../m1/admin/added-classes.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const TODAY = '2026-09-07';
const clone = value => JSON.parse(JSON.stringify(value));

class Node {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase(); this.childNodes = []; this.dataset = {};
    this.style = {}; this.attributes = {}; this.listeners = {}; this.value = ''; this.hidden = false;
  }
  get children() { return this.childNodes; }
  get textContent() { return (this.ownText || '') + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text) { this.ownText = String(text); this.childNodes = []; }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.childNodes = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type, extra = {}) {
    const event = { preventDefault() {}, target: this, currentTarget: this, ...extra };
    for (const listener of this.listeners[type] || []) await listener(event);
  }
  scrollIntoView() {}
  focus() { this.focused = true; }
}
function documentValue(series = [], history = [], gymId = 'rev', version = history.length) {
  return {
    schema: core.SCHEMA, ok: true, target: 'test', gymId, timezone: 'America/New_York', version,
    current: true, updatedAt: null, servedAt: '2026-09-07T23:00:00Z', series, history, importedIdentities: []
  };
}
function oneOff(overrides = {}) {
  return core.normalizeSeries({ id: 'added_12345678123456781234567812345678', label: 'QA Intro', time: '06:00',
    days: ['Monday'], startDate: TODAY, endDate: TODAY, enabled: true, ...overrides });
}
function persisted(series, version = 1, fromDate = series.startDate) {
  return documentValue([series], [{ seriesId: series.id, revision: version, fromDate, toDate: null, series }], 'rev', version);
}
function harness({ data = documentValue(), mutate = null, local = [],
  profile = installationProfile('rev'), href = 'https://deploy-preview-83--gib-live.netlify.app/m1/admin/' } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/id="(added[^" ]+|add-class)"/gu)) nodes.set(`#${match[1]}`, new Node());
  const form = nodes.get('#addedClassForm');
  const elements = [];
  for (const name of ['className', 'startTime', 'repeatMode', 'singleDate', 'startDate', 'endDate']) {
    const node = new Node('input'); node.name = name; elements[name] = node; elements.push(node);
  }
  const weekdays = core.DAYS.map(day => {
    const node = new Node('input'); node.name = 'weekday'; node.value = day; node.checked = false; elements.push(node); return node;
  });
  form.elements = elements;
  form.reset = () => { elements.forEach(node => { if (node.name !== 'weekday') node.value = ''; }); elements.repeatMode.value = 'one'; };
  form.querySelectorAll = selector => selector.endsWith(':checked') ? weekdays.filter(node => node.checked) : weekdays;
  const document = {
    createElement: tag => new Node(tag),
    querySelector: selector => nodes.get(selector),
    querySelectorAll: () => []
  };
  let currentData = clone(data);
  let fetchFailure = false;
  let sequence = 0;
  let changes = 0;
  const requests = [];
  const reads = [];
  const context = vm.createContext({
    Intl, Date, AbortSignal,
    location: { href },
    GIBM1TemporaryClasses: { ...core, todayInGym: () => TODAY },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` },
    localStorage: { getItem: () => JSON.stringify(local) },
    fetch: async url => {
      reads.push(url);
      if (fetchFailure) throw new Error('offline');
      return { ok: true, json: async () => clone(currentData) };
    }
  });
  new vm.Script(source).runInContext(context);
  const controller = context.GIBM1AddedClassesAdmin.create({
    document,
    profile,
    request: async (url, body) => {
      requests.push({ url, body: clone(body) });
      if (mutate) return mutate(clone(body), requests.length);
      currentData = persisted(core.normalizeSeries({ ...body.series, id: 'added_12345678123456781234567812345678' }));
      return clone(currentData);
    },
    onChange: () => { changes += 1; }, onUnauthorized: () => {}, onReviewDate: () => {}
  });
  controller.setActive(true);
  function draft(values = {}) {
    const defaults = { className: 'QA Intro', startTime: '06:00', singleDate: TODAY };
    for (const [name, value] of Object.entries({ ...defaults, ...values })) elements[name].value = value;
    return form.fire('input');
  }
  return { controller, nodes, elements, form, weekdays, requests, reads, draft,
    timings: context.GIBM1AddedClassesAdmin.classTiming,
    offline: () => { fetchFailure = true; }, setData(value) { currentData = clone(value); }, get changes() { return changes; } };
}

for (const gymId of ['rev', 'richmond']) {
  test(`${gymId}: canonical production Admin accepts only production read and save confirmations`, async () => {
    const profile = installationProfile(gymId, 'production', 'active');
    const href = profile.allowedOrigin + '/m1/admin/';
    const empty = { ...documentValue([], [], gymId), target: 'production' };
    const saved = oneOff();
    const confirmation = { ...documentValue([saved], [{ seriesId: saved.id, revision: 1,
      fromDate: saved.startDate, toDate: null, series: saved }], gymId, 1), target: 'production' };
    const ui = harness({ profile, href, data: empty, mutate: () => confirmation });
    assert.equal(await ui.controller.refresh(), true);
    await ui.draft(); await ui.form.fire('submit');
    assert.equal(ui.requests.length, 1);
    assert.deepEqual(ui.controller.classesForDate({}, TODAY), [core.classLabel(saved)]);
    assert.equal(ui.controller.isCurrent(), true);

    const wrongRead = harness({ profile, href, data: { ...empty, target: 'test' } });
    assert.equal(await wrongRead.controller.refresh(), false);
    await wrongRead.draft(); await wrongRead.form.fire('submit');
    assert.equal(wrongRead.requests.length, 0);
    assert.equal(wrongRead.nodes.get('#addedClassSave').disabled, true);

    const wrongAck = harness({ profile, href, data: empty, mutate: () => ({ ...confirmation, target: 'test' }) });
    await wrongAck.controller.refresh(); await wrongAck.draft(); await wrongAck.form.fire('submit');
    assert.equal(wrongAck.requests.length, 1);
    assert.deepEqual(wrongAck.controller.classesForDate({}, TODAY), []);
    assert.match(wrongAck.nodes.get('#addedClassStatus').textContent, /could not be confirmed/i);
  });
}

test('Richmond production reads do not authorize writes until both activation and write permission are active', async () => {
  const active = installationProfile('richmond', 'production', 'active');
  for (const profile of [installationProfile('richmond', 'production', 'pending'),
    { ...active, writesEnabled: false }, { ...active, activation: 'pending' }]) {
    const ui = harness({ profile, href: active.allowedOrigin + '/m1/admin/',
      data: { ...documentValue([], [], 'richmond'), target: 'production' }, local: [oneOff()] });
    assert.equal(await ui.controller.refresh(), true);
    await ui.draft(); await ui.form.fire('submit');
    await ui.nodes.get('#addedClassImport').fire('click');
    assert.equal(ui.requests.length, 0);
    assert.equal(ui.nodes.get('#addedClassSave').disabled, true);
    assert.equal(ui.nodes.get('#addedClassImport').disabled, true);
  }
});

test('TEST Admin rejects production data and unknown addresses never read or write shared classes', async () => {
  const crossed = harness({ data: { ...documentValue(), target: 'production' } });
  assert.equal(await crossed.controller.refresh(), false);
  await crossed.draft(); await crossed.form.fire('submit');
  assert.equal(crossed.requests.length, 0);
  for (const href of ['https://foreign.example/m1/admin/', 'http://gib-live.netlify.app/m1/admin/',
    'https://gib-richmond-live.netlify.app/m1/admin/']) {
    const ui = harness({ href });
    assert.equal(await ui.controller.refresh(), false);
    await ui.draft(); await ui.form.fire('submit');
    assert.equal(ui.reads.length, 0);
    assert.equal(ui.requests.length, 0);
  }
});

test('Admin defaults to one date, previews the exact date, and saves same-day late classes centrally without teaching records', async () => {
  const ui = harness();
  await ui.controller.refresh(); await ui.draft();
  assert.equal(ui.elements.repeatMode.value, 'one');
  assert.equal(ui.nodes.get('#addedRepeatingDates').hidden, true);
  assert.equal(ui.elements.startDate.disabled, true, 'hidden repeating dates cannot block native form validation');
  assert.equal(ui.nodes.get('#addedClassSave').disabled, false);
  assert.match(ui.nodes.get('#addedClassPreview').textContent, /Mon, Sep 7, 2026/);
  await ui.form.fire('submit');
  assert.equal(ui.requests.length, 1);
  const body = ui.requests[0].body;
  assert.equal(ui.requests[0].url, '/api/m1-added-classes');
  assert.equal(body.action, 'create');
  assert.deepEqual(core.datesForSeries(body.series), [TODAY]);
  assert.equal(body.series.time, '06:00');
  assert.equal(body.expectedVersion, 0);
  assert.ok(!('instructor' in body) && !('duration' in body) && !('rows' in body));
  assert.match(ui.nodes.get('#addedClassStatus').textContent, /Saved centrally/);
  assert.match(ui.nodes.get('#addedClassStatus').textContent, /Tablet receipt has not been confirmed/);
  assert.deepEqual(ui.controller.classesForDate({}, TODAY), ['6:00 AM QA Intro']);
});

test('limited weekday series previews every inclusive date across a month change and excludes other days', async () => {
  const ui = harness(); await ui.controller.refresh();
  ui.weekdays.forEach(node => { node.checked = ['Monday', 'Wednesday'].includes(node.value); });
  await ui.draft({ repeatMode: 'series', startDate: '2026-09-28', endDate: '2026-10-07' });
  assert.equal(ui.nodes.get('#addedSingleDate').hidden, true);
  assert.equal(ui.elements.singleDate.disabled, true);
  assert.equal(ui.nodes.get('#addedRepeatingDates').hidden, false);
  const preview = ui.nodes.get('#addedClassPreview').textContent;
  for (const date of ['Sep 28', 'Sep 30', 'Oct 5', 'Oct 7']) assert.ok(preview.includes(date));
  assert.ok(!preview.includes('Sep 29'));
  await ui.form.fire('submit');
  assert.deepEqual(core.datesForSeries(ui.requests[0].body.series), ['2026-09-28', '2026-09-30', '2026-10-05', '2026-10-07']);
});

test('new past dates and invalid or empty repeats cannot be saved', async () => {
  const ui = harness(); await ui.controller.refresh();
  await ui.draft({ singleDate: '2026-09-06' });
  assert.equal(ui.nodes.get('#addedClassSave').disabled, true);
  await ui.form.fire('submit'); assert.equal(ui.requests.length, 0);
  ui.weekdays.forEach(node => { node.checked = false; });
  await ui.draft({ repeatMode: 'series', startDate: TODAY, endDate: '2026-09-30' });
  assert.equal(ui.nodes.get('#addedClassSave').disabled, true);
  await ui.form.fire('submit'); assert.equal(ui.requests.length, 0);
});

test('an unconfirmed central save preserves the draft and reuses its exact request and class identity', async () => {
  const ui = harness({ mutate(body, count) {
    if (count === 1) throw new Error('Connection lost before confirmation');
    return persisted(core.normalizeSeries({ ...body.series, id: 'added_12345678123456781234567812345678' }));
  } });
  await ui.controller.refresh(); await ui.draft();
  await ui.form.fire('submit');
  assert.equal(ui.elements.className.value, 'QA Intro');
  assert.match(ui.nodes.get('#addedClassStatus').textContent, /Save not confirmed/);
  await ui.form.fire('submit');
  assert.deepEqual(ui.requests[0].body, ui.requests[1].body);
  assert.equal(ui.requests.length, 2);
});

test('wrong-gym and unavailable shared schedules fail closed; stale cached dates remain plainly labeled', async () => {
  const wrongGym = harness({ data: documentValue([], [], 'richmond') });
  await wrongGym.controller.refresh(); await wrongGym.draft();
  assert.equal(wrongGym.controller.isCurrent(), false);
  assert.equal(wrongGym.nodes.get('#addedClassSave').disabled, true);
  await wrongGym.form.fire('submit'); assert.equal(wrongGym.requests.length, 0);
  const ui = harness({ data: persisted(oneOff()) });
  await ui.controller.refresh(); ui.offline(); await ui.controller.refresh();
  assert.equal(ui.controller.isCurrent(), false);
  assert.deepEqual(ui.controller.classesForDate({}, TODAY), ['6:00 AM QA Intro']);
  assert.match(ui.nodes.get('#addedClassStatus').textContent, /may be out of date/);
  assert.equal(ui.nodes.get('#addedClassSave').disabled, true);
});

test('cancel upcoming asks for a concrete date review then preserves earlier schedule history', async () => {
  const original = oneOff({ days: ['Sunday', 'Monday', 'Tuesday'], startDate: '2026-09-06', endDate: '2026-09-08' });
  const canceled = core.normalizeSeries({ ...original, enabled: false });
  const after = documentValue([canceled], [
    { seriesId: original.id, revision: 1, fromDate: '2026-09-06', toDate: '2026-09-06', series: original },
    { seriesId: original.id, revision: 2, fromDate: TODAY, toDate: null, series: canceled }
  ]);
  const ui = harness({ data: persisted(original), mutate: () => after });
  await ui.controller.refresh();
  const button = { dataset: { addedCancel: original.id } };
  await ui.nodes.get('#addedClassList').fire('click', { target: { closest: selector => selector === '[data-added-cancel]' ? button : null } });
  assert.equal(ui.requests.length, 0, 'opening a cancellation review performs no write');
  const review = ui.nodes.get('#addedClassCancelCopy').textContent;
  assert.match(review, /Sep 7, 2026/); assert.match(review, /Sep 8, 2026/); assert.doesNotMatch(review, /Sep 6, 2026/);
  await ui.nodes.get('#addedClassCancelConfirm').fire('click');
  assert.equal(ui.requests[0].body.effectiveDate, TODAY);
  assert.equal(ui.requests[0].body.action, 'cancel');
  assert.deepEqual(ui.controller.classesForDate({}, '2026-09-06'), ['6:00 AM QA Intro']);
  assert.deepEqual(ui.controller.classesForDate({}, TODAY), []);
  assert.match(ui.nodes.get('#addedClassHistoryList').textContent, /Sep 6, 2026/);
});

test('editing carries the selected class and remaining dates into the same form', async () => {
  const original = oneOff({ startDate: '2026-09-14', endDate: '2026-09-14' });
  const ui = harness({ data: persisted(original) }); await ui.controller.refresh();
  const button = { dataset: { addedEdit: original.id } };
  await ui.nodes.get('#addedClassList').fire('click', { target: { closest: selector => selector === '[data-added-edit]' ? button : null } });
  assert.equal(ui.elements.className.value, original.label);
  assert.equal(ui.elements.singleDate.value, '2026-09-14');
  ui.elements.startTime.value = '19:30';
  await ui.form.fire('input'); await ui.form.fire('submit');
  assert.equal(ui.requests[0].body.action, 'update');
  assert.equal(ui.requests[0].body.seriesId, original.id);
  assert.equal(ui.requests[0].body.effectiveDate, TODAY);
  assert.equal(ui.requests[0].body.series.time, '19:30');
});

test('local compatibility import uses the authenticated central request and never removes original local data', async () => {
  const legacy = oneOff({ id: 'legacy_1' });
  const ui = harness({ local: [legacy], mutate: () => persisted(legacy) });
  await ui.controller.refresh();
  assert.equal(ui.nodes.get('#addedClassLocal').hidden, false);
  await ui.nodes.get('#addedClassImport').fire('click');
  assert.equal(ui.requests[0].body.action, 'import');
  assert.deepEqual(ui.requests[0].body.series, [legacy]);
  assert.equal(ui.nodes.get('#addedClassLocal').hidden, false);
  assert.doesNotMatch(source, /localStorage\.(?:removeItem|clear|setItem)/u);
});

test('Daily Review distinguishes future starts using New York dates and both daylight-saving transitions', () => {
  const timing = harness().timings;
  assert.equal(timing('6:30 PM QA Intro', TODAY, new Date('2026-09-07T22:00:00Z')), 'upcoming');
  assert.equal(timing('6:00 AM QA Intro', TODAY, new Date('2026-09-07T22:00:00Z')), 'past');
  assert.equal(timing('11:00 PM QA Intro', TODAY, new Date('2026-09-08T02:00:00Z')), 'upcoming', 'UTC midnight does not advance the gym date');
  assert.equal(timing('2:00 AM QA Intro', '2026-11-01', new Date('2026-11-01T06:30:00Z')), 'upcoming');
  assert.equal(timing('2:00 AM QA Intro', '2026-11-01', new Date('2026-11-01T07:30:00Z')), 'past');
  assert.equal(timing('3:00 AM QA Intro', '2026-03-08', new Date('2026-03-08T06:59:00Z')), 'upcoming');
  assert.equal(timing('3:00 AM QA Intro', '2026-03-08', new Date('2026-03-08T07:00:00Z')), 'past');
});

test('late older reads cannot erase a confirmed shared schedule and same-version conflicts are unavailable', async () => {
  const original = oneOff();
  const ui = harness({ data: persisted(original) }); await ui.controller.refresh();
  ui.setData(documentValue()); await ui.controller.refresh();
  assert.deepEqual(ui.controller.classesForDate({}, TODAY), ['6:00 AM QA Intro']);
  assert.equal(ui.controller.isCurrent(), true);
  ui.setData(persisted(oneOff({ label: 'Conflicting class' }))); await ui.controller.refresh();
  assert.equal(ui.controller.isCurrent(), false);
  assert.deepEqual(ui.controller.classesForDate({}, TODAY), ['6:00 AM QA Intro']);
});

test('one date can be canceled without canceling the rest of its repeating series', async () => {
  const original = oneOff({ days: ['Monday', 'Wednesday'], endDate: '2026-09-16' });
  const changed = core.normalizeSeries({ ...original, cancelledDates: ['2026-09-09'] });
  const ui = harness({ data: persisted(original), mutate: () => persisted(changed, 2) });
  await ui.controller.refresh();
  const button = { dataset: { addedCancel: original.id, addedCancelDate: '2026-09-09' } };
  await ui.nodes.get('#addedClassList').fire('click', { target: { closest: selector => selector === '[data-added-cancel]' ? button : null } });
  const review = ui.nodes.get('#addedClassCancelCopy').textContent;
  assert.match(review, /Sep 9, 2026/); assert.doesNotMatch(review, /Sep 14, 2026/);
  await ui.nodes.get('#addedClassCancelConfirm').fire('click');
  assert.equal(ui.requests[0].body.date, '2026-09-09');
  assert.ok(!('effectiveDate' in ui.requests[0].body));
  assert.deepEqual(ui.controller.classesForDate({}, '2026-09-09'), []);
  assert.deepEqual(ui.controller.classesForDate({}, '2026-09-14'), ['6:00 AM QA Intro']);
});

test('unrecognized local entries stay visible with an explicit count instead of silently disappearing', async () => {
  const ui = harness({ local: [oneOff(), { id: 'old-without-time', label: 'Legacy class' }] });
  await ui.controller.refresh();
  assert.equal(ui.nodes.get('#addedClassLocal').hidden, false);
  assert.match(ui.nodes.get('#addedClassLocalCount').textContent, /2 locally saved class entries found; 1 can be shared/);
  assert.match(ui.nodes.get('#addedClassLocalCount').textContent, /1 could not be shared/);
  assert.match(ui.nodes.get('#addedClassLocalCount').textContent, /Originals remain/);
});

test('editing a remaining series preserves dates already canceled individually', async () => {
  const original = oneOff({ days: ['Monday', 'Wednesday'], endDate: '2026-09-16', cancelledDates: ['2026-09-09'] });
  const ui = harness({ data: persisted(original) }); await ui.controller.refresh();
  const button = { dataset: { addedEdit: original.id } };
  await ui.nodes.get('#addedClassList').fire('click', { target: { closest: selector => selector === '[data-added-edit]' ? button : null } });
  ui.elements.startTime.value = '19:30';
  await ui.form.fire('input');
  assert.doesNotMatch(ui.nodes.get('#addedClassPreview').textContent, /Sep 9, 2026/);
  await ui.form.fire('submit');
  assert.deepEqual(ui.requests[0].body.series.cancelledDates, ['2026-09-09']);
});

test('a later schedule refresh cannot render missing/all-clear data after the review request failed', () => {
  const render = html.slice(html.indexOf('function renderReview()'), html.indexOf('async function loadReview('));
  let touched = false;
  const context = vm.createContext({ reviewLoaded: false, schedule: { current: true }, $() { touched = true; throw new Error('Must not render'); } });
  new vm.Script(`${render}\nrenderReview();`).runInContext(context);
  assert.equal(touched, false);
  const apply = html.slice(html.indexOf('function applyScheduleToReviewWhenSafe()'), html.indexOf('function applyPendingScheduleToReview('));
  let rendered = false;
  Object.assign(context, { renderScheduleSource() {}, currentDate: TODAY, $: () => ({ hidden: false }), renderReview() { rendered = true; } });
  new vm.Script(`${apply}\napplyScheduleToReviewWhenSafe();`).runInContext(context);
  assert.equal(rendered, false);
});
