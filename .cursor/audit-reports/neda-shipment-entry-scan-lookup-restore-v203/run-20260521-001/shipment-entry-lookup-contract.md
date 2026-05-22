# Shipment entry lookup contract

## Canonical API

**Module:** `lib/scanner/shipment-entry-lookup.ts`

```ts
lookupShipmentEntryScanCode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rawCode: string,
): Promise<ShipmentEntryLookupResult>
```

**Offline:** `mockLookupShipmentEntryScanCode(rawCode)`

## `ShipmentEntryLookupResult`

| Field | Purpose |
|-------|---------|
| `normalized_code` | Trimmed / zero-width stripped input |
| `match_status` | `found_tracking` \| `found_slip` \| `found_package` \| `found_pallet` \| `expected_only` \| `already_scanned` \| `not_found` \| `ambiguous` |
| `entity_type` | `tracking` \| `slip` \| `package` \| `box` \| `pallet` \| `container` \| `expected_package` \| `unknown` |
| `entity_id` | Primary UUID (EP line, package, or pallet) |
| `package_id` / `pallet_id` | Physical row IDs when resolved |
| `tracking_number` / `slip_code` / `package_code` | Display / continue hints |
| `status_label` / `status_detail` | Human gate badge copy |
| `next_action` | `continue_to_package` \| `continue_to_pallet` \| `create_orphan` \| `review_ambiguous` \| `show_not_found` |
| `inventory_rows` | `VInventoryStatusRow[]` for existing table UI |
| `inventory_matched_field` | View column match |
| `inventory_visual` | Gate glow state |
| `barcode` | `OperatorResolveResult` (never `item`) |
| `canonical_tracking` | Tracking to load EP lines / snapshot |

## Resolution order (no product tier)

1. `fetchVInventoryStatusForScanCode` (`v_inventory_item_status`)
2. `resolveOperatorBarcode` with `only` ∈ `tracking`, `package`, `slip`, `pallet`
3. Re-query inventory by package/pallet `tracking_number` when needed
4. `fetchExpectedPackageDetailRowsForParent` tracking fallback
5. Synthetic inventory row for package/slip with no EP line (physical box only)

## UI integration

`runIdentificationGateSearch` in `app/scanner/operator-mobile/scan/page.tsx` calls `lookupShipmentEntryScanCode` and maps:

- `inventory_rows` → `identifyGateShipmentLines` pipeline
- `inventory_visual` → badges / progress
- `canonical_tracking` → `identifyGateCanonicalTracking`

No duplicate types in `operator-store-actions` (client read model; same pattern as pre-V203 view fetch).
