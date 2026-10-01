import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { traceNativeHop } from './m1-google-trace.mjs';

// Fetch-compatible adapter, enabled only for opted-in Revolution TEST reads.
// The caller retains its exact body and single 25-second signal for the chain.
// No retries, URL reuse or credential storage.
export function createNativeHttpsControl(requestImpl = httpsRequest) {
  return async (input, init) => {
    const initial = new URL(input);
    if (initial.protocol !== 'https:' || initial.hostname !== 'script.google.com' || initial.port || initial.username || initial.password || init.method !== 'POST' || init.redirect !== 'follow' || !init.signal) throw new Error('TEST transport control rejected.');
    const headers = Object.fromEntries(new Headers(init.headers));
    // Match Node fetch's automatic request headers; explicit application headers
    // and the serialized body remain those of the unchanged pre-PR function.
    Object.assign(headers, { 'accept-language': '*', 'sec-fetch-mode': 'cors', 'user-agent': 'node', 'accept-encoding': 'br, gzip, deflate' });
    headers['content-length'] = String(Buffer.byteLength(init.body));
    const visit = (url, method, body, wireHeaders, redirects) => new Promise((resolve, reject) => {
      if (init.signal.aborted) { reject(init.signal.reason); return; }
      const observe = traceNativeHop(method, url.hostname);
      const req = requestImpl(url, { method, headers: wireHeaders, signal: init.signal }, response => {
        const status = response.statusCode;
        observe('headers', status);
        response.once('end', () => observe('complete'));
        response.once('error', error => observe('error', init.signal.aborted ? init.signal.reason : error));
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          let next;
          try {
            next = new URL(response.headers.location, url);
            if (redirects >= 20 || next.protocol !== 'https:' || !['script.google.com', 'script.googleusercontent.com'].includes(next.hostname) || next.port || next.username || next.password) throw new Error('Redirect rejected.');
          } catch { reject(new Error('TEST redirect rejected.')); return; }
          const rewrite = status === 303 && method !== 'HEAD' || [301, 302].includes(status) && method === 'POST';
          const nextHeaders = { ...wireHeaders };
          if (rewrite) { delete nextHeaders['content-type']; delete nextHeaders['content-length']; }
          resolve(visit(next, rewrite ? 'GET' : method, rewrite ? undefined : body, nextHeaders, redirects + 1));
          return;
        }
        const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
        if (decoder) {
          response.once('error', error => decoder.destroy(error));
          decoder.once('error', () => response.destroy());
          response.pipe(decoder);
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value != null) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        try {
          resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(decoder || response), { status, headers: responseHeaders }));
          if ([204, 205, 304].includes(status)) response.resume();
        } catch { response.destroy(); reject(new Error('TEST response rejected.')); }
      });
      req.once('error', error => { observe('error', init.signal.aborted ? init.signal.reason : error); reject(error); });
      req.end(body);
    });
    return visit(initial, init.method, init.body, headers, 0);
  };
}
export const nativeHttpsControl = createNativeHttpsControl();
