import { writeFile } from 'node:fs/promises';

import {
  browserInstallationProfileSource,
  installationProfile
} from '../m1/installation-profile-core.mjs';

const configured = process.env.GIB_M1_INSTALLATION || 'rev';
const profile = installationProfile(configured);
if (!profile) {
  throw new Error(`Unsupported GIB_M1_INSTALLATION value: ${JSON.stringify(configured)}`);
}

const source = browserInstallationProfileSource(profile);

await writeFile(
  new URL('../m1/installation-profile.generated.js', import.meta.url),
  source,
  'utf8'
);
