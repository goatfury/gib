# M1 current state

Verified 2026-08-08. This is a sanitized operating record: it contains no Sheet, Script, deployment, webhook, device, or credential identifiers.

## Currently live

- Canonical production kiosk origin: `https://gib-live.netlify.app`.
- Live branch and commit: `main` at `7c0a1bf5cb2fff2443031e10585fe08e30f81b77`.
- Public Netlify metadata and byte-for-byte checks of the tracked live kiosk, Admin, diagnostic, schedule, guest, and root assets confirm that commit is the live static build.
- The production candidate is not live. Its isolated Google receiver is provisioned but remains disconnected from Netlify production; the live site, `main`, old Sheet, and tablet are unchanged.

## Proven TEST state

- Branch: `agent/m1-revbjjops-test-path`.
- Commit: `a0273e4d154cc0289a0a3e10169135fca53b1b23`.
- Draft PR: #50, open and unmerged.
- Automated baseline: 101/101 M1 tests passed.
- Its Deploy Preview is TEST-only and accepts only obvious fake TEST names.

The latest genuine end-to-end TEST canary was performed against that TEST commit. It proved local save, a durable waiting queue, same-origin Netlify transport, a complete readable Google acknowledgment, and queue `1 -> 0` only after confirmation. Replaying the same permanent RowID returned `already exists`, the TEST Sheet remained exactly one row, and Apps Script rollback and restore worked. The exact canary time and row identity are not present in sanitized evidence and are not invented here.

## Production-candidate state

- Branch: `agent/m1-production-candidate-prep`.
- Draft PR: #51, open, unmerged, and stacked on `agent/m1-revbjjops-test-path`.
- The reviewed production source passed the complete candidate and proven TEST regression suites before deployment.
- No production Netlify configuration, site deployment, tablet installation, or sign-in canary has been performed.

## Production Google state

- One standalone production Apps Script project was created under the dedicated account.
- One immutable web-app deployment was created and verified against the reviewed source.
- The existing production Sheet was resolved; no new Sheet was created.
- The `Signins` schema is exactly eleven required headers and contains zero data rows.
- The receiver target is permanently locked to production and the one-time provisioning action is permanently closed.
- Required private connection state is retained only in the ignored private directory.
- Netlify production remains disconnected.

## TEST and production separation

- The browser uses only the same-origin kiosk endpoint and receives no Google URL, Google token, Sheet ID, Apps Script ID, deployment ID, or Netlify secret.
- Deploy Previews are pinned to TEST, use only TEST server configuration, and reject real instructor names.
- Production is pinned to the exact canonical origin and the production target. It remains disabled unless every production setting is present, including valid device authentication, and it accepts real instructor names.
- TEST and production use separate wrappers, manifests, standalone Apps Script projects, Sheets, server configuration, and authentication. Each standalone Apps Script project intentionally uses its Apps Script-managed default Cloud project; no standard Cloud project is required for the production web-app path. Neither environment's credential can authenticate the other.
- Production provisioning used one private production-only web-app POST whose credential is separate from the ordinary receiver credential. It did not use `scripts.run` or an Apps Script API executable, and the provisioning action is now permanently closed.

## Tablet and auto-sync

- Authorized auto-sync state: **OFF**. Production Netlify sync remains disabled after provisioning until a separately approved cutover.
- The physical tablet was not inspected or changed during this preparation, so its local storage state is not independently claimed as observed.
- No install link was issued and no device was installed.
- The prepared one-time installer leaves auto-sync OFF and preserves local history and the waiting queue. Its diagnostic reveals only: correct production origin YES/NO; device authorized YES/NO; auto-sync ON/OFF; local sign-in count; waiting count; and build/version.

## Known limitations

- Production Netlify settings and a production device authorization have not been installed or activated.
- No real production sign-in, migration, or cutover has been attempted.
- The current live path remains unchanged until a later approved run.
- A one-time install capability is deliberately consumed even if its successful response is lost; recovery is to issue a fresh capability, not replay the old one.

## Next authorized action

Configure the retained private receiver values in Netlify production while keeping production sync and tablet auto-sync OFF. Cutover still requires its own later approval.

## Rollback point

No live-site rollback is required because Netlify production and `main` are unchanged. The code rollback point remains live commit `7c0a1bf5cb2fff2443031e10585fe08e30f81b77`; the operational rollback point is the intact old tablet. The verified Apps Script deployment version is retained privately for a later approved rollback if needed.
