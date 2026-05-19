# Low-risk UI-only improvements

All items are **presentation-only** in `app/scanner/operator-mobile/**` (and shared badge helper usage). No migrations, resolver changes, or env wiring.

## Quick wins (≤1 file each)

| ID | Addresses | Change |
|----|-----------|--------|
| UI-1 | F6 | Render visible **Awaiting** label on slip cards (same chip style as IN PROGRESS), not dot-only |
| UI-2 | F14 | Pass `alertCount={0}` or omit badge until alerts are wired |
| UI-3 | F3 | While `packageItemsHydrationNonce` fetch in flight, show slim **Updating counts…** under Expected Items header |
| UI-4 | F4 | When `itemInspectionSlipLines` loading (local `slipLinesLoading` flag), show 2–3 skeleton rows instead of empty copy |
| UI-5 | F10 | Sticky toast for `itemBarcodeMiss` / `itemReceiveError` at bottom (reuse intake toast pattern) |
| UI-6 | F16 | Pass `itemOverscanWarning` into `ItemUnitRecordModal` as subtitle or banner when opening from over-scan |
| UI-7 | F9 | Add compact **?** help on item phase linking to “unexpected item” and Add/Scan flows (copy only) |
| UI-8 | F8 | In unknown modal, visually emphasize **Tracking** + **Box**; demote Item/Pallet with `text-xs` secondary row |
| UI-9 | F11 | Rename buttons: **Start new shipment (box)** vs **Record off-slip unit** to disambiguate |
| UI-10 | F18 | Show non-sr-only **Scanner ready** / last scan snippet under laser frame in items phase |

## Small logic-only UI (no new API fields)

| ID | Addresses | Change |
|----|-----------|--------|
| UI-11 | F2 | In items phase, queue last scanned code in ref while `busy` and process once save completes (client queue only) |
| UI-12 | F1 | On gate/box `busy`, show inline **Processing scan…** on scan frame instead of silent drop |
| UI-13 | F13 | Add **Today** chip next to expiry date that sets `input[type=date]` to local today |

## Deferred (needs additive select, not UI-only)

| ID | Addresses | Why deferred |
|----|-----------|--------------|
| UI-D1 | F5 | Show mismatch on slip cards requires `product_match_status` in `listOperatorPackageItemsForPackageAction` select + aggregate—touches server action contract |
| UI-D2 | F7 | Show match tier on card needs persisted tier on row or client-side re-derive from last scan payload |

## Suggested implementation order

1. UI-1, UI-3, UI-4 (slip list clarity + hydration feedback)
2. UI-6, UI-5 (errors/warnings visibility)
3. UI-8, UI-9 (unknown flows)
4. UI-11, UI-12 (scan throughput—slightly more than cosmetic but still client-only)

## Explicitly out of scope (per audit constraints)

- New tables / migrations / `package_items`
- Resolver or `resolveOperatorBarcode` changes
- Staging/prod env or feature-flag wiring changes
- OCR / AI / Amazon integrations
