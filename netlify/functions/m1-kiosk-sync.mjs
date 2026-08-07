import {
  jsonResponse,
  obviousTestValue,
  postGoogle,
  readJson,
  runtimeConfig,
  validNonFutureDate
} from './_lib/m1-common.mjs';

export const KIOSK_SYNC_PATH = '/api/m1-kiosk-sync';
export const MAX_KIOSK_SYNC_ROWS = 50;

export const config = {
  // Netlify extracts function routing metadata statically during the build.
  // Keep this value literal so the Deploy Preview route is actually emitted.
  path: '/api/m1-kiosk-sync',
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

const MAX_REQUEST_BYTES = 256_000;
const DEPLOY_PREVIEW_HOST = /^deploy-preview-\d+--gib-live\.netlify\.app$/u;
const ROW_ID_PATTERN = /^gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/u;
const ACCEPTED_RESULT_VALUES = new Set([
  'added',
  'already exists',
  'review required',
  'rejected',
  'failed'
]);
const REQUIRED_ROW_KEYS = Object.freeze([
  'RowID',
  'Timestamp',
  'Date',
  'Class Label',
  'Duration (hr)',
  'Instructor',
  'Site'
]);
const OPTIONAL_ROW_KEYS = Object.freeze(['Device', 'Build', 'Notes']);
const ALLOWED_ROW_KEYS = new Set([...REQUIRED_ROW_KEYS, ...OPTIONAL_ROW_KEYS]);

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function validPreviewSameOriginRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }

  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.pathname !== KIOSK_SYNC_PATH
    || url.search
    || url.hash
    || !DEPLOY_PREVIEW_HOST.test(url.hostname)
  ) {
    return false;
  }

  const hostHeader = request.headers.get('host');
  if (hostHeader && hostHeader.toLocaleLowerCase('en-US') !== url.host.toLocaleLowerCase('en-US')) {
    return false;
  }
  if (request.headers.get('origin') !== url.origin) return false;

  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin';
}

function exactText(value, maxLength, allowBlank = false) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) return null;
  const text = value.normalize('NFKC').trim();
  if (
    (!allowBlank && !text)
    || text.length > maxLength
    || FORMULA_PREFIX_PATTERN.test(text)
  ) {
    return null;
  }
  return text;
}

function cleanText(value, maxLength, allowBlank = false) {
  const text = exactText(value, maxLength, allowBlank);
  return text == null ? null : text.replace(/\s+/gu, ' ');
}

function validRowShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return REQUIRED_ROW_KEYS.every(key => keys.includes(key))
    && keys.every(key => ALLOWED_ROW_KEYS.has(key));
}

function validateRow(input, now) {
  if (!validRowShape(input)) return null;

  const rowId = typeof input.RowID === 'string' && ROW_ID_PATTERN.test(input.RowID)
    ? input.RowID
    : '';
  const timestamp = exactText(input.Timestamp, 19);
  const date = typeof input.Date === 'string' ? input.Date : '';
  const classLabel = exactText(input['Class Label'], 200);
  const duration = input['Duration (hr)'];
  const instructor = exactText(input.Instructor, 100);
  const site = exactText(input.Site, 80);
  const device = Object.hasOwn(input, 'Device') ? cleanText(input.Device, 120, true) : '';
  const build = Object.hasOwn(input, 'Build') ? cleanText(input.Build, 120, true) : '';
  const notes = Object.hasOwn(input, 'Notes') ? exactText(input.Notes, 400, true) : '';

  if (
    !rowId
    || !timestamp
    || !TIMESTAMP_PATTERN.test(timestamp)
    || timestamp.slice(0, 10) !== date
    || !validNonFutureDate(date, now)
    || !classLabel
    || typeof duration !== 'number'
    || !Number.isFinite(duration)
    || duration <= 0
    || duration > 8
    || !instructor
    || !obviousTestValue(instructor)
    || !site
    || device == null
    || build == null
    || notes == null
  ) {
    return null;
  }

  return {
    RowID: rowId,
    Timestamp: timestamp,
    Date: date,
    'Class Label': classLabel,
    'Duration (hr)': duration,
    Instructor: instructor,
    Site: site,
    Device: device,
    Build: build,
    Notes: notes
  };
}

function rejectedResult(input) {
  return {
    rowId: typeof input?.RowID === 'string' && ROW_ID_PATTERN.test(input.RowID)
      ? input.RowID
      : '',
    result: 'rejected',
    linkedRecordId: ''
  };
}

function validLinkedRecordId(value) {
  if (typeof value !== 'string' || value.length > 240 || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  return !value || (!FORMULA_PREFIX_PATTERN.test(value) && value === value.normalize('NFKC').trim());
}

function validResultLink(item) {
  if (item.result === 'added') return item.linkedRecordId === item.rowId;
  if (item.result === 'already exists' || item.result === 'review required') {
    return Boolean(item.linkedRecordId);
  }
  return item.linkedRecordId === '';
}

function sanitizeGoogleResults(google, forwardedRows) {
  if (
    !google.readable
    || !google.value
    || !exactObjectKeys(google.value, ['ok', 'results', 'target'])
    || google.value.ok !== true
    || google.value.target !== 'test'
    || !Array.isArray(google.value.results)
    || google.value.results.length !== forwardedRows.length
  ) {
    return null;
  }

  const expected = new Set(forwardedRows.map(row => row.RowID));
  const observed = new Map();
  for (const item of google.value.results) {
    if (
      !exactObjectKeys(item, ['linkedRecordId', 'result', 'rowId'])
      || typeof item.rowId !== 'string'
      || !expected.has(item.rowId)
      || observed.has(item.rowId)
      || typeof item.result !== 'string'
      || !ACCEPTED_RESULT_VALUES.has(item.result)
      || !validLinkedRecordId(item.linkedRecordId)
      || !validResultLink(item)
    ) {
      return null;
    }
    observed.set(item.rowId, {
      rowId: item.rowId,
      result: item.result,
      linkedRecordId: item.linkedRecordId
    });
  }

  if (observed.size !== expected.size) return null;
  return forwardedRows.map(row => observed.get(row.RowID));
}

function previewRuntimeConfig(env, requestUrl) {
  return runtimeConfig({
    GIB_TEST_WEBHOOK_URL: env.GIB_TEST_WEBHOOK_URL,
    GIB_TEST_WEBHOOK_TOKEN: env.GIB_TEST_WEBHOOK_TOKEN
  }, { requestUrl });
}

export async function handleKioskSync(request, dependencies = {}) {
  if (!validPreviewSameOriginRequest(request)) {
    return jsonResponse(403, {
      ok: false,
      message: 'Deploy Preview same-origin sync required.'
    });
  }

  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.response) return parsed.response;
  if (!exactObjectKeys(parsed.value, ['rows']) || !Array.isArray(parsed.value.rows)) {
    return jsonResponse(400, { ok: false, message: 'Rows were rejected.' });
  }

  const inputRows = parsed.value.rows;
  if (inputRows.length < 1 || inputRows.length > MAX_KIOSK_SYNC_ROWS) {
    return jsonResponse(400, { ok: false, message: 'Rows were rejected.' });
  }

  const validInputIds = inputRows
    .map(row => row && typeof row.RowID === 'string' && ROW_ID_PATTERN.test(row.RowID) ? row.RowID : '')
    .filter(Boolean);
  if (new Set(validInputIds).size !== validInputIds.length) {
    return jsonResponse(400, { ok: false, message: 'Duplicate RowIDs were rejected.' });
  }

  const now = dependencies.dateNow || new Date();
  const validatedRows = inputRows.map(row => validateRow(row, now));
  const forwardedRows = validatedRows.filter(Boolean);
  const localResults = validatedRows.map((row, index) => row ? null : rejectedResult(inputRows[index]));

  if (!forwardedRows.length) {
    return jsonResponse(200, {
      ok: true,
      test: true,
      results: localResults
    });
  }

  const env = dependencies.env || process.env;
  const runtime = previewRuntimeConfig(env, request.url);
  if (!runtime || runtime.preview !== true) {
    return jsonResponse(503, {
      ok: false,
      message: 'TEST sync is not configured.'
    });
  }

  const google = await postGoogle(
    runtime,
    'kioskSignIn',
    { rows: forwardedRows },
    dependencies.fetch || fetch
  );
  const upstreamResults = sanitizeGoogleResults(google, forwardedRows);
  if (!upstreamResults) {
    return jsonResponse(google.status === 0 ? 504 : 502, {
      ok: false,
      message: google.status === 0
        ? 'TEST sync timed out or could not be reached.'
        : 'TEST sync did not return a complete readable acknowledgment.'
    });
  }

  const byRowId = new Map(upstreamResults.map(result => [result.rowId, result]));
  return jsonResponse(200, {
    ok: true,
    test: true,
    results: validatedRows.map((row, index) => row ? byRowId.get(row.RowID) : localResults[index])
  });
}

export default request => handleKioskSync(request);
