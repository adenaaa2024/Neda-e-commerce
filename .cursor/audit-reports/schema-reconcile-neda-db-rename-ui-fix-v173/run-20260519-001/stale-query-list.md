# Stale query list (pre-fix)

## PostgREST SELECT strings (caused 42703 at runtime)

| Location | Stale columns | Impact |
|----------|---------------|--------|
| `app/returns/returns-constants.ts` `PACKAGE_LIST_SELECT` | `photo_url`, `photo_return_label_url`, `photo_opened_url`, `photo_closed_url`, `manifest_photo_url` | `listPackages` / package drawer load **FAIL** |
| `app/returns/returns-constants.ts` `PACKAGE_MUTATION_SELECT` | above + `photo_evidence` | create/update package **FAIL** |
| `app/returns/returns-constants.ts` `PALLET_LIST_SELECT` | `photo_url`, `bol_photo_url`, `manifest_photo_url` | `listPallets` **FAIL** |
| `app/returns/_components.tsx` (client hydrate) | `photo_url`, `bol_photo_url`, `manifest_photo_url` on `pallets` | item wizard pallet gallery **FAIL** |
| `app/returns/_components.tsx` (client hydrate) | `photo_opened_url`, `photo_return_label_url`, `photo_closed_url`, `photo_url` on `packages` | inherited box photos **FAIL** |
| `app/returns/_components.tsx` (package edit) | `photo_evidence` on `packages` | edit drawer reconcile **FAIL** |

## Server write paths (would 42703 on insert/update)

| Location | Stale payload keys |
|----------|-------------------|
| `app/returns/actions.ts` `createPallet` / `updatePallet` | `photo_url`, `bol_photo_url`, `manifest_photo_url` |
| `app/returns/actions.ts` `createPackage` / `updatePackage` | legacy package photo scalars, `photo_evidence` |

## Not stale (fallback reads only — no SELECT)

| Location | Note |
|----------|------|
| `app/returns/actions.ts` `normalizePackageRow` | `package_number` / `slip_id` fallbacks for inbound JSON only |
| `app/scanner/operator-mobile/scan/page.tsx` | same fallbacks in display strings |

## Scanner (already canonical)

| Surface | Status |
|---------|--------|
| `operator-store-actions.ts` package selects | Uses `package_code`, `*_photo_urls` arrays |
| `operator-store-actions.ts` pallet selects | Uses `pallet_photo_urls`, `bol_photo_urls`, `shipping_label_urls` |

## Forbidden contract (unchanged — PASS)

- No `package_items` under `app/`
- No `.from("returns")` under `app/`
- No `products.insert` under `app/`
