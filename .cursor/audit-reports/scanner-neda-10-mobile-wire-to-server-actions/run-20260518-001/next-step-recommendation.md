# Next step recommendation

1. **Operator session spot-check** — One matched FNSKU save on `/scanner/operator-mobile/scan` with live cookies (confirms RLS on `insertOperatorPackageItemAction`).
2. **Staging clone (ENV-06)** — Re-run this script against staging after contract clone.
3. **Optional** — Extend `listOperatorPackageItemsForPackageAction` select with product_match_status if mismatch chips on slip cards are required (additive read only).
