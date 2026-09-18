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
- Hosted TEST: passed on September 18, 2026. Application commit
  `560aa7aa8e9313f3b1709ba5eeadced3d90c3bb8`; subsequent changes are this handoff
  and one additional contract assertion, with no application changes.
- Exact TEST Admin:
  https://6aad5ea3781e0a0007507562--gib-live.netlify.app/m1/admin/
- Existing dedicated TEST receiver deployment: version 20. Normalized source
  readback fingerprints (FNV-1a): receiver `d5d1c0c5`, TEST wrapper `70bd6941`.
  No production script, properties, sharing or deployment was changed.
- Revolution release: not approved or performed.
- Stu usability: not confirmed; his availability does not block TEST preparation.

## Verification

Hosted controls used the existing TEST receiver and actual TEST workbook.
Independent Sheets reads verified persistence; browser state was not the proof
of the write. Fixtures contain synthetic instructors only.

| Check | Result |
| --- | --- |
| Wrong Level 2 kiosk entry, existing Level 1 Admin entry, other Level 2 instructor | Removed only the wrong entry through Daily Review. VOID and one complete audit; both neighboring entries unchanged. Fresh Admin session agreed. |
| Admin entry created later than its class date | Removed a canonical, audited Admin-added entry through instructor lookup. Refresh showed no active match. |
| Cancel and missing reason | No status, operation note or audit change. |
| Duplicate and competing requests | One original removal audit. A different Admin could not finish a pending request; after its owner finished, the second session received the original receipt. |
| Lost response | Discarded a submitted removal response, then reconciled it read-only in a fresh session. One VOID and one audit. |
| Interrupted note-only / note-plus-audit writes | Seeded synthetic partial persistence directly in TEST, then finished each through hosted Admin. Original actor/reason retained; existing audit reused. |
| Authentication renewal | Expired request protection rejected the action and cleared private dialog content. Signing in again preserved the saved request, which checked and completed correctly. |
| Stale and duplicate-ID targets | Rejected; still active with no removal audit. Ambiguous entries had no enabled removal action. |
| Unauthorized and wrong-gym requests | Rejected: unauthenticated 401, cross-origin/cross-gym 403, client-supplied actor 400. |
| Old kiosk and Admin-add replay | Rejected; independent readback still showed VOID with one original removal audit. |
| Final ledger comparison | Five intended targets VOID, one removal audit each, original ten business fields unchanged. Other instructor, correct class and protected legacy entry unchanged. |
| Responsive controls | Visual and actual Cancel checks at 1366 x 900, 768 x 1024 and 390 x 844. Dialog stayed inside the viewport, no horizontal overflow, action controls at least 44 pixels high. No physical-tablet claim. |

Focused receiver/API/journal tests passed. Required regression gate passed with
1,041 current tests and no failures or skips; the frozen compatibility check
also passed with its documented superseded expectations. The independent
reviewer found no remaining material authorization, targeting, retry/audit or
compatibility issue after the conflict-escape fix.

The ordinary kiosk sign-in, Undo/privacy, Staff Clock, queues and temporary-class
implementations are unchanged from the verified main baseline. Reused valid
hosted evidence in `m1-kiosk-privacy-qa.json` and `m1-elegant-qa.json`, together
with the required regression gate and retained Richmond tests. No physical
device was changed. Public Admin HTML, removal journal, kiosk HTML and the two
class helpers matched the local build byte for byte at the exact TEST URL.

Read-only production recheck confirmed the two requested live entries and
their existing audit remain unchanged. Published production deployment remains
`6aa72e54c392e20008f5b1f6` at the verified baseline. No live transaction occurred.

## Release after separate approval

1. Pin the approved commit, passing required checks, tested source fingerprints and
   hosted TEST evidence. Reconfirm the production project and deployment are
   the existing Revolution project, with its production wrapper and properties.
2. Deploy the compatible receiver and production wrapper first. Do not run
   provisioning, change sharing, rewrite properties, or write attendance data.
   Verify normal read-only production review and versioned eligibility. Keep the
   existing web-app deployment identity, access and properties. Its compatible
   unversioned reads support the older live UI during this step.
3. Release matching server/UI assets on Revolution only. Check login, reads,
   the removal confirmation and Cancel without submitting a real removal.
   Confirm the published application and receiver match the approved artifacts.
4. After Stu agrees, give him one real correction to perform himself. Verify
   its exact durable status/audit and preserved neighboring entry read-only.

## Rollback and limits

For a controlled rollback, stop initiating new removals and reconcile saved
operations through Check saved removal; let the original Admin finish any
pending operation before retiring the new server/UI. Restore the previous
Netlify deployment to withdraw the new controls and Revolution removal route.
Retain the compatible receiver. If urgent withdrawal precedes reconciliation,
preserve pending operations and restore the compatible recovery route before
finishing them; never pretend the withdrawal undid an uncertain write.
Never revert the Sheet, clear operation notes, delete audits, reset VOID, or
restore an old workbook: that could resurrect removals or erase later records.
An older UI can still read active attendance while omitting the new audit type.
Do not redeploy the old receiver over unresolved operation notes. TEST can be
withdrawn with the same sequence; synthetic evidence may remain in TEST.

Central active attendance and lookup exclude VOID. A kiosk's local backup can
still contain the historical pre-removal copy; no local-device reconciliation
or external payroll/spreadsheet update is claimed. No physical tablet changes
are part of this feature.

The existing Google route intermittently returned a timeout or unreadable
acknowledgment during TEST. The UI retained uncertain requests and offered
read-only Check/Retry; independently reconciled writes were never blindly sent
again. One completed removal needed a read-only view refresh retry. This is a
genuine operational limitation, not a claim that every response was immediate.

## Later handoff

After separately approved release and Stu's agreement, send one correction
task through his normal live Admin page. This task sends no message. After he
reports completion, verify the exact status/audit and preserved correct entry
read-only; do not submit another removal. Keep real names and record identifiers
in the private task context, outside this public evidence.
