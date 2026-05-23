# package_code view DDL plan (not applied)

**Approval:** `.cursor/operator-approvals/neda-shipment-entry-package-code-view-v204-approval.md`  
**Default:** `APPROVED_TO_APPLY_VIEW_DDL=false`

## Gap
`packages.package_code` is not exposed on `v_inventory_status` / `v_inventory_item_status`.

## Mitigation (V204 code, no DDL)
`lookupShipmentEntryScanCode` resolves carton via `resolveOperatorBarcode` → `packages.package_code` and hydrates manifest rows.

## Optional CREATE OR REPLACE VIEW (approval required)

```sql
-- Extend v_inventory_item_status only; non-destructive replace.
-- Join packages on expected_packages.tracking_number = packages.tracking_number (store-scoped).
-- Expose packages.package_code for exact gate match.
```

See repo migration `20260638120000_v_inventory_status.sql` for baseline; item-level view DDL lives on staging outside repo snapshot.
