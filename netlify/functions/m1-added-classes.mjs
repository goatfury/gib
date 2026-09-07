import { jsonResponse, readJson, requireAdmin, runtimeConfig, runtimeTarget, validTestSameOriginRequest } from './_lib/m1-common.mjs';
import { deploymentInstallationProfile } from './_lib/m1-installation.mjs';
import { AddedClassesError, defaultAddedClassesStore, mutateAddedClasses, publicAddedClasses, readAddedClasses } from './_lib/m1-added-classes.mjs';

export const ADDED_CLASSES_PATH = '/api/m1-added-classes';
export const config = { path: '/api/m1-added-classes', rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

export function addedClassesTestScope(request, dependencies = {}) {
  const profile = deploymentInstallationProfile(dependencies.installationId, dependencies.environment, dependencies.activation);
  if (!profile || runtimeTarget(request.url, profile.installationId, profile.environment, profile.activation) !== 'test') return null;
  const context = dependencies.context;
  const expectedSite = profile.installationId === 'rev' ? 'gib-live' : 'gib-richmond-test';
  if (context?.site?.name !== expectedSite || !context.site.id) return null;
  const deployContext = context.deploy?.context;
  if (profile.installationId === 'rev') {
    if (!['deploy-preview', 'branch-deploy'].includes(deployContext) || context.deploy?.published !== false) return null;
  } else if (profile.environment !== 'test' || !['production', 'deploy-preview', 'branch-deploy'].includes(deployContext)
    || (deployContext !== 'production' && context.deploy?.published !== false)) return null;
  const url = new URL(request.url);
  if (url.pathname !== ADDED_CLASSES_PATH || url.search || url.hash) return null;
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const fetchSite = request.headers.get('sec-fetch-site');
  if ((origin && origin !== url.origin) || (host && host.toLowerCase() !== url.host.toLowerCase())
    || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) return null;
  return profile;
}

export async function handleM1AddedClasses(request, dependencies = {}) {
  if (!['GET', 'POST'].includes(request.method)) return jsonResponse(405, { ok: false, message: 'Method not allowed.' });
  // Check deployed profile, runtime host, actual site, and deployment context
  // before even opening a store. No production read or write route exists.
  const profile = addedClassesTestScope(request, dependencies);
  if (!profile) return jsonResponse(403, { ok: false, message: 'Shared added classes are enabled only on a verified TEST deployment.' });
  const now = dependencies.now ?? Date.now();
  let input;
  let adminName;
  if (request.method === 'POST') {
    if (!validTestSameOriginRequest(request, ADDED_CLASSES_PATH, profile.installationId, profile.environment, profile.activation)) return jsonResponse(403, { ok: false, message: 'Use this TEST Admin page to save classes.' });
    const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
    if (runtime?.target !== 'test') return jsonResponse(503, { ok: false, message: 'TEST Admin service is not configured.' });
    const auth = requireAdmin(request, runtime, now);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, 65536);
    if (parsed.response) return parsed.response;
    input = parsed.value;
    adminName = auth.session.adminName;
  }
  try {
    const store = Object.hasOwn(dependencies, 'store') ? dependencies.store : await defaultAddedClassesStore();
    if (!store || typeof store.getWithMetadata !== 'function' || typeof store.set !== 'function') throw new Error('Storage unavailable.');
    if (request.method === 'GET') {
      const { value } = await readAddedClasses(store, profile.installationId, now);
      return jsonResponse(200, publicAddedClasses(value, now));
    }
    const saved = await mutateAddedClasses(store, profile.installationId, input, now, adminName);
    return jsonResponse(200, { ...publicAddedClasses(saved.value, now), result: saved.result, seriesIds: saved.seriesIds, requestId: input.requestId, retry: saved.retry, message: saved.result === 'duplicate' ? 'This class is already saved centrally.' : 'Saved centrally. Online tablets receive this on their next refresh.' });
  } catch (error) {
    return jsonResponse(error instanceof AddedClassesError ? error.status : 503, { ok: false, message: error instanceof AddedClassesError ? error.message : 'Shared classes could not be loaded, or the save could not be confirmed. Retry the same request to check safely.' });
  }
}
export default (request, context) => handleM1AddedClasses(request, { context, env: process.env });
