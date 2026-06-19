# Claim latest-sale-net source coverage backfill V1 approval

**Phase:** PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1
**Target:** Original/live `kxsvedvpjldygtdbylsy` only
**Scope:** Wire + backfill the deterministic latest sold price + Amazon fees for the
10 pilot removal claims into a governed source cache.

## What this approves

A governed write of the deterministic latest-sale-net backfill cache into the
canonical `workspace_settings.module_configs.claims.latest_sale_net_cache` only.
No `claim_candidates` / `claim_cases` / `claim_lines` / `claim_submissions` /
`claim_reference_edges` mutation. No Amazon submission. No scanner change. No AI.

## Deterministic resolution rules (pinned into the cache)

- Source priority: `amazon_reports_repository` (Seller Central Transaction View) then
  `amazon_settlements`. Same SKU only (ASIN is null on pilot rows; `amazon_all_orders`
  and `amazon_transactions` are empty for this org).
- Only real sales: `transaction_type = 'Order'` AND `product_sales > 0`. Refunds,
  reimbursements, reversals, fee-only and `$0` adjustment rows are excluded.
- Only rows at/before end-of-day of the claim `source_event_date`.
- Latest by sale date, tie-broken by `id DESC` → exactly one stable winner (no drift).
- Amazon fees come from the SAME selected sale row (`|selling_fees| + |fba_fees| + |other|`).
- No settlement-net fallback, no COGS fallback, no scanner/OCR values.
- If no valid sale exists, the entry is stored as UNKNOWN with an explicit
  `unknown_reason` (`NO_VALID_ORDER_SALE_AT_OR_BEFORE_EVENT`). No invented value.

## Approval token

Set the token below to `yes` to authorize the cache write, then run:

```
npx tsx scripts/phase-claim-latest-sale-net-source-coverage-backfill-v1.ts --execute
```

APPROVED_LATEST_SALE_NET_SOURCE_BACKFILL_V1=yes

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | (Maysam) |
| Date (UTC) | (06/19/2026) |
| Max scope | workspace_settings latest_sale_net_cache only — 10 pilot claims |

**Signature:** APPROVED_LATEST_SALE_NET_SOURCE_BACKFILL_V1=yes (authorized)
