import { createHash } from 'node:crypto';

const TEST_SHEET_ID = '1tC5W8unEHTXKeaUQ3CCYv3ZDhpLulb8_ee-ANOpwDLI';
const TEST_SHEET_TAB = 'Signins';
const TEST_SHEET_NAME = 'TEST ONLY - GiB M1 Instructor Sign-ins';
const TEST_SHEET_URL = `https://docs.google.com/spreadsheets/d/${TEST_SHEET_ID}/gviz/tq`;
const TIME_ZONE = 'America/New_York';
const SITE = 'Rev';
const DEVICE = 'TEST Admin Daily Review';
const BUILD = 'm1-daily-review-write-test';
const NETLIFY_SITE_ID = 'f748e737-11e3-4fab-8e8c-bf185eab29ff';
const MAX_BODY_BYTES = 4096;
const EXPECTED_HEADINGS = [
  'f',
  'Timestamp',
  'Date',
  'Class Label',
  'Duration (hr)',
  'Instructor',
  'Site',
  'Device',
  'Build',
  'Notes'
];
const SUCCESS_COUNT_KEYS = [
  'added',
  'appended',
  'created',
  'inserted',
  'received',
  'rowsAdded',
  'rowsWritten',
  'written',
  'count'
];

const REV_WEEKLY_SCHEDULE = {
  Monday: [
    '6:00 AM BJJ (Level 2)', '12:00 PM BJJ (Level 2)', '4:30 PM Yoga (Core)', '4:30 PM Kids’ BJJ',
    '4:30 PM BJJ (Level 1)', '5:30 PM BJJ (Level 2)', '5:30 PM Lapel Guard Class (Level 4)',
    '6:30 PM Takedown Drills (minimum white belt 2 stripes or yellow belt in judo)',
    '6:30 PM Muay Thai (Fundamentals/Intermediate, and intros when scheduled)',
    '6:30 PM Leglock Fundamentals (No-Gi, Level 3)', '7:00 PM BJJ (Level 2)',
    '7:00 PM No-Gi BJJ Intro Class/Level 1 BJJ'
  ],
  Tuesday: [
    '6:00 AM BJJ (Level 4) / Gi BJJ Intro Class', '6:00 AM No-Gi BJJ (Level 2)', '7:15 AM Conditioning',
    '12:00 PM BJJ (Level 2)', '4:30 PM Yoga (Flow)', '4:30 PM Kids’ BJJ', '5:30 PM BJJ (Level 2)',
    '5:30 PM Gi BJJ Intro Class / Level 1', '5:30 PM BJJ (Level 4)', '6:30 PM Muay Thai (Int/Adv)',
    '6:30 PM Guard Passing Class (Level 3)', '6:30 PM Judo', '7:00 PM BJJ Competition Class (Level 2, gi)'
  ],
  Wednesday: [
    '6:00 AM BJJ (Level 2)', '12:00 PM No-Gi BJJ (Level 2)', '4:30 PM Kids’ BJJ', '4:30 PM BJJ (Level 1)',
    '5:30 PM BJJ (Level 2)', '5:30 PM BJJ (Level 4)',
    '6:30 PM Muay Thai (Fundamentals/Intermediate, and intros when scheduled)',
    '6:30 PM BJJ Drills (Level 3)', '7:00 PM BJJ (Level 4)', '7:00 PM No-Gi BJJ Intro Class/Level 1 BJJ'
  ],
  Thursday: [
    '6:00 AM No-Gi BJJ (Level 4)', '6:00 AM No-Gi BJJ (Level 2) / Gi BJJ Intro Class', '7:15 AM Conditioning',
    '12:00 PM BJJ (Level 2)', '4:30 PM Kids’ BJJ', '5:00 PM Get Warm', '5:30 PM BJJ (Level 2)',
    '5:30 PM Gi BJJ Intro Class / Level 1', '5:30 PM No-Gi BJJ (Level 4)', '6:30 PM Muay Thai (Int/Adv)',
    '6:30 PM Advanced Leglocks (No-Gi, Level 3)', '6:30 PM Judo',
    '7:00 PM BJJ Competition Class (Level 2, no-gi)'
  ],
  Friday: [
    '6:00 AM Drill/Roll Class – BJJ', '12:00 PM Drill/Roll Class – BJJ', '4:30 PM Yoga (Flow)',
    '5:00 PM Takedown Drills (minimum white belt 2 stripes or yellow belt in judo)', '5:30 PM BJJ (Level 2)',
    '6:00 PM Muay Thai (Fundamentals/Intermediate)'
  ],
  Saturday: [
    '10:00 AM Kids’ BJJ', '10:00 AM Wrestling', '11:00 AM BJJ (Level 2)', '12:00 PM Conditioning'
  ],
  Sunday: [
    '12:00 PM BJJ Competition Class (Level 4, gi and no-gi)', '12:30 PM Get Warm', '1:00 PM BJJ Open Mat'
  ]
};

function clean(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function normalize(value) {
  return clean(value)
    .toLocaleLowerCase('en-US')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—―−]/g, '-');
}

function nyToday(now = new Date()) {
  const values = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now).forEach(part => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return `${values.year}-${values.month}-${values.day}`;
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dayNameForDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  ];
}

function durationForClass(classLabel) {
  return /\bkids[’']?\b/i.test(normalize(classLabel)) ? 0.5 : 1;
}

function stableRecordId({ date, instructor, classLabel, site }) {
  const source = JSON.stringify([date, normalize(instructor), normalize(classLabel), normalize(site)]);
  return `gib-test-admin-${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

function timestampInNewYork(now = new Date()) {
  const values = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).forEach(part => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function obviousTestValue(value) {
  return /\b(test|fake|demo|qa)\b|do not pay/i.test(clean(value));
}

function containsContactInfo(value) {
  const text = clean(value);
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
    || /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text);
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'The submitted data was not usable.' };
  }

  const allowedKeys = new Set(['date', 'classLabel', 'duration', 'instructor', 'site', 'notes', 'reason']);
  if (Object.keys(input).some(key => !allowedKeys.has(key))) {
    return { error: 'The submitted data included an unsupported field.' };
  }

  const value = {
    date: clean(input.date),
    classLabel: clean(input.classLabel),
    duration: Number(input.duration),
    instructor: clean(input.instructor),
    site: clean(input.site),
    notes: clean(input.notes),
    reason: clean(input.reason)
  };

  if (!validCalendarDate(value.date) || value.date > nyToday()) {
    return { error: 'Choose today or an earlier valid date.' };
  }
  if (value.site !== SITE) {
    return { error: 'Only Site Rev is allowed.' };
  }
  if (!value.classLabel || value.classLabel.length > 180) {
    return { error: 'The class is missing or too long.' };
  }

  const scheduled = REV_WEEKLY_SCHEDULE[dayNameForDate(value.date)] || [];
  const canonicalClass = scheduled.find(label => normalize(label) === normalize(value.classLabel));
  if (!canonicalClass) {
    return { error: 'The class is not in the stored Rev schedule for that date.' };
  }

  const expectedDuration = durationForClass(canonicalClass);
  if (!Number.isFinite(value.duration) || value.duration !== expectedDuration) {
    return { error: 'The duration does not match the stored class duration.' };
  }
  if (!value.instructor || value.instructor.length > 80 || !obviousTestValue(value.instructor)) {
    return { error: 'Use a clearly fake TEST instructor name, up to 80 characters.' };
  }
  if (/^[=+\-@]/.test(value.instructor)) {
    return { error: 'The fake instructor name cannot begin with a spreadsheet formula character.' };
  }
  if (!value.reason || value.reason.length < 3 || value.reason.length > 200) {
    return { error: 'Enter a reason between 3 and 200 characters.' };
  }
  if (value.notes.length > 300) {
    return { error: 'Notes must be 300 characters or fewer.' };
  }
  if (/^[=+\-@]/.test(value.notes) || /^[=+\-@]/.test(value.reason)) {
    return { error: 'Notes and reason cannot begin with a spreadsheet formula character.' };
  }
  if (containsContactInfo(`${value.instructor} ${value.notes} ${value.reason}`)) {
    return { error: 'Do not enter contact information in this TEST form.' };
  }

  value.classLabel = canonicalClass;
  value.duration = expectedDuration;
  return { value };
}

function googleDateString(value) {
  const text = clean(value);
  const match = text.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,.*)?\)$/);
  if (!match) return text;
  return `${match[1]}-${String(Number(match[2]) + 1).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
}

function cellText(cell) {
  if (!cell) return '';
  if (cell.f != null) return clean(cell.f);
  return googleDateString(cell.v);
}

function parseSheetResponse(text) {
  const source = clean(text);
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('TEST Sheet response was not readable.');

  let payload;
  try {
    payload = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new Error('TEST Sheet response was not readable.');
  }
  if (!payload || payload.status !== 'ok' || !payload.table) {
    throw new Error('TEST Sheet response was not usable.');
  }

  const headings = (payload.table.cols || []).map(column => clean(column && column.label));
  if (EXPECTED_HEADINGS.some((heading, index) => headings[index] !== heading)) {
    throw new Error('TEST Sheet headings did not match the expected TEST copy.');
  }

  const index = {};
  headings.forEach((heading, position) => {
    if (heading && index[heading] == null) index[heading] = position;
  });
  const value = (cells, heading) => index[heading] == null ? '' : cellText(cells[index[heading]]);

  return (payload.table.rows || []).map(row => {
    const cells = row && Array.isArray(row.c) ? row.c : [];
    return {
      date: value(cells, 'Date').slice(0, 10),
      classLabel: value(cells, 'Class Label'),
      instructor: value(cells, 'Instructor'),
      site: value(cells, 'Site'),
      duration: value(cells, 'Duration (hr)'),
      notes: value(cells, 'Notes'),
      status: value(cells, 'Status'),
      rowId: value(cells, 'RowID') || value(cells, 'f') || cellText(cells[0]),
      device: value(cells, 'Device'),
      build: value(cells, 'Build')
    };
  });
}

function isActive(row) {
  const status = clean(row.status).toUpperCase();
  return status !== 'VOID' && status !== 'VOIDED';
}

function sameEvent(row, record) {
  return isActive(row) && (
    (clean(row.rowId) && clean(row.rowId) === record.rowId)
    || (
      row.date === record.date
      && normalize(row.instructor) === normalize(record.instructor)
      && normalize(row.classLabel) === normalize(record.classLabel)
      && normalize(row.site) === normalize(record.site)
    )
  );
}

function sameClassSlot(row, record) {
  return isActive(row)
    && row.date === record.date
    && normalize(row.classLabel) === normalize(record.classLabel)
    && normalize(row.site) === normalize(record.site);
}

function verifyTestRows(rows) {
  if (rows.some(row => clean(row.instructor) && !obviousTestValue(row.instructor))) {
    throw new Error('TEST Sheet safety check failed.');
  }
  if (rows.some(row => clean(row.notes) && !obviousTestValue(row.notes))) {
    throw new Error('TEST Sheet safety check failed.');
  }
}

async function readTestSheet(fetchImpl = fetch) {
  const url = new URL(TEST_SHEET_URL);
  url.searchParams.set('sheet', TEST_SHEET_TAB);
  url.searchParams.set('tqx', 'out:json');
  url.searchParams.set('_', `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json,text/plain;q=0.9,*/*;q=0.1' },
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) throw new Error('TEST Sheet could not be read.');
  const text = await response.text();
  if (!text || text.length > 2_000_000) throw new Error('TEST Sheet response was not usable.');
  const rows = parseSheetResponse(text);
  verifyTestRows(rows);
  return rows;
}

function validateWebhookConfiguration(env) {
  const webhookUrl = clean(env.GIB_TEST_WEBHOOK_URL);
  const token = clean(env.GIB_TEST_WEBHOOK_TOKEN);
  if (!webhookUrl || token.length < 12 || token.length > 512) return null;

  let url;
  try {
    url = new URL(webhookUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'script.google.com'
    || !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return null;
  }
  return { webhookUrl: url.toString(), token };
}

function isAllowedDeployContext(runtimeContext) {
  return Boolean(runtimeContext && runtimeContext.deploy && runtimeContext.site)
    && runtimeContext.deploy.context === 'deploy-preview'
    && runtimeContext.deploy.published === false
    && runtimeContext.site.id === NETLIFY_SITE_ID;
}

function isAllowedPreviewRequest(_event, runtimeContext) {
  return isAllowedDeployContext(runtimeContext);
}

function parseGoogleAcknowledgement(text) {
  const source = clean(text);
  if (!source || source.length > 8192 || /<(?:!doctype|html|body)\b/i.test(source)) {
    return { readable: false };
  }

  let data;
  try {
    data = JSON.parse(source);
  } catch {
    if (/^[{[]/.test(source)) return { readable: false };
    if (/\b(error|failed|failure|exception|unauthorized|forbidden)\b/i.test(source)) {
      return { readable: true, success: false };
    }
    if (/^(ok|success|added)(?:\b|[.: -])/i.test(source)) {
      return { readable: true, success: true };
    }
    return { readable: true };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { readable: false };

  const candidates = [data, data.result, data.data].filter(
    item => item && typeof item === 'object' && !Array.isArray(item)
  );
  const explicitFailure = candidates.some(item => (
    item.ok === false
    || item.success === false
    || ['error', 'failed', 'failure'].includes(normalize(item.status))
    || clean(item.error)
  ));
  if (explicitFailure) return { readable: true, success: false };

  const explicitSuccess = candidates.some(item => (
    item.ok === true
    || item.success === true
    || ['ok', 'success'].includes(normalize(item.status))
  ));
  if (!explicitSuccess) return { readable: true };

  const counts = [];
  candidates.forEach(item => {
    SUCCESS_COUNT_KEYS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(item, key) && item[key] !== '') {
        const count = Number(item[key]);
        if (Number.isFinite(count)) counts.push(count);
      }
    });
  });
  if (counts.some(count => count !== 1)) return { readable: true, success: false };
  return { readable: true, success: true };
}

async function postOneRow(configuration, row, fetchImpl = fetch) {
  const response = await fetchImpl(configuration.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
      Accept: 'application/json'
    },
    body: JSON.stringify({ token: configuration.token, rows: [row] }),
    redirect: 'follow',
    signal: AbortSignal.timeout(6000)
  });
  const text = await response.text();
  if (!response.ok) return { readable: false };
  return parseGoogleAcknowledgement(text);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function confirmTestSheetWrite(record, fetchImpl = fetch) {
  const waits = [0, 750, 1500];
  for (const wait of waits) {
    if (wait) await delay(wait);
    let rows;
    try {
      rows = await readTestSheet(fetchImpl);
    } catch {
      continue;
    }
    const idMatches = rows.filter(row => isActive(row) && clean(row.rowId) === record.rowId);
    const tupleMatches = rows.filter(row => sameEvent(row, { ...record, rowId: '' }));
    const slotMatches = rows.filter(row => sameClassSlot(row, record));
    const exact = rows.filter(row => (
      isActive(row)
      && clean(row.rowId) === record.rowId
      && row.date === record.date
      && normalize(row.instructor) === normalize(record.instructor)
      && normalize(row.classLabel) === normalize(record.classLabel)
      && normalize(row.site) === normalize(record.site)
      && Number(row.duration) === Number(record.duration)
      && clean(row.device) === DEVICE
      && clean(row.build) === BUILD
      && clean(row.notes) === clean(record.notes)
    ));
    if (
      exact.length === 1
      && idMatches.length === 1
      && tupleMatches.length === 1
      && slotMatches.length === 1
      && exact[0] === idMatches[0]
      && exact[0] === tupleMatches[0]
      && exact[0] === slotMatches[0]
    ) {
      return true;
    }
    if (
      exact.length > 1
      || idMatches.length > 1
      || tupleMatches.length > 1
      || slotMatches.length > 1
    ) {
      return false;
    }
  }
  return false;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    },
    body: JSON.stringify(body)
  };
}

async function handler(event, _context, dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetch || fetch;
  const runtimeContext = dependencies.context || _context;

  if (event.httpMethod !== 'POST') {
    return response(405, { ok: false, message: 'Method not allowed.' });
  }
  if (!isAllowedPreviewRequest(event, runtimeContext)) {
    return response(403, { ok: false, message: 'This TEST function works only in its isolated Deploy Preview.' });
  }
  if (!event.body || Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) {
    return response(400, { ok: false, message: 'The submitted data was empty or too large.' });
  }
  if (!/^application\/json(?:;|$)/i.test(clean(event.headers && event.headers['content-type']))) {
    return response(415, { ok: false, message: 'Use JSON for this TEST request.' });
  }

  let input;
  try {
    input = JSON.parse(event.body);
  } catch {
    return response(400, { ok: false, message: 'The submitted data was not valid JSON.' });
  }

  const validated = validateInput(input);
  if (validated.error) return response(400, { ok: false, message: validated.error });

  const configuration = validateWebhookConfiguration(env);
  if (!configuration) {
    return response(503, { ok: false, message: 'The TEST write path is not configured for this Deploy Preview.' });
  }

  const value = validated.value;
  const record = {
    rowId: stableRecordId(value),
    date: value.date,
    classLabel: value.classLabel,
    duration: value.duration,
    instructor: value.instructor,
    site: SITE
  };

  let beforeRows;
  try {
    beforeRows = await readTestSheet(fetchImpl);
  } catch {
    return response(502, { ok: false, message: `The named ${TEST_SHEET_NAME} could not be safely read. Nothing was submitted.` });
  }
  if (beforeRows.some(row => sameClassSlot(row, record))) {
    return response(409, { ok: false, code: 'DUPLICATE', message: 'A sign-in already exists.' });
  }

  const noteParts = ['TEST Admin-added', `Reason: ${value.reason}`];
  if (value.notes) noteParts.push(`Notes: ${value.notes}`);
  const row = {
    RowID: record.rowId,
    Timestamp: timestampInNewYork(),
    Date: record.date,
    'Class Label': record.classLabel,
    'Duration (hr)': record.duration,
    Instructor: record.instructor,
    Site: record.site,
    Device: DEVICE,
    Build: BUILD,
    Notes: noteParts.join(' | ')
  };
  record.notes = row.Notes;

  let acknowledgement;
  try {
    acknowledgement = await postOneRow(configuration, row, fetchImpl);
  } catch {
    return response(502, {
      ok: false,
      code: 'UNCLEAR_GOOGLE_RESPONSE',
      message: 'Google did not return a clear readable result. Success is not being reported.'
    });
  }
  if (!acknowledgement.readable || acknowledgement.success === false) {
    return response(502, {
      ok: false,
      code: 'UNCLEAR_GOOGLE_RESPONSE',
      message: 'Google did not return a clear successful result. Success is not being reported.'
    });
  }

  try {
    const confirmed = await confirmTestSheetWrite(record, fetchImpl);
    if (!confirmed) {
      return response(502, {
        ok: false,
        code: 'UNCLEAR_GOOGLE_RESPONSE',
        message: 'The TEST Sheet did not confirm the new row. Success is not being reported.'
      });
    }
  } catch {
    return response(502, {
      ok: false,
      code: 'UNCLEAR_GOOGLE_RESPONSE',
      message: 'The TEST Sheet could not confirm the new row. Success is not being reported.'
    });
  }

  return response(200, {
    ok: true,
    recordId: record.rowId,
    message: 'The fake instructor was added to the TEST Sheet.'
  });
}

async function netlifyHandler(request, context) {
  if (!isAllowedDeployContext(context)) {
    const denied = response(403, {
      ok: false,
      message: 'This TEST function works only in its isolated Deploy Preview.'
    });
    return new Response(denied.body, {
      status: denied.statusCode,
      headers: denied.headers
    });
  }
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const result = await handler({
    httpMethod: request.method,
    headers,
    body: await request.text()
  }, context);
  return new Response(result.body, {
    status: result.statusCode,
    headers: result.headers
  });
}

const testExports = Object.freeze({
  BUILD,
  DEVICE,
  SITE,
  TEST_SHEET_ID,
  REV_WEEKLY_SCHEDULE,
  clean,
  normalize,
  nyToday,
  durationForClass,
  stableRecordId,
  validateInput,
  parseSheetResponse,
  sameEvent,
  sameClassSlot,
  validateWebhookConfiguration,
  isAllowedDeployContext,
  isAllowedPreviewRequest,
  parseGoogleAcknowledgement,
  response,
  handler
});

export default netlifyHandler;
export { handler, testExports as _test };
