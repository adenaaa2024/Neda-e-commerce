# Next step recommendation

1. **Commit** the working-tree repair (`operator-store-actions.ts`, `scan/page.tsx`, `item-unit-discrepancy-tags.ts` comment).
2. **Operator smoke** on staging/dev: item-scan save + reload (Neda-04 smoke script optional: `npx tsx scripts/scanner-neda-04-operator-mobile-smoke.ts`).
3. **Do not** apply `20260515190000_package_items.sql` on live DB unless explicitly approved — persistence is `return_items`.
4. If product linkage columns are needed on reads, follow scanner-02c pattern for `20260717120000_scanner_product_linkage_columns.sql` separately.
