# Forbidden contract scan — operator-mobile item-scan surface

**Surface files:**
- `app/scanner/operator-mobile/scan/page.tsx`
- `app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx`
- `app/scanner/operator-mobile/_components/operator-store-actions.ts`
- `app/scanner/operator-mobile/item-actions.ts`

| Forbidden pattern | Hits |
|-------------------|------|
| `package_items` | 0 |
| `.from("returns")` | 0 |
| `products.insert` | 0 |
| Direct browser Supabase writes (scan page item path) | 0 |

**Operator-mobile tree `package_items` refs:** 0

**Verdict:** **PASS** — zero forbidden usage in item-scan surface
