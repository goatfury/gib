// Diagnostic control copied verbatim from c0809db06db9da12e249b52c24c49584d8e6c883.
// Used only by explicitly selected, read-only TEST probes.
export async function postGoogle(config, action, data, fetchImpl = fetch) {
  let response;
  try {
    const body = {
      ...data,
      token: config.webhookToken,
      action,
      target: config.target || (config.preview ? 'test' : 'production')
    };
    if (config.installationId === 'richmond') {
      body.installation = 'richmond';
      body.environment = config.environment;
    }
    // Preserve the proven TEST wire contract (including its empty Admin field)
    // and production Admin actions, while the production kiosk forwards only
    // rows plus its pinned kiosk authentication, action, and target.
    if (config.preview || config.adminActionToken) {
      body.adminActionToken = config.adminActionToken;
    }
    response = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        Accept: 'application/json'
      },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000)
    });
  } catch {
    return { readable: false, status: 0, failureClass: 'UNREACHABLE' };
  }

  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength != null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > 256_000)
  ) {
    return { readable: false, status: response.status, failureClass: 'OVERSIZE' };
  }
  // Apps Script may omit Content-Length. Keep the post-read byte cap as the
  // fail-closed fallback for chunked/missing-length responses.
  let text;
  try {
    text = (await response.text()).trim();
  } catch {
    return { readable: false, status: response.status, failureClass: 'READ_FAILED' };
  }
  if (!response.ok) {
    return { readable: false, status: response.status, failureClass: 'HTTP_FAILURE' };
  }
  if (!text) {
    return { readable: false, status: response.status, failureClass: 'EMPTY' };
  }
  if (Buffer.byteLength(text, 'utf8') > 256_000) {
    return { readable: false, status: response.status, failureClass: 'OVERSIZE' };
  }
  if (/<(?:!doctype|html|body)\b/i.test(text)) {
    return { readable: false, status: response.status, failureClass: 'HTML' };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { readable: false, status: response.status, failureClass: 'UNSUPPORTED_JSON' };
    }
    return { readable: true, status: response.status, value };
  } catch {
    return { readable: false, status: response.status, failureClass: 'MALFORMED_JSON' };
  }
}
