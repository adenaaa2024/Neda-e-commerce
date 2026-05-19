# Hydrate boxes / slip lines

## Server actions (unchanged exports, new backend)

- `listOperatorSlipContentsForPackageAction` — slip lines for UI
- `listOperatorPackageItemsForPackageAction` — scanned units from `return_items`, slip barcode match

## Fixture hydration (`package_id` 9528d923…)

| Source | Count | Error |
|--------|-------|-------|
| `slip_contents` | 2 | none |
| `return_items` | 0 | none |

## UI expectation (items phase, no prior scans)

- Slip rows show **Awaiting** (per neda-03 validation checklist).
- No migration / `package_items` toast.

## Conclusion

**PASS** for slip + empty return_items hydration on fixture package.
