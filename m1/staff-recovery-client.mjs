const REQUEST_ID = /^gib-m1-staff-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUNCH_ID = /^gib-m1-staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUNCH_KEYS = ['punchId', 'timestamp', 'date', 'staffId', 'staffName', 'punchAction', 'site', 'device', 'build', 'note'];
const ORIGINAL_KEYS = ['operation', 'requestId', 'previousClockInPunchId', 'punch', 'proposedFinishAt'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-(?:04|05):00$/u.test(value)
  && Number.isFinite(Date.parse(value)) && formatter.format(new Date(value)).replace(' ', 'T') === value.slice(0, 19);

export function staffRecoveryEnabled(profile, config, location) {
  if (profile?.installationId !== 'rev' || config?.enabled !== true || location?.protocol !== 'https:' || location.port) return false;
  return config.target === 'test' && location.origin === 'https://deploy-preview-89--gib-live.netlify.app';
}

export function validRecoveryOriginal(value) {
  return exact(value, ORIGINAL_KEYS) && value.operation === 'recover' && REQUEST_ID.test(value.requestId)
    && PUNCH_ID.test(value.previousClockInPunchId) && exact(value.punch, PUNCH_KEYS)
    && PUNCH_ID.test(value.punch.punchId) && value.punch.punchId !== value.previousClockInPunchId
    && stamp(value.punch.timestamp) && value.punch.date === value.punch.timestamp.slice(0, 10)
    && value.punch.punchAction === 'clockIn' && PUNCH_KEYS.every(key => typeof value.punch[key] === 'string')
    && ['staffId', 'staffName', 'site', 'device', 'build'].every(key => value.punch[key].trim())
    && value.punch.site === 'Rev'
    && (value.proposedFinishAt === null || (stamp(value.proposedFinishAt) && Date.parse(value.proposedFinishAt) <= Date.parse(value.punch.timestamp)));
}

function sameOriginalItem(item, original) {
  return item && item.requestId === original.requestId && item.previousClockInPunchId === original.previousClockInPunchId
    && item.newClockInPunchId === original.punch.punchId && item.startedAt === original.punch.timestamp
    && item.staffId === original.punch.staffId && item.staffName === original.punch.staffName
    && item.proposedFinishAt === original.proposedFinishAt && exact(item.punch, PUNCH_KEYS)
    && PUNCH_KEYS.every(key => item.punch[key] === original.punch[key])
    && Array.isArray(item.conflicts) && item.conflicts.length <= 3 && new Set(item.conflicts).size === item.conflicts.length
    && item.conflicts.every(code => ['previous-punch-void', 'new-punch-void', 'finish-punch-void'].includes(code))
    && !item.conflicts.includes('new-punch-void')
    && ['pending', 'approved', 'rejected'].includes(item.status) && Number.isSafeInteger(item.revision) && item.revision >= 0;
}

export function confirmedRecovery(value, original, target, receiptRequired = false) {
  if (!validRecoveryOriginal(original) || !value || value.ok !== true || value.target !== target
    || value.recovery?.enabled !== true || !Array.isArray(value.recovery.items)) return null;
  const matching = value.recovery.items.filter(item => item?.requestId === original.requestId);
  if (matching.length !== 1 || !sameOriginalItem(matching[0], original)) return null;
  if (receiptRequired) {
    const receipt = value.receipt;
    if (!exact(receipt, ['requestId', 'previousClockInPunchId', 'newClockInPunchId', 'startedAt', 'proposedFinishAt', 'status'])
      || receipt.requestId !== original.requestId || receipt.previousClockInPunchId !== original.previousClockInPunchId
      || receipt.newClockInPunchId !== original.punch.punchId || receipt.startedAt !== original.punch.timestamp
      || receipt.proposedFinishAt !== original.proposedFinishAt || receipt.status !== 'pending') return null;
  }
  return matching[0];
}

// A separate journal leaves the ordinary punch queue and every instructor key intact.
// Clear only after an authoritative matching receipt/read and durable local adoption.
export function createStaffRecovery({ storage, key, target, post, onConfirmed, onChange = () => {} }) {
  let running = null;
  function pending() {
    const text = storage.getItem(key);
    if (!text) return null;
    const value = JSON.parse(text);
    if (!validRecoveryOriginal(value)) throw new Error('The saved new-shift request needs Admin help; it has been preserved.');
    return value;
  }
  function persist(value) {
    storage.setItem(key, JSON.stringify(value));
    if (storage.getItem(key) !== JSON.stringify(value)) throw new Error('The new-shift request could not be saved on this tablet.');
  }
  async function adopt(value, original, receiptRequired) {
    const item = confirmedRecovery(value, original, target, receiptRequired);
    if (!item) return false;
    if (JSON.stringify(pending()) !== JSON.stringify(original)) throw new Error('The saved request changed; confirmation was not applied.');
    await onConfirmed(original, item);
    if (JSON.stringify(pending()) !== JSON.stringify(original)) throw new Error('A newer saved request is waiting; its confirmation has been preserved.');
    storage.removeItem(key);
    onChange('confirmed', original);
    return true;
  }
  function run(readFirst) {
    if (running) return running;
    running = (async () => {
      await Promise.resolve();
      let original;
      try {
        original = pending();
        if (!original) return false;
        onChange('working', original);
        if (readFirst) {
          const result = await post({ operation: 'recoveryRead' });
          if (await adopt(result, original, false)) return true;
          if (result?.ok !== true || result.target !== target || result.recovery?.enabled !== true || !Array.isArray(result.recovery.items)
            || result.recovery.items.some(item => item?.requestId === original.requestId)) throw new Error('New shift confirmation is incomplete.');
        }
        const result = await post(original);
        if (!await adopt(result, original, true)) throw new Error('New shift has not been confirmed.');
        return true;
      } catch (error) {
        onChange('pending', original, error);
        return false;
      } finally { running = null; onChange('settled', original); }
    })();
    return running;
  }
  return {
    pending,
    busy: () => Boolean(running),
    begin(original) {
      if (pending()) throw new Error('Finish confirming the saved new-shift request first.');
      if (!validRecoveryOriginal(original)) throw new Error('The new-shift request is incomplete.');
      persist(original);
      onChange('pending', original);
      return run(false);
    },
    resume: () => run(true),
    retryOriginal: () => run(false)
  };
}

// Reject the DST gap and ambiguous repeated hour instead of guessing a finish time.
export function staffRecoveryFinish(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const candidates = ['-04:00', '-05:00'].map(offset => `${value}:00${offset}`).filter(timestamp =>
    Number.isFinite(Date.parse(timestamp)) && formatter.format(new Date(timestamp)).replace(' ', 'T') === value);
  return candidates.length === 1 ? candidates[0] : null;
}
