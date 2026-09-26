(() => {
  'use strict';
  const budget = 50000, expiry = 60000, hop = 25000;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const unavailable = () => new Error('Review status unavailable. No fresh central read was confirmed.');
  function valid(ticket) {
    return ticket && uuid.test(ticket.requestId || '') && Number.isSafeInteger(ticket.startedAt)
      && Number.isSafeInteger(ticket.deadlineAt) && Number.isSafeInteger(ticket.expiresAt)
      && ticket.deadlineAt > ticket.startedAt && ticket.deadlineAt <= ticket.startedAt + budget
      && ticket.expiresAt > ticket.deadlineAt && ticket.expiresAt <= ticket.startedAt + expiry
      && typeof ticket.dispatched === 'boolean';
  }
  const reusable = ticket => valid(ticket) && ticket.startedAt <= Date.now() && Date.now() < Math.min(ticket.deadlineAt, ticket.expiresAt);
  function createTicket() {
    const startedAt = Date.now();
    return { requestId: crypto.randomUUID(), startedAt, deadlineAt: startedAt + budget, expiresAt: startedAt + expiry, dispatched: false };
  }
  async function run({ ticket, send, retain = () => {}, current = () => true }) {
    if (!reusable(ticket)) throw unavailable();
    let value = { ...ticket }, operation = value.dispatched ? 'status' : 'start', attempts = 0;
    // Retain identity and the dispatch decision before network I/O. A lost start
    // reply resumes by status; it must never dispatch another Google read.
    value.dispatched = true;
    retain(value);
    while (current() && reusable(value)) {
      let result, nextOperation = 'status';
      attempts++;
      try {
        result = await send({ operation, requestId: value.requestId }, {
          timeoutMs: Math.min(hop, value.deadlineAt - Date.now()),
          timeoutMessage: 'Review status delivery was interrupted.'
        });
      } catch (error) {
        if ([400, 401, 403, 409, 410, 422].includes(error.status)) throw error;
        if (operation === 'status' && error.status === 404 && error.data?.code === 'READ_TICKET_MISSING' && !value.missingStartRetried) {
          // Only this authoritative missing-storage response permits one start
          // with the SAME ID. Atomic server creation prevents duplicate dispatch.
          value = { ...value, missingStartRetried: true };
          retain(value);
          nextOperation = 'start';
        }
        // Delivery failure is not a new read: only poll the original ticket.
      }
      operation = nextOperation;
      if (!current() || !reusable(value)) throw unavailable();
      if (result) {
        if (result.state !== 'pending') return result;
        if (result.ok !== true || result.requestId !== value.requestId
          || !Number.isSafeInteger(result.deadlineAt) || !Number.isSafeInteger(result.expiresAt)
          || result.expiresAt <= result.deadlineAt || result.deadlineAt <= Date.now()) throw unavailable();
        value = { ...value, deadlineAt: Math.min(value.deadlineAt, result.deadlineAt), expiresAt: Math.min(value.expiresAt, result.expiresAt) };
        if (!reusable(value)) throw unavailable();
        retain(value);
      }
      // At most twelve requests in the original 50-second budget: overlapping
      // badge/Admin reads stay below 40/min, and an addition check below 20/min.
      await new Promise(resolve => setTimeout(resolve, Math.min(attempts <= 2 ? 2000 : 5000, value.deadlineAt - Date.now())));
    }
    throw unavailable();
  }
  globalThis.GIBM1ReadClient = Object.freeze({ createTicket, reusable, run });
})();
