# Backend contract — operator-mobile scanner (v165)

**Audience:** Neda (UI)  
**Verified:** 2026-05-18 against project `kxsvedvpjldygtdbylsy` (workspace `.env.local`, read-only probes)  
**Status:** **PASS**

## Canonical runtime model

| Concern | Table / surface |
|---------|-----------------|
| Physical units scanned in a box | `return_items` (one row per unit) |
| Packing-slip lines for a box | `slip_contents` (replace-all per save) |
| Box header | `packages` |
| Product linkage (read + optional manual set) | `products`, `product_identifier_map` |
| **Never** use for item units | `package_items` |

Persistence stack for item scan:

```
insertOperatorPackageItemAction
  → insertReturn (app/returns/actions.ts)
    → return_items INSERT
    → applyReturnItemProductEnrichmentAfterInsert (best-effort linkage patch)
```

Hydrate stack:

```
listOperatorPackageItemsForPackageAction
  → return_items SELECT (by package_id)
  → listOperatorSlipContentsForPackageAction (for barcode ↔ slip_content_id)
  → resolveItemBarcodeAgainstSlipRows (in-memory)
```

## Auth and tenancy

All server actions in `operator-store-actions.ts` and `item-actions.ts`:

- Require cookie session (`getSessionUserIdFromCookies`)
- Resolve write org via `resolveWriteOrganizationId(null, requestedOrganizationId)`
- Use **service role** (`supabaseServer`) with explicit org/store checks (workspace org switch safe)

**Input every call carries:** `requestedOrganizationId` (workspace org UUID) and usually `storeId` (active store UUID).

## Core actions (Neda must use)

### 1. Store scope

**`getOperatorStoreScopeForOrganization(requestedOrganizationId?)`**

| | |
|---|---|
| **Reads** | `stores`, `organization_settings` |
| **Writes** | none |
| **Success** | `{ ok: true, snapshot: { stores: OperatorStoreOption[], defaultStoreId } }` |
| **Errors** | `Not signed in`, `Profile not found`, Supabase message |

### 2. Slip lines (read)

**`listOperatorSlipContentsForPackageAction(requestedOrganizationId, packageId, storeId?)`**

| | |
|---|---|
| **Reads** | `packages` (org + store check), `slip_contents` |
| **Writes** | none |
| **Success** | `{ ok: true, rows: OperatorSlipContentsListRow[] }` |
| **Row fields (UI)** | `id`, `upc`, `fnsku`, `description`, `quantity`, `condition`, `notes`, `rma_number`, `sort_index`, `slip_code`, `order_id`, `conflicting_order_id` |
| **Errors** | Not signed in, invalid package, wrong store, package not found |

Select uses **fallback chain** if optional columns missing (notes, order_id, conflicting_order_id, linkage).

### 3. Item units — list / hydrate

**`listOperatorPackageItemsForPackageAction(requestedOrganizationId, packageId, storeId?)`**

| | |
|---|---|
| **Reads** | `packages`, `return_items`, slip rows (via slip list action) |
| **Writes** | none |
| **Success** | `{ ok: true, rows: OperatorPackageItemRow[] }` |
| **Row shape** | `id`, `slip_content_id`, `scanned_barcode`, `match_kind`, `quantity` (always 1), `discrepancy_tags`, `expiry_date`, `lot_number`, `evidence_urls` |
| **`slip_content_id`** | Derived server-side by matching barcode to slip FNSKU/UPC — **not** stored on `return_items` |

### 4. Item units — save (primary Neda path)

**`insertOperatorPackageItemAction(input: InsertOperatorPackageItemInput)`**

| Field | Type | Required |
|-------|------|----------|
| `requestedOrganizationId` | UUID string | yes |
| `packageId` | UUID | yes |
| `storeId` | UUID \| null | yes (resolved from package if omitted) |
| `slipContentId` | UUID \| null | optional hint; validated against package |
| `scannedBarcode` | string | yes |
| `matchKind` | `"fnsku"` \| `"upc"` \| `"unexpected"` | yes |
| `quantity` | number | default 1, max 500 (loops `insertReturn`) |
| `discrepancyTags` | string[] | min 1 (filtered server-side) |
| `expiryDate` | `YYYY-MM-DD` \| null | required if `traceabilityRequired` or tag `expired` |
| `lotNumber` | string | required with expiry rules above |
| `evidenceUrls` | https URLs | required when damage-type tags selected |
| `traceabilityRequired` | boolean | grocery / perishable path |

| | |
|---|---|
| **Reads** | `packages`, optional `slip_contents` |
| **Writes** | `return_items` (via `insertReturn`) |
| **Success** | `{ ok: true, id: string }` (first inserted row) |
| **Errors** | See action-map.md |

**Safe fallback:** On validation error, show `message`; do not create partial rows except when `quantity > 1` fails mid-loop (earlier rows may exist — rare).

### 5. Box + slip persist

**`updateOperatorIntakeBoxPackageAction`** / aliases `saveOperatorPackageAction`, `saveOperatorSlipVisionAction`

| | |
|---|---|
| **Reads** | `packages`, `pallets` (optional), duplicate slip check |
| **Writes** | `packages` PATCH; `slip_contents` DELETE+INSERT when `slipContents.mode === "replace"`; optional `pallets` PATCH |
| **Success** | `{ ok: true, palletMixedOrderIds?, slipContentsOrderId?, slipConflictingOrderId?, palletOrderIdFromDb? }` |
| **Mismatch signal** | `palletMixedOrderIds: true` when slip token ≠ pallet `order_id` → sets `slip_contents.conflicting_order_id` on lines |

Post-replace: `enrichSlipContentsProductLinksAfterReplace` (async, best-effort linkage on slip rows only).

### 6. Slip barcode match (client + server)

**Client:** `resolveItemBarcodeAgainstSlipRows(barcode, SlipBarcodeMatchRow[])` in `lib/scanner/operator-slip-item-resolve.ts`

| Outcome | Meaning |
|---------|---------|
| `{ kind: "single", tier, slip }` | Open item modal linked to slip line |
| `{ kind: "ambiguous", candidates }` | Show picker |
| `{ kind: "none" }` | Unexpected barcode UI |

**Server:** Same logic inside `listOperatorPackageItemsForPackageAction` for hydrate `slip_content_id`.

### 7. Product linkage (read / manual only)

| Function | Role |
|----------|------|
| `resolveProductForScannerItem` | Deterministic resolver (map + products); **no create** |
| `applyReturnItemProductEnrichmentAfterInsert` | After `insertReturn`; patches linkage columns if present |
| `manualOverrideReturnItemProductResolution` | Operator picks existing `products.id` |

**Display:** `scannerProductResolutionBadges` / `useScannerProductResolutionBadges` from `identifier_resolution_status` (+ optional legacy fields).

**Catalog read (identify / item gate):** `resolveOperatorBarcode` with `only: "item"` → `products` + `product_identifier_map` (client Supabase, org-scoped).

## Secondary actions (same module, pallet / box flow)

| Action | Purpose |
|--------|---------|
| `listOperatorPackagesForPalletAction` | Box list on pallet |
| `fetchOperatorPalletHydrationAction` | Pallet header hydrate |
| `insertOperatorIntakeBoxPackageAction` | New box on pallet |
| `checkOperatorSlipCodeDuplicateAction` | Duplicate `id_slip_contents` guard |
| `findOperatorPalletByTrackingNumberAction` | Tracking dup / wrong store |
| `createOperatorPalletAction` | New pallet |
| `commitOperatorPalletShipmentStepAction` | Save & Start shipment step |
| `insertOperatorUnknownPackageAction` | Placeholder package (optional; not always called from UI) |
| `getOperatorStoreScopeForOrganization` | Store picker data |

## Secondary — expected_packages path (do not use for BOX slip item scan)

**`operatorReceiveItem`** (`item-actions.ts`): inserts `return_items` **and** bumps `expected_packages.actual_scanned_count`. Used when UI is in **tracking / EP expectation** mode, not slip-line BOX scan.

## Client-only helpers (not server actions)

| Helper | Module |
|--------|--------|
| `fetchExpectedPackagesForTracking`, `loadTrackingExpectationSnapshot` | `operator-tracking-expectations.ts` |
| `fetchVInventoryStatusForScanCode` | `v-inventory-status.ts` |
| `resolveOperatorBarcode` | `operator-resolve-barcode.ts` |
| `resolveItemBarcodeAgainstExpectedRows` | `operator-item-resolve.ts` |

## API routes (out of Neda BOX contract)

| Route | Note |
|-------|------|
| `POST /api/scanner/extract-box-slip` | AI vision — **do not call** per v165 constraints |
| `POST /api/scanner/extract-slip` | AI — **do not call** |

## Live verification summary

Executed `npx tsx scripts/scanner-neda-08-final-ui-signoff.ts`:

- `return_items` linkage SELECT: **OK**
- `slip_contents` display SELECT: **OK** (fallback attempt 4)
- `package_items`: **absent**
- Fixture `9528d923-3d27-4aed-a773-095b5028743d`: 2 slip lines, 3 return_items; NEDA-06 row matches slip barcode `X004N9OS4J`, `resolved_product_id` null

See `probe-output.json` in `scanner-neda-08-final-ui-signoff/run-20260518-001/` for full step log.
