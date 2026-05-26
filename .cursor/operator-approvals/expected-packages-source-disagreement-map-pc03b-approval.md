# Expected Packages source disagreement map — PC03B approval

**Default:** not approved. Required before PC03B `product_identifier_map` inserts.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed write | INSERT `product_identifier_map` only for PC03 `map-bridge-preview.json` rows |
| Product creation | forbidden |
| `expected_packages` update | forbidden |
| Import FK remap | forbidden in this approval |
| Production / original | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_EXPECTED_PACKAGES_SOURCE_DISAGREEMENT_MAP_PC03B=true
```

## Preconditions

- [ ] PC03 reconcile plan reviewed: `pc03-expected-packages-source-disagreement-reconcile/20260523T010000Z/`
- [ ] Operator confirms recommended `product_id` per cluster (3 clusters, 6 map rows)
- [ ] No conflicting active map rows on same FNSKU/SKU with different `product_id`

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_EXPECTED_PACKAGES_SOURCE_DISAGREEMENT_MAP_PC03B=true
Approved by: Main/user (PC03B execute prompt)
UTC date: 2026-05-23
```
