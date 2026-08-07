# M1 current state

Verified 2026-08-07. This is a sanitized operating record: it contains no Sheet, Script, deployment, webhook, device, or credential identifiers.

## Currently live

- Canonical production kiosk origin: `https://gib-live.netlify.app`.
- Live branch and commit: `main` at `7c0a1bf5cb2fff2443031e10585fe08e30f81b77`.
- Public Netlify metadata and byte-for-byte checks of the tracked live kiosk, Admin, diagnostic, schedule, guest, and root assets confirm that commit is the live static build.
- The production candidate is not live. This repair created or changed no Google, Netlify, live-site, Sheet, or tablet resource; it did not change `main`.

## Proven TEST state

- Branch: `agent/m1-revbjjops-test-path`.
- Commit: `a0273e4d154cc0289a0a3e10169135fca53b1b23`.
- Draft PR: #50, open and unmerged.
- Automated baseline: 101/101 M1 tests passed.
- Its Deploy Preview is TEST-only and accepts only obvious fake TEST names.

The latest genuine end-to-end TEST canary was performed against that TEST commit. It proved local save, a durable waiting queue, same-origin Netlify transport, a complete readable Google acknowledgment, and queue `1 -> 0` only after confirmation. Replaying the same permanent RowID returned `already exists`, the TEST Sheet remained exactly one row, and Apps Script rollback and restore worked. The exact canary time and row identity are not present in sanitized evidence and are not invented here.

## Production-candidate state

- Branch: `agent/m1-production-candidate-prep`.
- Pre-repair candidate implementation commit: `174ab631e3891e1025d8c94ca2355b1f714b09e4`.
- The repaired implementation commit will be recorded only after the repair passes QA and is committed. No new commit hash is claimed here.
- Intended PR shape: stacked draft PR with `agent/m1-revbjjops-test-path` as its base.
- The candidate prepares code, tests, the secure tablet-install method, provisioning commands, rollback, and cutover instructions only. It does not provision or activate production.

## TEST and production separation

- The browser uses only the same-origin kiosk endpoint and receives no Google URL, Google token, Sheet ID, Apps Script ID, deployment ID, or Netlify secret.
- Deploy Previews are pinned to TEST, use only TEST server configuration, and reject real instructor names.
- Production is pinned to the exact canonical origin and the production target. It remains disabled unless every production setting is present, including valid device authentication, and it accepts real instructor names.
- TEST and production use separate wrappers, manifests, standalone Apps Script projects, Sheets, server configuration, and authentication. Each standalone Apps Script project intentionally uses its Apps Script-managed default Cloud project; no standard Cloud project is required for the production web-app path. Neither environment's credential can authenticate the other.
- Production provisioning no longer uses `scripts.run` or an Apps Script API executable. A later authorized run will use one private production-only web-app POST whose credential is separate from the ordinary receiver credential, then permanently close that provisioning action.

## Tablet and auto-sync

- Authorized auto-sync state: **OFF**. Production Netlify sync remains disabled after provisioning until a separately approved cutover.
- The physical tablet was not inspected or changed during this preparation, so its local storage state is not independently claimed as observed.
- No install link was issued and no device was installed.
- The prepared one-time installer leaves auto-sync OFF and preserves local history and the waiting queue. Its diagnostic reveals only: correct production origin YES/NO; device authorized YES/NO; auto-sync ON/OFF; local sign-in count; waiting count; and build/version.

## Known limitations

- The isolated production Sheet and standalone production Apps Script project have not been created.
- Production Netlify settings and a production device authorization have not been installed or activated.
- No real production sign-in, migration, or cutover has been attempted.
- The current live path remains unchanged until a later approved run.
- A one-time install capability is deliberately consumed even if its successful response is lost; recovery is to issue a fresh capability, not replay the old one.

## Next authorized action

After the repaired candidate is QA-passed and reviewed, a separate authorized run may create the standalone production Apps Script project, deploy its normal web app, and make the private one-time provisioning POST while keeping production Netlify sync and auto-sync OFF. Cutover still requires its own later approval.

## Rollback point

No rollback is required for this preparation because nothing live changes. The code rollback point remains live commit `7c0a1bf5cb2fff2443031e10585fe08e30f81b77`; the operational rollback point is the intact old tablet. Before any later activation, record the then-current Apps Script deployment version privately so the prepared rollback command can restore it without exposing an identifier.
