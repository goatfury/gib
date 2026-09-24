import { writeFile } from 'node:fs/promises';

import {
  browserInstallationProfileSource,
  installationProfile
} from '../m1/installation-profile-core.mjs';

const configured = process.env.GIB_M1_INSTALLATION || 'rev';
const environment = configured === 'richmond'
  ? process.env.GIB_M1_ENVIRONMENT || 'test'
  : '';
const activation = configured === 'richmond' && environment === 'production'
  && process.env.GIB_RICHMOND_PRODUCTION_ACTIVATION === 'active'
  && process.env.GIB_RICHMOND_PRODUCTION_WRITE_ENABLED === 'true'
  ? 'active'
  : 'pending';
const profile = installationProfile(configured, environment, activation);
if (!profile) {
  throw new Error(`Unsupported GIB_M1_INSTALLATION value: ${JSON.stringify(configured)}`);
}

const source = browserInstallationProfileSource(profile);
const managerReviewTestEnabled = process.env.GIB_M1_MANAGER_REVIEW_PILOT === 'true';
const managerReviewLiveEnabled = process.env.GIB_M1_MANAGER_REVIEW_LIVE_PILOT === 'true';
if (managerReviewTestEnabled && managerReviewLiveEnabled) {
  throw new Error('Manager day review cannot enable TEST and production in the same build.');
}
if (managerReviewTestEnabled && (!['deploy-preview', 'branch-deploy', 'dev'].includes(process.env.CONTEXT || '') || (profile.installationId === 'richmond' && profile.environment !== 'test'))) {
  throw new Error('Manager day review requires an explicit TEST preview build.');
}
if (managerReviewLiveEnabled && (profile.installationId !== 'rev' || process.env.CONTEXT !== 'production')) {
  throw new Error('The live manager day review pilot requires an explicit Revolution production build.');
}
const managerReviewEnabled = managerReviewTestEnabled || managerReviewLiveEnabled;
const managerReviewTarget = managerReviewLiveEnabled ? 'production' : managerReviewTestEnabled ? 'test' : 'disabled';
await writeFile(new URL('../m1/manager-review-config.generated.js', import.meta.url), `globalThis.M1_MANAGER_REVIEW_CONFIG = Object.freeze(${JSON.stringify({ enabled: managerReviewEnabled, target: managerReviewTarget })});\n`);
await writeFile(new URL('../netlify/functions/_lib/m1-manager-review.generated.mjs', import.meta.url), `export const MANAGER_REVIEW_ENABLED = ${managerReviewEnabled};\nexport const MANAGER_REVIEW_TARGET = ${JSON.stringify(managerReviewTarget)};\n`);
const promotionsTestEnabled = process.env.GIB_PROMOTIONS_TEST_ENABLED === 'true';
const promotionsLiveEnabled = process.env.GIB_PROMOTIONS_LIVE_ENABLED === 'true';
if (promotionsTestEnabled && promotionsLiveEnabled) {
  throw new Error('The Belt & Stripe Log cannot enable TEST and LIVE in the same build.');
}
if (promotionsTestEnabled && (
  profile.installationId !== 'rev'
  || !['deploy-preview', 'branch-deploy', 'dev'].includes(process.env.CONTEXT || '')
)) {
  throw new Error('The Belt & Stripe Log can only be enabled in an explicit Revolution TEST build.');
}
if (promotionsLiveEnabled && (profile.installationId !== 'rev' || process.env.CONTEXT !== 'production')) {
  throw new Error('The live Belt & Stripe Log requires an explicit Revolution production build.');
}
const promotionsSettings = promotionsLiveEnabled
  ? { enabled: true, endpoint: '/api/m1-promotions', testOnly: false, target: 'live' }
  : { enabled: promotionsTestEnabled, endpoint: '/api/m1-promotions', testOnly: true };
const promotionsConfig = `Object.defineProperty(globalThis, 'M1_PROMOTIONS_TEST_CONFIG', {\n  value: Object.freeze(${JSON.stringify(promotionsSettings)}),\n  writable: false, configurable: false\n});\n`;

await Promise.all([
  writeFile(
    new URL('../m1/promotions-config.generated.js', import.meta.url),
    promotionsConfig,
    'utf8'
  ),
  writeFile(
    new URL('../m1/installation-profile.generated.js', import.meta.url),
    source,
    'utf8'
  ),
  writeFile(
    new URL('../netlify/functions/_lib/m1-installation.generated.mjs', import.meta.url),
    [
      `export const DEPLOYMENT_INSTALLATION_ID = ${JSON.stringify(profile.installationId)};`,
      `export const DEPLOYMENT_ENVIRONMENT = ${JSON.stringify(profile.environment || '')};`,
      `export const DEPLOYMENT_ACTIVATION = ${JSON.stringify(profile.activation || '')};`,
      ''
    ].join('\n'),
    'utf8'
  )
]);
