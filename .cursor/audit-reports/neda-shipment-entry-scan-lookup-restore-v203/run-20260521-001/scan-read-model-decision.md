# Scan read model decision

## Decision

Use **composite read orchestration** in `lookupShipmentEntryScanCode` — **not** a new DB view for V203.

## Sources

| Source | Use for |
|--------|---------|
| `v_inventory_item_status` | Manifest lines, variance, status chips, slip/fnsku/tracking on EP |
| `expected_packages` (+ detail fetch helpers) | Fallback when view empty; enrichment by id |
| `packages` | `package_code`, slip contents, box tracking |
| `pallets` | Pallet number + inbound tracking normalization |
| `loadTrackingExpectationSnapshot` | Operator line table after match |

## Rejected for V203

| Option | Why not |
|--------|---------|
| New `v_shipment_entry_lookup` view | DDL + PostgREST reload; package_code still needs packages join |
| Product / `products` lookup at gate | Wrong flow; confuses item scanner |
| Browser-only `packages` query in UI | Duplicates logic; already centralized in `operator-resolve-barcode` |
| Extend gate to search SKU first | Restores accidental product matching |

## DDL

**None applied.** See `package-code-read-model-gap.md` for optional view extension.

## Regression guard

- Item scan phase still uses `resolveOperatorBarcode(..., { only: "item" })` separately
- Gate `handleIdentifyMatchedStartWorkflow` uses `only: "package"` when entity is package (V203 fix)
