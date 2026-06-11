/**
 * PHASE-PRODUCT-LINKAGE-HARDENING — staging report + artifacts.
 *   npx tsx scripts/phase-product-linkage-hardening-report.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { fetchLinkageHealthSnapshot } from "../lib/product-linkage-health";
import {
  formatResolutionOrderExport,
  RESOLUTION_ORDER_OPERATIONAL,
  RESOLUTION_ORDER_SCANNER,
} from "../lib/product-linkage-resolution-policy";
import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";
import { createClient } from "@supabase/supabase-js";

const ORG = process.env.AUDIT_ORG_ID ?? "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase-product-linkage-hardening";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrlMatchesStagingRef(url)) {
    console.warn("Warning: not staging ref — report still runs read-only.");
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const snapshot = await fetchLinkageHealthSnapshot(supabase, ORG);
  const run_id = runId();
  const outDir = path.join(OUT_BASE, run_id);
  fs.mkdirSync(outDir, { recursive: true });

  const output = {
    prompt: "PHASE-PRODUCT-LINKAGE-HARDENING",
    run_id,
    resolution_order: {
      scanner: RESOLUTION_ORDER_SCANNER,
      operational_import: RESOLUTION_ORDER_OPERATIONAL,
      scanner_formatted: formatResolutionOrderExport("scanner"),
      operational_formatted: formatResolutionOrderExport("operational_import"),
    },
    unresolved_count: snapshot.unresolved_count,
    ambiguous_count: snapshot.ambiguous_count,
    duplicate_risks: snapshot.duplicate_risks,
    linkage_health: snapshot.linkage_health,
    operational_tables: snapshot.operational_tables,
    spine: snapshot.spine,
    SAFE_FOR_PRODUCT_STORY: snapshot.linkage_health.safe_for_product_story,
    modules_added: [
      "lib/product-linkage-identifier-normalize.ts",
      "lib/product-linkage-resolution-policy.ts",
      "lib/product-linkage-operational-resolve.ts",
      "lib/product-linkage-health.ts",
      "app/api/dashboard/products/linkage-health/route.ts",
    ],
    no_product_create: true,
  };

  fs.writeFileSync(path.join(outDir, "hardening-summary.json"), JSON.stringify(output, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ prompt: output.prompt, run_id, status: "PASS" }, null, 2),
  );

  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
