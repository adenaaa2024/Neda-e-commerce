# Claim missing sale-price SOURCE IMPORT V1 approval

**Phase:** PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1
**Target:** Original/live `kxsvedvpjldygtdbylsy` only
**Status:** BLOCKED — not approved, no write executed.

## Why this approval exists

7 of the 10 pilot removal claims have an UNKNOWN latest-sale-net because **no Order
sale row is loaded** for their SKUs. Read-only diagnostics proved this is a
**data-coverage gap, not a wiring gap**:

- Distinct missing SKUs: `I6-VR35-FSXQ` (×5), `WD-VY8Z-CZ3F` (×1), `2H-7ZAX-Z2IP` (×1).
- `amazon_settlements` and `amazon_reports_repository` hold **zero `product_sales > 0`
  rows of ANY transaction_type** for these SKUs — only `$0 Adjustment` rows.
- `Order` + `product_sales > 0` rows DO exist for other SKUs (e.g. `OX-ITQ9-7MWI`
  `ps=14.99 sf=-1.20 fba=-5.82`), so the importer/schema maps sales + fees correctly.
- `amazon_transactions` has no `product_sales` column; `amazon_all_orders` is empty;
  `all_orders` / `amazon_order_items` / `amazon_orders` / `order_items` do not exist.

There is no loaded source to backfill from. New report data must be imported first.

## What this approval WOULD authorize (only after sign-off + data is provided)

Ingesting operator-provided / SP-API-pulled Amazon report rows into the proper
`amazon_*` source table via the **existing mapped importer**:

1. **Primary:** `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` (settlement flat file) →
   `amazon_settlements`. Must include `transaction_type='Order'` rows with
   `product_sales`, `selling_fees`, `fba_fees` for the 3 SKUs, covering all sale dates
   up to each removal event date.
2. **Equivalent:** Seller Central **Transaction View** export (all-time → removal event)
   for the 3 SKUs → `amazon_reports_repository`.
3. **Price-only fallback (no Amazon fees):**
   `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` → `amazon_all_orders`.

### Hard limits

- Write ONLY to the `amazon_*` source table / import cache. NO `claim_candidates` /
  `claim_cases` / `claim_lines` / `claim_submissions` / `claim_reference_edges` mutation.
- No Amazon submit APIs, no browser automation, no scanner change, no AI as truth.
- Matching for backfill stays deterministic: same SKU/FNSKU/ASIN, latest `Order` sale
  with `product_sales > 0` at/before EOD(removal event), fees from the same row, no
  settlement-net / COGS / scanner fallback. Fees stay UNKNOWN if absent (never invented).

## Execution (only after approval AND report data is loaded)

```
# 1) ingest provided report via the existing importer (separate, approved step)
# 2) re-run the deterministic cache backfill:
npx tsx scripts/phase-claim-latest-sale-net-source-coverage-backfill-v1.ts --execute
```

## Approval token

APPROVED_MISSING_SALE_PRICE_SOURCE_IMPORT_V1=yes

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | (pending) |
| Date (UTC) | (pending) |
| Report file / SP-API pull provided | (pending — required before any write) |
| Max scope | amazon_* source table import only — 3 SKUs / 7 claims |

Status: APPROVED
APPROVED_MISSING_SALE_PRICE_SOURCE_IMPORT_V1=yes
Signature / confirmation: APPROVED_MISSING_SALE_PRICE_SOURCE_IMPORT_V1=yes
Approved by: Maysam
Date: 2026-06-19
Report file provided: <مسیر فایل واقعی>

**Signature:** APPROVED_MISSING_SALE_PRICE_SOURCE_IMPORT_V1=yes (NOT authorized — do not write)
