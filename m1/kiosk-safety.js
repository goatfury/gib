(function attachKioskSafety(root) {
  'use strict';

  function clean(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function normalize(value) {
    return clean(value)
      .toLocaleLowerCase('en-US')
      .replace(/[’‘`´]/g, "'")
      .replace(/[‐‑‒–—―−]/g, '-');
  }

  function isActiveLedgerRow(row) {
    const status = clean(row && (row.Status || row.status || 'OK')).toUpperCase();
    return status !== 'VOID' && status !== 'VOIDED';
  }

  function rowId(row) {
    return clean(row && (row.RowID || row.rowId || row.__rowId));
  }

  function eventKey(row) {
    return JSON.stringify([
      clean(row && (row.Date || row.date)).slice(0, 10),
      normalize(row && (row.Instructor || row.instructor)),
      normalize(row && (row['Class Label'] || row.classLabel)),
      normalize(row && (row.Site || row.site))
    ]);
  }

  function queueMatchesLedger(queueRow, activeRows, rowIdUseCount, eventUseCount) {
    const id = rowId(queueRow);
    if (id) {
      const allowedById = activeRows.filter(row => rowId(row) === id).length;
      const usedById = rowIdUseCount.get(id) || 0;
      if (usedById < allowedById) {
        rowIdUseCount.set(id, usedById + 1);
        return true;
      }
      // Older RowIDs used the tuple joined by pipes. Fall through to the
      // normalized event match so those waiting rows migrate safely.
      if (!id.includes('|')) return false;
    }

    const key = eventKey(queueRow);
    const allowedByEvent = activeRows.filter(row => eventKey(row) === key).length;
    const usedByEvent = eventUseCount.get(key) || 0;
    if (usedByEvent < allowedByEvent) {
      eventUseCount.set(key, usedByEvent + 1);
      return true;
    }
    return false;
  }

  function reconcileQueue(queue, ledger) {
    const activeRows = (Array.isArray(ledger) ? ledger : []).filter(isActiveLedgerRow);
    const rowIdUseCount = new Map();
    const eventUseCount = new Map();
    return (Array.isArray(queue) ? queue : []).filter(row =>
      queueMatchesLedger(row, activeRows, rowIdUseCount, eventUseCount)
    );
  }

  function resultStatus(result) {
    return normalize(result && (result.result || result.status));
  }

  function isSafeCompletion(result) {
    const status = resultStatus(result);
    return status === 'added' || status === 'already exists' || status === 'already_exists';
  }

  function applyReadableResults(queue, response) {
    const current = Array.isArray(queue) ? queue.slice() : [];
    if (!response || response.ok !== true || !Array.isArray(response.results)) {
      return { remaining: current, completed: [], readable: false };
    }

    const byId = new Map();
    response.results.forEach(result => {
      const id = rowId(result);
      if (id && !byId.has(id)) byId.set(id, result);
    });

    const completed = [];
    const remaining = current.filter(row => {
      const result = byId.get(rowId(row));
      if (result && isSafeCompletion(result)) {
        completed.push({ row, result });
        return false;
      }
      return true;
    });
    return { remaining, completed, readable: true };
  }

  function duplicateClasses(rows, date, instructor, site, classes) {
    const active = (Array.isArray(rows) ? rows : []).filter(isActiveLedgerRow);
    const candidateBase = { Date: date, Instructor: instructor, Site: site };
    return (Array.isArray(classes) ? classes : []).filter(classLabel => {
      const key = eventKey({ ...candidateBase, 'Class Label': classLabel });
      return active.some(row => eventKey(row) === key);
    });
  }

  function containsRow(rows, candidate) {
    const values = Array.isArray(rows) ? rows : [];
    const id = rowId(candidate);
    if (id && values.some(row => rowId(row) === id)) return true;
    const key = eventKey(candidate);
    return values.some(row => eventKey(row) === key);
  }

  function mergeSigninTransaction(ledger, queue, transaction) {
    const mergedLedger = Array.isArray(ledger) ? ledger.slice() : [];
    const mergedQueue = Array.isArray(queue) ? queue.slice() : [];
    const newRows = transaction && Array.isArray(transaction.newRows)
      ? transaction.newRows
      : [];
    const queuedRows = transaction && Array.isArray(transaction.queuedRows)
      ? transaction.queuedRows
      : [];

    newRows.forEach(row => {
      if (rowId(row) && !containsRow(mergedLedger, row)) mergedLedger.push(row);
    });
    queuedRows.forEach(row => {
      if (
        rowId(row)
        && containsRow(mergedLedger.filter(isActiveLedgerRow), row)
        && !containsRow(mergedQueue, row)
      ) {
        mergedQueue.push(row);
      }
    });
    return { ledger: mergedLedger, queue: mergedQueue };
  }

  function queueContainsLedgerRow(queue, ledgerRow) {
    const id = rowId(ledgerRow);
    return Boolean(
      isActiveLedgerRow(ledgerRow)
      && id
      && (Array.isArray(queue) ? queue : []).some(row => rowId(row) === id)
    );
  }

  function markCompletedLedgerRows(ledger, completed) {
    const results = Array.isArray(completed) ? completed : [];
    const byId = new Map();
    results.forEach(item => {
      const id = rowId(item && item.row);
      if (id && !byId.has(id)) byId.set(id, item.result || {});
    });
    return (Array.isArray(ledger) ? ledger : []).map(row => {
      const result = byId.get(rowId(row));
      if (!result) return row;
      return {
        ...row,
        __syncState: 'confirmed',
        __linkedRecordId: clean(result.linkedRecordId)
      };
    });
  }

  function markAttemptedLedgerRows(ledger, queue, attemptedAt) {
    const waiting = Array.isArray(queue) ? queue : [];
    return (Array.isArray(ledger) ? ledger : []).map(row => {
      if (!queueContainsLedgerRow(waiting, row)) return row;
      return {
        ...row,
        __syncState: 'attempted',
        __lastAttemptAt: clean(attemptedAt)
      };
    });
  }

  root.GibM1Safety = Object.freeze({
    clean,
    normalize,
    isActiveLedgerRow,
    rowId,
    eventKey,
    reconcileQueue,
    isSafeCompletion,
    applyReadableResults,
    duplicateClasses,
    mergeSigninTransaction,
    queueContainsLedgerRow,
    markCompletedLedgerRows,
    markAttemptedLedgerRows
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
