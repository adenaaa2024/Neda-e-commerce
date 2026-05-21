# NEDA handoff index

**Last sync:** NEDA-FILE-SYNC-AND-HANDOFF-REPAIR-V185  
**Branch context:** Operator-mobile / scanner read models on staging (`eiqfaapyumhixxoeltgu`)

---

## Root handoff docs (prompts reference these)

| File | Purpose |
|------|---------|
| `NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md` | Slip/return_item `ProductLinkageDisplayContract` |
| `NEDA_EXPECTED_PACKAGES_INVENTORY_VIEWS_HANDOFF_V179.md` | EP + `v_inventory_item_status` UI reads |

---

## Contract libraries (source of truth over markdown)

| Path | Role |
|------|------|
| `lib/scanner/product-linkage-display-contract.ts` | Linkage display type + labels |
| `lib/scanner/expected-packages-read-contract.ts` | EP variance + linkage merge |
| `lib/scanner/operator-tracking-expectations.ts` | EP fetch + tracking snapshot |
| `lib/scanner/v-inventory-status.ts` | Inventory view reads |

---

## Verification scripts (by version)

| Script | Report folder |
|--------|---------------|
| `scripts/scanner-neda-16-backend-product-linkage-handoff.ts` | `scanner-neda-16-backend-product-linkage-handoff/` |
| `scripts/scanner-neda-17-expected-packages-inventory-views.ts` | `scanner-neda-17-expected-packages-inventory-views/` |
| `scripts/smoke-expected-packages-ui-wire-v179.ts` | (inline / paired audits) |
| `scripts/smoke-inventory-views-ui-wire-v180.ts` | (inline / paired audits) |
| `scripts/expected-inventory-neda-read-model-signoff-v181.ts` | `expected-inventory-neda-read-model-signoff-v181/` |
| `scripts/neda-env-staging-alignment-v180.ts` | `neda-env-staging-alignment-v180/` |
| `scripts/neda-env-staging-fix-verify-v183.ts` | `neda-env-staging-fix-verify-v183/` |
| `scripts/neda-operator-store-scope-fix-v184.ts` | `neda-operator-store-scope-fix-v184/` |
| `scripts/neda-operator-store-scope-probe-v184.ts` | (stdout probe; no report dir) |
| `scripts/neda-runtime-browser-proof-v184.ts` | `neda-runtime-browser-proof-v184/` |
| `scripts/neda-file-sync-and-handoff-repair-v185.ts` | `neda-file-sync-and-handoff-repair-v185/` |
| `scripts/neda-20-add-edit-item-resolver-consume-v191.ts` | `neda-20-add-edit-item-resolver-consume-v191/` |
| `scripts/neda-21-product-resolution-contract-enforce-all-ui-v192.ts` | `neda-21-product-resolution-contract-enforce-all-ui-v192/` |

Shared smoke helpers: `scripts/lib/neda-read-model-smoke-v181.ts`

---

## Prompt name → code aliases

| Prompt name | Actual symbol / path |
|-------------|----------------------|
| `fetchExpectedPackagesNedaRead` | `fetchExpectedPackagesForTracking` / `loadTrackingExpectationSnapshot` |
| `fetchInventoryItemStatusForNeda` | `fetchVInventoryStatusForScanCode` |
| `ProductLinkageDisplayBlock` | `OperatorProductLinkageMeta` component |
| `expected-packages-neda-read-contract.md` | `lib/scanner/expected-packages-read-contract.ts` |
| `neda-inventory-read-contract.md` | `lib/scanner/v-inventory-status.ts` |

Full map: `.cursor/audit-reports/neda-file-sync-and-handoff-repair-v185/<run_id>/alias-map.md`

---

## Baseline backend contract (v165)

`.cursor/audit-reports/scanner-backend-contract-sync-v165/run-20260518-001/neda-handoff.md`

---

## Hard constraints (all Neda tasks)

- No production DB
- No migrations / DDL apply from Neda agent
- No `package_items`, no `returns` table name
- No Amazon SP-API, no OpenAI from Neda verification scripts
- Staging only unless ENV-06 explicitly approved
