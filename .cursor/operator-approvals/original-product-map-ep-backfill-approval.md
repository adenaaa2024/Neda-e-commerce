# Original — product_identifier_map + expected_packages backfill

**Default:** not approved.

| Field | Value |
|-------|--------|
| Target ref | `kxsvedvpjldygtdbylsy` |
| Branch | `feature/product-canonicalization-v3` |
| Dry-run evidence | `.cursor/audit-reports/original-product-map-expected-packages-backfill-dryrun/<run_id>/` |

## Preconditions

- [ ] `DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE` **PASS**
- [ ] Dry-run CSVs reviewed (Class A/B only for execute)
- [ ] Class C (product seed) explicitly excluded
- [ ] No product_name/title/OCR identity
- [ ] No staging row copy

## Allowed (execute prompt only)

- `UPDATE public.expected_packages` for Class **A** rows (existing map hit)
- `INSERT public.product_identifier_map` + `UPDATE expected_packages` for Class **B** rows (unique products.id, scoped org+store)
- Audit table per run

## Forbidden

- Product auto-create from title/OCR
- Blind staging→original copy
- Class C/D/E mutations in wave 1
- Claims / package_items schema changes

```text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PRODUCT_MAP_EP_BACKFILL=false
APPROVED_CLASS_A_EP_UPDATES=false
APPROVED_CLASS_B_MAP_INSERTS=false
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
```

## Sign-off

```
Approved by:
UTC date:
Notes:
```
