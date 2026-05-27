# Product canonicalization — PC Phase 01

**Branch:** `feature/product-canonicalization-v2`  
**Staging ref:** `eiqfaapyumhixxoeltgu`  
**Last updated:** 2026-05-28 (`removal-api-product-resolution-checkpoint` `20260528T180000Z`)

## Spine

| Object | Role |
|--------|------|
| `products` | Canonical product row (~17,033 staging) |
| `product_identifier_map` | Deterministic bridge (~16,803 active) |
| `resolved_product_id` | Persist only on single deterministic winner |

## Removal path — product creation (checkpoint)

| Rule | Detail |
|------|--------|
| Fetch / rebuild | **No** `products` INSERT during removal report sync or `rebuild_expected_packages_from_removals` |
| Promotion | Governed only with **real Amazon evidence** (SP-API / approved enrichment) |
| Forbidden | Title-only, product-name-only, OCR/fuzzy auto-create |

**Next:** **REMOVAL-PRODUCT-RESOLVER-WIRE** for `expected_packages` lines after rebuild.

See [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md).

## Product linkage coverage

Linkage **not 100%** — **PRODUCT-LINKAGE-TABLE-COVERAGE-AUDIT** required before spine-wide assumptions.

## Spreadsheet intake (unchanged)

4,479 rows · 16 cols · 175 parseable L×W×H · 90 merge-safe · 85 dup-ASIN review · 4,304 missing dims.

## Unresolved counts (census)

| Surface | Resolved | Unresolved |
|---------|----------|------------|
| expected_packages | 1,583 / 1,626 | 43 |
| return_items | 5 / 12 | 7 |
| slip_contents | 0 / 11 | 11 |
| AFI | 14,752 / 19,503 | 4,751 |

## Resolver (V192)

```text
input → normalize → local resolver → products + map → gated enrichment → persist if deterministic
```

**Guard:** `npm run check:product-resolution-contract-v192`
