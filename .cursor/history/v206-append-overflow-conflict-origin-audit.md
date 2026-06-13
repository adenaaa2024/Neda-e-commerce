
================================================================================
APPEND SLICE -- 20260521T200000Z
TOPIC: PHASE-EXPECTED-PACKAGES-SHIPMENT-OVERFLOW-CONFLICT-ORIGIN-AUDIT-387003587-X004LKS4VD-V1
================================================================================

### Read-only overflow origin audit (production)
- Qty-1 `shipment_overflow_conflict` EP (`ae6d28a9-…`) from **second** `amazon_removals` detail line (`7f5a0285-…`, shipped_qty=1, May 28 upload) matched to same shipment row (52) — NOT remainder split of 53→52+1
- Builder: `rebuild_expected_packages_from_removals` per-detail rule `shipment_total > detail_total` → `shipment_overflow_conflict`
- Primary detail (`4e8e4492-…`, shipped 53, Jun 6 upload) → matched EP qty 52
- No slip/OCR; duplicate detail lines same order/SKU/FNSKU = intake/source staleness pattern
- `is_conflict_legitimate: yes`; `is_builder_bug: no`; fix = status label/copy + optional intake dedupe review
- Next: PHASE-EXPECTED-PACKAGES-OVERFLOW-STATUS-LABEL-FIX-V1

### Evidence
- .cursor/audit-reports/phase-expected-packages-shipment-overflow-conflict-origin-audit/20260521T200000Z/
- Script: scripts/phase-expected-packages-overflow-conflict-origin-audit.ts

================================================================================
END APPEND SLICE -- 20260521T200000Z
================================================================================
