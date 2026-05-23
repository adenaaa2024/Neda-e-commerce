# Expected vs existing file map

**Run:** run-20260520-001  
**Branch inventory:** 15 present, 0 missing, 6 aliases

| Expected path | Status | Actual / notes |
|---------------|--------|----------------|
| `NEDA_EXPECTED_PACKAGES_INVENTORY_VIEWS_HANDOFF_V179.md` | **PRESENT** | NEDA_EXPECTED_PACKAGES_INVENTORY_VIEWS_HANDOFF_V179.md  |
| `NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md` | **PRESENT** | NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md  |
| `.ai-memory/NEDA_HANDOFF.md` | **PRESENT** | .ai-memory/NEDA_HANDOFF.md  |
| `.ai-memory/DATABASE_CONTRACT.md` | **PRESENT** | .ai-memory/DATABASE_CONTRACT.md  |
| `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md` | **PRESENT** | .ai-memory/PRODUCT_ID_MAPPING_STATUS.md  |
| `lib/scanner/expected-packages-read-contract.ts` | **PRESENT** | lib/scanner/expected-packages-read-contract.ts  |
| `lib/scanner/operator-tracking-expectations.ts` | **PRESENT** | lib/scanner/operator-tracking-expectations.ts  |
| `lib/scanner/v-inventory-status.ts` | **PRESENT** | lib/scanner/v-inventory-status.ts  |
| `lib/scanner/product-linkage-display-contract.ts` | **PRESENT** | lib/scanner/product-linkage-display-contract.ts  |
| `scripts/neda-env-staging-fix-verify-v183.ts` | **PRESENT** | scripts/neda-env-staging-fix-verify-v183.ts  |
| `scripts/neda-runtime-browser-proof-v184.ts` | **PRESENT** | scripts/neda-runtime-browser-proof-v184.ts  |
| `scripts/neda-operator-store-scope-fix-v184.ts` | **PRESENT** | scripts/neda-operator-store-scope-fix-v184.ts  |
| `scripts/smoke-expected-packages-ui-wire-v179.ts` | **PRESENT** | scripts/smoke-expected-packages-ui-wire-v179.ts  |
| `scripts/smoke-inventory-views-ui-wire-v180.ts` | **PRESENT** | scripts/smoke-inventory-views-ui-wire-v180.ts  |
| `scripts/neda-env-staging-alignment-v180.ts` | **PRESENT** | scripts/neda-env-staging-alignment-v180.ts  |
| `expected-packages-neda-read-contract.md` | **ALIAS** | lib/scanner/expected-packages-read-contract.ts — Optional markdown; lib is canonical |
| `neda-inventory-read-contract.md` | **ALIAS** | lib/scanner/v-inventory-status.ts — Optional markdown; lib is canonical |
| `scripts/neda-operator-store-scope-probe-v184.ts` | **ALIAS** | scripts/neda-operator-store-scope-probe-v184.ts — Read-only companion to neda-operator-store-scope-fix-v184.ts |
| `fetchExpectedPackagesNedaRead` | **ALIAS** | fetchExpectedPackagesForTracking / loadTrackingExpectationSnapshot — lib/scanner/operator-tracking-expectations.ts |
| `fetchInventoryItemStatusForNeda` | **ALIAS** | fetchVInventoryStatusForScanCode — lib/scanner/v-inventory-status.ts |
| `ProductLinkageDisplayBlock` | **ALIAS** | OperatorProductLinkageMeta — app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx |

## Handoff-ready

**YES** — docs + libs + scripts present; build=true; tsc=true; stale=true
