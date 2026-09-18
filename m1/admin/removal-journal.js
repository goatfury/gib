// Only the pending attendance operation is retained. Authentication, pairing
// codes and request tokens remain in the Admin page's memory-only session.
(() => {
  'use strict';
  const key = 'gib-rev-pending-signin-removal-v1';
  const sameKeys = (value, keys) => value && typeof value === 'object'
    && Object.keys(value).sort().join('|') === keys.sort().join('|');
  const journal = Object.freeze({
    read() { return sessionStorage.getItem(key); },
    save(value) {
      if (!sameKeys(value, ['request', 'record', 'adminName'])
        || !sameKeys(value.request, ['removalVersion', 'operation', 'requestId', 'rowId', 'fingerprint', 'reason'])
        || !sameKeys(value.record, ['displayId', 'recordId', 'timestamp', 'date', 'classLabel', 'duration', 'instructor', 'site', 'notes', 'source', 'reviewRequired', 'reviewMessage', 'removal'])
        || !sameKeys(value.record.removal, ['eligible', 'fingerprint', 'explanation', 'pending'])
        || (value.record.removal.pending !== null && !sameKeys(value.record.removal.pending, ['requestId', 'adminName', 'reason']))) throw new Error('Invalid attendance operation');
      const text = JSON.stringify(value);
      if (text.length > 6000) throw new Error('Invalid attendance operation');
      sessionStorage.setItem(key, text);
      if (sessionStorage.getItem(key) !== text) throw new Error('Operation was not saved');
    },
    clear() { sessionStorage.removeItem(key); }
  });
  Object.defineProperty(window, 'M1RemovalJournal', { value: journal });
})();
