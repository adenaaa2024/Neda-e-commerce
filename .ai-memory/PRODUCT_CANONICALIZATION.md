# Product canonicalization — PC Phase 01

**Branch:** `feature/product-canonicalization-v2`  
**Last updated:** 2026-05-29 (`removal-api-product-linkage-checkpoint` `20260529T120000Z`)

## Removal product linkage (checkpoint)

| Phase | Product create |
|-------|----------------|
| SP-API fetch | **Forbidden** |
| Domain sync | **Forbidden** |
| Rebuild | **Forbidden** — qty/tracking only |
| Resolver backfill | Map-only; **5,397** resolved / **71** missing evidence (dry-run post-fix) |
| Promotion | Amazon evidence only |

**Canonical path:** `product_id` / `resolved_product_id` — no title-only create.

## Rebuild verify (post allocation fix)

`removal-rebuild-verify-and-resolver-dryrun/20260528T181500Z-verify` — **PASS**, `rebuild_valid=yes`, mismatch **0**.

See [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md).

## Spine (unchanged)

~17,033 `products` · ~16,803 active map rows · V192 contract locked.

**Guard:** `npm run check:product-resolution-contract-v192`
