# Forbidden pattern scan

| Pattern | Gate `page.tsx` | `shipment-entry-lookup.ts` | Pass |
|---------|-----------------|----------------------------|------|
| Product resolver at gate | No resolver imports in `runIdentificationGateSearch` block (item phase still uses linkage elsewhere on page) | N/A | PASS |
| `package_items` table | Not referenced | Not referenced | PASS |
| `returns` table write | Not referenced in gate | Not referenced | PASS |
| Direct browser orphan EP write at gate | Unchanged (still session/actions on Continue) | N/A | PASS |
| `lookup` calls `products` | N/A | No `from("products")` | PASS |
| Item tier in gate lookup | N/A | `SHIPMENT_ENTRY_RESOLVE_ORDER` excludes `item` | PASS |
| Amazon / OpenAI | Not referenced | Not referenced | PASS |

## Note

`handleIdentifyMatchedStartWorkflow` still uses `resolveOperatorBarcode` with `only: "tracking"` or `"package"` or `"pallet"` on **Continue** — not product resolver. Item tier removed from default gate search.
