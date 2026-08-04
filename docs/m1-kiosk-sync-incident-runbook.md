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
5. Stop on target ambiguity, credential-scope overlap, semantic conflict, candidate growth, or any unexpected Sheet change.

## Gate 1: receiver deployment

Requires explicit production authorization after review and merge.

1. Snapshot the current receiver code, deployment version, and authentication configuration for rollback.
2. Configure separate secrets for the receiver transport, legacy kiosk append, Admin actions, and recovery. The values must be pairwise distinct. The legacy value is append-only and must never authenticate Admin or recovery actions.
3. Deploy the approved receiver version to the independently verified endpoint used by the old kiosk. Do not guess the target.
4. Run wrong-, missing-, and cross-scope authentication tests plus non-mutating Admin and recovery-list smoke tests.
5. If any check fails, restore the prior receiver version and authentication snapshot; keep auto-sync off.

## Gate 2: production recovery

Requires a separate explicit write authorization after Gate 1 passes.

1. Re-run the recovery tool in dry-run mode against the hard-verified production target.
2. Confirm the source checksum, target proof, exact candidate count, zero semantic conflicts, and no unexpected candidate growth.
3. Open the production write gate for one execution only. Preserve the private payload and private receipt outside Git.
4. Execute once, then immediately replay the comparison. The replay must propose zero additions.
5. Verify the recovered aggregate count through both the Sheet and Daily Review. Confirm that pre-existing rows and Sheet-only rows are unchanged.
6. Close the production write gate. Never delete by date, name, class, position, or broad range.

## Gate 3: genuine old-kiosk canary

Requires separate authorization and normal staff operation; auto-sync remains off.

1. Preserve the new local kiosk record and the independent staff-ledger entry before transmission.
2. Authorize one supervised delivery of one genuinely new sign-in through the actual old kiosk.
3. Independently confirm the exact new record in the real Sheet and Daily Review.
4. If it is absent or ambiguous, stop, preserve local evidence, keep auto-sync off, and restore the receiver/configuration if indicated.
5. Consider restoring auto-sync only after the canary and reconciliation pass. Until a future kiosk client retains its queue until a readable acknowledgment, continue local-history retention, independent recording, Daily Review monitoring, and daily reconciliation.

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
