# Scanner / Expected / Return / Claims — authoritative architecture

**Status:** CORRECTED — bulk/orphan hard-delete complete on staging  
**Branch:** `feature/phase1-latest-stash-land` @ `9a5cda8`  
**Last updated:** 2026-06-14 (`architecture-correction-history-memory-sync` `20260614T120000Z`)

**Evidence:** `.cursor/audit-reports/full-scanner-expected-returns-claims-architecture-readonly/20260531T084101Z/`

Related: [EXPECTED_ALLOCATION_MODEL.md](EXPECTED_ALLOCATION_MODEL.md) · [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md) · [CLAIM_ARCHITECTURE.md](CLAIM_ARCHITECTURE.md) · [DATABASE_CONTRACT.md](DATABASE_CONTRACT.md)

---

## CORRECTED rules (mandatory)

| Rule | Detail |
|------|--------|
| **`return_items`** | **Physical scanned units only** — 1 row = 1 unit; `COUNT(return_items WHERE deleted_at IS NULL)` |
| **Forecast / API / removal** | Belongs in **`expected_packages`** (+ `raw_report_uploads`, `amazon_removals`, `amazon_removal_shipments`) — **never** bulk-inserted into `return_items` |
| **Allocation** | `expected_packages` children (`build_source = 'receive_allocated'`) + `return_items.expected_item_id` set **after** physical scan via allocation RPC |
| **EP → RI linkage copy** | **Forbidden** unless RI is a **proven physical scan** (package/pallet/slip/operator receive path) |
| **Product linkage (expected)** | On **`expected_packages.resolved_product_id`** via **`product_identifier_map`** — not by bulk-filling `return_items` |
| **Product linkage (scan)** | On **`return_items.resolved_product_id`** via resolver on insert — not copied from EP in normal flow |
| **Claims (scanner)** | **`claim_lines`** (`line_grain = 'return_item'`) only after scanner issue + evidence + cutoff/module gates |
| **`package_items`** | **Forbidden** |
| **Title/OCR auto-link** | **Forbidden** |

---

## Two-grain model

| Layer | Table | Grain |
|-------|-------|-------|
| Physical scan | `return_items` | 1 row = 1 scanned unit |
| Slip OCR | `slip_contents` | 1 row = 1 slip line on a package |
| Expected forecast | `expected_packages` (root) | Group — `expected_scan_quantity` |
| Allocation unit | `expected_packages` (`receive_allocated`) | 1 child = 1 allocated unit |
| Read model | `v_inventory_item_status`, `v_inventory_status`, `v_scanned_items_counted` | Display only — not write path |

**Link direction:**

```
expected_packages → products (resolver)
return_items → expected_packages (after scan + allocate RPC)
claim_lines → return_items (after issue/evidence/cutoff)
```

---

## Valid receive path (code)

1. `operatorReceiveItem` / `insertReturn` — **quantity = 1** enforced  
2. Row anchors to `package_id` (and `pallet_id` via package)  
3. `allocate_expected_items_for_return_item_ids` RPC → `expected_item_id`  
4. Resolver sets `return_items.resolved_product_id` on insert  

**Delete/void:** `release_expected_item_unit` before soft-delete (`softVoidReturnItemWithExpectedRelease`, `voidOperatorIntakeBoxPackageAction`).

---

## Staging state (post bulk/orphan hard-delete — 2026-06-14)

| Metric | Value |
|--------|------:|
| `return_items` total | **33** |
| Active `return_items` | **33** |
| `bulk_orphan` | **0** (**SUPERSEDES** ~5,333 pending) |
| Active with `package_id` (proven physical scan) | **3** |
| `v_scanned_sum` | **3** |
| `products` | **17,033** (unchanged) |
| `expected_packages` | **9,459** (unchanged); **9,139** resolved |
| `product_identifier_map` | **16,811** (unchanged) |

**5333** invalid bulk/orphan rows **hard-deleted** on staging. Wave2 rollback had already reverted unsafe EP→RI `resolved_product_id` copy — spine tables unchanged throughout.

---

## Claims / queue safety

| Item | Status |
|------|--------|
| Returns-first policy (staging) | **CONFIGURED** — domains, dates, window, evidence/hold |
| Draft E2E | **BLOCKED** — closed package + evidence/note required |
| `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED` | **off** |
| Merge / deploy / original apply | **NO** until Phase1 final QA gate |

---

## Future gate (before any DB touch)

Any DB write, backfill, or migration touching scanner / expected / return / claims requires:

1. Read-only architecture evidence under `.cursor/audit-reports/`
2. Explicit operator approval under `.cursor/operator-approvals/`

---

## Next prompts (ordered)

1. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**
2. **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION**
3. **CLAIM-RETURNS-WORK-QUEUE-PHYSICAL-ANCHOR-GATE**
