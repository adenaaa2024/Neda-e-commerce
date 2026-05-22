# Product auto-create governance V165 — Barcode display cache approval


**Scope:** Optional `products` INSERT from returns wizard Amazon mock cache lane only.

## Environment flag

| Variable | Default | Meaning |
|----------|---------|---------|
| `ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT` | **off** | Allow governed insert via `cacheBarcodeProductFromAmazonLookup` |

Set on server env (Vercel / `.env.local`). Not `NEXT_PUBLIC_*`.

## Does NOT authorize

- Resolver / save path product creation (still forbidden)
- Bulk product imports
- Production changes without separate deploy signoff
- Live Amazon SP-API (mock adapter unchanged)

## Operator signoff (staging enable)

```
APPROVED_TO_ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT=true
Environment: dev/staging only unless production charter says otherwise
Approved by:Maysam Ebrahimi
UTC date: 05/18/2026
Notes:
```
