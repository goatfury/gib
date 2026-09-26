import { addedClassesScope } from '../m1-added-classes.mjs';
import { MANAGER_REVIEW_ENABLED, MANAGER_REVIEW_TARGET } from './m1-manager-review.generated.mjs';

// Build intent must agree with trusted site, publication, origin and gym facts.
// Runtime environment variables alone cannot turn a TEST artifact into live code.
export function managerReviewScope(request, dependencies = {}) {
  const enabled = dependencies.enabled ?? MANAGER_REVIEW_ENABLED;
  const target = dependencies.target ?? (dependencies.enabled === true ? 'test' : MANAGER_REVIEW_TARGET);
  if (!enabled || !['test', 'production'].includes(target)) return null;
  const url = new URL(request.url);
  const scope = addedClassesScope(new Request(new URL('/api/m1-added-classes', url), { headers: request.headers }), dependencies);
  if (!scope || scope.target !== target || (target === 'production' && scope.profile.installationId !== 'rev')) return null;
  return scope;
}
