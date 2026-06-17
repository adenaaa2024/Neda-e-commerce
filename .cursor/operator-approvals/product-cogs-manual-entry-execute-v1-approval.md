# Product COGS manual entry execute V1 approval

**Phase:** PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 (controlled `cogs_overrides` write)  
**Contract:** `lib/claims/submission/product-cogs-manual-entry-execute-v1.ts`  
**Target DB:** original/live `kxsvedvpjldygtdbylsy`

## Prerequisites (must be yes before execute)

- PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1 PASS
- PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1 PASS
- `SAFE_COGS_MANUAL_ENTRY_UI_READY=yes`
- `SAFE_TO_PLAN_COGS_APPLY_EXECUTE=yes`
- Operator input file populated: `.cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json`
- **Do not invent COGS** — values must come from COGS Entry UI or approved CSV dry-run only

APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1=yes
ALLOW_PARTIAL_COGS_WRITE=no

Also requires **APPROVED_PRODUCT_COGS_WRITE_V1=yes** in `.cursor/operator-approvals/product-cogs-source-build-v1-approval.md`.

## Scope

Original org/store only:

- **Org:** `00000000-0000-0000-0000-000000000001`
- **Store:** `509ee1f6-622c-46a5-8110-7b889ba46c2c`
- **Pilot run:** `pilot-20260615T190000Z`
- **Intake run:** `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`
- **FNSKUs (6):** X004D9AMWV, X003VSWH37, X004TRQBB3, X004LLJMN1, X004WJ8OE5, X004N992LN

Writes **only** `workspace_settings.module_configs.claim_intake.cogs_overrides[fnsku]` (rich record + audit log).

## Explicitly out of scope

- Mutating `claim_submissions`, `claim_cases`, `claim_lines`, `claim_candidates`
- Amazon SP-API / claim submission
- Broad migrations / `product_cost_snapshots`
- Scanner / Product Core resolver / RBAC changes
- AI/GPT
- Using sale price as COGS without explicit operator confirmation

## Rollback

Restore prior `cogs_overrides` JSON via generated `rollback.sql` (no hard delete of claim data).

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | |
| Date (UTC) | |
| Input file | `.cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json` |

**Decision:** [ ] APPROVED  [x] DEFER — operator sets approval token to `yes` on its own line when ready
