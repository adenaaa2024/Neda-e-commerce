# Product Core — protected backbone architecture

**Status:** PROTECTED — do not rewrite without audit + approval  
**Branch:** `feature/phase1-latest-stash-land` @ `c78fbb8`  
**Last updated:** 2026-06-13 (`product-core-protection-history-memory-update` `20260613T120000Z`)

## Protection rule (mandatory)

**Product Core is protected architecture.**

Do **not** rewrite, simplify, bypass, or replace existing Product Core flows in future prompts or implementations.

## Product Core scope

| Layer | Includes |
|-------|----------|
| Identity spine | `products`, `product_identifier_map`, `catalog_products` |
| Resolution | Resolver rules, tier priority, V192 contract, `resolved_product_id` |
| Intake | PIM import, sheet import, API enrichment |
| Normalization | Brand, category, vendor, dimensions, packaging, spec normalization |
| Governance | Safe product creation rules, raw/provenance preservation |

Related: [PRODUCT_IDENTIFIER_GOVERNANCE.md](PRODUCT_IDENTIFIER_GOVERNANCE.md) · [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) · [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md)

## Change gate (before any core mutation)

Any change to **matching, merge, resolver, product creation, normalization, or identifier-map writes** requires:

1. **Read-only audit**
2. **Parity proof**
3. **Risk report**
4. **Explicit operator approval**

No exceptions for "cleanup", "simplification", or "refactor" without this gate.

## Wave1 enrichment refactor — CLARIFIED

Wave1 enrichment refactor was **SAFE**: **moved code only** — did not change Product Core matching, merge, resolver, or product-creation semantics.

## Completion (roadmap correction)

| Dimension | Estimate |
|-----------|------------|
| Product Core **architecture** | **90-95%** |
| Product Core **operational / data completion** | **65-75%** |

**CLARIFIED:** architecture maturity and operational/data completion are separate — do not conflate.

## Execution policy (unchanged)

Product Core work still follows: `census -> classify -> sample dry-run -> approval -> sample apply -> verify -> next wave`

## Exact next prompt

```text
PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION
```

Resolve sheet conflicts under Product Core protection before max-25 sample apply.
