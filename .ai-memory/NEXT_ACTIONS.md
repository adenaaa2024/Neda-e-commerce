# Neda — next actions (safe, UI-only)

**Updated:** V195 handoff sync (2026-05-21)  
**Do not:** run migrations, touch production, write DB from browser, add `package_items`, call Amazon SP-API or OpenAI from scripts

---

## When resuming Neda work

1. Read `NEDA_FINAL_BACKEND_HANDOFF_V193.md` and `.ai-memory/NEDA_HANDOFF.md` first.
2. Confirm `.env.local` points at staging `eiqfaapyumhixxoeltgu` (not `kxsvedvpjldygtdbylsy`).
3. Re-run verification:
   ```bash
   npx tsx scripts/neda-handoff-file-sync-and-usage-v195.ts
   npx tsx scripts/v194-neda-ui-polish-lookup-sync.ts
   ```

---

## Optional polish (no schema)

- Browser spot-check: package drawer product link → detail → back to package context.
- Returns table: confirm row click opens item drawer; product link does not steal row navigation.
- Re-run `neda-runtime-browser-proof-v184.ts` after env or auth changes.

---

## Blocked on operator (not Neda)

- Apply migration `20260717120000_scanner_product_linkage_columns.sql` on staging when approved.
- EP extended product columns (`identifier_resolution_status` on `expected_packages`) — remain absent by policy until migration.

---

## After backend changes

- Update `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md` from a new `product-id-linkage-closure` probe.
- Append script row to `.ai-memory/NEDA_HANDOFF.md` verification table.
