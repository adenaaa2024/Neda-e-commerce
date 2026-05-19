# Receive / save path

## Code path

1. Barcode scan → `handleItemUnitModalSave` in `scan/page.tsx`
2. `insertOperatorPackageItemAction` → validates package/store, optional slip line
3. `insertReturn` → **`return_items`** insert (not `package_items`)
4. On success: `setPackageItemsHydrationNonce`, `setItemReceiveCountSyncNonce`, close modal

## Constraints this run

- **No live insert** — audit constraint “no broad DB writes”.
- Save path verified by static review + dev server **POST 200** responses during operator session (no stack traces in terminal).

## Failure modes (unchanged)

- Missing store → user message, no throw
- Missing conditions/tags → validation message
- `insertReturn` failure → `setItemReceiveError` / sync toast

## Conclusion

**PASS (static + dev HTTP)** — path targets `return_items`; no `package_items` branch. Operator should confirm one slip-matched save + reload in UI.
