import { installationProfile } from '../../../m1/installation-profile-core.mjs';
import {
  DEPLOYMENT_ACTIVATION,
  DEPLOYMENT_ENVIRONMENT,
  DEPLOYMENT_INSTALLATION_ID
} from './m1-installation.generated.mjs';

export function deploymentInstallationProfile(
  installationId = DEPLOYMENT_INSTALLATION_ID,
  environment = installationId === DEPLOYMENT_INSTALLATION_ID
    ? DEPLOYMENT_ENVIRONMENT
    : undefined,
  activation = installationId === DEPLOYMENT_INSTALLATION_ID
    && environment === DEPLOYMENT_ENVIRONMENT
    ? DEPLOYMENT_ACTIVATION
    : undefined
) {
  return installationProfile(installationId, environment, activation || 'pending');
}

export function remoteBackendEnabled(installationId, environment, activation) {
  return deploymentInstallationProfile(installationId, environment, activation)?.backend.enabled === true;
}

export function staffClockEnabled(installationId, environment, activation) {
  return deploymentInstallationProfile(installationId, environment, activation)?.featureFlags.staffClock === true;
}

export function remoteScheduleEnabled(installationId, environment, activation) {
  const mode = deploymentInstallationProfile(installationId, environment, activation)?.scheduleSource.mode;
  return mode === 'rev-website' || mode === 'richmond-website';
}
