/**
 * MAIN-SLIP-RETURN-ITEM-PRODUCT-LINKAGE-AUDIT-FIX — staging read-only census.
 * Usage: npx tsx scripts/slip-return-item-product-linkage-audit-readonly.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of require("node:fs").readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing Supabase env");

  const runId =
    process.env.SLIP_LINKAGE_AUDIT_RUN_ID?.trim() ||
    new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/slip-return-item-product-linkage-audit-fix",
    runId,
  );
  mkdirSync(outDir, { recursive: true });

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const slipRes = await sb
    .from("slip_contents")
    .select(
      "id, package_id, description, fnsku, upc, resolved_product_id, identifier_resolution_status",
      { count: "exact", head: false },
    )
    .not("description", "is", null)
    .limit(5000);

  const riRes = await sb
    .from("return_items")
    .select(
      "id, package_id, item_name, fnsku, sku, product_identifier, resolved_product_id, identifier_resolution_status, expected_item_id",
      { count: "exact", head: false },
    )
    .not("package_id", "is", null)
    .is("deleted_at", null)
    .limit(5000);

  const slips = Array.isArray(slipRes.data) ? slipRes.data : [];
  const ris = Array.isArray(riRes.data) ? riRes.data : [];

  const slipWithDesc = slips.filter((s) => String(s.description ?? "").trim());
  const slipResolved = slipWithDesc.filter((s) => String(s.resolved_product_id ?? "").trim());
  const slipDescNoLink = slipWithDesc.filter((s) => !String(s.resolved_product_id ?? "").trim());
  const riWithPkg = ris;
  const riResolved = riWithPkg.filter((r) => String(r.resolved_product_id ?? "").trim());
  const riNameNoLink = riWithPkg.filter(
    (r) =>
      !String(r.resolved_product_id ?? "").trim() &&
      String(r.item_name ?? "").trim() &&
      String(r.item_name ?? "").trim() !== "Scanned unit",
  );
  const riWithExpected = riWithPkg.filter((r) => String(r.expected_item_id ?? "").trim());

  const census = {
    run_id: runId,
    staging_url_ref: url.match(/https:\/\/([^.]+)\.supabase/)?.[1] ?? null,
    slip_contents_sampled: slips.length,
    slip_with_description: slipWithDesc.length,
    slip_resolved_product_id: slipResolved.length,
    slip_description_without_link: slipDescNoLink.length,
    return_items_sampled: riWithPkg.length,
    return_items_resolved: riResolved.length,
    return_items_item_name_without_link: riNameNoLink.length,
    return_items_with_expected_item_id: riWithExpected.length,
    slip_desc_no_link_sample: slipDescNoLink.slice(0, 8).map((s) => ({
      id: s.id,
      fnsku: s.fnsku,
      upc: s.upc,
      description: String(s.description ?? "").slice(0, 80),
      status: s.identifier_resolution_status,
    })),
  };

  writeFileSync(join(outDir, "staging-census.json"), JSON.stringify(census, null, 2));
  console.log(JSON.stringify(census, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
