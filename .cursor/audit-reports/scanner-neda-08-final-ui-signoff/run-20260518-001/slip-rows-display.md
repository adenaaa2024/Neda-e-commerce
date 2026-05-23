# Slip rows display

## Fixture

| Field | Value |
|-------|-------|
| `package_id` | `9528d923-3d27-4aed-a773-095b5028743d` |
| `slip_contents` rows | **2** |
| Select chain | Fallback attempt **4** (minimal columns + `slip_code`) |

## UI path

- `listOperatorSlipContentsForPackageAction` in `operator-store-actions.ts`
- `itemInspectionSlipLines` / slip visual state in `scan/page.tsx`
- Barcode match via `resolveItemBarcodeAgainstSlipRows` (`lib/scanner/operator-slip-item-resolve.ts`)

## Probe

`slip_rows_on_fixture` + `slip_contents_display_select` in `probe-output.json`.

## Conclusion

**PASS** — slip lines load for fixture package; operator fallback select succeeds on live DB.
