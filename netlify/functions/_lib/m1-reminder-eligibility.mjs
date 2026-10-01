import { localNow } from './m1-manager-review.mjs';

// Andrew approved this forward-looking reminder policy on this date. It is
// not an actual class finish, a payroll duration or historical schedule data.
export const REV_REMINDER_RULE = Object.freeze({
  id: 'rev-reminder-20-v1', effectiveDate: '2026-09-29', localTime: '20:00'
});

export function revolutionReminderEligibility(gym, date, occurrence) {
  if (gym !== 'rev' || typeof date !== 'string' || date < REV_REMINDER_RULE.effectiveDate
    || !/^\d{4}-\d{2}-\d{2}$/.test(date) || occurrence?.endAt !== null
    || occurrence.cancelled || typeof occurrence.startAt !== 'string'
    || !Number.isFinite(Date.parse(occurrence.startAt))) return null;
  const start = localNow(new Date(occurrence.startAt));
  // An explicit range must supply its own finish. New classes starting at or
  // after the cutoff are not presumed finished by this rule.
  if (start.date !== date || start.minutes >= 20 * 60
    || /(?:AM|PM)\s*[-–]/i.test(occurrence.label || '')) return null;
  const candidates = [4, 5].map(offset => new Date(Date.parse(date + 'T20:00:00Z') + offset * 3600000))
    .filter(at => Number.isFinite(at.getTime()) && localNow(at).date === date && localNow(at).minutes === 20 * 60);
  if (candidates.length !== 1) return null;
  return { reminderEligibleAt: candidates[0].toISOString(), eligibilityBasis: REV_REMINDER_RULE.id };
}
