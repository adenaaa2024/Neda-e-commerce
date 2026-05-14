# Table product link strategy

<!-- markdownlint-disable MD013 MD060 -->

**Slice:** NEXT-PRODUCT-ID-02  
**Purpose:** Canonical per-table plan for product graph links. **Confirm every column** with live `information_schema` or [sql/01_column_presence_audit.sql](./sql/01_column_presence_audit.sql).

**Class labels:** `graph-root` | `operational` | `staging` | `raw-source` | `downstream-derived`

---

## Legend (columns)

- **Current product columns (typical):** names observed in repo migrations / app usage — **not a substitute for live schema**.
- **resolved_product_id strategy:** target use of resolver output column(s) when present.
- **Keep raw identifiers:** always **yes** for operational/raw-source tables; raw SKU/ASIN/FNSKU columns stay.
- **Resolver mandatory:** should new/changed rows go through resolver before trusting links?
- **Human review:** required before auto-create / ambiguous link?

---

## Core graph

### products

| Field | Value |
|-------|--------|
| **Class** | graph-root |
| **Typical product columns** | `id` (canonical product PK), `organization_id`, `store_id`, SKU/ASIN/FNSKU-style columns (verify names), lifecycle / merge fields |
| **resolved_product_id** | N/A on root (this row **is** the product); optional mirrors elsewhere only if explicitly modeled |
| **catalog_product_id** | If PIM links catalog hub row to product — verify FK column name |
| **Keep raw identifiers** | yes (native columns + any `raw_*` / JSON) |
| **Downstream** | All operational tables resolve **to** `products.id` |
| **Risk** | high (root of graph) |
| **Backfill readiness** | N/A for “backfill product_id” — instead **merge/orphan** policies are separate |
| **Lineage** | `source_upload` / import provenance where applicable |
| **Resolver mandatory** | new row creation via approved pipeline only |
| **Human review** | yes for merge / duplicate / soft-delete |

### catalog_products

| Field | Value |
|-------|--------|
| **Class** | graph-root (catalog hub) |
| **Typical product columns** | `id`, `organization_id`, `store_id`, link to `products` (verify), listing identifiers |
| **resolved_product_id** | Usually expressed via `product_id` / FK to `products`; naming varies — verify |
| **catalog_product_id** | PK of this table |
| **Keep raw identifiers** | yes |
| **Downstream** | PIM UI, identifier map bridge, pricing facets |
| **Risk** | high |
| **Backfill readiness** | after PIM + map alignment |
| **Lineage** | import sessions, catalog bridge events |
| **Resolver mandatory** | yes for hub writes |
| **Human review** | yes for cross-listing merges |

### product_identifier_map

| Field | Value |
|-------|--------|
| **Class** | graph-root (index, not “raw source”) |
| **Typical product columns** | `product_id`, identifier columns (`seller_sku`, `asin`, `fnsku`, …), `organization_id`, `store_id`, partial unique indexes |
| **resolved_product_id** | N/A (map stores canonical `product_id`); resolver **reads** map |
| **catalog_product_id** | May exist for bridge (see migrations) |
| **Keep raw identifiers** | preserve `match_source` / provenance metadata |
| **Downstream** | Resolver primary index; inventory ledger completion |
| **Risk** | **critical** (multi-product fan-out breaks safety) |
| **Backfill readiness** | **blocked** until conflict review clears fan-out |
| **Lineage** | every insert tied to source action / import |
| **Resolver mandatory** | reads; writes only via guarded writer |
| **Human review** | yes for any non-idempotent map change |

### product_identity_staging_rows

| Field | Value |
|-------|--------|
| **Class** | staging |
| **Typical product columns** | proposed product / catalog links, validation flags (verify) |
| **resolved_product_id** | proposal fields only until promoted |
| **catalog_product_id** | optional proposal |
| **Keep raw identifiers** | yes |
| **Downstream** | `runProductIdentityImport` style promotion to `products` / map |
| **Risk** | medium |
| **Backfill readiness** | staging is ephemeral — promote, don’t “backfill staging” |
| **Lineage** | upload_id, session |
| **Resolver mandatory** | yes |
| **Human review** | optional batch for high-risk SKUs |

---

## Amazon operational tables

### amazon_amazon_fulfilled_inventory

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns (migrations)** | `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence` ([20260642_amazon_import_file_alignment.sql](../../supabase/migrations/20260642_amazon_import_file_alignment.sql)); plus native SKU/FNSKU/ASIN columns as typed by imports |
| **resolved_product_id strategy** | populate via resolver after unanimous match; NULL until safe |
| **Keep raw identifiers** | yes |
| **Downstream** | FBA availability, ledger, claims evidence |
| **Risk** | high |
| **Backfill readiness** | per-org dry-run required |
| **Lineage** | `upload_id`, `source_file_sha256`, `source_physical_row_number` where present ([20260616_physical_row_import_identity.sql](../../supabase/migrations/20260616_physical_row_import_identity.sql)) |
| **Resolver mandatory** | yes |
| **Human review** | for ambiguous rows |

### amazon_manage_fba_inventory

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | same resolver columns as AFI per `20260642` |
| **resolved_product_id strategy** | same as AFI |
| **Keep raw identifiers** | yes |
| **Downstream** | replenishment, warehouse |
| **Risk** | high |
| **Backfill readiness** | dry-run (NEXT-18D slice) |
| **Lineage** | upload + physical row |
| **Resolver mandatory** | yes |
| **Human review** | ambiguous |

### amazon_fba_inventory

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | Resolver quartet added in [20260813120000_amazon_fba_inventory_resolver_columns.sql](../../supabase/migrations/20260813120000_amazon_fba_inventory_resolver_columns.sql) (NEXT-PRODUCT-ID-04): `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`. Native `sku` / `fnsku` / `asin` / `product_name`; physical row lineage per [20260616](../../supabase/migrations/20260616_physical_row_import_identity.sql). |
| **resolved_product_id strategy** | Populate via resolver after unanimous match; NULL until safe. Dry-run now **selects** these columns ([product-seed-dry-run-report.ts](../../scripts/product-seed-dry-run-report.ts)). |
| **Keep raw identifiers** | yes |
| **Downstream** | FBA quantity truth |
| **Risk** | high |
| **Backfill readiness** | schema unblocked; **row** backfill still gated by checklist + conflict review |
| **Lineage** | upload + physical row |
| **Resolver mandatory** | yes |
| **Human review** | ambiguous |

**Vendor policy:** [vendor-confirmation-policy.md](./vendor-confirmation-policy.md).

### amazon_inventory_ledger

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | `sku`, `asin`, `fnsku` typed ([20260642](../../supabase/migrations/20260642_amazon_import_file_alignment.sql)); `resolved_product_id`, `resolved_catalog_product_id` ([20260620_product_identifier_map_ledger_enrichment.sql](../../supabase/migrations/20260620_product_identifier_map_ledger_enrichment.sql)); physical row lineage ([20260616](../../supabase/migrations/20260616_physical_row_import_identity.sql)) |
| **resolved_product_id strategy** | high value for movement joins; NULL until resolver |
| **Keep raw identifiers** | yes (headerless positional provenance in comments) |
| **Downstream** | FEFO, adjustments, financial resolver |
| **Risk** | high |
| **Backfill readiness** | after map + ledger generic completion rules |
| **Lineage** | `upload_id`, file SHA, row number |
| **Resolver mandatory** | yes |
| **Human review** | high for valuation-sensitive rows |

### amazon_all_orders

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | `sku`, `resolved_product_id`, `resolved_catalog_product_id`, resolution status/confidence ([20260642](../../supabase/migrations/20260642_amazon_import_file_alignment.sql)); physical row lineage |
| **resolved_product_id strategy** | link order lines to products for revenue/claims |
| **Keep raw identifiers** | yes (`amazon_order_id`, `merchant_order_id`, `sku`, …) |
| **Downstream** | settlements, claims, BI |
| **Risk** | high |
| **Backfill readiness** | per-table dry-run |
| **Lineage** | upload + physical row |
| **Resolver mandatory** | yes |
| **Human review** | ambiguous |

### amazon_returns

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | verify `product_id` / resolver columns live; physical row lineage added in `20260616` |
| **resolved_product_id strategy** | add if missing via migration **later**; populate via resolver |
| **Keep raw identifiers** | yes (RMA, SKU, LPN, …) |
| **Downstream** | claims inbox, reimbursements |
| **Risk** | high |
| **Backfill readiness** | after returns slice dry-run |
| **Lineage** | upload + physical row |
| **Resolver mandatory** | yes |
| **Human review** | yes for claim-sensitive |

### amazon_reimbursements

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | physical row lineage; verify resolver columns live |
| **resolved_product_id strategy** | recommended for payout ↔ product |
| **Keep raw identifiers** | yes |
| **Downstream** | accounting, claims |
| **Risk** | medium–high |
| **Backfill readiness** | after reimbursement slice dry-run |
| **Lineage** | upload + physical row |
| **Resolver mandatory** | yes |
| **Human review** | financial |

### amazon_removals

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | composite keys on order/sku/disposition; verify resolver columns |
| **resolved_product_id strategy** | populate when safe for removal ↔ inventory |
| **Keep raw identifiers** | yes |
| **Downstream** | removal shipments, claims, warehouse |
| **Risk** | high |
| **Backfill readiness** | after removals audit |
| **Lineage** | `upload_id`, `source_staging_id` (unique indexes in migrations) |
| **Resolver mandatory** | yes |
| **Human review** | ambiguous |

### amazon_removal_shipments

| Field | Value |
|-------|--------|
| **Class** | operational |
| **Product columns** | verify live |
| **resolved_product_id strategy** | same family as removals |
| **Keep raw identifiers** | yes |
| **Downstream** | warehouse, claims |
| **Risk** | medium–high |
| **Backfill readiness** | table-specific dry-run |
| **Lineage** | upload / shipment ids |
| **Resolver mandatory** | yes |
| **Human review** | case-by-case |

### amazon_reports_repository

| Field | Value |
|-------|--------|
| **Class** | raw-source |
| **Product columns** | `catalog_product_id` optional ([20260704130000_amazon_reports_repository_wide_columns.sql](../../supabase/migrations/20260704130000_amazon_reports_repository_wide_columns.sql)); generally **not** a line-level product row |
| **resolved_product_id strategy** | usually N/A; link via `upload_id` / metadata to processing pipeline |
| **Keep raw identifiers** | yes (blob / parsed JSON) |
| **Downstream** | dispatch, re-parse, synthetic rows |
| **Risk** | low for product graph if treated as meta |
| **Backfill readiness** | N/A for resolved_product_id mass fill |
| **Lineage** | `upload_id`, `source_file_sha256`, `source_physical_row_number` |
| **Resolver mandatory** | for **derived** child rows, not for blob row itself |
| **Human review** | low |

---

## Claims (downstream-derived)

### claim_candidates

| Field | Value |
|-------|--------|
| **Class** | downstream-derived |
| **Product columns (app)** | `resolved_product_id` selected in claim inbox APIs; plus `sku`, `fnsku`, `asin`, `source_table`, `source_row_id`, `organization_id`, `store_id` (see audit traces under `.cursor/audit-reports/next-claim-*`) |
| **resolved_product_id strategy** | projection may propose `proposed_resolved_product_id` — **do not** treat as committed graph state until policy says so |
| **Keep raw identifiers** | yes |
| **Downstream** | Claim inbox, workflow (future) |
| **Risk** | high (wrong product → wrong claim) |
| **Backfill readiness** | **derive** from source row + resolver; avoid independent guess |
| **Lineage** | `source_table` + `source_row_id` |
| **Resolver mandatory** | yes when mutating link from candidate |
| **Human review** | yes for dispute queue |

### claim_cases

| Field | Value |
|-------|--------|
| **Class** | downstream-derived (if table exists) |
| **Product columns** | verify live — repo notes some deployments **lack** this table ([20260352_cleanup_claim_submissions_without_report.sql](../../supabase/migrations/20260352_cleanup_claim_submissions_without_report.sql)) |
| **resolved_product_id strategy** | align with submissions / candidates if present |
| **Keep raw identifiers** | yes |
| **Downstream** | CRM / workspace |
| **Risk** | medium |
| **Backfill readiness** | schema-dependent |
| **Lineage** | link to submission / candidate |
| **Resolver mandatory** | if product link stored |
| **Human review** | policy-driven |

---

## Summary matrix (risk × readiness)

| Table | Risk | Backfill `resolved_product_id` |
|-------|------|----------------------------------|
| product_identifier_map | critical | **blocked** until conflicts reduced |
| products / catalog_products | high | governance, not blind fill |
| amazon_* operational | high | **only** after dry-run + checklist |
| amazon_reports_repository | low | not primary target |
| claim_candidates | high | derive from resolver on source, not isolated UPDATE |

---

## Next verification step

Run [sql/01_column_presence_audit.sql](./sql/01_column_presence_audit.sql) in Supabase SQL editor (SELECT-only), then optionally [scripts/read-only-product-link-audit.ts](../../scripts/read-only-product-link-audit.ts) with service role for **column existence probes** (read-only `select`).
