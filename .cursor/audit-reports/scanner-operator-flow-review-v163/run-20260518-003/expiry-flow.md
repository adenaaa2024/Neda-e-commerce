# Expiry flow

## Primary path: `ItemUnitRecordModal`

Used for all item-unit saves from operator-mobile scan (wedge → `handleItemBarcodeScan` → `queueItemUnitModal` → save).

Expiry block shown when `packageItemRequiresExpiryBlock`:

- Tag **Expired** selected, or
- Slip description matches perishable/grocery heuristic (`PERISHABLE_DESC_RX` in `lib/scanner/item-unit-discrepancy-tags.ts`)

Requires:

- Expiration date (`type="date"`)
- Batch / lot #

Evidence photos required separately when any non-OK damage tag is selected.

## Secondary path: legacy `itemDraft` + `handleSaveAndNextItem`

Still present for older inspection UI (`itemDraft`, `inspectionCondition`, `itemExpiryDate`). Rules:

- `itemDraft.expirationSupported` from `products.expiration_supported` on barcode lookup
- `inspectionCondition === "expired"` requires expiry date

**Risk:** Two mental models if both paths were reachable in one session; current happy path favors the modal after slip/EP match.

## Box intake

Expiry is **not** collected at box level (by design—box issues are separate wizard).

## Policy alignment

Matches NEXT-SCANNER-03 note: operator-mobile does not infer expiry from mismatch/OCR; tag + description heuristic only.

## Friction

1. Perishable heuristic from slip **description** only—short or missing descriptions skip expiry block until operator selects Expired.
2. Date input has no “today” shortcut on mobile.
3. Lot field required whenever expiry block shows—correct for traceability but slows fast scan.

## Assessment

**Clear and enforced on modal path**; heuristic false negatives are the main operator surprise.
