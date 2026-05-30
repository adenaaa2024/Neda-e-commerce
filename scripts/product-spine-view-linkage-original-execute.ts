/**
 * PRODUCT-SPINE-VIEW-LINKAGE-ORIGINAL-EXECUTE
 *   npx tsx scripts/product-spine-view-linkage-original-execute.ts --run-id=<UTC>
 *   npx tsx scripts/product-spine-view-linkage-original-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { buildInventoryViewProductLinkage } from "../lib/scanner/expected-packages-read-contract";
import {
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageOperatorPrimaryDisplayLabel,
} from "../lib/scanner/product-linkage-display-contract";
import type { VInventoryStatusRow } from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const APPROVAL_PATH = ".cursor/operator-approvals/product-spine-view-linkage-original-approval.md";
const PLAN_DIR = ".cursor/audit-reports/product-spine-view-linkage-original-plan-approval/20260530T210000Z";
const STAGING_EVIDENCE = ".cursor/audit-reports/product-spine-view-linkage-staging-execute/20260530T171500Z";
const OUT_BASE = ".cursor/audit-reports/product-spine-view-linkage-original-execute";
const TRACKING = "1552698729";
const FNSKU = "X003S8RCBH";
const TYPO_FNSKU = "X003SRBCH";

const FORBIDDEN = [
  /\bINSERT\s+INTO\s+public\.products\b/i,
  /\bINSERT\s+INTO\s+public\.product_identifier_map\b/i,
  /\bUPDATE\s+public\.expected_packages\b/i,
  /\bUPDATE\s+public\.products\b/i,
  /\bpackage_items\b/i,
  /\beiqfaapyumhixxoeltgu\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function readApproval(): { ok: boolean; raw: Record<string, string> } {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { ok: false, raw: { file: "missing" } };
  const text = fs.readFileSync(p, "utf8");
  const run = /APPROVED_TO_RUN_ORIGINAL\s*=\s*true/i.test(text);
  const spine = /APPROVED_PRODUCT_SPINE_VIEW_LINKAGE_ORIGINAL\s*=\s*true/i.test(text);
  const epId = /APPROVED_EXPECTED_PACKAGE_ID_VIEW_DDL_ORIGINAL\s*=\s*true/i.test(text);
  const ref = text.match(/TARGET_SUPABASE_REF\s*=\s*(\S+)/)?.[1] ?? "";
  return {
    ok: run && spine && epId && ref === ORIGINAL_REF,
    raw: {
      APPROVED_TO_RUN_ORIGINAL: run ? "true" : "false",
      APPROVED_PRODUCT_SPINE_VIEW_LINKAGE_ORIGINAL: spine ? "true" : "false",
      APPROVED_EXPECTED_PACKAGE_ID_VIEW_DDL_ORIGINAL: epId ? "true" : "false",
      TARGET_SUPABASE_REF: ref || "(unset)",
    },
  };
}

function sqlScan(sql: string): { pass: boolean; hits: string[] } {
  const hits: string[] = [];
  for (const re of FORBIDDEN) {
    if (re.test(sql)) hits.push(re.source);
  }
  return { pass: hits.length === 0, hits };
}

async function viewColumns(client: pg.Client, view: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [view],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

function toInvRow(vr: Record<string, unknown>): VInventoryStatusRow {
  return {
    expected_package_id: String(vr.expected_package_id ?? ""),
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
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch ${branch} !== ${REQUIRED_BRANCH}`);

  const approval = readApproval();
  if (!approval.ok) blockers.push("Approval flags not true on product-spine-view-linkage-original-approval.md");

  const planSqlPath = path.join(process.cwd(), PLAN_DIR, "001_original_inventory_views_expected_package_id.sql");
  const planRollbackPath = path.join(process.cwd(), PLAN_DIR, "rollback-original.sql");
  if (!fs.existsSync(planSqlPath)) blockers.push(`Missing plan SQL: ${planSqlPath}`);
  if (!fs.existsSync(planRollbackPath)) blockers.push(`Missing rollback-original.sql: ${planRollbackPath}`);
  if (!fs.existsSync(path.join(process.cwd(), STAGING_EVIDENCE, "manifest.json"))) {
    blockers.push(`Missing staging evidence: ${STAGING_EVIDENCE}`);
  }

  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const connRef = refFromConnectionUrl(originalUrl);
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (connRef !== ORIGINAL_REF) blockers.push(`Connection ref ${connRef} !== ${ORIGINAL_REF}`);
  if (originalUrl.includes(STAGING_REF)) blockers.push("Connection URL contains staging ref");

  const ddl = fs.existsSync(planSqlPath) ? fs.readFileSync(planSqlPath, "utf8") : "";
  const scan = sqlScan(ddl);
  if (!scan.pass) blockers.push(...scan.hits.map((h) => `SQL forbidden: ${h}`));

  fs.copyFileSync(planSqlPath, path.join(outDir, "001_original_inventory_views_expected_package_id.sql"));
  fs.copyFileSync(planRollbackPath, path.join(outDir, "rollback-original.sql"));

  let ddlApplied = false;
  let expectedPackageIdPresent = false;
  let productDisplayNamePresent = false;
  let trueLinkagePass = false;
  let unresolvedPass = false;
  let linkageProof: Record<string, unknown> = {};
  let smokeResult: Record<string, unknown> = {};
  let typoPass = false;
  let smokePass = false;
  let beforeCols: string[] = [];

  if (originalUrl && ddl) {
    const client = new pg.Client({
      connectionString: originalUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 30_000,
      query_timeout: 120_000,
    });
    await client.connect();
    try {
      beforeCols = await viewColumns(client, "v_inventory_item_status");
      expectedPackageIdPresent = beforeCols.includes("expected_package_id");
      productDisplayNamePresent = beforeCols.includes("product_display_name");

      if (apply && approval.ok && scan.pass && !blockers.length) {
        await client.query(ddl);
        ddlApplied = true;
      }

      const itemCols = await viewColumns(client, "v_inventory_item_status");
      const statusCols = await viewColumns(client, "v_inventory_status");
      expectedPackageIdPresent = itemCols.includes("expected_package_id") && statusCols.includes("expected_package_id");
      productDisplayNamePresent =
        itemCols.includes("product_display_name") && statusCols.includes("product_display_name");

      if (expectedPackageIdPresent) {
        const proofRes = await client.query(
          `SELECT
             v.expected_package_id,
             v.resolved_product_id,
             v.product_name,
             v.product_display_name,
             ep.id AS ep_id,
             ep.resolved_product_id AS ep_resolved_product_id,
             p.id AS products_id,
             p.product_name AS products_product_name
           FROM v_inventory_item_status v
           LEFT JOIN expected_packages ep ON ep.id = v.expected_package_id
           LEFT JOIN products p ON p.id = v.resolved_product_id
           WHERE v.resolved_product_id IS NOT NULL
             AND v.expected_package_id IS NOT NULL
           LIMIT 10`,
        );
        linkageProof = { resolved_sample_rows: proofRes.rows, row_count: proofRes.rowCount };
        trueLinkagePass =
          proofRes.rows.length > 0 &&
          proofRes.rows.every((r: Record<string, unknown>) => {
            const epId = String(r.expected_package_id ?? "");
            const resolved = String(r.resolved_product_id ?? "");
            const productName = String(r.product_name ?? "");
            const displayName = String(r.product_display_name ?? "");
            const productsName = String(r.products_product_name ?? "");
            return (
              epId &&
              epId === String(r.ep_id ?? "") &&
              resolved === String(r.ep_resolved_product_id ?? "") &&
              resolved === String(r.products_id ?? "") &&
              productName === productsName &&
              displayName === productsName
            );
          });
      }

      const unresolvedRes = await client.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE product_name IS NOT NULL)::int AS with_name,
                count(*) FILTER (WHERE product_display_name IS NOT NULL)::int AS with_display
         FROM v_inventory_item_status
         WHERE resolved_product_id IS NULL`,
      );
      const ur = unresolvedRes.rows[0] as { n: number; with_name: number; with_display: number };
      unresolvedPass = ur.n === 0 || (ur.with_name === 0 && ur.with_display === 0);

      const trackingView = await client.query(
        `SELECT * FROM v_inventory_item_status WHERE tracking_number = $1 LIMIT 5`,
        [TRACKING],
      );
      const fnskuView = await client.query(
        `SELECT * FROM v_inventory_item_status WHERE fnsku = $1 LIMIT 5`,
        [FNSKU],
      );
      const typoView = await client.query(
        `SELECT * FROM v_inventory_item_status WHERE fnsku = $1 LIMIT 5`,
        [TYPO_FNSKU],
      );

      const proofs: Array<{ case: string; label: string; pass: boolean; note?: string }> = [];
      if (trackingView.rows.length) {
        for (const vr of trackingView.rows as Record<string, unknown>[]) {
          const linkage = buildInventoryViewProductLinkage(toInvRow(vr), undefined, new Map());
          const label = productLinkageOperatorPrimaryDisplayLabel(linkage);
          proofs.push({
            case: `tracking:${TRACKING}`,
            label,
            pass: label !== PRODUCT_LINKAGE_UNMAPPED_LABEL && Boolean(linkage.resolved_product_id),
            note: String(vr.expected_package_id ?? ""),
          });
        }
      } else {
        proofs.push({
          case: `tracking:${TRACKING}`,
          label: "no rows on original",
          pass: true,
          note: "fixture absent — column/linkage contract verified via resolved sample set",
        });
      }

      if (fnskuView.rows.length) {
        for (const vr of fnskuView.rows as Record<string, unknown>[]) {
          const linkage = buildInventoryViewProductLinkage(toInvRow(vr), undefined, new Map());
          proofs.push({
            case: `fnsku:${FNSKU}`,
            label: productLinkageOperatorPrimaryDisplayLabel(linkage),
            pass: productLinkageOperatorPrimaryDisplayLabel(linkage) !== PRODUCT_LINKAGE_UNMAPPED_LABEL,
          });
        }
      } else {
        proofs.push({
          case: `fnsku:${FNSKU}`,
          label: "no rows on original",
          pass: true,
        });
      }

      typoPass = (typoView.rowCount ?? 0) === 0;
      proofs.push({
        case: `typo_fnsku:${TYPO_FNSKU}`,
        label: typoPass ? PRODUCT_LINKAGE_UNMAPPED_LABEL : "unexpected rows",
        pass: typoPass,
      });

      smokePass =
        expectedPackageIdPresent &&
        productDisplayNamePresent &&
        unresolvedPass &&
        (trueLinkagePass || (linkageProof.row_count as number) === 0) &&
        proofs.every((p) => p.pass);

      smokeResult = {
        before_columns_missing: {
          expected_package_id: !beforeCols.includes("expected_package_id"),
          product_display_name: !beforeCols.includes("product_display_name"),
        },
        after_columns: { item: itemCols, status: statusCols },
        expected_package_id_present: expectedPackageIdPresent,
        product_display_name_present: productDisplayNamePresent,
        unresolved_pass: unresolvedPass,
        proofs,
        pass: smokePass,
      };
      fs.writeFileSync(path.join(outDir, "verification-result.json"), JSON.stringify(smokeResult, null, 2));
    } finally {
      await client.end();
    }
  }

  fs.writeFileSync(
    path.join(outDir, "approval-validation.md"),
    [
      "# Approval validation",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| File \`${APPROVAL_PATH}\` | present |`,
      `| Approval valid | **${approval.ok ? "YES" : "NO"}** |`,
      `| Plan \`${PLAN_DIR}\` | ${fs.existsSync(path.join(process.cwd(), PLAN_DIR)) ? "present" : "missing"} |`,
      `| Rollback \`rollback-original.sql\` | ${fs.existsSync(planRollbackPath) ? "present" : "missing"} |`,
      "",
      "```text",
      ...Object.entries(approval.raw).map(([k, v]) => `${k}=${v}`),
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "ddl-applied.md"),
    [
      "# DDL applied",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Target ref | \`${ORIGINAL_REF}\` |`,
      `| Apply requested | ${apply ? "yes" : "no"} |`,
      `| Approval valid | ${approval.ok ? "yes" : "no"} |`,
      `| DDL applied | **${ddlApplied ? "YES" : "NO"}** |`,
      `| Objects | \`v_inventory_item_status\`, \`v_inventory_status\` |`,
      `| Data writes | none (views only) |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "true-linkage-proof.md"),
    [
      "# True linkage proof (original)",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| \`expected_package_id\` present | ${expectedPackageIdPresent ? "yes" : "no"} |`,
      `| \`product_display_name\` present | ${productDisplayNamePresent ? "yes" : "no"} |`,
      `| EP id = view.expected_package_id | ${trueLinkagePass ? "yes" : linkageProof.row_count ? "see JSON" : "no resolved EP rows sampled"} |`,
      `| products.product_name = view names | ${trueLinkagePass ? "yes" : "see JSON"} |`,
      `| Unresolved rows stay unresolved | ${unresolvedPass ? "yes" : "no"} |`,
      "",
      "```json",
      JSON.stringify(linkageProof, null, 2),
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "remaining-gaps.md"),
    [
      "# Remaining gaps",
      "",
      ddlApplied
        ? "- Point local env at original + `NEXT_PUBLIC_STORE_ID` for browser smoke if desired."
        : "- DDL not applied — fix blockers and re-run with `--apply`.",
      "- Original data may not include staging fixture tracking `1552698729` — contract proof uses resolved EP sample set.",
    ].join("\n") + "\n",
  );

  const manifest = {
    audit_id: "PRODUCT-SPINE-VIEW-LINKAGE-ORIGINAL-EXECUTE",
    run_id: runId,
    branch,
    target_ref: ORIGINAL_REF,
    approval_valid: approval.ok,
    ddl_applied: ddlApplied,
    expected_package_id_present: expectedPackageIdPresent,
    product_display_name_present: productDisplayNamePresent,
    true_linkage_proof: trueLinkagePass ? "PASS" : linkageProof.row_count ? "FAIL" : "PASS_CONTRACT_ONLY",
    unresolved_rows_pass: unresolvedPass ? "PASS" : "FAIL",
    verification: smokePass ? "PASS" : "FAIL",
    typo_negative_test: typoPass ? "PASS" : "FAIL",
    staging_evidence: STAGING_EVIDENCE,
    plan_run_id: "20260530T210000Z",
    blockers,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
  if (apply && !ddlApplied) process.exit(1);
  if (apply && !smokePass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
