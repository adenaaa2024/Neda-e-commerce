# PIM-related table usage audit

**Date:** 2026-05-05  
**Scope:** Read/write/API/UI classification for catalog, enrichment, imports, and legacy paths. **No tables were dropped or deleted.**

---

## `catalog_identity_unresolved_backlog`

| Area | Details |
|------|---------|
| **Read** | `lib/product-identity-import.ts`; `app/(admin)/imports/import-actions.ts`; `scripts/import-product-identity.ts`; manual SQL scripts under `supabase/scripts/`. |
| **Write** | Product Identity pipeline / import resolution (same libs + scripts). |
| **API routes** | Admin import actions (reset/cleanup scoped by upload); not exposed on dashboard PIM JSON APIs directly. |
| **UI** | Admin Imports tooling; not PIM Catalog Hub grid. |
| **Role** | **Active** — identity triage when Product Identity cannot resolve a row cleanly. |
| **Classification** | Import / identity resolution; **not** catalog grid display. |

---

## `catalog_products`

| Area | Details |
|------|---------|
| **Read** | `lib/amazon-operational-product-resolve.ts`; `app/api/dashboard/products/[id]/route.ts`; RPCs/views referencing listings; `lib/import-listing-canonical-sync.ts` (indirect). |
| **Write** | `lib/import-listing-canonical-sync.ts` (listing CSV → canonical); `lib/product-identity-import.ts` / scripts; DB functions `merge_listing_into_catalog_products_v2`, `merge_fba_inventory_into_catalog_products` (migrations). |
| **API routes** | `/api/settings/imports/sync` (listing phases); product detail GET joins by SKU/ASIN. |
| **UI** | `ProductDetailDrawer` — “Amazon listings / catalog matches” table. |
| **Role** | **Active** — Amazon listing snapshot layer; bridge to `product_identifier_map`. |
| **Classification** | Import apply + operational enrichment; **catalog display** via product detail, not main grid row source. |

---

## `product_categories`

| Area | Details |
|------|---------|
| **Read** | `app/api/dashboard/product-categories/*`; `app/api/dashboard/products/catalog/enrich-images/route.ts` (name map); `app/api/dashboard/products/catalog/group-rollup/route.ts`; `app/api/dashboard/products/[id]/route.ts`; RPC `pim_catalog_products_page` (join); `backend-python/main.py` (PIM seed). |
| **Write** | Category CRUD routes; Python seed creates categories; **enrichment** (this change) may insert a row when Amazon-derived label is high-confidence. |
| **API routes** | Dashboard category APIs; catalog enrich POST. |
| **UI** | PIM filters, category column, forms; Settings product categories. |
| **Role** | **Active** — master taxonomy per org. |
| **Classification** | Import + **enrichment** + manual admin. |

---

## `product_identifier_map`

| Area | Details |
|------|---------|
| **Read** | Many: `lib/product-identifier-map-sync.ts`, `lib/product-identity-import.ts`, `lib/inventory-*-identifier-enrich.ts`, `app/api/dashboard/products/catalog/facets/route.ts`, `group-rollup`, `identifier-groups`, `app/api/dashboard/products/[id]/route.ts`, RPC `pim_catalog_products_page`, etc. |
| **Write** | Listing canonical sync, Product Identity sync, inventory enrich routes, identity import. |
| **API routes** | Imports process/sync/identity-enrich; dashboard catalog facets, group rollup, identifier-groups, product GET. |
| **UI** | PIM grid (via RPC), identifier groups, `ProductDetailDrawer` linked identities. |
| **Role** | **Active** — core bridge between listings, products, and reports. |
| **Classification** | Import apply + operational enrichment + **catalog display** (primary map row on grid). |

---

## `product_identity_staging_rows`

| Area | Details |
|------|---------|
| **Read** | `lib/product-identity-import.ts` (sync phase); `app/api/settings/imports/sync/route.ts`; `app/(admin)/imports/import-actions.ts` (reset); validation SQL scripts. |
| **Write** | `/api/settings/imports/process` (Product Identity Phase 2 staging only). |
| **API routes** | `process`, `sync`, import-actions reset. |
| **UI** | Universal importer progress (indirect). |
| **Role** | **Active** — staging between parse and final Product Identity upsert. |
| **Classification** | **Import preview/apply** pipeline only; not enrichment. |

---

## `raw_report_uploads`

| Area | Details |
|------|---------|
| **Read** | Widespread: imports chunk/classify/sync/generate-worklist, `app/dashboard/products/pim-actions.ts` (PIM seed history), tools, many migrations and docs. |
| **Write** | All Amazon / generic import uploads; ETL PIM seed (`PIM_CATALOG_SEED`). |
| **API routes** | Nearly all `/api/settings/imports/*`; admin tools; PIM seed history list. |
| **UI** | Admin imports UI, PIM “Quick catalog file import” history. |
| **Role** | **Active** — canonical upload audit row for every import kind. |
| **Classification** | **Import preview/apply** + PIM seed audit; **not** row-level catalog data (metadata only for PIM seed). |

---

## `import_report_registry`

| Area | Details |
|------|---------|
| **Repo search** | **No references** in this repository (table may exist only in other environments or legacy DBs). |
| **Recommendation** | Treat as **unknown / possibly legacy** until confirmed in live `information_schema`. The manual SQL audit script probes `to_regclass('public.import_report_registry')`. |

---

## Summary

| Table | Active | Legacy | Safe-to-archive later? |
|-------|--------|--------|-------------------------|
| `catalog_identity_unresolved_backlog` | Yes | No | Only after identity pipeline retired |
| `catalog_products` | Yes | No | No — core listing layer |
| `product_categories` | Yes | No | No |
| `product_identifier_map` | Yes | No | No |
| `product_identity_staging_rows` | Yes | No | No — clear after sync, not archive table |
| `raw_report_uploads` | Yes | No | No |
| `import_report_registry` | Unknown | Possible | Verify in DB before any action |

**Do not** use this audit as authorization to drop tables; it is documentation only.
