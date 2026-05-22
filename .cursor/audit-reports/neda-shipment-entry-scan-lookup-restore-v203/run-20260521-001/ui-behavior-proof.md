# UI behavior proof

## Unchanged (by design)

- Shipment Entry layout: gate scan card → results card → entity picker (Pallet / Single box / Package) → Continue
- Flow phases: `scan` → `package_scan` → `items`
- Dark mobile chrome / `operator-shipment-entry-gate` styles
- OCR drop zone on gate input
- No navigation to product resolver or `/products/[id]` from gate search

## Restored behaviors

| Operator action | Expected UI |
|-----------------|-------------|
| Scan tracking on manifest | `in_progress` / `completed` badge, line table, canonical tracking, order id |
| Scan slip / `id_slip_contents` | Same table keyed on slip column |
| Scan carton **`package_code`** | Match via packages; hydrate tracking lines when EP exists; package entity path on Continue |
| Scan pallet barcode | `found_pallet`; resume existing pallet when duplicate |
| Unknown code | `manual_new` / **Unexpected** — orphan path, no product modal |
| Help tooltip | Updated to mention package/carton + pallet; excludes SKU/ASIN |

## Code anchors

- Gate search: `runIdentificationGateSearch` → `lookupShipmentEntryScanCode`
- Continue: `handleIdentifyMatchedStartWorkflow` — `resolveOnly: "package"` for package entity
- Pallet resume: `resumeWorkflowFromExistingPalletRow` when lookup finds existing pallet

## Visual flow proof (static)

- Label `Tracking Number or Slip Code` at ~L8407 `page.tsx`
- Results panel `identifyGateInventoryVisual` drives `data-gate-visual` tokens in CSS
- Product resolver components not imported into lookup module

**UI restored without redesign:** PASS (code inspection)
