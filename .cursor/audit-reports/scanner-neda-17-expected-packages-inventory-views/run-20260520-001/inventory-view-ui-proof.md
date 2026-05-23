# v_inventory_item_status UI proof

**Status:** PASS

## Primary read model

- Identify gate: `fetchVInventoryStatusForScanCode` → `identifyGateShipmentLines`
- Fallback: `expected_packages` detail rows when view empty/unavailable

## Line table columns

Product name (linkage label), FNSKU, Expected, Scanned, **Variance**, Status

## Symbols

- `fetchVInventoryStatusForScanCode`: yes
- `identifyGateShipmentLines`: yes
- Variance column: yes
