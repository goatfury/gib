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

await Promise.all([
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
