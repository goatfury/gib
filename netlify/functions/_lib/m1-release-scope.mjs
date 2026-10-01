import { addedClassesScope } from '../m1-added-classes.mjs';
import { managerReviewScope } from './m1-manager-scope.mjs';
import { liveControls } from '../../../tools/m1-release-controls.mjs';

// Only trusted deployment facts can select a live scope. A body/query can never
// supply an activation, target, gym, storage namespace or callback destination.
export function releaseFeatureScope(request, feature, dependencies = {}) {
  const url = new URL(request.url);
  const scope = addedClassesScope(new Request(new URL('/api/m1-added-classes', url), { headers: request.headers }), dependencies);
  if (!scope) return null;
  if (scope.target === 'test') {
    const test = managerReviewScope(request, dependencies);
    return test && (feature !== 'staffRecovery' || test.profile.installationId === 'rev') ? test : null;
  }
  const controls = liveControls(dependencies.env || process.env, scope.profile.installationId);
  if (scope.target !== 'production' || controls[feature] !== true) return null;
  return { ...scope, liveFeatures: controls };
}
