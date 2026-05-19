# Next step recommendation

## 1. Apply scanner linkage migration (operator approval required)

Apply `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` to `kxsvedvpjldygtdbylsy` (staging first).

Then re-run:

```powershell
npx tsx scripts/product-id-linkage-closure-v167-probe.ts
```

Expect all extended SELECT probes to PASS.

## 2. Staging E2E with known bridge row

Pick org/store where `product_identifier_map` has the smoke FNSKU (`X004N9OS4J` or successor). Scan one item and one slip line; confirm:

- `return_items.resolved_product_id` non-null
- `identifier_resolution_status` = `resolved`
- `identifier_resolution_source` persisted (e.g. `fnsku`, `product_identifier_map`)

## 3. Optional: deploy `v_product_identity`

If reporting or imports need unified REST reads, apply `20260630_v_product_identity.sql` in a separate approved changeset.

## 4. Align types after schema PASS

Regenerate or trim `types/database.types.ts` / `returns-action-types.ts` optional fields so TypeScript matches live columns (reduces false confidence in IDE).

## 5. Production

Only after staging probe PASS + operator sign-off. Do not run production from this audit.

---

**Related audits:** `scanner-neda-02-schema-probe/run-20260518-001`, `scanner-backend-contract-sync-v165/run-20260518-001`, `scanner-02c-confirm-staging-apply-verify/run-20260518-001`.
