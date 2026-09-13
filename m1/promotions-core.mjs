export const PROMOTIONS_IDLE_MS = 60_000;
export const PROMOTIONS_SUCCESS_MS = 3_000;

export function promotionsEnabled(profile, config) {
  return profile?.installationId === 'rev'
    && profile.backend?.enabled === true
    && config?.enabled === true
    && config.testOnly === true
    && config.endpoint === '/api/m1-promotions';
}

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if ((!plainObject(value) && !Array.isArray(value)) || ancestors.has(value)) {
    throw lifecycleError('INVALID_INTENT', 'The pending promotion must contain only complete JSON data.');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw lifecycleError('INVALID_INTENT', 'The pending promotion contains an incomplete list.');
    }
    for (const item of value) validateJsonValue(item, ancestors);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw lifecycleError('INVALID_INTENT', 'The pending promotion contains unsupported properties.');
      }
      validateJsonValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function copyIntent(intent) {
  if (!plainObject(intent) || typeof intent.requestId !== 'string' || !intent.requestId.trim()) {
    throw lifecycleError('INVALID_INTENT', 'A pending promotion needs its original request ID.');
  }
  validateJsonValue(intent);
  return freezeDeep(JSON.parse(JSON.stringify(intent)));
}

function decodeEnvelope(raw) {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw lifecycleError('STORAGE_UNAVAILABLE', 'Pending promotion storage could not be read.');
  let envelope;
  try { envelope = JSON.parse(raw); } catch {
    throw lifecycleError('STORAGE_INVALID', 'An unreadable pending promotion must be preserved.');
  }
  if (!plainObject(envelope) || envelope.version !== 1
    || Object.keys(envelope).sort().join('|') !== 'intent|version') {
    throw lifecycleError('STORAGE_INVALID', 'An unknown pending promotion must be preserved.');
  }
  try { return copyIntent(envelope.intent); } catch {
    throw lifecycleError('STORAGE_INVALID', 'An invalid pending promotion must be preserved.');
  }
}

/** Keep only one exact save intent, never the panel's roster or search state. */
export function createPromotionsLifecycle({
  now = Date.now,
  storage,
  key = 'gib_m1_promotions_pending_v1',
  onClear = () => {}
} = {}) {
  let active = false;
  let generation = 0;
  let deadline = 0;
  let phase = 'closed';
  let pendingIntent = null;
  let pendingRaw = null;
  let originatingToken = null;
  let storageFault = null;

  function readStorage() {
    if (!storage || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function'
      || typeof key !== 'string' || !key) {
      throw lifecycleError('STORAGE_UNAVAILABLE', 'Durable pending promotion storage is unavailable.');
    }
    const raw = storage.getItem(key);
    return { raw, intent: decodeEnvelope(raw) };
  }

  function storageFailure(error) {
    storageFault = error?.code ? error
      : lifecycleError('STORAGE_UNAVAILABLE', 'The pending promotion could not be durably verified.');
    return storageFault;
  }

  // Recovery remains closed. Opening the panel is the only visibility transition.
  try {
    const restored = readStorage();
    pendingRaw = restored.raw;
    pendingIntent = restored.intent;
  } catch (error) { storageFailure(error); }

  function unchangedStorage() {
    if (storageFault) throw storageFault;
    let observed;
    try { observed = readStorage(); } catch (error) { throw storageFailure(error); }
    if (observed.raw !== pendingRaw) {
      throw lifecycleError('PENDING_LOCKED', 'Pending promotion storage changed in another session. Reopen before continuing.');
    }
    return observed;
  }

  function leave(reason = 'back') {
    generation += 1;
    active = false;
    deadline = 0;
    phase = 'closed';
    onClear(reason);
  }

  function check() {
    if (!active || now() < deadline) return false;
    leave(phase === 'success' ? 'success' : 'idle');
    return true;
  }

  function open({ blocked = false } = {}) {
    if (blocked) return null;
    generation += 1;
    active = true;
    deadline = now() + PROMOTIONS_IDLE_MS;
    phase = pendingIntent ? 'pending' : 'active';
    return generation;
  }

  function touch() {
    check();
    if (!active || phase === 'success') return false;
    deadline = now() + PROMOTIONS_IDLE_MS;
    return true;
  }

  function isCurrent(token) {
    check();
    return active && token === generation;
  }

  function begin(intent) {
    check();
    if (!active || phase === 'success') {
      throw lifecycleError('PANEL_INACTIVE', 'Open the promotions panel before beginning an entry.');
    }
    if (pendingIntent) throw lifecycleError('PENDING_LOCKED', 'Check or retry the existing pending promotion first.');
    const exactIntent = copyIntent(intent);
    unchangedStorage();
    const serialized = JSON.stringify({ version: 1, intent: exactIntent });
    try {
      storage.setItem(key, serialized);
      const readback = readStorage();
      if (readback.raw !== serialized) {
        throw lifecycleError('STORAGE_UNAVAILABLE', 'The pending promotion was not durably confirmed. Nothing may be sent yet.');
      }
      pendingRaw = readback.raw;
      pendingIntent = readback.intent;
    } catch (error) {
      // A failed readback may still have saved the intent. Never overwrite it.
      throw storageFailure(error);
    }
    originatingToken = generation;
    phase = 'pending';
    deadline = now() + PROMOTIONS_IDLE_MS;
    return copyIntent(pendingIntent);
  }

  function pending() {
    return pendingIntent ? copyIntent(pendingIntent) : null;
  }

  function retirePending(requestId) {
    if (!pendingIntent || requestId !== pendingIntent.requestId) return false;
    unchangedStorage();
    try {
      storage.removeItem(key);
      const readback = readStorage();
      if (readback.raw !== null) {
        throw lifecycleError('STORAGE_UNAVAILABLE', 'The pending promotion could not be durably cleared.');
      }
    } catch (error) { throw storageFailure(error); }
    pendingIntent = null;
    pendingRaw = null;
    originatingToken = null;
    if (active && phase === 'pending') phase = 'active';
    return true;
  }

  function reconcile(requestId, { token = originatingToken } = {}) {
    if (!retirePending(requestId)) return false;
    if (isCurrent(token)) {
      phase = 'success';
      deadline = now() + PROMOTIONS_SUCCESS_MS;
    }
    return true;
  }

  // Only a definitive pre-append rejection may discard an unsaved intent.
  // Network uncertainty, request conflicts, and destination failures retain it.
  function settleRejected(requestId) {
    return retirePending(requestId);
  }

  function snapshot() {
    return Object.freeze({ active, generation, deadline, pending: Boolean(pendingIntent), phase });
  }

  return Object.freeze({ open, touch, token: () => generation, isCurrent, begin, pending, reconcile, settleRejected, leave, check, snapshot });
}
