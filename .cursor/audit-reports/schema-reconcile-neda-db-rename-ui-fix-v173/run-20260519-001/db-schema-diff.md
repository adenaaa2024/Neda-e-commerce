# DB schema diff — staging vs app (before reconcile)

**Source:** Live PostgREST probes on `https://eiqfaapyumhixxoeltgu.supabase.co` (service role, 2026-05-19).

## `packages` — dropped on staging (still in old migrations / TS types)

| Column | Staging |
|--------|---------|
| `package_number` | **MISSING** |
| `slip_id` | **MISSING** |
| `photo_url` | **MISSING** |
| `photo_return_label_url` | **MISSING** |
| `photo_opened_url` | **MISSING** |
| `photo_closed_url` | **MISSING** |
| `manifest_photo_url` | **MISSING** |
| `photo_evidence` | **MISSING** |
| `shipping_label_urls` | **MISSING** |

## `packages` — present on staging

| Column | Staging |
|--------|---------|
| `package_code` | OK |
| `id_slip_contents` | OK |
| `outside_photo_urls` | OK |
| `inside_photo_urls` | OK |
| `slip_photo_urls` | OK |
| `manifest_url` | OK |
| `manifest_data` | OK (used in mutation select) |

## `pallets` — dropped on staging

| Column | Staging |
|--------|---------|
| `photo_url` | **MISSING** |
| `bol_photo_url` | **MISSING** |
| `manifest_photo_url` | **MISSING** |
| `photo_evidence` | **MISSING** |

## `pallets` — present on staging

| Column | Staging |
|--------|---------|
| `pallet_photo_urls` | OK |
| `bol_photo_urls` | OK |
| `shipping_label_urls` | OK |

## Prisma

No `schema.prisma` in repo; migrations under `supabase/migrations/` document historical shapes only.
