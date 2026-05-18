# Resolver / Removal / Shipment Staging Migration Approval

Supabase project ref/name: kxsvedvpjldygtdbylsy
Environment: staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-16T09:11:00.774Z

APPROVED_TO_APPLY_RESOLVER_17_STAGING_MIGRATION_CHAIN=true

Scope:
- Staging only
- Apply migration chain from NEXT-RESOLVER-17
- Run post-apply schema checks
- Run smoke checks only after schema checks pass
- No production migration
- No product/scanner/claim data mutation except migration DDL/backfill explicitly in listed migrations
- Stop on any mismatch or missing dependency
