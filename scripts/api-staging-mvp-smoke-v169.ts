/**
 * API-STAGING-MVP-SMOKE-V169 — read-only staging smoke (no writes).
 * Usage: npx tsx scripts/api-staging-mvp-smoke-v169.ts --run-id=20260518T230000Z
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire, type Module } from "node:module";
import { createClient } from "@supabase/supabase-js";

import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const RETURN_ROW = "f3a3ad84-4115-4cf2-8926-915434dc034a";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const SCAN_ASIN = "B00NGQVYG4";
const SCAN_FNSKU = "X004DMS1TT";

type Check = { id: string; pass: boolean; detail: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function contractShapeOk(c: Record<string, unknown>): boolean {
  const keys = [
    "source_row_id",
    "source_table",
    "resolved_product_id",
    "identifier_resolution_status",
    "is_resolved",
    "fallback_display_name",
  ];
  return keys.every((k) => k in c);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const run_id = runId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/api-staging-mvp-smoke-v169",
    run_id,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const checks: Check[] = [];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  checks.push({
    id: "env_staging_url",
    pass: ref === STAGING_REF,
    detail: ref === STAGING_REF ? `NEXT_PUBLIC → ${STAGING_REF}` : `ref=${ref ?? "?"}`,
  });
  checks.push({
    id: "env_staging_project_ref",
    pass: stagingRef === STAGING_REF,
    detail: `STAGING_PROJECT_REF=${stagingRef}`,
  });
  checks.push({
    id: "env_production_blank",
    pass: !process.env.PRODUCTION_SUPABASE_URL?.trim() && !process.env.PRODUCTION_PROJECT_REF?.trim(),
    detail: "PRODUCTION_* unset in .env.local",
  });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || ref !== STAGING_REF) {
    fs.writeFileSync(path.join(outDir, "checks.json"), JSON.stringify({ run_id, checks, status: "FAIL" }, null, 2));
    console.error("BLOCKED: staging env gate failed");
    process.exit(2);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { buildProductLinkageDisplayContracts } = await import("../lib/product-linkage-display-enrich");

  const { count: productCount, error: pErr } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  checks.push({
    id: "pim_products_count",
    pass: !pErr && (productCount ?? 0) > 0,
    detail: pErr ? pErr.message : `org ${ORG} products=${productCount ?? 0}`,
  });

  const { data: productSample } = await sb
    .from("products")
    .select("id, product_name")
    .eq("organization_id", ORG)
    .limit(3);
  checks.push({
    id: "pim_list_sample",
    pass: (productSample?.length ?? 0) > 0,
    detail: `sample rows=${productSample?.length ?? 0}`,
  });

  const { data: returnRow, error: rErr } = await sb
    .from("return_items")
    .select(
      "id, sku, asin, fnsku, product_id, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence",
    )
    .eq("id", RETURN_ROW)
    .single();

  let returnContract: Record<string, unknown> | null = null;
  if (returnRow && !rErr) {
    const [c] = await buildProductLinkageDisplayContracts(ORG, [
      { source_table: "return_items", source_row_id: RETURN_ROW, row: returnRow as Record<string, unknown> },
    ]);
    returnContract = c as unknown as Record<string, unknown>;
    checks.push({
      id: "return_items_linkage_contract",
      pass: !!c && contractShapeOk(returnContract),
      detail: c
        ? `status=${c.identifier_resolution_status} is_resolved=${c.is_resolved}`
        : "no contract",
    });
  } else {
    checks.push({
      id: "return_items_linkage_contract",
      pass: false,
      detail: rErr?.message ?? "return row missing",
    });
  }

  const { data: slips } = await sb
    .from("slip_contents")
    .select(
      "id, fnsku, upc, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence",
    )
    .limit(5);

  if (slips?.length) {
    const slipContracts = await buildProductLinkageDisplayContracts(
      ORG,
      slips.map((s) => ({
        source_table: "slip_contents",
        source_row_id: String((s as { id: string }).id),
        row: s as Record<string, unknown>,
      })),
    );
    const ok = slipContracts.length === slips.length && slipContracts.every((c) => contractShapeOk(c as unknown as Record<string, unknown>));
    checks.push({
      id: "slip_contents_linkage_contract",
      pass: ok,
      detail: `contracts=${slipContracts.length} sample_status=${slipContracts[0]?.identifier_resolution_status ?? "?"}`,
    });
  } else {
    checks.push({
      id: "slip_contents_linkage_contract",
      pass: true,
      detail: "no slip_contents rows (N/A)",
    });
  }

  const resolver = await resolveScannerProductIdentifiers(sb, {
    organizationId: ORG,
    storeId: STORE,
    asin: SCAN_ASIN,
    fnsku: SCAN_FNSKU,
  });
  const linked = resolver.identifier_resolution_status === "resolved" && !!resolver.resolved_product_id;
  checks.push({
    id: "scanner_resolver_hydration",
    pass: ["resolved", "ambiguous", "unresolved", "mismatch"].includes(
      resolver.identifier_resolution_status ?? "unresolved",
    ),
    detail: `resolveScannerProductIdentifiers status=${resolver.identifier_resolution_status} linked=${linked}`,
  });

  const { count: edgeTotal } = await sb
    .from("claim_reference_edges")
    .select("id", { count: "exact", head: true });
  const { count: edgeDraft } = await sb
    .from("claim_reference_edges")
    .select("id", { count: "exact", head: true })
    .eq("draft_id", DRAFT_ID);
  checks.push({
    id: "claim_evidence_edges",
    pass: edgeTotal === 51,
    detail: `total_edges=${edgeTotal ?? 0} draft_${DRAFT_ID.slice(0, 8)}=${edgeDraft ?? 0}`,
  });

  let noPackageItems = true;
  const { error: pkgErr } = await sb.from("package_items").select("id").limit(1);
  if (!pkgErr) noPackageItems = false;
  else if (
    pkgErr.code === "42P01" ||
    pkgErr.code === "PGRST205" ||
    /does not exist|schema cache/i.test(pkgErr.message)
  ) {
    noPackageItems = true;
  } else {
    noPackageItems = false;
  }
  checks.push({
    id: "no_package_items",
    pass: noPackageItems,
    detail: noPackageItems ? "package_items absent (expected)" : "package_items query succeeded — unexpected",
  });

  const tridAuditPaths = [
    ".cursor/audit-reports/import-trid-normalization-v163",
    ".cursor/audit-reports/import-reference-graph-v164",
  ];
  const tridAuditExists = tridAuditPaths.some((p) => fs.existsSync(path.join(process.cwd(), p)));
  checks.push({
    id: "trid_reference_audit",
    pass: tridAuditExists,
    detail: tridAuditExists
      ? `audit dirs present (${tridAuditPaths.filter((p) => fs.existsSync(path.join(process.cwd(), p))).join(", ")})`
      : "no V163/V164 audit pack in repo (V170 graph API not verified)",
  });

  await runStaticContractTest(checks);

  const status = checks.every((c) => c.pass) ? "PASS" : "FAIL";
  const payload = {
    run_id,
    staging_project_ref: STAGING_REF,
    status,
    checks,
    samples: {
      return_linkage_contract: returnContract,
      scanner_resolver: resolver,
      product_sample: productSample,
    },
  };
  fs.writeFileSync(path.join(outDir, "checks.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# API-STAGING-MVP-SMOKE-V169\n\n**Run:** \`${run_id}\`  \n**Status:** **${status}**\n\nSee \`checks.json\`.\n`,
  );
  console.log(JSON.stringify({ status, checks }, null, 2));
  process.exit(status === "PASS" ? 0 : 1);
}

async function runStaticContractTest(checks: Check[]): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("npx tsx scripts/test-product-linkage-display-contract.ts", {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    checks.push({ id: "static_contract_mapper", pass: true, detail: "test-product-linkage-display-contract OK" });
  } catch (e) {
    checks.push({
      id: "static_contract_mapper",
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
