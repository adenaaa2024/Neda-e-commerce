# Database contract — canonical index

**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy` · **Future production:** NOT_CREATED_YET  
**Branch:** `feature/product-canonicalization-v2`

Domain detail lives in modular memory — this file is the **index + non-negotiable rules**.

| Topic | File |
|-------|------|
| Parity policy | [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) |
| Migrations | [MIGRATION_LEDGER.md](MIGRATION_LEDGER.md) |
| Product spine & unresolved counts | [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) |
| Packaging tables | [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md) — pilot **191** + W1 **50** + W2 **200** **CONFIRMED** both refs; **441** `dimensions_current` each |
| Claims | [CLAIMS_ENGINE_STATE.md](CLAIMS_ENGINE_STATE.md) |
| Views / Neda reads | [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md) |

## Product Resolution Contract — Non-Negotiable

```text
Manual/UI/API/import input
→ normalize identifiers
→ local product resolver first
→ products + product_identifier_map
→ gated backend enrichment only if no local match and gates allow
→ persist resolved_product_id only when deterministic
→ hydrate ProductLinkageDisplayContract
→ render same contract everywhere
```

**Applies to:** manual add/edit, scanner save, package/pallet children, return detail, expected packages, slip contents, imports, claims, Neda UI.

| Allowed | Forbidden |
|---------|-----------|
| Approved server actions | Direct browser Supabase writes for linkage/catalog |
| Resolver-on-save | UI `products.insert` / `products.upsert` |
| Governed scripts + rollback | `package_items` |
| Explicit unresolved/ambiguous/mismatch | Legacy `.from("returns")` for lines |
| `/pim/products/<id>` when resolved | Title/OCR/fuzzy/AI auto-link or auto-create |

**Guard:** `npm run check:product-resolution-contract-v192`

## Core tables

| Object | Contract |
|--------|----------|
| `products` | Canonical spine |
| `product_identifier_map` | ASIN/FNSKU/SKU/UPC/GTIN bridge |
| `return_items` | Canonical line table |
| `expected_packages` | Expected read layer |
| `slip_contents` | Slip-line source — governed promotion only |
| `packages` / `pallets` | Hierarchy; `package_code`, `slip_code` |

## Inventory views

| View | Contract |
|------|----------|
| `v_inventory_item_status` | Item-level; product columns + `package_code` filter |
| `v_inventory_status` | Package aggregate chip only |
| `v_scanned_items_counted` | Counts; active rows only (`deleted_at IS NULL`) |

## Forbidden / absent

| Name | Rule |
|------|------|
| `package_items` | Must not exist |
| `returns` (legacy) | Do not query for line data |
| Production mutation | Without explicit approval |
| Amazon API / AI | Unless separately approved |

## Evidence

`NEDA_FINAL_BACKEND_HANDOFF_V193.md` · `.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md` · `pc05f-wave2-original-verify/20260526T212000Z/` · `pc05d-packaging-backfill-scale-staging-plan/20260526T181000Z/`
