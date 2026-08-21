import { installationProfile } from '../../../m1/installation-profile-core.mjs';

export function installationProfileForEnvironment(env = process.env) {
  const configured = env?.GIB_M1_INSTALLATION;
  return installationProfile(configured == null || configured === '' ? 'rev' : configured);
}

export function remoteBackendEnabled(env = process.env) {
  return installationProfileForEnvironment(env)?.backend.enabled === true;
}

export function staffClockEnabled(env = process.env) {
  return installationProfileForEnvironment(env)?.featureFlags.staffClock === true;
}

export function remoteScheduleEnabled(env = process.env) {
  return installationProfileForEnvironment(env)?.scheduleSource.mode === 'rev-website';
}
