import { jsonResponse, readJson, requireAdmin } from './_lib/m1-common.mjs';
import { PROOF_PATH, ProofError, dispatchProof, fail, key, makeBinding, proofRuntime, proofStore, readEntry, readProof, validId, validateBinding } from './_lib/m1-test-read-callback.mjs';

export const config = { path: '/api/m1-test-read-proof', rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleReadProof(request, dependencies = {}) {
  const runtime = proofRuntime(request, PROOF_PATH, dependencies);
  if (!runtime) return jsonResponse(403, { ok: false, message: 'Read proof is restricted to Revolution TEST PR89.' });
  if (request.headers.get('origin') !== new URL(request.url).origin) return jsonResponse(403, { ok: false, message: 'Use the existing TEST Admin page.' });
  const now = dependencies.clock || Date.now;
  const auth = requireAdmin(request, runtime, now());
  if (auth.response) return auth.response;
  const parsed = await readJson(request, 1024);
  if (parsed.response) return parsed.response;
  const input = parsed.value;
  if (Object.keys(input).sort().join(',') !== 'operation,requestId' || !['start', 'status'].includes(input.operation) || !validId(input.requestId)) return jsonResponse(400, { ok: false, message: 'Only an identified read proof or its status is supported.' });
  try {
    const store = dependencies.store || await proofStore();
    if (input.operation === 'status') return jsonResponse(200, await readProof(store, input.requestId, now()));
    if (typeof dependencies.context?.waitUntil !== 'function') fail(503, 'Supported background dispatch is unavailable. Nothing was sent.');
    const pending = { binding: makeBinding(input.requestId, now()), reviewer: auth.session.adminName };
    const created = await store.set(key(input.requestId, 'pending'), JSON.stringify(pending), { onlyIfNew: true });
    const confirmed = await readEntry(store, input.requestId, 'pending');
    if (!confirmed) fail(503, 'Pending read was not confirmed centrally. Nothing was sent.');
    validateBinding(confirmed.binding, now());
    if (created?.modified === true) {
      if (JSON.stringify(confirmed) !== JSON.stringify(pending)) fail(503, 'Pending read confirmation did not match. Nothing was sent.');
      // Netlify explicitly keeps the invocation alive until this bounded promise settles.
      dependencies.context.waitUntil(dispatchProof(store, confirmed, runtime, dependencies));
    } else if (created?.modified !== false) fail(503, 'Pending read persistence is uncertain. Nothing was sent.');
    return jsonResponse(202, { ok: true, state: 'pending', requestId: input.requestId, expiresAt: confirmed.binding.expiresAt, ordinaryReplyUsed: false, node: process.versions.node, deploy: dependencies.context.deploy.id });
  } catch (error) {
    return jsonResponse(error instanceof ProofError ? error.status : 503, { ok: false, message: error instanceof ProofError ? error.message : 'Read proof is unavailable. No authoritative result is confirmed.' });
  }
}
export default (request, context) => handleReadProof(request, { context });
