# M1 kiosk sync incident runbook

This runbook keeps deployment, data recovery, and the real-kiosk canary as separate approval gates. It contains no credentials, production identifiers, or payroll rows.

## Containment

- Keep tablet auto-sync off. Do not press **Sync now** during diagnosis or recovery.
- Preserve local kiosk history and queued records. Keep the independent staff ledger running.
- Treat a browser `no-cors` fetch as delivery-attempt evidence only; its opaque response cannot prove that Google accepted a row.
- Do not require a physical visit unless a specific remote blocker is first proven.

## Pre-change evidence

1. Fetch and fingerprint the live kiosk and Admin assets; do not infer deployed behavior from repository files.
2. Record the current receiver deployment/version, relevant execution aggregates, Script Property names, and real-Sheet aggregate counts without recording secret values or payroll-row contents.
3. Re-run the exact legacy `{token, rows}` contract tests and the Admin contract tests.
4. Recompute the missing set against the live Sheet using all seven canonical fields and the approved source-file checksum.
5. Obtain a fresh local-history CSV export through ordinary staff, preserve its checksum, and compare it with both the original incident export and the live Sheet. Reconcile every post-export sign-in against the independent staff ledger before any kiosk transmission.
6. The five pre-August-3 CSV-only differences are dispositioned as two semantic conflicts and three otherwise unexplained exact absences. They are outside the authorized incident scope and must not be recovered without a separate decision.
7. Stop on target ambiguity, credential-scope overlap, semantic conflict, candidate growth, or any unexpected Sheet change.

## Gate 1: receiver deployment

Requires explicit production authorization after review and merge.

1. Snapshot the current receiver code, deployment version, and authentication configuration for rollback.
2. Generate a new legacy append credential and retain it privately. In one supervised session, update the receiver property and tablet value together, then use the local tablet diagnostic to report only endpoint `EXPECTED`/`UNEXPECTED`, credential `MATCH`/`MISMATCH`, auto-sync state, queue count, and local-history count. Never display or transmit either raw value.
3. Configure separate secrets for the receiver transport, legacy kiosk append, Admin actions, and recovery. The values must be pairwise distinct. The legacy value is append-only and must never authenticate Admin or recovery actions.
4. Deploy the approved receiver version to the independently verified endpoint used by the old kiosk. Do not guess the target.
5. Run wrong-, missing-, and cross-scope authentication tests plus non-mutating Admin and recovery-list smoke tests.
6. If any check fails, restore the prior receiver version and authentication snapshot; keep auto-sync off.

### Cross-channel collision rule

- Exact kiosk replays remain duplicate-safe by all seven canonical fields.
- Repeated coarse business combinations remain distinct when they are genuinely separate events.
- If an Admin-added event exists and a non-exact kiosk event later arrives with the same date, instructor, class, and site, retain the kiosk row for audit but mark its Device and Status as requiring collision review.
- Daily Review must show a visible “Review possible duplicate” warning before payroll reconciliation. Never silently treat both rows as ordinary reconciled events.

## Gate 2: production recovery

Requires a separate explicit write authorization after Gate 1 passes.

1. Re-run the recovery tool in dry-run mode against the hard-verified production target.
2. Confirm the source checksum, target proof, exact candidate count, zero semantic conflicts, and no unexpected candidate growth. Candidate and target HMACs must use explicit UTF-8 so Unicode rows verify identically in Node and Apps Script.
3. Open both production gates for one execution only: the CLI environment gate and the server-side `GIB_M1_RECOVERY_WRITE_INCIDENT` Script Property with the exact incident identifier. Valid recovery credentials alone must not enable writes.
4. Preserve the private payload and private receipt outside Git.
5. Execute once, then immediately replay the comparison. The replay must propose zero additions.
6. Verify the recovered aggregate count through both the Sheet and Daily Review. Confirm that pre-existing rows and Sheet-only rows are unchanged.
7. Remove or disable the server gate and close the CLI gate immediately after verification. Never delete by date, name, class, position, or broad range.

## Gate 3: genuine old-kiosk canary

Requires separate authorization and normal staff operation; auto-sync remains off.

1. Obtain and checksum a fresh local-history export before transmission. Compare it with the original export, the live Sheet, and the independent ledger.
2. Identify every post-export local sign-in and establish the complete expected queued set. The old kiosk sends its complete queue; do not assume it will send only one row.
3. Include one genuinely new, identifiable sign-in in the bounded expected set and preserve all local and ledger evidence.
4. Authorize one supervised delivery of the entire bounded queue.
5. Verify every expected row in the Sheet and Daily Review. Rely on full-row replay safety for rows already recovered.
6. If any row is absent or ambiguous, stop, preserve local evidence, keep auto-sync off, and restore the receiver/configuration if indicated.
7. Consider restoring auto-sync only after the entire bounded set reconciles. Until a future kiosk client retains its queue until a readable acknowledgment, continue local-history retention, independent recording, Daily Review monitoring, and daily reconciliation.

## Tablet verification procedure — prepare only

1. Open the same-origin M1 tablet diagnostic during a supervised Phase-B session; it has no network permission.
2. An authorized operator fills the two password fields through a private password-manager/autofill channel. Do not speak, message, screenshot, or manually display either value.
3. Run the local check and record only: receiver endpoint status, legacy credential status, auto-sync status, queue count, and local-history count.
4. Require `EXPECTED`, `MATCH`, and `OFF` before proceeding. Any other label stops the rollout.

## Rollback

- **Receiver code/deployment:** restore the snapshotted deployment version, then repeat non-mutating health checks.
- **Authentication configuration:** restore the snapshotted property/configuration set as one reviewed change; verify scope isolation before any delivery.
- **Recovery data:** use only the private execution receipt. Revalidate the target proof, row identity, and keyed full-row fingerprint for every inserted row; abort the entire rollback on any mismatch.

## Ongoing guardrails

- Require live-artifact fingerprints and exact client/receiver contract tests for every rollout.
- Require a genuine new-write canary before declaring production ready.
- Preserve duplicate-safe append/replay behavior and locking.
- Verify Daily Review after receiver or data changes.
- Reconcile kiosk, Sheet, Daily Review, and the independent ledger monthly; retain an aggregate audit receipt.
- A future kiosk client must keep queued rows until it receives and validates a readable server acknowledgment.
