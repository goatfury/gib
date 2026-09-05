# Richmond sign-in incident — open

## Outcome required

Trey must be able to use the Richmond sign-in tablet on Monday, September 7,
without remote troubleshooting. Andrew has the tablet at home until Monday
at the earliest. Keep driving the investigation toward that outcome; when
blocked, complete unaffected work and give one concrete unblock action.
Do not close the incident on a successful page load, diagnostic, or test suite.

## Verified facts

- Repository: `goatfury/gib`; working branch: `fix/richmond-startup-sync-retry`.
- Richmond kiosk: https://gib-richmond-live.netlify.app/m1/
- Read-only tablet check: https://gib-richmond-live.netlify.app/m1/connection.html
- Richmond Netlify site: `9b7757a9-70f4-4977-9ca2-270b41e34007`.
- Production sheet: https://docs.google.com/spreadsheets/d/1lGa-kmqqDiPGSg1Y1ZPyhDV3Wk_ZJ28p1pARRvV1iWc/edit
- On September 5, 23 active entries from August 31–September 5 reached the
  sheet after the tablet moved home. The old August 26 installation row is
  also present, marked VOID. This is not a payroll reconciliation.
- The user's tablet photo at 3:08:04 PM New York time shows: service reached,
  device accepted, automatic sending On, waiting 0, local history 24,
  last confirmed upload 2:50:36 PM, production sheet not confirmed.
- This is evidence about the home connection only. It does not establish
  what happened on the gym network.
- The failed check is the existing authenticated `ledgerStatus` request
  from Netlify to the Google receiver. The frontend diagnostic does not
  create sign-ins, change auto-sync, or read credentials.
- Sheet title, two tab names, and the eleven headers of each match the
  receiver's required schema in live Drive reads. The precise backend
  reason for the failed check is still unknown.

## Changes already released

- A reproduced startup bug left Richmond auto-sync off after an initial
  status failure. The normal retry timer and wake events now retry that
  incomplete activation; a 30-second timeout releases stalled requests.
- Retry fix GitHub commit: `ed3ab5d13d65f0e14b58f9c59c45db9f052045a2`.
  The offline shell revision is `2026-09-05-richmond-sync-retry`.
  This fixes a demonstrated defect; it is not proof of the original cause.
- Initial connection check GitHub commit:
  `108e735b0a175cad7b2e5a491bf6f9fc70f298bb`.
- These changes were deployed only to Richmond. Revolution's last checked
  deploy was `6a95d82e6ea2ad000986b4ea` and was not changed here.

## Active diagnostic route

The connection page requests `details-v1` using
`X-GIB-M1-Connection-Check`. Only an authorized Richmond tablet receives the
fixed `X-GIB-M1-Check-Code` category. Ordinary activation JSON, authentication,
write gates, and the upstream request remain unchanged. No account logs,
upstream bodies, identifiers, or credentials are exposed.

Use the actual tablet's reported code to select the next investigation:

- `TIMEOUT_OR_NETWORK`, `HTTP_FAILURE`, `HTML_RESPONSE`, or incomplete/invalid
  reply: inspect the server-to-Google delivery path and receiver availability.
- `RECEIVER_REJECTED`: distinguish receiver authentication, receiver schema
  validation, and lock contention. The receiver currently combines these
  into one rejection; this code alone does not identify which one occurred.
- `CONTRACT_MISMATCH`: compare the deployed receiver's exact response with
  the Netlify validator. Do not relax target or write checks to make it green.
- `WRITES_DISABLED` or `SERVER_WRITES_DISABLED`: verify the intended existing
  configuration and authorization before changing any gate.
- `CONFIRMED`: the read-only access check passed now; it is not a new-write
  canary or proof of gym connectivity.

## Access constraints

Browser access to Netlify's account logs was denied, and a subsequent request
was rejected by automatic approval review for repeating that denied access
without explicit authorization. Do not retry or bypass that restriction.
The app's narrowly scoped, authorized-device diagnostic is an independent
route and does not read those account logs. Broad secret-variable reads were
also rejected earlier; do not repeat them or disclose server credentials.

Do not reset the tablet, clear its history, change admin credentials, alter
Revolution, create fake production payroll entries, or void recovered entries
as part of this incident without the appropriate user instruction.

## Completion evidence still required

1. Explain and resolve the failed server-to-sheet check, or demonstrate a
   transient failure with sufficient evidence rather than assuming one.
2. Verify the exact live Richmond release and recovery behavior; preserve
   local entries until complete acknowledgments arrive.
3. Confirm a normal sign-in from the actual tablet at Richmond arrives in
   the production sheet. Home tests cannot substitute for this.
4. Only then report the Richmond operational outcome. Broader remote-customer
   readiness additionally needs visible upload status and useful remote
   diagnostics; it has not been established.
