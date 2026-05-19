# DB read / write map — operator-mobile scanner

**Primary persistence:** `return_items` + `slip_contents` + `packages`  
**Linkage reads:** `products`, `product_identifier_map`  
**Identify gate reads:** `expected_packages`, views via `v-inventory-status` helpers

---

## By user journey

### Identify gate (tracking / shipment)

| Step | Tables read | Tables written |
|------|-------------|----------------|
| Scan tracking | `expected_packages`, `pallets` (normalized tracking), optional inventory views | none (read-only gate) |
| Inventory status | PostgREST / view-backed queries in `v-inventory-status.ts` | none |
| Resolve barcode (multi-kind) | `expected_packages`, `packages`, `pallets`, `products`, `product_identifier_map` | none |
| Create receiving pallet (client or server) | `pallets` | `pallets` (insert via `createOperatorPalletAction` or client) |
| Dup tracking check | `pallets` | none (`findOperatorPalletByTrackingNumberAction`) |

### Box intake (package header + slip table)

| Step | Tables read | Tables written |
|------|-------------|----------------|
| Scan / pick box | `packages`, `pallets` | `packages` insert (`insertOperatorIntakeBoxPackageAction`) |
| Save photos / slip vision | `packages`, `pallets` | `packages` update; `slip_contents` delete+insert; optional `pallets` update |
| Duplicate slip check | `packages` (`id_slip_contents`) | none |
| Post slip replace enrichment | `slip_contents`, `product_identifier_map`, `products` | `slip_contents` linkage patch (best-effort) |

### Slip list (display)

| Step | Tables read | Tables written |
|------|-------------|----------------|
| Hydrate lines | `packages`, `slip_contents` | none |

### Item scan / save

| Step | Tables read | Tables written |
|------|-------------|----------------|
| Match barcode | slip rows in memory (from `slip_contents` read) | none |
| Save unit | `packages`, optional `slip_contents` (validate slip id) | **`return_items`** INSERT |
| Post-insert enrichment | `product_identifier_map`, `products` | **`return_items`** linkage columns (if exist) |
| Package counter | — | `packages.actual_item_count` (**DB trigger**, not app code) |

### Reload hydration

| Step | Tables read | Tables written |
|------|-------------|----------------|
| List units | `return_items`, `slip_contents` | none |
| Re-derive slip link | in-memory `resolveItemBarcodeAgainstSlipRows` | none |

### Manual product override (admin / future Neda)

| Step | Tables read | Tables written |
|------|-------------|----------------|
| Override | `return_items`, `products` | `return_items` linkage + `return_audit_log` |

---

## Table reference

### `return_items` (WRITE on scan)

| Column (operator path) | Source |
|------------------------|--------|
| `organization_id`, `store_id`, `package_id` | action input + resolution |
| `item_name` | slip `description` or `"Scanned unit"` |
| `conditions` | discrepancy tags array |
| `expiration_date`, `batch_number` | modal |
| `photo_evidence` | evidence URLs JSON |
| `fnsku` | when `matchKind === "fnsku"` |
| `sku` | when `matchKind === "upc"` or `"unexpected"` |
| `marketplace` | `"amazon"` |
| `resolved_product_id`, … | enrichment only if map/products match |

**Not written by operator item scan:** `expected_item_id`, `expected_package_id` (EP path only via `operatorReceiveItem`).

### `slip_contents` (WRITE on slip save only)

Replace-all per package: DELETE `WHERE package_id = ?` then INSERT rows.

| Column | Notes |
|--------|-------|
| `upc`, `fnsku`, `description`, `quantity`, `condition`, `sort_index` | from vision/manual lines |
| `notes` | JSON `{"missing":true}` when line marked missing |
| `order_id` | slip token when RA extracted |
| `conflicting_order_id` | pallet order when mismatch |
| Linkage quartet | enriched async after insert |

### `packages`

| Operation | When |
|-----------|------|
| INSERT | box intake, unknown placeholder |
| UPDATE | photos, slip id, manifest, notes, order_id, counts (trigger-maintained) |

### `pallets`

| Operation | When |
|-----------|------|
| INSERT | `createOperatorPalletAction` |
| UPDATE | shipment commit, smart order-id sync from box save |

### `expected_packages`

| Operation | When |
|-----------|------|
| READ | identify gate, tracking expectations, `operatorReceiveItem` resolve |
| UPDATE `actual_scanned_count` | **`operatorReceiveItem` only** — not `insertOperatorPackageItemAction` |

### `products` / `product_identifier_map`

| Operation | When |
|-----------|------|
| READ | `resolveOperatorBarcode` item, `resolveProductForScannerItem`, enrichment |
| INSERT | **never** from operator-mobile |

### `package_items`

| Operation | When |
|-----------|------|
| — | **FORBIDDEN** — table absent on live DB (PGRST205) |

### `returns` (legacy table name)

| Operation | When |
|-----------|------|
| — | **FORBIDDEN** — use `return_items` constant `RETURN_ITEMS_TABLE` |

---

## SELECT contracts (PostgREST)

From `app/returns/returns-constants.ts`:

```text
RETURN_SCANNER_LINKAGE_SELECT =
  resolved_product_id, resolved_catalog_product_id,
  identifier_resolution_status, identifier_resolution_confidence
```

**`return_items` item-scan list (server action):**

```text
id, fnsku, sku, product_identifier, conditions, expiration_date,
batch_number, photo_evidence, created_at
```

**`slip_contents` list (server action fallback chain):**  
Attempts full linkage + order columns; live DB verified at **fallback attempt 4** (base columns + `notes`).

---

## Triggers / side effects

- `packages.actual_item_count` updated by DB when `return_items` inserted/deleted (documented in code comments).
- `enrichSlipContentsProductLinksAfterReplace` — fire-and-forget after slip replace; failures logged only.
