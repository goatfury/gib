import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RICHMOND_PUBLIC_SCHEDULE_URL,
  RICHMOND_SCHEDULE_BLOCK_ID,
  parseRichmondScheduleHtml,
  scheduleFromRichmondHtml,
  validateRichmondTransition
} from '../netlify/functions/_lib/m1-richmond-schedule-core.mjs';
import {
  fetchRichmondCurrentSchedule,
  handleRichmondSchedule,
  resetRichmondScheduleMemoryForTests
} from '../netlify/functions/_lib/m1-richmond-schedule.mjs';

const OFFICIAL_LINES = Object.freeze({
  Monday: [
    '6:00-7:00AM - Muay Thai Fundamentals',
    '7:00-8:00AM - Brazilian Jiu-Jitsu No-Gi',
    '6:00-7:00PM - Muay Thai Fundamentals',
    '7:15-9:00PM - Brazilian Jiu-Jitsu Fundamentals'
  ],
  Tuesday: [
    '6:00-7:00AM - Muay Thai Mixed Levels',
    '7:00-8:00AM - Brazilian Jiu-Jitsu Gi',
    '6:00-7:00PM - Muay Thai Mixed Levels',
    '7:15-9:00PM - Brazilian Jiu-Jitsu Mixed Levels'
  ],
  Wednesday: [
    '6:00-7:00AM - Muay Thai Fundamentals',
    '7:00-8:00AM - Brazilian Jiu-Jitsu No-Gi',
    '6:00-7:00PM - Muay Thai Fundamentals',
    '7:15-9:00PM - Brazilian Jiu-Jitsu No-Gi Fundamentals'
  ],
  Thursday: [
    '6:00-7:00AM - Muay Thai Mixed Levels',
    '7:00-8:00AM - Brazilian Jiu-Jitsu Gi',
    '6:00-7:00PM - Muay Thai Mixed Levels',
    '7:15-9:00PM - Brazilian Jiu-Jitsu Mixed Levels'
  ],
  Friday: [
    '6:00-7:00AM - Muay Thai Fundamentals',
    '7:00-8:00AM - Brazilian Jiu-Jitsu No-Gi',
    '6:00-7:00PM - Muay Thai Open Mat',
    '7:15-9:00PM - Brazilian Jiu-Jitsu Fundamentals'
  ],
  Saturday: [
    '10:00-11:00AM - Muay Thai Fundamentals',
    '11:15-1:00PM -  Brazilian Jiu-Jitsu Fundamentals'
  ],
  Sunday: ['10:00-11:00AM - Ladies Muay Thai']
});

function officialHtml(extra = '') {
  const paragraphs = Object.entries(OFFICIAL_LINES).flatMap(([day, lines]) => [
    `<p class=""><strong>${day}</strong></p>`,
    ...lines.map(line => `<p class="">${line}</p>`)
  ]).join('');
  return `<!doctype html><html><body><div class="sqs-block html-block" id="${RICHMOND_SCHEDULE_BLOCK_ID}"><div class="sqs-block-content"><div class="sqs-text-block-container"><div class="sqs-html-content">${paragraphs}${extra}</div></div><style>.safe { color: black; }</style></div></div></body></html>`;
}

function scheduleRequest(host = 'gib-richmond-test.netlify.app', method = 'GET') {
  const origin = `https://${host}`;
  return new Request(`${origin}/api/m1-schedule`, {
    method,
    headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }
  });
}

class MemoryStore {
  constructor(value = null) {
    this.value = value;
    this.etag = value ? 'stored-etag' : '';
  }

  async getWithMetadata() {
    return this.value ? { data: this.value, etag: this.etag, metadata: {} } : null;
  }

  async get() {
    return this.value;
  }

  async set(_key, text, options = {}) {
    if (options.onlyIfNew && this.value) return { modified: false };
    if (options.onlyIfMatch && options.onlyIfMatch !== this.etag) return { modified: false };
    this.value = JSON.parse(text);
    this.etag = `etag-${this.value.contentHash.slice(0, 8)}`;
    return { modified: true, etag: this.etag };
  }
}

test('the official Richmond HTML shape parses all 23 classes and resolves the Saturday AM ambiguity', () => {
  const days = parseRichmondScheduleHtml(officialHtml());
  assert.deepEqual(
    Object.fromEntries(Object.entries(days).map(([day, classes]) => [day, classes.length])),
    { Monday: 4, Tuesday: 4, Wednesday: 4, Thursday: 4, Friday: 4, Saturday: 2, Sunday: 1 }
  );
  assert.equal(Object.values(days).flat().length, 23);
  assert.deepEqual(days.Saturday, [
    '10:00 AM–11:00 AM Muay Thai Fundamentals',
    '11:15 AM–1:00 PM Brazilian Jiu-Jitsu Fundamentals'
  ]);
});

test('the parser isolates the named Squarespace content and rejects executable markup inside it', () => {
  assert.doesNotThrow(() => parseRichmondScheduleHtml(officialHtml()));
  assert.throws(
    () => parseRichmondScheduleHtml(officialHtml('<script>alert(1)</script>')),
    error => error?.code === 'executable-or-unexpected-markup'
  );
});

test('ordinary Richmond schedule changes pass while implausible replacement fails closed', () => {
  const current = parseRichmondScheduleHtml(officialHtml());
  const ordinary = structuredClone(current);
  ordinary.Monday.push('12:00 PM–1:00 PM QA TEST Open Mat');
  assert.doesNotThrow(() => validateRichmondTransition(ordinary, current));
  const replacement = Object.fromEntries(Object.entries(current).map(([day, classes]) => [
    day,
    classes.map((label, index) => label.replace(
      /(AM|PM)\s+.+$/u,
      `$1 QA TEST Replacement ${day} ${index}`
    ))
  ]));
  assert.throws(
    () => validateRichmondTransition(replacement, current),
    error => error?.code === 'unexpected-schedule-churn'
  );
});

test('Richmond schedule service publishes current official data and persists last known good', async () => {
  resetRichmondScheduleMemoryForTests();
  const store = new MemoryStore();
  const now = Date.parse('2026-08-21T16:00:00.000Z');
  const response = await handleRichmondSchedule(scheduleRequest(), {
    now,
    store,
    fetchImpl: async url => {
      assert.equal(url, RICHMOND_PUBLIC_SCHEDULE_URL);
      return new Response(officialHtml(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"richmond-v1"' }
      });
    }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.current, true);
  assert.equal(body.fallback, 'none');
  assert.equal(body.source.type, 'squarespace-html');
  assert.equal(body.source.url, RICHMOND_PUBLIC_SCHEDULE_URL);
  assert.equal(Object.values(body.days).flat().length, 23);
  assert.equal(store.value.contentHash, body.contentHash);
});

test('a failed refresh serves only Richmond last known good, then the checked-in Richmond bootstrap', async () => {
  const now = Date.parse('2026-08-21T16:00:00.000Z');
  const previous = scheduleFromRichmondHtml(officialHtml(), new Date(now).toISOString(), '"old"');
  resetRichmondScheduleMemoryForTests();
  const storedResponse = await handleRichmondSchedule(scheduleRequest(), {
    now: now + 16 * 60 * 1_000,
    store: new MemoryStore(previous),
    fetchImpl: async () => { throw new Error('offline'); }
  });
  const storedBody = await storedResponse.json();
  assert.equal(storedBody.current, false);
  assert.equal(storedBody.fallback, 'last-known-good');
  assert.equal(storedBody.contentHash, previous.contentHash);
  assert.equal(storedBody.site, 'Richmond');

  resetRichmondScheduleMemoryForTests();
  const bootstrapResponse = await handleRichmondSchedule(scheduleRequest(), {
    now: now + 16 * 60 * 1_000,
    store: new MemoryStore(),
    fetchImpl: async () => { throw new Error('offline'); }
  });
  const bootstrapBody = await bootstrapResponse.json();
  assert.equal(bootstrapBody.current, false);
  assert.equal(bootstrapBody.fallback, 'bootstrap');
  assert.equal(bootstrapBody.source.type, 'checked-in-bootstrap');
  assert.equal(bootstrapBody.source.url, RICHMOND_PUBLIC_SCHEDULE_URL);
  assert.equal(bootstrapBody.site, 'Richmond');
});

test('Richmond schedule endpoint rejects every non-Richmond host before the upstream request', async () => {
  resetRichmondScheduleMemoryForTests();
  let fetchCalls = 0;
  const response = await handleRichmondSchedule(scheduleRequest('gib-live.netlify.app'), {
    store: new MemoryStore(),
    fetchImpl: async () => { fetchCalls += 1; return new Response(officialHtml()); }
  });
  assert.equal(response.status, 404);
  assert.equal(fetchCalls, 0);
});

test('an official 304 keeps the same Richmond schedule and refreshes its fetch time', async () => {
  const previous = scheduleFromRichmondHtml(officialHtml(), '2026-08-21T16:00:00.000Z', '"old"');
  const next = await fetchRichmondCurrentSchedule(
    async (_url, options) => {
      assert.equal(options.headers['If-None-Match'], '"old"');
      return new Response(null, { status: 304 });
    },
    Date.parse('2026-08-21T16:16:00.000Z'),
    previous
  );
  assert.equal(next.contentHash, previous.contentHash);
  assert.equal(next.fetchedAt, '2026-08-21T16:16:00.000Z');
});
