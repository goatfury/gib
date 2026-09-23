import { jsonResponse } from './_lib/m1-common.mjs';
import { CALLBACK_PATH, ProofError, SIGNATURE_HEADER, acceptResult, proofRuntime, proofStore } from './_lib/m1-test-read-callback.mjs';

export const config = { path: '/api/m1-test-read-result', rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleReadResult(request, dependencies = {}) {
  const runtime = proofRuntime(request, CALLBACK_PATH, dependencies);
  if (!runtime || request.method !== 'POST' || request.headers.has('origin')) return jsonResponse(403, { ok: false, message: 'Callback rejected.' });
  const declared = request.headers.get('content-length');
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '') || (declared !== null && (!/^\d+$/.test(declared) || +declared > 256_000))) return jsonResponse(400, { ok: false, message: 'Callback body rejected.' });
  try {
    const raw = await request.text();
    if (!raw || Buffer.byteLength(raw) > 256_000) return jsonResponse(400, { ok: false, message: 'Callback body rejected.' });
    const store = dependencies.store || await proofStore();
    return jsonResponse(200, await acceptResult(store, raw, request.headers.get(SIGNATURE_HEADER), runtime, (dependencies.clock || Date.now)()));
  } catch (error) {
    return jsonResponse(error instanceof ProofError ? error.status : 503, { ok: false, message: error instanceof ProofError ? error.message : 'Callback storage unavailable.' });
  }
}
export default (request, context) => handleReadResult(request, { context });
