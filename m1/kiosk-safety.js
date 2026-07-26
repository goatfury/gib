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

  root.GibM1Safety = Object.freeze({
    clean,
    normalize,
    isActiveLedgerRow,
    rowId,
    eventKey,
    reconcileQueue,
    isSafeCompletion,
    applyReadableResults,
    duplicateClasses
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
