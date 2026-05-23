# Hydration timing

## Pallet documentation hydrate

Triggered by `activePallet.id`, `palletDocHydrationNonce`, `orgId`, `sessionStoreId`.

- Server: `fetchOperatorPalletHydrationAction`
- Stale protection: `hydrateActivePalletIdRef` ignores results if pallet switched mid-flight
- On pallet/org switch: carrier, order id, and photo URL state reset before fetch
- Tracking-only sessions skip full pallet row hydrate (by design)

Increment `palletDocHydrationNonce` after successful pallet resolve and saves so carrier/order/conflict flags re-sync.

## Expected boxes (pallet / tracking worklist)

Separate effect loads `loadTrackingExpectationSnapshot` / pallet snapshot when `activePallet` or loose tracking changes. Blocks on `operatorStoresLoading` and missing `sessionStoreId` with inline error copy.

## Item phase — parallel loads

When `flowPhase === "items"` and `itemScanPackageId` is set:

| Effect | Action | State updated |
|--------|--------|----------------|
| Package items | `listOperatorPackageItemsForPackageAction` | `packageItemScanState` (counts by slip id) |
| Slip lines (inspection) | `listOperatorSlipContentsForPackageAction` | `itemInspectionSlipLines` |
| Expected qty total | `listOperatorSlipContentsForPackageAction` (again if total unset) | `receivingSlipExpectedItemQtyTotal` |

Refetch triggers:

- `packageItemsHydrationNonce` after each successful unit save
- `itemReceiveCountSyncNonce` for aggregate totals
- Package id change resets scan state to empty

## UX timing gaps

1. **No loading skeleton** on “Expected Items” while slip lines fetch—brief empty copy (“No slip lines yet”) possible.
2. **Count lag:** after save, UI waits for server round-trip before slip card counts update (nonce-driven). No optimistic increment on slip card.
3. **Duplicate slip fetch:** two effects can call `listOperatorSlipContentsForPackageAction` on entry (qty sum + line list).
4. **Initial gate:** full-page `ScanPageLoading` until `operatorStoresLoading` clears—appropriate but hides hub context.

## Assessment

Hydration is **correct and race-safe**; operators may perceive a **post-save pause** before qty ticks up. UI-only wins: lightweight “Syncing counts…” on item list during refetch.
