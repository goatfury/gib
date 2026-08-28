import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import * as syncCore from '../m1/sync-core.mjs';
import { installationProfile } from '../m1/installation-profile-core.mjs';

const kioskHtml = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const sharedSchedule = JSON.parse(readFileSync(
  new URL('../m1/shared-schedule.json', import.meta.url),
  'utf8'
));

const LIVE_BUILD = '2026-08-09 M1 PRODUCTION timestamp-rollover';
const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';
const CANONICAL_SCHEDULE_CACHE_KEY = 'gib_m1_canonical_schedule_cache_v1';
const DEVICE_COOKIE = '__Host-gib_m1_production_device';
const DEVICE_COOKIE_VALUE = 'opaque-http-only-current-tablet-authorization';
const FIXED_NOW = Date.parse('2026-08-11T15:00:00.000Z');
const DAYS = Object.freeze([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
]);
const ROW_IDS = Object.freeze([
  'gib-m1-11111111-1111-4111-8111-111111111111',
  'gib-m1-22222222-2222-4222-8222-222222222222',
  'gib-m1-33333333-3333-4333-8333-333333333333'
]);

function kioskModuleSource() {
  const match = kioskHtml.match(/<script\s+type="module">([\s\S]*?)<\/script>/u);
  assert.ok(match, 'The kiosk module script must remain embedded in m1/index.html.');
  return match[1].replace(
    /^\s*import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/sync-core\.mjs\?v=[a-z0-9._-]{1,64}['"];\s*/iu,
    ''
  );
}

const candidateBootstrapSource = kioskModuleSource();

class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [FIXED_NOW]));
  }

  static now() {
    return FIXED_NOW;
  }
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...tokens) {
    tokens.forEach(token => this.values.add(String(token)));
  }

  remove(...tokens) {
    tokens.forEach(token => this.values.delete(String(token)));
  }

  contains(token) {
    return this.values.has(String(token));
  }

  toggle(token, force) {
    const value = String(token);
    if (force === true) {
      this.values.add(value);
      return true;
    }
    if (force === false) {
      this.values.delete(value);
      return false;
    }
    if (this.values.has(value)) {
      this.values.delete(value);
      return false;
    }
    this.values.add(value);
    return true;
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  dispatchEvent(event) {
    const value = typeof event === 'string' ? { type: event } : event;
    for (const callback of this.listeners.get(value.type) || []) callback(value);
    return true;
  }
}

function descendants(element) {
  const out = [];
  const visit = value => {
    for (const child of value.children || []) {
      out.push(child);
      visit(child);
    }
  };
  visit(element);
  return out;
}

function matchesElement(element, selector) {
  if (selector === 'input') return element.tagName === 'INPUT';
  if (selector === 'select') return element.tagName === 'SELECT';
  if (selector === 'input[type="checkbox"]') {
    return element.tagName === 'INPUT' && element.type === 'checkbox';
  }
  if (selector === 'input[type="checkbox"]:checked') {
    return element.tagName === 'INPUT' && element.type === 'checkbox' && element.checked;
  }
  if (selector === '[data-duration-rule-row]') {
    return Object.hasOwn(element.dataset, 'durationRuleRow');
  }
  return false;
}

class FakeElement extends FakeEventTarget {
  constructor(tagName = 'div', id = '') {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this.children = [];
    this.parentNode = null;
    this.parentElement = null;
    this.attributes = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.type = '';
    this.textContent = '';
    this._innerHTML = '';
    this._namedChildren = new Map();
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this._innerHTML === '') this.replaceChildren();
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get lastChild() {
    return this.children.at(-1) || null;
  }

  appendChild(child) {
    if (child == null) return child;
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter(value => value !== child);
    }
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...values) {
    values.forEach(value => {
      this.appendChild(value instanceof FakeElement
        ? value
        : new FakeTextNode(String(value)));
    });
  }

  prepend(...values) {
    const nodes = values.map(value => value instanceof FakeElement
      ? value
      : new FakeTextNode(String(value)));
    nodes.reverse().forEach(node => {
      if (node.parentNode) {
        node.parentNode.children = node.parentNode.children.filter(value => value !== node);
      }
      node.parentNode = this;
      node.parentElement = this;
      this.children.unshift(node);
    });
  }

  replaceChildren(...values) {
    this.children.forEach(child => {
      child.parentNode = null;
      child.parentElement = null;
    });
    this.children = [];
    this.append(...values);
  }

  insertBefore(child, before) {
    if (!before || !this.children.includes(before)) return this.appendChild(child);
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter(value => value !== child);
    }
    const index = this.children.indexOf(before);
    child.parentNode = this;
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(value => value !== this);
    this.parentNode = null;
    this.parentElement = null;
  }

  hasChildNodes() {
    return this.children.length > 0;
  }

  querySelector(selector) {
    if (selector.startsWith('.')) {
      if (!this._namedChildren.has(selector)) {
        this._namedChildren.set(selector, new FakeElement('span'));
      }
      return this._namedChildren.get(selector);
    }
    return descendants(this).find(value => matchesElement(value, selector)) || null;
  }

  querySelectorAll(selector) {
    return descendants(this).filter(value => matchesElement(value, selector));
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  focus() {
    this.focused = true;
  }

  select() {
    this.selected = true;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this });
  }
}

class FakeTextNode extends FakeElement {
  constructor(value) {
    super('#text');
    this.textContent = value;
  }
}

function parseElementTags() {
  const tags = new Map();
  for (const match of kioskHtml.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/giu)) {
    tags.set(match[2], match[1]);
  }
  return tags;
}

const ELEMENT_TAGS = parseElementTags();

function createDocument(cookieState) {
  const target = new FakeEventTarget();
  const elements = new Map();
  const seriesDays = DAYS.map(day => {
    const input = new FakeElement('input');
    input.type = 'checkbox';
    input.value = day;
    input.dataset.seriesDay = '';
    return input;
  });

  const getElement = id => {
    if (!elements.has(id)) {
      elements.set(id, new FakeElement(ELEMENT_TAGS.get(id) || 'div', id));
    }
    return elements.get(id);
  };
  const body = new FakeElement('body');
  const document = {
    body,
    title: '',
    visibilityState: 'visible',
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    createElement: tagName => new FakeElement(tagName),
    createTextNode: value => new FakeTextNode(String(value)),
    getElementById: getElement,
    querySelector(selector) {
      const id = /^#([^\s>+~.[\]:]+)/u.exec(String(selector))?.[1];
      return id ? getElement(id) : new FakeElement('div');
    },
    querySelectorAll(selector) {
      const value = String(selector);
      if (value === '[data-series-day]') return seriesDays;
      if (value === '[data-series-day]:checked') return seriesDays.filter(item => item.checked);
      if (value === '[data-duration-rule-row]') {
        return getElement('durationRulesWrap').querySelectorAll(value);
      }
      if (value === '#classListWrap input[type="checkbox"]') {
        return getElement('classListWrap').querySelectorAll('input[type="checkbox"]');
      }
      if (value === '#classListWrap input[type="checkbox"]:checked') {
        return getElement('classListWrap').querySelectorAll('input[type="checkbox"]:checked');
      }
      return [];
    },
    __elements: elements,
    __seriesDays: seriesDays
  };

  Object.defineProperty(document, 'cookie', {
    configurable: false,
    enumerable: true,
    // The production device credential is HttpOnly, so browser code cannot read it.
    get() {
      cookieState.reads += 1;
      return '';
    },
    set(value) {
      cookieState.writes.push(String(value));
    }
  });
  return document;
}

function createStorage(initialEntries) {
  const values = new Map(Object.entries(initialEntries).map(([key, value]) => [key, String(value)]));
  const writes = [];
  const removals = [];
  const target = {};
  Object.defineProperties(target, {
    length: { enumerable: false, get: () => values.size },
    getItem: {
      enumerable: false,
      value: key => values.get(String(key)) ?? null
    },
    setItem: {
      enumerable: false,
      value(key, value) {
        const textKey = String(key);
        const textValue = String(value);
        writes.push([textKey, textValue]);
        values.set(textKey, textValue);
      }
    },
    removeItem: {
      enumerable: false,
      value(key) {
        const textKey = String(key);
        removals.push(textKey);
        values.delete(textKey);
      }
    },
    clear: {
      enumerable: false,
      value() {
        removals.push(...values.keys());
        values.clear();
      }
    },
    key: {
      enumerable: false,
      value: index => [...values.keys()][index] ?? null
    }
  });

  const storage = new Proxy(target, {
    ownKeys(object) {
      return [...Reflect.ownKeys(object), ...values.keys()];
    },
    getOwnPropertyDescriptor(object, property) {
      if (values.has(String(property))) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: values.get(String(property))
        };
      }
      return Reflect.getOwnPropertyDescriptor(object, property);
    },
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      return values.get(String(property));
    },
    set(_object, property, value) {
      const key = String(property);
      const text = String(value);
      writes.push([key, text]);
      values.set(key, text);
      return true;
    }
  });

  return {
    storage,
    values,
    writes,
    removals,
    snapshot: () => Object.fromEntries(values)
  };
}

function completeLedgerRow(rowId, overrides = {}) {
  return {
    RowID: rowId,
    Timestamp: '2026-08-09 15:57:03',
    Date: '2026-08-09',
    'Class Label': '1:00 PM BJJ Open Mat',
    'Duration (hr)': 1,
    Instructor: 'Andrew Smith',
    Site: 'Rev',
    Device: 'Rev front tablet',
    Build: LIVE_BUILD,
    Notes: 'Current tablet state before unified rollout',
    Status: 'OK',
    __batchId: 'gib-m1-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    __syncResult: 'added',
    __syncedAt: '2026-08-09T19:57:05.000Z',
    ...overrides
  };
}

function queuedCopy(row) {
  const {
    Status: _status,
    __syncResult: _syncResult,
    __syncedAt: _syncedAt,
    ...queued
  } = row;
  return queued;
}

function scheduleVariant(mode) {
  if (mode === 'website') return {};
  const days = mode === 'disabled'
    ? Object.fromEntries(DAYS.map(day => [day, []]))
    : structuredClone(sharedSchedule.days);
  const source = mode === 'regular' ? 'default' : mode;
  const entries = {
    gib_m1_schedule_v1: JSON.stringify({
      days,
      source,
      updatedAt: '2026-08-09T12:00:00.000Z'
    })
  };
  if (mode !== 'regular') entries.gib_m1_schedule_mode_v1 = mode;
  if (mode === 'url') {
    entries.gib_m1_schedule_url_v1 = 'https://example.test/current-tablet-schedule.json';
  }
  return entries;
}

function currentLiveStorage({ waiting, scheduleMode }) {
  const first = completeLedgerRow(ROW_IDS[0]);
  const second = completeLedgerRow(ROW_IDS[1], {
    Timestamp: '2026-08-10 18:30:00',
    Date: '2026-08-10',
    'Class Label': '6:30 PM BJJ Sweeps Class (Level 3)',
    Instructor: 'Stuart Turner',
    Notes: 'Second preserved ledger row',
    __batchId: 'gib-m1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  });
  const third = completeLedgerRow(ROW_IDS[2], {
    Timestamp: '2026-08-11 06:00:09',
    Date: '2026-08-11',
    'Class Label': '6:00 AM BJJ (Level 2)',
    Instructor: 'Current Tablet Instructor',
    Notes: 'Waiting row must retain permanent identity',
    __batchId: 'gib-m1-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    __syncResult: undefined,
    __syncedAt: undefined
  });
  delete third.__syncResult;
  delete third.__syncedAt;
  const ledger = [first, second, third];
  const queue = waiting ? [queuedCopy(third)] : [];

  ROW_IDS.forEach(rowId => assert.equal(syncCore.validPermanentRowId(rowId), true));
  return {
    gib_m1_local_state_v2: JSON.stringify({ version: 2, ledger, queue }),
    gib_m1_signins_v1: JSON.stringify(ledger),
    gib_m1_sync_queue_v1: JSON.stringify(queue),
    gib_m1_sync_auto_v1: 'true',
    gib_m1_sync_last: '2026-08-10T22:30:02.000Z',
    gib_m1_sync_error: waiting
      ? 'No readable confirmation; rows are still waiting.'
      : 'Previous temporary sync warning retained for operator context.',
    gib_m1_device_label_v1: 'Rev front tablet',
    gib_m1_device_v1: JSON.stringify({
      gymName: 'Revolution BJJ',
      location: 'Front Desk Tablet',
      siteCode: 'Rev'
    }),
    gib_m1_admin_pin_v1: '7319',
    gib_m1_instructor_names_v1: JSON.stringify([
      'Andrew Smith', 'Stuart Turner', 'Current Tablet Instructor'
    ]),
    gib_m1_duration_rules_v1: JSON.stringify([
      { match: 'Kids', duration: 0.5 },
      { match: 'BJJ', duration: 1 },
      { match: 'Judo', duration: 1 }
    ]),
    gib_m1_series_v1: JSON.stringify([{
      id: 'series-current-tablet-intro',
      label: 'TEST Temporary Intro',
      time: '18:00',
      days: ['Tuesday'],
      startDate: '2026-08-04',
      endDate: '2026-08-25',
      enabled: true
    }]),
    ...scheduleVariant(scheduleMode)
  };
}

function canonicalScheduleResponse() {
  const days = structuredClone(sharedSchedule.days);
  const contentHash = createHash('sha256').update(JSON.stringify(days), 'utf8').digest('hex');
  return {
    timezone: 'America/New_York',
    site: 'Rev',
    version: `revbjj-${contentHash.slice(0, 16)}`,
    contentHash,
    days,
    source: {
      url: 'https://revolutionbjj.com/schedule/',
      upstreamUrl: 'https://revolutionbjj.com/wp-json/wp/v2/pages?slug=schedule&status=publish&_fields=id,type,slug,status,link,title,modified,modified_gmt,content',
      type: 'wordpress-rest',
      pageId: 15,
      modifiedAt: '2026-08-11T12:00:00Z'
    },
    fetchedAt: '2026-08-11T15:00:00.000Z',
    current: true,
    fallback: 'none',
    status: {
      state: 'current',
      current: true,
      fallback: 'none',
      reason: null,
      storageWarning: null,
      servedAt: '2026-08-11T15:00:01.000Z'
    },
    cache: { refreshIntervalSeconds: 300 }
  };
}

function runCandidateBootstrap({ storageState, cookieState, schedulePayload }) {
  const document = createDocument(cookieState);
  const location = {
    origin: PRODUCTION_ORIGIN,
    href: `${PRODUCTION_ORIGIN}/m1/`,
    pathname: '/m1/',
    search: '',
    hash: ''
  };
  const windowTarget = new FakeEventTarget();
  const requests = [];
  const timers = [];
  const intervals = [];
  const clearedTimers = [];
  const clearedIntervals = [];
  const alerts = [];
  const prompts = [];
  const confirms = [];
  const warnings = [];
  let nextTimerId = 1;
  const rawSchedule = JSON.stringify(schedulePayload);

  const setTimeoutImpl = (callback, delay) => {
    const id = nextTimerId++;
    timers.push({ id, callback, delay });
    return id;
  };
  const setIntervalImpl = (callback, delay) => {
    const id = nextTimerId++;
    intervals.push({ id, callback, delay });
    return id;
  };
  const window = {
    document,
    location,
    navigator: {
      onLine: true,
      clipboard: { async writeText() {} }
    },
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    dispatchEvent: windowTarget.dispatchEvent.bind(windowTarget),
    setTimeout: setTimeoutImpl,
    clearTimeout(id) { clearedTimers.push(id); },
    setInterval: setIntervalImpl,
    clearInterval(id) { clearedIntervals.push(id); }
  };

  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Response(rawSchedule, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(rawSchedule.length)
      }
    });
  };

  const context = vm.createContext({
    ...syncCore,
    AbortController,
    Blob,
    Date: FixedDate,
    M1_INSTALLATION_PROFILE: installationProfile('rev'),
    M1_INSTALLATION_PROFILE_VALID: true,
    Intl,
    Response,
    TextEncoder,
    Uint8Array,
    URL,
    URLSearchParams,
    alert: message => alerts.push(String(message)),
    clearInterval: id => clearedIntervals.push(id),
    clearTimeout: id => clearedTimers.push(id),
    confirm: message => {
      confirms.push(String(message));
      return false;
    },
    console: {
      error: (...values) => warnings.push(values.map(String).join(' ')),
      warn: (...values) => warnings.push(values.map(String).join(' ')),
      log() {}
    },
    crypto: webcrypto,
    document,
    fetch: fetchImpl,
    localStorage: storageState.storage,
    location,
    navigator: window.navigator,
    prompt: message => {
      prompts.push(String(message));
      return null;
    },
    setInterval: setIntervalImpl,
    setTimeout: setTimeoutImpl,
    structuredClone,
    window
  });
  window.crypto = webcrypto;
  window.fetch = fetchImpl;
  window.localStorage = storageState.storage;
  window.URLSearchParams = URLSearchParams;

  new vm.Script(candidateBootstrapSource, {
    filename: 'm1/index.html#candidate-bootstrap'
  }).runInContext(context);

  return {
    alerts,
    clearedIntervals,
    clearedTimers,
    confirms,
    context,
    document,
    intervals,
    prompts,
    requests,
    timers,
    warnings
  };
}

async function settleBootstrap(run, expectScheduleRequest) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
    if (!expectScheduleRequest) return;
    if (run.requests.length === 1 && run.clearedTimers.length >= 1) return;
  }
  assert.fail('The candidate schedule bootstrap did not settle.');
}

function assertOriginalBytesPreserved(before, after, label) {
  for (const [key, value] of Object.entries(before)) {
    assert.equal(after[key], value, `${label}: ${key} changed bytes`);
  }
}

function assertLoadedWithoutSetup(run, { waiting }) {
  const elements = run.document.__elements;
  assert.equal(elements.get('cfgDeviceLabel').value, 'Rev front tablet');
  assert.equal(elements.get('cfgAutoSync').checked, true);
  assert.match(elements.get('pillText').textContent, /Revolution BJJ/u);
  assert.match(elements.get('hdrLoc').textContent, /Front Desk Tablet/u);
  assert.match(
    elements.get('syncStatus').textContent,
    new RegExp(`^${waiting ? '1 row' : '0 rows'} waiting to sync\\b`, 'u')
  );
  assert.equal(elements.get('nameDatalist').children.length, 3);
  assert.equal(elements.get('durationRulesWrap').children.length, 3);
  assert.equal(run.alerts.length, 0);
  assert.equal(run.prompts.length, 0);
  assert.equal(run.confirms.length, 0);
}

test('current f712 tablet state survives the candidate bootstrap and same-origin reload', async t => {
  const scheduleModes = ['website', 'regular', 'manual', 'url', 'disabled'];
  for (const waiting of [false, true]) {
    for (const scheduleMode of scheduleModes) {
      await t.test(`${waiting ? 'waiting queue' : 'empty queue'} with ${scheduleMode} schedule`, async () => {
        const initial = currentLiveStorage({ waiting, scheduleMode });
        const before = structuredClone(initial);
        const storageState = createStorage(initial);
        const cookieState = {
          jar: new Map([[DEVICE_COOKIE, DEVICE_COOKIE_VALUE]]),
          reads: 0,
          writes: []
        };
        const cookieBefore = JSON.stringify([...cookieState.jar]);
        const payload = canonicalScheduleResponse();
        const expectScheduleRequest = scheduleMode === 'website';

        const firstRun = runCandidateBootstrap({ storageState, cookieState, schedulePayload: payload });
        await settleBootstrap(firstRun, expectScheduleRequest);
        const afterFirst = storageState.snapshot();

        assertOriginalBytesPreserved(before, afterFirst, 'first candidate load');
        const firstAddedKeys = Object.keys(afterFirst).filter(key => !Object.hasOwn(before, key));
        assert.deepEqual(
          firstAddedKeys,
          expectScheduleRequest ? [CANONICAL_SCHEDULE_CACHE_KEY] : []
        );
        assert.deepEqual(
          [...new Set(storageState.writes.map(([key]) => key))],
          expectScheduleRequest ? [CANONICAL_SCHEDULE_CACHE_KEY] : []
        );
        assert.deepEqual(storageState.removals, []);
        assert.equal(JSON.stringify([...cookieState.jar]), cookieBefore);
        assert.deepEqual(cookieState.writes, []);
        assertLoadedWithoutSetup(firstRun, { waiting });
        assert.deepEqual(
          firstRun.requests.map(request => request.url),
          expectScheduleRequest ? ['/api/m1-schedule'] : []
        );

        const writesBeforeReload = storageState.writes.length;
        const secondRun = runCandidateBootstrap({ storageState, cookieState, schedulePayload: payload });
        await settleBootstrap(secondRun, expectScheduleRequest);
        const afterReload = storageState.snapshot();

        assertOriginalBytesPreserved(before, afterReload, 'same-origin candidate reload');
        assert.deepEqual(afterReload, afterFirst);
        assert.deepEqual(
          [...new Set(storageState.writes.slice(writesBeforeReload).map(([key]) => key))],
          expectScheduleRequest ? [CANONICAL_SCHEDULE_CACHE_KEY] : []
        );
        assert.deepEqual(storageState.removals, []);
        assert.equal(JSON.stringify([...cookieState.jar]), cookieBefore);
        assert.deepEqual(cookieState.writes, []);
        assertLoadedWithoutSetup(secondRun, { waiting });
        assert.deepEqual(
          secondRun.requests.map(request => request.url),
          expectScheduleRequest ? ['/api/m1-schedule'] : []
        );

        const state = JSON.parse(afterReload.gib_m1_local_state_v2);
        assert.equal(state.queue.length, waiting ? 1 : 0);
        assert.deepEqual(state.ledger.map(row => row.RowID), ROW_IDS);
        assert.ok(state.ledger.every(row => row.Build === LIVE_BUILD));
        assert.equal(afterReload.gib_m1_sync_auto_v1, 'true');
        assert.equal(afterReload.gib_m1_admin_pin_v1, '7319');
        assert.ok([
          ...firstRun.requests,
          ...secondRun.requests
        ].every(request => !/tablet-install|import|script\.google\.com/iu.test(request.url)));
      });
    }
  }
});
