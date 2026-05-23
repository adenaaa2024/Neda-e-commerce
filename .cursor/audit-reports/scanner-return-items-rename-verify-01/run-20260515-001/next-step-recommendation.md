# Next step recommendation

## Recommended next prompt

**NEXT-SCANNER-02 — PRODUCT LINKAGE FOR EXPECTED ITEMS + RETURN_ITEMS + SLIP_CONTENTS**

### Suggested scope

1. **Product resolver** — Map scanned barcodes / slip lines to catalog `products` (or product identity views) with explicit match rules and ambiguity handling.
2. **`return_items` + `slip_contents` + `expected_packages` / expected item rows** — Join strategy for “expected vs received” reconciliation in scanner and returns UI.
3. **`product_id` (and related FKs)** — Only where justified by an existing or new migration; align Prisma/Supabase types and inserts.
4. **Keep `return_items` as the persisted scanner line table** — Resolver writes resolved identifiers onto rows or sidecar tables as you define in the design.

This builds directly on the verified contract: physical line items live in **`return_items`**, not a legacy `returns` table name in application code.
