/* Shared by the kiosk, Daily Review, and the class service. No local-time date arithmetic. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GIBM1TemporaryClasses = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SCHEMA = 'gib-m1-added-classes/v1';
  const TIME_ZONE = 'America/New_York';
  const DAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  const DAY_MS = 86400000;
  function resolveAddedClassesTarget(profile, href) {
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
      if (profile?.installationId === 'rev') {
        if (url.hostname === 'gib-live.netlify.app') return 'production';
        return /^(?:deploy-preview-\d+|[0-9a-f]{24})--gib-live\.netlify\.app$/u.test(url.hostname) ? 'test' : '';
      }
      if (profile?.installationId !== 'richmond') return '';
      if (profile.environment === 'production') {
        return url.hostname === 'gib-richmond-live.netlify.app' ? 'production' : '';
      }
      if (profile.environment !== 'test') return '';
      return url.hostname === 'gib-richmond-test.netlify.app'
        || /^[0-9a-f]{24}--gib-richmond-test\.netlify\.app$/u.test(url.hostname) ? 'test' : '';
    } catch { return ''; }
  }
  function text(value) { return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : ''; }
  function validDate(value) {
    if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/u.test(value)) return false;
    const stamp = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
  }
  function dayNameForDate(value) { return validDate(value) ? DAYS[new Date(`${value}T12:00:00Z`).getUTCDay()] : ''; }
  function todayInGym(now = new Date(), timezone = TIME_ZONE) {
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch { return ''; }
  }
  function normalizeSeries(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // Display labels also select existing lesson-duration rules. Preserve their
    // internal spacing and characters; normalize only for safety validation.
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const safeLabel = text(raw.label);
    const time = text(raw.time);
    const startDate = text(raw.startDate);
    const endDate = text(raw.endDate);
    const id = text(raw.id);
    if (!safeLabel || label.length > 120 || safeLabel.length > 120 || /^[=+@-]/u.test(safeLabel) || /[<>]/u.test(safeLabel) || /[\u0000-\u001f\u007f]/u.test(raw.label)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time) || !validDate(startDate) || !validDate(endDate)
      || endDate < startDate || Date.parse(endDate) - Date.parse(startDate) > 365 * DAY_MS
      || id.length > 160 || (id && !/^[a-zA-Z0-9_-]+$/u.test(id))) return null;
    if (!Array.isArray(raw.days) || raw.days.length < 1 || raw.days.length > 7 || raw.days.some(day => !DAYS.includes(day))) return null;
    const days = DAYS.filter(day => raw.days.includes(day));
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return null;
    if (raw.cancelledDates !== undefined && (!Array.isArray(raw.cancelledDates) || raw.cancelledDates.length > 366)) return null;
    const cancelledDates = [...new Set(raw.cancelledDates || [])].sort();
    if (cancelledDates.some(date => !validDate(date) || date < startDate || date > endDate || !days.includes(dayNameForDate(date)))) return null;
    const result = { id, label, time, days, startDate, endDate, enabled: raw.enabled !== false, cancelledDates };
    if (!datesForNormalizedSeries(result, { includeCancelled: true }).length) return null;
    return result;
  }
  function datesForNormalizedSeries(series, options) {
    if (!series.enabled && !options.includeCancelled) return [];
    const from = options.from || series.startDate;
    const to = options.to || series.endDate;
    if (!validDate(from) || !validDate(to)) return [];
    const result = [];
    const start = Math.max(Date.parse(`${series.startDate}T12:00:00Z`), Date.parse(`${from}T12:00:00Z`));
    const end = Math.min(Date.parse(`${series.endDate}T12:00:00Z`), Date.parse(`${to}T12:00:00Z`));
    for (let stamp = start; stamp <= end; stamp += DAY_MS) {
      const date = new Date(stamp).toISOString().slice(0, 10);
      if (series.days.includes(dayNameForDate(date)) && (options.includeCancelled || !series.cancelledDates.includes(date))) result.push(date);
    }
    return result;
  }
  function datesForSeries(raw, options = {}) { const series = normalizeSeries(raw); return series ? datesForNormalizedSeries(series, options) : []; }
  function seriesIdentity(raw) {
    const series = normalizeSeries(raw);
    return series ? `m1-series-v1:${JSON.stringify([series.label.toLocaleLowerCase('en-US'), series.time, series.days, series.startDate, series.endDate])}` : '';
  }
  function classLabel(raw) {
    const series = normalizeSeries(raw);
    if (!series) return '';
    const [hours, minutes] = series.time.split(':').map(Number);
    return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'} ${series.label}`;
  }
  function labelMinutes(label) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)\b/iu.exec(label);
    return match ? (Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(match[2]) : 1440;
  }
  function resolvedSeriesForDate(input, date) {
    if (Array.isArray(input)) return input;
    if (!input || typeof input !== 'object') return [];
    if (!Array.isArray(input.history) || !input.history.length) return input.series || [];
    const resolved = new Map();
    for (const item of input.history) {
      if (item.fromDate <= date && (!item.toDate || date <= item.toDate) && (!resolved.has(item.seriesId) || resolved.get(item.seriesId).revision < item.revision)) resolved.set(item.seriesId, item);
    }
    return [...resolved.values()].map(item => item.series);
  }
  function classesForDate(regularDays, seriesOrDocument, date) {
    if (!validDate(date)) return [];
    const day = dayNameForDate(date);
    const regular = Array.isArray(regularDays?.[day]) ? regularDays[day] : [];
    const extra = resolvedSeriesForDate(seriesOrDocument, date).filter(series => datesForSeries(series, { from: date, to: date }).length).map(classLabel);
    return [...new Set([...regular, ...extra].filter(value => typeof value === 'string' && value.trim()))].sort((a, b) => labelMinutes(a) - labelMinutes(b) || a.localeCompare(b));
  }
  function validateDocument(value, gymId, expectedTarget = 'test') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCHEMA || value.ok !== true
      || !['test', 'production'].includes(expectedTarget) || value.target !== expectedTarget
      || !['rev', 'richmond'].includes(value.gymId) || (gymId && value.gymId !== gymId)
      || value.timezone !== TIME_ZONE || !Number.isInteger(value.version) || value.version < 0
      || !Array.isArray(value.series) || value.series.length > 500 || !Array.isArray(value.history) || value.history.length > 5000
      || !Array.isArray(value.importedIdentities) || value.importedIdentities.some(id => typeof id !== 'string' || !id.startsWith('m1-series-v1:') || id.length > 600)
      || !Number.isFinite(Date.parse(value.servedAt)) || (value.updatedAt !== null && !Number.isFinite(Date.parse(value.updatedAt)))
      || typeof value.current !== 'boolean') return null;
    const ids = new Set();
    for (const series of value.series) {
      const normalized = normalizeSeries(series);
      if (!normalized || !normalized.id || ids.has(normalized.id) || JSON.stringify(normalized) !== JSON.stringify(series)) return null;
      ids.add(normalized.id);
    }
    const latest = new Map();
    const revisions = new Set();
    for (const row of value.history) {
      const series = normalizeSeries(row?.series);
      if (!row || !series || row.seriesId !== series.id || !ids.has(row.seriesId) || !Number.isInteger(row.revision) || row.revision < 1
        || row.revision > value.version || revisions.has(row.revision) || !validDate(row.fromDate)
        || (row.toDate !== null && (!validDate(row.toDate) || row.toDate < row.fromDate))
        || JSON.stringify(series) !== JSON.stringify(row.series)) return null;
      revisions.add(row.revision);
      if (!latest.has(row.seriesId) || latest.get(row.seriesId).revision < row.revision) latest.set(row.seriesId, row);
    }
    if (value.series.some(series => JSON.stringify(latest.get(series.id)?.series) !== JSON.stringify(series))) return null;
    return value;
  }
  return Object.freeze({ SCHEMA, TIME_ZONE, DAYS, resolveAddedClassesTarget, validDate, normalizeSeries, datesForSeries, seriesIdentity, classesForDate, resolvedSeriesForDate, todayInGym, classLabel, dayNameForDate, validateDocument });
});
