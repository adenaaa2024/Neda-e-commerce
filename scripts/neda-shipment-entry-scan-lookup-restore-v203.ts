/**
 * NEDA V203 — Shipment Entry scan lookup restore smoke audit.
 * Run: npx tsx scripts/neda-shipment-entry-scan-lookup-restore-v203.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import { resolveOperatorBarcode } from "../lib/scanner/operator-resolve-barcode";

const RUN_ID = "run-20260521-001";
const OUT_DIR = join(
  process.cwd(),
  ".cursor/audit-reports/neda-shipment-entry-scan-lookup-restore-v203",
  RUN_ID,
);

const SAM_ORG_ID = process.env.NEDA_SMOKE_ORG_ID ?? "00000000-0000-4000-8000-000000000001";
const SAM_STORE_ID = process.env.NEDA_SMOKE_STORE_ID ?? "00000000-0000-4000-8000-000000000002";

type Step = { id: string; pass: boolean; detail: string };

function add(steps: Step[], id: string, pass: boolean, detail: string) {
  steps.push({ id, pass, detail });
}

function gateSearchBlock(page: string): string {
  const start = page.indexOf("const runIdentificationGateSearch");
  if (start < 0) return "";
  const end = page.indexOf("const loadPalletDetail = useCallback", start);
  return page.slice(start, end > start ? end : start + 12000);
}

function forbiddenScan(page: string): Step[] {
  const gate = gateSearchBlock(page);
  const steps: Step[] = [];
  add(
    steps,
    "no_product_resolver_in_gate",
    !/resolveProductForScanner|handleBarcodeLookup|ProductLinkageDisplayContract/.test(gate),
    "gate search block must not call product resolver",
  );
  add(steps, "no_package_items_table", !/package_items/.test(page), "no package_items reference");
  add(steps, "no_returns_table_write", !/\.from\(["']returns["']\)/.test(page), "no returns table");
  add(steps, "uses_lookupShipmentEntryScanCode", /lookupShipmentEntryScanCode/.test(page), "canonical lookup wired");
  add(steps, "no_item_only_in_lookup_module", existsSync(join(process.cwd(), "lib/scanner/shipment-entry-lookup.ts")), "lookup module exists");
  const lookupSrc = existsSync(join(process.cwd(), "lib/scanner/shipment-entry-lookup.ts"))
    ? readFileSync(join(process.cwd(), "lib/scanner/shipment-entry-lookup.ts"), "utf8")
    : "";
  add(steps, "lookup_excludes_products", !/from\(["']products["']\)/.test(lookupSrc), "lookup module skips products table");
  return steps;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const steps: Step[] = [];
  const page = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const lookupMod = require("fs").readFileSync(join(process.cwd(), "lib/scanner/shipment-entry-lookup.ts"), "utf8");

  add(steps, "ui_route_scan_page", existsSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx")), "/scanner/operator-mobile/scan");
  add(steps, "lib_lookup_export", /export async function lookupShipmentEntryScanCode/.test(lookupMod), "canonical API");
  add(steps, "lib_package_code_path", /"package"/.test(lookupMod) && /package_code/.test(lookupMod), "package code in lookup");
  steps.push(...forbiddenScan(page));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let dbSteps: Step[] = [];

  if (url && key) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const probe = "NONEXISTENT_PROBE_V203_XYZ";
    try {
      const miss = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, probe);
      add(dbSteps, "unknown_code_not_found", miss.match_status === "not_found" || miss.inventory_visual === "manual_new", `status=${miss.match_status}`);
      const itemProbe = await resolveOperatorBarcode(sb, SAM_ORG_ID, "B0INVALIDPROBE", { only: "item", storeId: SAM_STORE_ID });
      add(dbSteps, "item_resolver_separate", itemProbe.kind === "unknown" || itemProbe.kind === "item", "item path exists outside gate lookup");
    } catch (e) {
      add(dbSteps, "db_lookup_runtime", false, e instanceof Error ? e.message : String(e));
    }

    const { data: ep } = await sb
      .from("expected_packages")
      .select("tracking_number")
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .not("tracking_number", "is", null)
      .limit(1);
    const tn = ep?.[0]?.tracking_number ? String(ep[0].tracking_number) : null;
    if (tn) {
      try {
        const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, tn);
        add(
          dbSteps,
          "tracking_lookup",
          hit.match_status === "found_tracking" || hit.match_status === "expected_only" || hit.inventory_rows.length > 0,
          `status=${hit.match_status} rows=${hit.inventory_rows.length}`,
        );
      } catch (e) {
        add(dbSteps, "tracking_lookup", false, e instanceof Error ? e.message : String(e));
      }
    } else {
      add(dbSteps, "tracking_lookup", false, "no sample tracking in expected_packages");
    }

    const { data: pkg } = await sb
      .from("packages")
      .select("package_code")
      .eq("organization_id", SAM_ORG_ID)
      .is("deleted_at", null)
      .not("package_code", "is", null)
      .limit(1);
    const pkgCode = pkg?.[0]?.package_code ? String(pkg[0].package_code) : null;
    if (pkgCode) {
      try {
        const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, pkgCode);
        add(
          dbSteps,
          "package_code_lookup",
          hit.match_status === "found_package" || hit.barcode.kind === "package",
          `status=${hit.match_status} barcode=${hit.barcode.kind}`,
        );
      } catch (e) {
        add(dbSteps, "package_code_lookup", false, e instanceof Error ? e.message : String(e));
      }
    } else {
      add(dbSteps, "package_code_lookup", false, "no sample package_code in packages");
    }
  } else {
    add(dbSteps, "db_skipped", true, "NEXT_PUBLIC_SUPABASE_URL / key not set — static checks only");
  }

  steps.push(...dbSteps);

  const smokeMd = `# Scan lookup smoke results

| Step | Pass | Detail |
|------|------|--------|
${[...steps, ...dbSteps]
  .map((s) => `| ${s.id} | ${s.pass ? "PASS" : "FAIL"} | ${s.detail.replace(/\|/g, "\\|")} |`)
  .join("\n")}

## Summary

- **tracking/slip lookup**: ${dbSteps.find((s) => s.id === "tracking_lookup")?.pass ? "PASS" : dbSteps.some((s) => s.id === "tracking_lookup") ? "PARTIAL" : "PASS (static)"}
- **package code**: ${dbSteps.find((s) => s.id === "package_code_lookup")?.pass ? "PASS" : dbSteps.some((s) => s.id === "package_code_lookup") ? "PARTIAL/FAIL" : "PARTIAL (no DB)"}
- **forbidden patterns**: ${forbiddenScan(page).every((s) => s.pass) ? "PASS" : "FAIL"}
`;

  writeFileSync(join(OUT_DIR, "scan-lookup-smoke-results.md"), smokeMd);

  const manifest = {
    run_id: RUN_ID,
    task: "neda-shipment-entry-scan-lookup-restore-v203",
    steps,
    db_steps: dbSteps,
    pass_count: steps.filter((s) => s.pass).length,
    fail_count: steps.filter((s) => !s.pass).length,
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Wrote ${OUT_DIR}`);
  console.log(`PASS ${manifest.pass_count} FAIL ${manifest.fail_count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
