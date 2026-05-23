# Save path proof

Scanned units persist only via approved server actions:

| Action | Used |
|--------|------|
| `insertOperatorPackageItemAction` | yes |
| `listOperatorPackageItemsForPackageAction` | yes |
| `operatorReceiveItem` (EP path — avoid for BOX slip) | present (non-primary) |

**No** client `expected_packages` insert/update on scan page.
