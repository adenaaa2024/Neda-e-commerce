/**
 * Product spine app hydration — live staging smoke (read-only).
 * Run: npx tsx scripts/product-spine-app-hydration-smoke.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { buildInventoryViewProductLinkage } from "../lib/scanner/expected-packages-read-contract";
import {
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageOperatorPrimaryDisplayLabel,
} from "../lib/scanner/product-linkage-display-contract";
import type { VInventoryStatusRow } from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/product-spine-app-hydration-patch";
const TRACKING = "1552698729";
const FNSKU = "X003S8RCBH";
const TYPO_FNSKU = "X003SRBCH";
const EXPECTED_NAME = "Bobs Red Mill GF Baking Soda 4/16 Oz";
const PRODUCT_ID = "e3832e25-275f-4124-906b-f2d6b7931b86";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function toInvRow(vr: Record<string, unknown>): VInventoryStatusRow {
  return {
    expected_package_id: String(vr.expected_package_id ?? vr.id ?? ""),
    organization_id: String(vr.organization_id ?? ""),
    store_id: String(vr.store_id ?? ""),
    tracking_number: vr.tracking_number != null ? String(vr.tracking_number) : null,
    id_slip_contents: vr.id_slip_contents != null ? String(vr.id_slip_contents) : null,
    sku: vr.sku != null ? String(vr.sku) : null,
    fnsku: vr.fnsku != null ? String(vr.fnsku) : null,
    asin: vr.asin != null ? String(vr.asin) : null,
    order_id: vr.order_id != null ? String(vr.order_id) : null,
    status: vr.status != null ? String(vr.status) : null,
    product_name: vr.product_name != null ? String(vr.product_name) : null,
    product_display_name:
      vr.product_display_name != null
        ? String(vr.product_display_name)
        : vr.product_name != null
          ? String(vr.product_name)
          : null,
    product_id: vr.product_id != null ? String(vr.product_id) : null,
    resolved_product_id:
      vr.resolved_product_id != null ? String(vr.resolved_product_id).trim() || null : null,
    resolved_catalog_product_id:
      vr.resolved_catalog_product_id != null ? String(vr.resolved_catalog_product_id) : null,
    product_linkage_status:
      vr.product_linkage_status != null
        ? String(vr.product_linkage_status)
        : vr.identifier_resolution_status != null
          ? String(vr.identifier_resolution_status)
          : null,
    identifier_resolution_status:
      vr.identifier_resolution_status != null ? String(vr.identifier_resolution_status) : null,
    identifier_resolution_confidence:
      vr.identifier_resolution_confidence != null ? Number(vr.identifier_resolution_confidence) : null,
    carrier: vr.carrier != null ? String(vr.carrier) : null,
    total_expected: Number(vr.total_expected ?? 0),
    total_scanned: Number(vr.total_scanned ?? 0),
  };
}

async function main(): Promise<void> {
  const runId = process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1]?.trim() ?? runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const trackingRes = await client.query(
    `SELECT * FROM v_inventory_item_status WHERE tracking_number = $1 LIMIT 5`,
    [TRACKING],
  );
  const fnskuRes = await client.query(
    `SELECT * FROM v_inventory_item_status WHERE fnsku = $1 LIMIT 5`,
    [FNSKU],
  );
  const typoRes = await client.query(
    `SELECT * FROM v_inventory_item_status WHERE fnsku = $1 LIMIT 5`,
    [TYPO_FNSKU],
  );
  await client.end();

  const trackingRows = trackingRes.rows as Record<string, unknown>[];
  const proofs: Array<{ case: string; label: string; pass: boolean }> = [];

  for (const vr of trackingRows) {
    const inv = toInvRow(vr);
    const linkage = buildInventoryViewProductLinkage(inv, undefined, new Map());
    const label = productLinkageOperatorPrimaryDisplayLabel(linkage);
    proofs.push({
      case: `tracking:${TRACKING}`,
      label,
      pass: label === EXPECTED_NAME && linkage.resolved_product_id === PRODUCT_ID,
    });
  }

  for (const vr of fnskuRes.rows as Record<string, unknown>[]) {
    const linkage = buildInventoryViewProductLinkage(toInvRow(vr), undefined, new Map());
    proofs.push({
      case: `fnsku:${FNSKU}`,
      label: productLinkageOperatorPrimaryDisplayLabel(linkage),
      pass: productLinkageOperatorPrimaryDisplayLabel(linkage) === EXPECTED_NAME,
    });
  }

  proofs.push({
    case: `typo_fnsku:${TYPO_FNSKU}`,
    label: typoRes.rowCount ? "rows returned" : PRODUCT_LINKAGE_UNMAPPED_LABEL,
    pass: (typoRes.rowCount ?? 0) === 0,
  });

  const pass = proofs.every((p) => p.pass) && trackingRows.length > 0;

  const result = {
    run_id: runId,
    tracking: TRACKING,
    fnsku: FNSKU,
    expected_product_name: EXPECTED_NAME,
    tracking_view_rows: trackingRows.length,
    proofs,
    pass,
  };

  fs.writeFileSync(path.join(outDir, "scanner-smoke-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
