# Files changed

| File | Change |
|------|--------|
| `app/scanner/operator-mobile/_components/operator-store-actions.ts` | Item-scan list/insert use `return_items` + slip barcode match; removed `package_items` guard |
| `app/scanner/operator-mobile/scan/page.tsx` | Comments only (behavior unchanged) |
| `lib/scanner/item-unit-discrepancy-tags.ts` | Comment: tags → `return_items.conditions` |

## Not changed (by design)

- No new migration; `package_items` SQL left in repo unapplied
- Neda UI layout / modal workflow / action export names preserved
- `operatorReceiveItem` / EP path untouched
