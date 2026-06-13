
================================================================================
APPEND SLICE -- 20260521T190000Z
TOPIC: PHASE-SCANNER-SHIPMENT-LINE-AGGREGATION-AUDIT-387003587-X004LKS4VD
================================================================================

### Read-only audit (production)
- Shipment/tracking `387003587`, FNSKU `X004LKS4VD`: **2** `expected_packages` rows (qty 52 + 1) from detail-vs-shipment rebuild split (`matched` + `shipment_overflow_conflict`); same product grain; `v_inventory_item_status` **1** row total_expected **53**
- Root UI split: item-scan `slipLikeRowsForInspection` EP fallback maps one row per `expected_packages.id` (no aggregation); tracking snapshot `aggregateExpectedPackagesBySkuFnskuDisposition` aggregates correctly
- No packages/return_items/scans yet for this tracking
- `SAFE_TO_IMPLEMENT_AGGREGATION_FIX: yes` (UI read-layer only; no EP rebuild/allocation change)
- Next: PHASE-SCANNER-SHIPMENT-LINE-UI-GROUP-DISPLAY-387003587

### Evidence
- .cursor/audit-reports/phase-scanner-shipment-line-aggregation-audit/20260521T190000Z/
- Script: scripts/phase-scanner-shipment-line-aggregation-audit.ts

================================================================================
END APPEND SLICE -- 20260521T190000Z
================================================================================
