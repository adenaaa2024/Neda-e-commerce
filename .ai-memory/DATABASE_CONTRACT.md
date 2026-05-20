# Database contract — V183+

Staging ref: **`eiqfaapyumhixxoeltgu`** — Neda/local/Preview **must** use active quartet bound here.

## Active binding

`NEXT_PUBLIC_SUPABASE_URL`, anon key, service role, `DIRECT_POSTGRES_URL`. `STAGING_*` / `ORIGINAL_*` are aliases only.

## Core tables

### Catalog

| Table | Role |
|-------|------|
| `products` | ~17k Sam AM |
| `product_identifier_map` | Bridge; **`upc_code` present** — **UPC/GTIN tier not wired** (V182 gap) |

### Warehouse

| Table / view | Role |
|--------------|------|
| **`return_items`** | Lines — **not** `returns`; V183: **~7** FBM test cohort — **fake/test warning** |
| `packages`, `pallets`, `slip_contents` | Hierarchy |
| **`expected_packages`** | ~1,626 — V179 read-time linkage |

### Inventory views (V179 / V181)

| View | Neda product UI? |
|------|------------------|
| `v_inventory_item_status` | **YES — only** |
| `v_inventory_status` | Aggregate only |
| `v_scanned_items_counted` | Counters only |

### Forbidden / absent

| Name | Rule |
|------|------|
| **`package_items`** | Must not exist |
| **`returns`** (legacy) | Do not query |

### Claims

`claim_candidates` **72.7%** · `claim_candidate_drafts` **51.5%**

## Return-items FBM (V182 / V183)

| Item | Status |
|------|--------|
| V182 readiness | **72/100** |
| Dry-run | **Ready** — latest `20260521T140000Z` **PASS** |
| V183 result | **0** `set_resolved` proposals |
| Execute | **BLOCKED** (UPC/GTIN gap + no eligible rows) |

## Migrations

Staging first; production **blocked**. View snapshot: `20260824120000_inventory_views_neda_snapshot_v180.sql` (V189 filter migration is separate later pack).

## Evidence

| Topic | Path |
|-------|------|
| V182 canonical | `history-canonical-rebuild-v182/20260518T120000Z/` |
| V183 | `history-v183/20260520T230000Z/` |
| V181 | `expected-inventory-neda-read-model-signoff-v181/20260521T120000Z/` |
| FBM dry-run | `return-items-fbm-aware-dry-run-v183/20260521T140000Z/` |
