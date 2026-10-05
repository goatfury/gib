import { LIVE_ORIGINS, LIVE_RECIPIENTS, BUSINESS_SENDER, INITIAL_BCC } from '../../../tools/m1-release-controls.mjs';
import { createHash } from 'node:crypto';
import { datesThrough, localNow, datePlus, validateRead } from './m1-manager-review.mjs';
import { revolutionReminderEligibility } from './m1-reminder-eligibility.mjs';

export const DIGEST_SCHEMA = 'm1-attendance-digest/v1';
// Both approved production workers began daily monitoring on this date.
// Earlier absent dated schedules remain history; no schedule is backfilled.
export const EMAIL_FIRST_MONITORING_START = '2026-10-01';
export const DIGEST_ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
const DIGEST_ORIGINS = Object.freeze({ rev: DIGEST_ORIGIN, richmond: 'https://gib-richmond-test.netlify.app' });
// Callers obtain this scope from the installation/site/context validator. A
// request body or query parameter must never select the gym or callback host.
export function digestGym(scope) {
  if (!['test', 'production'].includes(scope?.target)) return null;
  if (scope.target === 'production' && scope.liveFeatures?.reminders !== true) return null;
  if (scope.profile?.installationId === 'rev') return 'rev';
  if (scope.profile?.installationId === 'richmond' && scope.profile.environment === scope.target) return 'richmond';
  return null;
}
export const digestOrigin = scope => (scope?.target === 'production' ? LIVE_ORIGINS : DIGEST_ORIGINS)[digestGym(scope)] || null;
export const digestPrefix = scope => 'm1-' + scope.target + '-scheduled-' + digestGym(scope) + '-';
export function digestStoreName(scope, kind = 'digest') {
  if (!digestGym(scope)) throw new Error('Digest scope required.');
  if (scope.target === 'test') return kind === 'digest' ? DIGEST_STORE : 'gib-m1-digest-test-' + kind + '-v1';
  if (!['digest', 'workflow', 'delivery'].includes(kind)) throw new Error('Invalid store kind.');
  return 'gib-m1-digest-production-' + digestGym(scope) + '-' + kind + '-v1';
}
export const DIGEST_TIMEZONE = 'America/New_York';
export const DIGEST_STORE = 'gib-m1-attendance-digest-test-v1';
export const DIGEST_CONFIRMED_SENDER = 'revbjjops@gmail.com';
export const digestHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const digestDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
export function latestEligibleOpportunity(configuration, assessedAt, gym) {
  const selected = configuration.gyms?.find(value => value.id === gym);
  const time = selected?.dailyLocalTime ?? configuration.dailyLocalTime, confirmed = selected?.cutoffConfirmed ?? configuration.cutoffConfirmed;
  if (!Number.isSafeInteger(assessedAt) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || typeof confirmed !== 'boolean'
    || configuration.timezone !== DIGEST_TIMEZONE || selected && selected.timezone !== configuration.timezone) throw new Error('WORKFLOW_OPPORTUNITY_CONFIGURATION_INVALID');
  if (!confirmed) return null;
  const local = localNow(new Date(assessedAt)), [hours, minutes] = time.split(':').map(Number), beforeCutoff = local.minutes < hours * 60 + minutes;
  return { date: beforeCutoff ? datePlus(local.date, -1) : local.date, assessmentDate: local.date, localTime: time, beforeCutoff };
}
const labelKey = label => String(label).normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const safeText = (value, max = 240) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const mailbox = value => typeof value === 'string' && value.length <= 254 && value.split('@')[0].length <= 64
  && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value);
const reviewerFor = { rev: ['stu', 'Stu'], richmond: ['trey', 'Trey'] };
const validPerson = (person, key, name) => exact(person, ['key', 'name', 'address']) && person.key === key && person.name === name
  && (person.address === null || mailbox(person.address));

export function defaultDigestConfiguration(scope, env = {}) {
  const gym = digestGym(scope);
  if (!gym) throw new Error('Enabled digest scope required.');
  const address = (key, fallback) => {
    const value = env[key] === undefined ? fallback : env[key];
    if (value === undefined || value === null || value === '') return null;
    if (!mailbox(value)) throw new Error('Digest recipient configuration is invalid.');
    return value;
  };
  const dailyLocalTime = env.GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME || '20:00';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyLocalTime)) throw new Error('Digest time configuration is invalid.');
  const confirmed = env.GIB_M1_DIGEST_CUTOFF_CONFIRMED;
  if (![undefined, '', 'true', 'false'].includes(confirmed)) throw new Error('Digest cutoff configuration is invalid.');
  const copy = env.GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW;
  if (![undefined, '', 'true', 'false'].includes(copy)) throw new Error('Digest copy configuration is invalid.');
  const blindCopy = env.GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW;
  if (![undefined, '', 'true', 'false'].includes(blindCopy)) throw new Error('Digest BCC configuration is invalid.');
  const andrew = { key: 'andrew', name: 'Andrew', address: address('GIB_M1_ATTENDANCE_DIGEST_ANDREW_EMAIL', 'andrew@revolutionbjj.com') };
  if ((copy === 'true' || blindCopy !== 'false') && !andrew.address) throw new Error('Andrew copy address is not configured.');
  const routing = Object.fromEntries(Object.entries(reviewerFor).map(([gym, [key, name]]) => {
    const reviewer = { key, name, address: address('GIB_M1_ATTENDANCE_DIGEST_' + key.toUpperCase() + '_EMAIL', gym === 'rev' ? 'info@revolutionbjj.com' : 'info@richmondbjj.com') };
    const distinct = reviewer.address?.toLowerCase() !== andrew.address?.toLowerCase();
    return [gym, { reviewer, cc: copy === 'true' && distinct ? [andrew] : [],
      bcc: blindCopy !== 'false' && copy !== 'true' && distinct ? [andrew] : [] }];
  }));
  if (scope.target === 'production' && (dailyLocalTime !== '20:00' || confirmed === 'false' || copy === 'true'
    || Object.entries(routing).some(([id, route]) => route.reviewer.address !== LIVE_RECIPIENTS[id] || route.cc.length || route.bcc.some(p => p.address !== INITIAL_BCC)))) throw new Error('Live digest configuration is not approved.');
  return { schema: DIGEST_SCHEMA, target: scope.target, sendingEnabled: false, senderAddress: DIGEST_CONFIRMED_SENDER, dailyLocalTime,
    ...(env.GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED === 'true' ? { emailFirst: true } : {}),
    ...(scope.syntheticRehearsal === true ? { syntheticRehearsal: true } : {}),
    cutoffConfirmed: confirmed === 'true' || (confirmed !== 'false' && dailyLocalTime === '20:00'), classFinishCutoffConfirmed: false, timezone: DIGEST_TIMEZONE,
    recipients: [routing[gym].reviewer, ...routing[gym].cc], routing,
    gyms: [{ id: gym, name: scope.profile.gymName, timezone: DIGEST_TIMEZONE,
      staffClockEnabled: gym === 'rev' && env.GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED !== 'true', adminUrl: digestOrigin(scope) + '/m1/admin/' }] };
}

function validateConfiguration(config) {
  if (config?.schema !== DIGEST_SCHEMA || !['test', 'production'].includes(config.target) || config.sendingEnabled !== false || config.timezone !== DIGEST_TIMEZONE
    || typeof config.cutoffConfirmed !== 'boolean' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.dailyLocalTime)
    || Object.hasOwn(config, 'senderAddress') && !mailbox(config.senderAddress)
    || Object.hasOwn(config, 'classFinishCutoffConfirmed') && typeof config.classFinishCutoffConfirmed !== 'boolean'
    || !Array.isArray(config.gyms) || !config.gyms.length || config.gyms.length > 2 || new Set(config.gyms.map(g => g.id)).size !== config.gyms.length
    || config.gyms.some(g => !['rev', 'richmond'].includes(g.id) || !safeText(g.name, 100) || /[\r\n]/.test(g.name) || g.timezone !== DIGEST_TIMEZONE
      || Object.hasOwn(g, 'dailyLocalTime') && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(g.dailyLocalTime)
      || Object.hasOwn(g, 'cutoffConfirmed') && typeof g.cutoffConfirmed !== 'boolean'
      || Object.hasOwn(g, 'classFinishCutoffConfirmed') && typeof g.classFinishCutoffConfirmed !== 'boolean'
      || Object.hasOwn(g, 'staffClockEnabled') && typeof g.staffClockEnabled !== 'boolean'
      || g.adminUrl !== (config.target === 'production' ? LIVE_ORIGINS[g.id] : DIGEST_ORIGINS[g.id]) + '/m1/admin/')
    || !Array.isArray(config.recipients)) {
    throw new Error('Digest scope is incomplete.');
  }
  if (config.target === 'production' && (config.syntheticRehearsal === true || config.gyms.length !== 1 || config.senderAddress !== BUSINESS_SENDER
    || config.dailyLocalTime !== '20:00' || config.cutoffConfirmed !== true || !config.routing
    || config.gyms.some(g => g.id === 'richmond' && g.staffClockEnabled !== false)
    || Object.entries(config.routing).some(([id, route]) => route.reviewer.address !== LIVE_RECIPIENTS[id] || route.cc.length
      || (route.bcc || []).some(p => p.address !== INITIAL_BCC)))) throw new Error('Live digest configuration is not approved.');
  if (!Object.hasOwn(config, 'routing')) {
    // Legacy immutable captures retain their original addressing and rendering.
    if (config.recipients.length !== 2 || !validPerson(config.recipients[0], 'andrew', 'Andrew')
      || !validPerson(config.recipients[1], 'stu', 'Stu')) throw new Error('Digest legacy scope is incomplete.');
    return;
  }
  const primaryGym = config.gyms.length === 1 ? config.gyms[0].id : 'rev';
  if (!exact(config.routing, ['rev', 'richmond']) || Object.entries(reviewerFor).some(([gym, [key, name]]) => {
    const route = config.routing[gym];
    return !exact(route, ['reviewer', 'cc', ...(Object.hasOwn(route || {}, 'bcc') ? ['bcc'] : [])]) || !validPerson(route.reviewer, key, name)
      || !Array.isArray(route.cc) || route.cc.length > 1 || route.cc.some(person => !validPerson(person, 'andrew', 'Andrew') || !person.address
        || person.address.toLowerCase() === route.reviewer.address?.toLowerCase())
      || Object.hasOwn(route, 'bcc') && (!Array.isArray(route.bcc) || route.bcc.length > 1 || route.bcc.some(person => !validPerson(person, 'andrew', 'Andrew') || !person.address
        || person.address.toLowerCase() === route.reviewer.address?.toLowerCase() || route.cc.some(copy => copy.address.toLowerCase() === person.address.toLowerCase())));
  }) || config.recipients.length !== 1 + config.routing[primaryGym].cc.length
    || JSON.stringify(config.recipients) !== JSON.stringify([config.routing[primaryGym].reviewer, ...config.routing[primaryGym].cc])
    || config.gyms.length > 1 && config.syntheticRehearsal !== true
    || config.syntheticRehearsal !== true && config.gyms.some(gym => gym.id === 'richmond' && gym.staffClockEnabled !== false)) throw new Error('Digest routing is incomplete.');
}

function link(gym, date, staff = false) {
  return gym.adminUrl + (staff ? '#staff-time' : '?reviewDate=' + encodeURIComponent(date) + '#sign-ins');
}

function scheduleDay(value, gym, date, now, cutoffConfirmed) {
  if (value?.date !== date || value.status !== 'complete' || !iso(value.observedAt) || Date.parse(value.observedAt) > now
    || !safeText(value.sourceVersion, 160)
    || !Array.isArray(value.occurrences) || value.occurrences.length > 100) return null;
  const seen = new Set();
  const occurrences = [];
  for (const item of value.occurrences) {
    if (!safeText(item?.label) || !iso(item.startAt) || localNow(new Date(item.startAt)).date !== date
      || typeof item.cancelled !== 'boolean' || seen.has(labelKey(item.label))) return null;
    let finish;
    const eligibility = revolutionReminderEligibility(gym.id, date, item);
    // A resolved cancellation needs no inferred finish time. Its only possible
    // attention item is separately recorded teaching that contradicts it.
    if (item.cancelled) finish = null;
    else if (iso(item.endAt) && Date.parse(item.endAt) > Date.parse(item.startAt) && Date.parse(item.endAt) - Date.parse(item.startAt) <= 24 * 3600000) finish = Date.parse(item.endAt);
    else if (eligibility && item.eligibilityBasis === eligibility.eligibilityBasis
      && item.reminderEligibleAt === eligibility.reminderEligibleAt) finish = Date.parse(eligibility.reminderEligibleAt);
    else if (item.endAt === null && cutoffConfirmed && item.finishBasis === 'confirmed-gym-close' && iso(item.finishedAtCutoff)
      && Date.parse(item.finishedAtCutoff) > Date.parse(item.startAt) && Date.parse(item.finishedAtCutoff) - Date.parse(item.startAt) <= 24 * 3600000) finish = Date.parse(item.finishedAtCutoff);
    else return null;
    seen.add(labelKey(item.label)); occurrences.push({ ...item, finish });
  }
  return occurrences;
}

// The only missing-person rule is a finished, scheduled occurrence with zero
// valid sign-ins. An unreviewed day and rare additional instructors are not it.
export function buildAttendanceDigest({ jobDate, snapshots, schedules, configuration, now = Date.now() }) {
  validateConfiguration(configuration);
  if (!digestDate(jobDate) || jobDate > localNow(new Date(now)).date || !Array.isArray(snapshots)
    || snapshots.length !== configuration.gyms.length || new Set(snapshots.map(s => s.gym)).size !== snapshots.length
    || snapshots.some(s => !configuration.gyms.some(g => g.id === s.gym))) throw new Error('Digest snapshots do not match the configured gyms.');
  const groups = [], readFailures = [];
  for (const gym of configuration.gyms) {
    const snapshot = snapshots.find(s => s.gym === gym.id), items = [], seen = new Set();
    const add = (kind, date, identity, summary, staff = false, attendance = null) => {
      const id = digestHash([gym.id, kind, date, identity]).slice(0, 24);
      if (!seen.has(id)) { seen.add(id); items.push({ id, kind, date, summary, url: link(gym, date, staff), ...(attendance ? { attendance: { ...attendance, classLabel: attendance.classLabel.replace(/\s+/g, ' ').trim(), instructor: attendance.instructor.replace(/\s+/g, ' ').trim() } } : {}) }); }
    };
    const failure = (component, code, message, dates, uploadReason) => readFailures.push({ gym: gym.id, component, code, message, ...(dates?.length ? { dates } : {}), ...(uploadReason ? { uploadReason } : {}), url: link(gym, jobDate, component === 'staff') });
    let ledger;
    try {
      if (snapshot.attendance?.ok !== true) throw new Error();
      ledger = validateRead(snapshot.attendance.ledger, gym.id, jobDate, configuration.target);
    } catch { failure('attendance', 'ATTENDANCE_UNAVAILABLE', 'Instructor attendance could not be checked. This is not a missing-instructor count.'); }
    if (configuration.emailFirst === true && (snapshot.uploads?.ok !== true || snapshot.uploads.complete !== true)) {
      const reason = {
        TABLET_REPORT_NOT_RECEIVED: 'No tablet upload report has been received. ',
        TABLET_REPORT_STALE: 'The last tablet upload report is stale or belongs to another day. ',
        TABLET_UPLOADS_PENDING: 'The tablet reports pending uploads or unconfirmed saved sign-ins. ',
        TABLET_MANIFEST_INCOMPLETE: 'The tablet could not provide a complete saved-sign-in manifest. ',
        SPREADSHEET_RECEIPTS_UNCONFIRMED: 'Some reported permanent row IDs could not be confirmed exactly once in the spreadsheet. ',
        UPLOAD_EVIDENCE_READ_UNAVAILABLE: 'Upload monitoring evidence could not be read. '
      }[snapshot.uploads?.reason] || '';
      failure('uploads', 'UPLOAD_COMPLETENESS_UNCONFIRMED', reason + 'Could not confirm that every saved instructor sign-in reached the spreadsheet. The tablet may be offline or silent, uploads may be incomplete, or complete upload evidence may be unavailable. Saved rows alone do not prove that its queue is empty.', null, ['TABLET_REPORT_NOT_RECEIVED', 'TABLET_REPORT_STALE', 'TABLET_UPLOADS_PENDING', 'TABLET_MANIFEST_INCOMPLETE', 'SPREADSHEET_RECEIPTS_UNCONFIRMED', 'UPLOAD_EVIDENCE_READ_UNAVAILABLE'].includes(snapshot.uploads?.reason) ? snapshot.uploads.reason : null);
    }
    if (ledger) {
      const recordIds = new Map();
      for (const day of ledger.days) for (const record of day.records) recordIds.set(record.recordId, (recordIds.get(record.recordId) || 0) + 1);
      const schedule = schedules.find(s => s?.gym === gym.id), unknownDates = [];
      const scheduleValid = schedule?.timezone === DIGEST_TIMEZONE && Array.isArray(schedule.days) && new Set(schedule.days.map(d => d.date)).size === schedule.days.length;
      for (const day of ledger.days) {
        const records = day.records, decisions = day.review?.decisions || [];
        const finishCutoffConfirmed = gym.classFinishCutoffConfirmed ?? configuration.classFinishCutoffConfirmed ?? gym.cutoffConfirmed ?? configuration.cutoffConfirmed;
        const occurrences = scheduleValid ? scheduleDay(schedule.days.find(d => d.date === day.date), gym, day.date, now, finishCutoffConfirmed) : null;
        if (!occurrences) unknownDates.push(day.date);
        else for (const occurrence of occurrences) {
          const matching = records.filter(r => labelKey(r.classLabel) === labelKey(occurrence.label));
          const decision = decisions.find(d => labelKey(d.label) === labelKey(occurrence.label));
          if (occurrence.cancelled && matching.length) add('attendance-conflict', day.date, 'schedule-cancellation:' + labelKey(occurrence.label), occurrence.label + ' — instructor(s): ' + matching.map(r => r.instructor).join(', ') + '; recorded sign-in conflicts with a canceled occurrence.', false, { classLabel: occurrence.label, instructor: matching.map(r => r.instructor).join(', '), problem: 'schedule-cancellation' });
          const cancelled = occurrence.cancelled || (decision?.outcome === 'not-held' && !matching.length);
          if (cancelled || occurrence.finish > now) continue;
          if (!matching.some(r => r.reviewRequired === false && recordIds.get(r.recordId) === 1 && safeText(r.instructor) && Number.isFinite(r.duration) && r.duration > 0)) {
            if (configuration.emailFirst === true && matching.length) {
              // A present, flagged sign-in is an existing record problem, not
              // a missing sign-in. Its review/ID problem is listed below.
              for (const record of matching.filter(r => r.duration <= 0)) add('attendance-conflict', day.date, 'duration:' + record.recordId, record.classLabel + ' — instructor: ' + record.instructor + '; the saved sign-in has a non-positive duration.', false, { classLabel: record.classLabel, instructor: record.instructor, problem: 'duration' });
            } else if (configuration.emailFirst !== true || day.warnings.every(warning => warning?.code === 'RECORD_ID_CONFLICT')) {
              // The background reader retains readable RECORD_ID_CONFLICT rows.
              // Other or unknown warnings could conceal excluded sign-ins, so
              // their incomplete day read cannot establish an absence.
              add('missing-instructor', day.date, labelKey(occurrence.label), occurrence.label + ' — instructor: ' + (matching.length ? matching.map(r => r.instructor).join(', ') : 'not identified') + '; no valid instructor sign-in recorded in the spreadsheet.', false, { classLabel: occurrence.label, instructor: matching.map(r => r.instructor).join(', '), problem: 'missing-sign-in' });
            }
          }
        }
        for (const [index, warning] of day.warnings.entries()) {
          const identity = [warning?.code || 'ATTENDANCE_WARNING', safeText(warning?.displayId, 200) ? warning.displayId : 'warning-' + index];
          const message = safeText(warning?.message, 500) ? warning.message : 'An existing attendance warning could not be verified.';
          if (configuration.emailFirst === true) failure('attendance', 'ATTENDANCE_RECORD_UNCONFIRMED', message + ' No specific sign-in correction was established.', [day.date]);
          else add('attendance-conflict', day.date, identity, message);
        }
        for (const record of records.filter(r => r.reviewRequired)) add('attendance-conflict', day.date, record.recordId, record.classLabel + ' — instructor: ' + record.instructor + '; the saved sign-in is flagged for review.', false, { classLabel: record.classLabel, instructor: record.instructor, problem: 'review-flag' });
        for (const record of records.filter(r => recordIds.get(r.recordId) !== 1)) add('attendance-conflict', day.date, 'ambiguous-id:' + record.recordId, record.classLabel + ' — instructor: ' + record.instructor + '; the saved sign-in has a duplicate permanent attendance ID.', false, { classLabel: record.classLabel, instructor: record.instructor, problem: 'duplicate-id' });
        for (const decision of decisions) {
          if (!safeText(decision?.label)) continue;
          const occurrence = occurrences?.find(o => labelKey(o.label) === labelKey(decision.label));
          if (occurrence && occurrence.finish > now) continue;
          const matching = records.filter(r => labelKey(r.classLabel) === labelKey(decision.label));
          if (decision.outcome === 'not-held' && matching.length) add('attendance-conflict', day.date, 'cancellation:' + labelKey(decision.label), decision.label + ' — instructor(s): ' + matching.map(r => r.instructor).join(', ') + '; recorded sign-in conflicts with “Didn’t happen.”', false, { classLabel: decision.label, instructor: matching.map(r => r.instructor).join(', '), problem: 'not-held' });
          else if (decision.outcome === 'unknown') {
            const message = decision.label + ' — class status is still “Don’t know.”';
            if (configuration.emailFirst === true) failure('schedule', 'CLASS_STATUS_UNCONFIRMED', message + ' No missing sign-in was established.', [day.date]);
            else add('class-question', day.date, labelKey(decision.label), message);
          }
        }
      }
      if (unknownDates.length) {
        // The complete historical read is retained. Missing dated setup before
        // monitoring began is coverage history, never a new attendance allegation.
        const historical = configuration.emailFirst === true ? unknownDates.filter(date => date < EMAIL_FIRST_MONITORING_START) : [];
        const current = unknownDates.filter(date => !historical.includes(date));
        if (historical.length) failure('schedule', 'HISTORICAL_SCHEDULE_UNAVAILABLE', 'Historical schedule coverage remains unconfirmed for ' + historical.length + ' dates (' + historical[0] + ' through ' + historical.at(-1) + '), before daily monitoring began. This is a retained setup/history gap, not a new attendance problem or a request for manager corrections. No missing sign-ins were inferred.', historical);
        if (current.length) failure('schedule', 'SCHEDULE_COVERAGE_UNAVAILABLE', 'The dated schedule or class finish times could not be confirmed for ' + current.length + ' date' + (current.length === 1 ? '' : 's') + ' (' + current[0] + ' through ' + current.at(-1) + '). This is an incomplete check, not evidence of missing sign-ins. No missing instructors were inferred for those dates.', current);
      }
    }
    // Trusted installation capability, never inferred from a failed read.
    if (gym.staffClockEnabled !== false) try {
      const staff = snapshot.staff;
      if (staff?.ok !== true || staff.complete !== true || !Array.isArray(staff.items) || staff.items.length > 1000
        || new Set(staff.items.map(item => item.id)).size !== staff.items.length
        || staff.items.some(item => !safeText(item?.id, 200) || !['forgotten-clock-out', 'time-correction', 'staff-conflict'].includes(item.kind)
          || !safeText(item.staffName, 160) || !digestDate(item.date) || item.date > jobDate || item.status !== 'pending' || !safeText(item.summary, 500))) throw new Error();
      for (const item of staff.items) add(item.kind, item.date, item.id, item.staffName + ' — ' + item.summary, true);
    } catch { failure('staff', 'STAFF_UNAVAILABLE', 'Staff Clock and pending time proposals could not be checked. Their status is unavailable.'); }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.summary.localeCompare(b.summary));
    groups.push({ gym: gym.id, name: gym.name, items });
  }
  const itemCount = groups.reduce((n, group) => n + group.items.length, 0);
  return { schema: DIGEST_SCHEMA, target: configuration.target, date: jobDate, generatedAt: new Date(now).toISOString(), sendingEnabled: false,
    ...(configuration.syntheticRehearsal === true ? { syntheticRehearsal: true } : {}),
    recipients: configuration.recipients, groups, readFailures, itemCount, shouldCapture: itemCount > 0 || readFailures.length > 0 };
}

// Manager copy uses structured attendance fields. Original summaries/failures
// remain in the digest for audit evidence and legacy captures remain readable.
const attendanceProblems = new Set(['missing-sign-in', 'schedule-cancellation', 'duration', 'review-flag', 'duplicate-id', 'not-held']);
function attendanceQuestion(item, jobDate) {
  const detail = item.attendance;
  if (!detail) return item.date + ' — ' + item.summary + ' What needs changing?';
  const label = detail.classLabel, date = item.date;
  if (item.kind === 'missing-instructor') return date === jobDate
    ? `We don’t have an instructor sign-in for ${label} on ${date}. Who taught it, or was it canceled?`
    : `For ${date}, we don’t have an instructor sign-in for ${label}. Who taught it, or was it canceled?`;
  const recorded = `The sign-in for ${label} on ${date}` + (detail.instructor ? ` lists ${detail.instructor}` : '');
  const questions = {
    'review-flag': ' and is marked for review. What needs changing?',
    'duplicate-id': ' and shares a record number with another sign-in. Can you tell us what needs changing?',
    duration: ', but its recorded length is zero or less. How long was the class?',
    'schedule-cancellation': ', but the schedule says the class was canceled. Did it happen, and what should change?',
    'not-held': ', but the class is marked as not held. Did it happen, and what should change?'
  };
  return recorded + questions[detail.problem];
}
function managerCheckNote(failure) {
  const dates = failure.dates, range = dates?.length ? dates[0] + (dates.length > 1 ? ' through ' + dates.at(-1) : '') : '';
  if (failure.component === 'uploads') return {
    TABLET_REPORT_NOT_RECEIVED: 'We haven’t received an upload report from the tablet.',
    TABLET_REPORT_STALE: 'The last tablet report can’t confirm today’s uploads.',
    TABLET_UPLOADS_PENDING: 'The tablet reports saved sign-ins that are still waiting to upload or be confirmed.',
    TABLET_MANIFEST_INCOMPLETE: 'The tablet couldn’t report all of its saved sign-ins.',
    SPREADSHEET_RECEIPTS_UNCONFIRMED: 'Some sign-ins in the tablet’s report couldn’t be matched to spreadsheet records.',
    UPLOAD_EVIDENCE_READ_UNAVAILABLE: 'The upload report couldn’t be read.'
  }[failure.uploadReason] || '';
  if (failure.code === 'HISTORICAL_SCHEDULE_UNAVAILABLE') return 'Older schedule checks' + (range ? ' for ' + range : '') + ' are still uncertain. These are older setup gaps, not new attendance problems.';
  if (failure.code === 'SCHEDULE_COVERAGE_UNAVAILABLE') return 'We couldn’t check the class schedule or finish times' + (range ? ' for ' + range : '') + '. That doesn’t tell us whether a sign-in is missing.';
  if (failure.code === 'ATTENDANCE_UNAVAILABLE') return 'The attendance records couldn’t be read for this check.';
  // Specific record/class warnings retain their known detail without inventing
  // a class identity or extracting one from old prose.
  return failure.message;
}
function renderManagerAttendance(digest) {
  const group = digest.groups[0], manager = reviewerFor[group?.gym]?.[1];
  const items = digest.groups.flatMap(g => g.items);
  const uploads = digest.readFailures.some(f => f.component === 'uploads');
  const onlyHistory = digest.readFailures.length > 0 && digest.readFailures.every(f => f.code === 'HISTORICAL_SCHEDULE_UNAVAILABLE');
  const clean = !digest.shouldCapture;
  const subject = items.length === 1
    ? 'Sign-in question for ' + (items[0].attendance?.classLabel || group.name) + ' on ' + items[0].date
    : items.length ? 'Sign-in questions for ' + group.name + ' on ' + digest.date
    : clean ? 'Today’s sign-in check is complete' : onlyHistory ? 'Earlier sign-in checks are still uncertain' : 'Today’s sign-in check couldn’t finish';
  const paragraphs = ['Hi' + (manager ? ' ' + manager : '') + ','];
  if (items.length > 1) paragraphs.push('Can you help with these sign-ins?');
  for (const item of items) paragraphs.push(attendanceQuestion(item, digest.date));
  if (items.length) paragraphs.push('Please reply here with any corrections and Andrew will update the record.');
  if (digest.readFailures.length) {
    if (items.length && uploads) paragraphs.push('Uploads not confirmed');
    const check = uploads ? 'We couldn’t confirm that all the sign-ins reached the spreadsheet.'
      : onlyHistory ? 'Today’s sign-in and upload check finished. Older schedule checks are still uncertain.'
      : 'We couldn’t finish checking the sign-in records against the class schedule.';
    paragraphs.push(check + (items.length ? ' This doesn’t identify another missing sign-in.'
      : ' We haven’t identified a specific missing sign-in, so no correction reply is needed.'));
    for (const failure of digest.readFailures) { const note = managerCheckNote(failure); if (note) paragraphs.push(note); }
    paragraphs.push('Andrew will look into the check.');
  } else if (clean) paragraphs.push('Today’s check finished, and no sign-in problems were found. No email is needed.');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + escape(subject)
    + '</title></head><body style="font:16px/1.5 Arial,sans-serif;color:#17212c"><main>'
    + paragraphs.map(p => '<p>' + escape(p) + '</p>').join('') + '</main></body></html>';
  return { subject, html, text: paragraphs.join('\n\n') };
}

export function renderAttendanceDigest(digest) {
  const synthetic = digest.syntheticRehearsal === true, production = digest.target === 'production';
  if (production && synthetic) throw new Error('Live synthetic email prohibited.');
  const ownManagerRoute = digest.groups.length === 1 && ['rev', 'richmond'].includes(digest.routedGym)
    && digest.groups[0].gym === digest.routedGym && digest.recipients.length === 1
    && digest.recipients[0].key === reviewerFor[digest.routedGym][0]
    && digest.recipients[0].name === reviewerFor[digest.routedGym][1];
  if (production && ownManagerRoute && digest.groups.every(g => g.items.every(i => ['missing-instructor', 'attendance-conflict'].includes(i.kind)))
    && !digest.readFailures.some(f => f.component === 'staff')) return renderManagerAttendance(digest);
  const routed = ['rev', 'richmond'].includes(digest.routedGym) && digest.groups.length === 1 && digest.groups[0].gym === digest.routedGym;
  const correctionCount = digest.groups.reduce((count, group) => count + group.items.filter(item => ['missing-instructor', 'attendance-conflict'].includes(item.kind)).length, 0);
  const clean = !digest.shouldCapture;
  const label = production && clean ? 'attendance check complete' : production && !correctionCount ? 'attendance check unconfirmed' : 'attendance attention';
  const heading = production && clean ? 'Attendance check complete' : production && !correctionCount ? 'Attendance check could not be confirmed' : 'Attendance that needs attention';
  const subject = `${synthetic ? 'SYNTHETIC REHEARSAL · ' : ''}${production ? '' : 'TEST '}${label} · ${routed ? digest.groups[0].name + ' · ' : ''}${digest.date}${digest.readFailures.length && (!production || correctionCount) ? ' · check incomplete' : ''}`;
  const introduction = production ? (clean ? 'Complete checks found no attendance problems. No daily email is needed.' : correctionCount
    ? 'Please reply with corrections only for the specific attendance problems listed below: the date, class, instructor, and what should change (or whether the class did not happen). The separate unconfirmed checks do not establish additional missing sign-ins. Your reply goes to Andrew at andrew@revolutionbjj.com. Andrew will update the spreadsheet during payroll, preserving the original records and correction history.'
    : 'No specific attendance correction is listed. No correction reply is requested. The checks below could not be confirmed; they do not show that an instructor sign-in is missing. Andrew will investigate the monitoring and schedule evidence.')
    : synthetic ? 'Controlled synthetic rehearsal. These are isolated fixtures, not real attendance or instructions to correct records. No real closing time has been confirmed.'
    : routed ? 'The designated gym reviewer can resolve these items in M1 using existing authorized access. These links contain only this gym’s review items.'
    : 'Either authorized reviewer can resolve these items in M1. The links show the same centrally saved records.';
  const to = digest.recipients.map(r => `${r.name}${r.address ? ' <' + r.address + '>' : ' (address not configured)'}`).join(', ');
  const cc = routed && digest.cc?.length ? digest.cc.map(r => `${r.name} <${r.address}>`).join(', ') : '';
  const lines = [production ? 'GIB Attendance reminder' : 'TEST CAPTURE — actual email sending is disabled.', 'To: ' + to, 'Subject: ' + subject, '',
    introduction];
  if (cc) lines.splice(2, 0, 'Cc: ' + cc);
  let html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(subject) + '</title><body style="margin:0;background:#f3f5f7;color:#17212c;font:16px/1.55 Arial,sans-serif"><main style="max-width:680px;margin:24px auto;padding:28px;background:white;border:1px solid #dce2e8;border-radius:12px"><p style="font-size:13px;font-weight:bold;color:#795714">' + (production ? 'GIB Attendance' : 'TEST CAPTURE · sending disabled') + '</p><h1 style="font-size:25px;line-height:1.2">' + escape(heading) + '</h1><p>' + escape(digest.date) + ' · Eastern time</p><p><strong>To:</strong> ' + escape(to) + '</p><p>Either authorized reviewer can resolve these items in M1. The links show the same centrally saved records.</p>';
  for (const group of digest.groups) {
    const failures = digest.readFailures.filter(f => f.gym === group.gym);
    if (!group.items.length && !failures.length) continue;
    lines.push('', group.name); html += '<h2 style="font-size:20px;margin-top:28px">' + escape(group.name) + '</h2>';
    if (group.items.length) {
      html += '<ul style="padding-left:22px">';
      for (const item of group.items) { lines.push(`${item.date} — ${item.summary}`, ...(production || synthetic && !routed ? [] : [item.url])); html += '<li style="margin:12px 0"><strong>' + escape(item.date) + '</strong> — ' + escape(item.summary) + (production || synthetic && !routed ? '' : '<br><a href="' + escape(item.url) + '">Open authenticated correction screen</a>') + '</li>'; }
      html += '</ul>';
    }
    if (failures.length) {
      lines.push('Checks that could not be completed:'); html += '<h3 style="font-size:16px;color:#9a4418">Checks that could not be completed</h3><ul>';
      for (const item of failures) { lines.push(item.message, ...(production ? [] : [item.url])); html += '<li style="margin:10px 0">' + escape(item.message) + (production ? '' : '<br><a href="' + escape(item.url) + '">Check records in M1</a>') + '</li>'; }
      html += '</ul>';
    }
  }
  if (!digest.shouldCapture) { lines.push('', 'No outstanding items were found in the complete checks. No daily email is needed.'); html += '<p>No outstanding items were found in the complete checks. No daily email is needed.</p>'; }
  lines.push('', 'Late uploads and corrections are checked again in the next digest. A day being unreviewed alone is not an email trigger.', production ? 'Email submission does not confirm delivery or resolve these questions.' : 'This is a capture preview; real delivery has not been tested.');
  html += '<hr style="border:0;border-top:1px solid #dce2e8;margin:28px 0"><p style="font-size:13px;color:#546171">Late uploads and corrections are checked again in the next digest. A day being unreviewed alone is not an email trigger.</p><p style="font-size:13px;color:#546171">' + (production ? 'Email submission does not confirm delivery or resolve these questions.' : 'This is a capture preview; real delivery has not been tested.') + '</p></main></body></html>';
  if (production || synthetic || routed) html = html.replace('Either authorized reviewer can resolve these items in M1. The links show the same centrally saved records.', escape(introduction));
  if (cc) html = html.replace('<p><strong>To:</strong> ' + escape(to) + '</p>', '<p><strong>To:</strong> ' + escape(to) + '</p><p><strong>Cc:</strong> ' + escape(cc) + '</p>');
  return { subject, html, text: lines.join('\n') };
}

// Separate route decisions for every configured gym. Missing addresses block
// delivery; a clean, complete gym produces no message even if another gym failed.
// Legacy captures may still render, but cannot infer new routing from old lists.
export function splitAttendanceDigest(digest, configuration) {
  validateConfiguration(configuration);
  if (!configuration.routing) throw new Error('Explicit per-gym routing is required.');
  if (digest?.schema !== DIGEST_SCHEMA || digest.target !== configuration.target || digest.sendingEnabled !== false
    || !digestDate(digest.date) || !iso(digest.generatedAt)
    || (digest.syntheticRehearsal === true) !== (configuration.syntheticRehearsal === true)
    || !Array.isArray(digest.groups) || digest.groups.length !== configuration.gyms.length
    || new Set(digest.groups.map(group => group?.gym)).size !== digest.groups.length
    || !Array.isArray(digest.readFailures)) throw new Error('Digest grouping is incomplete.');
  const kinds = new Set(['missing-instructor', 'attendance-conflict', 'class-question', 'forgotten-clock-out', 'time-correction', 'staff-conflict']);
  const staffKinds = new Set(['forgotten-clock-out', 'time-correction', 'staff-conflict']);
  const ids = new Set();
  for (const group of digest.groups) {
    const gym = configuration.gyms.find(value => value.id === group?.gym);
    if (!gym || !exact(group, ['gym', 'name', 'items']) || group.name !== gym.name || !Array.isArray(group.items)
      || group.items.length > 5000) throw new Error('Digest gym data is incomplete.');
    for (const item of group.items) {
      if (!exact(item, ['id', 'kind', 'date', 'summary', 'url', ...(Object.hasOwn(item, 'attendance') ? ['attendance'] : [])]) || !/^[0-9a-f]{24}$/.test(item.id) || ids.has(item.id)
        || !kinds.has(item.kind) || !digestDate(item.date) || item.date > digest.date || !safeText(item.summary, 1000)
        || item.url !== link(gym, item.date, staffKinds.has(item.kind))
        || Object.hasOwn(item, 'attendance') && (!['missing-instructor', 'attendance-conflict'].includes(item.kind)
          || !exact(item.attendance, ['classLabel', 'instructor', 'problem']) || !safeText(item.attendance.classLabel, 240)
          || /[\r\n]/.test(item.attendance.classLabel) || typeof item.attendance.instructor !== 'string'
          || item.attendance.instructor.length > 1000 || /[\r\n\u0000-\u001f]/.test(item.attendance.instructor)
          || !attendanceProblems.has(item.attendance.problem)
          || (item.kind === 'missing-instructor') !== (item.attendance.problem === 'missing-sign-in'))) throw new Error('Digest item crosses its gym boundary.');
      ids.add(item.id);
    }
  }
  for (const failure of digest.readFailures) {
    const gym = configuration.gyms.find(value => value.id === failure?.gym);
    if (!gym || !exact(failure, ['gym', 'component', 'code', 'message', 'url', ...(Object.hasOwn(failure, 'dates') ? ['dates'] : []), ...(Object.hasOwn(failure, 'uploadReason') ? ['uploadReason'] : [])])
      || !['attendance', 'schedule', 'staff', 'uploads'].includes(failure.component) || !/^[A-Z0-9_]{1,80}$/.test(failure.code)
      || Object.hasOwn(failure, 'uploadReason') && (failure.component !== 'uploads' || !['TABLET_REPORT_NOT_RECEIVED', 'TABLET_REPORT_STALE', 'TABLET_UPLOADS_PENDING', 'TABLET_MANIFEST_INCOMPLETE', 'SPREADSHEET_RECEIPTS_UNCONFIRMED', 'UPLOAD_EVIDENCE_READ_UNAVAILABLE'].includes(failure.uploadReason))
      || !safeText(failure.message, 1000) || failure.url !== link(gym, digest.date, failure.component === 'staff')
      || (Object.hasOwn(failure, 'dates') && (!Array.isArray(failure.dates) || !failure.dates.length
        || failure.dates.some(date => !digestDate(date) || date > digest.date)))) throw new Error('Digest failed-read coverage is incomplete.');
  }
  if (digest.itemCount !== ids.size || digest.shouldCapture !== Boolean(ids.size || digest.readFailures.length)) throw new Error('Digest result count is incomplete.');
  return configuration.gyms.map(gym => {
    const route = configuration.routing[gym.id], group = digest.groups.find(value => value.gym === gym.id);
    const own = { schema: DIGEST_SCHEMA, target: configuration.target, date: digest.date, generatedAt: digest.generatedAt, sendingEnabled: false,
      ...(digest.syntheticRehearsal === true ? { syntheticRehearsal: true } : {}), routedGym: gym.id,
      recipients: structuredClone([route.reviewer]), cc: structuredClone(route.cc), groups: structuredClone([group]),
      ...(Object.hasOwn(route, 'bcc') ? { bcc: structuredClone(route.bcc) } : {}),
      readFailures: structuredClone(digest.readFailures.filter(value => value.gym === gym.id)), itemCount: group.items.length };
    own.shouldCapture = Boolean(own.itemCount || own.readFailures.length);
    const routeStatus = !own.shouldCapture ? 'suppressed' : !route.reviewer.address ? 'blocked' : 'ready';
    return { gym: gym.id, routeStatus, code: routeStatus === 'suppressed' ? 'NO_OUTSTANDING_ITEMS' : routeStatus === 'blocked' ? 'REVIEWER_UNCONFIGURED' : null,
      to: route.reviewer.address ? [route.reviewer.address] : [], cc: route.cc.map(person => person.address), digest: own,
      ...(Object.hasOwn(route, 'bcc') ? { bcc: route.bcc.map(person => person.address) } : {}),
      rendered: own.shouldCapture ? renderAttendanceDigest(own) : null };
  });
}

export function digestDue(jobDate, now, configuration, schedules) {
  if (!configuration.cutoffConfirmed) return 'awaiting-configuration';
  const clock = localNow(new Date(now)), [hours, minutes] = configuration.dailyLocalTime.split(':').map(Number);
  if (jobDate > clock.date || (jobDate === clock.date && clock.minutes < hours * 60 + minutes)) return 'not-due';
  // A confirmed reminder time is not a promise that every class has finished.
  // Later occurrences stay excluded by the builder and roll into the next day.
  if (configuration.classFinishCutoffConfirmed === false) return 'due';
  for (const schedule of schedules) {
    const day = schedule?.days?.find(day => day.date === jobDate);
    const occurrences = day && scheduleDay(day, {}, jobDate, now, configuration.cutoffConfirmed);
    if (occurrences?.some(item => !item.cancelled && item.finish > now)) return 'not-due';
  }
  return 'due';
}

export { datesThrough };
