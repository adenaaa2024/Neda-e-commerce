# Runtime errors — before / after

## Before (reported + reproduced on staging)

| Surface | Error |
|---------|-------|
| Returns → Packages list | `packages.package_number does not exist` *(via list select including dropped `photo_url` etc.; user report cited package_number)* |
| Returns → Pallets list | `pallets.photo_url does not exist` |
| Package list server action | `column packages.photo_url does not exist` (full `PACKAGE_LIST_SELECT`) |
| Pallet list server action | `column pallets.photo_url does not exist` (full `PALLET_LIST_SELECT`) |

## After (staging PostgREST probe)

| Probe | Result |
|-------|--------|
| `PACKAGE_LIST_SELECT` (updated) | **OK** |
| `PALLET_LIST_SELECT` (updated) | **OK** |
| `packages.package_number` alone | Still **MISSING** (expected — never re-added) |
| `pallets.photo_url` alone | Still **MISSING** (expected) |

## UI runtime (not browser-tested this run)

Server list actions should load once app is deployed; full Returns page smoke pending operator session.
