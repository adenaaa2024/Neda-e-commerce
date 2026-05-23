# Files fixed

| File | Change |
|------|--------|
| `lib/returns-canonical-photos.ts` | **NEW** — read/write map between legacy UI fields and staging array columns |
| `app/returns/returns-constants.ts` | `PACKAGE_LIST_SELECT`, `PACKAGE_MUTATION_SELECT`, `PALLET_LIST_SELECT` aligned to staging |
| `app/returns/actions.ts` | Normalize rows + map insert/update payloads to canonical columns |
| `app/returns/returns-action-types.ts` | Document canonical arrays + derived scalars |
| `app/returns/_components.tsx` | Client selects, create pallet arrays, gallery helpers |
| `lib/entity-photo-evidence.ts` | `palletPhotoEvidenceUrlsFromRow` / `resolvePackageClaimPhotoUrls` read arrays |
| `types/database.types.ts` | `PackagesRow` / `PalletsRow` match staging |
| `lib/scanner/product-linkage-display-contract.ts` | `ProductsLookupClient` type (build fix) |
| `app/scanner/operator-mobile/_components/operator-store-actions.ts` | Supabase cast + confidence coercion (build fix) |

## Intentionally unchanged

| Area | Reason |
|------|--------|
| `app/scanner/**` | Already on canonical columns (NEDA-13/14 PASS) |
| `return_items` / `slip_contents` selects | No drift detected on staging probe |
| Production DB | Hard constraint — staging only |
