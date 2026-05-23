# Slip rows + hydrate — staging E2E

| Check | Result |
|-------|--------|
| `listOperatorSlipContentsForPackageAction` wired | yes |
| `listOperatorPackageItemsForPackageAction` wired | yes |
| Staging slip_contents (fixture) | 2 rows |
| Staging return_items (fixture) | before=3, after=3 |
| Browser Expected Items | not confirmed |
| FNSKU resolve (`X004N9OS4J`) | single |

Server actions read `slip_contents` + `return_items` only (no `package_items`).
