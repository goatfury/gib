const allowedOrigin = 'https://deploy-preview-86--gib-live.netlify.app';
const status = document.getElementById('status');
const connect = document.getElementById('connect');
const check = document.getElementById('check');
let busy = false;
let canConnect = false;
let callbackFailure = null;

function readCallbackFailure(search) {
  if (!search || search.length > 1000) return null;
  const query = new URLSearchParams(search);
  const allowed = ['result','phase','code','ms','httpStatus','expectedScopesPresent','unexpectedScopeCount','openidPresent'];
  if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)
    || !['failed','denied','expired'].includes(query.get('result'))
    || !['token','identity','api','state','storage','configuration','setup','authorization','other'].includes(query.get('phase'))
    || !['STATE','STORE','TOKEN_RESPONSE','TOKEN_SCOPE','TOKEN_IDENTITY','ACCESS_DENIED','TOKEN_REVOKED','REDIRECT','INVALID_JSON',
      'RESPONSE_TOO_LARGE','HTTP_ERROR','API_RESULT','INITIALIZE','SETUP_DISABLED','TIMEOUT','ABORTED','NETWORK','CONFIG','NOT_CONNECTED','OTHER'].includes(query.get('code'))
    || !/^(0|[1-9][0-9]{0,6})$/u.test(query.get('ms') || '') || Number(query.get('ms')) > 3600000) return null;
  const report = { phase:query.get('phase'),code:query.get('code'),ms:Number(query.get('ms')) };
  if (query.has('httpStatus')) {
    if (!/^[1-5][0-9]{2}$/u.test(query.get('httpStatus'))) return null;
    report.httpStatus = Number(query.get('httpStatus'));
  }
  if (['expectedScopesPresent','unexpectedScopeCount','openidPresent'].some(key => query.has(key))) {
    if (report.code !== 'TOKEN_SCOPE' || !['true','false'].includes(query.get('expectedScopesPresent')) || !['true','false'].includes(query.get('openidPresent'))
      || !/^(0|[1-9]|1[0-9]|20)$/u.test(query.get('unexpectedScopeCount') || '')) return null;
    report.expectedScopesPresent = query.get('expectedScopesPresent') === 'true';
    report.unexpectedScopeCount = Number(query.get('unexpectedScopeCount'));
    report.openidPresent = query.get('openidPresent') === 'true';
  }
  return report;
}

function showCallbackFailure() {
  if (!callbackFailure) return;
  const report = callbackFailure;
  status.textContent += ` Last connection attempt reported ${report.phase} / ${report.code} after ${report.ms} ms`
    + (report.httpStatus === undefined ? '' : ` (HTTP ${report.httpStatus})`)
    + (report.expectedScopesPresent === undefined ? '' : `; expected scopes present: ${report.expectedScopesPresent}; unexpected scopes: ${report.unexpectedScopeCount}; OpenID present: ${report.openidPresent}`)
    + '. This callback report does not establish connection status.';
}

async function request(operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/m1-promotions-api-oauth', {
      method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal,
      headers:{'Content-Type':'application/json', Accept:'application/json'}, body:JSON.stringify({operation})
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true || !result.data || typeof result.data !== 'object') throw new Error('Setup could not be confirmed.');
    return result.data;
  } finally { clearTimeout(timer); }
}

async function run(operation) {
  if (busy || location.origin !== allowedOrigin || (operation === 'start' && !canConnect)) return;
  busy = true; connect.disabled = true; check.disabled = true;
  try {
    const data = await request(operation);
    if (operation === 'start') {
      const destination = new URL(data.authorizationUrl);
      if (destination.origin !== 'https://accounts.google.com' || destination.pathname !== '/o/oauth2/v2/auth'
        || destination.username || destination.password || destination.hash) throw new Error('Unexpected authorization destination.');
      location.assign(destination.href);
      return;
    }
    if (!['configured','connected','setupEnabled'].every(key => typeof data[key] === 'boolean')) throw new Error('Unexpected setup status.');
    canConnect = data.configured && data.setupEnabled && !data.connected;
    status.textContent = data.connected ? 'Google is connected for the TEST reader. The engineering acceptance check is next.'
      : !data.configured ? 'Private server setup is still being prepared. No Google connection has been established.'
        : data.setupEnabled ? 'Ready for the existing Ops account to authorize the TEST reader.' : 'Owner setup is closed.';
    if (!data.connected) showCallbackFailure();
  } catch (_) {
    canConnect = false;
    status.textContent = 'The setup status could not be confirmed. No successful connection is being claimed.';
    showCallbackFailure();
  } finally { busy = false; connect.disabled = !canConnect; check.disabled = false; }
}

connect.addEventListener('click', () => run('start'));
check.addEventListener('click', () => run('status'));
if (location.origin === allowedOrigin) {
  // Only enumerated failure facts survive scrubbing. Authenticated status alone
  // controls connection claims and actions; query text is never authoritative.
  callbackFailure = readCallbackFailure(location.search);
  if (location.search) history.replaceState(null, '', location.pathname);
  run('status');
} else {
  check.disabled = true;
  status.textContent = 'This setup is available only on the approved PR86 TEST origin.';
}
