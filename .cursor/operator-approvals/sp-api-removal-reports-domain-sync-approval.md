# SP-API removal reports domain sync (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden |
| Product create from title only | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC=true
```

## Scope

- Phase 2 staging → Phase 3 sync for SP-API synthetic `REMOVAL_ORDER` + `REMOVAL_SHIPMENT` uploads
- Phase 4 generic (shipment upload): `rebuild_shipment_tree_from_removal_shipments` + enrichment patch
- `rebuild_expected_packages_from_removals(org, store)` after domain sync
- Resolve `product_id` read-only where possible; queue promotion plan only for missing products
- No `products.insert` / no `product_identifier_map.insert` in this execute pass

## Preconditions

- SP-API fetch execute PASS with `synthetic_upload_ready` for both report types
- Allocation fix verify PASS recommended before rebuild (see removal-rebuild-allocation-fix)

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
```
