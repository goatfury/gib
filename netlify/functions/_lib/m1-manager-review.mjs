import { createHash } from 'node:crypto';
import temporaryClasses from '../../../m1/temporary-classes-core.js';

// Dates confirmed by the existing payroll handoff, not inferred from attendance.
export const REVIEW_START = '2026-09-07';
export const TIMEZONE = 'America/New_York';
const DAY = 86400000;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function datePlus(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
export function localNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
export function periodFor(date) {
  const index = Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${REVIEW_START}T12:00:00Z`)) / (14 * DAY));
  const start = datePlus(REVIEW_START, index * 14);
  return { start, end: datePlus(start, 13) };
}
export function datesThrough(today) {
  if (!temporaryClasses.validDate(today) || today < REVIEW_START || today > datePlus(REVIEW_START, 3660)) throw new Error('Review date range unavailable.');
  const dates = [];
  for (let date = REVIEW_START; date <= today; date = datePlus(date, 1)) dates.push(date);
  return dates;
}
const key = label => label.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
export function classMinutes(label) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(label);
  return match && +match[1] >= 1 && +match[1] <= 12 && +match[2] < 60 ? (+match[1] % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + +match[2] : null;
}
export function dayPlan(day, schedule, added, now = new Date()) {
  const clock = localNow(now);
  const saved = day.review;
  // A current weekly timetable is evidence only for today. Never extrapolate it backwards.
  const base = day.date === clock.date ? schedule.days[temporaryClasses.dayNameForDate(day.date)] : saved?.snapshot?.base;
  const historyKnown = Array.isArray(base);
  const extra = temporaryClasses.classesForDate({}, added, day.date);
  const labels = [...new Set([...(base || []), ...extra])].sort();
  const scheduleData = { base: base || null, extra };
  const scheduleHash = digest(scheduleData);
  const groups = new Map();
  const get = label => {
    const id = key(label);
    if (!groups.has(id)) groups.set(id, { id, label, scheduled: false, records: [], outcome: '', minutes: classMinutes(label) });
    return groups.get(id);
  };
  labels.forEach(label => { get(label).scheduled = true; });
  day.records.forEach(record => get(record.classLabel).records.push(record));
  // Keep an explicitly unresolved occurrence visible even if it disappears from the schedule.
  for (const item of saved?.decisions || []) {
    const row = get(item.label);
    row.outcome = item.outcome;
  }
  const classes = [...groups.values()].sort((a, b) => (a.minutes ?? 1440) - (b.minutes ?? 1440) || a.label.localeCompare(b.label));
  for (const row of classes) {
    row.upcoming = day.date > clock.date || (day.date === clock.date && (row.minutes === null || row.minutes > clock.minutes));
    row.conflict = row.outcome === 'not-held' && row.records.length > 0;
    row.unresolved = row.outcome === 'unknown' || row.conflict || (row.records.length === 0 && row.outcome !== 'not-held');
  }
  const changed = Boolean(saved && (saved.attendanceHash !== day.attendanceHash || saved.scheduleHash !== scheduleHash));
  const blockers = [];
  if (day.warnings.length || day.records.some(r => r.reviewRequired)) blockers.push('Resolve the flagged attendance records before completing this day.');
  if (classes.some(row => row.upcoming)) blockers.push('Classes are still upcoming. Complete this day after they have started.');
  if (classes.some(row => row.unresolved && !row.upcoming)) blockers.push('Add missing instructors or resolve the blank and unknown classes.');
  const complete = saved?.action === 'complete' && !changed && !blockers.length;
  return { date: day.date, period: periodFor(day.date), classes, historyKnown, base: base || null, scheduleHash, attendanceHash: day.attendanceHash, revision: saved?.revision || 0, decisions: saved?.decisions || [], warnings: day.warnings, blockers, complete, changed, reviewer: saved?.reviewer || '', reviewedAt: saved?.time || '', canComplete: !blockers.length && day.date <= clock.date };
}

export function validateRead(value, gym, today) {
  const dates = datesThrough(today);
  if (!value || value.ok !== true || value.schema !== 'm1-manager-review/v1' || value.gym !== gym || value.from !== REVIEW_START || value.to !== today || value.complete !== true || !Array.isArray(value.days) || value.days.length !== dates.length) throw new Error('The complete central review could not be read.');
  for (let i = 0; i < dates.length; i++) {
    const day = value.days[i];
    if (day?.date !== dates[i] || !/^[a-f0-9]{64}$/.test(day.attendanceHash) || !Array.isArray(day.records) || !Array.isArray(day.warnings)) throw new Error('Incomplete central day.');
    if (day.records.some(r => !r || typeof r.recordId !== 'string' || r.date !== day.date || typeof r.classLabel !== 'string' || !r.classLabel || typeof r.instructor !== 'string' || !r.instructor || !Number.isFinite(r.duration) || typeof r.reviewRequired !== 'boolean')) throw new Error('Incomplete attendance record.');
    if (day.review && (!Number.isInteger(day.review.revision) || day.review.revision < 1 || !['partial', 'complete'].includes(day.review.action) || !Array.isArray(day.review.decisions) || !day.review.snapshot || !/^[a-f0-9]{64}$/.test(day.review.attendanceHash) || !/^[a-f0-9]{64}$/.test(day.review.scheduleHash) || !Number.isFinite(Date.parse(day.review.time)))) throw new Error('Incomplete saved review.');
  }
  return value;
}

export function proposedReview(input, day, schedule, added, now) {
  if (!input || !['partial', 'complete'].includes(input.action) || !/^manager-[a-zA-Z0-9-]{16,100}$/.test(input.requestId) || input.date !== day.date || input.revision !== (day.review?.revision || 0) || input.attendanceHash !== day.attendanceHash) throw new Error('Attendance or review changed. Refresh this day before saving.');
  const current = dayPlan(day, schedule, added, now);
  if (input.scheduleHash !== current.scheduleHash) throw new Error('The schedule changed. Refresh this day before saving.');
  if (!Array.isArray(input.decisions) || input.decisions.length > 100) throw new Error('Invalid class decisions.');
  const seen = new Set();
  for (const item of input.decisions) {
    if (!item || typeof item.label !== 'string' || !['unknown', 'not-held'].includes(item.outcome) || seen.has(key(item.label))) throw new Error('Invalid class decision.');
    const row = current.classes.find(row => row.id === key(item.label));
    if (!row || row.upcoming || (item.outcome === 'not-held' && row.records.length)) throw new Error('Recorded teaching cannot be marked as not held, and upcoming classes cannot be resolved early.');
    seen.add(key(item.label));
  }
  const candidate = dayPlan({ ...day, review: { ...day.review, decisions: input.decisions, snapshot: { base: current.base } } }, schedule, added, now);
  if (input.action === 'complete' && !candidate.canComplete) throw new Error(candidate.blockers.join(' '));
  return { ...input, snapshot: { base: current.base, classes: candidate.classes.map(row => ({ label: row.label, scheduled: row.scheduled, records: row.records })) } };
}
