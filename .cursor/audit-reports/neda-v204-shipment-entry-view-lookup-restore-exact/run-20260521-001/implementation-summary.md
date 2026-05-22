# V204 implementation summary

## Root cause
Identify gate sent **all** `manual_new` visuals to create flow, even when `lookupShipmentEntryScanCode` had found tracking/package/pallet via barcode resolver.

## Fix
1. `isShipmentEntryOffManifest` — strict off-manifest predicate
2. Gate: create flow only when off-manifest (production aligned with demo)
3. Lookup: `v_inventory_status` first, tracking EP hydration, barcode-derived visual when view rows empty
4. `ShipmentEntryGateResult` + `toShipmentEntryGateResult` for stable audit shape

## Not touched
Product resolver, item scan, Amazon API, package_items, returns writes, original DB.
