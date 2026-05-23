# Forbidden pattern scan

Scanned `app/scanner/**` and `app/returns/**`.

| Pattern | Hits | Allowed |
|---------|------|---------|
| package_items | 0 | 0 |
| .from("returns") | 0 | 0 |
| products.insert | 0 | 0 |
| client return_items write (scan/returns UI) | 0 | 0 |
| client products.select (scanner tree) | 0 | 0 |

**Note:** `scan/page.tsx` may `insert` **pallets** client-side for shipment receiving — not `return_items` / `package_items`.
