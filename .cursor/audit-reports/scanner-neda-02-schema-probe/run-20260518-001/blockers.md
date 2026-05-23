# Blockers — SCANNER-NEDA-02

## P0 — Schema

1. **`20260717120000_scanner_product_linkage_columns.sql` not applied** on linked project `kxsvedvpjldygtdbylsy`.
   - `expected_packages`: 0/11 linkage columns.
   - `return_items` / `slip_contents`: only 4/13–15 columns (inconsistent with full migration).

2. **`expected_packages.asin` referenced in app but absent on DB** — `EP_SELECT` / `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` fail even before linkage columns.

3. **`slip_contents.notes` absent** — types and migration expect it; live SELECT fails.

## P1 — Runtime (scanner)

Until migration apply:

- Extended list/detail selects wired in NEXT-SCANNER-03/04 **will error or fallback** depending on path.
- `applyReturnItemProductEnrichmentAfterInsert` and `enrichSlipContentsProductLinksAfterReplace` **cannot persist** full enrichment payloads.
- `resolveProductForScannerItem` **cannot** use `expected_packages` product shortcut.

## Non-blockers

- `products` and `product_identifier_map` are **ready** for deterministic resolver reads.
- Base `RETURN_LIST_SELECT` and `EP_DETAIL_SELECT` are **safe** on live DB.

## No action taken this run

- No migrations applied.
- No code changes.
- No Amazon / AI / external API calls.
