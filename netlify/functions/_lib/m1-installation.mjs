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

export function staffClockPairingProfile(installationId, environment, activation) {
  const profile = deploymentInstallationProfile(installationId, environment, activation);
  const pairing = profile?.staffClockPairing;
  if (
    profile?.featureFlags?.staffClock !== true
    || profile?.featureFlags?.staffClockPairing !== true
    || profile?.backend?.enabled !== true
    || !pairing
    || typeof pairing !== 'object'
    || pairing.origin !== profile.allowedOrigin
    || !Number.isInteger(pairing.expiresInSeconds)
    || pairing.expiresInSeconds < 60
    || pairing.expiresInSeconds > 300
  ) return null;
  return Object.freeze({
    installationId: profile.installationId,
    gymName: profile.gymName,
    deviceLabel: profile.deviceLabel,
    origin: pairing.origin,
    expiresInSeconds: pairing.expiresInSeconds
  });
}

export function remoteScheduleEnabled(installationId, environment, activation) {
  const mode = deploymentInstallationProfile(installationId, environment, activation)?.scheduleSource.mode;
  return mode === 'rev-website' || mode === 'richmond-website';
}
