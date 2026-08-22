import { createHash } from 'node:crypto';

export const RICHMOND_SCHEDULE_DAYS = Object.freeze([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
]);
export const RICHMOND_SCHEDULE_TIME_ZONE = 'America/New_York';
export const RICHMOND_SCHEDULE_SITE = 'Richmond';
export const RICHMOND_PUBLIC_SCHEDULE_URL = 'https://www.richmondbjj.com/schedule';
export const RICHMOND_SCHEDULE_BLOCK_ID = 'block-885f8d1ae3f423380aba';
export const RICHMOND_MAX_UPSTREAM_BYTES = 1_500_000;

export class RichmondScheduleSourceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RichmondScheduleSourceError';
    this.code = code;
  }
}

function fail(code) {
  throw new RichmondScheduleSourceError(code);
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
  return String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/giu, (_entity, token) => {
    if (token[0] !== '#') {
      if (!Object.hasOwn(named, token.toLowerCase())) fail('unexpected-entity');
      return named[token.toLowerCase()];
    }
    const hexadecimal = token[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
      fail('unexpected-entity');
    }
    return String.fromCodePoint(codePoint);
  });
}

export function normalizeRichmondLabel(value) {
  return String(value == null ? '' : value)
    .normalize('NFC')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, ' ')
    .replace(/[\t\r\n ]+/gu, ' ')
    .trim();
}

function minutesFor(hour, minute, period) {
  return (hour % 12) * 60 + minute + (period === 'PM' ? 720 : 0);
}

function canonicalTime(hour, minute, period) {
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

export function normalizeRichmondClassLine(value) {
  const text = normalizeRichmondLabel(decodeHtmlEntities(value));
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(.+)$/iu.exec(text);
  if (!match) fail('invalid-class-line');
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  const endPeriod = match[5].toUpperCase();
  const className = normalizeRichmondLabel(match[6]);
  if (
    startHour < 1 || startHour > 12 || endHour < 1 || endHour > 12
    || startMinute > 59 || endMinute > 59
    || !className || className.length > 160
    || /[\u0000-\u001f\u007f-\u009f<>]/u.test(className)
  ) fail('invalid-class-line');

  const candidates = [endPeriod, endPeriod === 'AM' ? 'PM' : 'AM']
    .map(startPeriod => {
      const start = minutesFor(startHour, startMinute, startPeriod);
      const end = minutesFor(endHour, endMinute, endPeriod);
      const duration = end >= start ? end - start : end + 1440 - start;
      return { startPeriod, duration };
    })
    .filter(candidate => candidate.duration > 0 && candidate.duration <= 4 * 60);
  if (candidates.length !== 1) fail('ambiguous-class-time');
  const startPeriod = candidates[0].startPeriod;
  return `${canonicalTime(startHour, startMinute, startPeriod)}–${canonicalTime(endHour, endMinute, endPeriod)} ${className}`;
}

function closedDiv(html, start) {
  const tags = /<\/?div\b[^>]*>/giu;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(html))) {
    depth += /^<div\b/iu.test(match[0]) ? 1 : -1;
    if (depth === 0) {
      if (tags.lastIndex - start > 100_000) fail('schedule-block-too-large');
      return html.slice(start, tags.lastIndex);
    }
    if (depth < 0 || tags.lastIndex - start > 100_000) break;
  }
  fail('schedule-block-not-closed');
}

function scheduleBlock(html) {
  const exactIndex = html.indexOf(`id="${RICHMOND_SCHEDULE_BLOCK_ID}"`);
  if (exactIndex >= 0) {
    const outerStart = html.lastIndexOf('<div', exactIndex);
    if (outerStart < 0) fail('schedule-block-not-closed');
    const outer = closedDiv(html, outerStart);
    const contentTags = [...outer.matchAll(
      /<div\b[^>]*class=(?:"[^"]*\bsqs-html-content\b[^"]*"|'[^']*\bsqs-html-content\b[^']*')[^>]*>/giu
    )];
    if (contentTags.length !== 1) fail('schedule-content-not-unique');
    return closedDiv(outer, contentTags[0].index);
  }
  const candidates = [...html.matchAll(/<div\b[^>]*class=(?:"[^"]*sqs-html-content[^"]*"|'[^']*sqs-html-content[^']*')[^>]*>([\s\S]*?)<\/div>/giu)]
    .map(match => match[1])
    .filter(block => RICHMOND_SCHEDULE_DAYS.every(day => new RegExp(`<strong>\\s*${day}\\s*<\\/strong>`, 'iu').test(block)));
  if (candidates.length !== 1) fail('schedule-block-not-unique');
  return candidates[0];
}

export function validateRichmondDays(days) {
  if (!days || typeof days !== 'object' || Array.isArray(days)) fail('invalid-schedule-object');
  const keys = Object.keys(days);
  if (keys.length !== 7 || keys.some(key => !RICHMOND_SCHEDULE_DAYS.includes(key))) {
    fail('missing-or-extra-weekday');
  }
  let total = 0;
  const normalized = {};
  for (const day of RICHMOND_SCHEDULE_DAYS) {
    if (!Array.isArray(days[day]) || days[day].length < 1 || days[day].length > 12) {
      fail('empty-partial-or-oversized-day');
    }
    const seen = new Set();
    normalized[day] = days[day].map(value => {
      const label = normalizeRichmondLabel(value);
      if (
        label.length > 200
        || !/^(?:1[0-2]|[1-9]):[0-5]\d\s+(?:AM|PM)–(?:1[0-2]|[1-9]):[0-5]\d\s+(?:AM|PM)\s+\S/u.test(label)
        || /[\u0000-\u001f\u007f-\u009f<>]/u.test(label)
      ) fail('invalid-class-label');
      const key = label.normalize('NFKC').toLocaleLowerCase('en-US');
      if (seen.has(key)) fail('duplicate-class');
      seen.add(key);
      return label;
    });
    total += normalized[day].length;
  }
  if (total < 10 || total > 50) fail('implausible-class-count');
  return normalized;
}

export function parseRichmondScheduleHtml(html) {
  if (
    typeof html !== 'string'
    || !html
    || Buffer.byteLength(html, 'utf8') > RICHMOND_MAX_UPSTREAM_BYTES
  ) fail('oversized-or-empty-upstream');
  const block = scheduleBlock(html);
  if (/<\/?(?:script|style|iframe|object|embed|svg|form|input|button|textarea|select|template)\b|\son[a-z]+\s*=|\b(?:javascript|data)\s*:/iu.test(block)) {
    fail('executable-or-unexpected-markup');
  }
  const paragraphs = [...block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/giu)].map(match => match[1]);
  if (paragraphs.length < 17 || paragraphs.length > 60) fail('unexpected-markup-shape');
  const collected = {};
  let currentDay = '';
  let dayIndex = 0;
  for (const rawParagraph of paragraphs) {
    const heading = /^\s*<strong>\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*<\/strong>\s*:?\s*$/iu.exec(rawParagraph);
    if (heading) {
      const day = RICHMOND_SCHEDULE_DAYS.find(value => value.toLowerCase() === heading[1].toLowerCase());
      if (!day || day !== RICHMOND_SCHEDULE_DAYS[dayIndex] || collected[day]) fail('unexpected-weekday-order');
      collected[day] = [];
      currentDay = day;
      dayIndex += 1;
      continue;
    }
    const withoutBreaks = rawParagraph.replace(/<br\s*\/?>/giu, ' ');
    if (/<[^>]+>/u.test(withoutBreaks)) continue;
    const text = normalizeRichmondLabel(decodeHtmlEntities(withoutBreaks));
    if (!text || !/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s*-/iu.test(text)) continue;
    if (!currentDay) fail('class-before-weekday');
    collected[currentDay].push(normalizeRichmondClassLine(text));
  }
  if (dayIndex !== 7) fail('missing-or-extra-weekday');
  return validateRichmondDays(collected);
}

export function richmondContentHash(days) {
  return createHash('sha256')
    .update(JSON.stringify(validateRichmondDays(days)), 'utf8')
    .digest('hex');
}

export function scheduleFromRichmondHtml(html, fetchedAt = new Date().toISOString(), etag = '') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(fetchedAt)) fail('invalid-fetched-time');
  const days = parseRichmondScheduleHtml(html);
  const contentHash = richmondContentHash(days);
  return {
    timezone: RICHMOND_SCHEDULE_TIME_ZONE,
    site: RICHMOND_SCHEDULE_SITE,
    version: `richmondbjj-${contentHash.slice(0, 16)}`,
    contentHash,
    days,
    source: {
      url: RICHMOND_PUBLIC_SCHEDULE_URL,
      upstreamUrl: RICHMOND_PUBLIC_SCHEDULE_URL,
      type: 'squarespace-html',
      pageId: null,
      modifiedAt: fetchedAt,
      etag: String(etag || '').slice(0, 240)
    },
    fetchedAt
  };
}

export function validateRichmondTransition(nextDays, previousDays) {
  const next = validateRichmondDays(nextDays);
  const previous = validateRichmondDays(previousDays);
  const nextTotal = Object.values(next).flat().length;
  const previousTotal = Object.values(previous).flat().length;
  if (nextTotal < Math.ceil(previousTotal * 0.6)) fail('unexpected-schedule-drop');
  if (nextTotal > Math.ceil(previousTotal * 1.4)) fail('unexpected-schedule-growth');
  let retained = 0;
  const previousLabels = new Set(Object.values(previous).flat().map(label => label.normalize('NFKC').toLowerCase()));
  for (const day of RICHMOND_SCHEDULE_DAYS) {
    if (next[day].length < Math.ceil(previous[day].length * 0.5)) fail('unexpected-schedule-drop');
    if (next[day].length > previous[day].length + 3) fail('unexpected-schedule-growth');
    retained += next[day].filter(label => previousLabels.has(label.normalize('NFKC').toLowerCase())).length;
  }
  if (retained < Math.ceil(previousTotal * 0.5)) fail('unexpected-schedule-churn');
  return next;
}
