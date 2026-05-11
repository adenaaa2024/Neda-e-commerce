---
name: NEXT-18C choose next source
overview: After the catalog_products slice ran clean against an empty table, recommend amazon_amazon_fulfilled_inventory as the next source-table wiring — but run a small read-only count probe across the five candidates first, because this env returned 0 catalog_products and may not have FBA/orders data either.
todos:
  - id: probe
    content: Read-only HEAD count probe across the five candidate Amazon tables + catalog_products in this env, masked-sample 3 rows per non-empty table for org/store/upload visibility.
    status: completed
  - id: decide
    content: "Confirm amazon_amazon_fulfilled_inventory is non-empty (or pick the highest-ranked non-empty candidate from section A: 1 -> 2 -> 3 -> 4 -> 5)."
    status: completed
  - id: wire-extract
    content: Add AmazonAmazonFulfilledInventoryRowProjection + extractFromAmazonAmazonFulfilledInventoryRow to lib/audits/product-seed-identifier-extract.ts (native seller_sku/fnsku/asin, raw_data UPC fallback, expose resolved_product_id).
    status: completed
  - id: wire-script
    content: Refactor processCatalogProductsTenant into a descriptor-driven processTenantSlice in scripts/product-seed-dry-run-report.ts; widen slice gate to allow exactly catalog_products + amazon_amazon_fulfilled_inventory.
    status: completed
  - id: run-slice
    content: Run npx tsx scripts/product-seed-dry-run-report.ts --source-table=amazon_amazon_fulfilled_inventory --max-rows-per-table=1000 and verify reports + J-checks.
    status: completed
  - id: report
    content: Report bucket distribution, J3 ratio, and any new bucket-1 (already_resolved) or bucket-5 (cross-product conflict) findings.
    status: completed
isProject: false
---

# NEXT-18C — Choose Next Product-Seed Dry-Run Source Table

PLAN ONLY. No edits. No SQL. No migrations. No writes. No schema changes.

## Recap of the live state

- The NEXT-18B first slice ran successfully against `catalog_products`:
  - exit code `0`, `rows_scanned=0`, `pairs_discovered=0`
  - five required reports + manifest + run-summary + validation-checks were written
  - a direct count probe of `catalog_products` returned `count=0`
- The orchestrator [scripts/product-seed-dry-run-report.ts](scripts/product-seed-dry-run-report.ts) currently rejects every other source table via `extractNotImplemented(t)` (gate at lines ~681-684).
- [lib/audits/product-seed-identifier-extract.ts](lib/audits/product-seed-identifier-extract.ts) only exports `extractFromCatalogProductsRow`; all other 13 tables throw "not yet implemented".

## A. Per-candidate comparison (migration- and mapper-grounded)

For each candidate I list: native identifiers, tenant scoping, upload linkage, resolver convention, overflow JSON, prior-plan signal, and a risk/complexity verdict for the extractor.

### 1. `amazon_amazon_fulfilled_inventory` — RECOMMENDED NEXT

- Native identifiers: `seller_sku`, `fulfillment_channel_sku` (FNSKU), `asin` — full high-confidence triad, no `raw_data` peek needed for core IDs. Source: `supabase/migrations/20260622_fba_inventory_engine_wave4.sql` lines 173-175.
- Tenant: `organization_id uuid NOT NULL`, `store_id uuid` nullable FK. Same migration lines 167-168.
- Upload linkage: `source_upload_id uuid` FK to `raw_report_uploads(id) ON DELETE SET NULL`. Same migration lines 169-170. Matches the `catalog_products` convention already wired in the orchestrator.
- Resolver: Convention A — `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence` added in `supabase/migrations/20260642_amazon_import_file_alignment.sql` lines 146-150.
- Overflow: `raw_data jsonb`. Same Wave 4 migration line 179.
- Mapper: `mapRowToAmazonAmazonFulfilledInventory` in [lib/import-sync-mappers.ts](lib/import-sync-mappers.ts) lines ~2921-2932 writes all three identifiers natively + `organization_id`, `store_id`, `source_upload_id`.
- Prior plans: ingestion audit calls it the "highest-priority identity carrier" ([.cursor/plans/ingestion_surface_audit_3b536b91.plan.md](.cursor/plans/ingestion_surface_audit_3b536b91.plan.md) lines 304-305); NEXT-18A audit notes "high match rate" for product seeding.
- Row count: no exact prior figure but described as a populated production carrier in store-attribution plans.
- Verdict: lowest extractor complexity, no new conventions, smallest column surface. Best fit for the second wiring slice.

### 2. `amazon_manage_fba_inventory`

- Native identifiers: `sku` (with `msku`/`merchant-sku`/`seller-sku` aliases), `fnsku`, `asin`, `product_name`. Source: `supabase/migrations/20260604_amazon_missing_report_tables.sql` lines 98-100; `supabase/migrations/20260622_fba_inventory_engine_wave4.sql` lines 29-30.
- Tenant: `organization_id NOT NULL`, `store_id` nullable FK. Same 20260604 migration lines 94-95.
- Upload linkage: `source_upload_id uuid` FK. Same migration lines 96-97.
- Resolver: Convention A — `supabase/migrations/20260642_amazon_import_file_alignment.sql` lines 140-143.
- Overflow: `raw_data jsonb`. Same 20260604 migration line 102.
- Mapper: `mapRowToAmazonManageFbaInventory` in [lib/import-sync-mappers.ts](lib/import-sync-mappers.ts) lines ~2614-2658.
- Prior plans: NEXT-18A rank #3 ([.cursor/plans/product_seed_candidate_audit_4f2574f0.plan.md](.cursor/plans/product_seed_candidate_audit_4f2574f0.plan.md) lines 106-107).
- Verdict: same conventions as #1 but a much wider native column surface. Save for slice 3 — wiring it after #1 gives a clean A/B comparison of identical patterns.

### 3. `amazon_fba_inventory`

- Native identifiers: `sku`, `fnsku`, `asin`, `product_name`. Source: `supabase/migrations/20260604_amazon_missing_report_tables.sql` lines 122-124.
- Tenant + upload: same pattern (`organization_id NOT NULL`, nullable `store_id` FK, `source_upload_id uuid` FK).
- Resolver: **Convention C** — no `resolved_product_id` columns. `20260642_amazon_import_file_alignment.sql` does not add resolver columns to this table, and `NATIVE_COLUMNS_FBA_INVENTORY` ([lib/import-sync-mappers.ts](lib/import-sync-mappers.ts) lines ~344-369) has no resolver entries.
- Overflow: `raw_data jsonb`.
- Prior plans: NEXT-18A confirms Convention C for this table (audit lines 88, 107). One of the NEXT-18A deferred open questions is "should we add the resolver quad here?" — this is exactly why wiring it earlier risks polluting the audit.
- Verdict: rich identifiers, but introduces a second convention (C vs A) the second slice should not test. Save for slice 4.

### 4. `amazon_inventory_ledger`

- Native identifiers: `sku`, `asin`, `fnsku`, `product_name`, `title`. Strong surface.
- Tenant: `organization_id NOT NULL`, `store_id` nullable (added later by [supabase/migrations/20260705120000_pim_model_stabilization.sql](supabase/migrations/20260705120000_pim_model_stabilization.sql) lines 223-228).
- Upload linkage: uses **`upload_id`** (not `source_upload_id`). The orchestrator's current `processCatalogProductsTenant` hard-codes `upload_linkage_col: "source_upload_id"` — wiring ledger needs a `castMode`/`uploadCol` parameter on the per-table runner.
- Resolver: Convention A — `supabase/migrations/20260620_product_identifier_map_ledger_enrichment.sql` lines 59-63.
- Overflow: `raw_data jsonb` ([supabase/migrations/20260430_amazon_prefix_global_refactor.sql](supabase/migrations/20260430_amazon_prefix_global_refactor.sql) lines 39-41).
- Row count: ~282,352 eligible rows per [.cursor/plans/store_attribution_implementation_e735ebee.plan.md](.cursor/plans/store_attribution_implementation_e735ebee.plan.md) line 17. With `--max-rows-per-table=1000` per tenant this is still bounded.
- Mapper note: no in-repo `CREATE TABLE`; baseline DDL lives outside the present migrations.
- Verdict: high value but introduces a new upload-column convention. Save for slice 5 once the `uploadCol` parameter is generalised.

### 5. `amazon_all_orders`

- Native identifiers: `sku`, `product_name` only. **`asin` and `fnsku` are NOT native** — they live in `raw_data`. Mapper return in [lib/import-sync-mappers.ts](lib/import-sync-mappers.ts) lines ~2438-2472 has no asin/fnsku.
- Tenant + upload: `organization_id NOT NULL`, `store_id` nullable, `source_upload_id uuid` FK ([supabase/migrations/20260604_amazon_missing_report_tables.sql](supabase/migrations/20260604_amazon_missing_report_tables.sql) lines 17-19).
- Resolver: Convention A ([supabase/migrations/20260642_amazon_import_file_alignment.sql](supabase/migrations/20260642_amazon_import_file_alignment.sql) lines 35-38).
- Prior plans: NEXT-18A ranks it #9 with SKU-only emphasis (audit lines 108, 112).
- Verdict: highest extractor complexity — must peek `raw_data` for the two most important product-seed identifiers (ASIN, FNSKU). Save for slice 6+ after raw-data extraction is exercised on a simpler table.

## B. Recommended next source table

**`amazon_amazon_fulfilled_inventory`** — for the reasons in section A.1.

## C. Exact extractor fields to implement (when approved)

In [lib/audits/product-seed-identifier-extract.ts](lib/audits/product-seed-identifier-extract.ts), add a new pure function `extractFromAmazonAmazonFulfilledInventoryRow` that mirrors `extractFromCatalogProductsRow` but reads:

- `seller_sku` native -> `identifiers.seller_sku` via `normalizeSellerSku`
- `fulfillment_channel_sku` native -> `identifiers.fnsku` via `normalizeFnsku` (FNSKU regex still applies)
- `asin` native -> `identifiers.asin` via `normalizeAsin`
- `raw_data` -> fallback for `upc` (keys: `upc`, `upc-code`, `upc_code`, `UPC`, `gtin`, `GTIN`) — same logic as catalog_products
- no `listing_id` on this table (omit)
- no `item_name`/`title` natively — omit `title` for now (consistent with NEXT-18A "name only" handling on tables that lack title columns)
- pass `resolved_product_id` (native column on this table) into the row projection so the orchestrator can set `rowAlreadyResolved = true` when populated — this exercises bucket 1 for the first time

Projection type:

```typescript
export type AmazonAmazonFulfilledInventoryRowProjection = {
  id: string;
  organization_id: string | null;
  store_id: string | null;
  seller_sku: string | null;
  fulfillment_channel_sku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  source_upload_id: string | null;
  raw_data: unknown;
};
```

## D. Query strategy

In [scripts/product-seed-dry-run-report.ts](scripts/product-seed-dry-run-report.ts):

1. Add a small per-table descriptor map (table name -> select projection, upload column name, raw-overflow column name, conventionA-resolver column names) so `processCatalogProductsTenant` becomes `processTenantSlice(table, descriptor, ...)`. Catalog stays wired with the new descriptor.
2. Discovery: same `(organization_id, store_id)` pair scan but against `amazon_amazon_fulfilled_inventory`. Pairs accumulate across all requested source tables (already supported by the discovery function — just parameterise the table name).
3. Pagination: same keyset-by-`id` 1000-row pages, capped by `--max-rows-per-table` per tenant.
4. Indices already loaded per tenant (`product_identifier_map`, `products`, `raw_report_uploads.id`) are reused for all source tables for that tenant — no extra preload cost.
5. `rowAlreadyResolved` is `true` when `resolved_product_id` is a non-null UUID; the classifier already supports bucket 1 (`already_resolved`).

## E. Expected report behavior (slice 2)

- `00-roll-up.csv` gains rows for `source_table=amazon_amazon_fulfilled_inventory` with bucket breakdowns; existing catalog rows continue to appear when `--source-table=catalog_products` is also passed.
- `01-rows.ndjson` gets per-row NDJSON for this table including `existing_product_id_hit` populated when `resolved_product_id` is non-null (first observed bucket-1 rows).
- `02-identifier-fan-out.json` is unchanged in shape — fan-out is computed from the per-tenant identifier-map index, not from the source row.
- `03-cross-product-conflict.csv` may show new rows if a `(seller_sku, asin)` pair on this table maps to multiple `product_id`s across the identifier map.
- `04-provenance-gap.csv` may show new rows for FBA inventory rows whose `source_upload_id` is null or unresolved.
- `05-validation-checks.json` J3 ratio (upload provenance >= 99%) is the most likely strict regression — FBA inventory often has rows from manual API pulls without an upload row.

## F. Agent implementation scope if approved

The wiring is intentionally small — three surgical changes:

1. [lib/audits/product-seed-identifier-extract.ts](lib/audits/product-seed-identifier-extract.ts):
   - Add `AmazonAmazonFulfilledInventoryRowProjection` type.
   - Add `extractFromAmazonAmazonFulfilledInventoryRow` (mirrors catalog flow, native triad + raw_data UPC).
   - Keep `extractNotImplemented` for the remaining 12 tables.
2. [scripts/product-seed-dry-run-report.ts](scripts/product-seed-dry-run-report.ts):
   - Refactor `processCatalogProductsTenant` into a generic `processTenantSlice(table, descriptor, sb, index, accum, ...)` driven by a small per-table descriptor (select string, upload column, resolver column, extractor function, `rowAlreadyResolved` derivation). Catalog descriptor stays exact.
   - Add the FBA descriptor.
   - Update the slice gate to allow `catalog_products` OR `amazon_amazon_fulfilled_inventory`. Everything else still throws `extractNotImplemented`.
3. No changes to:
   - [lib/audits/product-seed-classifier.ts](lib/audits/product-seed-classifier.ts) (existing 11-bucket logic already handles bucket 1)
   - [lib/audits/product-seed-output.ts](lib/audits/product-seed-output.ts) (output schema unchanged)

Run command after wiring (single tenant, bounded):

```bash
npx tsx scripts/product-seed-dry-run-report.ts \
  --source-table=amazon_amazon_fulfilled_inventory \
  --max-rows-per-table=1000
```

J-check expectations:
- J1, J4-J7 stay strict-pass by classifier construction.
- J3 may slip below 0.99 (non-strict) — investigation, not a failure.
- J8 dirty rate should stay below 10% given native triad.

## G. Do-not-touch list (unchanged from NEXT-18B)

- Do NOT modify `products`, `product_identifier_map`, `catalog_products`, `product_prices`, or `product_identity_staging_rows` (no UPDATE / INSERT / DELETE).
- Do NOT add migrations, ALTER TABLE, or new indexes.
- Do NOT widen `_pim_resolve_product` (deferred NEXT-18A open question).
- Do NOT add resolver columns to `amazon_fba_inventory` (deferred NEXT-18A open question).
- Do NOT change `amazon_reports_repository.upload_id` type (deferred NEXT-18A open question).
- Do NOT add `.gitignore` entries (operator decision, deferred).
- Do NOT enable any source table other than `catalog_products` and `amazon_amazon_fulfilled_inventory` in the slice gate.
- Do NOT alter [lib/import-sync-mappers.ts](lib/import-sync-mappers.ts) or any ingestion-write path.

## Final recommendation

**Run a small read-only count/identifier audit first, then go to Agent mode for the FBA wiring.**

Justification: catalog_products was empty in this env; if `amazon_amazon_fulfilled_inventory` is also empty here, wiring it would produce another zero-row report with no new signal. A 30-second HEAD-count probe across the five candidates settles which table will actually exercise the new code path before any agent-mode changes are made.

Suggested probe (read-only, no writes):

```bash
npx tsx -e "...HEAD count loop over the five tables..."
```

(The exact one-liner mirrors the probe we already ran for catalog_products and would be issued as a single Agent-mode shell call before wiring.)

If the probe shows `amazon_amazon_fulfilled_inventory` is populated, proceed directly to the agent-mode wiring in section F.

If the probe shows it is empty but `amazon_manage_fba_inventory` or `amazon_inventory_ledger` is populated, switch the slice target to whichever is non-empty (still following section A's complexity ordering — manage_fba is the simpler fallback; ledger requires the `uploadCol = "upload_id"` parameterisation).

If all five are empty, this is a fixture problem, not a wiring problem — defer further wiring until a fixture or non-empty environment is available.
