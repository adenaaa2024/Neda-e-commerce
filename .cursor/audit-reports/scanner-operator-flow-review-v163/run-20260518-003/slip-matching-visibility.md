# Slip matching visibility

## Slip line list (item phase)

Each slip row shows:

- Description (or FNSKU · UPC fallback)
- UPC and FNSKU monospace row
- **QTY: scanned of expected**
- Status via `slipCardStatusMark`:
  - **Awaiting:** tiny gray dot + `sr-only` “Awaiting scan” (no visible label)
  - **IN PROGRESS / RECEIVED:** compact uppercase label + row color / emerald ring when complete

Unexpected units appear as a dedicated card: **“Not on packing slip”** with count.

## Matching logic (operator-visible outcomes)

1. Prefer slip lines with UPC/FNSKU → `resolveItemBarcodeAgainstSlipRows`
2. Else expected-package detail rows → EP picker or miss message
3. On save, server matches barcode to slip tier (`fnsku` / `upc` / `unexpected`)

## Pre-save signals

- **Over-scan:** `itemOverscanWarning` banner above slip list when scan exceeds slip qty (scan still proceeds in modal)
- **Subtitle in modal:** slip description or identifiers

## Post-save signals

- Slip card counts update after hydration refetch (not instant)
- `scanSuccessFlash` on frame (global)
- Unexpected aggregate row increments

## Not shown today

- Which tier matched (FNSKU vs UPC) on the slip card
- Product mismatch / review badges on slip rows
- Last scanned barcode per line

## Shipment summary (pallet context)

When `expectedPkgLines` loaded, compact Exp / Scn / Rem per product group—helpful above slip list for multi-box shipments.

## Assessment

**Quantity matching is visible and color-coded** after first scan; **pre-scan Awaiting state is easy to overlook**; **match quality** (tier, product mismatch) is under-surfaced.
