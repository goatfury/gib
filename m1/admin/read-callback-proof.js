(() => {
  'use strict';
  globalThis.GIBM1ReadCallbackProof = Object.freeze({ create({ request, onUnauthorized }) {
    if (location.origin !== 'https://deploy-preview-89--gib-live.netlify.app') return null;
    const root = document.createElement('details');
    root.className = 'manager-summary';
    root.id = 'readCallbackProof';
    root.innerHTML = '<summary>Read-only response-path proof · Revolution TEST</summary><p>The ordinary Google reply is deliberately discarded. This proof reads instructor records through a signed callback; it does not complete a day or change records.</p><button class="btn" type="button">Run read-only proof</button><p role="status" aria-live="polite"></p><pre style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>';
    document.getElementById('sign-ins').prepend(root);
    root.hidden = true;
    const button = root.querySelector('button');
    const status = root.querySelector('[role="status"]');
    const output = root.querySelector('pre');
    const endpoint = '/api/m1-test-read-proof';
    let generation = 0;
    let expiryTimer;
    const clearResult = () => { clearTimeout(expiryTimer); output.textContent = ''; };
    button.addEventListener('click', async () => {
      const own = ++generation;
      const requestId = crypto.randomUUID();
      const started = Date.now();
      const options = { timeoutMs: 12000, timeoutMessage: 'Proof status could not be confirmed.' };
      button.disabled = true; clearResult(); status.textContent = 'Persisting the pending read centrally…';
      try {
        const initial = await request(endpoint, { operation: 'start', requestId }, options);
        if (own !== generation) return;
        if (initial?.state !== 'pending' || initial.requestId !== requestId || initial.ordinaryReplyUsed !== false || initial.expiresAt <= Date.now()) throw new Error('Read dispatch was not confirmed.');
        status.textContent = 'Waiting for the authoritative callback. No result confirmed yet.';
        while (own === generation && Date.now() < Math.min(initial.expiresAt, started + 60000)) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (own !== generation) return;
          const data = await request(endpoint, { operation: 'status', requestId }, options);
          if (own !== generation) return;
          if (data?.ok !== true || data.requestId !== requestId || data.ordinaryReplyUsed !== false || data.expiresAt <= Date.now()) throw new Error('A fresh read was not confirmed.');
          if (data.state === 'received') {
            if (data.result?.ok !== true || data.result.complete !== true || data.result.gym !== 'rev' || !Array.isArray(data.result.days)) throw new Error('Incomplete read result.');
            status.textContent = `Authoritative callback received in ${(data.latencyMs / 1000).toFixed(2)} seconds; visible after ${((Date.now() - started) / 1000).toFixed(2)} seconds. Ordinary reply was not used. This snapshot expires in ${Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000))} seconds.`;
            // Data is text, never HTML. Names remain inside the authenticated Admin panel.
            output.textContent = JSON.stringify({ requestId, deploy: initial.deploy, node: initial.node, digest: data.digest, readAt: data.readAt, result: data.result }, null, 2);
            expiryTimer = setTimeout(() => { clearResult(); status.textContent = 'Proof snapshot expired. Run a fresh read; no current result is confirmed.'; }, Math.max(0, data.expiresAt - Date.now()));
            return;
          }
          if (data.state !== 'pending') throw new Error('Unknown proof state.');
        }
        throw new Error('No authoritative callback arrived before expiry. Nothing was marked complete.');
      } catch (error) {
        if (own === generation) { clearResult(); status.textContent = `Read proof unconfirmed: ${error.message}`; }
        if (error.status === 401) onUnauthorized();
      } finally { if (own === generation) button.disabled = false; }
    });
    return { open() { root.hidden = false; }, clear() { generation++; clearResult(); status.textContent = ''; button.disabled = false; root.hidden = true; } };
  } });
})();
