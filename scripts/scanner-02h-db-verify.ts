/**
 * SCANNER-02H — read-only staging DB verification for manual UI smoke.
 * Run: npx tsx scripts/scanner-02h-db-verify.ts --run-id=20260517T092000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const RETURN_ROW = "f3a3ad84-4115-4cf2-8926-915434dc034a";
const SLIP_PACKAGE = "b59c36f0-2b93-4fb5-a49e-f9c192358d7c";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/scanner-02h", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: returnRow } = await sb
    .from("return_items")
    .select(
      "id, sku, asin, fnsku, store_id, identifier_resolution_status, resolved_product_id, identifier_resolution_confidence",
    )
    .eq("id", RETURN_ROW)
    .single();

  const { data: slips } = await sb
    .from("slip_contents")
    .select("id, fnsku, identifier_resolution_status, resolved_product_id")
    .eq("package_id", SLIP_PACKAGE)
    .order("fnsku");

  const { count: productCount } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);

  const payload = {
    run_id: runId,
    verified_at: new Date().toISOString(),
    staging_ref: stagingRef,
    return_row: returnRow,
    slip_contents: slips,
    product_count_org: productCount,
  };
  fs.writeFileSync(path.join(outDir, "db-verify-snapshot.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
