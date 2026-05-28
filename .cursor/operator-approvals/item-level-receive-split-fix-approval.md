# Item-Level Receive Split Fix Approval

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by:
Approved at UTC:

APPROVED_TO_RUN_STAGING=true
APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX=true

## Scope

- Staging only (`eiqfaapyumhixxoeltgu`)
- Add minimal `return_items.expected_item_id` pointer to `expected_packages.id`
- Replace/bypass quantity-only receive split behavior for normal scanner receives
- Require one `return_items` row per physical scanned item
- Rewrite smoke to create physical item rows instead of qty-only calls
- Add reversible detach/move/reconcile plan for item edits/deletes

## Explicit exclusions

- [ ] No production / original (`kxsvedvpjldygtdbylsy`)
- [ ] No `return_items.quantity_entered`
- [ ] No `return_items.scanned_quantity`
- [ ] No product auto-create
- [ ] No `product_identifier_map.insert`
- [ ] No Amazon API / AI

## Sign-off

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX=true
Approved by:
UTC date:
Notes:
```
