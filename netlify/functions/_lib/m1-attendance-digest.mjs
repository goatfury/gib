import { createHash } from 'node:crypto';
import { datesThrough, localNow, datePlus, validateRead } from './m1-manager-review.mjs';

export const DIGEST_SCHEMA = 'm1-attendance-digest/v1';
export const DIGEST_ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
export const DIGEST_TIMEZONE = 'America/New_York';
export const DIGEST_STORE = 'gib-m1-attendance-digest-test-v1';
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
  if (scope?.target !== 'test' || scope.profile?.installationId !== 'rev') throw new Error('Revolution TEST digest required.');
  const address = key => {
    const value = env[key];
    if (value === undefined || value === null || value === '') return null;
    if (!mailbox(value)) throw new Error('Digest recipient configuration is invalid.');
    return value;
  };
  const dailyLocalTime = env.GIB_M1_ATTENDANCE_DIGEST_LOCAL_TIME || '22:00';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyLocalTime)) throw new Error('Digest time configuration is invalid.');
  const copy = env.GIB_M1_ATTENDANCE_DIGEST_COPY_ANDREW;
  if (![undefined, '', 'true', 'false'].includes(copy)) throw new Error('Digest copy configuration is invalid.');
  const andrew = { key: 'andrew', name: 'Andrew', address: address('GIB_M1_ATTENDANCE_DIGEST_ANDREW_EMAIL') };
  if (copy === 'true' && !andrew.address) throw new Error('Andrew copy address is not configured.');
  const routing = Object.fromEntries(Object.entries(reviewerFor).map(([gym, [key, name]]) => {
    const reviewer = { key, name, address: address('GIB_M1_ATTENDANCE_DIGEST_' + key.toUpperCase() + '_EMAIL') };
    return [gym, { reviewer, cc: copy === 'true' && reviewer.address?.toLowerCase() !== andrew.address.toLowerCase() ? [andrew] : [] }];
  }));
  return { schema: DIGEST_SCHEMA, target: 'test', sendingEnabled: false, dailyLocalTime,
    ...(scope.syntheticRehearsal === true ? { syntheticRehearsal: true } : {}),
    cutoffConfirmed: env.GIB_M1_DIGEST_CUTOFF_CONFIRMED === 'true', timezone: DIGEST_TIMEZONE,
    recipients: [routing.rev.reviewer, ...routing.rev.cc], routing,
    gyms: [{ id: 'rev', name: scope.profile.gymName, timezone: DIGEST_TIMEZONE, adminUrl: DIGEST_ORIGIN + '/m1/admin/' }] };
}

function validateConfiguration(config) {
  if (config?.schema !== DIGEST_SCHEMA || config.target !== 'test' || config.sendingEnabled !== false || config.timezone !== DIGEST_TIMEZONE
    || typeof config.cutoffConfirmed !== 'boolean' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.dailyLocalTime)
    || !Array.isArray(config.gyms) || !config.gyms.length || config.gyms.length > 2 || new Set(config.gyms.map(g => g.id)).size !== config.gyms.length
    || config.gyms.some(g => !['rev', 'richmond'].includes(g.id) || !safeText(g.name, 100) || /[\r\n]/.test(g.name) || g.timezone !== DIGEST_TIMEZONE
      || Object.hasOwn(g, 'dailyLocalTime') && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(g.dailyLocalTime)
      || Object.hasOwn(g, 'cutoffConfirmed') && typeof g.cutoffConfirmed !== 'boolean'
      || g.adminUrl !== (g.id === 'rev' ? DIGEST_ORIGIN : 'https://gib-richmond-test.netlify.app') + '/m1/admin/')
    || !Array.isArray(config.recipients)) {
    throw new Error('Digest scope is incomplete.');
  }
  if (!Object.hasOwn(config, 'routing')) {
    // Legacy immutable captures retain their original addressing and rendering.
    if (config.recipients.length !== 2 || !validPerson(config.recipients[0], 'andrew', 'Andrew')
      || !validPerson(config.recipients[1], 'stu', 'Stu')) throw new Error('Digest legacy scope is incomplete.');
    return;
  }
  if (!exact(config.routing, ['rev', 'richmond']) || Object.entries(reviewerFor).some(([gym, [key, name]]) => {
    const route = config.routing[gym];
    return !exact(route, ['reviewer', 'cc']) || !validPerson(route.reviewer, key, name)
      || !Array.isArray(route.cc) || route.cc.length > 1 || route.cc.some(person => !validPerson(person, 'andrew', 'Andrew') || !person.address
        || person.address.toLowerCase() === route.reviewer.address?.toLowerCase());
  }) || config.recipients.length !== 1 + config.routing.rev.cc.length
    || JSON.stringify(config.recipients) !== JSON.stringify([config.routing.rev.reviewer, ...config.routing.rev.cc])
    || (config.gyms.some(gym => gym.id === 'richmond') && config.syntheticRehearsal !== true)) throw new Error('Digest routing is incomplete.');
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
    // A resolved cancellation needs no inferred finish time. Its only possible
    // attention item is separately recorded teaching that contradicts it.
    if (item.cancelled) finish = null;
    else if (iso(item.endAt) && Date.parse(item.endAt) > Date.parse(item.startAt) && Date.parse(item.endAt) - Date.parse(item.startAt) <= 24 * 3600000) finish = Date.parse(item.endAt);
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
    const add = (kind, date, identity, summary, staff = false) => {
      const id = digestHash([gym.id, kind, date, identity]).slice(0, 24);
      if (!seen.has(id)) { seen.add(id); items.push({ id, kind, date, summary, url: link(gym, date, staff) }); }
    };
    const failure = (component, code, message, dates) => readFailures.push({ gym: gym.id, component, code, message, ...(dates?.length ? { dates } : {}), url: link(gym, jobDate, component === 'staff') });
    let ledger;
    try {
      if (snapshot.attendance?.ok !== true) throw new Error();
      ledger = validateRead(snapshot.attendance.ledger, gym.id, jobDate, 'test');
    } catch { failure('attendance', 'ATTENDANCE_UNAVAILABLE', 'Instructor attendance could not be checked. This is not a missing-instructor count.'); }
    if (ledger) {
      const recordIds = new Map();
      for (const day of ledger.days) for (const record of day.records) recordIds.set(record.recordId, (recordIds.get(record.recordId) || 0) + 1);
      const schedule = schedules.find(s => s?.gym === gym.id), unknownDates = [];
      const scheduleValid = schedule?.timezone === DIGEST_TIMEZONE && Array.isArray(schedule.days) && new Set(schedule.days.map(d => d.date)).size === schedule.days.length;
      for (const day of ledger.days) {
        const records = day.records, decisions = day.review?.decisions || [];
        const occurrences = scheduleValid ? scheduleDay(schedule.days.find(d => d.date === day.date), gym, day.date, now, configuration.cutoffConfirmed) : null;
        if (!occurrences) unknownDates.push(day.date);
        else for (const occurrence of occurrences) {
          const matching = records.filter(r => labelKey(r.classLabel) === labelKey(occurrence.label));
          const decision = decisions.find(d => labelKey(d.label) === labelKey(occurrence.label));
          if (occurrence.cancelled && matching.length) add('attendance-conflict', day.date, 'schedule-cancellation:' + labelKey(occurrence.label), occurrence.label + ' — recorded teaching conflicts with a canceled occurrence.');
          const cancelled = occurrence.cancelled || (decision?.outcome === 'not-held' && !matching.length);
          if (cancelled || occurrence.finish > now) continue;
          if (!matching.some(r => r.reviewRequired === false && recordIds.get(r.recordId) === 1 && safeText(r.instructor) && Number.isFinite(r.duration) && r.duration > 0)) {
            add('missing-instructor', day.date, labelKey(occurrence.label), occurrence.label + ' — no valid instructor sign-in.');
          }
        }
        for (const [index, warning] of day.warnings.entries()) {
          const identity = [warning?.code || 'ATTENDANCE_WARNING', safeText(warning?.displayId, 200) ? warning.displayId : 'warning-' + index];
          add('attendance-conflict', day.date, identity, safeText(warning?.message, 500) ? warning.message : 'An existing attendance warning needs review.');
        }
        for (const record of records.filter(r => r.reviewRequired)) add('attendance-conflict', day.date, record.recordId, record.classLabel + ' — ' + record.instructor + ': recorded attendance needs review.');
        for (const record of records.filter(r => recordIds.get(r.recordId) !== 1)) add('attendance-conflict', day.date, 'ambiguous-id:' + record.recordId, record.classLabel + ' — the permanent attendance ID is ambiguous.');
        for (const decision of decisions) {
          if (!safeText(decision?.label)) continue;
          const occurrence = occurrences?.find(o => labelKey(o.label) === labelKey(decision.label));
          if (occurrence && occurrence.finish > now) continue;
          const matching = records.filter(r => labelKey(r.classLabel) === labelKey(decision.label));
          if (decision.outcome === 'not-held' && matching.length) add('attendance-conflict', day.date, 'cancellation:' + labelKey(decision.label), decision.label + ' — recorded teaching conflicts with “Didn’t happen.”');
          else if (decision.outcome === 'unknown') add('class-question', day.date, labelKey(decision.label), decision.label + ' — class status is still “Don’t know.”');
        }
      }
      if (unknownDates.length) failure('schedule', 'SCHEDULE_COVERAGE_UNAVAILABLE', 'The actual dated schedule or class finish times could not be confirmed for ' + unknownDates.length + ' date' + (unknownDates.length === 1 ? '' : 's') + '. No missing instructors were inferred for those dates.', unknownDates);
    }
    try {
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
  return { schema: DIGEST_SCHEMA, target: 'test', date: jobDate, generatedAt: new Date(now).toISOString(), sendingEnabled: false,
    ...(configuration.syntheticRehearsal === true ? { syntheticRehearsal: true } : {}),
    recipients: configuration.recipients, groups, readFailures, itemCount, shouldCapture: itemCount > 0 || readFailures.length > 0 };
}

export function renderAttendanceDigest(digest) {
  const synthetic = digest.syntheticRehearsal === true;
  const routed = ['rev', 'richmond'].includes(digest.routedGym) && digest.groups.length === 1 && digest.groups[0].gym === digest.routedGym;
  const subject = `${synthetic ? 'SYNTHETIC REHEARSAL · ' : ''}TEST attendance attention · ${routed ? digest.groups[0].name + ' · ' : ''}${digest.date}${digest.readFailures.length ? ' · check incomplete' : ''}`;
  const introduction = synthetic ? 'Controlled synthetic rehearsal. These are isolated fixtures, not real attendance or instructions to correct records. No real closing time has been confirmed.'
    : routed ? 'The designated gym reviewer can resolve these items in M1 using existing authorized access. These links contain only this gym’s review items.'
    : 'Either authorized reviewer can resolve these items in M1. The links show the same centrally saved records.';
  const to = digest.recipients.map(r => `${r.name}${r.address ? ' <' + r.address + '>' : ' (address not configured)'}`).join(', ');
  const cc = routed && digest.cc?.length ? digest.cc.map(r => `${r.name} <${r.address}>`).join(', ') : '';
  const lines = ['TEST CAPTURE — actual email sending is disabled.', 'To: ' + to, 'Subject: ' + subject, '',
    introduction];
  if (cc) lines.splice(2, 0, 'Cc: ' + cc);
  let html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(subject) + '</title><body style="margin:0;background:#f3f5f7;color:#17212c;font:16px/1.55 Arial,sans-serif"><main style="max-width:680px;margin:24px auto;padding:28px;background:white;border:1px solid #dce2e8;border-radius:12px"><p style="font-size:13px;font-weight:bold;color:#795714">TEST CAPTURE · sending disabled</p><h1 style="font-size:25px;line-height:1.2">Attendance that needs attention</h1><p>' + escape(digest.date) + ' · Eastern time</p><p><strong>To:</strong> ' + escape(to) + '</p><p>Either authorized reviewer can resolve these items in M1. The links show the same centrally saved records.</p>';
  for (const group of digest.groups) {
    const failures = digest.readFailures.filter(f => f.gym === group.gym);
    if (!group.items.length && !failures.length) continue;
    lines.push('', group.name); html += '<h2 style="font-size:20px;margin-top:28px">' + escape(group.name) + '</h2>';
    if (group.items.length) {
      html += '<ul style="padding-left:22px">';
      for (const item of group.items) { lines.push(`${item.date} — ${item.summary}`, ...(synthetic && !routed ? [] : [item.url])); html += '<li style="margin:12px 0"><strong>' + escape(item.date) + '</strong> — ' + escape(item.summary) + (synthetic && !routed ? '' : '<br><a href="' + escape(item.url) + '">Open authenticated correction screen</a>') + '</li>'; }
      html += '</ul>';
    }
    if (failures.length) {
      lines.push('Checks that could not be completed:'); html += '<h3 style="font-size:16px;color:#9a4418">Checks that could not be completed</h3><ul>';
      for (const item of failures) { lines.push(item.message, item.url); html += '<li style="margin:10px 0">' + escape(item.message) + '<br><a href="' + escape(item.url) + '">Check records in M1</a></li>'; }
      html += '</ul>';
    }
  }
  if (!digest.shouldCapture) { lines.push('', 'No outstanding items were found in the complete checks. No daily email is needed.'); html += '<p>No outstanding items were found in the complete checks. No daily email is needed.</p>'; }
  lines.push('', 'Late uploads and corrections are checked again in the next digest. A day being unreviewed alone is not an email trigger.', 'This is a capture preview; real delivery has not been tested.');
  html += '<hr style="border:0;border-top:1px solid #dce2e8;margin:28px 0"><p style="font-size:13px;color:#546171">Late uploads and corrections are checked again in the next digest. A day being unreviewed alone is not an email trigger.</p><p style="font-size:13px;color:#546171">This is a capture preview; real delivery has not been tested.</p></main></body></html>';
  if (synthetic || routed) html = html.replace('Either authorized reviewer can resolve these items in M1. The links show the same centrally saved records.', escape(introduction));
  if (cc) html = html.replace('<p><strong>To:</strong> ' + escape(to) + '</p>', '<p><strong>To:</strong> ' + escape(to) + '</p><p><strong>Cc:</strong> ' + escape(cc) + '</p>');
  return { subject, html, text: lines.join('\n') };
}

// Separate route decisions for every configured gym. Missing addresses block
// delivery; a clean, complete gym produces no message even if another gym failed.
// Legacy captures may still render, but cannot infer new routing from old lists.
export function splitAttendanceDigest(digest, configuration) {
  validateConfiguration(configuration);
  if (!configuration.routing) throw new Error('Explicit per-gym routing is required.');
  if (digest?.schema !== DIGEST_SCHEMA || digest.target !== 'test' || digest.sendingEnabled !== false
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
      if (!exact(item, ['id', 'kind', 'date', 'summary', 'url']) || !/^[0-9a-f]{24}$/.test(item.id) || ids.has(item.id)
        || !kinds.has(item.kind) || !digestDate(item.date) || item.date > digest.date || !safeText(item.summary, 1000)
        || item.url !== link(gym, item.date, staffKinds.has(item.kind))) throw new Error('Digest item crosses its gym boundary.');
      ids.add(item.id);
    }
  }
  for (const failure of digest.readFailures) {
    const gym = configuration.gyms.find(value => value.id === failure?.gym);
    if (!gym || !exact(failure, ['gym', 'component', 'code', 'message', 'url', ...(Object.hasOwn(failure, 'dates') ? ['dates'] : [])])
      || !['attendance', 'schedule', 'staff'].includes(failure.component) || !/^[A-Z0-9_]{1,80}$/.test(failure.code)
      || !safeText(failure.message, 1000) || failure.url !== link(gym, digest.date, failure.component === 'staff')
      || (Object.hasOwn(failure, 'dates') && (!Array.isArray(failure.dates) || !failure.dates.length
        || failure.dates.some(date => !digestDate(date) || date > digest.date)))) throw new Error('Digest failed-read coverage is incomplete.');
  }
  if (digest.itemCount !== ids.size || digest.shouldCapture !== Boolean(ids.size || digest.readFailures.length)) throw new Error('Digest result count is incomplete.');
  return configuration.gyms.map(gym => {
    const route = configuration.routing[gym.id], group = digest.groups.find(value => value.gym === gym.id);
    const own = { schema: DIGEST_SCHEMA, target: 'test', date: digest.date, generatedAt: digest.generatedAt, sendingEnabled: false,
      ...(digest.syntheticRehearsal === true ? { syntheticRehearsal: true } : {}), routedGym: gym.id,
      recipients: structuredClone([route.reviewer]), cc: structuredClone(route.cc), groups: structuredClone([group]),
      readFailures: structuredClone(digest.readFailures.filter(value => value.gym === gym.id)), itemCount: group.items.length };
    own.shouldCapture = Boolean(own.itemCount || own.readFailures.length);
    const routeStatus = !own.shouldCapture ? 'suppressed' : !route.reviewer.address ? 'blocked' : 'ready';
    return { gym: gym.id, routeStatus, code: routeStatus === 'suppressed' ? 'NO_OUTSTANDING_ITEMS' : routeStatus === 'blocked' ? 'REVIEWER_UNCONFIGURED' : null,
      to: route.reviewer.address ? [route.reviewer.address] : [], cc: route.cc.map(person => person.address), digest: own,
      rendered: own.shouldCapture ? renderAttendanceDigest(own) : null };
  });
}

export function digestDue(jobDate, now, configuration, schedules) {
  if (!configuration.cutoffConfirmed) return 'awaiting-configuration';
  const clock = localNow(new Date(now)), [hours, minutes] = configuration.dailyLocalTime.split(':').map(Number);
  if (jobDate > clock.date || (jobDate === clock.date && clock.minutes < hours * 60 + minutes)) return 'not-due';
  for (const schedule of schedules) {
    const day = schedule?.days?.find(day => day.date === jobDate);
    const occurrences = day && scheduleDay(day, {}, jobDate, now, configuration.cutoffConfirmed);
    if (occurrences?.some(item => !item.cancelled && item.finish > now)) return 'not-due';
  }
  return 'due';
}

export { datesThrough };
