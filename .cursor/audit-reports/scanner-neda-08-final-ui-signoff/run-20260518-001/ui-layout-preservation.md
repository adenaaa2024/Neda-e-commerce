# Neda UI layout preservation

Static scan of `app/scanner/operator-mobile/**` — no layout regressions required for `return_items` backend swap.

## Preserved structures

| Element | Status |
|---------|--------|
| `ScannerBottomNav` + `SCANNER_OPERATOR_HOME_PATH` / `SCANNER_OPERATOR_SCAN_PATH` | Present |
| `identifyGatePhase` / OCR action sheet | Present |
| `flowPhase` (`identify` → items flow) | Present |
| `ItemUnitRecordModal` | Present |
| `OperatorSessionStoreProvider` / store bar | Present |
| `insertOperatorPackageItemAction` import in scan page | Present |
| `listOperatorPackageItemsForPackageAction` import in scan page | Present |
| `packageItemsHydrationNonce` (legacy name) | Present |

## Workflow

Operator hub → scan route → identify gate → box/items → slip lines → unit modal → save → hydrate.

## Conclusion

**PASS** — mobile chrome and Neda workflow unchanged; persistence layer swap is transparent to UI.
