# Product canonicalization — PC Phase 01

**Branch:** `feature/product-canonicalization-v2`  
**Staging ref:** `eiqfaapyumhixxoeltgu`  
**Baseline audit:** `pc01-product-canonicalization-baseline/20260522T230000Z/`

## Spine

| Object | Role |
|--------|------|
| `products` | Canonical product row (~17,033 staging) |
| `product_identifier_map` | Deterministic bridge (~16,803 active) |
| `resolved_product_id` | Persist only on single deterministic winner |

## Unresolved counts (authoritative census)

| Table / surface | Resolved | Unresolved | Notes |
|-----------------|----------|------------|-------|
| **expected_packages** | **1,583 / 1,626** | **43** | Post-PC03B (+6 map); was 49 at PC01 |
| **return_items** (read-layer) | **5 / 12** | **7** | Map-only after expected stable; separate test-cohort closure (V186–V189) |
| **slip_contents** | **0 / 11** | **11** | All manual_review at PC03 plan |
| **AFI** (`amazon_amazon_fulfilled_inventory`) | 14,752 / 19,503 | **4,751** | Catalog-scale program |

### expected_packages triage (49 → 43)

| Wave | Count | Action |
|------|-------|--------|
| dirty source (UNKNOW / ASIN-in-FNSKU) | **38** | Quarantine plan PASS; execute approval-gated |
| source disagreement | **6** | **Closed** PC03B (+6 map rows) |
| API catalog 404 | **5** | PC02C manual ASIN queue |

## Resolver rules (non-negotiable)

```text
input → normalize identifiers → local resolver (products + map)
→ gated backend enrichment ONLY if allowed and no local match
→ persist resolved_product_id if deterministic single winner
→ hydrate ProductLinkageDisplayContract
```

| Rule | Detail |
|------|--------|
| Comparison priority | `products.id` / `resolved_product_id` first; then legacy `product_id`; then fnsku → asin+sku → asin → sku → product_identifier |
| Expected vs scanned mismatch | Product-key mismatch wins over raw identifier collision |
| Writes | Approved server actions + governed scripts with dry-run + rollback |
| **Forbidden** | Title/OCR/fuzzy/UI product creation; browser `products.insert`; direct browser Supabase for linkage |

**Guard:** `npm run check:product-resolution-contract-v192`

## Governed executes (staging, reference)

| Wave | Result |
|------|--------|
| PC03B map-only | +6 map rows → 1,583/1,626 |
| E1/E2/E1B (V192–V200) | Map + promotion waves per audit packs |
| PC03A slip/return map | **0** map-bridge candidates at plan time |

## Evidence

`history-pc-phase-01/20260526T120000Z/` · `pc03b-expected-packages-source-disagreement-map-execute/20260523T020000Z/` · `pc03-expected-packages-dirty-source-quarantine-plan/20260523T050000Z/`
