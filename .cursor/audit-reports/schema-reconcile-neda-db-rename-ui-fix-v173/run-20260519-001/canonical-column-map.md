# Canonical column map (staging `eiqfaapyumhixxoeltgu`)

## Packages

| Legacy / UI alias | Staging canonical column | Notes |
|-------------------|--------------------------|-------|
| `package_number` | **`package_code`** | Renamed from `slip_id` (migration `20260511140000`) |
| `slip_id` | **`package_code`** | Same rename |
| `photo_url` (outer box) | **`outside_photo_urls`** | `text[]`, max 3 URLs |
| `photo_opened_url` | **`inside_photo_urls[0]`** | Interior / opened |
| `photo_return_label_url` | **`slip_photo_urls[0]`** | Slip / label scan |
| `photo_closed_url` | **`outside_photo_urls[1]`** | Second exterior slot when used |
| `manifest_photo_url` | **`slip_photo_urls[0]`** or **`manifest_url`** | Slip image + optional URL field |
| `photo_evidence` (JSONB) | *(absent on staging)* | Client mirror only; not selected/written |

## Pallets

| Legacy / UI alias | Staging canonical column | Notes |
|-------------------|--------------------------|-------|
| `photo_url` | **`pallet_photo_urls[0]`** | `text[]`, max 3 URLs |
| `bol_photo_url` | **`bol_photo_urls[0]`** | Bill of lading |
| `manifest_photo_url` | **`shipping_label_urls[0]`** | Manifest / shipping label scans |
| `photo_evidence` (JSONB) | *(absent on staging)* | Operator-mobile uses arrays |

## Return items (unchanged)

| Rule | Value |
|------|-------|
| Table name | **`return_items`** (never `returns`) |
| Forbidden | **`package_items`** |

## Exact answers (report-back)

- **Canonical package identifier column:** `package_code`
- **Canonical pallet overview image column:** `pallet_photo_urls` (array; first element is primary)
- **Canonical pallet BOL image column:** `bol_photo_urls` (array)
- **Canonical package outer-box image column:** `outside_photo_urls` (array)
