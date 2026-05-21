# Alias map (prompt path → repo path)

| Prompt / legacy name | Use instead | Notes |
|---------------------|-------------|-------|
| `expected-packages-neda-read-contract.md` | `lib/scanner/expected-packages-read-contract.ts` | NEDA-17 accepts lib fallback |
| `neda-inventory-read-contract.md` | `lib/scanner/v-inventory-status.ts` | NEDA-17 accepts lib fallback |
| `fetchExpectedPackagesNedaRead` | `lib/scanner/operator-tracking-expectations.ts` | fetchExpectedPackagesForTracking, loadTrackingExpectationSnapshot, enrichTrackingOperatorLinesWithProductLinkage |
| `fetchInventoryItemStatusForNeda` | `lib/scanner/v-inventory-status.ts` | fetchVInventoryStatusForScanCode, fetchVInventoryItemStatusLinesExact |
| `ProductLinkageDisplayBlock` | `app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx` | UI component for linkage badges |
| `scripts/neda-operator-store-scope-probe-v184.ts` | `scripts/neda-operator-store-scope-probe-v184.ts` | Probe-only; fix script is neda-operator-store-scope-fix-v184.ts |
