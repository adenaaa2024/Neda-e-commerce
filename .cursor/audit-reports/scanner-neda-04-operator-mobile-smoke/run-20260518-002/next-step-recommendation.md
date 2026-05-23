# Next step recommendation

1. **Operator manual (5 min)** — On staging/dev: open `/scanner/operator-mobile/scan`, scan tracking with EP inventory, complete identify gate, save one slip-matched unit, reload and confirm counts.
2. **Optional fixture seed** — Add or use a package whose `tracking_number` matches an `expected_packages` row for repeatable identify-gate automation.
3. **When ready** — Apply `20260717120000_scanner_product_linkage_columns.sql` on non-prod, re-run `scripts/next-scanner-04-staging-e2e.ts` and shorten `slip_contents` fallback chain.
4. **Do not** apply `package_items` migration on live DB — persistence remains `return_items`.
