# Resolver 19B — Production Migration Preparation Approval


Supabase project ref/name: kxsvedvpjldygtdbylsy
Environment: dev/staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-17T01:30:00Z


APPROVED_TO_PREPARE_RESOLVER_PRODUCTION_MIGRATION=true

## Scope (preparation only — NOT apply)

- Authorize production parity planning, read-only probes, and migration pack review
- **Does not** authorize DDL apply, RPC rebuilds, or Generic REMOVAL_SHIPMENT runs on production
- Apply requires separate artifact: `APPROVED_TO_APPLY_RESOLVER_17_PRODUCTION_MIGRATION_CHAIN=true` (NEXT-RESOLVER-19-EXECUTE)

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Staging 17-EXECUTE `parity_green: true` | |
| Staging 18A Generic path smoke (or waiver) | |
| Production ref distinct from staging dev `kxsvedvpjldygtdbylsy` | |
| Read-only production pre-apply probe completed | |
| Backup / PITR owner assigned | |

## Migration chain (staging-proven — 10 files)

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
Status: PENDING | APPROVED
Production project ref:
Approved by:
UTC date:
Notes:
```
