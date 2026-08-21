import { installationProfile } from '../../../m1/installation-profile-core.mjs';
import { DEPLOYMENT_INSTALLATION_ID } from './m1-installation.generated.mjs';

export function deploymentInstallationProfile(installationId = DEPLOYMENT_INSTALLATION_ID) {
  return installationProfile(installationId);
}

export function remoteBackendEnabled(installationId) {
  return deploymentInstallationProfile(installationId)?.backend.enabled === true;
}

export function staffClockEnabled(installationId) {
  return deploymentInstallationProfile(installationId)?.featureFlags.staffClock === true;
}

export function remoteScheduleEnabled(installationId) {
  const mode = deploymentInstallationProfile(installationId)?.scheduleSource.mode;
  return mode === 'rev-website' || mode === 'richmond-website';
}
