# Resolver 19B — Production Migration Preparation Approval

```
PRODUCTION_PROJECT_REF=NOT_CREATED_YET
Supabase project ref/name: NOT_CREATED_YET
Environment: PRODUCTION ONLY (BLOCKED)
Approved by: (pending)
Approved at UTC: (pending)
```

```
APPROVED_TO_PREPARE_RESOLVER_PRODUCTION_MIGRATION=false
```

## Scope (preparation only — NOT apply)

- Authorize production parity planning, read-only probes, and migration pack review **only after** a distinct production ref exists
- **Does not** authorize DDL apply, RPC rebuilds, or Generic REMOVAL_SHIPMENT runs on production today
- Apply requires separate artifact: `APPROVED_TO_APPLY_RESOLVER_17_PRODUCTION_MIGRATION_CHAIN=false` (NEXT-RESOLVER-19-EXECUTE)

## Topology (canonical)

| Role | Ref |
|------|-----|
| Original / rollback | `kxsvedvpjldygtdbylsy` |
| Staging / local test | `eiqfaapyumhixxoeltgu` |
| Production | `NOT_CREATED_YET` |

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Staging 17-EXECUTE `parity_green: true` on **clone** | |
| Staging 18A Generic path smoke (or waiver) on `eiqfaapyumhixxoeltgu` | |
| Production ref distinct from `kxsvedvpjldygtdbylsy` and `eiqfaapyumhixxoeltgu` | |
| Read-only production pre-apply probe completed | |
| Backup / PITR owner assigned | |

## Migration chain (proven on pre-clone staging — 10 files)

Schema on `eiqfaapyumhixxoeltgu` is carried by ENV-04R Postgres clone; **do not re-apply** this chain on staging without a new approval.

1. `20260522_shipment_scan_allocation_tree.sql`
2. `20260523_removal_item_allocations.sql`
3. `20260524_rebuild_removal_item_allocations.sql`
4. `20260525_rebuild_shipment_tree_from_removal_shipments.sql`
5. `20260527_enrich_expected_packages_from_shipment_allocations.sql`
6. `20260528_canonical_cross_file_expected_packages.sql`
7. `20260628_backfill_expected_packages_shipment_meta.sql`
8. `20260629_backfill_expected_packages_shipment_meta_normalize.sql`
9. `20260815160000_claim_review_work_items.sql`
10. `20260816120000_claim_filing_requests.sql`

## Signoff

```
Environment: PRODUCTION ONLY
Status: BLOCKED
Production project ref: NOT_CREATED_YET
Approved by:
UTC date:
Notes:
```
