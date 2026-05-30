# Next actions — canonical

**Branch:** `feature/product-canonicalization-v3` @ `4402064`  
**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy`  
**Last updated:** 2026-06-09 (`history-memory-align-after-phase1-census` `20260609T140000Z`)

---

## P0 — Phase 1 next priorities (ordered)

1. **REMOVAL-STAGING-GAP-FETCH-SYNC** — close staging removal fetch/sync data gap  
2. **DELETE-RELEASE-WIRING** — wire `release_expected_item_unit` on delete/void paths (census identified gap)  
3. **DELETE-UNDO-RETENTION-ARCHITECTURE** — cascade undo + retention (`20260901120000` drafted, not applied)  
4. **PRODUCT-SPINE-VIEW-LINKAGE-ORIGINAL-EXECUTE** — original `expected_package_id` + `product_display_name` view DDL  
5. **CLAIMS-ORIGINAL-PARITY-GROUPING** — original claims schema parity + grouping  

---

## P1 — Data backfill (still not ready)

6. **ORIGINAL-PRODUCT-MAP-EP-BACKFILL-DRY-RUN-REPEAT** — after product spine view DDL on original  
7. **ORIGINAL-PRODUCT-MAP-EP-BACKFILL-EXECUTE** — **NOT READY** (447 Class C only; A/B = 0)

---

## P2 — Branch / build

8. **NEDA-LINKAGE-BRANCH-MERGE** — after original product spine view DDL + smoke  
9. **BUILD-FIX-TESSERACT-SCAN-PAGE**

---

## Done

- [x] Staging DB parity slip/view **PASS** — `20260529T231120Z/`  
- [x] Original DB parity slip/view **PASS** — `20260529T234437Z/` (**CORRECTED** — was BLOCKED in prior memory)  
- [x] Staging product spine true linkage **PASS** — `product-spine-view-linkage-staging-execute/20260530T171500Z/`  
- [x] Browser smoke **PASS** — tracking `1552698729`, FNSKU `X003S8RCBH`  
- [x] Expected allocation census **complete**  
- [x] Removal verify gate align + burn-in retry **PASS**; resolver **+6 EP**

---

## Blocked / not ready

| Item | Reason |
|------|--------|
| Original product spine view DDL | Approval/apply pending |
| EP backfill execute | Class C only (447 rows) |
| Cascade/undo migration | Drafted, not applied |
| Future production | **NOT_CREATED_YET** |
