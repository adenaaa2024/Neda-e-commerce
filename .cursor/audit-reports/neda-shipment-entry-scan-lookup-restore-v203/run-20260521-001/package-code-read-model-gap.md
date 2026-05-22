# Package code read model gap

## Schema (present)

| Table / column | Role |
|----------------|------|
| `packages.package_code` | Carton / box barcode (renamed from `slip_id` in `20260511140000`) |
| `packages.id_slip_contents` | Printed slip document id |
| `packages.tracking_number` | Carrier label on box |
| `packages.rma_number` | RMA / slip barcode |
| `expected_packages` | Manifest lines (tracking, sku, fnsku, slip) — **no `package_code`** |

## Views (gap)

| View | Includes `package_code`? |
|------|---------------------------|
| `v_inventory_item_status` | **No** — match columns: fnsku, sku, tracking_number, id_slip_contents |
| `v_inventory_status` | **No** — EP + products join only |

## V203 mitigation (no DDL)

Shipment Entry lookup uses **server-side read orchestration**:

- `resolveOperatorBarcode` → `packages.package_code` (indexed `idx_packages_org_package_code`)
- Hydrate manifest rows via package `tracking_number` when view returns empty

## DDL plan (approval only — not applied)

Optional future migration (not executed):

```sql
-- APPROVAL REQUIRED: expose package_code on operator gate view
-- ALTER VIEW v_inventory_item_status ADD package_code from packages join
```

Prefer keeping package resolution in `lookupShipmentEntryScanCode` to avoid view drift across stores.

## Status

| Capability | V203 |
|------------|------|
| Scan `package_code` | **PASS** via `packages` table |
| Scan carton in inventory view alone | **FAIL** without join migration |
| End-to-end gate UX | **PASS** via orchestration |
