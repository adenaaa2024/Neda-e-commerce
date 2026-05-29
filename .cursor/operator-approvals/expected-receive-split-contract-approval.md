# Expected receive split contract (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` (workspace-linked) |
| Production / original | forbidden unless separate approval |
| Prerequisite plans | Grouped allocation execute PASS; carrier normalization PASS |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_EXPECTED_RECEIVE_SPLIT_CONTRACT=true
```

## Scope (when approved)

1. **Migration** — additive columns on `expected_packages` for receive allocation lineage; new `build_source = receive_allocated`; partial unique index for allocated rows; rebuild exclusion rules.
2. **DB function** — `allocate_expected_package_on_receive(...)` transactional split (idempotent).
3. **Server integration** — wrap `operatorReceiveItem` (and optionally unify with `insertOperatorPackageItemAction`) to call split before `return_items` insert; populate `return_items.expected_item_id`.
4. **Contract probes** — per-family qty conservation, no double-count, overage handling.
5. **No** Amazon API; **no** product auto-create.

## Explicit exclusions

- No production writes without new approval
- No silent merge of distinct slips/packages into one EP row
- Do not run full `rebuild_expected_packages_from_removals` without receive-row preservation rules

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_EXPECTED_RECEIVE_SPLIT_CONTRACT=true
Approved by: Maysam Ebrahimi
UTC date: 05282026
```
