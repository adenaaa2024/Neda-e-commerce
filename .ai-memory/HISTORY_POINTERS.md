# History pointers — authoritative

Do not paste full history into `.ai-memory`.

**Restore order:** V182 canonical → … → V202 identifier manual review batch → **V205/V206 inventory package_code views (latest)**.

---

## Latest operator history — V205/V206 inventory `package_code` views

```
.cursor/audit-reports/history-v206/20260522T240000Z/v205-v206-package-code-inventory-views-append.md
```

| Field | Value |
|-------|-------|
| Run | `20260522T240000Z` (browser proof `20260522T180000Z`) |
| Status | **PASS** — staging + original view DDL; staging UI browser proof |

**Artifacts:** `main-v205-package-code-v-inventory-item-status-apply/20260522T173000Z/` · `main-v206-package-code-inventory-views-original-parity-apply/20260522T180000Z/`

---

## Prior — V202 identifier manual review batch

```
.cursor/audit-reports/history-v202/20260522T220000Z/v202-identifier-manual-review-batch-append.md
```

| Field | Value |
|-------|-------|
| Run | `20260522T220000Z` |
| Status | **PASS** — 43 queued; 0 DB writes; 0 map-bridge candidates |

**Artifacts:** `expected-packages-identifier-manual-review-batch-v202/20260522T220000Z/`

---

## Prior — V202 Amazon API evidence execute

```
.cursor/audit-reports/history-v202/20260522T210000Z/v202-amazon-api-evidence-execute-append.md
```

| Field | Value |
|-------|-------|
| Run | `20260522T210000Z` |
| Status | **FAIL** — 3 SP-API catalog 404; 0 inserts |

**Artifacts:** `expected-packages-amazon-api-evidence-execute-v202/20260522T210000Z/`

---

## Prior — V202 Amazon API evidence dry-run

```
.cursor/audit-reports/history-v202/20260522T200000Z/v202-amazon-api-evidence-dry-run-append.md
```

| Field | Value |
|-------|-------|
| Run | `20260522T200000Z` |
| Status | **READY_FOR_EXECUTE_REVIEW** — 8 cohort; 5 WOULD_CALL_API |

**Artifacts:** `expected-packages-amazon-api-evidence-dry-run-v202/20260522T200000Z/`

---

## Latest operator proof — V202 browser (supersedes V196 CONDITIONAL_PASS)

```
.cursor/audit-reports/product-linkage-browser-proof-signoff-v202/20260522T195000Z/
```

| Field | Value |
|-------|-------|
| Proof archive | `v200-product-lookup-browser-proof-complete/20260522T195000Z/` |
| Status | **PASS** 11/11 UI + 7/7 preflight |

---

## V196 era full history — lookup / expected / vendor / packaging

```
.cursor/audit-reports/history-v196/20260522T230000Z/ERP_PIM_FULL_HISTORY_V196_APPEND_ONLY_LOOKUP_EXPECTED_VENDOR_PACKAGING_ROADMAP.md
```

| Field | Value |
|-------|-------|
| Pack / run | `history-memory-v196-closeout` / `20260522T230000Z` |
| Milestone | V196 lookup fix, expected/API/manual plans, vendor 1883, packaging model, V197 census, V198 E1B blocked |

---

## Prior — V195 closeout

```
.cursor/audit-reports/history-v195/20260530T120000Z/ERP_PIM_FULL_HISTORY_V195_APPEND_ONLY_ORIGINAL_PARITY_EDIT_LOOKUP_CLOSEOUT.md
```

---

## Canonical base — V182

```
.cursor/audit-reports/history-canonical-rebuild-v182/20260518T120000Z/ERP_PIM_FULL_HISTORY_V182_CANONICAL_APPEND_ONLY_REBUILT.md
```

---

## Milestone audit evidence

| Area | Path |
|------|------|
| V196 lookup item_name/UPC/ambiguous | `v196-item-name-upc-ambiguous-lookup-fix/20260519T223000Z/` |
| V196 vendor 1883 plan | `v196-vendor-category-cleanup-1883-plan/20260521T214500Z/` |
| V199 expected review / API-manual plan | `v199-expected-identifier-ambiguous-review-pack/20260522T130000Z/` |
| V201 remaining 52 triage | `expected-packages-remaining-52-review-v201/20260522T170000Z/` |
| V202 API execute | `expected-packages-amazon-api-evidence-execute-v202/20260522T210000Z/` |
| V202 API dry-run | `expected-packages-amazon-api-evidence-dry-run-v202/20260522T200000Z/` |
| V199 API dry-run (superseded gates) | `expected-packages-amazon-api-evidence-dry-run-v199/20260522T140000Z/` |
| V197 table census | `v197-product-linkage-table-census/20260522T120000Z/` |
| V198 E1B blocked | `expected-packages-e1b-map-bridge-execute-v198/20260522T140000Z/` |
| V200 E1B materialize | `expected-packages-e1b-blocker-materialize-execute-v200/20260522T160000Z/` |
| V202 browser signoff | `product-linkage-browser-proof-signoff-v202/20260522T195000Z/` |
| V195 original parity | `v195-original-view-parity-apply/20260522T000100Z/` |
| Neda handoff | `NEDA_FINAL_BACKEND_HANDOFF_V193.md` |

---

## Read order

| Need | Read |
|------|------|
| Now | `.ai-memory/CURRENT_STATE.md` |
| Neda | `.ai-memory/NEDA_HANDOFF.md` · `NEDA_FINAL_BACKEND_HANDOFF_V193.md` |
| DB | `.ai-memory/DATABASE_CONTRACT.md` |
| Product IDs | `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md` |
| V196 history | V196 path above |
| V196 sync | `history-memory-v196-closeout/20260522T230000Z/` |

---

## Paired-update law

History append + `.ai-memory` in one session.
