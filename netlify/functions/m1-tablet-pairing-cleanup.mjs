import { jsonResponse } from './_lib/m1-common.mjs';
import { staffClockPairingProfile } from './_lib/m1-installation.mjs';
import {
  createPairingBlob,
  defaultPairingStore,
  deletePairingBlob,
  pairingCodeIndexKeyFromHash,
  readPairingBlob,
  TABLET_PAIRING_GENESIS_SECONDS,
  TABLET_PAIRING_PURGE_SECONDS,
  updatePairingBlob,
  validPairingCodeIndexForRequest,
  validPairingRequestKeyForRecord,
  validPairingRequestRecordForCleanup
} from './_lib/m1-tablet-pairing.mjs';

export const PAIRING_CLEANUP_LIMIT_PER_PREFIX = 30;
export const PAIRING_CLEANUP_CONCURRENCY = 5;
export const PAIRING_CLEANUP_CURSOR_KEY = 'pairing/cleanup/v1/cursor';
export const PAIRING_CLEANUP_PREFIXES = ['pairing/request/v1/'];

const SECONDS_PER_HOUR = 3_600;
const PAIRING_CLEANUP_GENESIS_PURGE_BUCKET = Math.floor(
  (TABLET_PAIRING_GENESIS_SECONDS + TABLET_PAIRING_PURGE_SECONDS) / SECONDS_PER_HOUR
) * SECONDS_PER_HOUR;

export const config = { schedule: '*/5 * * * *' };

function seconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return Math.floor(numeric >= 100_000_000_000 ? numeric / 1_000 : numeric);
}

function exactObjectKeys(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function validCursor(value) {
  return exactObjectKeys(value, ['v', 'bucket'])
    && value.v === 1
    && Number.isInteger(value.bucket)
    && value.bucket >= PAIRING_CLEANUP_GENESIS_PURGE_BUCKET
    && value.bucket % SECONDS_PER_HOUR === 0;
}

function cursorValue(bucket) {
  return Object.freeze({
    v: 1,
    bucket
  });
}

function bucketPrefix(bucket) {
  return `${PAIRING_CLEANUP_PREFIXES[0]}${String(bucket).padStart(12, '0')}/`;
}

async function firstPageKeys(store, prefix) {
  if (!store || typeof store.list !== 'function') {
    throw new Error('Tablet pairing store is unavailable.');
  }
  for await (const page of store.list({ prefix, paginate: true })) {
    if (!page || !Array.isArray(page.blobs)) {
      throw new Error('Tablet pairing store returned an unreadable listing.');
    }
    return page.blobs
      .map(blob => blob?.key)
      .filter(key => typeof key === 'string' && key.startsWith(prefix));
  }
  return [];
}

async function loadOrCreateCursor(store) {
  const existing = await readPairingBlob(store, PAIRING_CLEANUP_CURSOR_KEY);
  if (existing) {
    if (!validCursor(existing.value)) {
      throw new Error('Tablet pairing cleanup cursor is invalid.');
    }
    return existing;
  }

  const created = await createPairingBlob(
    store,
    PAIRING_CLEANUP_CURSOR_KEY,
    cursorValue(PAIRING_CLEANUP_GENESIS_PURGE_BUCKET)
  );
  const current = await readPairingBlob(store, PAIRING_CLEANUP_CURSOR_KEY);
  if (!current || !validCursor(current.value)) {
    throw new Error('Tablet pairing cleanup cursor is unavailable.');
  }
  if (created && current.value.bucket !== PAIRING_CLEANUP_GENESIS_PURGE_BUCKET) {
    throw new Error('Tablet pairing cleanup cursor changed unexpectedly.');
  }
  return current;
}

async function retireRequest(store, requestKey, current) {
  let request;
  try {
    request = await readPairingBlob(store, requestKey);
  } catch {
    // Keep the request as the durable link to its code index. A later run can
    // retry without creating an unreachable authorization record.
    return false;
  }
  if (!request) return false;

  const record = request.value;
  if (
    !validPairingRequestRecordForCleanup(record)
    || !validPairingRequestKeyForRecord(requestKey, record)
  ) {
    return false;
  }
  if (record.purgeAfter > current) return false;

  const codeKey = pairingCodeIndexKeyFromHash(record.codeHash);
  let code;
  try {
    code = await readPairingBlob(store, codeKey);
  } catch {
    return false;
  }
  if (code) {
    if (!validPairingCodeIndexForRequest(code.value, requestKey, record)) return false;
    await deletePairingBlob(store, codeKey);
  }
  await deletePairingBlob(store, requestKey);
  return true;
}

async function retireBatch(store, keys, current) {
  let deleted = 0;
  for (let offset = 0; offset < keys.length; offset += PAIRING_CLEANUP_CONCURRENCY) {
    const results = await Promise.all(keys.slice(
      offset,
      offset + PAIRING_CLEANUP_CONCURRENCY
    ).map(async key => {
      try {
        return await retireRequest(store, key, current);
      } catch {
        return false;
      }
    }));
    deleted += results.filter(Boolean).length;
  }
  return deleted;
}

export async function handleTabletPairingCleanup(_request, dependencies = {}) {
  const profile = staffClockPairingProfile(
    dependencies.installationId,
    dependencies.environment,
    dependencies.activation
  );
  if (!profile) return jsonResponse(200, { ok: true, inspected: 0, deleted: 0 });

  const current = seconds(dependencies.now ?? Date.now());
  if (!Number.isInteger(current) || current < SECONDS_PER_HOUR) {
    return jsonResponse(503, { ok: false, message: 'Tablet pairing cleanup time is invalid.' });
  }
  const eligibleBucket = (Math.floor(current / SECONDS_PER_HOUR) * SECONDS_PER_HOUR)
    - SECONDS_PER_HOUR;

  try {
    const store = dependencies.store ?? await defaultPairingStore();
    const cursor = await loadOrCreateCursor(store);
    if (cursor.value.bucket > eligibleBucket) {
      return jsonResponse(200, { ok: true, inspected: 0, deleted: 0 });
    }

    const prefix = bucketPrefix(cursor.value.bucket);
    const keys = (await firstPageKeys(store, prefix))
      .slice(0, PAIRING_CLEANUP_LIMIT_PER_PREFIX);
    const deleted = await retireBatch(store, keys, current);

    const remaining = await firstPageKeys(store, prefix);
    if (!remaining.length) {
      await updatePairingBlob(
        store,
        PAIRING_CLEANUP_CURSOR_KEY,
        cursorValue(cursor.value.bucket + SECONDS_PER_HOUR),
        cursor.etag
      );
    }

    return jsonResponse(200, {
      ok: true,
      inspected: keys.length,
      deleted
    });
  } catch {
    return jsonResponse(503, {
      ok: false,
      message: 'Tablet pairing cleanup is temporarily unavailable.'
    });
  }
}

export default request => handleTabletPairingCleanup(request);
