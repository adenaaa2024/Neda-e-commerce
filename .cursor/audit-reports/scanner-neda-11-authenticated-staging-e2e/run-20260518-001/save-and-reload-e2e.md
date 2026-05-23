# Save + reload — staging E2E

| Item | Result |
|------|--------|
| `insertOperatorPackageItemAction` wired | yes |
| Browser Save unit clicked | no — headless run did not reach Items modal |
| Action parity insert (`insertReturn` payload) | yes — rolled back (`SCANNER_NEDA_11_DELETE_AFTER=true`) |
| return_items count delta | 3 → 4 → 3 (after rollback) |
| Reload hydrate (DB) | rows present |

Authenticated session drove **14× POST 200** on `/scanner/operator-mobile/scan` (slip list + package items hydrate).

Insert path: `insertOperatorPackageItemAction` → `insertReturn` → `return_items` (not `package_items`). Parity insert used when UI modal not reached; optional operator manual Save unit on device.
