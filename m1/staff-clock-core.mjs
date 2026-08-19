export const STAFF_CLOCK_TIME_ZONE = 'America/New_York';
export const STAFF_PAY_PERIOD_ANCHOR = '2026-08-10';
export const STAFF_OPEN_SHIFT_LIMIT_MS = 18 * 60 * 60 * 1_000;
export const STAFF_PUNCH_ID_PATTERN = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const DAY_MS = 24 * 60 * 60 * 1_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u;
const STAFF_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,79})$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/u;
const REQUIRED_RECORD_KEYS = Object.freeze([
  'punchId',
  'timestamp',
  'date',
  'staffId',
  'staffName',
  'punchAction',
  'site',
  'device',
  'build',
  'note',
  'status',
  'source'
]);
const OPTIONAL_RECORD_KEYS = Object.freeze(['adminName', 'linkedPunchId']);
const ALLOWED_RECORD_KEYS = new Set([...REQUIRED_RECORD_KEYS, ...OPTIONAL_RECORD_KEYS]);
const RECORD_ACTIONS = new Set(['clockIn', 'clockOut']);
const RECORD_STATUSES = new Set(['ACTIVE', 'VOID']);
const RECORD_SOURCES = new Set(['Tablet', 'Admin-added']);
const NEW_YORK_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: STAFF_CLOCK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function exactObjectKeys(value, required, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => allowed.has(key));
}

function validText(value, maxLength, allowEmpty = false) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) return false;
  if (value !== value.normalize('NFKC').trim()) return false;
  if ((!allowEmpty && !value) || value.length > maxLength) return false;
  return !value || !FORMULA_PREFIX_PATTERN.test(value);
}

function dateParts(value) {
  const match = typeof value === 'string' ? value.match(DATE_PATTERN) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = Date.UTC(year, month - 1, day);
  const parsed = new Date(instant);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return { year, month, day, instant };
}

function newYorkParts(value) {
  const parts = {};
  NEW_YORK_PARTS_FORMATTER.formatToParts(value).forEach(part => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}-${parts.minute}-${parts.second}`.replaceAll('-', ':')
  };
}

function validNow(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid current time is required.');
  return date;
}

function compareRecords(left, right) {
  return Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.punchId.localeCompare(right.punchId, 'en-US');
}

function recordFingerprint(record) {
  return JSON.stringify([
    ...REQUIRED_RECORD_KEYS.map(key => record[key]),
    record.adminName || '',
    record.linkedPunchId || ''
  ]);
}

function attentionItem(code, staffId, record = null, detail = {}) {
  return {
    code,
    staffId,
    punchId: record?.punchId || detail.punchId || '',
    timestamp: record?.timestamp || detail.timestamp || '',
    date: record?.date || detail.date || '',
    ...detail
  };
}

function uniqueAttention(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = JSON.stringify([
      item.code,
      item.staffId,
      item.punchId,
      item.timestamp,
      item.date
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function periodContains(period, date) {
  return date >= period.startDate && date <= period.endDate;
}

function addUtcDays(date, days) {
  const parsed = dateParts(date);
  if (!parsed) throw new Error('A valid calendar date is required.');
  return new Date(parsed.instant + (days * DAY_MS)).toISOString().slice(0, 10);
}

function allStaffIdentities(staffMembers, records, attention) {
  const identities = new Map();
  records.forEach(record => identities.set(record.staffId, record.staffName));
  staffMembers.forEach(member => identities.set(member.staffId, member.staffName));
  attention.forEach(item => {
    if (item.staffId && !identities.has(item.staffId)) identities.set(item.staffId, item.staffId);
  });
  return [...identities.entries()]
    .map(([staffId, staffName]) => ({ staffId, staffName }))
    .sort((left, right) => left.staffName.localeCompare(right.staffName, 'en-US'));
}

function periodSummary(period, states) {
  return {
    ...period,
    staffTotals: states.map(state => {
      const shifts = state.completedShifts.filter(shift => periodContains(period, shift.date));
      const totalMilliseconds = shifts.reduce((total, shift) => total + shift.elapsedMilliseconds, 0);
      const relevantAttention = state.attention.filter(item => (
        item.date ? periodContains(period, item.date) : true
      ));
      return {
        staffId: state.staffId,
        staffName: state.staffName,
        completedShifts: shifts.length,
        totalMilliseconds,
        formattedTotal: formatStaffElapsed(totalMilliseconds),
        needsAttention: relevantAttention.length > 0
      };
    })
  };
}

export function validStaffDate(value) {
  return Boolean(dateParts(value));
}

export function validStaffTimestamp(value) {
  const match = typeof value === 'string' ? value.match(TIMESTAMP_PATTERN) : null;
  if (!match) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const parts = newYorkParts(parsed);
  return parts.date === match[1] && parts.time === match[2];
}

export function validStaffPunchId(value) {
  return typeof value === 'string' && STAFF_PUNCH_ID_PATTERN.test(value);
}

export function createStaffPunchId(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
    throw new Error('Secure Staff Clock identity is unavailable.');
  }
  const uuid = cryptoApi.randomUUID().toLowerCase();
  const punchId = `gib-m1-staff-${uuid}`;
  if (!validStaffPunchId(punchId)) {
    throw new Error('Secure Staff Clock identity could not be created.');
  }
  return punchId;
}

export function validStaffMember(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'staffId' || keys[1] !== 'staffName') return false;
  return typeof value.staffId === 'string'
    && STAFF_ID_PATTERN.test(value.staffId)
    && validText(value.staffName, 100);
}

export function validStaffRecord(value) {
  if (!exactObjectKeys(value, REQUIRED_RECORD_KEYS, ALLOWED_RECORD_KEYS)) return false;
  if (
    !validStaffPunchId(value.punchId)
    || !validStaffTimestamp(value.timestamp)
    || !validStaffDate(value.date)
    || value.timestamp.slice(0, 10) !== value.date
    || typeof value.staffId !== 'string'
    || !STAFF_ID_PATTERN.test(value.staffId)
    || !validText(value.staffName, 100)
    || !RECORD_ACTIONS.has(value.punchAction)
    || !validText(value.site, 80)
    || !validText(value.device, 120)
    || !validText(value.build, 120)
    || !validText(value.note, 400, true)
    || !RECORD_STATUSES.has(value.status)
    || !RECORD_SOURCES.has(value.source)
  ) return false;
  if (
    Object.hasOwn(value, 'adminName')
    && value.adminName !== ''
    && !validText(value.adminName, 80)
  ) return false;
  if (
    Object.hasOwn(value, 'linkedPunchId')
    && value.linkedPunchId !== ''
    && !validStaffPunchId(value.linkedPunchId)
  ) return false;
  return true;
}

export function sameStaffRecord(left, right) {
  return validStaffRecord(left)
    && validStaffRecord(right)
    && recordFingerprint(left) === recordFingerprint(right);
}

export function mergeStaffRecords(confirmedRecords = [], pendingRecords = []) {
  if (!Array.isArray(confirmedRecords) || !Array.isArray(pendingRecords)) {
    throw new Error('Confirmed and pending Staff Clock records must be arrays.');
  }
  if (!confirmedRecords.every(validStaffRecord) || !pendingRecords.every(validStaffRecord)) {
    throw new Error('A Staff Clock record was invalid.');
  }

  const group = records => {
    const byId = new Map();
    records.forEach(record => {
      if (!byId.has(record.punchId)) byId.set(record.punchId, []);
      byId.get(record.punchId).push(record);
    });
    return byId;
  };
  const confirmedById = group(confirmedRecords);
  const pendingById = group(pendingRecords);
  const punchIds = new Set([...confirmedById.keys(), ...pendingById.keys()]);
  const records = [];
  const attention = [];

  [...punchIds].sort().forEach(punchId => {
    const confirmed = confirmedById.get(punchId) || [];
    const pending = pendingById.get(punchId) || [];
    const confirmedFingerprints = new Set(confirmed.map(recordFingerprint));
    const pendingFingerprints = new Set(pending.map(recordFingerprint));

    if (confirmedFingerprints.size > 1) {
      const affected = new Set([...confirmed, ...pending].map(record => record.staffId));
      affected.forEach(staffId => attention.push(attentionItem(
        'CONFLICTING_DUPLICATE', staffId, null, { punchId }
      )));
      return;
    }

    if (confirmed.length) {
      const chosen = confirmed[0];
      records.push(chosen);
      pending.forEach(record => {
        if (!sameStaffRecord(chosen, record)) {
          new Set([chosen.staffId, record.staffId]).forEach(staffId => {
            attention.push(attentionItem('CONFLICTING_DUPLICATE', staffId, chosen));
          });
        }
      });
      return;
    }

    if (pendingFingerprints.size > 1) {
      new Set(pending.map(record => record.staffId)).forEach(staffId => {
        attention.push(attentionItem('CONFLICTING_DUPLICATE', staffId, null, { punchId }));
      });
      return;
    }
    if (pending.length) records.push(pending[0]);
  });

  return {
    records: records.sort(compareRecords),
    attention: uniqueAttention(attention)
  };
}

export function evaluateStaffState(staffId, records = [], options = {}) {
  if (typeof staffId !== 'string' || !STAFF_ID_PATTERN.test(staffId)) {
    throw new Error('A valid Staff ID is required.');
  }
  if (!Array.isArray(records) || !records.every(validStaffRecord)) {
    throw new Error('Staff Clock records were invalid.');
  }
  const now = validNow(options.now ?? new Date());
  const suppliedAttention = Array.isArray(options.attention) ? options.attention : [];
  const externalAttention = suppliedAttention.filter(item => item?.staffId === staffId);
  const active = records
    .filter(record => record.staffId === staffId && record.status === 'ACTIVE')
    .sort(compareRecords);
  const staffName = active.at(-1)?.staffName
    || records.filter(record => record.staffId === staffId).at(-1)?.staffName
    || options.staffName
    || staffId;
  const attention = [...externalAttention];
  const completedShifts = [];
  let openClockIn = null;
  let latestRecord = null;
  let structuralContradiction = false;

  for (let index = 0; index < active.length && !structuralContradiction; index += 1) {
    const record = active[index];
    const next = active[index + 1];
    if (next && Date.parse(next.timestamp) === Date.parse(record.timestamp)) {
      attention.push(attentionItem('SIMULTANEOUS_PUNCHES', staffId, record));
      structuralContradiction = true;
      break;
    }
    if (!openClockIn) {
      if (record.punchAction === 'clockOut') {
        attention.push(attentionItem(
          latestRecord?.punchAction === 'clockOut'
            ? 'REPEATED_CLOCK_OUT'
            : 'CLOCK_OUT_WITHOUT_CLOCK_IN',
          staffId,
          record
        ));
        structuralContradiction = true;
        break;
      }
      openClockIn = record;
      latestRecord = record;
      continue;
    }
    if (record.punchAction === 'clockIn') {
      attention.push(attentionItem('REPEATED_CLOCK_IN', staffId, record));
      structuralContradiction = true;
      break;
    }

    const elapsedMilliseconds = Date.parse(record.timestamp) - Date.parse(openClockIn.timestamp);
    if (elapsedMilliseconds <= 0) {
      attention.push(attentionItem('NON_POSITIVE_SHIFT', staffId, record));
      structuralContradiction = true;
      break;
    }
    completedShifts.push({
      staffId,
      staffName: record.staffName,
      date: openClockIn.date,
      clockIn: openClockIn,
      clockOut: record,
      elapsedMilliseconds
    });
    if (elapsedMilliseconds > STAFF_OPEN_SHIFT_LIMIT_MS) {
      attention.push(attentionItem('UNREASONABLY_LONG_SHIFT', staffId, openClockIn));
    }
    openClockIn = null;
    latestRecord = record;
  }

  if (!structuralContradiction && openClockIn) {
    const today = newYorkParts(now).date;
    const elapsed = now.getTime() - Date.parse(openClockIn.timestamp);
    if (elapsed < 0) {
      attention.push(attentionItem('FUTURE_PUNCH', staffId, openClockIn));
      structuralContradiction = true;
    } else if (openClockIn.date < today || elapsed > STAFF_OPEN_SHIFT_LIMIT_MS) {
      attention.push(attentionItem('MISSING_CLOCK_OUT', staffId, openClockIn));
    }
  }

  const needsAttention = attention.length > 0;
  const stateUnknown = structuralContradiction || externalAttention.length > 0;
  const clockedIn = stateUnknown ? null : Boolean(openClockIn);
  return {
    staffId,
    staffName,
    clockedIn,
    clockInRecord: clockedIn ? openClockIn : null,
    latestRecord,
    nextPunchAction: needsAttention ? null : (clockedIn ? 'clockOut' : 'clockIn'),
    needsAttention,
    attention: uniqueAttention(attention),
    completedShifts
  };
}

export function payPeriodRange(referenceDate, offset = 0) {
  if (!Number.isInteger(offset)) throw new Error('Pay-period offset must be an integer.');
  const reference = dateParts(referenceDate);
  const anchor = dateParts(STAFF_PAY_PERIOD_ANCHOR);
  if (!reference || !anchor) throw new Error('A valid pay-period date is required.');
  const daysFromAnchor = Math.floor((reference.instant - anchor.instant) / DAY_MS);
  const periodIndex = Math.floor(daysFromAnchor / 14) + offset;
  const startDate = addUtcDays(STAFF_PAY_PERIOD_ANCHOR, periodIndex * 14);
  return { startDate, endDate: addUtcDays(startDate, 13) };
}

export function payPeriodOptions(referenceDate) {
  return {
    current: {
      key: 'current',
      label: 'Current pay period',
      ...payPeriodRange(referenceDate, 0)
    },
    previous: {
      key: 'previous',
      label: 'Previous pay period',
      ...payPeriodRange(referenceDate, -1)
    }
  };
}

export function formatStaffElapsed(elapsedMilliseconds) {
  if (
    typeof elapsedMilliseconds !== 'number'
    || !Number.isFinite(elapsedMilliseconds)
    || elapsedMilliseconds < 0
  ) throw new Error('Elapsed time must be a non-negative finite number.');
  const totalMinutes = Math.floor(elapsedMilliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} hr ${minutes} min`;
}

export function buildStaffReview({
  confirmedRecords = [],
  pendingRecords = [],
  staffMembers = [],
  now = new Date()
} = {}) {
  if (!Array.isArray(staffMembers) || !staffMembers.every(validStaffMember)) {
    throw new Error('The active Staff Clock list was invalid.');
  }
  if (new Set(staffMembers.map(member => member.staffId)).size !== staffMembers.length) {
    throw new Error('The active Staff Clock list contained duplicate IDs.');
  }
  const currentTime = validNow(now);
  const today = newYorkParts(currentTime).date;
  const merged = mergeStaffRecords(confirmedRecords, pendingRecords);
  const identities = allStaffIdentities(staffMembers, merged.records, merged.attention);
  const staffStates = identities.map(member => evaluateStaffState(
    member.staffId,
    merged.records,
    { now: currentTime, attention: merged.attention, staffName: member.staffName }
  ));
  const attention = uniqueAttention(staffStates.flatMap(state => state.attention));
  const periods = payPeriodOptions(today);

  return {
    today,
    records: merged.records,
    staffStates,
    clockedInNow: staffStates.filter(state => state.clockedIn === true),
    todayPunches: merged.records
      .filter(record => record.date === today)
      .sort(compareRecords),
    attention,
    payPeriods: {
      current: periodSummary(periods.current, staffStates),
      previous: periodSummary(periods.previous, staffStates)
    }
  };
}
