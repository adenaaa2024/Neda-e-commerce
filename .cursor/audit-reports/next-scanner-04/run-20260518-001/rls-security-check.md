# RLS security check (NEXT-SCANNER-04)

## Live RLS matrix test

**Not run** — environment not confirmed dev/staging; no anon/authenticated session fixtures in this audit.

## Static checks (pass)

### Manual override

- `assertRowOrgAccess(actor_profile_id, orgId)` before update.
- Product lookup: `.eq("organization_id", orgId).eq("store_id", storeId)` — rejects product from another store/org.

### Drawer product picker (client)

- `supabaseBrowser.from("products")` filtered by `organization_id`, `store_id`, and `sku` — relies on RLS for tenant isolation in production; server override uses service role with explicit org/store match.

### Service role usage

- E2E probe script uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS) — acceptable for controlled staging scripts only; not used in operator UI path for override (server action uses `supabaseServer` with same explicit filters).

## Recommended post-gate checks

1. Operator A cannot override return item in org B (403 / error from `assertRowOrgAccess`).
2. Override with product UUID from another store → `"Product not found for this organization and store."`
3. Browser client product list returns only tenant-visible `products` under anon/authenticated policies.

## Product creation / merge

**No code path in manual override or scanner enrichment creates or merges products** (static review; live count check deferred to `--write-test` after gate).
