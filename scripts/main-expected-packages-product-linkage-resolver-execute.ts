/**
 * MAIN PRODUCT LINKAGE — expected_packages resolver execute (staging only).
 *
 * Deterministic SQL tier backfill (product_identifier_map + products fallback):
 *   1 FNSKU → 3 SKU → UPC → 4 ASIN (exact single match only; ambiguous rows untouched)
 *
 *   npx tsx scripts/main-expected-packages-product-linkage-resolver-execute.ts --run-id=<id>
 *   npx tsx scripts/main-expected-packages-product-linkage-resolver-execute.ts --run-id=<id> --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  applyExpectedPackagesResolverDdl,
  assertPackageItemsForbidden,
  ensureExpectedPackagesAuditTable,
  executeExpectedPackagesTierBackfill,
  initExpectedPackagesAsinExpr,
  probeExpectedPackagesCoverage,
  type ExpectedPackagesTier,
} from "../lib/expected-packages-resolver-backfill-pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/main-product-linkage-expected-packages-resolver-execute";
const APPROVAL_PATH =
  ".cursor/operator-approvals/main-expected-packages-product-linkage-resolver-approval.md";
const SMOKE_FNSKU = "X004JWH5NB";
const SMOKE_TRACKING = "2320305295";
const BATCH_SIZE = 100;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_MAIN_EXPECTED_PACKAGES_PRODUCT_LINKAGE_RESOLVER\s*=\s*true/i.test(text)
  );
}

function auditTableName(runId: string): string {
  return `main_ep_linkage_audit_${runId.replace(/[^a-z0-9]/gi, "_").slice(0, 28)}`;
}

async function tableHasColumn(client: pg.Client, table: string, column: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Tier UPC — map.upc_code exact (priority between SKU and ASIN). */
async function executeUpcMapBatch(client: pg.Client, runId: string, auditTable: string): Promise<number> {
  const hasEpUpc = await tableHasColumn(client, "expected_packages", "upc_code");
  const hasEpUpcAlt = await tableHasColumn(client, "expected_packages", "upc");
  const hasMapUpc = await tableHasColumn(client, "product_identifier_map", "upc_code");
  if (!hasMapUpc || (!hasEpUpc && !hasEpUpcAlt)) return 0;

  const upcExpr = hasEpUpc
    ? `NULLIF(TRIM(t.upc_code), '')`
    : `NULLIF(TRIM(t.upc), '')`;

  const q = `
    WITH picked AS (
      SELECT t.id
      FROM public.expected_packages t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND t.organization_id IS NOT NULL
        AND ${upcExpr} IS NOT NULL
      LIMIT ${BATCH_SIZE}
    ),
    winners AS (
      SELECT p.id AS row_id,
        (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
        (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
      FROM picked p
      INNER JOIN public.expected_packages t ON t.id = p.id
      INNER JOIN public.product_identifier_map m
        ON m.organization_id = t.organization_id
        AND m.store_id = t.store_id
        AND NULLIF(TRIM(m.upc_code), '') = ${upcExpr}
      WHERE m.product_id IS NOT NULL
      GROUP BY p.id
      HAVING COUNT(DISTINCT m.product_id) = 1
    ),
    updated AS (
      UPDATE public.expected_packages t
      SET
        resolved_product_id = w.product_id,
        resolved_catalog_product_id = w.catalog_product_id,
        identifier_resolution_status = 'matched',
        identifier_resolution_confidence = 0.9,
        updated_at = now()
      FROM winners w
      WHERE t.id = w.row_id
      RETURNING t.id, w.product_id, w.catalog_product_id
    )
    INSERT INTO public."${auditTable}" (
      run_id, source_table, source_row_id, match_tier,
      new_resolved_product_id, new_resolved_catalog_product_id,
      new_identifier_resolution_status, new_identifier_resolution_confidence
    )
    SELECT $1, 'expected_packages', u.id, 5, u.product_id, u.catalog_product_id, 'matched', 0.9
    FROM updated u
    RETURNING id
  `;
  const res = await client.query(q, [runId]);
  return res.rowCount ?? 0;
}

async function executeUpcMapLoop(client: pg.Client, runId: string, auditTable: string): Promise<number> {
  let total = 0;
  for (let i = 0; i < 500; i++) {
    const n = await executeUpcMapBatch(client, runId, auditTable);
    total += n;
    if (n === 0) break;
  }
  return total;
}

type ProductColumn = "fnsku" | "sku" | "upc_code" | "barcode" | "asin";

async function executeProductsDirectBatch(
  client: pg.Client,
  column: ProductColumn,
  confidence: number,
  runId: string,
  auditTable: string,
  epColumn: string,
): Promise<number> {
  const hasCol = await tableHasColumn(client, "products", column);
  if (!hasCol) return 0;

  const q = `
    WITH picked AS (
      SELECT t.id
      FROM public.expected_packages t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND t.organization_id IS NOT NULL
        AND NULLIF(TRIM(t.${epColumn}), '') IS NOT NULL
      LIMIT ${BATCH_SIZE}
    ),
    winners AS (
      SELECT p.id AS row_id,
        (array_agg(pr.id ORDER BY pr.id))[1] AS product_id
      FROM picked p
      INNER JOIN public.expected_packages t ON t.id = p.id
      INNER JOIN public.products pr
        ON pr.organization_id = t.organization_id
        AND pr.store_id = t.store_id
        AND NULLIF(TRIM(pr.${column}), '') = NULLIF(TRIM(t.${epColumn}), '')
        AND (pr.deleted_at IS NULL)
      GROUP BY p.id
      HAVING COUNT(DISTINCT pr.id) = 1
    ),
    updated AS (
      UPDATE public.expected_packages t
      SET
        resolved_product_id = w.product_id,
        resolved_catalog_product_id = NULL,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = $2,
        updated_at = now()
      FROM winners w
      WHERE t.id = w.row_id
      RETURNING t.id, w.product_id
    )
    INSERT INTO public."${auditTable}" (
      run_id, source_table, source_row_id, match_tier,
      new_resolved_product_id, new_identifier_resolution_status, new_identifier_resolution_confidence
    )
    SELECT $1, 'expected_packages', u.id, $3, u.product_id, 'resolved', $2
    FROM updated u
    RETURNING id
  `;
  const tierCode = column === "fnsku" ? 11 : column === "sku" ? 13 : column === "asin" ? 14 : 15;
  const res = await client.query(q, [runId, confidence, tierCode]);
  return res.rowCount ?? 0;
}

async function executeProductsDirectLoop(
  client: pg.Client,
  column: ProductColumn,
  epColumn: string,
  confidence: number,
  runId: string,
  auditTable: string,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < 500; i++) {
    const n = await executeProductsDirectBatch(client, column, confidence, runId, auditTable, epColumn);
    total += n;
    if (n === 0) break;
  }
  return total;
}

async function markAmbiguousFnsku(client: pg.Client): Promise<number> {
  const r = await client.query(`
    WITH multi AS (
      SELECT t.id
      FROM public.expected_packages t
      INNER JOIN public.product_identifier_map m
        ON m.organization_id = t.organization_id
        AND m.store_id = t.store_id
        AND NULLIF(TRIM(m.fnsku), '') = NULLIF(TRIM(t.fnsku), '')
      WHERE t.resolved_product_id IS NULL
        AND NULLIF(TRIM(t.fnsku), '') IS NOT NULL
      GROUP BY t.id
      HAVING COUNT(DISTINCT m.product_id) > 1
    )
    UPDATE public.expected_packages t
    SET identifier_resolution_status = 'ambiguous',
        identifier_resolution_confidence = 1,
        updated_at = now()
    FROM multi m
    WHERE t.id = m.id
    RETURNING t.id
  `);
  return r.rowCount ?? 0;
}

async function fetchSmokeSamples(client: pg.Client): Promise<Record<string, unknown>[]> {
  const samples: Record<string, unknown>[] = [];

  const fnskuQ = await client.query(
    `SELECT ep.id::text, ep.sku, ep.fnsku, ep.resolved_product_id::text, ep.identifier_resolution_status,
            NULLIF(trim(p.product_name), '') AS product_name
     FROM public.expected_packages ep
     LEFT JOIN public.products p ON p.id = ep.resolved_product_id
     WHERE upper(trim(ep.fnsku)) = upper($1)
     LIMIT 5`,
    [SMOKE_FNSKU],
  );
  for (const row of fnskuQ.rows) {
    samples.push({
      smoke: "fnsku",
      fnsku: SMOKE_FNSKU,
      ...row,
      product_name_visible: !!row.product_name,
    });
  }

  const trackQ = await client.query(
    `SELECT ep.id::text, ep.tracking_number, ep.sku, ep.fnsku, ep.resolved_product_id::text,
            ep.identifier_resolution_status,
            NULLIF(trim(p.product_name), '') AS product_name
     FROM public.expected_packages ep
     LEFT JOIN public.products p ON p.id = ep.resolved_product_id
     WHERE ep.tracking_number ILIKE $1
     ORDER BY ep.sku
     LIMIT 10`,
    [`%${SMOKE_TRACKING}%`],
  );
  for (const row of trackQ.rows) {
    samples.push({
      smoke: "neda_tracking",
      tracking: SMOKE_TRACKING,
      ...row,
      product_name_visible: !!row.product_name,
    });
  }

  try {
    const viewQ = await client.query(
      `SELECT sku, fnsku, product_name
       FROM public.v_inventory_item_status
       WHERE tracking_number ILIKE $1
       LIMIT 10`,
      [`%${SMOKE_TRACKING}%`],
    );
    for (const row of viewQ.rows) {
      samples.push({
        smoke: "view_after_linkage",
        tracking: SMOKE_TRACKING,
        ...row,
        product_name_visible: !!row.product_name,
      });
    }
  } catch {
    samples.push({ smoke: "view_after_linkage", error: "v_inventory_item_status query skipped" });
  }

  return samples;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  if (branch !== REQUIRED_BRANCH) throw new Error(`branch=${branch}`);
  if (execute && !readApproval()) {
    throw new Error("approval flags not true");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }
  if (ref === ORIGINAL_REF) throw new Error("original ref blocked");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '600s'`);
  await client.query(`SET lock_timeout = '120s'`);

  if (await assertPackageItemsForbidden(client)) {
    await client.end();
    throw new Error("package_items forbidden");
  }

  await initExpectedPackagesAsinExpr(client);
  const coverageBefore = await probeExpectedPackagesCoverage(client);

  const auditTable = auditTableName(runId);
  const tierResults: Array<{ step: string; updated: number }> = [];
  let ambiguousMarked = 0;

  if (execute) {
    await applyExpectedPackagesResolverDdl(client);
    await ensureExpectedPackagesAuditTable(client, auditTable);

    for (const tier of [1, 3] as ExpectedPackagesTier[]) {
      const updated = await executeExpectedPackagesTierBackfill(client, tier, runId, auditTable);
      tierResults.push({ step: `map_tier_${tier}`, updated });
    }

    const upcUpdated = await executeUpcMapLoop(client, runId, auditTable);
    tierResults.push({ step: "map_tier_upc", updated: upcUpdated });

    const asinUpdated = await executeExpectedPackagesTierBackfill(client, 4, runId, auditTable);
    tierResults.push({ step: "map_tier_4", updated: asinUpdated });

    tierResults.push({
      step: "products_fnsku",
      updated: await executeProductsDirectLoop(client, "fnsku", "fnsku", 1, runId, auditTable),
    });
    tierResults.push({
      step: "products_sku",
      updated: await executeProductsDirectLoop(client, "sku", "sku", 0.85, runId, auditTable),
    });
    const epUpcCol = (await tableHasColumn(client, "expected_packages", "upc_code"))
      ? "upc_code"
      : (await tableHasColumn(client, "expected_packages", "upc"))
        ? "upc"
        : null;
    if (epUpcCol && (await tableHasColumn(client, "products", "upc_code"))) {
      tierResults.push({
        step: "products_upc",
        updated: await executeProductsDirectLoop(client, "upc_code", epUpcCol, 0.9, runId, auditTable),
      });
    }
    if (await tableHasColumn(client, "expected_packages", "asin")) {
      tierResults.push({
        step: "products_asin",
        updated: await executeProductsDirectLoop(client, "asin", "asin", 0.7, runId, auditTable),
      });
    }

    ambiguousMarked = await markAmbiguousFnsku(client);
  }

  const coverageAfter = await probeExpectedPackagesCoverage(client);
  const smoke = await fetchSmokeSamples(client);
  await client.end();

  const totalUpdated = tierResults.reduce((a, t) => a + t.updated, 0);
  const productNameVisible = smoke.some((s) => s.product_name_visible === true);

  const exactNextPrompt = execute
    ? productNameVisible
      ? "NEDA OPERATOR SCAN BROWSER SPOT-CHECK — verify tracking 2320305295 and FNSKU X004JWH5NB show product names on staging"
      : "MAIN-PRODUCT-LINKAGE-REVIEW — smoke samples missing product_name; check map/products coverage"
    : "MAIN-EXPECTED-PACKAGES-PRODUCT-LINKAGE-RESOLVER-EXECUTE — rerun with --execute";

  fs.writeFileSync(path.join(outDir, "tier-execute-results.json"), JSON.stringify(tierResults, null, 2));
  fs.writeFileSync(
    path.join(outDir, "coverage-before.json"),
    JSON.stringify(coverageBefore, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "coverage-after.json"), JSON.stringify(coverageAfter, null, 2));
  fs.writeFileSync(path.join(outDir, "smoke-samples.json"), JSON.stringify(smoke, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Main expected_packages product linkage resolver",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Mode | ${execute ? "**execute**" : "dry-run (no writes)"} |`,
      `| Staging | \`${STAGING_REF}\` |`,
      `| Resolved before | **${coverageBefore?.resolved ?? 0}** / ${coverageBefore?.total ?? 0} (${coverageBefore?.coverage_pct ?? 0}%) |`,
      `| Resolved after | **${coverageAfter?.resolved ?? 0}** / ${coverageAfter?.total ?? 0} (${coverageAfter?.coverage_pct ?? 0}%) |`,
      `| Rows updated (this run) | **${totalUpdated}** |`,
      `| Ambiguous marked (FNSKU multi) | ${ambiguousMarked} |`,
      `| Unresolved after | **${coverageAfter?.unresolved ?? 0}** |`,
      `| Ambiguous after | **${coverageAfter?.ambiguous ?? 0}** |`,
      `| Smoke product_name visible | **${productNameVisible ? "yes" : "no"}** |`,
      "",
      "Priority: FNSKU (tier 1) → SKU (tier 3) → UPC (tier 5) → ASIN (tier 4) → products direct fallback.",
      "",
      `**Next:** ${exactNextPrompt}`,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone.\n");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "MAIN PRODUCT LINKAGE — EXPECTED_PACKAGES RESOLVER EXECUTE",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        mode: execute ? "execute" : "dry_run",
        resolved_before: coverageBefore?.resolved ?? 0,
        resolved_after: coverageAfter?.resolved ?? 0,
        unresolved_count: coverageAfter?.unresolved ?? 0,
        ambiguous_count: coverageAfter?.ambiguous ?? 0,
        rows_updated: totalUpdated,
        smoke_product_name_visible: productNameVisible,
        exact_next_prompt: exactNextPrompt,
        forbidden: {
          product_create: true,
          map_insert: true,
          amazon_api: true,
          original_db: true,
        },
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify(JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8")), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
