# Return items fake/test cleanup — V186 operator approval

**Scope:** Quarantine fake/test `return_items` on staging (4 PK allowlist). Plan-only governance file; execute requires explicit approval.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `CLEANUP_METHOD` | `soft_delete` |

## PK allowlist (only these rows)

- `23ccf73f-cbda-485e-9ebb-cc8e365b9172` — Sam synthetic X00X/B0X
- `3270ee19-441d-4b30-9d66-0273c46ea247` — test3 org
- `ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663` — test3 org
- `e08156b5-6f59-4bad-9a33-330c500df9cd` — test3 org

**Excluded:** `bd5bf0d6-500a-4696-80c6-7c0e65f539b6` (real Sam row — spine/resolver complete)

## Staging Track A (already executed)

Sibling approval [return-items-test-cohort-cleanup-v186-approval.md](./return-items-test-cohort-cleanup-v186-approval.md) recorded execute on **`20260521T200000Z`** (4 rows soft-deleted, active cohort 3).

**Do not re-execute** unless operator intentionally re-runs with idempotent script after reviewing audit:

`.cursor/audit-reports/return-items-fake-test-cleanup-approval-plan-v186/20260522T220000Z/`

## Preconditions

- [ ] Review `fake-test-candidates.md` and `recommended-cleanup-plan.md` in approval-plan audit folder
- [ ] Preimage CSV exported before UPDATE
- [ ] Staging ref guard only — **no production**
- [ ] No `return_items` resolver execute in same window
- [ ] No `package_items` changes

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
CLEANUP_METHOD=soft_delete
Approved by: Main/user (FAKE-TEST-CLEANUP-EXECUTE-V186)
UTC date: 2026-05-22
```
