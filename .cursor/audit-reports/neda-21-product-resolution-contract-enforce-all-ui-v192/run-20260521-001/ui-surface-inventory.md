# UI surface inventory — NEDA-21

| # | Surface | File / action | Contract path | Static |
|---|---------|---------------|---------------|--------|
| 1 | Add item modal | `ItemUnitRecordModal.tsx` | `resolveBarcodeLinkage` → `previewOperatorItemBarcodeLinkageAction` | PASS |
| 2 | Edit item (returns drawer) | `returns/_components.tsx` ItemDrawer | `previewOperatorItemBarcodeLinkageAction` + `updateReturn` | PASS |
| 3 | Save / update button | scan `saveItemUnitModal`; drawer `handleSave` | `insertOperatorPackageItemAction` / `updateReturn` | PASS |
| 4 | Item detail | drawer + `fetchReturnItemProductLinkageAction` | hydrated `ProductLinkageDisplayContract` | PASS |
| 5 | Package child rows | `listOperatorPackageItemsForPackageAction` | `product_linkage` per unit | PASS |
| 6 | Pallet child rows | `listOperatorPackagesForPalletAction` → open package | package list server action | PASS |
| 7 | Expected packages panel | `ExpectedInventoryLineRow` | `OperatorProductLinkageMeta` + EP read contract | PASS |
| 8 | Inventory item status | `fetchVInventoryItemStatusLinesExact` | view read + variance labels | PASS |
| 9 | Scanner item scan | `insertOperatorPackageItemAction` | resolver-on-save + returned linkage | PASS |
| 10 | Unresolved / ambiguous | `OperatorProductLinkageMeta` | `No product link yet` / `Needs review` | PASS |

**EP receive path:** `operatorReceiveItem` (server) → `insertReturn` + enrichment — does not return `product_linkage` to client; counts refresh via EP panel reads.

**V191/V192 handoff audits in repo:** v191=no v192_lock=no
