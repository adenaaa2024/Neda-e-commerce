# Operator mobile route — save path (static)

## Route

`/scanner/operator-mobile/scan` — `app/scanner/operator-mobile/scan/page.tsx`

## Item scan flow (slip-first)

1. Operator selects/scans box (`hasReceivableBoxForItems`).
2. `handleItemBarcodeScan` loads `itemInspectionSlipLines`.
3. `resolveItemBarcodeAgainstSlipRows` → single match opens `ItemUnitRecordModal`.
4. `handleItemUnitModalSave` → `insertOperatorPackageItemAction` with `slipContentId`, `matchKind`, `discrepancyTags`.
5. Success → hydration nonce bump + modal close.

## This run

- **Automated:** service-role insert parity probe (`scripts/scanner-neda-06-small-write-smoke.ts`).
- **Browser:** not re-executed; path reviewed unchanged since neda-04.

## Optional manual confirm (2 min)

1. Sign in as operator for org `7397edff-…`.
2. Open package `1231` / tracking `123`.
3. Scan `X004N9OS4J`, tag **Sellable OK**, save.
4. Confirm UI shows unit on matching slip line.

## Conclusion

**PASS (static + DB parity)** — UI save path targets `return_items`.
