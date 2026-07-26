import {
  jsonResponse,
  postGoogle,
  readJson,
  runtimeConfig,
  sanitizeKioskRows
} from './_lib/m1-common.mjs';

export async function handleKioskSync(request, dependencies = {}) {
  const parsed = await readJson(request, 96_000);
  if (parsed.response) return parsed.response;

  const config = runtimeConfig(dependencies.env || process.env);
  if (!config) {
    return jsonResponse(503, {
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'Sign-in sync is not configured for this environment.'
    });
  }

  const rows = sanitizeKioskRows(parsed.value.rows);
  if (!rows) {
    return jsonResponse(400, {
      ok: false,
      code: 'REJECTED',
      message: 'The waiting sign-ins were rejected because their format was not safe.'
    });
  }

  const google = await postGoogle(
    config,
    'kioskSignIn',
    { rows },
    dependencies.fetch || fetch
  );
  if (!google.readable || !google.value || google.value.ok !== true || !Array.isArray(google.value.results)) {
    return jsonResponse(502, {
      ok: false,
      code: 'UNCLEAR_GOOGLE_RESPONSE',
      message: 'Google did not return a clear result. Every item is still waiting.'
    });
  }

  const submitted = new Set(rows.map(row => row.RowID));
  const results = google.value.results.filter(result =>
    result
    && typeof result === 'object'
    && submitted.has(String(result.rowId || result.RowID || ''))
    && ['added', 'already exists', 'rejected', 'failed'].includes(String(result.result || ''))
  );
  if (results.length !== rows.length) {
    return jsonResponse(502, {
      ok: false,
      code: 'UNCLEAR_GOOGLE_RESPONSE',
      message: 'Google returned an incomplete result. Every unclear item is still waiting.'
    });
  }

  return jsonResponse(200, {
    ok: true,
    test: config.preview,
    results
  });
}

export default request => handleKioskSync(request);
