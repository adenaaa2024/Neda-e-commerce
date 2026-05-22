# Return items test cohort cleanup — V186 operator approval

**Scope:** Quarantine fake/test `return_items` on staging only (4 PK allowlist).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `CLEANUP_METHOD` | `soft_delete` (or `hard_delete` if operator overrides) |

## PK allowlist (only these rows)

- `23ccf73f-cbda-485e-9ebb-cc8e365b9172`
- `3270ee19-441d-4b30-9d66-0273c46ea247`
- `ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663`
- `e08156b5-6f59-4bad-9a33-330c500df9cd`

## Preconditions

- [ ] Review `.cursor/audit-reports/return-items-source-identifier-cleanup-v186/<run_id>/fake-test-row-cleanup-plan.md`
- [ ] Preimage CSV exported before UPDATE/DELETE
- [ ] No `return_items` resolver execute in same window

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
CLEANUP_METHOD=soft_delete
Approved by: Main/user (Track A execute prompt)
UTC date: 2026-05-21
```
