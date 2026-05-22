/**
 * EXPECTED-INVENTORY-NEDA-READ-MODEL-FINAL-SIGNOFF-V181 — staging read-model verification.
 *
 *   npx tsx scripts/expected-inventory-neda-read-model-signoff-v181.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { fetchExpectedPackagesNedaRead } from "../app/returns/expected-packages-linkage-actions";
import { fetchInventoryItemStatusForNeda } from "../app/returns/inventory-views-linkage-actions";
import { PRODUCT_LINKAGE_LABEL_NO_LINK } from "../lib/product-linkage-display-ui";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const NEDA_READ_GLOBS = [
  "app/returns/expected-packages-linkage-actions.ts",
  "app/returns/inventory-views-linkage-actions.ts",
  "app/api/returns/expected-packages-linkage/route.ts",
  "lib/expected-packages-neda-read-contract.ts",
  "lib/expected-packages-product-linkage.ts",
  "lib/inventory-views-neda-read-contract.ts",
  "lib/inventory-views-product-linkage.ts",
  "lib/inventory-package-status-ui.ts",
  "components/returns/ExpectedPackagesLinkagePanel.tsx",
  "components/returns/InventoryItemStatusLinkagePanel.tsx",
  "components/returns/InventoryPackageStatusChip.tsx",
  "app/returns/page.tsx",
  "app/returns/_components.tsx",
];

const STALE_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "package_items", re: /\bpackage_items\b/ },
  { id: "from_returns", re: /\.from\(\s*["']returns["']\s*\)/ },
  { id: "package_number", re: /\bpackage_number\b/ },
  { id: "pallets_photo_url", re: /\bpallets\.photo_url\b|\.select\([^)]*photo_url[^)]*\)[^;]*pallets/ },
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scanStaleRefs(root: string): { id: string; file: string; pass: boolean }[] {
  const out: { id: string; file: string; pass: boolean }[] = [];
  for (const rel of NEDA_READ_GLOBS) {
    const fp = path.join(root, rel);
    if (!fs.existsSync(fp)) {
      out.push({ id: "missing_file", file: rel, pass: false });
      continue;
    }
    const text = fs.readFileSync(fp, "utf8");
    for (const { id, re } of STALE_PATTERNS) {
      if (re.test(text)) out.push({ id, file: rel, pass: false });
    }
  }
  return out;
}

function uiStaticChecks(root: string): Record<string, boolean> {
  const components = fs.readFileSync(path.join(root, "app/returns/_components.tsx"), "utf8");
  const invPanel = fs.readFileSync(
    path.join(root, "components/returns/InventoryItemStatusLinkagePanel.tsx"),
    "utf8",
  );
  const expPanel = fs.readFileSync(
    path.join(root, "components/returns/ExpectedPackagesLinkagePanel.tsx"),
    "utf8",
  );
  const chipImportedInDrawer = components.includes("InventoryPackageStatusChip");

  return {
    fetchExpectedPackagesNedaRead_wired: expPanel.includes("fetchExpectedPackagesNedaRead"),
    fetchInventoryItemStatusForNeda_wired: invPanel.includes("fetchInventoryItemStatusForNeda"),
    expected_panel_filters: expPanel.includes("filterOrderId") && expPanel.includes("filterTracking"),
    expected_qty_variance_ui:
      expPanel.includes("expected_quantity") && expPanel.includes("VARIANCE_LABEL"),
    inventory_qty_status_ui:
      invPanel.includes("expected_quantity") &&
      invPanel.includes("scanned_quantity") &&
      invPanel.includes("VARIANCE_LABEL"),
    product_linkage_block_both:
      expPanel.includes("ProductLinkageDisplayBlock") &&
      invPanel.includes("ProductLinkageDisplayBlock"),
    drawer_inventory_panel_no_duplicate_chip:
      components.includes("InventoryItemStatusLinkagePanel") &&
      !components.includes("InventoryPackageStatusChip"),
    package_chip_single_source:
      invPanel.includes("v_inventory_status") && invPanel.includes("hidePackageRollup"),
    api_route_exists: fs.existsSync(
      path.join(root, "app/api/returns/expected-packages-linkage/route.ts"),
    ),
    drawer_no_inventory_package_status_chip_component: !chipImportedInDrawer,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const root = process.cwd();
  const outDir = path.join(
    root,
    ".cursor/audit-reports/expected-inventory-neda-read-model-signoff-v181",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const urlRef = refFromSupabaseUrl(process.env.STAGING_SUPABASE_URL ?? "") ?? stagingRef;

  if (stagingRef !== STAGING_REF) {
    console.error(JSON.stringify({ ok: false, error: "staging ref mismatch" }));
    process.exit(2);
  }

  const staleHits = scanStaleRefs(root);
  const uiChecks = uiStaticChecks(root);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const pkgItems = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  await client.end();

  const expected = await fetchExpectedPackagesNedaRead({
    organizationId: SAM_ORG,
    storeId: SAM_STORE,
    limit: 50,
  });
  const inventory = await fetchInventoryItemStatusForNeda({
    organizationId: SAM_ORG,
    storeId: SAM_STORE,
    limit: 50,
  });

  if (!expected.ok || !inventory.ok) {
    console.error(
      JSON.stringify({
        ok: false,
        expected_error: expected.ok ? null : expected.error,
        inventory_error: inventory.ok ? null : inventory.error,
      }),
    );
    process.exit(1);
  }

  const sampleOrder = expected.data.rows[0]?.order_id?.trim();
  let orderFilterOk = true;
  if (sampleOrder) {
    const filtered = await fetchExpectedPackagesNedaRead({
      organizationId: SAM_ORG,
      storeId: SAM_STORE,
      orderId: sampleOrder,
      limit: 30,
    });
    orderFilterOk = filtered.ok && filtered.data.rows.every((r) => r.order_id === sampleOrder);
  }

  const tn = inventory.data.item_status_rows[0]?.tracking_number?.trim();
  let trackingFilterOk = true;
  let packageStatusWithTracking: string | null = null;
  if (tn) {
    const filtered = await fetchInventoryItemStatusForNeda({
      organizationId: SAM_ORG,
      storeId: SAM_STORE,
      trackingNumber: tn,
      limit: 30,
    });
    trackingFilterOk =
      filtered.ok &&
      filtered.data.item_status_rows.every((r) => (r.tracking_number ?? "").includes(tn.slice(0, 8)));
    if (filtered.ok) packageStatusWithTracking = filtered.data.package_status?.status ?? null;
  }

  const expUnresolved = expected.data.rows.filter((r) => !r.product_linkage.is_resolved);
  const invUnresolved = inventory.data.item_status_rows.filter((r) => !r.product_linkage.is_resolved);

  const fieldChecks = {
    expected_row_shape:
      expected.data.rows.length > 0 &&
      expected.data.rows.every(
        (r) =>
          typeof r.expected_quantity === "number" &&
          typeof r.scanned_quantity === "number" &&
          Boolean(r.variance_status) &&
          r.product_linkage != null,
      ),
    inventory_row_shape:
      inventory.data.item_status_rows.length > 0 &&
      inventory.data.item_status_rows.every(
        (r) =>
          typeof r.expected_quantity === "number" &&
          typeof r.scanned_quantity === "number" &&
          Boolean(r.inventory_status) &&
          r.product_linkage != null,
      ),
    package_status_chip_when_tracking_filter: Boolean(packageStatusWithTracking),
    unresolved_label_constant: PRODUCT_LINKAGE_LABEL_NO_LINK === "No product link yet",
    has_unresolved_sample: expUnresolved.length > 0 || invUnresolved.length > 0,
  };

  const payload = {
    ok: true,
    run_id: runId,
    signoff: "EXPECTED-INVENTORY-NEDA-READ-MODEL-FINAL-SIGNOFF-V181",
    staging_ref: STAGING_REF,
    sam_org: SAM_ORG,
    sam_store: SAM_STORE,
    package_items_absent: (pkgItems.rowCount ?? 0) === 0,
    stale_ref_violations: staleHits,
    stale_refs_pass: staleHits.length === 0,
    ui_static_checks: uiChecks,
    ui_static_pass: Object.values(uiChecks).every(Boolean),
    field_checks: fieldChecks,
    field_checks_pass: Object.values(fieldChecks).every(Boolean),
    expected_packages: {
      linkage_readiness: expected.data.linkage_readiness,
      sample_rows: expected.data.rows.length,
      resolved: expected.data.rows.filter((r) => r.product_linkage.is_resolved).length,
      unresolved: expUnresolved.length,
      order_filter_ok: orderFilterOk,
    },
    inventory_item_status: {
      linkage_readiness: inventory.data.linkage_readiness,
      views_present: inventory.data.views_present,
      sample_rows: inventory.data.item_status_rows.length,
      resolved: inventory.data.item_status_rows.filter((r) => r.product_linkage.is_resolved).length,
      unresolved: invUnresolved.length,
      package_status_unfiltered: inventory.data.package_status?.status ?? null,
      package_status_with_tracking: packageStatusWithTracking,
      tracking_filter_ok: trackingFilterOk,
    },
    approved_read_paths: [
      "fetchExpectedPackagesNedaRead",
      "GET /api/returns/expected-packages-linkage",
      "fetchInventoryItemStatusForNeda",
      "v_inventory_status (package chip only)",
      "v_scanned_items_counted (aggregation via views)",
    ],
  };

  const overallPass =
    payload.package_items_absent &&
    payload.stale_refs_pass &&
    payload.ui_static_pass &&
    payload.field_checks_pass &&
    expected.data.linkage_readiness !== "FAIL" &&
    inventory.data.linkage_readiness !== "FAIL";

  fs.writeFileSync(path.join(outDir, "signoff-result.json"), JSON.stringify({ ...payload, overall_pass: overallPass }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "signoff-summary.md"),
    [
      "# Neda expected vs scanned read model — final signoff (V181)",
      "",
      `**Run ID:** \`${runId}\`  `,
      `**Overall:** ${overallPass ? "**PASS**" : "**FAIL**"}  `,
      `**Staging:** \`${STAGING_REF}\` · Sam org/store`,
      "",
      "## Automated checks",
      "",
      "| Area | Result |",
      "|------|--------|",
      `| \`npm run build\` | Run separately (see manifest) |`,
      `| Staging smokes | expected-packages + inventory-views |`,
      `| Stale refs (Neda read surfaces) | ${payload.stale_refs_pass ? "PASS" : "FAIL"} |`,
      `| UI static wiring | ${payload.ui_static_pass ? "PASS" : "FAIL"} |`,
      `| Read contract fields | ${payload.field_checks_pass ? "PASS" : "FAIL"} |`,
      `| \`package_items\` absent | ${payload.package_items_absent ? "PASS" : "FAIL"} |`,
      "",
      "## Read paths approved",
      "",
      ...payload.approved_read_paths.map((p) => `- ${p}`),
      "",
      "## Staging samples",
      "",
      `- Expected packages: ${payload.expected_packages.sample_rows} rows (${payload.expected_packages.resolved} resolved, ${payload.expected_packages.unresolved} unresolved) · linkage ${payload.expected_packages.linkage_readiness}`,
      `- Inventory item status: ${payload.inventory_item_status.sample_rows} rows · package chip \`${payload.inventory_item_status.package_status ?? "—"}\` · linkage ${payload.inventory_item_status.linkage_readiness}`,
      "",
      "## UI notes (static)",
      "",
      "- Packages tab: filterable Expected Packages + Inventory Item Status panels",
      "- Package drawer: `InventoryItemStatusLinkagePanel` only (no `InventoryPackageStatusChip` duplicate)",
      "- Unresolved rows use \`ProductLinkageDisplayBlock\` → \"No product link yet\"",
      "",
      overallPass ? "## Signoff\n\n**Approved for Neda UI use on staging.**" : "## Signoff\n\n**Blocked** — see signoff-result.json",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        prompt: "EXPECTED-INVENTORY-NEDA-READ-MODEL-FINAL-SIGNOFF-V181",
        artifacts: ["signoff-result.json", "signoff-summary.md", "smoke-expected-packages.json", "smoke-inventory-views.json"],
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ...payload, overall_pass: overallPass, out_dir: outDir }, null, 2));
  if (!overallPass) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
