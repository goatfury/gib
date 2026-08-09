import { createHash } from 'node:crypto';

export const SCHEDULE_DAYS = Object.freeze([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
]);

export const SCHEDULE_TIME_ZONE = 'America/New_York';
export const SCHEDULE_SITE = 'Rev';
export const PUBLIC_SCHEDULE_URL = 'https://revolutionbjj.com/schedule/';
export const WORDPRESS_SCHEDULE_URL = 'https://revolutionbjj.com/wp-json/wp/v2/pages?slug=schedule&status=publish&_fields=id,type,slug,status,link,title,modified,modified_gmt,content';
export const MAX_UPSTREAM_BYTES = 128_000;
export const MAX_CLASS_LABEL_LENGTH = 240;
export const MAX_CLASSES_PER_DAY = 24;
export const MIN_TOTAL_CLASSES = 30;
export const MAX_TOTAL_CLASSES = 100;
export const MAX_SOURCE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const MIN_CLASSES_BY_DAY = Object.freeze({
  Monday: 5,
  Tuesday: 5,
  Wednesday: 5,
  Thursday: 5,
  Friday: 2,
  Saturday: 2,
  Sunday: 1
});

export class ScheduleSourceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ScheduleSourceError';
    this.code = code;
  }
}

function fail(code) {
  throw new ScheduleSourceError(code);
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    quot: '"',
    rsquo: '’',
    lsquo: '‘'
  };
  return String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, token) => {
    if (token[0] !== '#') {
      const decoded = named[token.toLowerCase()];
      if (decoded == null) fail('unexpected-entity');
      return decoded;
    }
    const hexadecimal = token[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
      fail('unexpected-entity');
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      fail('unexpected-entity');
    }
  });
}

export function normalizeClassLabel(value) {
  return String(value == null ? '' : value)
    .normalize('NFC')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, ' ')
    .replace(/[\t\r\n ]+/gu, ' ')
    .trim();
}

export function comparisonLabel(value) {
  return normalizeClassLabel(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/\s*\/\s*/gu, '/')
    .replace(/\s+/gu, ' ');
}

export function validatePlausibleScheduleTransition(nextDays, previousDays) {
  const next = normalizeAndValidateDays(nextDays);
  const previous = normalizeAndValidateDays(previousDays);
  const nextTotal = Object.values(next).reduce((sum, values) => sum + values.length, 0);
  const previousTotal = Object.values(previous).reduce((sum, values) => sum + values.length, 0);
  if (nextTotal < Math.ceil(previousTotal * 0.7)) fail('unexpected-schedule-drop');
  for (const day of SCHEDULE_DAYS) {
    if (next[day].length < Math.ceil(previous[day].length * 0.5)) {
      fail('unexpected-schedule-drop');
    }
  }
  return next;
}

export function startMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})\s+(AM|PM)\b/i.exec(normalizeClassLabel(value));
  if (!match) return Number.POSITIVE_INFINITY;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return Number.POSITIVE_INFINITY;
  return (hour % 12) * 60 + minute + (match[3].toUpperCase() === 'PM' ? 720 : 0);
}

function safePlainLabel(value) {
  const label = normalizeClassLabel(value);
  if (
    !label
    || label.length > MAX_CLASS_LABEL_LENGTH
    || Buffer.byteLength(label, 'utf8') > MAX_CLASS_LABEL_LENGTH * 4
    || /[\u0000-\u001f\u007f-\u009f<>]/u.test(label)
    || /\p{Cf}/u.test(label)
    || /\b(?:javascript|data)\s*:/iu.test(label)
    || /\bon[a-z]+\s*=/iu.test(label)
    || !/^(?:1[0-2]|[1-9]):[0-5]\d\s+(?:AM|PM)\b/u.test(label)
  ) {
    fail('invalid-class-label');
  }
  return label;
}

export function normalizeAndValidateDays(days) {
  if (!days || typeof days !== 'object' || Array.isArray(days)) fail('invalid-schedule-object');
  const keys = Object.keys(days);
  if (keys.length !== SCHEDULE_DAYS.length || keys.some(key => !SCHEDULE_DAYS.includes(key))) {
    fail('missing-or-extra-weekday');
  }

  let total = 0;
  const normalized = {};
  for (const day of SCHEDULE_DAYS) {
    const values = days[day];
    if (
      !Array.isArray(values)
      || values.length < MIN_CLASSES_BY_DAY[day]
      || values.length > MAX_CLASSES_PER_DAY
    ) {
      fail('empty-partial-or-oversized-day');
    }
    const seen = new Set();
    const sortable = values.map((value, index) => {
      if (typeof value !== 'string') fail('invalid-class-label');
      const label = safePlainLabel(value);
      const duplicateKey = comparisonLabel(label);
      if (seen.has(duplicateKey)) fail('duplicate-class');
      seen.add(duplicateKey);
      return { label, index, minutes: startMinutes(label) };
    });
    sortable.sort((left, right) => (
      left.minutes === right.minutes ? left.index - right.index : left.minutes - right.minutes
    ));
    normalized[day] = sortable.map(item => item.label);
    total += normalized[day].length;
  }
  if (total < MIN_TOTAL_CLASSES || total > MAX_TOTAL_CLASSES) fail('implausible-class-count');
  return normalized;
}

export function validateScheduleContract(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) fail('invalid-schedule-object');
  if (schedule.timezone !== SCHEDULE_TIME_ZONE || schedule.site !== SCHEDULE_SITE) {
    fail('invalid-schedule-scope');
  }
  return normalizeAndValidateDays(schedule.days);
}

export function contentHashForDays(days) {
  const canonicalDays = normalizeAndValidateDays(days);
  return createHash('sha256')
    .update(JSON.stringify(canonicalDays), 'utf8')
    .digest('hex');
}

export function parseScheduleHtml(renderedHtml) {
  if (
    typeof renderedHtml !== 'string'
    || !renderedHtml
    || Buffer.byteLength(renderedHtml, 'utf8') > MAX_UPSTREAM_BYTES
  ) {
    fail('oversized-or-empty-upstream');
  }
  if (
    /<!--|<\/?(?:script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|template)\b|\son[a-z]+\s*=|\b(?:javascript|data)\s*:/iu.test(renderedHtml)
    || /<[^>]*\s(?:hidden\b|aria-hidden\s*=|style\s*=)[^>]*>/iu.test(renderedHtml)
  ) {
    fail('executable-or-unexpected-markup');
  }
  for (const tag of renderedHtml.matchAll(/<\/?\s*([a-z][a-z0-9-]*)\b[^>]*>/giu)) {
    if (!['p', 'strong', 'br', 'a'].includes(tag[1].toLowerCase())) {
      fail('unexpected-markup-shape');
    }
  }

  const collected = {};
  const paragraphPattern = /<p\b([^>]*)>([\s\S]*?)<\/p\s*>/giu;
  const weekdayPattern = new RegExp(
    `^\\s*<strong>\\s*(${SCHEDULE_DAYS.join('|')})\\s*<\\/strong>\\s*:\\s*<br\\s*\\/?>\\s*([\\s\\S]*?)\\s*$`,
    'iu'
  );
  const anyWeekdayStrong = new RegExp(
    `<strong(?:\\s+[^>]*)?>\\s*(${SCHEDULE_DAYS.join('|')})\\s*<\\/strong>`,
    'iu'
  );
  const everyWeekdayStrong = new RegExp(
    `<strong(?:\\s+[^>]*)?>\\s*(${SCHEDULE_DAYS.join('|')})\\s*<\\/strong>`,
    'giu'
  );
  const alternateWeekdayHeading = new RegExp(
    `<(?:h[1-6]|th|dt|li)\\b[^>]*>\\s*(${SCHEDULE_DAYS.join('|')})\\b`,
    'iu'
  );
  if (alternateWeekdayHeading.test(renderedHtml)) fail('unexpected-markup-shape');
  if ([...renderedHtml.matchAll(everyWeekdayStrong)].length !== SCHEDULE_DAYS.length) {
    fail('unexpected-markup-shape');
  }
  let paragraphCount = 0;
  let topLevelCursor = 0;
  let paragraph;
  while ((paragraph = paragraphPattern.exec(renderedHtml)) !== null) {
    if (!/^\s*$/u.test(renderedHtml.slice(topLevelCursor, paragraph.index))) {
      fail('unexpected-markup-shape');
    }
    topLevelCursor = paragraphPattern.lastIndex;
    paragraphCount += 1;
    if (paragraphCount > 80) fail('unexpected-markup-shape');
    const attributes = paragraph[1].trim();
    const body = paragraph[2];
    const weekday = weekdayPattern.exec(body);
    if (!weekday) {
      if (anyWeekdayStrong.test(body)) fail('unexpected-markup-shape');
      continue;
    }
    if (!/^class=(?:"wp-block-paragraph"|'wp-block-paragraph')$/iu.test(attributes)) {
      fail('unexpected-markup-shape');
    }
    const day = SCHEDULE_DAYS.find(value => value.toLowerCase() === weekday[1].toLowerCase());
    if (!day || collected[day]) fail('duplicate-day-section');
    const rawLabels = weekday[2].split(/<br\s*\/?>/giu);
    collected[day] = rawLabels.map(rawLabel => {
      if (/<[^>]*>/u.test(rawLabel)) fail('unexpected-class-markup');
      return safePlainLabel(decodeHtmlEntities(rawLabel));
    });
  }
  if (!/^\s*$/u.test(renderedHtml.slice(topLevelCursor))) fail('unexpected-markup-shape');
  return normalizeAndValidateDays(collected);
}

export function scheduleFromWordPressPayload(payload, fetchedAt = new Date().toISOString()) {
  if (!Array.isArray(payload) || payload.length !== 1) fail('unexpected-wordpress-result');
  const page = payload[0];
  if (
    !page
    || typeof page !== 'object'
    || page.slug !== 'schedule'
    || page.type !== 'page'
    || page.status !== 'publish'
    || page.link !== PUBLIC_SCHEDULE_URL
    || page.title?.rendered !== 'Schedule'
    || !Number.isInteger(page.id)
    || page.content?.protected !== false
  ) {
    fail('unexpected-wordpress-page');
  }
  const modifiedAt = String(page.modified_gmt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(modifiedAt)) {
    fail('invalid-wordpress-modified-time');
  }
  const parsedModifiedAt = Date.parse(`${modifiedAt}Z`);
  if (!Number.isFinite(parsedModifiedAt) || new Date(parsedModifiedAt).toISOString().slice(0, 19) !== modifiedAt) {
    fail('invalid-wordpress-modified-time');
  }
  const parsedFetchedAt = Date.parse(fetchedAt);
  if (
    !Number.isFinite(parsedFetchedAt)
    || new Date(parsedFetchedAt).toISOString() !== fetchedAt
    || parsedModifiedAt > parsedFetchedAt + MAX_SOURCE_CLOCK_SKEW_MS
  ) {
    fail('future-wordpress-modified-time');
  }
  const days = parseScheduleHtml(page.content?.rendered);
  const contentHash = contentHashForDays(days);
  return {
    timezone: SCHEDULE_TIME_ZONE,
    site: SCHEDULE_SITE,
    version: `revbjj-${contentHash.slice(0, 16)}`,
    contentHash,
    days,
    source: {
      url: PUBLIC_SCHEDULE_URL,
      upstreamUrl: WORDPRESS_SCHEDULE_URL,
      type: 'wordpress-rest',
      pageId: page.id,
      modifiedAt: `${modifiedAt}Z`
    },
    fetchedAt
  };
}
