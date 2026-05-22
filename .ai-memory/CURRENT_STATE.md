# Current state — V196 closeout + V202 proof (authoritative)

**Last updated:** 2026-05-22 (`expected-packages-identifier-manual-review-batch-v202` `20260522T220000Z`)  
**V196 history:** [HISTORY_POINTERS.md](HISTORY_POINTERS.md) →  
`.cursor/audit-reports/history-v196/20260522T230000Z/ERP_PIM_FULL_HISTORY_V196_APPEND_ONLY_LOOKUP_EXPECTED_VENDOR_PACKAGING_ROADMAP.md`  
**Latest browser proof:** `product-linkage-browser-proof-signoff-v202/20260522T195000Z/` (**PASS** 11/11)  
**Neda handoff:** [`NEDA_FINAL_BACKEND_HANDOFF_V193.md`](../NEDA_FINAL_BACKEND_HANDOFF_V193.md)

## Milestone — V196/V197 planning + proof (this closeout)

| Gate | Status |
|------|--------|
| V196 lookup item_name/UPC/ambiguous fix | **PASS** code; ambiguous collapse; UPC field; picker UI |
| V196 lookup browser proof (V196 harness) | **CONDITIONAL_PASS** — auth only; superseded by V200/V202 **PASS** |
| V196 expected API/manual plan | **PASS** plan — V199 review + V201 triage + API dry-run gates |
| V196 vendor 1883 plan | **PASS** plan — supplier code, not category; allowlist + display name path |
| V196 packaging model plan | **PASS** plan — `packaging_level` + `fulfillment_context`; DDL deferred V201 |
| V197 product linkage census | **PASS** — 20 tables ranked; expected_packages top unresolved |
| V198 E1B map-only execute | **BLOCKED** — orphan import `product_id`; closed in V200 |
| Product resolution contract | **LOCKED** — guard **PASS** |

## Subsequent (after V196 closeout — operator state)

| Gate | Status |
|------|--------|
| V200 E1B blocker materialize + map | **PASS** — E1B cohort closed |
| Expected read-layer (current) | **1,577 / 1,626**; **49** unresolved; **6** ambiguous (V201) |
| V202 browser proof signoff | **PASS** — supersedes V196 CONDITIONAL_PASS |
| V195 original view parity | **APPLIED_VERIFIED** on `kxsvedvpjldygtdbylsy` |

## Environment topology

| Surface | DB ref |
|---------|--------|
| Staging / local / Preview / Neda | `eiqfaapyumhixxoeltgu` |
| Original (Vercel Production app) | `kxsvedvpjldygtdbylsy` |
| Future production project | **NOT_CREATED_YET** / **BLOCKED** |

## Lookup (V196)

- Ambiguous: duplicate map rows sharing one `product_id` resolve (not false ambiguous).
- Lookup returns UPC/GTIN, canonical `item_name`, `ambiguous_candidates[]`.
- UI: `AmbiguousProductPicker`, `IdentifierStack` UPC row.
- Save unchanged: `insertReturn` / `updateReturn` resolver-on-save.

## Expected packages (plan status at V196 closeout)

| Bucket | Rows (V199/V201 era) | Status |
|--------|---------------------:|--------|
| Read-layer resolved (post-E2) | 1,546 | at V199 review |
| Unresolved | 80 → **52** after V200 E1B | triage ongoing |
| API evidence execute V202 | **FAIL** (catalog 404) — 3 SP-API calls, 0 inserts (`20260522T210000Z`) |
| API evidence dry-run V202 | **READY** — 5 would call, 3 skip linked (`20260522T200000Z`) |
| Manual identifier batch V202 | 38 + 5 API 404 | **PASS** queue (`20260522T220000Z`) — all 38 → quarantine/fix source; 0 map-bridge |
| Source disagreement | 6 | manual reconcile |
| E1B map-missing | 28 | blocked V198; **closed V200** |

## Vendor 1883 decision

- **630** products under vendor code `1883` (1883 MAISON ROUTIN + mixed brands).
- Not invalid category data — PIM numeric-label audit false positive.
- Plan: allowlist + `display_name` / alias; optional split for **171** mixed-brand rows.

## Packaging model decision

Composite profile key:

- `organization_id` + `store_id` + `product_id`
- **`packaging_level`**: `unit`, `inner_pack`, `case`, `master_carton`
- **`fulfillment_context`**: FBA / MFN / wholesale (and governed enums)

Tables (plan only): `product_packaging_profiles`, `product_packaging_profile_versions`, `product_dimensions_current`.  
DDL staging plan: **V201** (not applied in V196).

## Roadmap — next 3 days (V196)

| Day | Focus |
|-----|--------|
| **Day 1** | Product linkage: V196 lookup landed, V197 census, V199 expected classification |
| **Day 2** | Vendor 1883 + packaging architecture; E1B spine repair; API dry-run prep |
| **Day 3** | Claims scoping; gated API path; TRID/reference graph entry |

## Next phase (claims / API / TRID / catalog)

1. **Claims** — cleanup / regeneration (governed)  
2. **Manual / source queues** — operator CSV at `expected-packages-identifier-manual-review-batch-v202/20260522T220000Z/`; fix UNKNOW/ASIN-in-FNSKU before map/E2; 6 source disagreement next  
3. **TRID / reference graph** — after product linkage stable  
4. **Product catalog** — E1B closed; remaining 52 + AFI/spine waves  
5. **Packaging DDL V201** — approval-gated staging apply  
6. **AI layer** (later; default deny)

## Carried gates

| Gate | Status |
|------|--------|
| `package_items` | **FORBIDDEN** |
| Legacy `returns` | **FORBIDDEN** |
| Claims staging | **72.7%** / **51.5%** |

## Evidence

`history-memory-v196-closeout/20260522T230000Z/` · `v196-item-name-upc-ambiguous-lookup-fix/20260519T223000Z/` · `v196-vendor-category-cleanup-1883-plan/20260521T214500Z/` · `v197-product-linkage-table-census/20260522T120000Z/` · `v199-expected-identifier-ambiguous-review-pack/20260522T130000Z/` · `product-linkage-browser-proof-signoff-v202/20260522T195000Z/`
