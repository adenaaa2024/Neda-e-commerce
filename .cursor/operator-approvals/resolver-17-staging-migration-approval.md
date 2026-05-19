# Resolver / Removal / Shipment Staging Migration Approval

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-16T09:11:00.774Z

APPROVED_TO_APPLY_RESOLVER_17_STAGING_MIGRATION_CHAIN=false

Scope (historical — schema on `eiqfaapyumhixxoeltgu` via ENV-04R clone; **do not re-apply**):
- Staging target `eiqfaapyumhixxoeltgu` only
- Original source `kxsvedvpjldygtdbylsy`
- Apply migration chain from NEXT-RESOLVER-17
- Run post-apply schema checks
- Run smoke checks only after schema checks pass
- No production migration
- No product/scanner/claim data mutation except migration DDL/backfill explicitly in listed migrations
- Stop on any mismatch or missing dependency
