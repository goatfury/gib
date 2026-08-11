import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MAX_UPSTREAM_BYTES,
  PUBLIC_SCHEDULE_URL,
  ScheduleSourceError,
  WORDPRESS_SCHEDULE_URL,
  comparisonLabel,
  parseScheduleHtml,
  scheduleFromWordPressPayload,
  validatePlausibleScheduleTransition
} from '../netlify/functions/_lib/m1-schedule-core.mjs';
import {
  REFRESH_INTERVAL_MS,
  fetchCurrentSchedule,
  handleM1Schedule,
  validScheduleRequest
} from '../netlify/functions/m1-schedule.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/revolutionbjj-schedule-wordpress.json', import.meta.url),
  'utf8'
));
const previewUrl = 'https://deploy-preview-99--gib-live.netlify.app/api/m1-schedule';
const now = Date.parse('2026-08-11T21:00:00.000Z');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceResponse(payload = fixture, options = {}) {
  const response = new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: {
      'Content-Type': options.contentType || 'application/json; charset=UTF-8',
      ...(options.headers || {})
    }
  });
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: options.url || WORDPRESS_SCHEDULE_URL
  });
  return response;
}

function serviceDependencies(overrides = {}) {
  return {
    now,
    deployContext: 'deploy-preview',
    published: false,
    env: {},
    memory: { value: null, storedAt: 0, lastAttemptAt: 0, lastFailureReason: '' },
    store: new MemoryStore(),
    fetchImpl: async () => sourceResponse(),
    ...overrides
  };
}

class MemoryStore {
  constructor(value = null) {
    this.value = value;
    this.etag = value ? '"seed"' : '';
    this.writes = 0;
    this.lastOptions = null;
  }

  async getWithMetadata() {
    return this.value ? { data: clone(this.value), etag: this.etag } : null;
  }

  async get() {
    return this.value ? clone(this.value) : null;
  }

  async set(_key, text, options = {}) {
    this.lastOptions = options;
    if (options.onlyIfNew && this.value) return { modified: false };
    if (options.onlyIfMatch && options.onlyIfMatch !== this.etag) return { modified: false };
    this.value = JSON.parse(text);
    this.etag = `"write-${++this.writes}"`;
    return { modified: true, etag: this.etag };
  }
}

function replaceRendered(pattern, replacement) {
  const payload = clone(fixture);
  payload[0].content.rendered = payload[0].content.rendered.replace(pattern, replacement);
  return payload;
}

function payloadFromDays(days, modifiedGmt = '2026-08-09T12:30:00') {
  const payload = clone(fixture);
  payload[0].modified_gmt = modifiedGmt;
  payload[0].modified = modifiedGmt.replace('T12:', 'T08:');
  payload[0].content.rendered = Object.entries(days).map(([day, labels]) => (
    `<p class="wp-block-paragraph"><strong>${day}</strong>:<br>${labels.join('<br>')}</p>`
  )).join('\n\n\n\n');
  return payload;
}

function replacementLabel(label, suffix) {
  const time = /^(?:1[0-2]|[1-9]):[0-5]\d\s+(?:AM|PM)/u.exec(label)?.[0];
  assert.ok(time, `expected a canonical class time in ${label}`);
  return `${time} Review candidate ${suffix}`;
}

function replaceSchedulePartition(days, partition, partitionCount = 4) {
  const next = clone(days);
  for (const [day, labels] of Object.entries(next)) {
    for (let index = partition; index < labels.length; index += partitionCount) {
      labels[index] = replacementLabel(labels[index], `${day} ${index + 1}`);
    }
  }
  return next;
}

function replaceEveryClass(days) {
  return Object.fromEntries(Object.entries(days).map(([day, labels]) => [
    day,
    labels.map((label, index) => replacementLabel(label, `${day} ${index + 1}`))
  ]));
}

function errorCode(fn, code) {
  assert.throws(fn, error => error instanceof ScheduleSourceError && error.code === code);
}

test('captured public WordPress schedule fixture parses into the current seven-day contract', () => {
  const result = scheduleFromWordPressPayload(fixture, '2026-08-11T21:00:00.000Z');
  assert.equal(result.timezone, 'America/New_York');
  assert.equal(result.site, 'Rev');
  assert.equal(Object.keys(result.days).length, 7);
  assert.equal(Object.values(result.days).flat().length, 55);
  assert.equal(result.days.Monday[5], '5:30 PM Muay Thai Drills');
  assert.equal(result.days.Monday[6], '5:30 PM Focus Class (Level 4) – tripod passing (changes every quarter)');
  assert.equal(result.source.url, PUBLIC_SCHEDULE_URL);
  assert.equal(result.source.type, 'wordpress-rest');
  assert.match(result.contentHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.version, `revbjj-${result.contentHash.slice(0, 16)}`);
});

test('added, removed, renamed, and changed-time classes produce validated new content versions', () => {
  const baseline = scheduleFromWordPressPayload(fixture);
  const variants = [
    replaceRendered('1:00 PM BJJ Open Mat</p>', '1:00 PM BJJ Open Mat<br>2:00 PM Sunday Lab</p>'),
    replaceRendered('<br>1:00 PM BJJ Open Mat</p>', '</p>'),
    replaceRendered('6:30 PM BJJ Sweeps Class (Level 3)', '6:30 PM BJJ Passing Class (Level 3)'),
    replaceRendered('5:30 PM BJJ (Level 2)<br>6:00 PM Muay Thai', '6:15 PM BJJ (Level 2)<br>6:00 PM Muay Thai')
  ];
  for (const variant of variants) {
    const parsed = scheduleFromWordPressPayload(variant);
    assert.notEqual(parsed.version, baseline.version);
  }
  const changedTime = scheduleFromWordPressPayload(variants[3]);
  assert.equal(changedTime.days.Friday.at(-1), '6:15 PM BJJ (Level 2)');
});

test('transition guard allows ordinary additions, removals, renames, and moved times', () => {
  const previous = scheduleFromWordPressPayload(fixture).days;
  const next = clone(previous);
  next.Sunday.push('2:00 PM Sunday Lab');
  next.Tuesday.pop();
  next.Monday[1] = '12:00 PM BJJ Arm Bars (Level 2)';
  next.Wednesday[1] = '12:30 PM No-Gi BJJ (Level 2)';

  const validated = validatePlausibleScheduleTransition(next, previous);
  assert.equal(Object.values(validated).flat().length, Object.values(previous).flat().length);
  assert.ok(validated.Sunday.includes('2:00 PM Sunday Lab'));
  assert.ok(validated.Monday.includes('12:00 PM BJJ Arm Bars (Level 2)'));
  assert.ok(validated.Wednesday.includes('12:30 PM No-Gi BJJ (Level 2)'));
});

test('transition guard accepts the verified Aug 9 to Aug 11 live addition', () => {
  const current = scheduleFromWordPressPayload(fixture).days;
  const previous = clone(current);
  previous.Monday = previous.Monday.filter(label => label !== '5:30 PM Muay Thai Drills');
  const validated = validatePlausibleScheduleTransition(current, previous);
  assert.equal(Object.values(previous).flat().length, 54);
  assert.equal(Object.values(validated).flat().length, 55);
  assert.ok(validated.Monday.includes('5:30 PM Muay Thai Drills'));
});

test('transition guard rejects excessive total and per-day growth with a growth reason', () => {
  const previous = scheduleFromWordPressPayload(fixture).days;
  const excessiveTotal = clone(previous);
  excessiveTotal.Sunday.push(...Array.from(
    { length: 18 },
    (_, index) => `2:00 AM Total Growth Class ${index + 1}`
  ));
  assert.equal(Object.values(excessiveTotal).flat().length, 73);
  errorCode(
    () => validatePlausibleScheduleTransition(excessiveTotal, previous),
    'unexpected-schedule-growth'
  );

  const excessiveDay = clone(previous);
  excessiveDay.Sunday.push(
    '2:01 AM Daily Growth Class 1',
    '2:02 AM Daily Growth Class 2',
    '2:03 AM Daily Growth Class 3'
  );
  errorCode(
    () => validatePlausibleScheduleTransition(excessiveDay, previous),
    'unexpected-schedule-growth'
  );
});

test('transition guard rejects wholesale week and normal-day label replacement as churn', () => {
  const previous = scheduleFromWordPressPayload(fixture).days;
  const replacedWeek = Object.fromEntries(Object.entries(previous).map(([day, labels]) => [
    day,
    labels.map((_, index) => `${(index % 12) + 1}:15 AM Replacement ${day} Class ${index + 1}`)
  ]));
  errorCode(
    () => validatePlausibleScheduleTransition(replacedWeek, previous),
    'unexpected-schedule-churn'
  );

  const replacedMonday = clone(previous);
  replacedMonday.Monday = previous.Monday.map(
    (_, index) => `${(index % 12) + 1}:30 PM Replacement Monday Class ${index + 1}`
  );
  errorCode(
    () => validatePlausibleScheduleTransition(replacedMonday, previous),
    'unexpected-schedule-churn'
  );
});

test('transition guard requires retention even on a two-class day', () => {
  const previous = scheduleFromWordPressPayload(fixture).days;
  const oneSundayEdit = clone(previous);
  oneSundayEdit.Sunday[0] = '12:30 PM Sunday ordinary time edit';
  assert.doesNotThrow(() => validatePlausibleScheduleTransition(oneSundayEdit, previous));

  const replacedSunday = clone(previous);
  replacedSunday.Sunday = replacedSunday.Sunday.map((label, index) => (
    replacementLabel(label, `Sunday ${index + 1}`)
  ));
  errorCode(
    () => validatePlausibleScheduleTransition(replacedSunday, previous),
    'unexpected-schedule-churn'
  );
});

test('canonical class labels accept exactly 200 characters and reject 201', () => {
  const days = scheduleFromWordPressPayload(fixture).days;
  const exactBoundary = clone(days);
  exactBoundary.Monday[0] = '6:00 AM '.padEnd(200, 'A');
  assert.equal(exactBoundary.Monday[0].length, 200);
  assert.equal(
    scheduleFromWordPressPayload(payloadFromDays(exactBoundary)).days.Monday[0].length,
    200
  );

  const oversized = clone(exactBoundary);
  oversized.Monday[0] += 'A';
  errorCode(
    () => scheduleFromWordPressPayload(payloadFromDays(oversized)),
    'invalid-class-label'
  );
});

test('whitespace is normalized and punctuation comparison is stable', () => {
  const payload = replaceRendered(
    '6:00 AM BJJ (Level 4)/Gi BJJ Intro Class',
    '  6:00   AM BJJ (Level 4) / Gi BJJ Intro Class  '
  );
  const parsed = scheduleFromWordPressPayload(payload);
  assert.equal(parsed.days.Tuesday[0], '6:00 AM BJJ (Level 4) / Gi BJJ Intro Class');
  assert.equal(
    comparisonLabel('6:00 AM Drill/Roll Class — BJJ'),
    comparisonLabel('6:00 AM Drill / Roll Class – BJJ')
  );
});

test('missing, empty, partial, and duplicate weekday structures fail closed', () => {
  errorCode(
    () => parseScheduleHtml(fixture[0].content.rendered.replace(/<p[^>]*><strong>Sunday[\s\S]*?<\/p>/u, '')),
    'unexpected-markup-shape'
  );
  errorCode(() => parseScheduleHtml(''), 'oversized-or-empty-upstream');
  errorCode(
    () => parseScheduleHtml('<p><strong>Monday</strong>:<br>6:00 AM BJJ</p>'),
    'unexpected-markup-shape'
  );
  const structurallyCompleteButTruncated = [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
  ].map(day => (
    `<p class="wp-block-paragraph"><strong>${day}</strong>:<br>`
    + '6:00 AM First Class<br>12:00 PM Second Class<br>6:00 PM Third Class</p>'
  )).join('');
  errorCode(
    () => parseScheduleHtml(structurallyCompleteButTruncated),
    'empty-partial-or-oversized-day'
  );
  const duplicated = fixture[0].content.rendered.replace(
    '<p class="wp-block-paragraph"><strong>Tuesday</strong>',
    '<p class="wp-block-paragraph"><strong>Monday</strong>'
  );
  errorCode(() => parseScheduleHtml(duplicated), 'duplicate-day-section');
});

test('duplicate classes and unexpected or executable class markup fail closed', () => {
  const duplicate = replaceRendered(
    '1:00 PM BJJ Open Mat</p>',
    '1:00 PM BJJ Open Mat<br>1:00 PM BJJ Open Mat</p>'
  );
  errorCode(() => scheduleFromWordPressPayload(duplicate), 'duplicate-class');
  const unexpected = replaceRendered(
    '1:00 PM BJJ Open Mat',
    '<em>1:00 PM BJJ Open Mat</em>'
  );
  errorCode(() => scheduleFromWordPressPayload(unexpected), 'unexpected-markup-shape');
  const malicious = replaceRendered(
    '1:00 PM BJJ Open Mat',
    '1:00 PM BJJ Open Mat<script>alert(1)</script>'
  );
  errorCode(() => scheduleFromWordPressPayload(malicious), 'executable-or-unexpected-markup');
  const invisibleControl = replaceRendered(
    '6:00 AM BJJ (Level 2)',
    '6:00 AM B\u200BJJ (Level 2)'
  );
  errorCode(() => scheduleFromWordPressPayload(invisibleControl), 'invalid-class-label');
  const hiddenDay = replaceRendered(
    '<p class="wp-block-paragraph"><strong>Monday</strong>',
    '<p class="wp-block-paragraph" hidden><strong>Monday</strong>'
  );
  errorCode(() => scheduleFromWordPressPayload(hiddenDay), 'executable-or-unexpected-markup');
  const supersededShape = clone(fixture);
  supersededShape[0].content.rendered += '<table><tr><th>Monday</th></tr></table>';
  errorCode(() => scheduleFromWordPressPayload(supersededShape), 'unexpected-markup-shape');
  const hiddenWrapper = clone(fixture);
  hiddenWrapper[0].content.rendered = `<div hidden>${hiddenWrapper[0].content.rendered}</div>`;
  errorCode(() => scheduleFromWordPressPayload(hiddenWrapper), 'executable-or-unexpected-markup');

  for (const hiddenValue of ['hidden="hidden"', 'hidden=""', 'hidden=true']) {
    const valueBearingHiddenWrapper = clone(fixture);
    valueBearingHiddenWrapper[0].content.rendered = `<div ${hiddenValue}>${valueBearingHiddenWrapper[0].content.rendered}</div>`;
    errorCode(
      () => scheduleFromWordPressPayload(valueBearingHiddenWrapper),
      'executable-or-unexpected-markup'
    );
  }

  for (const wrapper of [
    '<div class="hidden">%s</div>',
    '<details>%s</details>',
    '<noscript>%s</noscript>',
    '<dialog>%s</dialog>',
    '<a class="hidden">%s</a>',
    '<strong class="hidden">%s</strong>'
  ]) {
    const retiredWrapper = clone(fixture);
    retiredWrapper[0].content.rendered = wrapper.replace('%s', retiredWrapper[0].content.rendered);
    errorCode(() => scheduleFromWordPressPayload(retiredWrapper), 'unexpected-markup-shape');
  }
  const replacementDiv = clone(fixture);
  replacementDiv[0].content.rendered += '<div class="new-schedule"><strong>Monday</strong>: 6:00 AM New</div>';
  errorCode(() => scheduleFromWordPressPayload(replacementDiv), 'unexpected-markup-shape');
});

test('oversized HTML and oversized HTTP bodies are rejected', async () => {
  errorCode(() => parseScheduleHtml('x'.repeat(MAX_UPSTREAM_BYTES + 1)), 'oversized-or-empty-upstream');
  await assert.rejects(
    () => fetchCurrentSchedule(async () => sourceResponse(fixture, {
      headers: { 'Content-Length': String(MAX_UPSTREAM_BYTES + 1) }
    }), now),
    error => error instanceof ScheduleSourceError && error.code === 'oversized-response'
  );
});

test('network timeout, HTTP failure, and redirect to another origin are distinguished', async () => {
  await assert.rejects(
    () => fetchCurrentSchedule(async () => { throw new DOMException('timeout', 'AbortError'); }, now),
    error => error.code === 'network-timeout'
  );
  const abortedBody = new Response(new ReadableStream({
    start(controller) {
      controller.error(new DOMException('body timed out', 'AbortError'));
    }
  }), { headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(abortedBody, 'url', { value: WORDPRESS_SCHEDULE_URL });
  await assert.rejects(
    () => fetchCurrentSchedule(async () => abortedBody, now),
    error => error.code === 'network-timeout'
  );
  await assert.rejects(
    () => fetchCurrentSchedule(async () => sourceResponse({}, { status: 503 }), now),
    error => error.code === 'http-failure'
  );
  await assert.rejects(
    () => fetchCurrentSchedule(async () => sourceResponse({}, {
      status: 302,
      url: 'https://evil.example/schedule'
    }), now),
    error => error.code === 'redirect-rejected'
  );
});

test('a materially future WordPress modification time cannot pin last known good', () => {
  const future = clone(fixture);
  future[0].modified_gmt = '2099-01-01T00:00:00';
  future[0].modified = '2098-12-31T19:00:00';
  errorCode(
    () => scheduleFromWordPressPayload(future, '2026-08-09T13:00:00.000Z'),
    'future-wordpress-modified-time'
  );
});

test('a future-dated durable record is ignored rather than pinning fallback', async () => {
  const invalidDurable = scheduleFromWordPressPayload(fixture, '2026-08-11T21:00:00.000Z');
  invalidDurable.source.modifiedAt = '2099-01-01T00:00:00Z';
  const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    store: new MemoryStore(invalidDurable),
    fetchImpl: async () => sourceResponse({}, { status: 503 })
  }));
  const body = await response.json();
  assert.equal(body.fallback, 'bootstrap');
  assert.equal(body.source.type, 'checked-in-bootstrap');
  assert.equal(body.status.reason, 'http-failure');
});

test('successful refresh is cached and written atomically as last known good', async () => {
  const store = new MemoryStore();
  const memory = { value: null, storedAt: 0, lastAttemptAt: 0, lastFailureReason: '' };
  let fetches = 0;
  const dependencies = serviceDependencies({
    store,
    memory,
    fetchImpl: async () => { fetches += 1; return sourceResponse(); }
  });
  const first = await handleM1Schedule(new Request(previewUrl), dependencies);
  const firstBody = await first.json();
  const second = await handleM1Schedule(new Request(previewUrl), {
    ...dependencies,
    now: now + REFRESH_INTERVAL_MS - 1
  });
  const secondBody = await second.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.current, true);
  assert.equal(firstBody.fallback, 'none');
  assert.equal(secondBody.version, firstBody.version);
  assert.equal(fetches, 1);
  assert.equal(store.writes, 1);
  assert.equal(store.lastOptions.onlyIfNew, true);
});

test('durable-storage write failure stays visible throughout the memory-cache interval', async () => {
  const memory = {
    value: null,
    storedAt: 0,
    lastAttemptAt: 0,
    lastFailureReason: '',
    storageWarning: ''
  };
  const store = {
    async getWithMetadata() { return null; },
    async get() { return null; },
    async set() { throw new Error('storage unavailable'); }
  };
  const dependencies = serviceDependencies({ store, memory });
  const first = await handleM1Schedule(new Request(previewUrl), dependencies);
  const firstBody = await first.json();
  const second = await handleM1Schedule(new Request(previewUrl), {
    ...dependencies,
    now: now + 1_000
  });
  const secondBody = await second.json();
  assert.equal(firstBody.current, true);
  assert.equal(firstBody.status.reason, null);
  assert.equal(firstBody.status.storageWarning, 'last-known-good-storage-not-updated');
  assert.equal(secondBody.status.storageWarning, 'last-known-good-storage-not-updated');
});

test('a durable CAS loser serves the concurrently persisted winner, never its losing candidate', async () => {
  const oldPayload = replaceRendered(
    '6:30 PM BJJ Sweeps Class (Level 3)',
    '6:30 PM BJJ Old Passing Class (Level 3)'
  );
  oldPayload[0].modified_gmt = '2026-08-09T10:58:26';
  oldPayload[0].modified = '2026-08-09T06:58:26';
  const oldSchedule = scheduleFromWordPressPayload(
    oldPayload,
    new Date(now - REFRESH_INTERVAL_MS - 1).toISOString()
  );
  const winnerPayload = replaceRendered(
    '6:30 PM BJJ Sweeps Class (Level 3)',
    '6:30 PM BJJ New Passing Class (Level 3)'
  );
  winnerPayload[0].modified_gmt = '2026-08-11T20:30:00';
  winnerPayload[0].modified = '2026-08-11T16:30:00';
  const winner = scheduleFromWordPressPayload(winnerPayload, new Date(now).toISOString());
  const store = new MemoryStore(oldSchedule);
  store.set = async () => {
    store.value = winner;
    store.etag = '"concurrent-winner"';
    return { modified: false };
  };

  const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({ store }));
  const body = await response.json();
  assert.equal(body.version, winner.version);
  assert.equal(body.status.reason, 'concurrent-refresh-winner');
  assert.equal(body.status.storageWarning, null);
});

test('a newer CAS loser stays in memory when the durable conflict winner is older', async () => {
  const oldPayload = replaceRendered(
    '6:30 PM BJJ Sweeps Class (Level 3)',
    '6:30 PM BJJ Old Passing Class (Level 3)'
  );
  oldPayload[0].modified_gmt = '2026-08-09T10:58:26';
  oldPayload[0].modified = '2026-08-09T06:58:26';
  const oldSchedule = scheduleFromWordPressPayload(
    oldPayload,
    new Date(now - REFRESH_INTERVAL_MS - 1).toISOString()
  );
  const store = new MemoryStore(oldSchedule);
  store.set = async () => ({ modified: false });

  const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({ store }));
  const body = await response.json();
  const current = scheduleFromWordPressPayload(fixture, new Date(now).toISOString());
  assert.equal(body.version, current.version);
  assert.notEqual(body.version, oldSchedule.version);
  assert.equal(body.status.reason, null);
  assert.equal(body.status.storageWarning, 'last-known-good-storage-not-updated');
});

test('newer validated memory never regresses to an older durable record after a failed write', async () => {
  const oldPayload = replaceRendered(
    '6:30 PM BJJ Sweeps Class (Level 3)',
    '6:30 PM BJJ Old Passing Class (Level 3)'
  );
  oldPayload[0].modified_gmt = '2026-08-09T10:58:26';
  oldPayload[0].modified = '2026-08-09T06:58:26';
  const oldSchedule = scheduleFromWordPressPayload(
    oldPayload,
    new Date(now - (REFRESH_INTERVAL_MS * 2)).toISOString()
  );
  const store = new MemoryStore(oldSchedule);
  store.set = async () => { throw new Error('storage unavailable'); };
  const memory = {
    value: null,
    storedAt: 0,
    lastAttemptAt: 0,
    lastFailureReason: '',
    storageWarning: ''
  };

  const first = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    store,
    memory,
    fetchImpl: async () => sourceResponse()
  }));
  const firstBody = await first.json();
  assert.equal(firstBody.current, true);
  assert.notEqual(firstBody.version, oldSchedule.version);

  const second = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    now: now + REFRESH_INTERVAL_MS + 1,
    store,
    memory,
    fetchImpl: async () => { throw new DOMException('timeout', 'AbortError'); }
  }));
  const secondBody = await second.json();
  assert.equal(secondBody.version, firstBody.version);
  assert.equal(secondBody.fallback, 'last-known-good');
  assert.equal(secondBody.status.reason, 'network-timeout');
  assert.equal(secondBody.status.storageWarning, 'last-known-good-storage-not-updated');
});

test('cumulative website drift is bounded by the fixed checked-in approval anchor', async () => {
  const approvedDays = scheduleFromWordPressPayload(fixture).days;
  const approvedLabels = new Set(Object.values(approvedDays).flat());
  const firstDrift = replaceSchedulePartition(approvedDays, 0);
  const secondDrift = replaceSchedulePartition(firstDrift, 1);

  assert.doesNotThrow(() => validatePlausibleScheduleTransition(firstDrift, approvedDays));
  assert.doesNotThrow(() => validatePlausibleScheduleTransition(secondDrift, firstDrift));
  errorCode(
    () => validatePlausibleScheduleTransition(secondDrift, approvedDays),
    'unexpected-schedule-churn'
  );

  const store = new MemoryStore();
  const memory = {
    value: null,
    storedAt: 0,
    lastAttemptAt: 0,
    lastFailureReason: '',
    storageWarning: '',
    currentReason: ''
  };
  const firstResponse = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    store,
    memory,
    fetchImpl: async () => sourceResponse(payloadFromDays(firstDrift, '2026-08-11T20:30:00'))
  }));
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.current, true);
  assert.equal(firstBody.fallback, 'none');
  assert.equal(
    Object.values(firstBody.days).flat().filter(label => approvedLabels.has(label)).length,
    39
  );

  const secondResponse = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    now: now + REFRESH_INTERVAL_MS + 1,
    store,
    memory,
    fetchImpl: async () => sourceResponse(payloadFromDays(secondDrift, '2026-08-11T20:35:00'))
  }));
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.current, false);
  assert.equal(secondBody.fallback, 'last-known-good');
  assert.equal(secondBody.status.reason, 'unexpected-schedule-churn');
  assert.equal(secondBody.contentHash, firstBody.contentHash);
  assert.equal(store.writes, 1);
  assert.equal(store.value.contentHash, firstBody.contentHash);
});

test('an exact approved anchor restores a legacy last-known-good with excessive drift', async () => {
  const approvedDays = scheduleFromWordPressPayload(fixture).days;
  const driftedDays = replaceEveryClass(approvedDays);
  errorCode(
    () => validatePlausibleScheduleTransition(approvedDays, driftedDays),
    'unexpected-schedule-churn'
  );
  const driftedSchedule = scheduleFromWordPressPayload(
    payloadFromDays(driftedDays, '2026-08-11T20:30:00'),
    '2026-08-11T20:31:00.000Z'
  );
  const restoredPayload = payloadFromDays(approvedDays, '2026-08-11T20:40:00');
  const approvedSchedule = scheduleFromWordPressPayload(
    restoredPayload,
    new Date(now).toISOString()
  );
  const store = new MemoryStore(driftedSchedule);

  const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    store,
    fetchImpl: async () => sourceResponse(restoredPayload)
  }));
  const body = await response.json();
  assert.equal(body.current, true);
  assert.equal(body.fallback, 'none');
  assert.equal(body.contentHash, approvedSchedule.contentHash);
  assert.equal(store.writes, 1);
  assert.equal(store.value.contentHash, approvedSchedule.contentHash);
});

test('failed refresh retains durable last known good and exposes fallback status', async () => {
  const current = scheduleFromWordPressPayload(fixture, new Date(now - REFRESH_INTERVAL_MS - 1).toISOString());
  const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    store: new MemoryStore(current),
    fetchImpl: async () => { throw new DOMException('timeout', 'AbortError'); }
  }));
  const body = await response.json();
  assert.equal(body.version, current.version);
  assert.equal(body.current, false);
  assert.equal(body.fallback, 'last-known-good');
  assert.equal(body.status.reason, 'network-timeout');
});

test('older, conflicting, and implausibly truncated refreshes cannot replace last known good', async () => {
  const current = scheduleFromWordPressPayload(
    fixture,
    new Date(now - REFRESH_INTERVAL_MS - 1).toISOString()
  );
  const cases = [];

  const older = clone(fixture);
  older[0].modified_gmt = '2026-08-09T10:58:26';
  older[0].modified = '2026-08-09T06:58:26';
  cases.push([older, 'stale-upstream']);

  const conflicting = replaceRendered(
    '6:30 PM BJJ Sweeps Class (Level 3)',
    '6:30 PM BJJ Passing Class (Level 3)'
  );
  cases.push([conflicting, 'conflicting-upstream-version']);

  const counts = { Monday: 6, Tuesday: 6, Wednesday: 5, Thursday: 6, Friday: 3, Saturday: 2, Sunday: 2 };
  const truncatedDays = Object.fromEntries(
    Object.entries(current.days).map(([day, labels]) => [day, labels.slice(0, counts[day])])
  );
  const truncated = payloadFromDays(truncatedDays);
  assert.equal(Object.values(scheduleFromWordPressPayload(truncated).days).flat().length, 30);
  cases.push([truncated, 'unexpected-schedule-drop']);

  for (const [payload, reason] of cases) {
    const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
      store: new MemoryStore(current),
      fetchImpl: async () => sourceResponse(payload)
    }));
    const body = await response.json();
    assert.equal(body.version, current.version, reason);
    assert.equal(body.fallback, 'last-known-good', reason);
    assert.equal(body.status.reason, reason);
  }
});

test('no server last known good falls back to the validated checked-in bootstrap', async () => {
  const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    store: new MemoryStore(),
    fetchImpl: async () => sourceResponse({}, { status: 503 })
  }));
  const body = await response.json();
  assert.equal(body.current, false);
  assert.equal(body.fallback, 'bootstrap');
  assert.equal(body.source.type, 'checked-in-bootstrap');
  assert.equal(Object.values(body.days).flat().length, 55);
});

test('fresh durable schedule prevents unnecessary upstream requests on a cold instance', async () => {
  const current = scheduleFromWordPressPayload(fixture, new Date(now - 1_000).toISOString());
  let fetches = 0;
  const response = await handleM1Schedule(new Request(previewUrl), serviceDependencies({
    store: new MemoryStore(current),
    fetchImpl: async () => { fetches += 1; return sourceResponse(); }
  }));
  assert.equal(response.status, 200);
  assert.equal(fetches, 0);
});

test('Deploy Previews use deploy-specific storage, never the production-wide store', async () => {
  const calls = [];
  const deployStore = new MemoryStore();
  const siteStore = new MemoryStore();
  const blobs = {
    getDeployStore(options) {
      calls.push(['deploy', options]);
      return deployStore;
    },
    getStore(options) {
      calls.push(['site', options]);
      return siteStore;
    }
  };
  const common = {
    now,
    env: {},
    blobs,
    memory: { value: null, storedAt: 0, lastAttemptAt: 0, lastFailureReason: '' },
    fetchImpl: async () => sourceResponse()
  };
  await handleM1Schedule(new Request(previewUrl), {
    ...common,
    deployContext: 'deploy-preview',
    published: false
  });
  assert.deepEqual(calls.map(call => call[0]), ['deploy']);

});

test('an approved published production context alone selects the site-wide durable store', async () => {
  const calls = [];
  const blobs = {
    getDeployStore() {
      calls.push('deploy');
      return new MemoryStore();
    },
    getStore() {
      calls.push('site');
      return new MemoryStore();
    }
  };
  const response = await handleM1Schedule(
    new Request('https://gib-live.netlify.app/api/m1-schedule'),
    {
      now,
      deployContext: 'production',
      published: true,
      env: { GIB_M1_WEBSITE_SCHEDULE_PRODUCTION_ENABLED: 'true' },
      blobs,
      memory: { value: null, storedAt: 0, lastAttemptAt: 0, lastFailureReason: '' },
      fetchImpl: async () => sourceResponse()
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['site']);
});

test('schedule endpoint enforces its exact same-origin read-only boundary', async () => {
  assert.equal(validScheduleRequest(new Request(previewUrl)), true);
  assert.equal(validScheduleRequest(new Request(`${previewUrl}?bust=1`)), false);
  assert.equal(validScheduleRequest(new Request(
    previewUrl,
    { headers: { Origin: 'https://evil.example' } }
  )), false);
  const direct = await handleM1Schedule(
    new Request('https://deploy-preview-99--gib-live.netlify.app/.netlify/functions/m1-schedule'),
    serviceDependencies()
  );
  assert.equal(direct.status, 404);
  const post = await handleM1Schedule(new Request(previewUrl, { method: 'POST' }), serviceDependencies());
  assert.equal(post.status, 405);
});

test('production stays disabled until a separately approved production enablement', async () => {
  const response = await handleM1Schedule(
    new Request('https://gib-live.netlify.app/api/m1-schedule'),
    serviceDependencies({ deployContext: 'production', published: true, env: {} })
  );
  assert.equal(response.status, 503);
  assert.match(await response.text(), /not enabled in this deployment/i);
});

test('branch, development, preview-server, custom, and unknown contexts stay disabled', async () => {
  for (const deployContext of ['branch-deploy', 'dev', 'preview-server', 'custom-branch', 'unknown']) {
    const response = await handleM1Schedule(
      new Request(previewUrl),
      serviceDependencies({ deployContext })
    );
    assert.equal(response.status, 503, deployContext);
  }
});

test('a preview-shaped hostname cannot substitute for an authoritative deploy context', async () => {
  const response = await handleM1Schedule(new Request(previewUrl), {
    now,
    env: {},
    published: false,
    memory: { value: null, storedAt: 0, lastAttemptAt: 0, lastFailureReason: '' },
    store: new MemoryStore(),
    fetchImpl: async () => sourceResponse()
  });
  assert.equal(response.status, 503);
});

test('only the PR alias and immutable deploy-id hosts are accepted for a Deploy Preview', async () => {
  const immutable = '6a29d32eaf2462ac0763b1ab--gib-live.netlify.app';
  const good = await handleM1Schedule(
    new Request(`https://${immutable}/api/m1-schedule`),
    serviceDependencies()
  );
  assert.equal(good.status, 200);
  for (const host of ['evil.example', 'branch-name--gib-live.netlify.app', 'gib-live.netlify.app']) {
    const response = await handleM1Schedule(
      new Request(`https://${host}/api/m1-schedule`),
      serviceDependencies()
    );
    assert.equal(response.status, 503, host);
  }
});
