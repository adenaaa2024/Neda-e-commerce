# Next actions — canonical

**Branch:** `feature/phase1-latest-stash-land` @ `9a5cda8` · **main** `4402064` (not merged)  
**Last updated:** 2026-06-14 (`architecture-correction-history-memory-sync` `20260614T120000Z`)

**Architecture:** [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md) — bulk/orphan RI hard-delete **COMPLETE** (5333 removed; active RI **33**).

**Product Core:** protected backbone — see [PRODUCT_CORE_ARCHITECTURE.md](PRODUCT_CORE_ARCHITECTURE.md).

---

## Execution policy (all waves)

`census -> classify -> sample dry-run -> approval -> sample apply -> verify -> next wave`

---

## P0 — Inventory views + product sheet

1. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION** — exclude deleted bulk/orphan RI pattern from inventory views; align read models with physical scans only  
2. **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION** — **3399** needs-review/conflicts  

**Forbidden:** broad product import · bulk RI from expected/API/removal · merge to main

---

## P0 — Claims queue safety

3. **CLAIM-RETURNS-WORK-QUEUE-PHYSICAL-ANCHOR-GATE** — require `package_id IS NOT NULL` in queue + promote paths  

---

## P1 — Product sheet sample + enrichment

4. **PRODUCT-SHEET-IMPORT-MAX-25-SAMPLE-WAVE** — max **25** rows after Phase F  
5. **PRODUCT-ENRICHMENT-BACKEND-JOB-WAVES** — replace browser-loop update button  
6. **CLAIMS-RETURNS-FIRST-CONFIGURE** — cutoff dates; module scope + manual grouping UI (after physical-anchor gate)  

---

## P2 — Gated (unchanged)

7. **CRON-APPLY-ENABLE** — **off**  
8. **REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-RESUME**  
9. **SUPERADMIN-AUTOMATION-SETTINGS** — planned only  

---

## Done

- [x] Staging bulk/orphan `return_items` hard-delete — **5333** removed; active RI **33** (`active_with_package` **3**); spine unchanged  
- [x] Wave2 `resolved_product_id` rollback — **PASS**  
- [x] Full scanner/expected/returns/claims architecture recovery (read-only) — `20260531T084101Z`  
- [x] Product sheet import dry-run (read-only)  
- [x] Removal rebuild mismatch **0** · duplicate EP **0**

**SUPERSEDES:** BULK-RETURN-ITEMS-PROVENANCE-READONLY · BULK-RETURN-ITEMS-QUARANTINE-APPROVAL-AND-EXECUTE · EXPECTED-LINKAGE-CLASS-A-STAGING-SAMPLE · RETURN-ITEMS-DRIFT-REVIEW

---

## Hard policy

| Rule | Value |
|------|-------|
| Merge to main | **NO** |
| Safe git action | Commit repair state to **feature branch only** |
| Cron apply | **disabled** |
| Original DB writes | **explicit approval only** |
| Broad product import | **FORBIDDEN** |
| Bulk `return_items` from expected/API | **FORBIDDEN** |
| EP→RI linkage copy without physical scan | **FORBIDDEN** |
| Claims auto-promote | **off** |
