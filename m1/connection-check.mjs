const ORIGIN = 'https://gib-richmond-live.netlify.app';
const PREFIX = 'gib_m1_richmond_production_';
const ENDPOINT = '/api/m1-tablet-status';

export function readTabletSummary(storage) {
  const unknown = { waiting: null, saved: null, automatic: null, last: null };
  try {
    const auto = storage.getItem(`${PREFIX}sync_auto_v1`);
    const lastValue = storage.getItem(`${PREFIX}sync_last`);
    const parsedLast = lastValue ? Date.parse(lastValue) : NaN;
    const summary = { ...unknown, automatic: auto === 'true', last: Number.isFinite(parsedLast) ? new Date(parsedLast).toISOString() : null };
    const raw = storage.getItem(`${PREFIX}local_state_v2`);
    if (raw !== null) {
      const state = JSON.parse(raw);
      if (state?.version !== 2 || !Array.isArray(state.ledger) || !Array.isArray(state.queue)) return summary;
      return { ...summary, waiting: state.queue.length, saved: state.ledger.length };
    }
    const queue = JSON.parse(storage.getItem(`${PREFIX}sync_queue_v1`) || '[]');
    const history = JSON.parse(storage.getItem(`${PREFIX}signins_v1`) || '[]');
    return { ...summary, waiting: Array.isArray(queue) ? queue.length : null, saved: Array.isArray(history) ? history.length : null };
  } catch { return unknown; }
}

export async function checkConnection({ origin, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (origin !== ORIGIN) return { kind: 'wrong-device-site' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reachedService = false;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', mode: 'same-origin', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}', signal: controller.signal
    });
    reachedService = true;
    const text = await response.text();
    if (!text || text.length > 1024) return { kind: 'unexpected-response' };
    let value;
    try { value = JSON.parse(text); } catch { return { kind: 'unexpected-response' }; }
    const exactRichmond = value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join('|') === 'activation|authorized|writesEnabled'
      && typeof value.authorized === 'boolean' && typeof value.writesEnabled === 'boolean'
      && ['active', 'pending'].includes(value.activation)
      && value.writesEnabled === (value.activation === 'active');
    if (response.status === 200 && exactRichmond) {
      if (!value.authorized) return { kind: 'not-authorized' };
      return { kind: value.writesEnabled ? 'connected' : 'sheet-unconfirmed' };
    }
    if (response.status === 503 && exactRichmond && value.authorized) return { kind: 'sheet-unconfirmed' };
    if (response.status === 429) return { kind: 'rate-limited' };
    return { kind: 'service-unavailable' };
  } catch {
    return { kind: reachedService ? 'incomplete-response' : 'no-response' };
  } finally { clearTimeout(timer); }
}

export function resultText(connection, local) {
  const result = (headline, explanation, service, authorization, sheet, tone = 'attention') => ({ headline, explanation, service, authorization, sheet, tone });
  switch (connection.kind) {
    case 'connected': {
      const explanation = 'This device reached the sign-in service, its authorization was accepted, and the service confirmed access and write permission with the Richmond production sheet.';
      if (local.automatic !== true) return result('Connection works; automatic sending needs attention', explanation, 'Reached', 'Accepted', 'Confirmed now');
      if (local.waiting === null) return result('Connection works; saved counts could not be read', explanation, 'Reached', 'Accepted', 'Confirmed now');
      if (local.waiting > 0) return result(`Connection works; ${local.waiting} sign-ins still waiting`, `${explanation} Return to sign-in to let it retry sending.`, 'Reached', 'Accepted', 'Confirmed now');
      return result('Connection to sheet confirmed now', explanation, 'Reached', 'Accepted', 'Confirmed now', 'good');
    }
    case 'not-authorized': return result('This browser is not authorized to send', 'The service responded. This may be a different device or browser from the installed tablet. Do not reset the tablet or clear its saved data.', 'Reached', 'Not accepted', 'Not checked');
    case 'sheet-unconfirmed': return result('Tablet accepted; sheet access needs attention', 'The tablet reached the service and was authorized. The service could not confirm the sheet connection and both write permissions. This points to the service-to-sheet check, not a missing Wi-Fi connection on this device.', 'Reached', 'Accepted', 'Not confirmed');
    case 'no-response': return result('No response from the sign-in service', 'The request failed or timed out. A Wi-Fi icon cannot establish access to this service. This result alone cannot distinguish the local network from a service outage.', 'No response', 'Unknown', 'Not checked');
    case 'incomplete-response': return result('The service response did not finish', 'The connection started, but no complete reply arrived within the time limit.', 'Incomplete response', 'Unknown', 'Not checked');
    case 'wrong-device-site': return result('Open this on the Richmond sign-in site', 'This check only runs on the Richmond production site, in the tablet’s usual browser.', 'Not checked', 'Not checked', 'Not checked');
    case 'rate-limited': return result('The service asked us to wait', 'Too many checks arrived together. Wait a minute before checking again.', 'Reached', 'Not checked', 'Not checked');
    default: return result('The service did not return a valid check', 'The request received a response, but it did not confirm Richmond tablet and sheet access. This is not a successful connection check.', 'Response received', 'Unknown', 'Not confirmed');
  }
}

if (typeof document !== 'undefined') {
  const byId = id => document.getElementById(id);
  const displayTime = value => value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'None recorded';
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    byId('again').disabled = true;
    byId('headline').textContent = 'Checking the connection…';
    byId('explanation').textContent = 'This can take up to 30 seconds.';
    byId('result').dataset.tone = '';
    for (const id of ['service', 'authorization', 'sheet']) byId(id).textContent = 'Checking…';
    byId('checked').textContent = '—';
    const getLocal = () => {
      try { return readTabletSummary(window.localStorage); }
      catch { return readTabletSummary({ getItem() { throw new Error('unavailable'); } }); }
    };
    const showLocal = local => {
      byId('automatic').textContent = local.automatic === null ? 'Unknown' : local.automatic ? 'On' : 'Off';
      byId('waiting').textContent = local.waiting === null ? 'Unknown' : String(local.waiting);
      byId('saved').textContent = local.saved === null ? 'Unknown' : String(local.saved);
      byId('last').textContent = displayTime(local.last);
    };
    showLocal(getLocal());
    try {
      const connection = await checkConnection({ origin: window.location.origin });
      const local = getLocal();
      showLocal(local);
      const result = resultText(connection, local);
      for (const id of ['headline', 'explanation', 'service', 'authorization', 'sheet']) byId(id).textContent = result[id];
      byId('result').dataset.tone = result.tone;
      byId('checked').textContent = displayTime(new Date().toISOString());
    } finally {
      running = false;
      byId('again').disabled = false;
    }
  };
  byId('again').addEventListener('click', run);
  run();
}
