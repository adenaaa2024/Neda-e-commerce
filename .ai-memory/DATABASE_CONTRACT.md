# Database contract — canonical index

**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy` · **Future production:** NOT_CREATED_YET  
**Branch:** `feature/product-canonicalization-v2`  
**Last updated:** 2026-05-28 (`removal-api-product-resolution-checkpoint` `20260528T180000Z`)

| Topic | File |
|-------|------|
| Removal intake | [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md) |
| Product spine | [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) |
| Packaging | [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md) |
| Parity | [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) |

## expected_packages (removal-derived)

| Rule | Contract |
|------|----------|
| Intake table | **`expected_packages`** — no `accepted_packages` |
| Rebuild | `rebuild_expected_packages_from_removals(org, store?)` |
| Grain | One row per detail×shipment match + optional remainder row |
| Join | `org + store + order_id + order_type + order_date + sku + fnsku + disposition` (NULL-safe) |
| Forbidden join | SKU-only, FNSKU-only |
| Sources | `source_detail_row_id` → `amazon_removals.id`; `source_shipment_row_id` → `amazon_removal_shipments.id` or NULL |

## Product creation (removal path)

| Allowed | Forbidden |
|---------|-----------|
| Resolver persist when deterministic (separate wire) | Product create during removal fetch/rebuild |
| Governed promotion with Amazon evidence | Title-only / product-name-only create |

## Packaging `dimensions_current`

Operator checkpoint: **571** staging + original (post-Wave3). Last verify artifact: **441/441** (`20260526T214000Z`).

## Evidence

`supabase/migrations/20260631_expected_packages_derived_rebuild.sql` · `scripts/sp-api-removal-shipment-detail-api-plan.ts`
