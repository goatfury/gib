# M1 production provisioning and rollback

**PREPARED — DO NOT RUN IN THIS TASK.**

These commands are for a later, separately authorized run. This production-candidate task must not create a Sheet, create or deploy an Apps Script project, change Netlify production configuration, issue an install link, or touch the tablet.

## Tool and private prerequisites

Run the repository tool from the repository root. It uses the pinned local `@google/clasp` version 3.3.0 and captures clasp output rather than echoing Google identifiers or errors.

```text
node tools/m1-production-provision.mjs status
```

`status` is read-only. `prepare` is a separate read-only preflight: it validates the reviewed source, ignored private configuration, existing authorization, and pinned clasp version, then assembles the exact three-file stage in memory. It writes nothing and performs no remote mutation. A completed status command reports `ok=true` even when a prerequisite is false, so inspect `sourceReady`, `privatePathIgnored`, and `authUsable`. For an existing project, also require `projectStateUsable`.

The ignored `private/m1-production/config.json` must contain the schema `gib-m1-production-private-config/v1` and the private standard Google Cloud project ID. It may name an existing clasp authorization file only by a path inside `private/m1-production/`. Use the existing authorization. Do not run Google OAuth, `clasp login`, or clasp bootstrap unless hard evidence shows that authorization is unusable and a separate repair is approved.

Every mutating action requires both `--execute` and its exact action-bound confirmation. Without `--execute`, it is a sanitized dry run and performs no mutation. Failures print only `{"ok":false,"code":"<safe code>"}`.

## First-time production Google provisioning

Run these commands in this exact order in the later authorized run:

```text
node tools/m1-production-provision.mjs prepare
node tools/m1-production-provision.mjs create --execute --confirm M1-PRODUCTION-CREATE
node tools/m1-production-provision.mjs push --execute --confirm M1-PRODUCTION-PUSH
node tools/m1-production-provision.mjs version --execute --confirm M1-PRODUCTION-VERSION
node tools/m1-production-provision.mjs deploy --execute --confirm M1-PRODUCTION-DEPLOY
node tools/m1-production-provision.mjs provision --execute --confirm M1-PRODUCTION-PROVISION
node tools/m1-production-provision.mjs status
```

The phases are intentionally separate:

1. `create` creates exactly one standalone production Apps Script project in an isolated ignored bootstrap directory. It does not create the Sheet.
2. `push` stages and verifies exactly `Code.gs`, `GibM1Receiver.gs`, and `appsscript.json`, then pushes only those reviewed files.
3. `version` creates one immutable Apps Script version.
4. `deploy` creates the initial deployment at that immutable version and verifies the remote deployment version.
5. `provision` calls `provisionGibM1ProductionReceiver()` through the executable deployment. It creates or resolves exactly one Sheet titled `RBJJ M1 — PRODUCTION`, verifies the exact 11-column `Signins` schema and permanent RowIDs, and persists the production Sheet and target lock privately.

The initial deployment is deliberately fail-closed between `deploy` and `provision`: the production wrapper requires the persisted production target lock, and production Netlify sync remains disabled. If provisioning fails, stop with lifecycle `deployed-unprovisioned`; do not skip, reorder, or repeat phases blindly.

## Later approved source update

Reuse the same standalone project and deployment:

```text
node tools/m1-production-provision.mjs push --execute --confirm M1-PRODUCTION-PUSH
node tools/m1-production-provision.mjs version --execute --confirm M1-PRODUCTION-VERSION
node tools/m1-production-provision.mjs update --execute --confirm M1-PRODUCTION-UPDATE
node tools/m1-production-provision.mjs provision --execute --confirm M1-PRODUCTION-PROVISION
node tools/m1-production-provision.mjs status
```

`update` records the actual currently deployed version, moves the same deployment to the immutable candidate version, and verifies the remote state before and after the move. It never creates a second production project or deployment.

## Apps Script rollback and restore

Rollback uses the privately recorded prior deployed version; it never guesses by subtracting one. Restore is permitted only after the exact matching rollback and returns the same deployment to the recorded approved version.

```text
node tools/m1-production-provision.mjs status
node tools/m1-production-provision.mjs rollback --execute --confirm M1-PRODUCTION-ROLLBACK
node tools/m1-production-provision.mjs status
node tools/m1-production-provision.mjs restore --execute --confirm M1-PRODUCTION-RESTORE
node tools/m1-production-provision.mjs status
```

Both moves verify the remote version before and after the update and journal the intended move before changing Google. If a private `pendingOperation` remains after a crash or ambiguous response, stop; later mutations fail closed until exact read-only reconciliation. Rollback and restore do not change Sheet rows and are not payroll-row recovery commands.

## One-time tablet install artifact

Only after isolated production Google and Netlify configuration has passed separate review, provide the private install run ID and capability secret through the approved private environment or an ignored secret file, then run:

```text
node tools/m1-production-provision.mjs install-link --execute --confirm M1-PRODUCTION-INSTALL-LINK
```

The command writes the 60-second, run-bound link to `private/m1-production/installer-link.txt`; it does not print the link or permanent device credential. The link opens only on `https://gib-live.netlify.app`, carries its one-time capability in the URL fragment, and leaves auto-sync OFF. A lost successful redemption burns the capability; issue a fresh link instead of replaying it.

## Sanitized output and private artifacts

Successful CLI output is one JSON summary containing only booleans, counts, expiry seconds, and the lifecycle. Its fields are: `ok`, `dryRun`, `sourceReady`, `privatePathIgnored`, `authUsable`, `projectStateUsable`, `stagedFileCount`, `commandCount`, `sheetResolved`, `sheetCreated`, `sheetMatchCount`, `headerCount`, `dataRowCount`, `rollbackPrepared`, `restorePrepared`, `installerLinkSaved`, `expiresInSeconds`, and `lifecycle`. It contains no Google identifier, webhook URL, token, credential, row, or instructor name.

All generated state stays under the ignored `private/m1-production/` tree with private file permissions:

- `config.json`: standard Cloud project identity and optional private clasp authorization path.
- `state.json`: lifecycle journal, source hashes, private Google identities and URL, version records, target state, and derived receiver credential.
- `clasp-bootstrap/`: isolated first-create output; never used as the reviewed push stage.
- `clasp-project/`: private clasp project metadata plus the exact reviewed three-file source stage.
- `installer-link.txt`: ephemeral raw install link.

Never print, paste, commit, attach, or place these artifacts in a PR, issue, screenshot, QR caption, or document. No command in this runbook changes Netlify production configuration or enables auto-sync.
