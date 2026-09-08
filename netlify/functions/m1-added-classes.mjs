import { jsonResponse, readJson, requireAdmin, runtimeConfig, runtimeTarget } from './_lib/m1-common.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import { AddedClassesError, defaultAddedClassesStore, mutateAddedClasses, publicAddedClasses, readAddedClasses } from './_lib/m1-added-classes.mjs';

export const ADDED_CLASSES_PATH = '/api/m1-added-classes';
export const config = { path: '/api/m1-added-classes', rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

const SITES = Object.freeze({
  'test/rev': { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' },
  'production/rev': { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' },
  'test/richmond': { name: 'gib-richmond-test', id: '42736c77-e3c8-40aa-ba97-4f935d0999ad' },
  'production/richmond': { name: 'gib-richmond-live', id: '9b7757a9-70f4-4977-9ca2-270b41e34007' }
});

export function addedClassesScope(request, dependencies = {}) {
  const profile = deploymentInstallationProfile(dependencies.installationId, dependencies.environment, dependencies.activation);
  if (!profile) return null;
  const target = runtimeTarget(request.url, profile.installationId, profile.environment, profile.activation);
  const context = dependencies.context;
  const expectedSite = SITES[`${target}/${profile.installationId}`];
  if (!expectedSite || context?.site?.name !== expectedSite.name || context.site.id !== expectedSite.id) return null;
  const deployContext = context.deploy?.context;
  const url = new URL(request.url);
  if (target === 'production') {
    // Only the current published canonical gym origin may open live storage.
    // Drafts and immutable review URLs can never select production class data.
    if (url.origin !== profile.allowedOrigin || deployContext !== 'production' || context.deploy?.published !== true) return null;
    if (profile.installationId === 'richmond' && (profile.activation !== 'active' || profile.writesEnabled !== true)) return null;
  } else if (profile.installationId === 'rev') {
    if (!['deploy-preview', 'branch-deploy'].includes(deployContext) || context.deploy?.published !== false) return null;
  } else if (profile.environment !== 'test' || !['production', 'deploy-preview', 'branch-deploy'].includes(deployContext)
    || (deployContext !== 'production' && context.deploy?.published !== false)) return null;
  if (url.pathname !== ADDED_CLASSES_PATH || url.search || url.hash) return null;
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const fetchSite = request.headers.get('sec-fetch-site');
  if ((origin && origin !== url.origin) || (host && host.toLowerCase() !== url.host.toLowerCase())
    || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) return null;
  return { profile, target };
}

export async function handleM1AddedClasses(request, dependencies = {}) {
  if (!['GET', 'POST'].includes(request.method)) return jsonResponse(405, { ok: false, message: 'Method not allowed.' });
  // Resolve the gym and target from trusted deployment facts before storage.
  const scope = addedClassesScope(request, dependencies);
  if (!scope) return jsonResponse(403, { ok: false, message: 'Shared added classes are unavailable on this deployment.' });
  const { profile, target } = scope;
  const now = dependencies.now ?? Date.now();
  let input;
  let adminName;
  if (request.method === 'POST') {
    const fetchSite = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== new URL(request.url).origin || (fetchSite && fetchSite !== 'same-origin')) return jsonResponse(403, { ok: false, message: 'Use this gym\'s Admin page to save classes.' });
    const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
    if (runtime?.target !== target || (target === 'production' && profile.installationId === 'richmond' && runtime.writesEnabled !== true)) return jsonResponse(503, { ok: false, message: 'Admin service is not configured for this installation.' });
    const auth = requireAdmin(request, runtime, now);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, 65536);
    if (parsed.response) return parsed.response;
    input = parsed.value;
    adminName = auth.session.adminName;
  }
  try {
    const store = Object.hasOwn(dependencies, 'store') ? dependencies.store : await defaultAddedClassesStore(target);
    if (!store || typeof store.getWithMetadata !== 'function' || typeof store.set !== 'function') throw new Error('Storage unavailable.');
    if (request.method === 'GET') {
      const { value } = await readAddedClasses(store, profile.installationId, now, target);
      return jsonResponse(200, publicAddedClasses(value, now));
    }
    const saved = await mutateAddedClasses(store, profile.installationId, input, now, adminName, target);
    return jsonResponse(200, { ...publicAddedClasses(saved.value, now), result: saved.result, seriesIds: saved.seriesIds, requestId: input.requestId, retry: saved.retry, message: saved.result === 'duplicate' ? 'This class is already saved centrally.' : 'Saved centrally. Online tablets receive this on their next refresh.' });
  } catch (error) {
    return jsonResponse(error instanceof AddedClassesError ? error.status : 503, { ok: false, message: error instanceof AddedClassesError ? error.message : 'Shared classes could not be loaded, or the save could not be confirmed. Retry the same request to check safely.' });
  }
}
export default (request, context) => handleM1AddedClasses(request, { context, env: process.env });
