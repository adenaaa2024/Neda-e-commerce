# Product identifier governance

**Carries forward:** V192 · PC Phase 01 · removal resolver policy  
**Last updated:** 2026-06-06 (append)

## Spine

| Object | Role |
|--------|------|
| `products` | Canonical row; `products.id` first comparison key |
| `product_identifier_map` | ASIN, FNSKU, SKU, UPC/GTIN bridge |
| `resolved_product_id` | Persist on single deterministic winner |

## Resolution path (locked)

```text
input → normalize → local resolver (products + map)
→ gated backend enrichment ONLY if allowed
→ persist resolved_product_id if deterministic
→ ProductLinkageDisplayContract
```

**Guard:** `npm run check:product-resolution-contract-v192`

## Tier priority

1. `resolved_product_id` / `products.id`  
2. Legacy `product_id` (only if no canonical key)  
3. FNSKU → ASIN+SKU → ASIN → SKU → product_identifier / UPC-GTIN (tier 4 often disabled)

## Forbidden

UI/browser `products.insert` · title/OCR/fuzzy/AI auto-create · product create on removal fetch/rebuild · unapproved SP-API product writes

## Removal phases

| Phase | Product create |
|-------|----------------|
| SP-API fetch / sync / rebuild | **Forbidden** |
| Post-rebuild resolver | Map-only |

Evidence: [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) · [SP_API_STATE.md](SP_API_STATE.md)
