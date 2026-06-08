# Neda scanner — quantity batch API contract (backend prep)

**Status:** Backend prep only. Existing mobile UI unchanged; continues to work with `quantity=1` or multi-insert loop.

## Canonical model

| Concept | Table / field |
|---------|----------------|
| Scanned unit batch | `return_items` (one row per operator save) |
| Unit count | `return_items.scanned_quantity` (integer ≥ 1, default 1) |
| Expiration | `return_items.expiration_date` (date/text), `batch_number` (lot) |
| Expected forecast | `expected_packages.expected_scan_quantity` |
| Problem units | Separate `return_items` rows with conditions + `photo_evidence` |

Progress views use **`SUM(scanned_quantity)`** for scanned totals; **`COUNT(*)`** exposed as `scan_batch_count` where useful.

## Save scan — server action

**Primary path (unchanged surface):** `insertReturn` via `insertOperatorPackageItemAction` / `operatorReceiveItem`.

### Request fields (extended)

```typescript
type ReturnInsertPayload = {
  marketplace: string;
  item_name: string;
  conditions: string[];
  store_id?: string;
  package_id?: string;
  pallet_id?: string;
  sku?: string;
  fnsku?: string;
  asin?: string;
  product_identifier?: string;
  expiration_date?: string;   // ISO date YYYY-MM-DD
  batch_number?: string;      // lot / batch code
  notes?: string;
  photo_evidence?: Record<string, unknown> | null;
  /** NEW — default 1. Values > 1 create one batch row (after migration). */
  scanned_quantity?: number;
  expected_item_id?: string | null;
  organization_id?: string;
  actor_profile_id?: string | null;
};
```

### Backward compatibility

| Client behavior | Server result |
|-----------------|---------------|
| Omits `scanned_quantity` | `scanned_quantity = 1` |
| Sends `quantity: 1` per scan (legacy loop) | N rows × qty 1 (unchanged) |
| Sends `scanned_quantity: N` once | 1 row × qty N (new; requires migration) |
| Problem scan with photos | Separate row; keep `scanned_quantity = 1` unless multiple identical damaged units share same evidence |

### Allocation RPC (post Phase-2 migration)

After `20260608180100_return_items_quantity_allocation_rpcs.sql`:

- `allocate_expected_items_for_return_item_ids` decrements parent EP by **`scanned_quantity`**, not 1.
- Over-allocation blocked when parent `expected_scan_quantity < scanned_quantity` unless org setting allows (future).

## Item-level receive

`operatorReceiveItem` today **rejects `quantity !== 1`**. Until mobile sends batch quantity:

- Use package-level `insertOperatorPackageItemAction` with `scanned_quantity`, **or**
- Next prompt: relax item-actions guard when `scanned_quantity` column exists.

## Read paths (unchanged URLs)

| UI need | Source |
|---------|--------|
| Package progress | `v_inventory_status`, `v_inventory_item_status` |
| Slip line scanned total | `v_scanned_items_counted.total_scanned` |
| Batch row count | `v_scanned_items_counted.scan_batch_count` |
| Expected remaining | `remaining_to_scan` on inventory views |

## Claims

- Claim lines should use **`scanned_quantity`** (or `quantity_actual`) for affected units.
- One problem row with `scanned_quantity = 3` → claim quantity 3; evidence stays on that row.

## Migration order

1. `20260608180000_return_items_scanned_quantity_batch.sql` — column, indexes, views
2. `20260608180100_return_items_quantity_allocation_rpcs.sql` — allocation RPCs (staging verify first)
3. Deploy app with `insertReturn` + list select including `scanned_quantity`

## Verification

```bash
npx tsx scripts/scanner-quantity-batch-verify-readonly.ts
```
