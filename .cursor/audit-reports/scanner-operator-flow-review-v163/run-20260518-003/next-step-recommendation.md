# Next step recommendation

## For Neda (UX)

1. **Approve UI-1 + UI-3 + UI-4** for the next small operator-mobile PR—biggest clarity per line of diff on the item list.
2. **Train operators** on two “unknown” paths: shipment-level (unknown modal / create box) vs unit-level (off-slip / unexpected).
3. **Optional device pass** — one real wedge session on `/scanner/operator-mobile/scan` confirming post-save count tick and over-scan warning (complements this static review).

## For engineering

1. Implement **low-risk UI-only** items from `low-risk-ui-improvements.md` in a dedicated PR (no DB).
2. If mismatch-on-slip is required, open a **separate** tiny PR adding `product_match_status` / `product_review_required` to existing `listOperatorPackageItemsForPackageAction` select (additive read only—not a migration).
3. Do **not** reintroduce `package_items` or resolver changes.

## Artifacts

Run folder: `.cursor/audit-reports/scanner-operator-flow-review-v163/run-20260518-003/`
