# NEXT-CLAIM-01D — Existing Claim Engine + Return / Package / Pallet Reality Audit

## Authority and scope

- **Operator snapshot:** Facts in this plan that come from **DATABASE(1).zip** (as stated by you) are treated as **live schema truth** for table/column presence. That zip is **not present in this workspace**; no automated extraction was run here.
- **Repo cross-check:** Migrations and [app/claim-engine/](app/claim-engine/) were searched read-only. Where repo and live DB **diverge**, the audit must prefer **live** definitions (export view SQL from DB) and file a **schema drift** note for engineering.

### Language (required distinction)

- **`amazon_returns`** — raw Amazon FBA Returns report rows (marketplace evidence).
- **`returns`** — operational scanned/entered return **items** (warehouse workflow).
- **`packages`** — carton/package layer.
- **`pallets`** — tracking/container layer.
- **`slip_contents`** — package slip item lines (confirmed in live DB; OCR bridge later).

---

## A. Existing claim engine map (live + repo)

### Live-confirmed (per DATABASE(1).zip)

| Object | Role (to be confirmed via `pg_get_viewdef`) |
|--------|-----------------------------------------------|
| `claim_candidates` | Likely **staging / detection** rows for claim opportunities (lifecycle TBD from columns + triggers). |
| `claim_cases` | Likely **grouping / case file** above a submission or candidate (TBD). |
| `claim_submissions` | **Submission queue** — PDF path, status enum, `return_id`, `source_payload` (repo aligns). |
| `claim_reimbursements` | Likely **financial tie-out** rows (amounts, dates, marketplace refs). |
| `claim_history_logs` | **CRM / timeline** — repo maps `claim_id` → submission id ([claim-crm-actions.ts](app/claim-engine/claim-crm-actions.ts)). |
| `v_claim_analytics_base` | Analytics-oriented base (dependencies: read `pg_get_viewdef`). |
| `v_claim_base_amazon_removals` | **Repo:** defined in [20260633_v_claim_base_amazon_removals.sql](supabase/migrations/20260633_v_claim_base_amazon_removals.sql) — removal-side claim candidates + `expected_packages` aggregates + reimbursements/transactions rollups. |
| `v_claim_candidate_financial_hints` | Financial hints for **candidates** (implies join path from candidate → orders/SKU/ledger). |
| `v_claim_candidate_source_context` | Source/evidence context for candidates (raw uploads, staging, etc.). |
| `v_claim_financial_events` | Unified financial event shape for reporting. |

### Repo reality (Next.js Claim Engine)

- **Single write/read hub in code:** [claim-repository.ts](app/claim-engine/claim-repository.ts) states all Claim Engine data goes through **`claim_submissions`**, not legacy `claims`.
- **Workspace list:** `fetchClaimWorkspaceRows` → `claim_submissions` filtered by post-pipeline statuses ([claim-repository.ts](app/claim-engine/claim-repository.ts)).
- **Queue / PDF:** [claim-submission-actions.ts](app/claim-engine/claim-submission-actions.ts) lists `ready_to_send` rows with embedded `returns`.
- **KPIs:** [claim-crm-actions.ts](app/claim-engine/claim-crm-actions.ts) aggregates **`claim_submissions`** (`claim_amount`, `reimbursement_amount`, `status`).
- **Detail:** [claim-actions.ts](app/claim-engine/claim-actions.ts) loads submission + `returns` + **optional** `pallets` / `packages` via returns app list helpers.

**Drift finding:** **`claim_candidates`, `claim_cases`, `claim_reimbursements`, and most `v_claim_*` views are not referenced** by a repo-wide grep in `app/` or `supabase/migrations` (except **`v_claim_base_amazon_removals`**). They may be populated by **SQL jobs, Python agent, or migrations not in this branch**. Audit step one: **`pg_depend` / view definitions** to see whether candidates feed submissions or sit in parallel.

---

## B. Operational chain map (confirmed + inheritance)

**Chain (FK direction):**

- `returns.package_id` → `packages.id`
- `packages.pallet_id` → `pallets.id`
- `returns.pallet_id` → `pallets.id` (optional direct link; can coexist with package link)

**`slip_contents`:** `slip_contents.package_id` → `packages.id` (per your snapshot).

**Inheritance (app meaning):** Pallet-level **carrier** and **order_id** are intended to **pre-fill** child packages and return line fields in the returns UI ([returns-action-types.ts](app/returns/returns-action-types.ts), [returns-constants.ts](app/returns/returns-constants.ts) `PALLET_LIST_SELECT` / package payloads). Triggers maintain **`packages.actual_item_count`** from return rows and **`pallets.item_count`** ([20250319_returns_v3_packages.sql](supabase/migrations/20250319_returns_v3_packages.sql), v1 pallets migration).

**`packages.manifest_data`:** JSONB slip lines in repo — **coexists** with live **`slip_contents`**; audit should document whether one is canonical, derived, or dual-written.

---

## C. Raw Amazon evidence map

| Source | Use |
|--------|-----|
| **`amazon_returns`** | Customer-return evidence; match to **`returns`** inferentially (`lpn`, `order_id`, `store_id`, ASIN/FNSKU/SKU). **No FK** in typical design. |
| **`amazon_removals`**, **`amazon_removal_shipments`**, **`expected_packages`** | Removal pipeline; **`v_claim_base_amazon_removals`** documents join via `expected_packages.source_detail_row_id` → `amazon_removals.id` (repo). |
| **`amazon_reimbursements`**, **`amazon_settlements`**, **`amazon_transactions`** | Money and fee evidence; same view aggregates by `(organization_id, order_id[, sku])` where applicable. |
| **`amazon_inventory_ledger`**, **`amazon_all_orders`**, **`amazon_reports_repository`** | Catalog / ledger / report metadata for enrichment and dedupe keys (repo has multiple ALTER migrations). |

**Important:** Repo view comment: **`amazon_returns` is not joined** into **`v_claim_base_amazon_removals`** — return-side vs removal-side are **separate claim families**.

---

## D. Product linkage status

| Surface | Notes |
|---------|--------|
| **`returns.product_id`** | Legacy nullable link ([types/database.types.ts](types/database.types.ts)); **not** in `RETURN_LIST_SELECT` ([returns-constants.ts](app/returns/returns-constants.ts)) — UI lists may underuse it. |
| **Identifiers on `returns`** | `asin`, `fnsku`, `sku`, `product_identifier` — primary operational identity for joins. |
| **`amazon_*` `resolved_product_id`** | Present on several ledger/report tables in later migrations — audit live columns for each table you care about. |
| **`claim_candidates` resolution columns** | Per your snapshot — confirm names (`resolved_product_id`, `resolved_catalog_product_id`) and null rates. |
| **`pim_identifier_dispute` / `pim_conflict_review_event`** | Identity review queue; **no direct FK to `returns`** in PIM migration — blocks **confidence** on product-tight claims until decided. |

---

## E. Claim MVP possibilities (existing schema first)

1. **Removal mismatch** — **`v_claim_base_amazon_removals`** (already encodes reason candidates in SQL comments).
2. **Return not reimbursed / missing reimbursement** — Join **`returns`** (`order_id`, SKU/FNSKU) to **`amazon_reimbursements`** / settlements / transactions; optionally reuse patterns from **`v_claim_financial_events`** if it standardizes joins.
3. **Amazon return not scanned** — Anti-join **`amazon_returns`** to **`returns`** on org + store + **LPN** (and fallback keys).
4. **Operational return without Amazon return evidence** — `returns` left join `amazon_returns` with null match on best key set.
5. **Package / pallet discrepancy** — `packages.expected_item_count` vs `actual_item_count`, `status`, `discrepancy_note`; pallet **`operator_package_count`** (live) vs child package counts.
6. **Financial mismatch** — **`claim_reimbursements`** vs **`claim_submissions`** / **`v_claim_candidate_financial_hints`** (read-only reconciliation report).

Prefer **views + read-only SQL** before any new tables.

---

## F. Data gaps

- **No enforced FK** `amazon_returns` → `returns`.
- **`returns.product_id`** optional and easy to omit in list queries — weak catalog join unless fixed in **read** paths only (no schema change required for MVP report).
- **Photo model split:** Live pallets use **`pallet_photo_urls` / `bol_photo_urls` / `shipping_label_urls`** (arrays); Next **`PALLET_LIST_SELECT`** still lists legacy single URL fields in repo — **UI/API may not show live evidence columns** until selectors align (planning only: document mismatch).
- **`expected_packages`:** only confirmed table in your “expected_*” set; do not assume `expected_returns` / `expected_pallets` / `expected_items` exist until `information_schema` confirms.
- **`slip_contents`:** gap = link to **resolved product** (SKU/FNSKU → `products` / `product_identifier_map`) if line rows lack `product_id`.
- **PIM disputes:** block automated high-confidence claims on ambiguous SKUs.

---

## G. Minimal Claim MVP sequence

1. **Read-only inventory:** Row counts + null rates on join keys (`returns.package_id`, `packages.pallet_id`, `slip_contents.package_id`, candidate → submission linkage if any FK).
2. **Export view definitions** for all **`v_claim_*`** into repo docs (optional) or internal wiki — **no migration** in MVP audit phase.
3. **Single “Claim MVP report” SQL or notebook** that uses **`v_claim_base_amazon_removals`** + optional **`returns`/`amazon_returns`** anti-joins — **SELECT only**.
4. **Decide orchestration:** If **`claim_candidates`** is populated but unused by Next, either (a) wire read-only UI to candidates/views, or (b) treat submissions as sole MVP surface — **do not create new tables** until this decision is documented.
5. **No automated Amazon submission**; advisory summaries only beyond existing PDF pipeline.

---

## H. UI / API readiness

| Exists | Gap |
|--------|-----|
| [app/claim-engine/page.tsx](app/claim-engine/page.tsx) + [ClaimEngineClient.tsx](app/claim-engine/ClaimEngineClient.tsx) | No repo usage of **`claim_candidates`** / extra **`v_claim_*`** as first-class tabs. |
| Submission queue + workspace rows ([claim-submission-actions.ts](app/claim-engine/claim-submission-actions.ts), [claim-repository.ts](app/claim-engine/claim-repository.ts)) | KPIs only know **`claim_submissions`** ([claim-crm-actions.ts](app/claim-engine/claim-crm-actions.ts)). |
| Claim detail loads **return + package + pallet** ([claim-actions.ts](app/claim-engine/claim-actions.ts)) | **`slip_contents`** not loaded in claim detail path (grep/repo). |
| Returns module ([app/returns/](app/returns/)) | Strong for operational hierarchy; **slip_contents** and **live pallet URL arrays** need explicit queries if shown in Claim MVP. |

**Show first for operators:** (1) removal base view excerpt or drill-down, (2) operational return with package/pallet + slip lines, (3) financial hints view row for same `order_id`/SKU if present.

---

## I. Do-not-touch list

- No `UPDATE` / `DELETE` / `ALTER` on production from this audit.
- No new claim tables before documenting **`claim_candidates` / `claim_cases` / `claim_reimbursements`** relationships.
- No writes to **`products`**, **`product_identifier_map`**, merges, imports, scanner logic, or Amazon case submission automation.

---

## J. Recommended next step

**1. Build a read-only Claim MVP report first using existing claim views/tables** — including **`v_claim_base_amazon_removals`**, **`v_claim_candidate_financial_hints`**, **`v_claim_candidate_source_context`**, **`v_claim_financial_events`**, and **`v_claim_analytics_base`**, plus operational **`returns`/`packages`/`pallets`/`slip_contents`** joins as **SELECT-only**. Use that report to resolve whether **`claim_candidates`** is the intended upstream of **`claim_submissions`** or a parallel track (avoids premature schema work and avoids declaring **5** unless views are broken or empty).

---

## Read-only SQL pack (operator) — view deps + slip + candidates

**View definitions and dependencies**

```sql
SELECT c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname LIKE 'v_claim%'
ORDER BY 1;

SELECT DISTINCT dependent_ns.nspname || '.' || dependent_view.relname AS dependent_view,
                source_ns.nspname || '.' || source_table.relname AS source_table
FROM pg_depend
JOIN pg_rewrite ON pg_depend.objid = pg_rewrite.oid
JOIN pg_class AS dependent_view ON pg_rewrite.ev_class = dependent_view.oid
JOIN pg_class AS source_table ON pg_depend.refobjid = source_table.oid
JOIN pg_namespace dependent_ns ON dependent_ns.oid = dependent_view.relnamespace
JOIN pg_namespace source_ns ON source_ns.oid = source_table.relnamespace
WHERE dependent_ns.nspname = 'public'
  AND dependent_view.relkind = 'v'
  AND dependent_view.relname LIKE 'v_claim%'
ORDER BY 1, 2;
```

**Claim graph (adjust FK names after `\d` in psql)**

```sql
SELECT conname, conrelid::regclass AS from_table, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND conrelid::regclass::text ~* 'claim_'
ORDER BY 1;
```

**Operational + slip**

```sql
SELECT COUNT(*) AS slip_rows, COUNT(DISTINCT package_id) AS packages_with_slip
FROM public.slip_contents;

SELECT COUNT(*) FILTER (WHERE package_id IS NULL) AS returns_no_package,
       COUNT(*) FILTER (WHERE pallet_id IS NULL) AS returns_no_pallet
FROM public.returns
WHERE deleted_at IS NULL;
```

---

## Implementation todos (post-plan approval)

- id: export-view-sql — Export `pg_get_viewdef` for all `v_claim_*` and store with DATABASE(1).zip lineage.
- id: map-candidate-submission — Document FK/graph between `claim_candidates`, `claim_cases`, `claim_submissions`, `claim_reimbursements`.
- id: align-ui-selectors — List gaps between `PALLET_LIST_SELECT` / types and live pallet array columns (read-only doc).
- id: read-only-mvp-sql — Author one consolidated SELECT-only report query set for operators.
