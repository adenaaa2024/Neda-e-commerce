# Next step recommendation

1. **Operator sign-off (optional, ~5 min)** — Signed-in operator opens `/scanner/operator-mobile/scan`, scans fixture package `1231` / FNSKU `X004N9OS4J`, confirms slip line highlight + unit card after save.
2. **Identify gate demo** — Seed or pick tracking with `expected_packages` rows for org `7397edff-…` if you want recorded gate match video/screenshots.
3. **Cleanup** — Soft-delete NEDA-06 smoke row `ccffe8b3-…` when audit data no longer needed.
4. **Ship** — No further scanner linkage code changes required for operator-mobile `return_items` path; monitor slip linkage migration separately.

**Do not** — Reintroduce `package_items`, OCR-driven `products.insert`, or rename operator UI state keys (`packageItemsHydrationNonce` is legacy naming only).
