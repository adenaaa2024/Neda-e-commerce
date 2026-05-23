# NEDA backend product linkage handoff (V178)

**Owner:** Neda  
**Audit:** `scanner-neda-16-backend-product-linkage-handoff`  
**Status:** Consume-only — no migrations, no `products.insert`, no Amazon/OpenAI

---

## Goal

Wire operator-mobile slip lines, item modal, and package hydrate to **server-built** `ProductLinkageDisplayContract` — never client catalog queries or EP product columns.

---

## Canonical contract

| Artifact | Path |
|----------|------|
| Display contract type + builders | `lib/scanner/product-linkage-display-contract.ts` |
| UI meta block | `app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx` |
| Server actions | `app/scanner/operator-mobile/_components/operator-store-actions.ts` |

### Display states

| State | Label | Source |
|-------|-------|--------|
| Resolved | `productLinkagePrimaryLabel` → catalog name | `resolved_product_id` + `fetchProductNamesByResolvedIds` |
| Unresolved | **No product link yet** | `PRODUCT_LINKAGE_UNMAPPED_LABEL` |
| Ambiguous | **Needs review** | `PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL` |

Linkage columns live on **`return_items`** and **`slip_contents`** only — not on live `expected_packages` (see v167 policy).

---

## Surfaces to wire

| Surface | Read path | Contract field |
|---------|-----------|----------------|
| Scan page slip rows | `listOperatorSlipContentsForPackageAction` | `product_linkage` per row |
| Slip line picker | `productLinkageForSlipMatch` + shared meta | same |
| Item inspection modal | `productLinkage` prop on `ItemUnitRecordModal` | same |
| Package item hydrate | `listOperatorPackageItemsForPackageAction` | per unit row |

---

## Save path (approved)

- **Insert units:** `insertOperatorPackageItemAction` → `return_items` (not `package_items`, not `operatorReceiveItem` on BOX slip scan)
- **No** client `supabase.from(...).insert` on scan page
- **No** `products.insert` from scanner surfaces

---

## Forbidden (do not reintroduce)

- `package_items` table references
- `.from("returns")` — use `RETURN_ITEMS_TABLE` / `return_items`
- `expected_packages.identifier_resolution_status` SELECT for UI badges
- Product auto-create from OCR/title

See `.ai-memory/DATABASE_CONTRACT.md` and `.cursor/audit-reports/scanner-backend-contract-sync-v165/run-20260518-001/forbidden-old-contracts.md`.

---

## Verification scripts

```bash
npx tsx scripts/scanner-neda-16-backend-product-linkage-handoff.ts
npx tsx scripts/smoke-expected-packages-ui-wire-v179.ts   # EP panels only
```

**Prerequisite:** PASS run under `.cursor/audit-reports/scanner-neda-15-product-id-ui-final-wiring/`

---

## Staging fixture (read probes)

| Field | Value |
|-------|-------|
| Package id | `9528d923-3d27-4aed-a773-095b5028743d` |
| Org | `00000000-0000-0000-0000-000000000001` |
| Store (Sam) | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |

---

## Related memory

- `.ai-memory/NEDA_HANDOFF.md` — index of audits and scripts
- `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md` — column/migration status
