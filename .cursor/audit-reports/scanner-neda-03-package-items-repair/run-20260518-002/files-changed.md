# Files changed

| File | Change |
|------|--------|
| `app/scanner/operator-mobile/_components/operator-store-actions.ts` | Item-scan list/insert use `return_items` + slip barcode match; removed `package_items` guard; insert via `insertReturn`; shared `formatSupabaseActionError` import |
| `app/scanner/operator-mobile/scan/page.tsx` | Comments + hydration doc; identify-gate error formatting; extended slip select fallbacks (product linkage columns) |
| `lib/scanner/item-unit-discrepancy-tags.ts` | Already documents `return_items.conditions` (no diff this run) |

## Not changed (by design)

- No new migration; `supabase/migrations/20260515190000_package_items.sql` left unapplied
- Neda UI layout / modal workflow / export names (`listOperatorPackageItemsForPackageAction`, etc.) preserved
- `operatorReceiveItem` / EP path untouched
- No products created from OCR/title

## Working tree note

Changes verified in git diff vs `HEAD`; not committed in this run.
