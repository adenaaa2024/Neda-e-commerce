/**
 * Read-only check: PIM catalog facets brand count vs DB COUNT(DISTINCT brand).
 *
 * Run: npx tsx scripts/verify-pim-catalog-facets-brand-count.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or anon + org access).
 * Optional: PIM_FACETS_VERIFY_ORG_ID, PIM_FACETS_VERIFY_STORE_ID, PIM_FACETS_MIN_BRANDS (default 1278).
 */
import { createClient } from "@supabase/supabase-js";

import { collectPimCatalogFacets } from "../lib/pim-catalog-facets-collect";

const MIN_BRANDS = Number(process.env.PIM_FACETS_MIN_BRANDS ?? "1278");
const ORG = String(process.env.PIM_FACETS_VERIFY_ORG_ID ?? "").trim();
const STORE = String(process.env.PIM_FACETS_VERIFY_STORE_ID ?? "").trim();

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    console.log("[verify-pim-facets] SKIP — missing Supabase env (unable to verify staging brand count).");
    process.exit(0);
  }

  if (!ORG || !STORE) {
    console.log(
      "[verify-pim-facets] SKIP — set PIM_FACETS_VERIFY_ORG_ID and PIM_FACETS_VERIFY_STORE_ID to run count check.",
    );
    process.exit(0);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const collected = await collectPimCatalogFacets(client, ORG, STORE);
  if (!collected.ok) {
    console.error("[verify-pim-facets] FAIL —", collected.error);
    process.exit(1);
  }

  const brandCount = collected.facets.brands.length;
  console.log("[verify-pim-facets] brand facet count:", brandCount);
  console.log("[verify-pim-facets] rows scanned (brand pages):", collected.meta.brands_rows_scanned);

  if (brandCount >= MIN_BRANDS) {
    console.log(`[verify-pim-facets] OK — brand count >= ${MIN_BRANDS}`);
    process.exit(0);
  }

  console.error(`[verify-pim-facets] FAIL — expected at least ${MIN_BRANDS} brands, got ${brandCount}`);
  process.exit(1);
}

void main().catch((e) => {
  console.error("[verify-pim-facets] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
