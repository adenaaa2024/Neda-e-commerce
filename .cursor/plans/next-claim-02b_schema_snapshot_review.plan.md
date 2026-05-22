# NEXT-CLAIM-02B — Claim Schema Snapshot Review

## Authority and inputs

- **Upstream design:** [next-claim-02_readonly_claim_mvp_report.plan.md](next-claim-02_readonly_claim_mvp_report.plan.md) (NEXT-CLAIM-02).
- **Operator artifact:** Plain-text output from **`NEXT_CLAIM_02B_SCHEMA_SNAPSHOT_SQL.sql`** **or** the equivalent **Supabase Snippet CSV bundle** (see **Operator CSV bundle** below). The zip **`Snapshot database.zip`** is **binary** — use extracted CSV/SQL under the repo (for example `.cursor/audit-reports/next-claim-02b/<run_id>/`) for version-controlled review.

### Operator CSV bundle (accepted — maps to A–F)

The following files from `...\SNAPSHOT\` are **sufficient** for NEXT-CLAIM-02B / NEXT-CLAIM-03 contract freeze when all are present (column names match a sample review):

| File | Maps to | Contents (verified sample) |
|------|---------|------------------------------|
| `(12).csv` | **A** | `table_schema`, `table_name`, `table_type` — lists BASE TABLEs + `v_claim_*` VIEWs |
| `(13).csv` | **B** | Per-table columns: `ordinal_position`, `column_name`, `data_type`, `is_nullable`, … |
| `(14).csv` | **C** | FK edges: `source_table`, `source_column`, `target_table`, `target_column`, `constraint_name`, rules |
| `(15).csv` | **D** | `viewname`, `definition` — full `v_claim_*` SQL (quoted CSV; parse with proper CSV reader) |
| `(16).csv` | **E** | `object_name`, `rows` — live row counts |
| `(17).csv` | **F** | Link/null gaps for `returns` / `packages` / `pallets` (e.g. `package_id_null`, `store_id_null`) |
| `(18).csv` | **F / bucket 7** | PIM-style rollup (sample: `taxonomy_cell`, `status`, `rows`) — confirm full column set if used for dispute joins |

**Sanity check on `(14).csv`:** Some rows may show **constraint names** that do not match `source_table` (e.g. `amazon_removals` paired with `expected_*_fkey`). Treat **column pairs** as authoritative; **re-verify** odd constraint names against live `pg_constraint` before legal/compliance sign-off.

**Sample row-count reality (one environment):** `claim_candidates` ≫ 0 while `claim_cases`, `claim_reimbursements`, `slip_contents` may be **0** — NEXT-CLAIM-03 must **not assume** non-empty case/reimbursement/slip tables; buckets 2/5/6 can still use **views** + `amazon_*` + `returns`/`packages`/`pallets`.

**Vocabulary (frozen):**

- **`amazon_returns`** — raw Amazon FBA Returns report.
- **`returns`** — operational scanned/entered return item rows.
- **`packages`** — package/carton layer.
- **`pallets`** — tracking/container layer.
- **`slip_contents`** — package slip / carton content item lines.

---

## Purpose of this review

Freeze the **exact source contract** for **NEXT-CLAIM-03** (read-only Claim MVP report generator): table/view existence, column names, FK graph, view usability, row counts, null gaps — so the generator **never guesses** joins or columns.

---

## A. Confirm exact tables/views available

**From snapshot sections:** `information_schema.tables` (or `pg_catalog`) listing `public` objects filtered by name patterns (`claim_%`, `v_claim_%`, `returns`, `packages`, `pallets`, `slip_contents`, `expected_packages`, `amazon_%`, `pim_%`, `products`, `product_identifier_map`).

**Deliverable:** A single checklist table: `object_name`, `kind` (table/view), `present Y/N`.

**Status without artifact:** **Pending** — populate when SQL output is available.

---

## B. Confirm exact columns to use per source

**From snapshot:** `information_schema.columns` (ordinal order) for each object in the NEXT-CLAIM-02 list.

**Per object, record:**

- Primary key column(s).
- Tenant columns: `organization_id`, `store_id` (nullable?).
- Join columns used in buckets: `order_id`, `rma_number`, `lpn`, `tracking_number`, `package_id`, `pallet_id`, `return_id`, SKU family (`sku`, `fnsku`, `asin`, `upc`, `product_identifier`, `product_id`, `resolved_product_id` where present).
- Evidence columns: pallet URL arrays vs legacy `photo_*`, `photo_evidence` jsonb, `manifest_data` on `packages`, columns on `slip_contents`.

**Deliverable:** “Column contract” subsection per table/view — **only names that appear in snapshot** (no inferred renames).

**Status without artifact:** **Pending**.

---

## C. Confirm FK relationships

**From snapshot:** `information_schema.table_constraints` + `key_column_usage` / `constraint_column_usage` for `FOREIGN KEY` where `from_table` ∈ claim + operational + slip set.

**Minimum graph to validate:**

- `returns.package_id` → `packages.id`
- `packages.pallet_id` → `pallets.id`
- `returns.pallet_id` → `pallets.id` (if constraint exists vs app-only)
- `slip_contents.package_id` → `packages.id`
- `claim_submissions.return_id` → `returns.id`
- Any `claim_candidates` / `claim_cases` / `claim_reimbursements` → `returns`, `claim_submissions`, or each other

**Deliverable:** Mermaid or bullet FK list with **exact constraint names**.

**Status without artifact:** **Pending**.

---

## D. Confirm view definitions and whether `v_claim_*` are usable

**From snapshot:** `pg_get_viewdef('public.<view>'::regclass, true)` (or equivalent) for each `v_claim_%`.

**Usability criteria:**

- View **runs** without error (`SELECT * LIMIT 1` in snapshot or separate smoke section).
- Grain is documented: one row per what? (removal line, candidate, order, etc.)
- Columns sufficient for NEXT-CLAIM-02 buckets **1** and **6** without fragile `raw_data`-only logic (acceptable if documented).
- No mutable side effects (views must be plain `SELECT`).

**If a view references dropped columns or wrong table names:** mark **not usable** and record error text → feeds **J** blocker.

**Status without artifact:** **Pending**.

---

## E. Confirm row counts and which sources have data

**From snapshot:** `SELECT relname, n_live_tup FROM pg_stat_user_tables` (approximate) and/or exact `COUNT(*)` for key tables (operator trade-off: exact counts can be slow on huge tables — use `COUNT(*) WHERE created_at > …` if scripted).

**Deliverable:** Table of `object`, `approx_rows` or `exact_rows`, `has_data Y/N`.

**Emptiness rule:** If `claim_candidates` is empty but `v_claim_base_amazon_removals` has rows, NEXT-CLAIM-03 should **prefer views** for bucket 1 and treat `claim_candidates` as optional overlay (aligns with NEXT-CLAIM-02 **H**).

**Status without artifact:** **Pending**.

---

## F. Confirm null / link gaps

**From snapshot:** Precomputed null counts or percentages for:

| Field | Question |
|-------|----------|
| `returns.package_id` | % NULL |
| `returns.pallet_id` | % NULL |
| `returns.product_id` | % NULL |
| `packages.pallet_id` | % NULL |
| `returns.organization_id`, `returns.store_id` | % NULL |
| `packages.organization_id`, `packages.store_id` | % NULL |
| `slip_contents` → resolvable SKU / product link | % NULL key fields |

**Deliverable:** One CSV row per metric in snapshot output, or a small summary table copied into this plan’s appendix.

**Status without artifact:** **Pending**.

---

## G. Final source contract for NEXT-CLAIM-03 (template)

After **A–F** are filled from the snapshot, emit a **frozen** subsection (copy into NEXT-CLAIM-03 spec or `manifest.json` `schema_contract`):

1. **Version:** snapshot file hash + timestamp.
2. **Allowed read sources:** explicit list of table/view names.
3. **Per-bucket FROM clause:** literal view/table name + required column list.
4. **Join matrix:** (left, right, on columns) per bucket from NEXT-CLAIM-02.
5. **Forbidden:** any object not in the list; any column not in **B**.

Until the snapshot is **copied into the repo** and a human signs off on **(14)** FK oddities, **G** may remain partially a **template**; columns and joins can be **draft-frozen** from `(12)–(15)` as read from the operator path.

---

## H. Which buckets can be implemented first

**Default priority (subject to D/E):**

1. **Bucket 1 (removal)** — if `v_claim_base_amazon_removals` is **usable** and **non-empty**.
2. **Bucket 5 (package/pallet gaps)** — if `returns` / `packages` / `pallets` columns match snapshot and null metrics are acceptable for reporting.
3. **Bucket 6 (financial hints)** — if `v_claim_candidate_financial_hints` and/or `v_claim_financial_events` are **usable**.

**Bucket 3–4** (Amazon ↔ operational return) — first after **`amazon_returns`** and **`returns`** LPN/order columns confirmed in **B** and null rates in **F** understood.

**Bucket 7 (PIM blockers)** — first after `pim_identifier_dispute` / `pim_conflict_review_event` columns for join to identifiers confirmed.

**Status without artifact:** Order above is **provisional**.

---

## I. Which buckets must be deferred

- Any bucket whose **driving view fails** (**D**) or driving table is **empty** (**E**) with no alternative source.
- **Bucket 2** (return not reimbursed) if `amazon_reimbursements` / financial views lack **`order_id`** or SKU alignment with `returns` at required match rate (**F** shows near-total nulls).
- **Heavy** cross-table reports on **full-history** `amazon_inventory_ledger` if timeouts occur — defer chunked queries to NEXT-CLAIM-03b.

---

## J. Any blocker before Agent implementation

| Blocker type | Condition |
|--------------|-----------|
| **Schema** | Critical view `SELECT` fails or references missing columns. |
| **No data** | All `v_claim_*` empty and `claim_candidates` empty — report is trivial until pipelines populate. |
| **Tenant** | No reliable `organization_id` on a driving object — cannot satisfy single-org validation. |
| **Contract** | Snapshot output incomplete (missing FK section or missing view defs). |

**Status without artifact:** **Blocker: snapshot text not in repo** — Agent must not start until **G** can be filled.

---

## K. Do-not-touch list

- No code edits, no DB writes, no migrations, no new tables, no updates to `claim_*`, `products`, `product_identifier_map`, `pim_*`, operational tables, `amazon_*`, UI/API, or scanner logic as part of **02B** (review only).

---

## L. Recommendation

| # | When |
|---|------|
| **1** | Proceed to Agent implementation — only after **A–G** are completed from real snapshot output and **J** has no schema blockers. |
| **2** | Patch view/schema first — if **D** shows broken `v_claim_*` or FK drift; out of scope for 02B except **documentation** of required fix. |
| **3** | Run more SQL first — if artifact is partial (e.g. columns but no counts, or no `pg_get_viewdef`). |
| **4** | Pause — if **J** indicates broken views and no DBA window to fix. |

**Current recommendation:** If the **(12)–(18) CSV bundle** is complete for your environment, **1. Proceed to Agent implementation** of NEXT-CLAIM-03 **for buckets backed by non-empty sources** (`claim_candidates`, `v_claim_*`, `amazon_*`, `returns`/`packages`/`pallets`). Still **copy the CSVs into the repo** under `.cursor/audit-reports/next-claim-02b/<run_id>/` for traceability. Use **3** only if a table listed in NEXT-CLAIM-02 is **missing** from `(12)` or view defs in `(15)` are truncated; use **4** if `(15)` shows broken view SQL.

---

## Appendix — What the snapshot SQL bundle should include

Operator / DBA should ensure the script produces **machine-reviewable** sections:

1. Table/view inventory (filtered).
2. Columns per object (name, type, nullable).
3. FK listing (constraint name, from, to).
4. View definitions (`pg_get_viewdef`).
5. Row counts (approx or exact).
6. Null-count queries for **F**.
7. Optional: `SELECT * FROM v_claim_base_amazon_removals LIMIT 3` redacted sample (no PII policy).

---

## Follow-up action (single step)

Copy **unzipped** snapshot results from `Snapshot database.zip` or SQL editor exports into **`c:\Users\Jennifer\Desktop\ecommerce-os\.cursor\audit-reports\next-claim-02b\<run_id>\`** and reference that path in NEXT-CLAIM-03 / a short “02B review complete” note so the contract is traceable.
