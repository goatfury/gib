import { jsonResponse } from './_lib/m1-common.mjs';
import { CALLBACK_PATH, LIVE_CALLBACK_PATH, ProofError, SIGNATURE_HEADER, acceptResult, createReadTrace, traceReadStage, validId, callbackRuntime, proofStore } from './_lib/m1-test-read-callback.mjs';

// Netlify's source parser requires literal routes, including inside arrays.
export const config = { path: ['/api/m1-test-read-result', '/api/m1-manager-read-result'], rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleReadResult(request, dependencies = {}) {
  const path = new URL(request.url).pathname;
  const runtime = [CALLBACK_PATH, LIVE_CALLBACK_PATH].includes(path) && callbackRuntime(request, path, dependencies);
  if (!runtime || request.method !== 'POST' || request.headers.has('origin')) return jsonResponse(403, { ok: false, message: 'Callback rejected.' });
  const declared = request.headers.get('content-length');
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '') || (declared !== null && (!/^\d+$/.test(declared) || +declared > 256_000))) return jsonResponse(400, { ok: false, message: 'Callback body rejected.' });
  let trace = () => {};
  try {
    const raw = await request.text();
    if (!raw || Buffer.byteLength(raw) > 256_000) return jsonResponse(400, { ok: false, message: 'Callback body rejected.' });
    let id;
    try { id = JSON.parse(raw)?.binding?.requestId; } catch {} // acceptResult preserves the existing authenticated JSON rejection.
    if (validId(id)) trace = createReadTrace(id, dependencies);
    const store = await traceReadStage(trace, 'callback.storage.open', () => dependencies.store || proofStore({}, runtime.target));
    const receipt = await acceptResult(store, raw, request.headers.get(SIGNATURE_HEADER), runtime, (dependencies.clock || Date.now)(), trace);
    trace('callback.response', 'ready', 200);
    return jsonResponse(200, receipt);
  } catch (error) {
    trace('callback.response', 'rejected', error instanceof ProofError ? error.status : 503);
    return jsonResponse(error instanceof ProofError ? error.status : 503, { ok: false, message: error instanceof ProofError ? error.message : 'Callback storage unavailable.' });
  }
}
export default (request, context) => handleReadResult(request, { context });
