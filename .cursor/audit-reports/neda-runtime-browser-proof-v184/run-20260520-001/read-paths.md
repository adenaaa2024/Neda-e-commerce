# Runtime read paths (browser session)

| Surface | Runtime path |
|---------|----------------|
| expected_packages | `fetchExpectedPackagesForTracking` / `loadTrackingExpectationSnapshot` via server actions + client hydrate |
| inventory item status | `fetchVInventoryStatusForScanCode`, `fetchVInventoryItemStatusLinesExact` |
| scanner reads | `return_items` server actions (POST `/scanner/operator-mobile/scan`) |
| package drawer | `boxScanResolvedPkgBadge`, saved-box hub, item rows + `OperatorProductLinkageMeta` |

**API SAM baseline:** tracking `2954989706` on org `00000000-0000-0000-0000-000000000001`  
**Browser fixture scope:** org `7397edff-7994-4731-8501-55d258d507d2` (operator auth user store access)
