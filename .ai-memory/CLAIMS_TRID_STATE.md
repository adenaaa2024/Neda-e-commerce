# Claims & TRID state — phase1 delivery

**Branch:** `feature/product-canonicalization-v3` @ `4402064`  
**Last updated:** 2026-06-09 (`history-memory-align-after-phase1-census` `20260609T140000Z`)

Related: [CLAIMS_ENGINE_STATE.md](CLAIMS_ENGINE_STATE.md) · [TRID_CLAIM_STATUS.md](TRID_CLAIM_STATUS.md)

## Delivery status summary

| Track | Dry-run | Applied | Next |
|-------|---------|---------|------|
| Claim lines schema | **PASS** | **NO** | Schema apply staging |
| Claim lines backfill | **PASS** | **NO** | After schema apply |
| TRID foundation | **PASS_WITH_BLOCKERS** | **NO** | After `claim_lines` |

## Claims — claim_lines

| Item | Detail |
|------|--------|
| Migration file | `supabase/migrations/20260831120000_claim_lines_foundation.sql` |
| Schema dry-run | **PASS** — `claim-return-line-foundation-schema-dryrun/20260528T140000Z/` |
| Applied | **NO** (drafted per delivery checkpoint) |
| Backfill upper bound | **~13,966** pre-dedupe |
| Backfill dry-run | **PASS** — `claim-return-line-backfill-dryrun/20260528T160000Z/` |
| Approval | `claim-return-line-foundation-schema-approval.md` |

### Backfill lanes (upper bound)

| Lane | Est. rows |
|------|----------:|
| removal claim candidates | 6,481 |
| returnish claim candidates | 2,574 |
| expected group short | 4,911 |
| return_item grain | 0 |

Dedupe by `idempotency_key` will reduce actual INSERT count.

## TRID foundation

| Item | Detail |
|------|--------|
| Migration file | `supabase/migrations/20260832120000_trid_foundation.sql` |
| Dry-run | **PASS_WITH_BLOCKERS** — `trid-foundation-migration-dryrun/20260530T200000Z/` |
| Applied | **NO** |
| Prerequisite | **`public.claim_lines` missing** — apply claim_lines migration first |
| Approval | `trid-foundation-migration-approval.md` |
| Reuse | `financial_reference_resolver` — 560,222 distinct trid_keys |

## Claim line grain (locked)

| Lane | Grain |
|------|-------|
| Scanner / receive | **1 claim_line ↔ 1 return_items** |
| Expected short/overage | **group-grain** on root EP |
| Import candidates | **import-grain** until TRID grouping |

## Priority (June 2026 — append)

Aligns with [ROADMAP.md](ROADMAP.md): Scanner → Product → Removal → **Claims (here)** → TRID → Inventory → AI

**Next (phase 1 census):** **CLAIMS-ORIGINAL-PARITY-GROUPING** — original schema parity + grouping architecture.

1. **BUILD-FIX-TESSERACT-SCAN-PAGE**  
2. **ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE** (product completion on original)  
3. **CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY**  
4. **CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-APPLY** (after claim_lines; approval false)  
5. **GH-AUTH-PR-CREATE**  
6. **TRID-FOUNDATION-MIGRATION-APPLY** (after claim_lines)

**Done (append):** ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE · resolver finish verify **PASS**

## Forbidden

- No claim submit without approval  
- No product auto-create from claims  
- No TRID apply before claim_lines  
- No production writes  

## Evidence

`claim-return-line-foundation-schema-dryrun/20260528T140000Z/` · `claim-return-line-backfill-dryrun/20260528T160000Z/` · `trid-foundation-migration-dryrun/20260530T200000Z/`
