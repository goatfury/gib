import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { randomBytes } from 'node:crypto';

// Observe Node's actual automatic redirects without replacing fetch, reading
// paths/headers/bodies, changing methods, or forwarding any trace data to Google.
const scope = new AsyncLocalStorage();
const requests = new WeakMap();
const hosts = new Set(['script.google.com', 'script.googleusercontent.com', 'accounts.google.com', 'www.google.com']);
const actions = new Set(['dailyReview', 'managerReviewRead', 'managerReviewSave', 'managerReviewVoid']);
const errors = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED']);
function emit(context, event, values = {}) {
  try { console.info('M1_TEST_HOP', JSON.stringify({ trace: context.id, variant: context.variant, action: context.action, gym: context.gym, attempt: context.attempt, event, at: new Date().toISOString(), ...values })); } catch { /* Diagnostics must never affect transport. */ }
}
channel('undici:request:create').subscribe(({ request }) => {
  try {
    const context = scope.getStore();
    if (!context || context.hops >= 12) return;
    const host = new URL(String(request.origin)).hostname;
    const info = { context, started: Date.now(), hop: ++context.hops, method: ['POST', 'GET', 'HEAD'].includes(request.method) ? request.method : 'other', host: hosts.has(host) ? host : 'other', status: 0 };
    requests.set(request, info);
    emit(context, 'request', { hop: info.hop, method: info.method, host: info.host, elapsedMs: 0 });
  } catch { /* Never inspect or log the request on failure. */ }
});
for (const [name, event] of [['headers', 'headers'], ['trailers', 'complete'], ['error', 'error']]) {
  channel(`undici:request:${name}`).subscribe(({ request, response, error }) => {
    try {
      const info = requests.get(request);
      if (!info) return;
      if (Number.isInteger(response?.statusCode)) info.status = response.statusCode;
      const code = error ? ['TimeoutError', 'AbortError'].includes(error.name) ? error.name : errors.has(error.code) ? error.code : 'OTHER' : '';
      emit(info.context, event, { hop: info.hop, method: info.method, host: info.host, status: info.status, elapsedMs: Date.now() - info.started, ...(code ? { code } : {}) });
    } catch { /* Never log a raw error or response. */ }
  });
}
export async function traceGoogle(meta, run) {
  if (meta.target !== 'test' || meta.enabled !== true || !actions.has(meta.action)) return run();
  const context = { id: randomBytes(8).toString('hex'), variant: ['pre-pr', 'native-https'].includes(meta.variant) ? meta.variant : 'current', action: meta.action, gym: meta.gym === 'richmond' ? 'richmond' : 'rev', attempt: Number.isInteger(meta.attempt) ? meta.attempt : 1, hops: 0 };
  return scope.run(context, async () => {
    const started = Date.now();
    emit(context, 'start', { node: process.versions.node, undici: process.versions.undici || 'unknown' });
    try { return await run(); }
    finally { emit(context, 'end', { hops: context.hops, elapsedMs: Date.now() - started }); }
  });
}

// Native HTTPS supplies the same minimal events; no URL, header or body is read.
export function traceNativeHop(method, hostname) {
  const context = scope.getStore();
  if (!context || context.variant !== 'native-https') return () => {};
  const hop = ++context.hops, started = Date.now();
  const safe = { hop, method: ['POST', 'GET', 'HEAD'].includes(method) ? method : 'other', host: hosts.has(hostname) ? hostname : 'other' };
  emit(context, 'request', { ...safe, elapsedMs: 0 });
  let status = 0, ended = false;
  return (event, value) => {
    if (ended || !['headers', 'complete', 'error'].includes(event)) return;
    if (event === 'headers' && Number.isInteger(value)) status = value;
    const code = event === 'error' ? ['TimeoutError', 'AbortError'].includes(value?.name) ? value.name : errors.has(value?.code) ? value.code : 'OTHER' : '';
    emit(context, event, { ...safe, status, elapsedMs: Date.now() - started, ...(code ? { code } : {}) });
    if (event !== 'headers') ended = true;
  };
}
