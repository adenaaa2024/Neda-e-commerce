/**
 * Operator scan product link fix — Neda mobile scanner audit (read-only + contract proof).
 *
 *   npx tsx scripts/operator-scan-product-link-fix-neda.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { buildInventoryViewProductLinkage } from "../lib/scanner/expected-packages-read-contract";
import { productLinkageOperatorPrimaryDisplayLabel } from "../lib/scanner/product-linkage-display-contract";
import type { VInventoryStatusRow } from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/operator-scan-product-link-fix-neda";
const TRACKING = "2320305295";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function mockInvRow(partial: Partial<VInventoryStatusRow>): VInventoryStatusRow {
  return {
    expected_package_id: "",
    organization_id: "00000000-0000-0000-0000-000000000001",
    store_id: "509ee1f6-622c-46a5-8110-7b889ba46c2c",
    tracking_number: TRACKING,
    id_slip_contents: null,
    sku: null,
    fnsku: null,
    asin: null,
    order_id: null,
    status: "expected",
    product_name: null,
    product_display_name: null,
    product_id: null,
    resolved_product_id: null,
    resolved_catalog_product_id: null,
    product_linkage_status: null,
    identifier_resolution_status: null,
    identifier_resolution_confidence: null,
    carrier: null,
    total_expected: 0,
    total_scanned: 0,
    ...partial,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const epRes = await client.query(
    `SELECT id, tracking_number, order_id, sku, fnsku, resolved_product_id, identifier_resolution_status
     FROM expected_packages WHERE tracking_number ILIKE $1 ORDER BY sku`,
    [`%${TRACKING}%`],
  );
  const viewRes = await client.query(`SELECT * FROM v_inventory_item_status WHERE tracking_number ILIKE $1`, [
    `%${TRACKING}%`,
  ]);
  await client.end();

  const epRows = epRes.rows as Record<string, unknown>[];
  const viewRows = viewRes.rows as Record<string, unknown>[];
  const totalExpected = viewRows.reduce((s, r) => s + Number(r.total_expected ?? 0), 0);

  const contractProof: Array<{
    sku: string;
    fnsku: string;
    before_label: string;
    after_label: string;
    resolved: boolean;
  }> = [];

  for (const vr of viewRows) {
    const inv = mockInvRow({
      sku: String(vr.sku ?? ""),
      fnsku: String(vr.fnsku ?? ""),
      order_id: String(vr.order_id ?? ""),
      product_name: String(vr.product_name ?? ""),
      resolved_product_id: String(vr.resolved_product_id ?? "") || null,
      product_linkage_status: String(vr.product_linkage_status ?? "resolved"),
      total_expected: Number(vr.total_expected ?? 0),
      total_scanned: Number(vr.total_scanned ?? 0),
    });
    const epMatch = epRows.find(
      (e) =>
        String(e.sku ?? "").trim() === String(vr.sku ?? "").trim() &&
        String(e.fnsku ?? "").trim() === String(vr.fnsku ?? "").trim(),
    );
    const before = buildInventoryViewProductLinkage(
      { ...inv, resolved_product_id: null, product_name: null, product_linkage_status: null },
      undefined,
      new Map(),
    );
    const after = buildInventoryViewProductLinkage(inv, epMatch ?? undefined, new Map());
    contractProof.push({
      sku: String(vr.sku ?? ""),
      fnsku: String(vr.fnsku ?? ""),
      before_label: productLinkageOperatorPrimaryDisplayLabel(before),
      after_label: productLinkageOperatorPrimaryDisplayLabel(after),
      resolved: after.resolved_product_id != null && after.product_name != null,
    });
  }

  const uiFixed = contractProof.every(
    (p) => p.resolved && p.after_label !== "No product link yet" && !p.after_label.startsWith("Needs"),
  );
  const trackingResolved = epRows.length > 0 && epRows.every((r) => r.resolved_product_id && r.identifier_resolution_status === "resolved");

  const rootCause =
    "v_inventory_item_status exposes resolved_product_id + product_name but VInventoryStatusRow dropped them; buildInventoryViewProductLinkage treated view rows as unresolved when expected_package_id join failed.";

  fs.writeFileSync(
    path.join(outDir, "tracking-debug.json"),
    JSON.stringify(
      {
        tracking_number: TRACKING,
        expected_packages: epRows,
        v_inventory_item_status: viewRows,
        total_expected_from_view: totalExpected,
        contract_proof: contractProof,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "fix-summary.md"),
    [
      "# Operator scan product link fix",
      "",
      `**Tracking:** \`${TRACKING}\` | **Expected qty (view):** ${totalExpected}`,
      "",
      "## Root cause",
      "",
      rootCause,
      "",
      "## Code changes",
      "",
      "- `lib/scanner/v-inventory-status.ts` — map `resolved_product_id`, `product_linkage_status` from view",
      "- `lib/scanner/expected-packages-read-contract.ts` — hydrate linkage from view + COALESCE effective product id",
      "- `lib/scanner/product-linkage-display-contract.ts` — prefer catalog name; unresolved reason labels",
      "- `app/scanner/operator-mobile/scan/page.tsx` — EP join by sku/fnsku/order; name map from view rows",
      "- `lib/expected-packages-product-linkage.ts` — always fetch product name when persisted resolved",
      "",
      "## Contract proof (tracking rows)",
      "",
      "| SKU | FNSKU | before UI | after UI | resolved |",
      "|-----|-------|-----------|----------|:--------:|",
      ...contractProof.map(
        (p) =>
          `| ${p.sku} | ${p.fnsku} | ${p.before_label} | **${p.after_label}** | ${p.resolved ? "yes" : "no"} |`,
      ),
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "OPERATOR SCAN PRODUCT LINK FIX — NEDA MOBILE SCANNER",
    run_id: runId,
    branch: execSync("git branch --show-current", { encoding: "utf8" }).trim(),
    data_source: "v_inventory_item_status + expected_packages (staging read-only)",
    tracking_number: TRACKING,
    tracking_row_resolved: trackingResolved,
    ui_fixed: uiFixed,
    ep_row_count: epRows.length,
    view_row_count: viewRows.length,
    total_expected: totalExpected,
    remaining_unresolved_reason: uiFixed ? null : "See contract_proof rows with after_label still unmapped",
    exact_next_prompt: uiFixed
      ? "NEDA OPERATOR SCAN BROWSER SPOT-CHECK — verify tracking 2320305295 shows product names on staging"
      : "OPERATOR SCAN PRODUCT LINK FIX — follow-up hydration for remaining unresolved cohort",
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
