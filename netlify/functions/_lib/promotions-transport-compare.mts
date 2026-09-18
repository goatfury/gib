import { createHash, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const COMPARISON_DEADLINE_MS = 25000;
export const MAX_RESPONSE_BYTES = 1000000;
const REDIRECT_LIMIT = 20;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const instanceId = randomBytes(12).toString('hex');
let invocations = 0;
export const nextComparisonInvocation = () => ++invocations;

export function comparisonMetadata(arm, endpoint, invocation, environment = {}) {
  const version = value => /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(value || '') ? value : 'unknown';
  const context = ['production', 'deploy-preview', 'branch-deploy', 'dev'].includes(environment.CONTEXT) ? environment.CONTEXT : 'unknown';
  const region = /^(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:east|west|north|south|central|northeast|southeast)-[1-9]$/u.test(environment.AWS_REGION || '') ? environment.AWS_REGION : 'unknown';
  return { arm, nodeVersion:version(process.versions.node), undiciVersion:version(process.versions.undici), context, region,
    deploymentId:/^[a-f0-9]{24}$/u.test(environment.DEPLOY_ID || '') ? environment.DEPLOY_ID : 'unknown',
    instanceId, invocation, warm:invocation > 1,
    endpointHash:createHash('sha256').update(endpoint, 'utf8').digest('hex'),
    deadlineMs:COMPARISON_DEADLINE_MS, maxResponseBytes:MAX_RESPONSE_BYTES, redirectLimit:REDIRECT_LIMIT, errorCode:'none' };
}

const ERROR_CODES = new Set(['ABORT_ERR', 'TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE', 'BODY_TOO_LARGE', 'REDIRECT_POLICY', 'REDIRECT_LIMIT', 'CONTENT_ENCODING']);
export function comparisonErrorCode(error) {
  if ([error, error?.cause].some(candidate => candidate?.name === 'TimeoutError')) return 'TIMEOUT';
  for (const candidate of [error, error?.cause]) {
    if (candidate?.name === 'AbortError') return 'ABORT_ERR';
    if (ERROR_CODES.has(candidate?.code)) return candidate.code;
  }
  return 'OTHER';
}
const comparisonError = code => Object.assign(new Error('TEST transport comparison failed.'), { code });
const elapsed = started => Math.max(0, Math.round(performance.now() - started));

export function allowedGoogleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && ['script.google.com', 'script.googleusercontent.com'].includes(url.hostname);
  } catch { return false; }
}

function nextLocation(location, current) {
  const next = new URL(location, current);
  if (!allowedGoogleUrl(next.href)) throw comparisonError('REDIRECT_POLICY');
  // The URL is validation only. An absolute opaque Location is never rebuilt.
  return /^https:\/\//iu.test(location) ? location : next.href;
}
function newHop(url, method, diagnostics) {
  return { method, host:diagnostics.hostCategory(url), path:diagnostics.pathCategory(url), status:null, type:'missing', ms:0,
    destination:'none', destinationPath:'none' };
}
function destination(hop, location, current, diagnostics) {
  if (!location) return;
  try {
    const next = new URL(location, current);
    hop.destination = diagnostics.hostCategory(next.href);
    hop.destinationPath = diagnostics.pathCategory(next.href);
  } catch { hop.destination = 'other'; hop.destinationPath = 'other'; }
}

// Read decoded bytes with the same deadline as every redirect. Cancellation is
// also attached to the body so a server that stops after headers cannot hang.
export async function readComparisonBody(response, signal) {
  signal.throwIfAborted();
  if (!response.body) return '';
  const reader = response.body.getReader();
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => { void reader.cancel(signal.reason).catch(() => {}); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once:true });
  });
  const chunks = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw comparisonError('BODY_TOO_LARGE');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

// A per-request wrapper delegates to Node's existing native fetch pool. It
// observes native automatic redirects and guards every dispatch, including a
// 307/308 POST, before any signed body can reach a different service.
export function guardedComparisonDispatcher(delegate, trace, diagnostics, signal) {
  return {
    dispatch(options, handler) {
      signal.throwIfAborted();
      const origin = String(options.origin);
      const url = origin + options.path;
      if (!allowedGoogleUrl(origin) || !allowedGoogleUrl(url) || !String(options.path).startsWith('/')) throw comparisonError('REDIRECT_POLICY');
      if (trace.length > REDIRECT_LIMIT) throw comparisonError('REDIRECT_LIMIT');
      const started = performance.now();
      const hop = newHop(url, options.method, diagnostics);
      trace.push(hop);
      const wrapped = new Proxy(handler, {
        get(target, property) {
          if (property === 'onHeaders') return (...args) => {
            const [status, rawHeaders] = args;
            if (status >= 200) {
              const headers = new Headers();
              for (let index = 0; index < rawHeaders.length; index += 2) headers.append(String(rawHeaders[index]), String(rawHeaders[index + 1]));
              hop.status = status; hop.type = diagnostics.responseType({ headers }); hop.ms = elapsed(started);
              if (REDIRECTS.has(status)) destination(hop, headers.get('location'), url, diagnostics);
            }
            return target.onHeaders.apply(target, args);
          };
          if (property === 'onError') return error => {
            if (hop.status === null) hop.ms = elapsed(started);
            return target.onError.call(target, error);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      // Preserve the native options, including the encoded path and body.
      return delegate.dispatch(options, wrapped);
    }
  };
}

export async function fetchComparisonAutomatic(fetcher, url, options, trace, diagnostics, getDispatcher) {
  options.signal.throwIfAborted();
  let delegate;
  if (getDispatcher) delegate = await getDispatcher();
  else {
    // Network-free initialization ensures importing Undici cannot install its
    // own default Agent before Node has initialized the native fetch Agent.
    const initialized = await globalThis.fetch('data:,', { signal:options.signal });
    await initialized.body?.cancel();
    const { getGlobalDispatcher } = await import('undici');
    delegate = getGlobalDispatcher();
  }
  options.signal.throwIfAborted();
  return fetcher(url, { ...options, redirect:'follow', dispatcher:guardedComparisonDispatcher(delegate, trace, diagnostics, options.signal) });
}

function httpsHop(url, options, hop, socketTrace, diagnostics, requestImpl) {
  const started = performance.now();
  const socket = { hop:socketTrace.length + 1, dnsMs:null, connectMs:null, tlsMs:null, headersMs:null, reused:false, errorCode:'none' };
  socketTrace.push(socket);
  return new Promise((resolve, reject) => {
    let incoming;
    let source;
    let disposed = false;
    let settled = false;
    let req;
    const failed = error => {
      if (!disposed) socket.errorCode = comparisonErrorCode(error);
      if (hop.status === null) hop.ms = elapsed(started);
      if (!settled) { settled = true; reject(error); }
      else if (!disposed) source?.destroy(error);
    };
    try {
      options.signal.throwIfAborted();
      // agent:false creates a fresh connection for every hop. Node's default
      // certificate and hostname verification remain enabled explicitly.
      req = requestImpl(url, { method:options.method, headers:options.headers, signal:options.signal, agent:false, rejectUnauthorized:true }, response => {
        incoming = response;
        socket.headersMs = elapsed(started); socket.reused = req.reusedSocket === true;
        hop.ms = socket.headersMs; hop.status = response.statusCode;
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        hop.type = diagnostics.responseType({ headers });
        const encoding = headers.get('content-encoding')?.trim().toLowerCase();
        source = response;
        if (encoding && encoding !== 'identity') {
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
          if (!decoder) { failed(comparisonError('CONTENT_ENCODING')); response.destroy(); req.destroy(); return; }
          source = decoder;
          pipeline(response, decoder, error => { if (error && !disposed) failed(error); });
        }
        source.on('error', failed);
        const empty = [204, 205, 304].includes(response.statusCode);
        try {
          const reply = new Response(empty ? null : Readable.toWeb(source), { status:response.statusCode, headers });
          Object.defineProperty(reply, 'url', { value:url });
          const dispose = () => { disposed = true; source.destroy(); incoming.destroy(); req.destroy(); };
          if (empty) dispose();
          settled = true;
          resolve({ response:reply, dispose });
        } catch (error) { failed(error); source.destroy(); req.destroy(); }
      });
      req.once('socket', connection => {
        socket.reused = req.reusedSocket === true;
        connection.once('lookup', error => { socket.dnsMs = elapsed(started); if (error) socket.errorCode = comparisonErrorCode(error); });
        connection.once('connect', () => { socket.connectMs = elapsed(started); });
        connection.once('secureConnect', () => { socket.tlsMs = elapsed(started); });
      });
      req.on('error', failed);
      req.end(options.body);
    } catch (error) { failed(error); req?.destroy(); }
  });
}

export async function fetchComparisonHttps(firstUrl, options, trace, socketTrace, diagnostics, requestImpl = httpsRequest) {
  let url = firstUrl;
  let method = options.method;
  let headers = options.headers;
  let body = options.body;
  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
    options.signal.throwIfAborted();
    if (!allowedGoogleUrl(url)) throw comparisonError('REDIRECT_POLICY');
    const hop = newHop(url, method, diagnostics);
    trace.push(hop);
    const { response, dispose } = await httpsHop(url, { ...options, method, headers, body }, hop, socketTrace, diagnostics, requestImpl);
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    destination(hop, location, url, diagnostics);
    let next;
    try {
      if (redirects === REDIRECT_LIMIT) throw comparisonError('REDIRECT_LIMIT');
      next = nextLocation(location, url);
    } catch (error) { dispose(); throw error; }
    dispose();
    if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
      method = 'GET'; body = undefined; headers = { Accept:'application/json' };
    }
    url = next;
  }
}
