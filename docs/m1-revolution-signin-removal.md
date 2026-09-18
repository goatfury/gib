# Revolution instructor sign-in removal

Adds “Remove sign-in” to the existing Daily Review and instructor lookup. One
confirmation carries the chosen instructor, class/date, and required reason.
Both uniquely identified kiosk and audited Admin-added entries are supported.
Protected or ambiguous records explain why removal is unavailable.

The receiver rechecks the exact ID and original stored business-field digest
under its write lock. It saves the immutable operation in a note on the RowID
cell, then writes one existing-format removal audit and changes only Status to
VOID. It rereads all three before acknowledging completion. Interrupted work
can be checked without writing and resumed by its original Admin, including
from a fresh session. Unknown existing cell notes are protected. The first
actor, reason and fingerprint cannot be replaced by a competing request.

The authenticated server session supplies the actor. Exact Revolution origins,
wrapper identity, target environment and existing Admin credentials are required.
Richmond retains its own route, wrapper and eligibility. Older Revolution Admin
reads keep their old response shape. Kiosk and Admin-add permanent-ID replay
protections remain in place. Signins and Admin Audit export columns are unchanged.

## Milestones

- Built: isolated branch from live baseline 3876433161a393fa15262f40ac9179be4e093029.
- Hosted TEST: verification in progress; release remains blocked until complete.
- Revolution release: not approved or performed.
- Stu usability: not confirmed; his availability does not block TEST preparation.

## Release after separate approval

1. Pin the approved commit, passing required checks, tested source digests and
   hosted TEST evidence. Reconfirm the production project and deployment are
   the existing Revolution project, with its production wrapper and properties.
2. Deploy the compatible receiver and production wrapper first. Do not run
   provisioning, change sharing, rewrite properties, or write attendance data.
   Verify normal read-only production review and versioned eligibility.
3. Release matching server/UI assets on Revolution only. Check login, reads,
   the removal confirmation and Cancel without submitting a real removal.
4. After Stu agrees, give him one real correction to perform himself. Verify
   its exact durable status/audit and preserved neighboring entry read-only.

## Rollback and limits

Hide/disable new UI and mutation dispatch first if needed. Retain compatible
receiver read/recovery support until every pending operation is resolved.
Never revert the Sheet, clear operation notes, delete audits, reset VOID, or
restore an old workbook: that could resurrect removals or erase later records.
An older UI can still read active attendance while omitting the new audit type.

Central active attendance and lookup exclude VOID. A kiosk's local backup can
still contain the historical pre-removal copy; no local-device reconciliation
or external payroll/spreadsheet update is claimed. No physical tablet changes
are part of this feature.
