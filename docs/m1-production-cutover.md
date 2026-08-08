# M1 production cutover checklist

This checklist is prepared for a later, explicitly authorized cutover. Do not use it during production-candidate preparation. Keep auto-sync off until step 10, and stop at the first unexpected result.

- [ ] 1. Export and preserve the old tablet CSV.
- [ ] 2. Record the exact cutoff time.
- [ ] 3. Old CSV owns records before the cutoff.
- [ ] 4. New production Sheet owns records after the cutoff.
- [ ] 5. Keep the old tablet intact as rollback.
- [ ] 6. Install the new device through the one-time link or QR.
- [ ] 7. Keep auto-sync OFF.
- [ ] 8. Make one controlled real sign-in.
- [ ] 9. Manually send and verify the exact Google row.
- [ ] 10. Enable auto-sync.
- [ ] 11. Verify a second genuine sign-in.
- [ ] 12. Roll back immediately if either verification fails.
- [ ] 13. Reconcile old CSV + new Sheet + Stuart’s independent record for the split payroll period.

Rollback means auto-sync returns to OFF, the new path stops, and the intact old tablet remains the operating fallback while evidence is preserved. Do not delete or rewrite either side of the cutoff.
