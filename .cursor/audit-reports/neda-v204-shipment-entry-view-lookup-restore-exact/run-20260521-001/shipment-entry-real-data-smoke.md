# Shipment Entry real-data smoke (staging)

**Ref:** `eiqfaapyumhixxoeltgu`  
**Org:** `00000000-0000-0000-0000-000000000001`  
**Store:** `509ee1f6-622c-46a5-8110-7b889ba46c2c`

| Test | Pass | Detail |
|------|------|--------|
| unknown_off_manifest | PASS | found=false manifest=off_manifest |
| no_item_in_gate_lookup | PASS | item resolver separate (kind=unknown) |
| known_tracking | PASS | status=found_tracking manifest=partially_scanned rows=1 |
| known_slip | FAIL | no sample id_slip_contents |
| known_package_code | PASS | status=found_package barcode=package |
| known_pallet | PASS | status=found_pallet barcode=pallet |
| expected_only | PASS | status=found_tracking |
| already_scanned | FAIL | no scanned sample |

## Samples used
```json
{
  "tracking": "2954989706",
  "slip": null,
  "package_code": "PKG-MNI9DR05",
  "pallet": "PLT-20260402-653"
}
```
