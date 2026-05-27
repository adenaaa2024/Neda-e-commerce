# Next actions — canonical

**Branch:** `feature/product-canonicalization-v2`  
**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy`

---

## P1 — Removal / expected_packages (active)

1. **REMOVAL-QUANTITY-ALLOCATION-VALIDATION** — read-only validation vs `rebuild_expected_packages_from_removals` contract  
2. **SP-API-REMOVAL-REPORTS-FETCH-WORKER** — implement Reports API workers (order + shipment); approval-gated  
3. **REMOVAL-PRODUCT-RESOLVER-WIRE** — resolver for `expected_packages` without auto-create on fetch/rebuild  
4. **REBUILD-EXPECTED-PACKAGES-FROM-REMOVALS-EXECUTE** — after sync + validation PASS  

---

## P1 — Other

5. **PC05-PACKAGING-FULL-PARITY-VERIFY** — re-run to confirm **571** staging/original if Wave3 parity claimed  
6. **PRODUCT-LINKAGE-TABLE-COVERAGE-AUDIT** — linkage not 100%  
7. **PC06A** — commit operator DDL to migrations — no apply  

---

## Done — anchors

- [x] Removal intake architecture documented (`REMOVAL_API_INTAKE.md`)  
- [x] Spreadsheet checkpoint (4,479 rows)  
- [x] Governed packaging waves through Wave2 — **441/441** verify on disk  

---

## Blocked / approval-gated

- SP-API removal fetch — `sp-api-removal-shipment-fetch-approval.md`  
- Spreadsheet / vendor 1883 — separate approvals  
- Future production — **NOT_CREATED_YET**
