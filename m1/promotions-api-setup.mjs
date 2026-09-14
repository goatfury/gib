const allowedOrigin = 'https://deploy-preview-86--gib-live.netlify.app';
const status = document.getElementById('status');
const connect = document.getElementById('connect');
const check = document.getElementById('check');
let busy = false;
let canConnect = false;

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
  } catch (_) {
    canConnect = false;
    status.textContent = 'The setup status could not be confirmed. No successful connection is being claimed.';
  } finally { busy = false; connect.disabled = !canConnect; check.disabled = false; }
}

connect.addEventListener('click', () => run('start'));
check.addEventListener('click', () => run('status'));
if (location.origin === allowedOrigin) {
  // Callback result text is untrusted; only the authenticated status is used.
  if (location.search) history.replaceState(null, '', location.pathname);
  run('status');
} else {
  check.disabled = true;
  status.textContent = 'This setup is available only on the approved PR86 TEST origin.';
}
